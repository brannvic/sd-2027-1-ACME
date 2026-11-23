import {
  Body, ConflictException, Controller, Get, Headers, HttpCode, Injectable, Param, Post, ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { IsEmail, IsNotEmpty, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { Bases, cache, claveInterna, comprobarInterna, guardarEvento, interna, MensajeInvalido, pausa, redisLimite } from './infra';
import { Actor, Escaneo, RolDistribuido } from './contrato';
import { Rol } from '../usuarios/roles';
import { generarHashContrasena, verificarContrasena } from '../usuarios/contrasenas';

const jornada = 12 * 60 * 60;
const roles: RolDistribuido[] = [...Object.values(Rol), 'proveedor'];
const jwt = new JwtService({ secret: process.env.JWT_SECRET, signOptions: { algorithm: 'HS256', issuer: 'acme-usuarios' } });
const reloj = new JwtService({ secret: claveInterna, signOptions: { algorithm: 'HS256', issuer: 'acme-reloj' } });

export async function autenticar(autorizacion?: string, consultarRevocacion = true): Promise<Actor> {
  if (!autorizacion?.startsWith('Bearer ')) throw new UnauthorizedException('Se requiere un token Bearer');
  let datos: { sub: string; sid: string; rol: RolDistribuido; exp: number };
  try {
    datos = jwt.verify(autorizacion.slice(7), { algorithms: ['HS256'], issuer: 'acme-usuarios' });
    if (!datos.sub || !datos.sid || !roles.includes(datos.rol) || !Number.isFinite(datos.exp)) throw new Error();
  } catch { throw new UnauthorizedException('Token inválido o vencido'); }
  if (consultarRevocacion && await estaRevocada(datos.sid)) throw new UnauthorizedException('Sesión terminada');
  return { id: datos.sub, sesionId: datos.sid, rol: datos.rol, exp: datos.exp };
}

const revocadas = new Map<string, number>();
export async function estaRevocada(sesionId: string) {
  const local = revocadas.get(sesionId);
  if (local && local > Date.now()) return true;
  if (local) revocadas.delete(sesionId);
  try {
    const vencimiento = Number(await redisLimite(() => cache.get('revocada:' + sesionId)));
    if (vencimiento > Date.now()) {
      recordar(sesionId, vencimiento);
      return true;
    }
  } catch { /* El control síncrono decide entregas y correcciones si Redis está caído. */ }
  return false;
}

function recordar(sesionId: string, vence: number) {
  revocadas.set(sesionId, vence);
  const alarma = setTimeout(() => revocadas.delete(sesionId), Math.max(0, vence - Date.now()));
  alarma.unref();
}

function interpretarRevocacion(dato: unknown) {
  const evento = dato as { clave: string; id: string; vence: number };
  if (evento?.clave !== 'sesion.terminada' || !evento.id || !Number.isFinite(evento.vence)) {
    throw new MensajeInvalido('Evento de revocación inválido');
  }
  return evento;
}

export function revocarLocal(dato: unknown) {
  const evento = interpretarRevocacion(dato);
  if (evento.vence > Date.now() && !revocadas.has(evento.id)) recordar(evento.id, evento.vence);
}

export async function proyectarRevocacion(dato: unknown) {
  const evento = interpretarRevocacion(dato);
  const ttl = evento.vence - Date.now();
  if (ttl <= 0) return;
  await redisLimite(() => cache.set('revocada:' + evento.id, String(evento.vence), { PX: ttl }));
}

export async function verificarSesion(actor: Actor): Promise<'confirmado' | 'rechazado' | 'pendiente'> {
  try {
    const r = await interna('usuarios', '/interno/sesiones/' + actor.sesionId, {}, 1500);
    await r.body?.cancel();
    if (r.ok) return 'confirmado';
    if (r.status === 401) return 'rechazado';
  } catch { /* Se guarda la solicitud y se reconcilia desde el shard. */ }
  return 'pendiente';
}

export function crearAncla(actor: Actor) {
  const servidorMs = Date.now();
  return { servidorMs, ancla: reloj.sign({ sub: actor.id, servidorMs }, { noTimestamp: true }) };
}

export function horaEscaneo(escaneo: Escaneo, actor: Actor) {
  const ahora = Date.now();
  const { ancla, transcurridoMs, relojLocalMs } = escaneo;
  if (!ancla && transcurridoMs === undefined && relojLocalMs === undefined) {
    return { registradoEn: new Date(ahora).toISOString(), sospechoso: false };
  }
  try {
    const datos = reloj.verify<{ sub: string; servidorMs: number }>(ancla ?? '',
      { algorithms: ['HS256'], issuer: 'acme-reloj' });
    const calculado = datos.servidorMs + (transcurridoMs ?? NaN);
    if (datos.sub !== actor.id || !Number.isFinite(calculado) || transcurridoMs! < 0 || calculado > ahora + 10000) throw new Error();
    return {
      registradoEn: new Date(Math.min(calculado, ahora)).toISOString(),
      sospechoso: relojLocalMs === undefined || Math.abs(relojLocalMs - calculado) > 120000,
    };
  } catch {
    return { registradoEn: new Date(ahora).toISOString(), sospechoso: true };
  }
}

class Login {
  @IsEmail() @MaxLength(254) correo!: string;
  @IsString() @IsNotEmpty() @MaxLength(256) contrasena!: string;
}
class Registro extends Login {
  @MinLength(12) declare contrasena: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @IsNotEmpty() @MaxLength(200) nombre!: string;
}
class Cambio {
  @IsString() @IsNotEmpty() @MaxLength(256) actual!: string;
  @IsString() @MinLength(12) @MaxLength(256) nueva!: string;
}

@Injectable()
export class Sesiones {
  constructor(private readonly bases: Bases) {}

  private async operacion<T>(ejecutar: (tx: EntityManager) => Promise<T>) {
    const base = await this.bases.usuarios();
    return base.transaction(async tx => {
      await this.bases.verificarMayoria(tx);
      const valor = await ejecutar(tx);
      await tx.query('SET LOCAL statement_timeout = 0');
      return valor;
    });
  }

  async inicializarDemo() {
    const contrasena = process.env.DEMO_PASSWORD;
    if (!contrasena) return;
    const hash = generarHashContrasena(contrasena);
    for (;;) {
      try {
        await this.operacion(async tx => {
          for (const rol of roles) {
            await tx.query(`INSERT INTO usuarios VALUES ($1,$2,$3,$4,$5) ON CONFLICT (correo) DO NOTHING`,
              [randomUUID(), rol + '@acme.test', 'Demo ' + rol, hash, rol]);
          }
        });
        return;
      } catch (error) {
        console.warn('Usuarios demo:', (error as Error).message);
        await pausa(1200);
      }
    }
  }

  registrar(datos: Registro) {
    return this.operacion(async tx => {
      const id = randomUUID();
      const r = await tx.query(`INSERT INTO usuarios VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (correo) DO NOTHING RETURNING id`,
        [id, datos.correo.toLowerCase(), datos.nombre.trim(), generarHashContrasena(datos.contrasena), Rol.CLIENTE]);
      if (!r.length) throw new ConflictException('El correo ya está registrado');
      return { id, nombre: datos.nombre.trim(), rol: Rol.CLIENTE };
    });
  }

  async login(datos: Login) {
    const { usuario, sid, vence } = await this.operacion(async tx => {
      const [usuario] = await tx.query('SELECT * FROM usuarios WHERE correo=$1 FOR UPDATE', [datos.correo.toLowerCase()]);
      if (!usuario || !verificarContrasena(datos.contrasena, usuario.contrasenaHash)) {
        throw new UnauthorizedException('Correo o contraseña incorrectos');
      }
      const sid = randomUUID();
      const vence = Math.floor(Date.now() / 1000) + jornada;
      await tx.query('INSERT INTO sesiones VALUES ($1,$2,$3,NULL)', [sid, usuario.id, new Date(vence * 1000)]);
      return { usuario, sid, vence };
    });
    return {
      token: jwt.sign({ sub: usuario.id, sid, rol: usuario.rol, exp: vence }),
      venceEn: new Date(vence * 1000),
      usuario: { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol },
    };
  }

  verificar(id: string) {
    return this.operacion(async tx => {
      const [r] = await tx.query('SELECT "revocadaEn" FROM sesiones WHERE id=$1', [id]);
      if (!r || r.revocadaEn) throw new UnauthorizedException('Sesión terminada');
      return { vigente: true };
    });
  }

  async existeCliente(id: string) {
    return this.operacion(async tx => {
      const [r] = await tx.query("SELECT id FROM usuarios WHERE id=$1 AND rol='cliente'", [id]);
      return { existe: Boolean(r) };
    });
  }

  private async revocar(tx: EntityManager, campo: 'id' | '"usuarioId"', valor: string) {
    const [sesiones]: [{ id: string; venceEn: Date }[]] = await tx.query(
      `UPDATE sesiones SET "revocadaEn"=now() WHERE ${campo}=$1 AND "revocadaEn" IS NULL RETURNING id, "venceEn"`,
      [valor],
    );
    for (const sesion of sesiones) {
      await guardarEvento(tx, { id: sesion.id, clave: 'sesion.terminada', vence: sesion.venceEn.getTime() } as
        { id: string; clave: string; vence: number });
    }
  }

  logout(actor: Actor) {
    return this.operacion(async tx => {
      // Obtiene los bloqueos en el mismo orden que el cambio de contraseña.
      await tx.query('SELECT id FROM usuarios WHERE id=$1 FOR UPDATE', [actor.id]);
      await this.revocar(tx, 'id', actor.sesionId);
      return { mensaje: 'Sesión cerrada' };
    });
  }

  cambiar(actor: Actor, datos: Cambio) {
    return this.operacion(async tx => {
      const [usuario] = await tx.query('SELECT * FROM usuarios WHERE id=$1 FOR UPDATE', [actor.id]);
      const [sesion] = await tx.query('SELECT "revocadaEn" FROM sesiones WHERE id=$1 AND "usuarioId"=$2', [actor.sesionId, actor.id]);
      if (!usuario || !sesion || sesion.revocadaEn || !verificarContrasena(datos.actual, usuario.contrasenaHash)) {
        throw new UnauthorizedException('La sesión o la contraseña actual no es válida');
      }
      await tx.query('UPDATE usuarios SET "contrasenaHash"=$1 WHERE id=$2', [generarHashContrasena(datos.nueva), actor.id]);
      await this.revocar(tx, '"usuarioId"', actor.id);
      return { mensaje: 'Contraseña actualizada' };
    });
  }
}

@Controller()
export class SesionesApi {
  constructor(private readonly sesiones: Sesiones) {}

  @Post('api/v1/auth/registro')
  registro(@Body() datos: Registro) { return this.sesiones.registrar(datos); }

  @Post('api/v1/auth/login') @HttpCode(200)
  login(@Body() datos: Login) { return this.sesiones.login(datos); }

  @Post('api/v1/auth/logout') @HttpCode(200)
  async logout(@Headers('authorization') auth?: string) { return this.sesiones.logout(await autenticar(auth, false)); }

  @Post('api/v1/auth/contrasena') @HttpCode(200)
  async cambiar(@Body() datos: Cambio, @Headers('authorization') auth?: string) {
    return this.sesiones.cambiar(await autenticar(auth, false), datos);
  }

  @Get('interno/sesiones/:id')
  verificar(@Param('id') id: string, @Headers('x-acme-interna') clave?: string) {
    comprobarInterna(clave);
    return this.sesiones.verificar(id);
  }

  @Get('interno/clientes/:id')
  existe(@Param('id') id: string, @Headers('x-acme-interna') clave?: string) {
    comprobarInterna(clave);
    return this.sesiones.existeCliente(id);
  }
}
