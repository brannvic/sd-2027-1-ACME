#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

const base = (process.env.ACME_URL ?? 'http://localhost:8083').replace(/\/$/, '') + '/api/v1/';
const [operacion, guia, ...args] = process.argv.slice(2);
if (!operacion || operacion === 'ayuda') {
  console.log(`
ACME_URL               URL del gateway (http://localhost:8083)
ACME_CORREO            Correo, si no se proporciona ACME_TOKEN
ACME_CONTRASENA        Contraseña de la cuenta
ACME_TOKEN             Token Bearer opcional

node distribuido/acme.mjs login
node distribuido/acme.mjs envio GUIA CLIENTE_UUID "Nombre" "Dirección"
node distribuido/acme.mjs almacen GUIA "Almacén"
node distribuido/acme.mjs centro GUIA "Centro"
node distribuido/acme.mjs direccion GUIA
node distribuido/acme.mjs contacto GUIA respondio|sin_respuesta "Notas"
node distribuido/acme.mjs decision GUIA regresar|no_regresar "Notas"
node distribuido/acme.mjs recuperar GUIA
`.trim());
  process.exit(0);
}

async function pedir(ruta, datos, token) {
  const respuesta = await fetch(base + ruta, {
    method: datos ? 'POST' : 'GET',
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' },
    body: datos ? JSON.stringify(datos) : undefined, signal: AbortSignal.timeout(30000),
  });
  const json = await respuesta.json();
  if (!respuesta.ok) throw new Error(respuesta.status + ' ' + JSON.stringify(json.message ?? json));
  return json;
}
function login() {
  const { ACME_CORREO: correo, ACME_CONTRASENA: contrasena } = process.env;
  if (!correo || !contrasena) throw new Error('Configura ACME_CORREO y ACME_CONTRASENA');
  return pedir('auth/login', { correo, contrasena });
}

async function ejecutar() {
  if (operacion === 'login') return login();
  if (!/^[A-Z0-9-]{6,40}$/.test(guia ?? '')) throw new Error('Indica un número de guía válido');
  const ruta = 'movimientos/' + guia;
  const token = process.env.ACME_TOKEN ?? (await login()).token;
  switch (operacion) {
    case 'envio': {
      const [clienteId, destinatario, direccion] = args;
      return pedir('movimientos/envios', { numeroGuia: guia, clienteId, destinatario, direccion }, token);
    }
    case 'almacen':
    case 'centro': return pedir('movimientos/escanear', {
      id: randomUUID(), numeroGuia: guia, tipo: operacion === 'almacen' ? 'ingreso_almacen' : 'ingreso_centro_distribucion',
      ubicacion: args[0],
    }, token);
    case 'direccion': return pedir(ruta + '/direccion', undefined, token);
    case 'contacto':
      if (!['respondio', 'sin_respuesta'].includes(args[0])) throw new Error('Indica respondio o sin_respuesta');
      return pedir(ruta + '/caso', { clienteRespondio: args[0] === 'respondio', notasContacto: args[1] }, token);
    case 'decision':
      return pedir(ruta + '/caso', { clienteRespondio: false, decisionProveedor: args[0], notasContacto: args[1] }, token);
    case 'recuperar': return pedir(ruta + '/recuperar', { id: randomUUID() }, token);
    default: throw new Error('Operación desconocida. Ejecuta el comando ayuda.');
  }
}

ejecutar().then(r => console.log(JSON.stringify(r, null, 2))).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
