require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const amqp = require('amqplib');

const urls = (process.env.TEST_USUARIOS_DB_URLS ?? '').split(',').filter(Boolean);
const caida = 'postgres://nadie:nada@127.0.0.1:1/usuarios_test'; // réplica inalcanzable
const contrasena = 'AcmeDemo2026!';

test('Usuarios con quórum sobre 3 PostgreSQL reales', async t => {
  assert.equal(urls.length, 3, 'TEST_USUARIOS_DB_URLS debe tener 3 réplicas');
  for (const url of urls) assert.match(url, /\/usuarios_test$/, 'Usa bases exclusivas de prueba (usuarios_test)');
  const { privateKey } = generateKeyPairSync('ed25519');
  Object.assign(process.env, {
    USUARIOS_DB_URLS: urls.join(','), JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    RABBITMQ_URL: process.env.TEST_RABBITMQ_URL, PUBLICAR_CADA_MS: '200', QUORUM_TIMEOUT_MS: '1000',
  });
  const { Replicas } = require('../../dist/quorum');
  const { UsuariosService } = require('../../dist/usuarios.service');
  const { crearAplicacion } = require('../../dist/crear-aplicacion');

  const todas = new Replicas(urls, 1000);
  t.after(() => todas.cerrar());
  await todas.vaciarParaPruebas();
  const servicio = new UsuariosService(todas, privateKey);
  const cuentas = {};
  for (const rol of ['cliente', 'repartidor']) cuentas[rol] = (await servicio.crearSiNoExiste(`${rol}@acme.test`, rol, rol, contrasena)).id;
  assert.equal((await servicio.crearSiNoExiste('cliente@acme.test', 'otro', 'cliente', 'OtraClave2026!')).creado, false);

  // Cola propia para observar los eventos que publica el outbox.
  const conexion = await amqp.connect(process.env.TEST_RABBITMQ_URL);
  t.after(() => conexion.close());
  const canal = await conexion.createChannel();
  await canal.assertExchange('acme.eventos', 'topic', { durable: true });
  const { queue } = await canal.assertQueue('', { exclusive: true });
  await canal.bindQueue(queue, 'acme.eventos', 'sesion.terminada');
  const eventos = [];
  await canal.consume(queue, mensaje => { eventos.push({ id: mensaje.properties.messageId, ...JSON.parse(mensaje.content) }); }, { noAck: true });

  const app = await crearAplicacion();
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const url = await app.getUrl();
  async function pedir(ruta, metodo = 'GET', cuerpo, token, esperado = 200) {
    const respuesta = await fetch(`${url}${ruta}`, {
      method: metodo, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const datos = await respuesta.json();
    assert.equal(respuesta.status, esperado, JSON.stringify(datos));
    return datos;
  }
  const login = (correo, clave, esperado) => pedir('/api/v1/auth/login', 'POST', { correo, contrasena: clave }, undefined, esperado);

  await t.test('salud, login, validación y rutas internas', async () => {
    assert.equal((await pedir('/health')).estado, 'UP');
    await login('cliente@acme.test', 'incorrecta', 401);
    await login('no-es-correo', contrasena, 400);
    const sesion = await login('cliente@acme.test', contrasena);
    assert.equal(sesion.usuario.rol, 'cliente');
    const sid = JSON.parse(Buffer.from(sesion.token.split('.')[1], 'base64url')).sid;
    assert.deepEqual(await pedir(`/interno/sesiones/${sid}`), { sesionId: sid, activa: true, usuarioId: cuentas.cliente });
    assert.equal((await pedir(`/interno/usuarios/${cuentas.cliente}`)).rol, 'cliente');
    await pedir(`/interno/usuarios/${randomUUID()}`, 'GET', undefined, undefined, 404);
    await pedir('/interno/sesiones/no-uuid', 'GET', undefined, undefined, 400);
  });

  await t.test('logout revoca y publica sesion_terminada una vez confirmado por el quórum', async () => {
    const { token } = await login('repartidor@acme.test', contrasena);
    const sid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sid;
    await pedir('/api/v1/auth/logout', 'POST', {}, token);
    await pedir('/api/v1/auth/logout', 'POST', {}, token, 401);
    assert.equal((await pedir(`/interno/sesiones/${sid}`)).activa, false);
    for (let i = 0; i < 50 && !eventos.some(e => e.id === sid); i++) await new Promise(r => setTimeout(r, 100));
    const evento = eventos.find(e => e.id === sid);
    assert.equal(evento?.tipo, 'sesion_terminada');
    assert.equal(evento.usuarioId, cuentas.repartidor);
    const filas = await todas.leerVarios('sesiones', 'id = $1', [sid]);
    assert.equal(filas[0].evento_publicado, true);
  });

  await t.test('con una réplica caída hay servicio; con dos, 503 y los tokens siguen siendo verificables', async () => {
    const conUnaCaida = new UsuariosService(new Replicas([urls[0], urls[1], caida], 1000), privateKey);
    const sesion = await conUnaCaida.iniciarSesion('cliente@acme.test', contrasena);
    const sinMayoria = new Replicas([urls[0], caida, caida], 1000);
    await assert.rejects(new UsuariosService(sinMayoria, privateKey).iniciarSesion('cliente@acme.test', contrasena), /Sin quórum/);
    assert.equal((await sinMayoria.estado()).quorum, false);
    const { verificarToken, llavePublicaDe } = require('../../dist/tokens');
    assert.equal(verificarToken(sesion.token, llavePublicaDe(privateKey)).sub, cuentas.cliente);
  });

  await t.test('R + W > N: después de cambiar la contraseña con una réplica caída, la vieja nunca gana', async () => {
    const sinLaTercera = new UsuariosService(new Replicas([urls[0], urls[1], caida], 1000), privateKey);
    const { token } = await sinLaTercera.iniciarSesion('cliente@acme.test', contrasena);
    const { datos } = await sinLaTercera.autenticar(token);
    await sinLaTercera.cambiarContrasena(datos.sub, contrasena, 'NuevaClave2026!');
    // La tercera réplica todavía tiene el hash viejo, pero cualquier mayoría incluye una réplica actualizada.
    const sinLaPrimera = new UsuariosService(new Replicas([caida, urls[1], urls[2]], 1000), privateKey);
    await assert.rejects(sinLaPrimera.iniciarSesion('cliente@acme.test', contrasena), /incorrectos/);
    await sinLaPrimera.iniciarSesion('cliente@acme.test', 'NuevaClave2026!');
    assert.equal((await sinLaPrimera.estadoSesion(datos.sid)).activa, false, 'el cambio de contraseña revoca las sesiones');
    // La lectura reparó la tercera réplica: ahora ella sola coincide con la segunda.
    await new Promise(r => setTimeout(r, 200));
    const solo23 = new Replicas([caida, urls[1], urls[2]], 1000);
    const usuario = await solo23.leerUno('usuarios', 'id = $1', [cuentas.cliente]);
    const directo = new (require('pg').Pool)({ connectionString: urls[2] });
    const [fila] = (await directo.query('SELECT version FROM usuarios WHERE id = $1', [cuentas.cliente])).rows;
    await directo.end();
    assert.equal(Number(fila.version), usuario.version);
  });
});
