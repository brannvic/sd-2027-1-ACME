import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { Rol, UsuarioAutenticado } from '../autenticacion/autenticacion';
import { EstadoVerificacion, UsuariosCliente } from '../autenticacion/usuarios.cliente';
import { Reloj } from '../reloj';
import { ReintentosService } from '../reintentos/reintentos.service';
import { CorregirDireccionDto, CrearEnvioDto, RegistrarCasoDto, RegistrarMovimientoDto } from './movimientos.dto';
import { EstadoPaquete, Movimiento, Paquete, TipoMovimiento } from './paquete.entity';

@Injectable()
export class MovimientosService {
  constructor(
    private readonly baseDatos: DataSource, private readonly reintentos: ReintentosService,
    private readonly reloj: Reloj, private readonly usuarios: UsuariosCliente,
  ) {}

  async crearEnvio(datos: CrearEnvioDto, usuario: UsuarioAutenticado) {
    // El titular vive en otro servicio: se le pregunta a Usuarios (si no responde, 503).
    const cliente = await this.usuarios.obtenerUsuario(datos.clienteId);
    if (!cliente || cliente.rol !== Rol.CLIENTE) throw new BadRequestException('El titular debe ser un cliente existente');
    return this.baseDatos.transaction(async transaccion => {
      const paquete = transaccion.create(Paquete, {
        ...datos, estado: EstadoPaquete.CREADO, creadoEn: this.reloj.ahora(), primeraSalidaEn: null,
        contactoEn: null, clienteRespondio: null, notasContacto: null, decisionProveedor: null, casoCerradoEn: null,
      });
      await transaccion.insert(Paquete, paquete);
      await transaccion.insert(Movimiento, this.crearMovimiento(randomUUID(), paquete.numeroGuia, usuario.id, TipoMovimiento.ENVIO_CREADO));
      return paquete;
    });
  }

