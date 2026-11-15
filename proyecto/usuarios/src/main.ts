import 'reflect-metadata';
import { crearAplicacion } from './crear-aplicacion';

async function iniciarServidor() {
  const aplicacion = await crearAplicacion();
  await aplicacion.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

iniciarServidor().catch(error => { console.error(error); process.exitCode = 1; });
