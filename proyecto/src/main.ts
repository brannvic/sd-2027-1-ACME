import 'reflect-metadata';
import { Controller, Get, Module, Type, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { resolve } from 'node:path';
import { json } from 'express';
import { ErroresBaseDatos } from './errores-base-datos';
import { ConsultaApi, Consultas, proyectarConsulta } from './distribuido/consulta';
import { Gateway, GatewayApi } from './distribuido/gateway';
import { Bases, consumir, ciclo, escucharRevocaciones, iniciarCache, publicarOutbox, puerto } from './distribuido/infra';
import { Movimientos, MovimientosApi } from './distribuido/movimientos';
import { iniciarReintentos } from './distribuido/reintentos';
import { proyectarRevocacion, revocarLocal, Sesiones, SesionesApi } from './distribuido/sesiones';

@Controller()
class Salud {
  @Get('health') get() { return { servicio: process.env.SERVICIO, proceso: process.env.HOSTNAME }; }
}

async function iniciarApi(controlador: Type, servicio: Type, gateway = false) {
  @Module({ controllers: gateway ? [controlador] : [controlador, Salud], providers: [Bases, servicio] })
  class Modulo {}
  const app = await NestFactory.create<NestExpressApplication>(Modulo, { bodyParser: false });
  app.use(json({ limit: '16mb' }));
  app.enableShutdownHooks();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ErroresBaseDatos());
  if (gateway) app.useStaticAssets(resolve('web'), {
    setHeaders: (res, ruta) => {
      if (ruta.endsWith('sw.js') || ruta.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  });
  await app.listen(puerto, '0.0.0.0');
  return app;
}

async function main() {
  if (!process.env.CLAVE_INTERNA || !process.env.JWT_SECRET) throw new Error('Configura las claves de ACME');
  iniciarCache();
  if (['gateway', 'consulta', 'movimientos'].includes(process.env.SERVICIO ?? '')) {
    void escucharRevocaciones(revocarLocal);
  }
  switch (process.env.SERVICIO) {
    case 'gateway': return iniciarApi(GatewayApi, Gateway, true);
    case 'consulta': return iniciarApi(ConsultaApi, Consultas);
    case 'proyeccion': return proyectarConsulta();
    case 'reintentos': return iniciarReintentos();
    case 'revocaciones': return consumir('revocaciones', proyectarRevocacion);
    case 'usuarios': {
      const app = await iniciarApi(SesionesApi, Sesiones);
      const bases = app.get(Bases);
      void publicarOutbox('outbox usuarios', () => bases.usuarios());
      void app.get(Sesiones).inicializarDemo();
      return;
    }
    case 'movimientos': {
      const app = await iniciarApi(MovimientosApi, Movimientos);
      const bases = app.get(Bases);
      for (let indice = 0; indice < 4; indice++) {
        void publicarOutbox('outbox shard ' + indice, () => bases.shard(indice));
        void ciclo('confirmaciones shard ' + indice, () => app.get(Movimientos).reconciliar(indice));
      }
      return;
    }
    default: throw new Error('Servicio inválido');
  }
}

void main().catch(error => { console.error(error); process.exit(1); });
