import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { KeyObject, randomUUID } from 'node:crypto';
import { generarHashContrasena, verificarContrasena } from './contrasenas';
import { Registro, Replicas } from './quorum';
import { DatosToken, Rol, firmarToken, llavePublicaDe, verificarToken } from './tokens';

export interface FilaUsuario extends Registro { correo: string; nombre: string; contrasena_hash: string; rol: Rol }
export interface FilaSesion extends Registro { usuario_id: string; vence_en: Date; revocada_en: Date | null; evento_publicado: boolean }

export const DURACION_SESION_MS = 12 * 60 * 60 * 1000; // jornada completa

@Injectable()
export class UsuariosService {
  private readonly llavePublica: KeyObject;

  constructor(private readonly replicas: Replicas, private readonly llavePrivada: KeyObject) {
    this.llavePublica = llavePublicaDe(llavePrivada);
  }

  /** Lectura y escritura por quórum: sin mayoría de réplicas no hay login (503). */
  async iniciarSesion(correo: string, contrasena: string) {
    const usuario = await this.buscarPorCorreo(correo);
    if (!usuario || !verificarContrasena(contrasena, usuario.contrasena_hash)) {
      throw new UnauthorizedException('Correo o contraseña incorrectos');
    }
    const ahora = Date.now();
    const sesion: FilaSesion = {
      id: randomUUID(), usuario_id: usuario.id, vence_en: new Date(ahora + DURACION_SESION_MS),
      revocada_en: null, evento_publicado: false, version: Replicas.siguienteVersion(),
    };
    await this.replicas.escribir('sesiones', sesion);
    const datos: DatosToken = { sub: usuario.id, sid: sesion.id, rol: usuario.rol, iat: Math.floor(ahora / 1000), exp: Math.floor(sesion.vence_en.getTime() / 1000) };
    return {
      token: firmarToken(datos, this.llavePrivada),
      venceEn: sesion.vence_en,
      usuario: { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol },
    };
  }

  /** Para operaciones de la propia cuenta (logout, contraseña): firma local + sesión vigente leída por quórum. */
  async autenticar(token: string) {
    let datos: DatosToken;
    try { datos = verificarToken(token, this.llavePublica); } catch { throw new UnauthorizedException('Token inválido o vencido'); }
    const sesion = await this.replicas.leerUno<FilaSesion>('sesiones', 'id = $1', [datos.sid]);
    if (!sesion || sesion.usuario_id !== datos.sub || !this.estaActiva(sesion)) throw new UnauthorizedException('Sesión terminada');
    return { datos, sesion };
  }

  /**
   * Revocar y "dejar el evento pendiente" es una sola escritura (evento_publicado = false):
   * la tabla de sesiones funciona como outbox y el publicador manda sesion_terminada a RabbitMQ.
   */
  async revocar(sesion: FilaSesion) {
    await this.replicas.escribir('sesiones', {
      ...sesion, revocada_en: new Date(), evento_publicado: false, version: Replicas.siguienteVersion(sesion),
    });
  }

  async cambiarContrasena(usuarioId: string, actual: string, nueva: string) {
    if (actual === nueva) throw new BadRequestException('La contraseña nueva debe ser distinta');
    const usuario = await this.replicas.leerUno<FilaUsuario>('usuarios', 'id = $1', [usuarioId]);
    if (!usuario || !verificarContrasena(actual, usuario.contrasena_hash)) throw new UnauthorizedException('La contraseña actual no coincide');
    // Primero se revocan las sesiones: si después falla el quórum, lo peor es que el usuario quedó fuera, no una brecha.
    const sesiones = await this.replicas.leerVarios<FilaSesion>('sesiones', 'usuario_id = $1 AND revocada_en IS NULL', [usuarioId]);
    for (const sesion of sesiones.filter(s => this.estaActiva(s))) await this.revocar(sesion);
    await this.replicas.escribir('usuarios', {
      ...usuario, contrasena_hash: generarHashContrasena(nueva), version: Replicas.siguienteVersion(usuario),
    });
    return { mensaje: 'Contraseña actualizada; inicia sesión de nuevo', sesionesRevocadas: sesiones.length };
  }

  /** Revocación síncrona que consultan los demás servicios para "entregado" y cambio de dirección. */
  async estadoSesion(sesionId: string) {
    const sesion = await this.replicas.leerUno<FilaSesion>('sesiones', 'id = $1', [sesionId]);
    return { sesionId, activa: !!sesion && this.estaActiva(sesion), usuarioId: sesion?.usuario_id ?? null };
  }

  async obtenerUsuario(id: string) {
    const usuario = await this.replicas.leerUno<FilaUsuario>('usuarios', 'id = $1', [id]);
    return usuario && { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol };
  }

  /** Alta idempotente por correo (la usa el seed). No cambia la contraseña de una cuenta existente. */
  async crearSiNoExiste(correo: string, nombre: string, rol: Rol, contrasena: string) {
    const existente = await this.buscarPorCorreo(correo);
    if (existente) return { creado: false, id: existente.id };
    const usuario: FilaUsuario = {
      id: randomUUID(), correo: correo.toLowerCase(), nombre, rol,
      contrasena_hash: generarHashContrasena(contrasena), version: Replicas.siguienteVersion(),
    };
    await this.replicas.escribir('usuarios', usuario);
    return { creado: true, id: usuario.id };
  }

  private buscarPorCorreo(correo: string) {
    return this.replicas.leerUno<FilaUsuario>('usuarios', 'correo = $1', [correo.toLowerCase()]);
  }

  private estaActiva(sesion: FilaSesion) {
    return !sesion.revocada_en && new Date(sesion.vence_en).getTime() > Date.now();
  }
}
