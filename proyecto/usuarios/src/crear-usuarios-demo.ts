import 'reflect-metadata';
import { crearReplicas } from './app.module';
import { cargarLlavePrivada, Rol } from './tokens';
import { UsuariosService } from './usuarios.service';

// Crea las cuentas de demostración con escritura por quórum. Es idempotente: no cambia cuentas existentes.
async function crearUsuariosDemo() {
  const contrasena = process.env.DEMO_PASSWORD;
  if (!contrasena || contrasena.length < 12) throw new Error('DEMO_PASSWORD debe tener al menos 12 caracteres');
  const replicas = crearReplicas();
  const usuarios = new UsuariosService(replicas, cargarLlavePrivada());
  try {
    const roles: Rol[] = ['cliente', 'repartidor', 'almacenista', 'administrador'];
    for (const rol of roles) {
      const resultado = await usuarios.crearSiNoExiste(`${rol}@acme.test`, `Demo ${rol}`, rol, contrasena);
      console.log(`${resultado.creado ? 'Creado' : 'Disponible'}: ${rol}@acme.test`);
    }
    console.log(JSON.stringify((await replicas.estado()).replicas));
  } finally {
    await replicas.cerrar();
  }
}

crearUsuariosDemo().catch(error => { console.error(error.message ?? error); process.exitCode = 1; });
