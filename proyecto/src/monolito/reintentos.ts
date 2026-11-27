import { TipoMovimiento as M, EstadoPaquete as E } from '../movimientos/tipos';
import { obtenerFechaSiguiente, obtenerFechaYHoraLocal } from '../reintentos/horarios';
import { EventoPaquete, Plan, eventoPaquete } from '../distribuido/contrato';
import { ciclo, consumir, interna, mongo } from '../distribuido/infra';

type Franja = Plan['franja'];
type Programacion = Plan & { estado: 'pendiente' | 'consumido' | 'cancelado'; id: string };
interface Intento {
  salidaId: string;
  fecha: string;
  franja: Franja;
  direccion: string;
  resultado?: { id: string; tipo: 'fallido' | 'entregado' | 'compensado' };
}
interface Comando {
  id: string;
  origen: string;
  accion: 'plan' | 'sucursal';
  plan?: Plan;
}
interface Registro {
  _id: string;
  version: number;
  intentos: Intento[];
  programaciones: Programacion[];
  comandos: Comando[];
}

function calcular(registro: Registro, evento: EventoPaquete): Registro {
  const { movimiento: m, paquete: p, version } = evento;
  const intentos = registro.intentos.map(x => ({ ...x }));
  const programaciones = registro.programaciones.map(x => ({ ...x }));
  const comandos = [...registro.comandos];
  const pendiente = programaciones.find(x => x.estado === 'pendiente');
  const actual = intentos.at(-1);
  if (m.confirmacion !== 'confirmado') return { ...registro, version };
  if (m.tipo === M.SALIDA_RUTA) {
    const local = obtenerFechaYHoraLocal(new Date(m.registradoEn));
    intentos.push({ salidaId: m.id, fecha: local.fecha,
      franja: pendiente?.franja ?? (local.minutos < 14 * 60 ? 'manana' : 'tarde'),
      direccion: p.direccion });
    if (pendiente) pendiente.estado = 'consumido';
  }
  if ((m.tipo === M.ENTREGADO || m.tipo === 'entrega_erronea' || m.tipo === M.INTENTO_FALLIDO) && actual) {
    actual.resultado = { id: m.id, tipo: m.tipo === M.INTENTO_FALLIDO ? 'fallido' :
      m.tipo === M.ENTREGADO ? 'entregado' : 'compensado' };
  }
  if (m.tipo === M.INTENTO_FALLIDO && actual) {
    const fallos = new Set(intentos.filter(x => x.resultado?.tipo === 'fallido')
      .map(x => x.fecha));
    if (fallos.size >= 3) {
      comandos.push({ id: m.id + ':sucursal', origen: m.id, accion: 'sucursal' });
    } else {
      const fecha = obtenerFechaSiguiente(obtenerFechaYHoraLocal(new Date(m.registradoEn)).fecha);
      const plan: Plan = { origen: m.id, fecha, franja: actual.franja === 'manana' ? 'tarde' : 'manana',
        direccion: p.direccion, revisionDireccion: p.revisionDireccion };
      const id = m.id + ':plan:' + p.revisionDireccion;
      programaciones.push({ ...plan, id, estado: 'pendiente' });
      comandos.push({ id, origen: m.id, accion: 'plan', plan });
    }
  }
  if (m.tipo === M.DIRECCION_CORREGIDA && pendiente) {
    pendiente.estado = 'cancelado';
    const plan: Plan = { origen: pendiente.origen, fecha: pendiente.fecha, franja: pendiente.franja,
      direccion: p.direccion, revisionDireccion: p.revisionDireccion };
    const id = plan.origen + ':plan:' + plan.revisionDireccion;
    programaciones.push({ ...plan, id, estado: 'pendiente' });
    comandos.push({ id, origen: plan.origen, accion: 'plan', plan });
  }
  if (pendiente && (p.estado === E.EN_SUCURSAL || p.estado === E.ENTREGADO)) pendiente.estado = 'cancelado';
  return { ...registro, version, intentos, programaciones, comandos };
}

export async function iniciarReintentos() {
  const registros = mongo().collection<Registro>('intentos_entrega');
  void ciclo('comandos de reintentos', async () => {
    const guias = await registros.find({ 'comandos.0': { $exists: true } }).sort({ _id: 1 }).toArray();
    // Procesa independientemente para que un shard caído no pause las otras guías.
    for (let inicio = 0; inicio < guias.length; inicio += 16) {
      await Promise.allSettled(guias.slice(inicio, inicio + 16).map(async registro => {
        const comando = registro.comandos[0];
        const r = await interna('movimientos', '/interno/' + registro._id + '/reintentos', {
          method: 'POST', body: JSON.stringify(comando),
        }, 6000);
        await r.body?.cancel();
        if (!r.ok) return;
        await registros.updateOne({ _id: registro._id }, { $pull: { comandos: { id: comando.id } } });
      }));
    }
  }, 350);

  await consumir('reintentos', async dato => {
    const evento = eventoPaquete(dato);
    const _id = evento.paquete.numeroGuia;
    const filtro = { _id };
    const actual = await registros.findOne(filtro);
    if (actual && actual.version >= evento.version) return;
    const registro = calcular(actual ?? { _id, version: 0, intentos: [], programaciones: [], comandos: [] }, evento);
    const comandos = registro.comandos.slice(actual?.comandos.length ?? 0);
    await registros.updateOne(filtro, {
      $set: { version: registro.version, intentos: registro.intentos, programaciones: registro.programaciones },
      $push: { comandos: { $each: comandos } },
    }, { upsert: true });
  });
}
