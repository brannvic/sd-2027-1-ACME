import {
  CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { KeyObject } from 'node:crypto';
import { DataSource } from 'typeorm';
import { verificarToken } from './tokens';

export enum Rol {
  CLIENTE = 'cliente',
  REPARTIDOR = 'repartidor',
  ALMACENISTA = 'almacenista',
  ADMINISTRADOR = 'administrador',
}

export interface UsuarioAutenticado { id: string; rol: Rol; sesionId: string }

export const LLAVE_PUBLICA_TOKENS = Symbol('LLAVE_PUBLICA_TOKENS');
export const Roles = (...roles: Rol[]) => SetMetadata('roles', roles);
type SolicitudAutenticada = Request & { usuario: UsuarioAutenticado };

export const UsuarioActual = createParamDecorator((_datos: unknown, contexto: ExecutionContext): UsuarioAutenticado =>
  contexto.switchToHttp().getRequest<SolicitudAutenticada>().usuario);

/**
 * Autenticación sin depender de Usuarios en línea:
 * 1. firma y vencimiento se verifican localmente con la llave pública;
 * 2. la revocación se consulta en la lista local sesiones_revocadas, que alimentan los eventos sesion_terminada.
 * Si Usuarios cae, el repartidor sigue trabajando con su token de jornada.
 */
@Injectable()
export class AutenticacionGuard implements CanActivate {
  constructor(
    @Inject(LLAVE_PUBLICA_TOKENS) private readonly llavePublica: KeyObject,
    private readonly baseDatos: DataSource,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const solicitud = contexto.switchToHttp().getRequest<SolicitudAutenticada>();
    const encabezado = solicitud.headers.authorization;
    if (!encabezado?.startsWith('Bearer ')) throw new UnauthorizedException('Se requiere un token Bearer');
    let datos;
    try { datos = verificarToken(encabezado.slice(7), this.llavePublica); } catch { throw new UnauthorizedException('Token inválido o vencido'); }
    if (!Object.values<string>(Rol).includes(datos.rol)) throw new UnauthorizedException('Token inválido o vencido');
    const revocada = await this.baseDatos.query('SELECT 1 FROM sesiones_revocadas WHERE "sesionId" = $1', [datos.sid]);
    if (revocada.length) throw new UnauthorizedException('Sesión terminada');
    solicitud.usuario = { id: datos.sub, rol: datos.rol as Rol, sesionId: datos.sid };
    const roles = this.reflector.getAllAndOverride<Rol[]>('roles', [contexto.getHandler(), contexto.getClass()]);
    if (roles && !roles.includes(solicitud.usuario.rol)) throw new ForbiddenException('Tu rol no permite esta operación');
    return true;
  }
}
