import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Channel, ChannelModel, ConsumeMessage, connect } from 'amqplib';
import { DataSource } from 'typeorm';

export const EXCHANGE_EVENTOS = 'acme.eventos';
const COLA = 'monolito.sesion_terminada';
const CLAVE = 'sesion.terminada';

export interface EventoSesionTerminada { tipo: 'sesion_terminada'; sesionId: string; usuarioId: string; venceEn: string }

/**
 * Consume sesion_terminada desde RabbitMQ y mantiene la lista local de sesiones revocadas.
 * - Idempotente: el mismo evento dos veces no hace nada nuevo (ON CONFLICT DO NOTHING).
 * - El ack se manda después de guardar: si el proceso cae a la mitad, RabbitMQ reentrega el mensaje.
 * - Si RabbitMQ no está, reintenta conectarse cada 3 s; los eventos esperan en la cola durable.
 */
@Injectable()
export class ConsumidorSesiones implements OnModuleDestroy {
  private readonly log = new Logger('ConsumidorSesiones');
  private readonly url = process.env.RABBITMQ_URL ?? 'amqp://acme:acme_desarrollo@localhost:5672';
  private conexion: ChannelModel | null = null;
  private canal: Channel | null = null;
  private reconexion: NodeJS.Timeout | null = null;
  private detenido = false;
  conectado = false;

  constructor(private readonly baseDatos: DataSource) {}

  iniciar() { void this.conectar(); }

  /**
   * Antes de abrir la API se procesa lo que quedó en la cola mientras el servicio estuvo caído,
   * para no aceptar tokens que ya se revocaron. Si RabbitMQ no responde, se abre igual (disponibilidad).
   */
  async ponerseAlDia(maxMs = 5000): Promise<boolean> {
    const limite = Date.now() + maxMs;
    while (Date.now() < limite) {
      if (this.canal) {
        const { messageCount } = await this.canal.checkQueue(COLA).catch(() => ({ messageCount: -1 }));
        if (messageCount === 0) return true;
      }
      await new Promise(resolver => setTimeout(resolver, 200));
    }
    this.log.warn('Se abre la API sin confirmar que la cola de sesiones esté al día');
    return false;
  }

  async procesar(evento: EventoSesionTerminada) {
    await this.baseDatos.query(
      `INSERT INTO sesiones_revocadas ("sesionId", "usuarioId", "venceEn", "recibidaEn") VALUES ($1, $2, $3, now())
       ON CONFLICT ("sesionId") DO NOTHING`, [evento.sesionId, evento.usuarioId, evento.venceEn]);
  }

  async onModuleDestroy() {
    this.detenido = true;
    if (this.reconexion) clearTimeout(this.reconexion);
    await this.conexion?.close().catch(() => undefined);
  }

  private async conectar() {
    if (this.detenido) return;
    try {
      const conexion = await connect(this.url, { timeout: 3000 });
      conexion.on('error', () => undefined);
      conexion.on('close', () => {
        if (this.conectado) this.log.warn('Se perdió la conexión con RabbitMQ; reintentando');
        this.conexion = null; this.canal = null; this.conectado = false;
        this.programarReconexion();
      });
      const canal = await conexion.createChannel();
      await canal.assertExchange(EXCHANGE_EVENTOS, 'topic', { durable: true });
      await canal.assertQueue(COLA, { durable: true });
      await canal.bindQueue(COLA, EXCHANGE_EVENTOS, CLAVE);
      await canal.prefetch(20);
      this.conexion = conexion; this.canal = canal; this.conectado = true;
      await canal.consume(COLA, mensaje => void this.alRecibir(canal, mensaje));
      this.log.log(`Escuchando ${CLAVE} en la cola ${COLA}`);
    } catch {
      this.programarReconexion();
    }
  }

  private programarReconexion() {
    if (this.detenido || this.reconexion) return;
    this.reconexion = setTimeout(() => { this.reconexion = null; void this.conectar(); }, 3000);
  }

  private async alRecibir(canal: Channel, mensaje: ConsumeMessage | null) {
    if (!mensaje) return;
    let evento: EventoSesionTerminada;
    try {
      evento = JSON.parse(mensaje.content.toString());
      if (evento.tipo !== 'sesion_terminada' || typeof evento.sesionId !== 'string') throw new Error('forma inválida');
    } catch {
      this.log.error(`Mensaje inválido descartado: ${mensaje.content.toString().slice(0, 200)}`);
      canal.nack(mensaje, false, false);
      return;
    }
    try {
      await this.procesar(evento);
      canal.ack(mensaje);
    } catch {
      // La base no respondió: se devuelve a la cola tras una pausa para no girar en falso.
      setTimeout(() => { try { canal.nack(mensaje, false, true); } catch { /* canal cerrado: RabbitMQ lo reentrega */ } }, 1000);
    }
  }
}
