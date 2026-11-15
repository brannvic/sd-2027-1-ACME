import { Pool, types } from 'pg';

// bigint (versiones) como número: Date.now() cabe sin perder precisión.
types.setTypeParser(20, Number);

/**
 * Quórum sobre N PostgreSQL independientes (una por "región").
 *
 * - Escritura: se manda a todas y se confirma con al menos W = mayoría acuses.
 * - Lectura: se pregunta a todas, se necesitan al menos R = mayoría respuestas y gana la versión más alta.
 *
 * Como R + W > N, toda lectura coincide con al menos una réplica que tiene la última escritura confirmada:
 * después de un cambio de contraseña, nadie puede entrar con la anterior.
 * Si no hay mayoría, se lanza SinQuorumError (503): preferimos negar el servicio a abrir una brecha.
 */
export class SinQuorumError extends Error {
  constructor(operacion: string, respondieron: number, necesarias: number) {
    super(`Sin quórum para ${operacion}: respondieron ${respondieron} de ${necesarias} réplicas necesarias`);
  }
}

export type Tabla = 'usuarios' | 'sesiones';
export interface Registro { id: string; version: number; [columna: string]: unknown }

const COLUMNAS: Record<Tabla, string[]> = {
  usuarios: ['id', 'correo', 'nombre', 'contrasena_hash', 'rol', 'version'],
  sesiones: ['id', 'usuario_id', 'vence_en', 'revocada_en', 'evento_publicado', 'version'],
};

const ESQUEMA = `
  CREATE TABLE IF NOT EXISTS usuarios (
    id uuid PRIMARY KEY, correo varchar NOT NULL UNIQUE, nombre varchar NOT NULL,
    contrasena_hash varchar NOT NULL,
    rol varchar NOT NULL CHECK (rol IN ('cliente','repartidor','almacenista','administrador')),
    version bigint NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sesiones (
    id uuid PRIMARY KEY, usuario_id uuid NOT NULL, vence_en timestamptz NOT NULL, revocada_en timestamptz,
    evento_publicado boolean NOT NULL DEFAULT false, version bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sesiones_por_usuario ON sesiones (usuario_id);
  CREATE INDEX IF NOT EXISTS sesiones_por_publicar ON sesiones (id) WHERE revocada_en IS NOT NULL AND NOT evento_publicado;
`;

interface Replica { nombre: string; pool: Pool; esquema: Promise<void> | null }
type Resultado<T> = { replica: Replica; ok: true; valor: T } | { replica: Replica; ok: false; error: unknown };

export class Replicas {
  private readonly replicas: Replica[];
  readonly mayoria: number;

  constructor(urls: string[], timeoutMs = 2000) {
    if (urls.length === 0) throw new Error('USUARIOS_DB_URLS debe tener al menos una réplica');
    this.replicas = urls.map((url, indice) => {
      const pool = new Pool({
        connectionString: url, max: 5, connectionTimeoutMillis: timeoutMs,
        statement_timeout: timeoutMs, query_timeout: timeoutMs,
      });
      pool.on('error', () => { /* una réplica caída no debe tumbar el proceso */ });
      return { nombre: `replica-${indice + 1}`, pool, esquema: null };
    });
    this.mayoria = Math.floor(urls.length / 2) + 1;
  }

  /** Nueva versión: siempre mayor que la leída, y basada en el reloj del servidor para que no se repita. */
  static siguienteVersion(actual?: { version: number } | null): number {
    return Math.max((actual?.version ?? 0) + 1, Date.now());
  }

  /** Lee un registro con quórum de lectura y repara en segundo plano las réplicas atrasadas. */
  async leerUno<T extends Registro>(tabla: Tabla, condicion: string, parametros: unknown[]): Promise<T | null> {
    const resultados = await this.enCadaReplica(async replica =>
      (await replica.pool.query<T>(`SELECT * FROM ${tabla} WHERE ${condicion} LIMIT 1`, parametros)).rows[0] ?? null);
    const respuestas = this.exigirMayoria(`leer ${tabla}`, resultados);
    const masReciente = respuestas.reduce<T | null>((mejor, fila) => !fila ? mejor : !mejor || fila.version > mejor.version ? fila : mejor, null);
    if (masReciente) {
      const atrasadas = resultados.filter(r => r.ok && (!r.valor || r.valor.id !== masReciente.id || r.valor.version < masReciente.version));
      for (const r of atrasadas) void this.escribirEn(r.replica, tabla, masReciente).catch(() => undefined);
    }
    return masReciente;
  }

