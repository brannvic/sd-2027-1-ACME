import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as dormir } from 'node:timers/promises';

const origen = process.env.ACME_URL ?? 'http://localhost:8083';
const contrasena = process.env.DEMO_PASSWORD ?? 'AcmeDemo2026!';
const noEncontrada = 'NO-EXISTE-' + randomUUID().slice(0, 8).toUpperCase();
const id = () => randomUUID();
const guia = () => 'PRUEBA-' + id().slice(0, 12).toUpperCase();
const shard = g => createHash('sha256').update(g).digest()[0] % 4;

async function http(ruta, opciones = {}) {
  const { datos, token, espera = 200 } = opciones;
  const r = await fetch(origen + '/api/v1/' + ruta, {
    method: datos ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: datos ? JSON.stringify(datos) : undefined, signal: AbortSignal.timeout(32000),
  });
  const json = await r.json();
  assert.equal(r.status, espera, ruta + ' → ' + (json.message ?? r.statusText));
  return json;
}

async function hasta(prueba, segundos = 45) {
  const inicios = Date.now();
  for (;;) {
    try { return await prueba(); }
    catch (error) {
      if (Date.now() - inicios >= segundos * 1000) throw error;
      await dormir(500);
    }
  }
}

const login = (rol, espera = 200, clave = contrasena) => http('auth/login', {
  datos: { correo: rol + '@acme.test', contrasena: clave }, espera,
});
const loginReal = (correo, clave, espera = 200) => http('auth/login', { datos: { correo, contrasena: clave }, espera });
const [cliente, almacen, repartidor, proveedor, admin] = await hasta(() =>
  Promise.all(['cliente', 'almacenista', 'repartidor', 'proveedor', 'administrador'].map(rol => login(rol))), 120);
const correo = 'prueba-' + id() + '@acme.test';
const clave = 'Prueba-Acme-43!';
const otro = await http('auth/registro', { datos: { correo, nombre: 'Otro cliente', contrasena: clave }, espera: 201 });
const otroLogin = await loginReal(correo, clave);
assert.equal(otroLogin.usuario.id, otro.id);
const crear = g => http('movimientos/envios', { token: proveedor.token, espera: 201, datos: {
  numeroGuia: g, clienteId: cliente.usuario.id, destinatario: 'Titular de prueba', direccion: 'Calle inicial 42',
} });
const escanear = (g, tipo, extra = {}, token = repartidor.token, espera = 200) =>
  http('movimientos/escanear', { token, espera, datos: { id: id(), numeroGuia: g, tipo, ...extra } });
const direccion = g => http('movimientos/' + g + '/direccion', { token: repartidor.token });
const consulta = (g, token, espera = 200) => http('tracking/' + g + (token ? '/detalle' : ''), { token, espera });
const posicionar = async g => {
  await escanear(g, 'ingreso_almacen', { ubicacion: 'A1' }, almacen.token);
  await escanear(g, 'ingreso_centro_distribucion', { ubicacion: 'C1' }, almacen.token);
};

const g = guia();
await crear(g);
await hasta(async () => assert.equal((await consulta(g)).estado, 'creado'));
const publico = await consulta(g);
assert.deepEqual(Object.keys(publico).sort(), ['estado', 'historial', 'numeroGuia']);
await consulta(noEncontrada, undefined, 404);
await consulta(g, otroLogin.token, 403);
assert.equal((await consulta(g, cliente.token)).destinatario, 'Titular de prueba');
const correccion = { id: id(), direccion: 'Dirección corregida 10' };
const corregir = (g, datos, espera = 200) => http('movimientos/' + g + '/direccion', { token: cliente.token, datos, espera });
assert.equal((await corregir(g, correccion)).duplicado, false);
assert.equal((await corregir(g, correccion)).duplicado, true);
assert.equal((await direccion(g)).revisionDireccion, 2);
await posicionar(g);
await escanear(g, 'salida_ruta', {}, 'token-invalido', 401);
const salida = { id: id(), numeroGuia: g, tipo: 'salida_ruta', revisionDireccion: 2 };
const entrega = { id: id(), numeroGuia: g, tipo: 'entregado', receptor: 'Receptor de prueba', revisionDireccion: 2 };
await escanear(g, 'entregado', {}, repartidor.token, 400);
const lote = () => http('movimientos/sincronizar', { token: repartidor.token, datos: { escaneos: [salida, entrega] } });
assert.deepEqual((await lote()).resultados.map(x => x.status), [200, 200]);
assert.deepEqual((await lote()).resultados.map(x => x.duplicado), [true, true]);
await corregir(g, { id: id(), direccion: 'Demasiado tarde 54' }, 409);
await hasta(async () => {
  const vista = await consulta(g, cliente.token);
  assert.equal(vista.estado, 'entregado');
  assert.equal(vista.historial.filter(m => m.tipo === 'entregado').length, 1);
  assert.equal(vista.historial.filter(m => m.tipo === 'direccion_corregida').length, 1);
});
console.log('✓ Rastreo, privacidad, corrección, lote idempotente y entrega terminal');

