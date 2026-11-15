import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConsumidorSesiones } from './autenticacion/consumidor-sesiones';

@Controller('health')
export class SaludController {
  constructor(private readonly baseDatos: DataSource, private readonly sesiones: ConsumidorSesiones) {}

  // Sin base no hay servicio (503). Sin RabbitMQ sí: solo se atrasan las revocaciones por evento.
  @Get()
  async comprobarSalud() {
    const mensajeria = this.sesiones.conectado ? 'UP' : 'DOWN';
    try {
      await this.baseDatos.query('SELECT 1');
      return { estado: 'UP', baseDatos: 'UP', mensajeria };
    } catch {
      throw new ServiceUnavailableException({ estado: 'DOWN', baseDatos: 'DOWN', mensajeria });
    }
  }
}
