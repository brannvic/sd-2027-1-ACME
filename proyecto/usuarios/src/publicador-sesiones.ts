import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ChannelModel, ConfirmChannel, connect } from 'amqplib';
import { Replicas } from './quorum';
import { FilaSesion } from './usuarios.service';

export const EXCHANGE_EVENTOS = 'acme.eventos';
export const CLAVE_SESION_TERMINADA = 'sesion.terminada';

/**
 * Publicador del outbox de sesiones.
 * Cada pocos segundos busca sesiones revocadas con evento_publicado = false, publica sesion_terminada
 * con confirmación del broker y solo entonces marca el evento como publicado.
 * Si RabbitMQ está caído no se pierde nada: las sesiones siguen pendientes y se publican al volver.
 * Entrega "al menos una vez": los consumidores deben ser idempotentes (messageId = id de la sesión).
 */
@Injectable()
export class PublicadorSesiones implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PublicadorSesiones');
  private conexion: ChannelModel | null = null;
  private canal: ConfirmChannel | null = null;
  private temporizador: NodeJS.Timeout | null = null;
  private enCurso: Promise<void> | null = null;
  conectado = false;

  constructor(private readonly replicas: Replicas, private readonly url: string, private readonly intervaloMs: number) {}

  onModuleInit() {
    this.despertar();
    this.temporizador = setInterval(() => void this.publicarPendientes(), this.intervaloMs);
  }

  async onModuleDestroy() {
    if (this.temporizador) clearInterval(this.temporizador);
    await this.enCurso;
    await this.conexion?.close().catch(() => undefined);
  }

  /** Publica ya, sin esperar al siguiente ciclo (se llama después de un logout). */
  despertar() { void this.publicarPendientes(); }

  publicarPendientes(): Promise<void> {
    this.enCurso ??= this.ciclo().finally(() => { this.enCurso = null; });
    return this.enCurso;
  }

  private async ciclo() {
    try {
      const canal = await this.obtenerCanal();
      let pendientes: FilaSesion[];
      try {
        pendientes = await this.replicas.leerVarios<FilaSesion>('sesiones', 'revocada_en IS NOT NULL AND NOT evento_publicado', []);
      } catch { return; } // sin quórum: se reintenta en el siguiente ciclo
      for (const sesion of pendientes) {
        const evento = {
          tipo: 'sesion_terminada', sesionId: sesion.id, usuarioId: sesion.usuario_id,
          venceEn: new Date(sesion.vence_en).toISOString(), revocadaEn: new Date(sesion.revocada_en!).toISOString(),
        };
        canal.publish(EXCHANGE_EVENTOS, CLAVE_SESION_TERMINADA, Buffer.from(JSON.stringify(evento)), {
          persistent: true, messageId: sesion.id, contentType: 'application/json', type: evento.tipo,
        });
        await canal.waitForConfirms();
        await this.replicas.escribir('sesiones', { ...sesion, evento_publicado: true, version: Replicas.siguienteVersion(sesion) });
      }
    } catch (error) {
      if (this.conectado) this.log.warn(`No se pudo publicar sesion_terminada; se reintentará: ${(error as Error).message}`);
      await this.reiniciarConexion();
    }
  }

  private async obtenerCanal(): Promise<ConfirmChannel> {
    if (this.canal) return this.canal;
    const conexion = await connect(this.url, { timeout: 3000 });
    conexion.on('error', () => undefined);
    conexion.on('close', () => { this.conexion = null; this.canal = null; this.conectado = false; });
    const canal = await conexion.createConfirmChannel();
    await canal.assertExchange(EXCHANGE_EVENTOS, 'topic', { durable: true });
    this.conexion = conexion;
    this.canal = canal;
    this.conectado = true;
    return canal;
  }

  private async reiniciarConexion() {
    const conexion = this.conexion;
    this.conexion = null; this.canal = null; this.conectado = false;
    await conexion?.close().catch(() => undefined);
  }
}