  /** Lee varios registros con quórum: une las filas de todas las réplicas y por cada id gana la versión más alta. */
  async leerVarios<T extends Registro>(tabla: Tabla, condicion: string, parametros: unknown[]): Promise<T[]> {
    const resultados = await this.enCadaReplica(async replica =>
      (await replica.pool.query<T>(`SELECT * FROM ${tabla} WHERE ${condicion}`, parametros)).rows);
    const porId = new Map<string, T>();
    for (const filas of this.exigirMayoria(`leer ${tabla}`, resultados)) {
      for (const fila of filas) if ((porId.get(fila.id)?.version ?? -1) < fila.version) porId.set(fila.id, fila);
    }
    return [...porId.values()];
  }

  /** Escribe en todas las réplicas y confirma solo si acusan recibo al menos W = mayoría. */
  async escribir(tabla: Tabla, registro: Registro): Promise<void> {
    const resultados = await this.enCadaReplica(replica => this.escribirEn(replica, tabla, registro));
    this.exigirMayoria(`escribir ${tabla}`, resultados);
  }

  async estado() {
    const resultados = await this.enCadaReplica(replica => replica.pool.query('SELECT 1'));
    const replicas = Object.fromEntries(resultados.map(r => [r.replica.nombre, r.ok ? 'UP' : 'DOWN']));
    const vivas = resultados.filter(r => r.ok).length;
    return { replicas, vivas, necesarias: this.mayoria, quorum: vivas >= this.mayoria };
  }

  async cerrar() {
    await Promise.all(this.replicas.map(r => r.pool.end().catch(() => undefined)));
  }

  /** Solo para pruebas: deja vacías las tablas de todas las réplicas alcanzables. */
  async vaciarParaPruebas() {
    await this.enCadaReplica(r => r.pool.query('TRUNCATE usuarios, sesiones'));
  }

  // Upsert condicionado por versión: una réplica nunca retrocede a un valor más viejo.
  private async escribirEn(replica: Replica, tabla: Tabla, registro: Registro) {
    await this.asegurarEsquema(replica);
    const columnas = COLUMNAS[tabla];
    const valores = columnas.map(columna => registro[columna] ?? null);
    const marcadores = columnas.map((_, i) => `$${i + 1}`).join(', ');
    const asignaciones = columnas.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ');
    await replica.pool.query(
      `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${marcadores})
       ON CONFLICT (id) DO UPDATE SET ${asignaciones} WHERE ${tabla}.version < EXCLUDED.version`, valores);
  }

  private async enCadaReplica<T>(operacion: (replica: Replica) => Promise<T>): Promise<Resultado<T>[]> {
    return Promise.all(this.replicas.map(async (replica): Promise<Resultado<T>> => {
      try {
        await this.asegurarEsquema(replica);
        return { replica, ok: true, valor: await operacion(replica) };
      } catch (error) {
        return { replica, ok: false, error };
      }
    }));
  }

  private exigirMayoria<T>(operacion: string, resultados: Resultado<T>[]): T[] {
    const exitosos = resultados.filter((r): r is Extract<Resultado<T>, { ok: true }> => r.ok);
    if (exitosos.length < this.mayoria) throw new SinQuorumError(operacion, exitosos.length, this.mayoria);
    return exitosos.map(r => r.valor);
  }

  // El esquema se crea en cada réplica la primera vez que responde, aunque haya estado caída al arrancar.
  private asegurarEsquema(replica: Replica): Promise<void> {
    replica.esquema ??= replica.pool.query(ESQUEMA).then(() => undefined, error => { replica.esquema = null; throw error; });
    return replica.esquema;
  }
}
