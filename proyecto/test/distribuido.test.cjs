const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'jwt-de-pruebas';
process.env.CLAVE_INTERNA = 'ancla-de-pruebas';
const { CircuitoConsulta } = require('../dist/distribuido/gateway');
const { crearAncla, horaEscaneo, autenticar, sincronizarRevocaciones } = require('../dist/distribuido/sesiones');
const { RelojOffline } = require('../dist/reloj-offline');
const { cache } = require('../dist/distribuido/infra');
const { JwtService } = require('@nestjs/jwt');

test('el circuito abre con 50 de 100 fallas y reabre si falla la prueba', () => {
  let ahora = 0;
  let azar = 0.2;
  const circuito = new CircuitoConsulta(() => ahora, () => azar);
  for (let i = 0; i < 100; i++) circuito.terminar(circuito.entrar(), i >= 50);
  assert.equal(circuito.estado().estado, 'abierto');
  assert.equal(circuito.entrar(), null);
  ahora = 60000;
  assert.equal(circuito.estado().estado, 'semiabierto');
  assert.equal(circuito.entrar(), null);
  azar = 0.04;
  circuito.terminar(circuito.entrar(), true);
  assert.equal(circuito.estado().estado, 'abierto');
  ahora = 120000;
  const prueba = circuito.entrar();
  assert.equal(circuito.entrar(), null);
  circuito.terminar(prueba, false);
  assert.deepEqual(circuito.estado(), { estado: 'cerrado', muestras: 0, fallas: 0 });
});

test('el reloj conserva el ancla tras renovar la sesión y marca la discrepancia', () => {
  const actor = { id: 'repartidor', sesionId: 'primera' };
  const { servidorMs, ancla } = crearAncla(actor);
  const datos = { ancla, transcurridoMs: 0, relojLocalMs: servidorMs + 4 * 60 * 1000 };
  const confirmado = horaEscaneo(datos, { ...actor, sesionId: 'renovada' });
  assert.equal(confirmado.registradoEn, new Date(servidorMs).toISOString());
  assert.equal(confirmado.sospechoso, true);
  assert.equal(horaEscaneo({ ...datos, relojLocalMs: servidorMs }, actor).sospechoso, false);
  assert.equal(horaEscaneo({ relojLocalMs: servidorMs }, actor).sospechoso, true);
  assert.equal(horaEscaneo({ ...datos, relojLocalMs: servidorMs, relojIncierto: true }, actor).sospechoso, true);
});

test('el reloj offline conserva lo medido al recargar sin usar el reloj alterado del equipo', () => {
  const valores = new Map();
  const almacen = { getItem: clave => valores.get(clave) ?? null, setItem: (clave, valor) => valores.set(clave, valor) };
  let monotono = 0;
  let pared = 100000;
  const reloj = new RelojOffline('repartidor', almacen, () => monotono, () => pared);
  reloj.anclar({ ancla: 'firmada', servidorMs: 100000 });
  monotono = 4000;
  pared += 86400000;
  const anterior = reloj.capturar();
  assert.equal(anterior.transcurridoMs, 4000);
  assert.equal(anterior.relojIncierto, false);

  monotono = 0; // Otro documento: performance.now() vuelve a empezar.
  const reabierto = new RelojOffline('repartidor', almacen, () => monotono, () => pared);
  monotono = 3000;
  const posterior = reabierto.capturar();
  assert.equal(posterior.ancla, anterior.ancla);
  assert.equal(posterior.transcurridoMs, 7000);
  assert.equal(posterior.relojIncierto, true);
  assert.equal(anterior.transcurridoMs, 4000, 'no reescribe los escaneos ya encolados');
  assert.equal(new RelojOffline('otro', almacen).capturar().ancla, undefined);
  reabierto.anclar({ ancla: 'nueva', servidorMs: 200000 });
  assert.equal(reabierto.capturar().relojIncierto, false);
});

test('sin ancla o con almacenamiento local averiado se puede capturar y se marca la incertidumbre', () => {
  const almacen = { getItem: () => { throw new Error('sin almacenamiento'); }, setItem: () => { throw new Error('sin almacenamiento'); } };
  const reloj = new RelojOffline('repartidor', almacen, () => 0, () => 42);
  assert.equal(reloj.capturar().relojIncierto, true);
  reloj.anclar({ ancla: 'firmada', servidorMs: 100 });
  assert.equal(reloj.capturar().ancla, 'firmada');
});

test('el arranque exige recuperar revocaciones y luego rechaza tokens revocados aun sin Redis', async t => {
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  const token = sid => 'Bearer ' + jwt.sign({ sub: 'repartidor', sid, rol: 'repartidor' },
    { algorithm: 'HS256', issuer: 'acme-usuarios', expiresIn: '1h' });
  await assert.rejects(autenticar(token('revocada')), error => error.getStatus() === 503);
  const peticion = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 }));
  await assert.rejects(sincronizarRevocaciones());
  await assert.rejects(autenticar(token('vigente')), error => error.getStatus() === 503);
  peticion.mock.mockImplementation(async () => new Response(JSON.stringify([
    { clave: 'sesion.terminada', id: 'revocada', vence: Date.now() + 3600000 },
  ]), { status: 200 }));
  await sincronizarRevocaciones();
  t.mock.method(cache, 'get', async () => { throw new Error('Redis fuera de línea'); });
  await assert.rejects(autenticar(token('revocada')), error => error.getStatus() === 401);
  assert.equal((await autenticar(token('vigente'))).sesionId, 'vigente');
});

