import { KeyObject, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

// JWT firmado con Ed25519 (alg EdDSA). Usuarios firma con la llave privada;
// los demás servicios solo tienen la pública: pueden verificar, pero no fabricar tokens.
// El mismo verificador vive en el monolito (src/autenticacion/tokens.ts).

export type Rol = 'cliente' | 'repartidor' | 'almacenista' | 'administrador';
export interface DatosToken { sub: string; sid: string; rol: Rol; iat: number; exp: number }

const base64url = (datos: string | Buffer) => Buffer.from(datos).toString('base64url');

export function cargarLlavePrivada(): KeyObject {
  const pem = process.env.JWT_PRIVATE_KEY ?? (process.env.JWT_PRIVATE_KEY_FILE && readFileSync(process.env.JWT_PRIVATE_KEY_FILE, 'utf8'));
  if (!pem) throw new Error('Define JWT_PRIVATE_KEY_FILE (o JWT_PRIVATE_KEY) con la llave privada Ed25519');
  const llave = createPrivateKey(pem);
  if (llave.asymmetricKeyType !== 'ed25519') throw new Error('La llave de tokens debe ser Ed25519');
  return llave;
}

export function firmarToken(datos: DatosToken, llavePrivada: KeyObject): string {
  const contenido = `${base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))}.${base64url(JSON.stringify(datos))}`;
  return `${contenido}.${base64url(sign(null, Buffer.from(contenido), llavePrivada))}`;
}

/** Verifica firma y vencimiento sin consultar a nadie. Lanza Error si el token no sirve. */
export function verificarToken(token: string, llavePublica: KeyObject, ahora = Date.now()): DatosToken {
  const [encabezado, cuerpo, firma, ...resto] = token.split('.');
  if (!encabezado || !cuerpo || !firma || resto.length) throw new Error('Formato de token inválido');
  if (JSON.parse(Buffer.from(encabezado, 'base64url').toString()).alg !== 'EdDSA') throw new Error('Algoritmo no permitido');
  if (!verify(null, Buffer.from(`${encabezado}.${cuerpo}`), llavePublica, Buffer.from(firma, 'base64url'))) {
    throw new Error('Firma inválida');
  }
  const datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString()) as DatosToken;
  if (typeof datos.sub !== 'string' || typeof datos.sid !== 'string' || typeof datos.rol !== 'string' || typeof datos.exp !== 'number') {
    throw new Error('Contenido de token inválido');
  }
  if (datos.exp * 1000 <= ahora) throw new Error('Token vencido');
  return datos;
}

export const llavePublicaDe = (llavePrivada: KeyObject) => createPublicKey(llavePrivada);
