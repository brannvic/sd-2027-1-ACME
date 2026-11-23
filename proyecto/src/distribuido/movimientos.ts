import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, HttpException, Injectable,
  NotFoundException, Param, Post, ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { Type as ValidarTipo } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { CorregirDireccionDto, CrearEnvioDto, RegistrarCasoDto, RegistrarMovimientoDto } from '../movimientos/movimientos.dto';
import { EstadoPaquete as E, TipoMovimiento as M } from '../movimientos/tipos';
import { obtenerFechaYHoraLocal, estaDentroDeFranja } from '../reintentos/horarios';
import { Rol } from '../usuarios/roles';
import { Actor, Confirmacion, Escaneo, EventoPaquete, MovimientoDistribuido, PaqueteDistribuido, Plan, RolDistribuido, Tipo } from './contrato';
import { Bases, comprobarInterna, guardarEvento, interna, shardDe } from './infra';
import { autenticar, crearAncla, estaRevocada, horaEscaneo, verificarSesion } from './sesiones';

class EscanearDto extends RegistrarMovimientoDto implements Escaneo {
  @IsOptional() @IsInt() @Min(1) revisionDireccion?: number;
  @IsOptional() @IsString() @MaxLength(1024) ancla?: string;
  @IsOptional() @IsNumber() @Min(0) transcurridoMs?: number;
  @IsOptional() @IsNumber() relojLocalMs?: number;
}
class LoteDto {
  @IsArray() @ValidateNested({ each: true }) @ValidarTipo(() => EscanearDto) escaneos!: EscanearDto[];
}
class RecuperacionDto {
  @IsUUID() id!: string;
}
type Solicitud = { clase: 'escanear'; datos: Escaneo } | { clase: 'corregir'; direccion: string };
type ComandoReintentos = { id: string; origen: string; accion: 'plan' | 'sucursal'; plan?: Plan };
interface Fila { version: number; datos: PaqueteDistribuido }
interface Entrada { movimiento: MovimientoDistribuido; huella: string }

function permitir(actor: Actor, ...roles: RolDistribuido[]) {
  if (!roles.includes(actor.rol)) throw new ForbiddenException('Tu rol no permite esta operación');
}

function guiaValida(guia: string) {
  if (!/^[A-Z0-9-]{6,40}$/.test(guia)) throw new BadRequestException('Formato de guía inválido');
  return guia;
}

function huella(actor: Actor, solicitud: object) {
  return createHash('sha256').update(JSON.stringify([actor.id, solicitud], (_clave, valor: unknown) => {
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return valor;
    return Object.fromEntries(Object.entries(valor).sort(([a], [b]) => a.localeCompare(b)));
  })).digest('hex');
}

function construirMovimiento(id: string, guia: string, usuarioId: string, tipo: Tipo): MovimientoDistribuido {
  return { id, numeroGuia: guia, usuarioId, tipo, registradoEn: new Date().toISOString(), confirmacion: 'confirmado', sospechoso: false };
}

@Injectable()
export class Movimientos {
  constructor(private readonly bases: Bases) {}

