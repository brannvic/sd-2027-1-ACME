import 'reflect-metadata';
import { Injectable, OnModuleDestroy, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { connect, ConfirmChannel, Channel, ConsumeMessage } from 'amqplib';
import { createClient } from 'redis';
import { MongoClient } from 'mongodb';
import { DataSource, EntityManager } from 'typeorm';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { setTimeout as dormir } from 'node:timers/promises';

export const claveInterna = process.env.CLAVE_INTERNA!;
export const puerto = Number(process.env.INTERNAL_PORT ?? 8080);
export const shardDe = (guia: string) => createHash('sha256').update(guia).digest()[0] % 4;
export const pausa = dormir;
const directorio = new Resolver({ timeout: 450, tries: 1 });
export const direccionesDe = (servicio: string) => directorio.resolve4(servicio);

export function comprobarInterna(valor?: string) {
  const recibido = Buffer.from(valor ?? '');
  const esperado = Buffer.from(claveInterna);
  if (recibido.length !== esperado.length || !timingSafeEqual(recibido, esperado)) {
    throw new UnauthorizedException('Operación interna');
  }
}

export const interna = (servicio: string, ruta: string, opciones: RequestInit = {}, ms = 2000) =>
  fetch('http://' + servicio + ':' + puerto + ruta, {
    ...opciones, headers: { 'x-acme-interna': claveInterna, 'content-type': 'application/json', ...opciones.headers },
    signal: AbortSignal.timeout(ms),
  });

export async function ciclo(nombre: string, operar: () => Promise<void>, intervalo = 1000) {
  for (;;) {
    try { await operar(); }
    catch (error) { console.error(nombre, (error as Error).message); }
    await pausa(intervalo);
  }
}

@Injectable()
export class Bases implements OnModuleDestroy {
  private readonly conexiones = new Map<string, Promise<DataSource>>();

  shard(indice: number) {
    return this.conectar('shard' + indice, 'acme', 'acme', esquemaMovimientos);
  }

  async usuarios() {
    const candidatos = await Promise.all([1, 2, 3].map(async i => {
      const nombre = 'usuarios-pg' + i;
      try {
        const [host] = await direccionesDe(nombre);
        const respuesta = await fetch('http://' + host + ':8008/primary', { signal: AbortSignal.timeout(800) });
        await respuesta.text();
        return respuesta.ok ? host : null;
      } catch { return null; }
    }));
    const activos = candidatos.filter((host): host is string => host !== null);
    if (activos.length !== 1) throw new ServiceUnavailableException('Usuarios sin líder confirmado');
    return this.conectar(activos[0], 'postgres', 'postgres', esquemaUsuarios);
  }

  async verificarMayoria(tx: EntityManager) {
    const [r] = await tx.query(`SELECT NOT pg_is_in_recovery() AS lider,
      EXISTS (SELECT FROM pg_stat_replication WHERE sync_state IN ('sync', 'quorum')
        AND state = 'streaming') AS replica`);
    if (!r.lider || !r.replica) throw new ServiceUnavailableException('Usuarios sin mayoría');
    // Evita que un cliente HTTP espere indefinidamente durante una elección o un corte.
    await tx.query("SET LOCAL synchronous_commit = 'remote_apply'");
    await tx.query("SET LOCAL statement_timeout = '5500ms'");
  }

  private conectar(host: string, username: string, database: string, esquema: string) {
    const actual = this.conexiones.get(host);
    if (actual) return actual;
    const base = new DataSource({
      type: 'postgres', host, username, database, password: process.env.DB_PASSWORD,
      connectTimeoutMS: 1000, extra: { max: 12, statement_timeout: 6000, lock_timeout: 3500 },
    });
    const inicializar = async () => {
      await base.initialize();
      await base.transaction(async tx => {
        await tx.query("SELECT pg_advisory_xact_lock(60704301)");
        const [marca] = await tx.query("SELECT to_regclass('acme_esquema_v1') existe");
        if (!marca.existe) {
          await tx.query(esquema);
          await tx.query('CREATE TABLE acme_esquema_v1 (version int PRIMARY KEY)');
        }
      });
      return base;
    };
    const pendiente = inicializar().catch(async error => {
      this.conexiones.delete(host);
      if (base.isInitialized) await base.destroy();
      console.error(host, (error as Error).message);
      throw new ServiceUnavailableException('La base de datos no está disponible');
    });
    this.conexiones.set(host, pendiente);
    return pendiente;
  }

  async onModuleDestroy() {
    await Promise.allSettled([...this.conexiones.values()].map(async conexion => (await conexion).destroy()));
  }
}

const outbox = `CREATE TABLE outbox (
  secuencia bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, evento jsonb NOT NULL,
  publicado boolean NOT NULL DEFAULT false
); CREATE INDEX outbox_pendiente ON outbox (secuencia) WHERE NOT publicado;`;
const esquemaUsuarios = `CREATE TABLE usuarios (
  id uuid PRIMARY KEY, correo text UNIQUE NOT NULL, nombre text NOT NULL, "contrasenaHash" text NOT NULL,
  rol text NOT NULL CHECK (rol IN ('cliente','repartidor','almacenista','administrador','proveedor'))
);
CREATE TABLE sesiones (
  id uuid PRIMARY KEY, "usuarioId" uuid NOT NULL REFERENCES usuarios(id),
  "venceEn" timestamptz NOT NULL, "revocadaEn" timestamptz
);
CREATE INDEX sesiones_usuario ON sesiones ("usuarioId");
` + outbox;
const esquemaMovimientos = `CREATE TABLE paquetes (
  guia text PRIMARY KEY, version int NOT NULL, datos jsonb NOT NULL
);
CREATE TABLE historial_movimientos (
  id uuid PRIMARY KEY, guia text NOT NULL REFERENCES paquetes(guia), datos jsonb NOT NULL
);
CREATE INDEX movimientos_guia ON historial_movimientos (guia);
CREATE TABLE confirmaciones (
  id uuid PRIMARY KEY REFERENCES historial_movimientos(id), guia text NOT NULL, actor jsonb NOT NULL,
  operador jsonb NOT NULL, orden int NOT NULL
);
CREATE INDEX confirmaciones_por_guia ON confirmaciones (guia, orden);
CREATE TABLE comandos (
  id text PRIMARY KEY, guia text NOT NULL REFERENCES paquetes(guia)
);
` + outbox;

export const cache = createClient({
  url: process.env.REDIS_URL, disableOfflineQueue: true, socket: { connectTimeout: 800 },
});
cache.on('error', error => console.warn('Redis:', error.message));
export function iniciarCache() { if (!cache.isOpen) void cache.connect().catch(console.error); }

export function mongo() {
  return new MongoClient(process.env.MONGO_URL!, { serverSelectionTimeoutMS: 1000 }).db();
}

export const exchange = 'acme.eventos';
const dlx = 'acme.errores';
const colas = {
  consulta: 'paquete.actualizado',
  reintentos: 'paquete.actualizado',
  revocaciones: 'sesion.terminada',
};
export type Cola = keyof typeof colas;

async function topologia(canal: Channel) {
  await canal.assertExchange(exchange, 'topic', { durable: true });
  await canal.assertExchange(dlx, 'direct', { durable: true });
  for (const [cola, patron] of Object.entries(colas)) {
    await canal.assertQueue(cola + '.fallidos', { durable: true });
    await canal.bindQueue(cola + '.fallidos', dlx, cola);
    await canal.assertQueue(cola, { durable: true, deadLetterExchange: dlx, deadLetterRoutingKey: cola,
      arguments: { 'x-single-active-consumer': true } });
    await canal.bindQueue(cola, exchange, patron);
  }
}

export class MensajeInvalido extends Error {}

export async function escucharRevocaciones(procesar: (evento: unknown) => void, alConectar?: () => Promise<void>) {
  await ciclo('revocaciones locales', async () => {
    const conexion = await connect(process.env.RABBIT_URL!, { timeout: 2000 });
    conexion.on('error', () => undefined);
    try {
      const canal = await conexion.createChannel();
      canal.on('error', () => undefined);
      const cerrado = new Promise<void>(resolve => canal.once('close', resolve));
      await topologia(canal);
      const { queue } = await canal.assertQueue('', { exclusive: true, autoDelete: true, durable: false });
      await canal.bindQueue(queue, exchange, 'sesion.terminada');
      await canal.consume(queue, mensaje => {
        if (!mensaje) return;
        try { procesar(JSON.parse(mensaje.content.toString())); }
        catch (error) { console.error('Revocación local:', (error as Error).message); }
      }, { noAck: true });
      // Primero se suscribe: los eventos concurrentes con el snapshot también
      // llegan a la lista local. Al reconectar recupera los emitidos durante el corte.
      await alConectar?.();
      await cerrado;
    } finally { await conexion.close().catch(() => undefined); }
  });
}

export async function consumir(cola: Cola, procesar: (evento: unknown) => Promise<void>,
  recibirCanal?: (canal: Channel | null) => void, enCurso?: (procesando: boolean) => void) {
  await ciclo(cola, async () => {
    const conexion = await connect(process.env.RABBIT_URL!, { timeout: 2000 });
    conexion.on('error', () => undefined);
    try {
      const canal = await conexion.createChannel();
      canal.on('error', () => undefined);
      const cerrado = new Promise<void>(resolve => {
        canal.once('close', resolve);
        conexion.once('close', resolve);
      });
      await topologia(canal);
      await canal.prefetch(1);
      let vivo = true;
      void cerrado.then(() => { vivo = false; });
      const atender = async (mensaje: ConsumeMessage) => {
        let evento: unknown;
        try { evento = JSON.parse(mensaje.content.toString()); }
        catch { if (vivo) canal.nack(mensaje, false, false); return; }
        while (vivo) {
          try {
            await procesar(evento);
            if (vivo) canal.ack(mensaje);
            return;
          } catch (error) {
            if (!vivo) return;
            if (error instanceof MensajeInvalido) { canal.nack(mensaje, false, false); return; }
            console.error(cola, (error as Error).message);
            await pausa(750);
          }
        }
      };
      await canal.consume(cola, mensaje => {
        if (mensaje) {
          enCurso?.(true);
          void atender(mensaje).catch(() => canal.close().catch(() => undefined)).finally(() => enCurso?.(false));
        }
        else void canal.close().catch(() => undefined);
      });
      recibirCanal?.(canal);
      await cerrado;
    } finally {
      recibirCanal?.(null);
      await conexion.close().catch(() => undefined);
    }
  });
}

export interface Evento { id: string; clave: string }

export async function guardarEvento(tx: EntityManager, evento: Evento) {
  await tx.query('INSERT INTO outbox(evento) VALUES ($1)', [JSON.stringify(evento)]);
}

export async function publicarOutbox(nombre: string, obtenerBase: () => Promise<DataSource>) {
  await ciclo(nombre, async () => {
    const conexion = await connect(process.env.RABBIT_URL!, { timeout: 2000 });
    conexion.on('error', () => undefined);
    try {
      const canal = await conexion.createConfirmChannel();
      canal.on('error', () => undefined);
      let vivo = true;
      canal.once('close', () => { vivo = false; });
      await topologia(canal);
      while (vivo) {
        const base = await obtenerBase();
        const publicados = await base.transaction(async tx => {
          await tx.query('SELECT pg_advisory_xact_lock(7308851)');
          const pendientes: { secuencia: string; evento: Evento }[] = await tx.query(
            'SELECT secuencia, evento FROM outbox WHERE NOT publicado ORDER BY secuencia LIMIT 50',
          );
          if (!pendientes.length) return 0;
          await publicar(canal, pendientes.map(p => p.evento));
          await tx.query('UPDATE outbox SET publicado=true WHERE secuencia=ANY($1::bigint[])',
            [pendientes.map(p => p.secuencia)]);
          return pendientes.length;
        });
        if (!publicados) await pausa(300);
      }
    } finally { await conexion.close().catch(() => undefined); }
  });
}

async function publicar(canal: ConfirmChannel, eventos: Evento[]) {
  for (const evento of eventos) {
    canal.publish(exchange, evento.clave, Buffer.from(JSON.stringify(evento)), {
      persistent: true, messageId: evento.id, contentType: 'application/json',
    });
  }
  let alarma: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      canal.waitForConfirms(),
      new Promise<never>((_, reject) => {
        alarma = setTimeout(() => reject(new Error('RabbitMQ no confirmó el lote')), 3000);
      }),
    ]);
  } finally { clearTimeout(alarma); }
}

export async function redisLimite<T>(operar: () => Promise<T>): Promise<T> {
  let alarma: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operar(), new Promise<never>((_, reject) => {
        alarma = setTimeout(() => reject(new Error('Redis no respondió a tiempo')), 350);
      }),
    ]);
  } finally { clearTimeout(alarma); }
}

