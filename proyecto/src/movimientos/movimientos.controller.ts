import { Body, Controller, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AutenticacionGuard, Rol, Roles, UsuarioActual, UsuarioAutenticado } from '../autenticacion/autenticacion';
import { CorregirDireccionDto, CrearEnvioDto, RegistrarCasoDto, RegistrarMovimientoDto } from './movimientos.dto';
import { MovimientosService } from './movimientos.service';

// 200 reenvío del mismo UUID · 201 registrado · 202 registrado pero pendiente de confirmar la sesión con Usuarios
const codigoDeRespuesta = (resultado: { duplicado: boolean; movimiento: { confirmacion: string } }) =>
  resultado.duplicado ? 200 : resultado.movimiento.confirmacion === 'pendiente' ? 202 : 201;

@Controller('paquetes')
@UseGuards(AutenticacionGuard)
@Roles(Rol.ADMINISTRADOR)
export class PaquetesController {
  constructor(private readonly movimientos: MovimientosService) {}

  @Post()
  crearEnvio(@Body() datos: CrearEnvioDto, @UsuarioActual() usuario: UsuarioAutenticado) {
    return this.movimientos.crearEnvio(datos, usuario);
  }

  @Patch(':numero_guia/caso')
  registrarContactoYDecision(@Param('numero_guia') numeroGuia: string, @Body() datos: RegistrarCasoDto) {
    return this.movimientos.registrarContactoYDecision(numeroGuia, datos);
  }
}

@Controller('movimientos')
@UseGuards(AutenticacionGuard)
export class MovimientosController {
  constructor(private readonly movimientos: MovimientosService) {}

  @Post('escanear') @Roles(Rol.ALMACENISTA, Rol.REPARTIDOR)
  async registrarMovimiento(@Body() datos: RegistrarMovimientoDto, @UsuarioActual() usuario: UsuarioAutenticado,
    @Res({ passthrough: true }) respuesta: Response) {
    const resultado = await this.movimientos.registrarMovimiento(datos, usuario);
    respuesta.status(codigoDeRespuesta(resultado));
    return resultado;
  }

  @Patch(':numero_guia/direccion') @Roles(Rol.CLIENTE)
  async corregirDireccion(@Param('numero_guia') numeroGuia: string, @Body() datos: CorregirDireccionDto,
    @UsuarioActual() usuario: UsuarioAutenticado, @Res({ passthrough: true }) respuesta: Response) {
    const resultado = await this.movimientos.corregirDireccion(numeroGuia, datos, usuario);
    respuesta.status(codigoDeRespuesta(resultado));
    return resultado;
  }
}