  private async enShard<T>(guia: string, operar: (base: Awaited<ReturnType<Bases['shard']>>) => Promise<T>) {
    try { return await operar(await this.bases.shard(shardDe(guia))); }
    catch (error) {
      const conexion = error as { code?: string; message?: string };
      if (['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'ECONNRESET', '57P01'].includes(conexion.code ?? '') ||
          /timeout exceeded when trying to connect|connection terminated/i.test(conexion.message ?? '')) {
        throw new ServiceUnavailableException('La partición de esta guía no está disponible');
      }
      throw error;
    }
  }

  private async transaccion<T>(guia: string, operar: (tx: EntityManager) => Promise<T>) {
    return this.enShard(guia, base => base.transaction(operar));
  }

  private async cargar(tx: EntityManager, guia: string): Promise<Fila> {
    const [fila] = await tx.query('SELECT datos, version FROM paquetes WHERE guia=$1 FOR UPDATE', [guia]);
    if (!fila) throw new NotFoundException('No existe el paquete');
    return fila;
  }

  private async publicar(tx: EntityManager, fila: Fila, movimiento: MovimientoDistribuido) {
    const paquete = fila.datos;
    const version = ++fila.version;
    await tx.query('UPDATE paquetes SET version=$2, datos=$3 WHERE guia=$1', [paquete.numeroGuia, version, paquete]);
    const evento: EventoPaquete = { id: randomUUID(), clave: 'paquete.actualizado', version, paquete, movimiento };
    await guardarEvento(tx, evento);
  }

  private async nuevo(tx: EntityManager, fila: Fila, movimiento: MovimientoDistribuido, huella: string) {
    await tx.query('INSERT INTO historial_movimientos VALUES ($1,$2,$3)',
      [movimiento.id, movimiento.numeroGuia, { movimiento, huella }]);
    await this.publicar(tx, fila, movimiento);
  }

  private async duplicado(tx: EntityManager, id: string, esperado: string): Promise<MovimientoDistribuido | undefined> {
    const [{ datos } = {}]: { datos?: Entrada }[] = await tx.query('SELECT datos FROM historial_movimientos WHERE id=$1', [id]);
    if (!datos) return;
    if (datos.huella !== esperado) throw new ConflictException('El UUID ya se utilizó con otros datos');
    return datos.movimiento;
  }

  async crear(datos: CrearEnvioDto, actor: Actor) {
    permitir(actor, 'proveedor', Rol.ADMINISTRADOR);
    let existe;
    try {
      const r = await interna('usuarios', '/interno/clientes/' + datos.clienteId);
      if (!r.ok) throw new Error();
      existe = (await r.json() as { existe: boolean }).existe;
    } catch { throw new ServiceUnavailableException('No se pudo verificar al titular'); }
    if (!existe) throw new BadRequestException('El titular debe ser un cliente existente');
    const creadoEn = new Date().toISOString();
    const paquete: PaqueteDistribuido = {
      ...datos, creadoEn, estado: E.CREADO, revisionDireccion: 1, direccionDesde: creadoEn,
      primeraSalidaEn: null, salidaEn: null, plan: null, ultimoFallo: null, contactoEn: null, clienteRespondio: null,
      notasContacto: null, decisionProveedor: null, casoCerradoEn: null,
    };
    return this.transaccion(datos.numeroGuia, async tx => {
      await tx.query('INSERT INTO paquetes VALUES ($1,0,$2)', [datos.numeroGuia, paquete]);
      await this.nuevo(tx, { datos: paquete, version: 0 },
        construirMovimiento(randomUUID(), datos.numeroGuia, actor.id, M.ENVIO_CREADO), '');
      return paquete;
    });
  }

  async escanear(datos: Escaneo, actor: Actor) {
    const almacen = datos.tipo === M.INGRESO_ALMACEN || datos.tipo === M.INGRESO_CENTRO;
    permitir(actor, almacen ? Rol.ALMACENISTA : Rol.REPARTIDOR);
    if (almacen && !datos.ubicacion) throw new BadRequestException('Indica el almacén o centro de distribución');
    if (datos.tipo === M.INTENTO_FALLIDO && !datos.motivo) throw new BadRequestException('Indica el motivo del intento fallido');
    if (datos.tipo === M.ENTREGADO && !datos.receptor) throw new BadRequestException('Indica quién recibió el paquete');
    const movimiento = {
      ...construirMovimiento(datos.id, datos.numeroGuia, actor.id, datos.tipo), ...horaEscaneo(datos, actor),
      ubicacion: datos.ubicacion, motivo: datos.motivo, receptor: datos.receptor,
    };
    return this.registrar(movimiento, { clase: 'escanear', datos }, actor, datos.tipo === M.ENTREGADO);
  }

  async corregir(guia: string, datos: CorregirDireccionDto, actor: Actor) {
    permitir(actor, Rol.CLIENTE);
    return this.registrar({ ...construirMovimiento(datos.id, guia, actor.id, M.DIRECCION_CORREGIDA), direccionNueva: datos.direccion },
      { clase: 'corregir', direccion: datos.direccion }, actor, true);
  }

  private async registrar(mov: MovimientoDistribuido, solicitud: Solicitud, actor: Actor, sensible: boolean) {
    const confirmacion: Confirmacion = sensible ? await verificarSesion(actor) : 'confirmado';
    if (confirmacion === 'rechazado') throw new UnauthorizedException('Sesión terminada');
    return this.transaccion(mov.numeroGuia, async tx => {
      // Serializa UUID repetidos dentro de la partición y bloquea la guía para ordenar sus eventos.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [mov.id]);
      const fila = await this.cargar(tx, mov.numeroGuia);
      const paquete = fila.datos;
      if (solicitud.clase === 'corregir' && paquete.clienteId !== actor.id) {
        throw new ForbiddenException('Solo el titular puede corregir la dirección');
      }
      const firma = huella(actor, solicitud);
      const existente = await this.duplicado(tx, mov.id, firma);
      if (existente) return { movimiento: existente, duplicado: true, paquete };
      this.validar(paquete, mov);
      const [anterior] = sensible ? await tx.query('SELECT id FROM confirmaciones WHERE guia=$1 LIMIT 1', [mov.numeroGuia]) : [];
      if (confirmacion === 'pendiente' || anterior) {
        mov.confirmacion = 'pendiente';
        await this.nuevo(tx, fila, mov, firma);
        await tx.query('INSERT INTO confirmaciones (id,guia,actor,operador,orden) VALUES ($1,$2,$3,$4,$5)',
          [mov.id, mov.numeroGuia, actor, solicitud, fila.version]);
      } else {
        this.aplicar(paquete, mov, solicitud);
        await this.nuevo(tx, fila, mov, firma);
      }
      return { movimiento: mov, duplicado: false, paquete };
    });
  }

  private validar(paquete: PaqueteDistribuido, mov: MovimientoDistribuido, reconciliar = false) {
    if (mov.tipo === M.DIRECCION_CORREGIDA) {
      const salida = paquete.primeraSalidaEn;
      if (salida && (!reconciliar || salida <= mov.registradoEn)) {
        throw new ConflictException('El paquete ya salió a ruta; no se puede corregir la dirección');
      }
      return;
    }
    if (mov.tipo === M.SALIDA_RUTA && paquete.estado === E.INTENTO_FALLIDO) {
      const local = obtenerFechaYHoraLocal(new Date(mov.registradoEn));
      if (!paquete.plan) throw new ServiceUnavailableException('Aún se está programando el próximo intento');
      if (local.fecha < paquete.plan.fecha || !estaDentroDeFranja(local.minutos, paquete.plan.franja)) {
        throw new ConflictException('El reintento corresponde desde ' + paquete.plan.fecha + ', franja ' + paquete.plan.franja);
      }
    }
    const permitidos: Partial<Record<Tipo, PaqueteDistribuido['estado'][]>> = {
      [M.INGRESO_ALMACEN]: [E.CREADO, E.EN_ALMACEN],
      [M.INGRESO_CENTRO]: [E.EN_ALMACEN, E.EN_CENTRO],
      [M.SALIDA_RUTA]: [E.EN_CENTRO, E.INTENTO_FALLIDO],
      [M.INTENTO_FALLIDO]: [E.EN_RUTA],
      [M.ENTREGADO]: [E.EN_RUTA],
    };
    if (!permitidos[mov.tipo]?.includes(paquete.estado)) {
      throw new ConflictException('No se permite ' + mov.tipo + ' desde ' + paquete.estado);
    }
    if ((mov.tipo === M.ENTREGADO || mov.tipo === M.INTENTO_FALLIDO) && paquete.salidaEn! > mov.registradoEn) {
      throw new ConflictException('El resultado tiene una hora anterior a la salida a ruta');
    }
  }

  private aplicar(paquete: PaqueteDistribuido, mov: MovimientoDistribuido, solicitud: Solicitud) {
    if (solicitud.clase === 'corregir') {
      if (paquete.direccionDesde > mov.registradoEn) throw new ConflictException('Hay una corrección de dirección más reciente');
      paquete.direccion = solicitud.direccion;
      paquete.direccionDesde = mov.registradoEn;
      paquete.revisionDireccion++;
      paquete.plan = null;
      return;
    }
    switch (mov.tipo) {
      case M.INGRESO_ALMACEN: paquete.estado = E.EN_ALMACEN; break;
      case M.INGRESO_CENTRO: paquete.estado = E.EN_CENTRO; break;
      case M.SALIDA_RUTA:
        paquete.primeraSalidaEn ??= mov.registradoEn;
        paquete.salidaEn = mov.registradoEn;
        paquete.estado = E.EN_RUTA;
        paquete.plan = null;
        break;
      case M.INTENTO_FALLIDO:
        paquete.ultimoFallo = mov.id;
        paquete.estado = E.INTENTO_FALLIDO;
        break;
      case M.ENTREGADO: {
        const revision = solicitud.datos.revisionDireccion;
        const coincide = revision === paquete.revisionDireccion || (revision === undefined && paquete.revisionDireccion === 1);
        if (!coincide && paquete.direccionDesde <= mov.registradoEn) {
          mov.tipo = 'entrega_erronea';
          paquete.estado = 'entrega_erronea';
        } else {
          paquete.estado = E.ENTREGADO;
        }
        break;
      }
    }
  }

  async reconciliar(indice: number) {
    const base = await this.bases.shard(indice);
    const pendientes: { id: string; guia: string; actor: Actor; operador: Solicitud }[] = await base.query(
      'SELECT DISTINCT ON (guia) id,guia,actor,operador FROM confirmaciones ORDER BY guia,orden',
    );
    for (const pendiente of pendientes) {
      const resultado = await estaRevocada(pendiente.actor.sesionId) ? 'rechazado' : await verificarSesion(pendiente.actor);
      if (resultado === 'pendiente') continue;
      await base.transaction(async tx => {
        const fila = await this.cargar(tx, pendiente.guia);
        const [vigente] = await tx.query('SELECT id FROM confirmaciones WHERE guia=$1 ORDER BY orden LIMIT 1', [pendiente.guia]);
        if (vigente?.id !== pendiente.id) return;
        const [{ datos }]: { datos: Entrada }[] = await tx.query('SELECT datos FROM historial_movimientos WHERE id=$1', [pendiente.id]);
        const mov = datos.movimiento;
        mov.confirmacion = resultado;
        if (resultado === 'confirmado') {
          try {
            this.validar(fila.datos, mov, true);
            this.aplicar(fila.datos, mov, pendiente.operador);
          } catch (error) {
            if (!(error instanceof ConflictException)) throw error;
            mov.confirmacion = 'rechazado';
          }
        }
        await tx.query('UPDATE historial_movimientos SET datos=$2 WHERE id=$1', [mov.id, datos]);
        await tx.query('DELETE FROM confirmaciones WHERE id=$1', [mov.id]);
        await this.publicar(tx, fila, mov);
      });
    }
  }

  planificar(guia: string, datos: ComandoReintentos) {
    return this.transaccion(guia, async tx => {
      const fila = await this.cargar(tx, guia);
      const paquete = fila.datos;
      if (paquete.estado !== E.INTENTO_FALLIDO || paquete.ultimoFallo !== datos.origen) return { aplicado: false };
      if (datos.accion === 'plan' && datos.plan?.revisionDireccion !== paquete.revisionDireccion) return { aplicado: false };
      const insercion = await tx.query('INSERT INTO comandos VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [datos.id, guia]);
      if (!insercion.length) return { aplicado: true };
      const pasaASucursal = datos.accion === 'sucursal';
      if (pasaASucursal) paquete.estado = E.EN_SUCURSAL;
      else paquete.plan = datos.plan!;
      const [{ datos: fallo }]: { datos: Entrada }[] = await tx.query('SELECT datos FROM historial_movimientos WHERE id=$1', [datos.origen]);
      await this.nuevo(tx, fila, construirMovimiento(randomUUID(), guia, fallo.movimiento.usuarioId,
        pasaASucursal ? M.PASO_SUCURSAL : 'reintento_programado'), '');
      return { aplicado: true };
    });
  }

  async direccion(guia: string) {
    const [{ datos: paquete } = {}]: { datos?: PaqueteDistribuido }[] = await this.enShard(guia,
      base => base.query('SELECT datos FROM paquetes WHERE guia=$1', [guia]));
    if (!paquete) throw new NotFoundException('No existe el paquete');
    const { numeroGuia, direccion, revisionDireccion, estado, plan } = paquete;
    return { numeroGuia, direccion, revisionDireccion, estado, plan };
  }

  caso(guia: string, datos: RegistrarCasoDto, actor: Actor) {
    permitir(actor, Rol.ADMINISTRADOR);
    if (datos.clienteRespondio && datos.decisionProveedor) throw new BadRequestException('La decisión requiere falta de respuesta del cliente');
    return this.transaccion(guia, async tx => {
      const fila = await this.cargar(tx, guia);
      const p = fila.datos;
      if (p.estado !== E.EN_SUCURSAL || p.casoCerradoEn) throw new ConflictException('El paquete no tiene un caso abierto en sucursal');
      const ahora = new Date().toISOString();
      p.contactoEn = ahora;
      p.clienteRespondio = datos.clienteRespondio;
      p.notasContacto = datos.notasContacto;
      if (datos.decisionProveedor) {
        p.decisionProveedor = datos.decisionProveedor;
        p.casoCerradoEn = ahora;
      }
      const movimiento = construirMovimiento(randomUUID(), guia, actor.id, datos.decisionProveedor ? 'caso_cerrado' : 'contacto_registrado');
      await this.nuevo(tx, fila, movimiento, '');
      return p;
    });
  }

  recuperar(guia: string, id: string, actor: Actor) {
    permitir(actor, Rol.ALMACENISTA, Rol.ADMINISTRADOR);
    return this.transaccion(guia, async tx => {
      const fila = await this.cargar(tx, guia);
      const firma = huella(actor, { guia, operacion: 'recuperar' });
      if (await this.duplicado(tx, id, firma)) return fila.datos;
      if (fila.datos.estado !== 'entrega_erronea') throw new ConflictException('El paquete no está pendiente de recuperación');
      fila.datos.estado = E.EN_CENTRO;
      await this.nuevo(tx, fila, construirMovimiento(id, guia, actor.id, 'recuperado'), firma);
      return fila.datos;
    });
  }
}

@Controller()
export class MovimientosApi {
  constructor(private readonly movimientos: Movimientos) {}

  @Get('api/v1/movimientos/hora')
  async hora(@Headers('authorization') auth?: string) { return crearAncla(await autenticar(auth)); }

  @Post('api/v1/movimientos/envios')
  async crear(@Body() datos: CrearEnvioDto, @Headers('authorization') auth?: string) {
    return this.movimientos.crear(datos, await autenticar(auth));
  }

  @Post('api/v1/movimientos/escanear') @HttpCode(200)
  async escanear(@Body() datos: EscanearDto, @Headers('authorization') auth?: string) {
    return this.movimientos.escanear(datos, await autenticar(auth));
  }

  @Post('api/v1/movimientos/sincronizar') @HttpCode(200)
  async lote(@Body() datos: LoteDto, @Headers('authorization') auth?: string) {
    const actor = await autenticar(auth);
    permitir(actor, Rol.REPARTIDOR, Rol.ALMACENISTA);
    const grupos = new Map<string, Escaneo[]>();
    for (const escaneo of datos.escaneos) {
      const grupo = grupos.get(escaneo.numeroGuia) ?? [];
      grupo.push(escaneo);
      grupos.set(escaneo.numeroGuia, grupo);
    }
    const resultados = await Promise.all([...grupos.values()].map(async grupo => {
      const parciales = [];
      for (const escaneo of grupo) {
        try {
          parciales.push({ id: escaneo.id, status: 200, ...await this.movimientos.escanear(escaneo, actor) });
        } catch (error) {
          const codigo = error instanceof HttpException ? error.getStatus() : 503;
          parciales.push({ id: escaneo.id, status: codigo, mensaje: codigo === 503 ? 'Operación temporalmente no disponible' : (error as Error).message });
          if (codigo >= 500) break; // Preserva el orden pendiente de la misma guía.
        }
      }
      return parciales;
    }));
    return { resultados: resultados.flat() };
  }

  @Post('api/v1/movimientos/:guia/direccion') @HttpCode(200)
  async corregir(@Param('guia') guia: string, @Body() datos: CorregirDireccionDto, @Headers('authorization') auth?: string) {
    return this.movimientos.corregir(guiaValida(guia), datos, await autenticar(auth));
  }

  @Get('api/v1/movimientos/:guia/direccion')
  async direccion(@Param('guia') guia: string, @Headers('authorization') auth?: string) {
    permitir(await autenticar(auth), Rol.REPARTIDOR, Rol.ALMACENISTA, Rol.ADMINISTRADOR);
    return this.movimientos.direccion(guiaValida(guia));
  }

  @Post('api/v1/movimientos/:guia/caso') @HttpCode(200)
  async caso(@Param('guia') guia: string, @Body() datos: RegistrarCasoDto, @Headers('authorization') auth?: string) {
    return this.movimientos.caso(guiaValida(guia), datos, await autenticar(auth));
  }

  @Post('api/v1/movimientos/:guia/recuperar') @HttpCode(200)
  async recuperar(@Param('guia') guia: string, @Body() datos: RecuperacionDto, @Headers('authorization') auth?: string) {
    return this.movimientos.recuperar(guiaValida(guia), datos.id, await autenticar(auth));
  }

  @Post('interno/:guia/reintentos') @HttpCode(200)
  planificar(@Param('guia') guia: string, @Body() datos: ComandoReintentos, @Headers('x-acme-interna') clave?: string) {
    comprobarInterna(clave);
    return this.movimientos.planificar(guia, datos);
  }
}
