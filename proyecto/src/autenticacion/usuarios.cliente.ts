import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export type EstadoVerificacion = 'activa' | 'revocada' | 'no_verificable';

/**
 * Cliente HTTP hacia las rutas internas de Usuarios (no pasan por Nginx).
 * Toda llamada tiene timeout: el monolito nunca se queda colgado esperando a otro servicio.
 */
@Injectable()
export class UsuariosCliente {
  private readonly url = process.env.USUARIOS_URL ?? 'http://localhost:3000';
  private readonly timeoutMs = Number(process.env.USUARIOS_TIMEOUT_MS ?? 2000);

  /** Revocación síncrona. "no_verificable" cuando Usuarios no responde o no tiene quórum. */
  async verificarSesion(sesionId: string): Promise<EstadoVerificacion> {
    try {
      const respuesta = await fetch(`${this.url}/interno/sesiones/${sesionId}`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!respuesta.ok) return 'no_verificable';
      const { activa } = await respuesta.json() as { activa: boolean };
      return activa ? 'activa' : 'revocada';
    } catch {
      return 'no_verificable';
    }
  }

  /** Para dar de alta un envío hay que confirmar que el titular existe y es cliente. Sin Usuarios: 503. */
  async obtenerUsuario(id: string): Promise<{ id: string; rol: string } | null> {
    let respuesta: Response;
    try {
      respuesta = await fetch(`${this.url}/interno/usuarios/${id}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new ServiceUnavailableException('Usuarios no responde; no se puede validar al titular del envío');
    }
    if (respuesta.status === 404) return null;
    if (!respuesta.ok) throw new ServiceUnavailableException('Usuarios no responde; no se puede validar al titular del envío');
    return respuesta.json() as Promise<{ id: string; rol: string }>;
  }
}