const errorGuia = guia();
await crear(errorGuia);
await posicionar(errorGuia);
await corregir(errorGuia, { id: id(), direccion: 'Nueva calle 40' });
await escanear(errorGuia, 'salida_ruta');
assert.equal((await escanear(errorGuia, 'entregado', { receptor: 'Receptor', revisionDireccion: 1 })).movimiento.tipo, 'entrega_erronea');
await http('movimientos/' + errorGuia + '/recuperar', { token: admin.token, datos: { id: id() } });
assert.equal((await direccion(errorGuia)).estado, 'en_centro_distribucion');
console.log('✓ Compensación de entrega a dirección previa y recuperación');

const reintento = guia();
await crear(reintento);
await posicionar(reintento);
const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
// Reloj de fixture para simular 3 días de operación en segundos.
function reloj(dias, hora, minuto = 0) {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() - dias);
  t.setUTCHours(hora + 6, minuto, 0, 0);
  const servidorMs = +t;
  const datos = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: repartidor.usuario.id, iss: 'acme-reloj', servidorMs });
  const firma = createHmac('sha256', process.env.CLAVE_INTERNA ?? 'acme-interna-demo-78fe00547abc').update(datos).digest('base64url');
  return { ancla: datos + '.' + firma, transcurridoMs: 0, relojLocalMs: servidorMs + 300000 };
}
for (const [dias, hora] of [[4, 10], [3, 15], [2, 10]]) {
  await escanear(reintento, 'salida_ruta', reloj(dias, hora));
  const datos = { ...reloj(dias, hora, 30), id: id(), motivo: 'Ausente' };
  const fallo = await escanear(reintento, 'intento_fallido', datos);
  assert.equal(fallo.movimiento.sospechoso, true);
  assert.equal((await escanear(reintento, 'intento_fallido', datos)).duplicado, true);
  await hasta(async () => {
    const d = await direccion(reintento);
    if (dias === 2) assert.equal(d.estado, 'en_sucursal');
    else assert.equal(d.plan?.franja, hora === 10 ? 'tarde' : 'manana');
  });
}
await http('movimientos/' + reintento + '/caso', { token: admin.token, datos: {
  clienteRespondio: false, notasContacto: 'Sin respuesta', decisionProveedor: 'regresar',
} });
await hasta(async () => assert.equal((await consulta(reintento, cliente.token)).decisionProveedor, 'regresar'));
console.log('✓ Tres días, franjas alternadas, reloj sospechoso, sucursal y decisión');

const nueva = clave + '-Nueva';
await http('auth/contrasena', { token: otroLogin.token, datos: { actual: clave, nueva } });
await loginReal(correo, clave, 401);
const actualizada = await loginReal(correo, nueva);
await http('auth/logout', { token: actualizada.token, datos: {} });
await hasta(() => consulta(g, actualizada.token, 401));
console.log('✓ Contraseña consistente y revocación de sesión');

