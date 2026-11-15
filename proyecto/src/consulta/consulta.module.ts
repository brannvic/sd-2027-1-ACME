import { Module } from '@nestjs/common';
import { AutenticacionModule } from '../autenticacion/autenticacion.module';
import { ConsultaController } from './consulta.controller';
import { ConsultaService } from './consulta.service';

@Module({ imports: [AutenticacionModule], controllers: [ConsultaController], providers: [ConsultaService] })
export class ConsultaModule {}
