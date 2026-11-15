import { Module } from '@nestjs/common';
import { AutenticacionGuard, LLAVE_PUBLICA_TOKENS } from './autenticacion';
import { ConsumidorSesiones } from './consumidor-sesiones';
import { cargarLlavePublica } from './tokens';
import { UsuariosCliente } from './usuarios.cliente';

// Ya no hay tablas de usuarios aquí: Usuarios es otro servicio. Este módulo solo verifica tokens,
// guarda la lista de sesiones revocadas que llega por eventos y habla con Usuarios por HTTP interno.
@Module({
  providers: [
    { provide: LLAVE_PUBLICA_TOKENS, useFactory: cargarLlavePublica },
    AutenticacionGuard, ConsumidorSesiones, UsuariosCliente,
  ],
  exports: [LLAVE_PUBLICA_TOKENS, AutenticacionGuard, ConsumidorSesiones, UsuariosCliente],
})
export class AutenticacionModule {}
