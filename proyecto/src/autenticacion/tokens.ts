import { KeyObject, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Verificación local de tokens EdDSA (Ed25519). El monolito solo tiene la llave pública:
// puede comprobar que el token lo firmó Usuarios, pero no puede fabricar uno.
// Es el mismo formato que firma usuarios/src/tokens.ts.

export interface DatosToken { sub: string; sid: string; rol: string; iat: number; exp: number }

export function cargarLlavePublica(): KeyObject {
  const pem = process.env.JWT_PUBLIC_KEY ?? (process.env.JWT_PUBLIC_KEY_FILE && readFileSync(process.env.JWT_PUBLIC_KEY_FILE, 'utf8'));
  if (!pem) throw new Error('Define JWT_PUBLIC_KEY_FILE (o JWT_PUBLIC_KEY) con la llave pública Ed25519 de Usuarios');
  const llave = createPublicKey(pem);
  if (llave.asymmetricKeyType !== 'ed25519') throw new Error('La llave de tokens debe ser Ed25519');
  return llave;
}

/** Comprueba firma y vencimiento sin preguntarle a nadie. Lanza Error si el token no sirve. */
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
