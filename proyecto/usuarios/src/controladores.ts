import {
  ArgumentsHost, Body, CanActivate, Catch, Controller, ExceptionFilter, ExecutionContext, Get, HttpCode, HttpStatus,
  Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Req, ServiceUnavailableException, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { PublicadorSesiones } from './publicador-sesiones';
import { Replicas, SinQuorumError } from './quorum';
import { FilaSesion, UsuariosService } from './usuarios.service';
import { DatosToken } from './tokens';

class InicioSesionDto {
  @IsEmail() @MaxLength(254) correo!: string;
  @IsString() @MinLength(1) @MaxLength(128) contrasena!: string;
}

class CambioContrasenaDto {
  @IsString() @MinLength(1) @MaxLength(128) contrasenaActual!: string;
  @IsString() @MinLength(12) @MaxLength(128) contrasenaNueva!: string;
}

type SolicitudConSesion = Request & { sesion: { datos: DatosToken; sesion: FilaSesion } };

@Injectable()
export class SesionPropiaGuard implements CanActivate {
  constructor(private readonly usuarios: UsuariosService) {}
  async canActivate(contexto: ExecutionContext) {
    const solicitud = contexto.switchToHttp().getRequest<SolicitudConSesion>();
    const encabezado = solicitud.headers.authorization;
    if (!encabezado?.startsWith('Bearer ')) throw new UnauthorizedException('Se requiere un token Bearer');
    solicitud.sesion = await this.usuarios.autenticar(encabezado.slice(7));
    return true;
  }
}

/** Rutas públicas: Nginx solo enruta /api/v1/auth/* hacia este servicio. */
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly usuarios: UsuariosService, private readonly publicador: PublicadorSesiones) {}

  @Post('login') @HttpCode(200)
  iniciarSesion(@Body() datos: InicioSesionDto) {
    return this.usuarios.iniciarSesion(datos.correo, datos.contrasena);
  }

  @Post('logout') @HttpCode(200) @UseGuards(SesionPropiaGuard)
  async cerrarSesion(@Req() solicitud: SolicitudConSesion) {
    await this.usuarios.revocar(solicitud.sesion.sesion);
    this.publicador.despertar();
    return { mensaje: 'Sesión cerrada' };
  }

  @Post('contrasena') @HttpCode(200) @UseGuards(SesionPropiaGuard)
  async cambiarContrasena(@Req() solicitud: SolicitudConSesion, @Body() datos: CambioContrasenaDto) {
    const resultado = await this.usuarios.cambiarContrasena(solicitud.sesion.datos.sub, datos.contrasenaActual, datos.contrasenaNueva);
    this.publicador.despertar();
    return resultado;
  }
}

/**
 * Rutas internas: solo las usan otros servicios dentro de la red de Docker. Nginx no las publica.
 * En producción irían protegidas además con mTLS o un token de servicio.
 */
@Controller('interno')
export class InternoController {
  constructor(private readonly usuarios: UsuariosService) {}

  @Get('sesiones/:id')
  estadoSesion(@Param('id', ParseUUIDPipe) id: string) {
    return this.usuarios.estadoSesion(id);
  }

  @Get('usuarios/:id')
  async obtenerUsuario(@Param('id', ParseUUIDPipe) id: string) {
    const usuario = await this.usuarios.obtenerUsuario(id);
    if (!usuario) throw new NotFoundException('No existe el usuario');
    return usuario;
  }
}

@Controller('health')
export class SaludController {
  constructor(private readonly replicas: Replicas, private readonly publicador: PublicadorSesiones) {}

  @Get()
  async comprobarSalud() {
    const estado = await this.replicas.estado();
    const cuerpo = {
      estado: estado.quorum ? (estado.vivas === Object.keys(estado.replicas).length ? 'UP' : 'DEGRADADO') : 'SIN_QUORUM',
      ...estado, mensajeria: this.publicador.conectado ? 'UP' : 'DOWN',
    };
    if (!estado.quorum) throw new ServiceUnavailableException(cuerpo);
    return cuerpo;
  }
}

@Catch(SinQuorumError)
export class SinQuorumFiltro implements ExceptionFilter {
  catch(error: SinQuorumError, contexto: ArgumentsHost) {
    contexto.switchToHttp().getResponse<Response>().status(HttpStatus.SERVICE_UNAVAILABLE).json({
      statusCode: 503,
      message: 'No hay mayoría de réplicas de Usuarios; no se puede iniciar sesión ni cambiar datos. Los tokens vigentes siguen funcionando.',
      detalle: error.message,
    });
  }
}