if (process.argv.includes('--fallas')) {
  const archivo = fileURLToPath(new URL('../docker-compose.yml', import.meta.url));
  const docker = (...args) => execFileSync('docker', ['compose', '-f', archivo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const pg = ['usuarios-pg1', 'usuarios-pg2', 'usuarios-pg3'];
  const lider = pg.find(nodo => {
    try {
      docker('exec', '-T', nodo, '/opt/patroni/bin/python', '-c',
        'from urllib.request import urlopen; urlopen("http://localhost:8008/primary")');
      return true;
    } catch { return false; }
  });
  assert.ok(lider);
  try {
    docker('stop', lider);
    await hasta(() => login('cliente'), 90);
    await loginReal(correo, clave, 401);
  } finally { docker('start', lider); }
  const esperaUnico = guia();
  const esperaCorreccion = guia();
  const falloEnEspera = id();
  await crear(esperaUnico);
  await crear(esperaCorreccion);
  await posicionar(esperaUnico);
  await posicionar(esperaCorreccion);
  const detenidos = pg.slice(0, 2);
  try {
    docker('stop', ...detenidos);
    await hasta(() => login('cliente', 503), 40);
    await http('auth/registro', { datos: { correo: 'sin-quorum@acme.test', nombre: 'Sin quórum', contrasena: clave }, espera: 503 });
    await escanear(esperaUnico, 'salida_ruta');
    const pendiente = await escanear(esperaUnico, 'entregado', { receptor: 'Se confirma después' });
    assert.equal(pendiente.movimiento.confirmacion, 'pendiente');
    assert.equal((await direccion(esperaUnico)).estado, 'en_ruta');
    const falloPosterior = await escanear(esperaUnico, 'intento_fallido', { id: falloEnEspera, motivo: 'Resultado concurrente' });
    assert.equal(falloPosterior.movimiento.confirmacion, 'pendiente');
    assert.equal((await direccion(esperaUnico)).estado, 'en_ruta');
    const cambios = await corregir(esperaCorreccion, { id: id(), direccion: 'Dirección pendiente 17' });
    assert.equal(cambios.movimiento.confirmacion, 'pendiente');
    await escanear(esperaCorreccion, 'salida_ruta');
    await escanear(esperaCorreccion, 'intento_fallido', { motivo: 'Domicilio equivocado' });
    await hasta(async () => assert.equal((await direccion(esperaCorreccion)).plan?.direccion, 'Calle inicial 42'));
  } finally { docker('start', ...detenidos); }
  await hasta(async () => assert.equal((await direccion(esperaUnico)).estado, 'entregado'), 85);
  await hasta(async () => {
    const vista = await consulta(esperaUnico, cliente.token);
    assert.equal(vista.estado, 'entregado');
    assert.equal(vista.historial.find(m => m.id === falloEnEspera)?.confirmacion, 'rechazado');
    assert.equal(vista.plan, null);
  });
  await hasta(async () => {
    const actual = await direccion(esperaCorreccion);
    assert.equal(actual.direccion, 'Dirección pendiente 17');
    assert.equal(actual.plan?.direccion, actual.direccion);
    assert.equal(actual.plan?.revisionDireccion, actual.revisionDireccion);
  });
  console.log('✓ Promoción con mayoría, confirmaciones pendientes y cambio de dirección del reintento');

  const sesionRevocada = await login('repartidor');
  await http('auth/logout', { token: sesionRevocada.token, datos: {} });
  try {
    docker('stop', 'redis');
    docker('restart', 'gateway', 'monolito', 'movimientos');
    await hasta(() => http('movimientos/hora', { token: sesionRevocada.token, espera: 401 }), 65);
    await hasta(() => direccion(g));
  } finally { docker('start', 'redis'); }
  // Espera a que Nginx resuelva todas las copias del gateway.
  await hasta(async () => {
    const respuestas = await Promise.all(Array.from({ length: 12 }, async () => {
      const r = await fetch(origen + '/health', { signal: AbortSignal.timeout(3000) });
      assert.equal(r.status, 200);
      return r.json();
    }));
    assert.ok(respuestas.every(r => r.servicio === 'gateway'));
  });
  console.log('✓ Recuperación de revocaciones tras reiniciar las API sin Redis; tokens vigentes siguen funcionando');

  const caida = guia();
  let sano = guia();
  while (shard(sano) === shard(caida)) sano = guia();
  await crear(caida);
  await crear(sano);
  const nombre = 'shard' + shard(caida);
  try {
    docker('stop', nombre);
    await escanear(caida, 'ingreso_almacen', { ubicacion: 'A1' }, almacen.token, 503);
    await escanear(sano, 'ingreso_almacen', { ubicacion: 'A1' }, almacen.token);
  } finally { docker('start', nombre); }
  console.log('✓ Caída aislada de una partición');

  const broker = guia();
  await crear(broker);
  await hasta(async () => assert.equal((await consulta(broker)).estado, 'creado'));
  try {
    docker('stop', 'rabbit');
    await escanear(broker, 'ingreso_almacen', { ubicacion: 'A1' }, almacen.token);
    assert.equal((await consulta(broker)).estado, 'creado');
  } finally { docker('start', 'rabbit'); }
  await hasta(async () => assert.equal((await consulta(broker)).estado, 'en_almacen'), 55);
  console.log('✓ Recuperación de eventos acumulados en outbox');

  try {
    docker('stop', 'monolito');
    const atrasado = await consulta(g);
    assert.equal(atrasado.desactualizado, true);
    await consulta(noEncontrada, undefined, 503);
    for (let i = 0; i < 12; i++) await Promise.all(Array.from({ length: 30 }, () => consulta(g)));
    const estados = await Promise.all(Array.from({ length: 12 }, async () => (await (await fetch(origen + '/health')).json()).consulta.estado));
    assert.ok(estados.every(estado => estado === 'abierto'), estados.join(','));
  } finally { docker('start', 'monolito'); }
  console.log('✓ Pérdida de Consulta, circuit breaker abierto y respaldo en Redis');
}
