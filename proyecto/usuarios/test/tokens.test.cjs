const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { firmarToken, verificarToken, llavePublicaDe } = require('../dist/tokens');
const { Replicas } = require('../dist/quorum');
const { generarHashContrasena, verificarContrasena } = require('../dist/contrasenas');

const { privateKey } = generateKeyPairSync('ed25519');
const datos = { sub: 'u1', sid: 's1', rol: 'repartidor', iat: 1, exp: Math.floor(Date.now() / 1000) + 60 };

test('un token firmado con la privada se verifica solo con la pública', () => {
  const token = firmarToken(datos, privateKey);
  assert.deepEqual(verificarToken(token, llavePublicaDe(privateKey)), datos);
});

test('se rechaza un token alterado, firmado con otra llave o vencido', () => {
  const token = firmarToken(datos, privateKey);
  const publica = llavePublicaDe(privateKey);
  const [e, , f] = token.split('.');
  const alterado = `${e}.${Buffer.from(JSON.stringify({ ...datos, rol: 'administrador' })).toString('base64url')}.${f}`;
  assert.throws(() => verificarToken(alterado, publica), /Firma/);
  assert.throws(() => verificarToken(firmarToken(datos, generateKeyPairSync('ed25519').privateKey), publica), /Firma/);
  assert.throws(() => verificarToken(firmarToken({ ...datos, exp: 10 }, privateKey), publica), /vencido/);
  assert.throws(() => verificarToken('a.b', publica));
});

test('la mayoría de 3 réplicas es 2 y las versiones siempre crecen', () => {
  assert.equal(new Replicas(['a', 'b', 'c']).mayoria, 2);
  assert.equal(new Replicas(['a', 'b', 'c', 'd', 'e']).mayoria, 3);
  const futura = Date.now() + 1e9;
  assert.equal(Replicas.siguienteVersion({ version: futura }), futura + 1);
  assert.ok(Replicas.siguienteVersion() >= Date.now() - 5);
});

test('las contraseñas usan sal distinta y rechazan una clave incorrecta', () => {
  const hash = generarHashContrasena('AcmeDemo2026!');
  assert.notEqual(hash, generarHashContrasena('AcmeDemo2026!'));
  assert.equal(verificarContrasena('AcmeDemo2026!', hash), true);
  assert.equal(verificarContrasena('incorrecta', hash), false);
  assert.equal(verificarContrasena('incorrecta', 'invalido'), false);
});
