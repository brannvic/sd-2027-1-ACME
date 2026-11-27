const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'jwt-de-pruebas';
process.env.CLAVE_INTERNA = 'ancla-de-pruebas';
const { CircuitoConsulta } = require('../dist/distribuido/gateway');
const { crearAncla, horaEscaneo } = require('../dist/distribuido/sesiones');

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
});

