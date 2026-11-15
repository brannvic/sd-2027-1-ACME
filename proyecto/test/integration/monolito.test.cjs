require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomUUID, sign } = require('node:crypto');

// El monolito ya no tiene cuentas: los tokens los firma Usuarios. Aquí la prueba hace de Usuarios:
// firma tokens con su propia llave Ed25519 y reemplaza el cliente HTTP interno por uno en memoria.
function firmar(datos, llavePrivada) {
  const b64 = valor => Buffer.from(valor).toString('base64url');
  const contenido = `${b64(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))}.${b64(JSON.stringify(datos))}`;
  return `${contenido}.${b64(sign(null, Buffer.from(contenido), llavePrivada))}`;
}

test('recorrido HTTP con PostgreSQL real y transacciones', async t => {
  assert.match(process.env.DB_NAME ?? '', /^acme_test(?:_|$)/, 'Usa una base exclusiva cuyo nombre empiece por acme_test');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  process.env.JWT_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });
  process.env.RECONCILIAR_CADA_MS = '0'; // la prueba llama al reconciliador a mano
  const { default: baseDatos } = require('../../dist/base-datos');
  const { Paquete, Movimiento } = require('../../dist/movimientos/paquete.entity');
  const { IntentoEntrega, ProgramacionReintento } = require('../../dist/reintentos/reintento.entity');
  const { Reloj } = require('../../dist/reloj');
  const { UsuariosCliente } = require('../../dist/autenticacion/usuarios.cliente');
  const { ConsumidorSesiones } = require('../../dist/autenticacion/consumidor-sesiones');
  const { ConfirmacionesService } = require('../../dist/movimientos/confirmaciones.service');
  const { crearAplicacion } = require('../../dist/crear-aplicacion');
  await baseDatos.initialize();
  t.after(async () => { if (baseDatos.isInitialized) await baseDatos.destroy(); });
  await baseDatos.runMigrations();
  await baseDatos.query('TRUNCATE programacion_reintentos, intentos_entrega, historial_movimientos, paquetes, sesiones_revocadas RESTART IDENTITY CASCADE');
  const app = await crearAplicacion();
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const url = await app.getUrl();
  let instante = '2026-10-16T16:00:00Z';
  app.get(Reloj).ahora = () => new Date(instante);

  // "Usuarios" en memoria: cuentas, sesiones revocadas allá y un interruptor para simular que no responde.
  const usuarios = {};
  const tokens = {};
  const sesionDe = {};
  const revocadasEnUsuarios = new Set();
  let usuariosCaido = false;
  function emitirToken(rol, venceEn = Date.now() + 12 * 3600e3) {
    const sid = randomUUID();
    sesionDe[rol] = sid;
    return firmar({ sub: usuarios[rol].id, sid, rol: usuarios[rol].rol, iat: 1, exp: Math.floor(venceEn / 1000) }, privateKey);
  }
  for (const rol of ['cliente', 'repartidor', 'almacenista', 'administrador', 'otro_cliente']) {
    usuarios[rol] = { id: randomUUID(), rol: rol === 'otro_cliente' ? 'cliente' : rol };
    tokens[rol] = emitirToken(rol);
  }
  const clienteUsuarios = app.get(UsuariosCliente);
  clienteUsuarios.verificarSesion = async sid => usuariosCaido ? 'no_verificable' : revocadasEnUsuarios.has(sid) ? 'revocada' : 'activa';
  clienteUsuarios.obtenerUsuario = async id => {
    if (usuariosCaido) throw new (require('@nestjs/common').ServiceUnavailableException)('Usuarios no responde');
    return Object.values(usuarios).find(u => u.id === id) ?? null;
  };
  const consumidor = app.get(ConsumidorSesiones);
  const revocarPorEvento = rol => consumidor.procesar({
    tipo: 'sesion_terminada', sesionId: sesionDe[rol], usuarioId: usuarios[rol].id, venceEn: new Date(Date.now() + 3600e3).toISOString(),
  });

  async function pedir(ruta, metodo = 'GET', cuerpo, token, esperado = 200) {
    const respuesta = await fetch(`${url}${ruta.startsWith('/health') ? '' : '/api/v1'}${ruta}`, {
      method: metodo, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const datos = await respuesta.json();
    assert.equal(respuesta.status, esperado, JSON.stringify(datos));
    return datos;
  }
  async function crearPaquete(guia) {
    return pedir('/paquetes', 'POST', { numeroGuia: guia, clienteId: usuarios.cliente.id, destinatario: 'Titular privado', direccion: 'Dirección privada 123' }, tokens.administrador, 201);
  }
  async function escanear(guia, tipo, extra = {}, esperado = 201, id = randomUUID(), token) {
    return pedir('/movimientos/escanear', 'POST', { id, numeroGuia: guia, tipo, ...extra },
      token ?? tokens[['ingreso_almacen', 'ingreso_centro_distribucion'].includes(tipo) ? 'almacenista' : 'repartidor'], esperado);
  }
  async function llevarAlCentro(guia) {
    await escanear(guia, 'ingreso_almacen', { ubicacion: 'Almacén de prueba' });
    await escanear(guia, 'ingreso_centro_distribucion', { ubicacion: 'Centro de prueba' });
  }

  await t.test('salud, tokens verificados localmente, permisos y validación', async () => {
    assert.equal((await pedir('/health')).estado, 'UP');
    await pedir('/paquetes', 'POST', {}, undefined, 401);
    await pedir('/paquetes', 'POST', {}, tokens.cliente, 403);
    await pedir('/paquetes', 'POST', {}, tokens.administrador, 400);
    await pedir('/tracking/INEXISTENTE', 'GET', undefined, undefined, 404);
    const vencido = firmar({ sub: usuarios.cliente.id, sid: randomUUID(), rol: 'cliente', iat: 1, exp: 10 }, privateKey);
    await pedir('/reintentos', 'GET', undefined, vencido, 401);
    const ajeno = firmar({ sub: usuarios.administrador.id, sid: randomUUID(), rol: 'administrador', iat: 1, exp: 4e9 }, generateKeyPairSync('ed25519').privateKey);
    await pedir('/reintentos', 'GET', undefined, ajeno, 401);
    const [e, , f] = tokens.repartidor.split('.');
    const alterado = `${e}.${Buffer.from(JSON.stringify({ sub: usuarios.repartidor.id, sid: sesionDe.repartidor, rol: 'administrador', iat: 1, exp: 4e9 })).toString('base64url')}.${f}`;
    await pedir('/paquetes/X/caso', 'PATCH', {}, alterado, 401);
    await pedir('/paquetes', 'POST', { numeroGuia: 'ACME-SIN-TITULAR', clienteId: usuarios.repartidor.id, destinatario: 'X', direccion: 'Y' }, tokens.administrador, 400);
    usuariosCaido = true;
    try {
      await pedir('/paquetes', 'POST', { numeroGuia: 'ACME-SIN-USUARIOS', clienteId: usuarios.cliente.id, destinatario: 'X', direccion: 'Y' }, tokens.administrador, 503);
      await pedir('/reintentos', 'GET', undefined, tokens.repartidor); // con Usuarios caído, el token de jornada sigue sirviendo
    } finally { usuariosCaido = false; }
  });

  await t.test('privacidad, corrección idempotente y UUID incompatible', async () => {
    await crearPaquete('ACME-ENTREGA');
    await crearPaquete('ACME-OTRO');
    await pedir('/tracking/ACME-ENTREGA/detalle', 'GET', undefined, tokens.otro_cliente, 403);
    const id = randomUUID();
    const cambio = { id, direccion: 'Dirección nueva confidencial 456' };
    const ruta = '/movimientos/ACME-ENTREGA/direccion';
    await pedir(ruta, 'PATCH', cambio, tokens.otro_cliente, 403);
    const respuestas = await Promise.all([201, 200].map(() => fetch(`${url}/api/v1${ruta}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.cliente}` }, body: JSON.stringify(cambio),
    })));
    assert.deepEqual(respuestas.map(r => r.status).sort(), [200, 201]);
    await pedir(ruta, 'PATCH', { ...cambio, direccion: 'Otra dirección' }, tokens.cliente, 409);
    await pedir('/movimientos/ACME-OTRO/direccion', 'PATCH', cambio, tokens.cliente, 409);
    const publico = await pedir('/tracking/ACME-ENTREGA');
    assert.deepEqual(Object.keys(publico).sort(), ['estado', 'historial', 'numeroGuia']);
    assert.equal(JSON.stringify(publico).includes('confidencial'), false);
    assert.equal(publico.historial.filter(m => m.tipo === 'direccion_corregida').length, 1);
    const detalle = await pedir('/tracking/ACME-ENTREGA/detalle', 'GET', undefined, tokens.cliente);
    assert.equal(detalle.direccion, cambio.direccion);
    assert.equal(detalle.destinatario, 'Titular privado');
  });

  await t.test('entrega, movimientos concurrentes y estado terminal', async () => {
    const guia = 'ACME-ENTREGA';
    await escanear(guia, 'entregado', { receptor: 'Persona' }, 409);
    await escanear(guia, 'ingreso_almacen', { ubicacion: 'Almacén' }, 403, randomUUID(), tokens.repartidor);
    await llevarAlCentro(guia);
    await escanear(guia, 'salida_ruta');
    await pedir(`/movimientos/${guia}/direccion`, 'PATCH', { id: randomUUID(), direccion: 'Ya es tarde' }, tokens.cliente, 409);
    await escanear(guia, 'entregado', {}, 400);
    await escanear(guia, 'entregado', { receptor: '   ' }, 400);
    const id = randomUUID();
    const entregas = await Promise.all([1, 2].map(() => fetch(`${url}/api/v1/movimientos/escanear`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.repartidor}` },
      body: JSON.stringify({ id, numeroGuia: guia, tipo: 'entregado', receptor: 'Recibe de prueba' }),
    })));
    assert.deepEqual(entregas.map(r => r.status).sort(), [200, 201]);
    await escanear(guia, 'intento_fallido', { motivo: 'No estaba' }, 409);
    await escanear(guia, 'salida_ruta', {}, 409);
    const detalle = await pedir(`/tracking/${guia}/detalle`, 'GET', undefined, tokens.cliente);
    assert.equal(detalle.estado, 'entregado');
    assert.equal(detalle.historial.filter(m => m.tipo === 'entregado').length, 1);
    assert.equal(detalle.historial.at(-1).receptor, 'Recibe de prueba');
  });

  await t.test('tres días, franjas alternas, rollback y cierre de caso', async () => {
    const guia = 'ACME-REINTENTOS';
    await crearPaquete(guia);
    await llevarAlCentro(guia);
    await escanear(guia, 'salida_ruta');
    await escanear(guia, 'intento_fallido', {}, 400);
    const idFallo = randomUUID();
    await escanear(guia, 'intento_fallido', { motivo: 'Domicilio sin respuesta' }, 201, idFallo);
    await escanear(guia, 'intento_fallido', { motivo: 'Domicilio sin respuesta' }, 200, idFallo);
    let pendientes = await pedir('/reintentos', 'GET', undefined, tokens.repartidor);
    assert.equal(pendientes.length, 1);
    assert.equal(pendientes[0].fecha, '2026-10-17');
    assert.equal(pendientes[0].franja, 'tarde');
    const antes = await baseDatos.getRepository(Movimiento).countBy({ numeroGuia: guia });
    await escanear(guia, 'salida_ruta', {}, 409);
    instante = '2026-10-17T16:00:00Z'; // Mañana: no corresponde a la segunda franja.
    await escanear(guia, 'salida_ruta', {}, 409);
    assert.equal(await baseDatos.getRepository(Movimiento).countBy({ numeroGuia: guia }), antes);
    assert.equal(await baseDatos.getRepository(IntentoEntrega).countBy({ numeroGuia: guia }), 1);
    assert.equal(await baseDatos.getRepository(ProgramacionReintento).countBy({ numeroGuia: guia, estado: 'pendiente' }), 1);
    instante = '2026-10-17T21:00:00Z';
    await escanear(guia, 'salida_ruta');
    await escanear(guia, 'intento_fallido', { motivo: 'Segundo día sin respuesta' });
    pendientes = await pedir('/reintentos', 'GET', undefined, tokens.administrador);
    assert.equal(pendientes[0].fecha, '2026-10-18');
    assert.equal(pendientes[0].franja, 'manana');
    instante = '2026-10-18T16:00:00Z';
    await escanear(guia, 'salida_ruta');
    await escanear(guia, 'intento_fallido', { motivo: 'Tercer día sin respuesta' });
    assert.equal((await pedir(`/tracking/${guia}`)).estado, 'en_sucursal');
    assert.deepEqual(await pedir('/reintentos', 'GET', undefined, tokens.repartidor), []);
    const caso = `/paquetes/${guia}/caso`;
    await pedir(caso, 'PATCH', { clienteRespondio: false, notasContacto: 'Sin respuesta' }, tokens.repartidor, 403);
    await pedir(caso, 'PATCH', { clienteRespondio: true, notasContacto: 'Respondió', decisionProveedor: 'regresar' }, tokens.administrador, 400);
    const contacto = await pedir(caso, 'PATCH', { clienteRespondio: false, notasContacto: 'Llamada sin respuesta' }, tokens.administrador);
    assert.equal(contacto.casoCerradoEn, null);
    const cerrado = await pedir(caso, 'PATCH', { clienteRespondio: false, notasContacto: 'Proveedor autoriza devolución', decisionProveedor: 'regresar' }, tokens.administrador);
    assert.ok(cerrado.casoCerradoEn);
    assert.equal(cerrado.estado, 'en_sucursal');
    await pedir(caso, 'PATCH', { clienteRespondio: false, notasContacto: 'Repetido' }, tokens.administrador, 409);
    await escanear(guia, 'salida_ruta', {}, 409);
  });

  await t.test('un error de escritura revierte paquete e historial juntos', async () => {
    await crearPaquete('ACME-ROLLBACK');
    const original = app.get(require('../../dist/reintentos/reintentos.service').ReintentosService).registrarSalidaARuta;
    const servicio = app.get(require('../../dist/reintentos/reintentos.service').ReintentosService);
    await llevarAlCentro('ACME-ROLLBACK');
    servicio.registrarSalidaARuta = async (transaccion) => {
      await transaccion.query("INSERT INTO intentos_entrega (\"numeroGuia\") VALUES ('NO-EXISTE')");
    };
    try {
      await escanear('ACME-ROLLBACK', 'salida_ruta', {}, 503);
    } finally { servicio.registrarSalidaARuta = original; }
    const paquete = await baseDatos.getRepository(Paquete).findOneByOrFail({ numeroGuia: 'ACME-ROLLBACK' });
    assert.equal(paquete.estado, 'en_centro_distribucion');
    assert.equal(paquete.primeraSalidaEn, null);
    assert.equal(await baseDatos.getRepository(Movimiento).countBy({ numeroGuia: 'ACME-ROLLBACK', tipo: 'salida_ruta' }), 0);
  });

  await t.test('dos entregas distintas concurrentes solo confirman una', async () => {
    const guia = 'ACME-CONCURRENTE';
    await crearPaquete(guia);
    await llevarAlCentro(guia);
    await escanear(guia, 'salida_ruta');
    const respuestas = await Promise.all([1, 2].map(numero => fetch(`${url}/api/v1/movimientos/escanear`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.repartidor}` },
      body: JSON.stringify({ id: randomUUID(), numeroGuia: guia, tipo: 'entregado', receptor: `Persona ${numero}` }),
    })));
    assert.deepEqual(respuestas.map(r => r.status).sort(), [201, 409]);
    assert.equal(await baseDatos.getRepository(Movimiento).countBy({ numeroGuia: guia, tipo: 'entregado' }), 1);
  });

  await t.test('Usuarios caído: "entregado" queda pendiente y no es terminal hasta confirmar la sesión', async () => {
    const guia = 'ACME-PENDIENTE';
    await crearPaquete(guia);
    await llevarAlCentro(guia);
    await escanear(guia, 'salida_ruta');
    usuariosCaido = true;
    const id = randomUUID();
    const { movimiento } = await escanear(guia, 'entregado', { receptor: 'Vecina' }, 202, id);
    assert.equal(movimiento.confirmacion, 'pendiente');
    await escanear(guia, 'entregado', { receptor: 'Vecina' }, 200, id);
    let publico = await pedir(`/tracking/${guia}`);
    assert.equal(publico.estado, 'entrega_por_confirmar');
    assert.equal(publico.historial.at(-1).confirmacion, 'pendiente');
    await escanear(guia, 'intento_fallido', { motivo: 'X' }, 409);
    assert.deepEqual(await app.get(ConfirmacionesService).reconciliar(), { confirmados: 0, rechazados: 0 });
    usuariosCaido = false;
    assert.deepEqual(await app.get(ConfirmacionesService).reconciliar(), { confirmados: 1, rechazados: 0 });
    publico = await pedir(`/tracking/${guia}`);
    assert.equal(publico.estado, 'entregado');
    assert.equal(publico.historial.at(-1).confirmacion, 'confirmada');
  });

  await t.test('si la sesión resultó revocada, el "entregado" pendiente se rechaza y el paquete vuelve a ruta', async () => {
    const guia = 'ACME-REVOCADO';
    await crearPaquete(guia);
    await llevarAlCentro(guia);
    await escanear(guia, 'salida_ruta');
    usuariosCaido = true;
    await escanear(guia, 'entregado', { receptor: 'Desconocido' }, 202);
    revocadasEnUsuarios.add(sesionDe.repartidor); // el celular se reportó robado mientras Usuarios no respondía
    usuariosCaido = false;
    assert.deepEqual(await app.get(ConfirmacionesService).reconciliar(), { confirmados: 0, rechazados: 1 });
    const detalle = await pedir(`/tracking/${guia}/detalle`, 'GET', undefined, tokens.cliente);
    assert.equal(detalle.estado, 'en_ruta');
    assert.equal(detalle.historial.at(-1).confirmacion, 'rechazada');
    assert.equal((await pedir(`/tracking/${guia}`)).historial.some(m => m.tipo === 'entregado'), false);
    await escanear(guia, 'entregado', { receptor: 'Titular' }, 401); // revocación síncrona: 401 inmediato
    revocadasEnUsuarios.delete(sesionDe.repartidor);
    tokens.repartidor = emitirToken('repartidor'); // nueva sesión del repartidor legítimo
    await escanear(guia, 'entregado', { receptor: 'Titular' }, 201);
    assert.equal((await pedir(`/tracking/${guia}`)).estado, 'entregado');
  });

  await t.test('corrección de dirección pendiente: se aplica al confirmar, o se rechaza si ya salió a ruta', async () => {
    await crearPaquete('ACME-DIR-OK');
    await crearPaquete('ACME-DIR-TARDE');
    usuariosCaido = true;
    for (const guia of ['ACME-DIR-OK', 'ACME-DIR-TARDE']) {
      await pedir(`/movimientos/${guia}/direccion`, 'PATCH', { id: randomUUID(), direccion: 'Nueva 789' }, tokens.cliente, 202);
      assert.equal((await pedir(`/tracking/${guia}/detalle`, 'GET', undefined, tokens.cliente)).direccion, 'Dirección privada 123');
    }
    usuariosCaido = false;
    await llevarAlCentro('ACME-DIR-TARDE');
    await escanear('ACME-DIR-TARDE', 'salida_ruta');
    assert.deepEqual(await app.get(ConfirmacionesService).reconciliar(), { confirmados: 1, rechazados: 1 });
    assert.equal((await pedir('/tracking/ACME-DIR-OK/detalle', 'GET', undefined, tokens.cliente)).direccion, 'Nueva 789');
    const tarde = await pedir('/tracking/ACME-DIR-TARDE/detalle', 'GET', undefined, tokens.cliente);
    assert.equal(tarde.direccion, 'Dirección privada 123');
    assert.match(tarde.historial.find(m => m.tipo === 'direccion_corregida').notaConfirmacion, /salió a ruta/);
  });

  await t.test('el evento sesion_terminada revoca el token localmente, una sola vez aunque llegue repetido', async () => {
    await pedir('/reintentos', 'GET', undefined, tokens.repartidor);
    await revocarPorEvento('repartidor');
    await revocarPorEvento('repartidor');
    await pedir('/reintentos', 'GET', undefined, tokens.repartidor, 401);
    const [{ total }] = await baseDatos.query('SELECT count(*)::int AS total FROM sesiones_revocadas WHERE "sesionId" = $1', [sesionDe.repartidor]);
    assert.equal(total, 1);
    await pedir('/tracking/ACME-ENTREGA');
  });

  await t.test('el consumidor real de RabbitMQ aplica la revocación publicada en acme.eventos', { skip: !process.env.RABBITMQ_URL && 'sin RABBITMQ_URL' }, async () => {
    consumidor.iniciar();
    assert.equal(await consumidor.ponerseAlDia(10000), true);
    const amqp = require('amqplib');
    const conexion = await amqp.connect(process.env.RABBITMQ_URL);
    try {
      const canal = await conexion.createConfirmChannel();
      const evento = { tipo: 'sesion_terminada', sesionId: sesionDe.almacenista, usuarioId: usuarios.almacenista.id, venceEn: new Date(Date.now() + 3600e3).toISOString() };
      canal.publish('acme.eventos', 'sesion.terminada', Buffer.from(JSON.stringify(evento)), { persistent: true, messageId: evento.sesionId });
      await canal.waitForConfirms();
    } finally { await conexion.close(); }
    let estado = 0;
    for (let i = 0; i < 50 && estado !== 401; i++) {
      estado = (await fetch(`${url}/api/v1/reintentos`, { headers: { Authorization: `Bearer ${tokens.almacenista}` } })).status;
      if (estado !== 401) await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(estado, 401);
    assert.equal((await pedir('/health')).mensajeria, 'UP');
  });

  await t.test('sin conexión a la base se responde 503 y no se exponen errores internos', async () => {
    const conexion = app.get(require('typeorm').DataSource);
    await conexion.destroy();
    try {
      await pedir('/health', 'GET', undefined, undefined, 503);
      const error = await pedir('/tracking/ACME-ENTREGA', 'GET', undefined, undefined, 503);
      assert.equal('stack' in error, false);
      await pedir('/reintentos', 'GET', undefined, tokens.administrador, 503);
    } finally { await conexion.initialize(); }
  });
});
