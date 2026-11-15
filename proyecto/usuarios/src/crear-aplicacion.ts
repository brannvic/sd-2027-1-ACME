import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SinQuorumFiltro } from './controladores';
import { Replicas } from './quorum';

export async function crearAplicacion(): Promise<INestApplication> {
  const aplicacion = await NestFactory.create(AppModule);
  aplicacion.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  aplicacion.useGlobalFilters(new SinQuorumFiltro());
  aplicacion.enableShutdownHooks();
  const replicas = aplicacion.get(Replicas);
  const cerrar = aplicacion.close.bind(aplicacion);
  aplicacion.close = async () => { await cerrar(); await replicas.cerrar(); };
  return aplicacion;
}
