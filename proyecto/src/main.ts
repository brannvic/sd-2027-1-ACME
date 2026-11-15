import 'reflect-metadata';
import 'dotenv/config';
import { ConsumidorSesiones } from './autenticacion/consumidor-sesiones';
import { crearAplicacion } from './crear-aplicacion';

async function iniciarServidor() {
  const aplicacion = await crearAplicacion();
  // Al recuperarse, primero se procesa la cola de sesiones revocadas y después se abre la API.
  const sesiones = aplicacion.get(ConsumidorSesiones);
  sesiones.iniciar();
  await sesiones.ponerseAlDia(Number(process.env.ESPERA_COLA_MS ?? 5000));
  await aplicacion.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
}

iniciarServidor().catch(error => { console.error(error); process.exitCode = 1; });
