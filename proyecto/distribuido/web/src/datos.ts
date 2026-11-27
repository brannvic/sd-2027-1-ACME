export interface Sesion {
  token: string;
  venceEn: string;
  usuario: { id: string; rol: string; nombre: string };
}
export interface Escaneo {
  id: string;
  numeroGuia: string;
  tipo: string;
  motivo?: string;
  receptor?: string;
  revisionDireccion?: number;
  ancla?: string;
  transcurridoMs?: number;
  relojLocalMs: number;
  relojIncierto?: boolean;
}
export interface Pendiente { orden: number; usuario: string; escaneo: Escaneo; problema?: string }
export interface Direccion { numeroGuia: string; direccion: string; revisionDireccion: number; estado: string;
  plan?: { fecha: string; franja: string } }
export interface Historial { id?: string; tipo: string; registradoEn: string; confirmacion?: string; sospechoso?: boolean;
  motivo?: string; receptor?: string; ubicacion?: string; direccionNueva?: string }
export interface Vista {
  numeroGuia: string; estado: string; historial: Historial[]; direccion?: string; destinatario?: string;
  primeraSalidaEn?: string; aviso?: string; plan?: { fecha: string; franja: string };
}

export class ErrorApi extends Error {
  constructor(readonly status: number, mensaje: string) { super(mensaje); }
}

export async function api<T>(ruta: string, token?: string, datos?: object): Promise<T> {
  const r = await fetch('/api/v1/' + ruta, {
    method: datos ? 'POST' : 'GET', cache: 'no-store',
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(datos ? { 'content-type': 'application/json' } : {}) },
    body: datos ? JSON.stringify(datos) : undefined, signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const detalle = await r.json().catch(() => ({}));
    throw new ErrorApi(r.status, detalle.message ?? 'El servidor respondió con un error');
  }
  return r.json() as Promise<T>;
}

const abrir = new Promise<IDBDatabase>((resolve, reject) => {
  const peticion = indexedDB.open('acme-reparto', 1);
  peticion.onupgradeneeded = () => {
    peticion.result.createObjectStore('cola', { keyPath: 'orden', autoIncrement: true });
    peticion.result.createObjectStore('direcciones');
  };
  peticion.onsuccess = () => resolve(peticion.result);
  peticion.onerror = () => reject(peticion.error);
});

async function operar<T>(almacen: string, modo: IDBTransactionMode, ejecutar: (tabla: IDBObjectStore) => IDBRequest<T>) {
  const db = await abrir;
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(almacen, modo);
    const solicitud = ejecutar(tx.objectStore(almacen));
    tx.oncomplete = () => resolve(solicitud.result);
    tx.onabort = () => reject(tx.error ?? new Error('El almacenamiento local no está disponible'));
  });
}
export const agregar = (usuario: string, escaneo: Escaneo) =>
  operar('cola', 'readwrite', tabla => tabla.add({ usuario, escaneo }));
export const pendientes = async (usuario: string): Promise<Pendiente[]> =>
  (await operar('cola', 'readonly', tabla => tabla.getAll())).filter(x => x.usuario === usuario);
export const quitar = (orden: number) => operar('cola', 'readwrite', tabla => tabla.delete(orden));
export const marcar = (item: Pendiente, problema: string) =>
  operar('cola', 'readwrite', tabla => tabla.put({ ...item, problema }));
export const direccionLocal = (usuario: string, guia: string): Promise<Direccion | undefined> =>
  operar('direcciones', 'readonly', tabla => tabla.get(usuario + ':' + guia));
export const guardarDireccion = (usuario: string, dir: Direccion) =>
  operar('direcciones', 'readwrite', tabla => tabla.put(dir, usuario + ':' + dir.numeroGuia));

export async function hashPin(pin: string, sal: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sal + pin));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const mensaje = (error: unknown) => error instanceof Error ? error.message : String(error);

