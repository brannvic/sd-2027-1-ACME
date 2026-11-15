import { Module } from '@nestjs/common';
import { AutenticacionModule } from '../autenticacion/autenticacion.module';
import { ReintentosService } from './reintentos.service';
import { ReintentosController } from './reintentos.controller';

@Module({ imports: [AutenticacionModule], controllers: [ReintentosController], providers: [ReintentosService], exports: [ReintentosService] })
export class ReintentosModule {}
