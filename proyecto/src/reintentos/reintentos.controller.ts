import { Controller, Get, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AutenticacionGuard, Rol, Roles } from '../autenticacion/autenticacion';
import { ProgramacionReintento } from './reintento.entity';

@Controller('reintentos')
@UseGuards(AutenticacionGuard)
export class ReintentosController {
  constructor(private readonly baseDatos: DataSource) {}

  @Get() @Roles(Rol.REPARTIDOR, Rol.ADMINISTRADOR)
  consultarReintentosPendientes() {
    return this.baseDatos.getRepository(ProgramacionReintento).find({
      where: { estado: 'pendiente' }, order: { fecha: 'ASC', numeroGuia: 'ASC' },
    });
  }
}
