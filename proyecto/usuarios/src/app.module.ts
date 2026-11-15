import { Module } from '@nestjs/common';
import { AuthController, InternoController, SaludController, SesionPropiaGuard } from './controladores';
import { PublicadorSesiones } from './publicador-sesiones';
import { Replicas } from './quorum';
import { cargarLlavePrivada } from './tokens';
import { UsuariosService } from './usuarios.service';

export function crearReplicas() {
  const urls = (process.env.USUARIOS_DB_URLS ?? '').split(',').map(url => url.trim()).filter(Boolean);
  return new Replicas(urls, Number(process.env.QUORUM_TIMEOUT_MS ?? 2000));
}

@Module({
  controllers: [AuthController, InternoController, SaludController],
  providers: [
    { provide: Replicas, useFactory: crearReplicas },
    { provide: UsuariosService, useFactory: (replicas: Replicas) => new UsuariosService(replicas, cargarLlavePrivada()), inject: [Replicas] },
    {
      provide: PublicadorSesiones, inject: [Replicas],
      useFactory: (replicas: Replicas) => new PublicadorSesiones(
        replicas, process.env.RABBITMQ_URL ?? 'amqp://acme:acme_desarrollo@localhost:5672', Number(process.env.PUBLICAR_CADA_MS ?? 2000)),
    },
    SesionPropiaGuard,
  ],
})
export class AppModule {}
