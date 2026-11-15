import { Module } from '@nestjs/common';
import { Reloj } from '../reloj';
import { ReintentosModule } from '../reintentos/reintentos.module';
import { AutenticacionModule } from '../autenticacion/autenticacion.module';
import { MovimientosController, PaquetesController } from './movimientos.controller';
import { ConfirmacionesService } from './confirmaciones.service';
import { MovimientosService } from './movimientos.service';

@Module({
  imports: [AutenticacionModule, ReintentosModule], controllers: [MovimientosController, PaquetesController],
  providers: [MovimientosService, ConfirmacionesService, Reloj],
})
export class MovimientosModule {}
