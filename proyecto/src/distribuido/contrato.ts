import { EstadoPaquete, TipoMovimiento } from '../movimientos/tipos';
import type { Franja } from '../reintentos/horarios';
import { Rol } from '../usuarios/roles';
import { Evento, MensajeInvalido } from './infra';

export type RolDistribuido = Rol | 'proveedor';
export interface Actor { id: string; rol: RolDistribuido; sesionId: string; exp: number }
export type Estado = EstadoPaquete | 'entrega_erronea';
export type Tipo = TipoMovimiento | 'entrega_erronea' | 'recuperado' | 'contacto_registrado' | 'caso_cerrado' |
  'reintento_programado' | 'confirmacion_rechazada';
export type Confirmacion = 'pendiente' | 'confirmado' | 'rechazado';
export interface Plan {
  origen: string;
  fecha: string;
  franja: Franja;
  direccion: string;
  revisionDireccion: number;
}
export interface PaqueteDistribuido {
  numeroGuia: string;
  clienteId: string;
  destinatario: string;
  direccion: string;
  revisionDireccion: number;
  direccionDesde: string;
  estado: Estado;
  creadoEn: string;
  primeraSalidaEn: string | null;
  salidaEn: string | null;
  plan: Plan | null;
  ultimoFallo: string | null;
  contactoEn: string | null;
  clienteRespondio: boolean | null;
  notasContacto: string | null;
  decisionProveedor: string | null;
  casoCerradoEn: string | null;
}
export interface Escaneo {
  id: string;
  numeroGuia: string;
  tipo: TipoMovimiento;
  ubicacion?: string;
  motivo?: string;
  receptor?: string;
  revisionDireccion?: number;
  ancla?: string;
  transcurridoMs?: number;
  relojLocalMs?: number;
}
export interface MovimientoDistribuido {
  id: string;
  numeroGuia: string;
  usuarioId: string;
  tipo: Tipo;
  registradoEn: string;
  confirmacion: Confirmacion;
  sospechoso: boolean;
  ubicacion?: string;
  motivo?: string;
  receptor?: string;
  direccionNueva?: string;
}
export interface EventoPaquete extends Evento {
  clave: 'paquete.actualizado';
  version: number;
  paquete: PaqueteDistribuido;
  movimiento: MovimientoDistribuido;
}

export function eventoPaquete(dato: unknown): EventoPaquete {
  const evento = dato as EventoPaquete;
  if (evento?.clave !== 'paquete.actualizado' || !evento.id || !Number.isInteger(evento.version) ||
    !evento.paquete?.numeroGuia || !evento.movimiento?.id) throw new MensajeInvalido('Evento de paquete inválido');
  return evento;
}

export function publico(paquete: PaqueteDistribuido, historial: MovimientoDistribuido[]) {
  return { numeroGuia: paquete.numeroGuia, estado: paquete.estado, historial: historial
    .filter(movimiento => movimiento.confirmacion === 'confirmado')
    .map(({ tipo, registradoEn }) => ({ tipo, registradoEn })) };
}