  async registrarMovimiento(datos: RegistrarMovimientoDto, usuario: UsuarioAutenticado) {
    const esMovimientoAlmacen = [TipoMovimiento.INGRESO_ALMACEN, TipoMovimiento.INGRESO_CENTRO].includes(datos.tipo);
    if (usuario.rol !== (esMovimientoAlmacen ? Rol.ALMACENISTA : Rol.REPARTIDOR)) {
      throw new ForbiddenException('Este movimiento no corresponde a tu rol');
    }
    if (datos.tipo === TipoMovimiento.ENTREGADO && !datos.receptor?.trim()) throw new BadRequestException('Indica quién recibió el paquete');
    if (datos.tipo === TipoMovimiento.INTENTO_FALLIDO && !datos.motivo?.trim()) throw new BadRequestException('Indica el motivo del intento fallido');
    if (esMovimientoAlmacen && !datos.ubicacion?.trim()) throw new BadRequestException('Indica el almacén o centro de distribución');
    // "Entregado" es terminal: además de la verificación local, se pregunta a Usuarios si la sesión sigue viva.
    // Se hace antes de la transacción para no tener el paquete bloqueado mientras se espera la red.
    const verificacion = datos.tipo === TipoMovimiento.ENTREGADO ? await this.verificarSesionSensible(usuario) : 'activa';
    return this.baseDatos.transaction(async transaccion => {
      // Serializa el mismo UUID incluso si dos solicitudes lo usan para guías diferentes.
      await transaccion.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [datos.id]);
      const paquete = await this.cargarPaqueteParaActualizar(transaccion, datos.numeroGuia);
      const movimiento = this.crearMovimiento(datos.id, datos.numeroGuia, usuario.id, datos.tipo);
      movimiento.sesionId = usuario.sesionId;
      movimiento.ubicacion = datos.ubicacion ?? null;
      movimiento.motivo = datos.motivo ?? null;
      movimiento.receptor = datos.receptor ?? null;
      movimiento.confirmacion = verificacion === 'no_verificable' ? 'pendiente' : 'confirmada';
      const existente = await this.buscarMovimientoRepetido(transaccion, movimiento);
      if (existente) return { movimiento: existente, duplicado: true };
      this.validarTransicion(paquete.estado, datos.tipo);
      await transaccion.insert(Movimiento, movimiento);

      switch (datos.tipo) {
        case TipoMovimiento.INGRESO_ALMACEN: paquete.estado = EstadoPaquete.EN_ALMACEN; break;
        case TipoMovimiento.INGRESO_CENTRO: paquete.estado = EstadoPaquete.EN_CENTRO; break;
        case TipoMovimiento.SALIDA_RUTA:
          await this.reintentos.registrarSalidaARuta(transaccion, paquete, movimiento);
          paquete.primeraSalidaEn ??= movimiento.registradoEn;
          paquete.estado = EstadoPaquete.EN_RUTA;
          break;
        case TipoMovimiento.ENTREGADO:
          await this.reintentos.registrarResultadoEntrega(transaccion, paquete, movimiento);
          // Sin verificación no se marca como terminal: queda pendiente hasta que Usuarios responda.
          paquete.estado = movimiento.confirmacion === 'pendiente' ? EstadoPaquete.ENTREGA_POR_CONFIRMAR : EstadoPaquete.ENTREGADO;
          break;
        case TipoMovimiento.INTENTO_FALLIDO: {
          const intento = await this.reintentos.registrarResultadoEntrega(transaccion, paquete, movimiento);
          paquete.estado = EstadoPaquete.INTENTO_FALLIDO;
          const pasoASucursal = await this.reintentos.programarSiguienteIntento(transaccion, paquete, intento, movimiento);
          if (pasoASucursal) {
            await transaccion.insert(Movimiento, this.crearMovimiento(randomUUID(), paquete.numeroGuia, usuario.id, TipoMovimiento.PASO_SUCURSAL));
          }
          break;
        }
      }
      await transaccion.save(Paquete, paquete);
      return { movimiento, duplicado: false };
    });
  }

  async corregirDireccion(numeroGuia: string, datos: CorregirDireccionDto, usuario: UsuarioAutenticado) {
    const verificacion = await this.verificarSesionSensible(usuario);
    return this.baseDatos.transaction(async transaccion => {
      await transaccion.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [datos.id]);
      const paquete = await this.cargarPaqueteParaActualizar(transaccion, numeroGuia);
      if (paquete.clienteId !== usuario.id) throw new ForbiddenException('Solo el titular puede corregir la dirección');
      const movimiento = this.crearMovimiento(datos.id, numeroGuia, usuario.id, TipoMovimiento.DIRECCION_CORREGIDA);
      movimiento.sesionId = usuario.sesionId;
      movimiento.direccionNueva = datos.direccion;
      movimiento.confirmacion = verificacion === 'no_verificable' ? 'pendiente' : 'confirmada';
      const existente = await this.buscarMovimientoRepetido(transaccion, movimiento);
      if (existente) return { movimiento: existente, duplicado: true };
      if (paquete.primeraSalidaEn) throw new ConflictException('El paquete ya salió a ruta; no se puede corregir la dirección');
      // Pendiente: queda registrada, pero la dirección vigente no cambia hasta confirmar la sesión.
      if (movimiento.confirmacion === 'confirmada') paquete.direccion = datos.direccion;
      await transaccion.insert(Movimiento, movimiento);
      await transaccion.save(Paquete, paquete);
      return { movimiento, duplicado: false };
    });
  }

  async registrarContactoYDecision(numeroGuia: string, datos: RegistrarCasoDto) {
    return this.baseDatos.transaction(async transaccion => {
      const paquete = await this.cargarPaqueteParaActualizar(transaccion, numeroGuia);
      if (paquete.estado !== EstadoPaquete.EN_SUCURSAL) throw new ConflictException('El paquete no está en sucursal');
      if (paquete.casoCerradoEn) throw new ConflictException('El caso ya está cerrado');
      if (datos.clienteRespondio && datos.decisionProveedor) throw new BadRequestException('La decisión del proveedor requiere falta de respuesta del cliente');
      paquete.contactoEn = this.reloj.ahora();
      paquete.clienteRespondio = datos.clienteRespondio;
      paquete.notasContacto = datos.notasContacto;
      if (datos.decisionProveedor) {
        paquete.decisionProveedor = datos.decisionProveedor;
        paquete.casoCerradoEn = this.reloj.ahora();
      }
      return transaccion.save(Paquete, paquete);
    });
  }

  /** Revocación síncrona: revocada → 401; Usuarios sin responder → el movimiento queda pendiente. */
  private async verificarSesionSensible(usuario: UsuarioAutenticado): Promise<EstadoVerificacion> {
    const verificacion = await this.usuarios.verificarSesion(usuario.sesionId);
    if (verificacion === 'revocada') throw new UnauthorizedException('Sesión terminada');
    return verificacion;
  }

  async cargarPaqueteParaActualizar(transaccion: EntityManager, numeroGuia: string) {
    const paquete = await transaccion.findOne(Paquete, { where: { numeroGuia }, lock: { mode: 'pessimistic_write' } });
    if (!paquete) throw new NotFoundException('No existe el paquete');
    return paquete;
  }

  private crearMovimiento(id: string, numeroGuia: string, usuarioId: string, tipo: TipoMovimiento): Movimiento {
    return Object.assign(new Movimiento(), {
      id, numeroGuia, usuarioId, tipo, registradoEn: this.reloj.ahora(),
      ubicacion: null, motivo: null, receptor: null, direccionNueva: null,
      sesionId: null, confirmacion: 'confirmada', notaConfirmacion: null,
    });
  }

  private async buscarMovimientoRepetido(transaccion: EntityManager, recibido: Movimiento) {
    const existente = await transaccion.findOneBy(Movimiento, { id: recibido.id });
    if (!existente) return null;
    const campos: (keyof Movimiento)[] = ['numeroGuia', 'usuarioId', 'tipo', 'ubicacion', 'motivo', 'receptor', 'direccionNueva'];
    if (campos.some(campo => existente[campo] !== recibido[campo])) {
      throw new ConflictException('El UUID ya se utilizó con otros datos');
    }
    return existente;
  }

  private validarTransicion(estado: EstadoPaquete, tipo: TipoMovimiento) {
    const permitidos: Partial<Record<TipoMovimiento, EstadoPaquete[]>> = {
      [TipoMovimiento.INGRESO_ALMACEN]: [EstadoPaquete.CREADO, EstadoPaquete.EN_ALMACEN],
      [TipoMovimiento.INGRESO_CENTRO]: [EstadoPaquete.EN_ALMACEN, EstadoPaquete.EN_CENTRO],
      [TipoMovimiento.SALIDA_RUTA]: [EstadoPaquete.EN_CENTRO, EstadoPaquete.INTENTO_FALLIDO],
      [TipoMovimiento.INTENTO_FALLIDO]: [EstadoPaquete.EN_RUTA],
      [TipoMovimiento.ENTREGADO]: [EstadoPaquete.EN_RUTA],
    };
    if (!permitidos[tipo]?.includes(estado)) throw new ConflictException(`No se permite ${tipo} desde ${estado}`);
  }
}
