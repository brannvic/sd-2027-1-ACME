import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UsuariosCliente } from '../autenticacion/usuarios.cliente';
import { ReintentosService } from '../reintentos/reintentos.service';
import { EstadoPaquete, Movimiento, TipoMovimiento } from './paquete.entity';
import { MovimientosService } from './movimientos.service';

/**
 * Resuelve los movimientos que quedaron "pendientes de confirmación" porque Usuarios no respondió.
 * Cada RECONCILIAR_CADA_MS vuelve a preguntar por la sesión con la que se registraron:
 * - activa   → se confirman ("entregado" pasa a terminal; la corrección cambia la dirección si aún no sale a ruta);
 * - revocada → se rechazan (un "entregado" con sesión revocada no cuenta y el paquete vuelve a en_ruta).
 * Si Usuarios sigue sin responder, no cambia nada y se intenta en el siguiente ciclo.
 */
@Injectable()
export class ConfirmacionesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Confirmaciones');
  private temporizador: NodeJS.Timeout | null = null;
  private enCurso: Promise<{ confirmados: number; rechazados: number }> | null = null;

  constructor(
    private readonly baseDatos: DataSource, private readonly usuarios: UsuariosCliente,
    private readonly movimientos: MovimientosService, private readonly reintentos: ReintentosService,
  ) {}

  onApplicationBootstrap() {
    const cadaMs = Number(process.env.RECONCILIAR_CADA_MS ?? 15000);
    if (cadaMs > 0) this.temporizador = setInterval(() => void this.reconciliar().catch(() => undefined), cadaMs);
  }

  onModuleDestroy() { if (this.temporizador) clearInterval(this.temporizador); }

  reconciliar() {
    this.enCurso ??= this.ciclo().finally(() => { this.enCurso = null; });
    return this.enCurso;
  }

  private async ciclo() {
    const resultado = { confirmados: 0, rechazados: 0 };
    // Las revocaciones vencidas ya no sirven: el token se rechaza solo por su fecha.
    await this.baseDatos.query(`DELETE FROM sesiones_revocadas WHERE "venceEn" < now() - interval '1 hour'`);
    const pendientes = await this.baseDatos.getRepository(Movimiento).find({
      where: { confirmacion: 'pendiente' }, order: { secuencia: 'ASC' }, take: 100,
    });
    for (const pendiente of pendientes) {
      const verificacion = await this.usuarios.verificarSesion(pendiente.sesionId!);
      if (verificacion === 'no_verificable') break; // Usuarios sigue sin responder
      await this.baseDatos.transaction(async transaccion => {
        const paquete = await this.movimientos.cargarPaqueteParaActualizar(transaccion, pendiente.numeroGuia);
        const movimiento = await transaccion.findOneByOrFail(Movimiento, { id: pendiente.id });
        if (movimiento.confirmacion !== 'pendiente') return;
        const valido = verificacion === 'activa';
        if (movimiento.tipo === TipoMovimiento.ENTREGADO) {
          if (valido) {
            paquete.estado = EstadoPaquete.ENTREGADO;
          } else {
            paquete.estado = EstadoPaquete.EN_RUTA;
            await this.reintentos.deshacerResultadoEntrega(transaccion, paquete, movimiento);
            movimiento.notaConfirmacion = 'La sesión estaba revocada: el "entregado" no cuenta';
          }
        } else if (movimiento.tipo === TipoMovimiento.DIRECCION_CORREGIDA) {
          if (valido && !paquete.primeraSalidaEn) {
            paquete.direccion = movimiento.direccionNueva!;
          } else {
            movimiento.notaConfirmacion = valido
              ? 'El paquete salió a ruta antes de confirmar la corrección'
              : 'La sesión estaba revocada: la corrección no se aplica';
          }
        }
        movimiento.confirmacion = movimiento.notaConfirmacion ? 'rechazada' : 'confirmada';
        await transaccion.save(Movimiento, movimiento);
        await transaccion.save(paquete);
        resultado[movimiento.confirmacion === 'confirmada' ? 'confirmados' : 'rechazados']++;
      });
    }
    if (resultado.confirmados || resultado.rechazados) this.log.log(`Pendientes resueltos: ${JSON.stringify(resultado)}`);
    return resultado;
  }
}
