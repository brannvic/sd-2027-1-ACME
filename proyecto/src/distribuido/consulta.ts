import {
  BadGatewayException, Controller, ForbiddenException, Get, Headers, Injectable, NotFoundException, Param,
} from '@nestjs/common';
import { Channel } from 'amqplib';
import { MovimientoDistribuido, PaqueteDistribuido, eventoPaquete, publico } from './contrato';
import { cache, consumir, ciclo, mongo, redisLimite } from './infra';
import { autenticar } from './sesiones';

export interface Vista {
  _id: string;
  version: number;
  paquete: PaqueteDistribuido;
  historial: MovimientoDistribuido[];
}
type DocumentoVista = Vista & { cachePendiente?: boolean };

const claveVista = (guia: string) => 'tracking:' + guia;
const ttlVista = 43200;
const guardarSiMasReciente = `
  local anterior = redis.call('GET', KEYS[1])
  if anterior and cjson.decode(anterior).version > tonumber(ARGV[1]) then return 0 end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
`;

async function guardarCache(vista: Vista) {
  try {
    const { _id, version, paquete, historial } = vista;
    await redisLimite(() => cache.eval(guardarSiMasReciente, {
      keys: [claveVista(_id)], arguments: [String(version), JSON.stringify({ _id, version, paquete, historial }), String(ttlVista)],
    }));
    return true;
  } catch { return false; }
}

export async function leerCache(guia: string) {
  try {
    const valor = await redisLimite(() => cache.get(claveVista(guia)));
    return valor ? JSON.parse(valor) as Vista : null;
  } catch { return null; }
}

interface SaludProyeccion { _id: string; sincronizada: boolean; actualizada: Date }

export async function proyectarConsulta() {
  const db = mongo();
  const vistas = db.collection<DocumentoVista>('guias');
  const salud = db.collection<SaludProyeccion>('salud');
  let canal: Channel | null = null;
  let trabajando = false;
  let sincronizada = false;
  let generacion = 0;
  void ciclo('reparación de caché', async () => {
    if (!cache.isReady) return;
    const pendientes = await vistas.find({ cachePendiente: true }).limit(50).toArray();
    for (const vista of pendientes) {
      if (!await guardarCache(vista)) break;
      await vistas.updateOne({ _id: vista._id, version: vista.version }, { $unset: { cachePendiente: '' } });
    }
  }, 1000);
  void ciclo('salud de consulta', async () => {
    const actual = canal;
    const revision = generacion;
    if (!actual) return;
    const cola = await actual.checkQueue('consulta');
    if (revision !== generacion) return;
    if (!trabajando && cola.messageCount === 0) sincronizada = true;
    await salud.updateOne({ _id: 'proyeccion' },
      { $set: { sincronizada, actualizada: new Date() } }, { upsert: true });
  }, 500);

  await consumir('consulta', async dato => {
    try {
      const { paquete, movimiento, version } = eventoPaquete(dato);
      const _id = paquete.numeroGuia;
      const anterior = await vistas.findOne({ _id });
      if (anterior && anterior.version >= version) return;
      const historial = [...(anterior?.historial ?? [])];
      const posicion = historial.findIndex(mov => mov.id === movimiento.id);
      if (posicion >= 0) historial[posicion] = movimiento;
      else historial.push(movimiento);
      const vista: DocumentoVista = { _id, paquete, version, historial, cachePendiente: true };
      await vistas.replaceOne({ _id }, vista, { upsert: true });
      if (await guardarCache(vista)) {
        await vistas.updateOne({ _id, version }, { $unset: { cachePendiente: '' } });
      }
    } catch (error) {
      sincronizada = false;
      throw error;
    }
  }, nuevo => {
    generacion++;
    canal = nuevo;
    sincronizada = false;
  }, activo => { trabajando = activo; });
}

export async function respuestaVista(vista: Vista, detalle: boolean, auth?: string) {
  if (!detalle) return publico(vista.paquete, vista.historial);
  const actor = await autenticar(auth);
  if (actor.id !== vista.paquete.clienteId) throw new ForbiddenException('Solo el titular puede consultar el detalle');
  return { ...vista.paquete, historial: vista.historial };
}

@Injectable()
export class Consultas {
  private readonly db = mongo();
  async leer(guia: string, detalle: boolean, auth?: string) {
    if (detalle) await autenticar(auth);
    const salud = await this.db.collection<SaludProyeccion>('salud').findOne({ _id: 'proyeccion' })
      .catch(() => { throw new BadGatewayException('La proyección está temporalmente indisponible'); });
    if (!salud?.sincronizada || Date.now() - salud.actualizada.getTime() > 4000) {
      throw new BadGatewayException('La proyección aún se está sincronizando');
    }
    const cacheada = await leerCache(guia);
    const vista = cacheada ?? await this.db.collection<Vista>('guias').findOne({ _id: guia })
      .catch(() => { throw new BadGatewayException('La base de consulta está temporalmente indisponible'); });
    if (!vista) throw new NotFoundException('No existe el paquete');
    if (!cacheada) await guardarCache(vista);
    return respuestaVista(vista, detalle, auth);
  }
}

@Controller('api/v1/tracking')
export class ConsultaApi {
  constructor(private readonly consultas: Consultas) {}

  @Get(':guia/detalle')
  detalle(@Param('guia') guia: string, @Headers('authorization') auth?: string) {
    return this.consultas.leer(guia, true, auth);
  }

  @Get(':guia')
  publico(@Param('guia') guia: string) { return this.consultas.leer(guia, false); }
}

