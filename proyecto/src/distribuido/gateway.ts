import {
  All, Controller, Get, Injectable, NotFoundException, Req, Res, ServiceUnavailableException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { leerCache, respuestaVista } from '../monolito/consulta';
import { direccionesDe, puerto } from './infra';

export class CircuitoConsulta {
  private readonly historial: boolean[] = [];
  private abiertoHasta = 0;
  private probando = false;
  private generacion = 0;

  constructor(private readonly ahora = Date.now, private readonly azar = Math.random) {}

  entrar() {
    if (!this.abiertoHasta) return { generacion: this.generacion, prueba: false };
    if (this.ahora() < this.abiertoHasta || this.probando || this.azar() >= 0.05) return null;
    this.probando = true;
    return { generacion: this.generacion, prueba: true };
  }

  terminar(entrada: NonNullable<ReturnType<CircuitoConsulta['entrar']>>, fallo: boolean) {
    if (entrada.generacion !== this.generacion) return;
    if (entrada.prueba) {
      this.probando = false;
      if (!fallo) {
        this.abiertoHasta = 0;
        this.historial.length = 0;
        this.generacion++;
        return;
      }
    } else {
      this.historial.push(fallo);
      if (this.historial.length > 100) this.historial.shift();
      if (this.historial.length < 100 || this.historial.filter(Boolean).length < 50) return;
    }
    this.abiertoHasta = this.ahora() + 60000;
    this.generacion++;
  }

  estado() {
    const estado = !this.abiertoHasta ? 'cerrado' : this.ahora() < this.abiertoHasta ? 'abierto' : 'semiabierto';
    return { estado, muestras: this.historial.length, fallas: this.historial.filter(Boolean).length };
  }
}

const sonFallos = (status: number) => [500, 502, 504].includes(status);

@Injectable()
export class Gateway {
  readonly circuito = new CircuitoConsulta();
  private turno = 0;

  private enviar(host: string, req: Request, ms: number) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    return fetch('http://' + host + ':' + puerto + req.originalUrl, {
      method: req.method, headers, body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(ms), redirect: 'manual',
    });
  }

  private async consultar(req: Request) {
    const ips = await direccionesDe('monolito');
    if (!ips.length) throw new Error('DNS de Consulta sin direcciones');
    const inicio = this.turno++ % ips.length;
    for (let turno = 0; turno < ips.length; turno++) {
      try {
        const respuesta = await this.enviar(ips[(inicio + turno) % ips.length], req, 2000);
        if (!sonFallos(respuesta.status)) return { status: respuesta.status, cuerpo: await respuesta.text() };
        await respuesta.body?.cancel();
      } catch { /* Prueba la siguiente réplica resuelta por Docker. */ }
    }
    throw new Error('Ninguna réplica de Consulta respondió');
  }

  async tracking(req: Request, res: Response, guia: string, detalle: boolean) {
    const entrada = this.circuito.entrar();
    if (entrada) {
      try {
        const r = await this.consultar(req);
        this.circuito.terminar(entrada, false);
        res.status(r.status).type('json').send(r.cuerpo);
        return;
      } catch { this.circuito.terminar(entrada, true); }
    }
    const guardada = await leerCache(guia);
    if (!guardada) throw new ServiceUnavailableException('Consulta temporalmente no disponible');
    const vista = await respuestaVista(guardada, detalle, req.headers.authorization);
    res.status(200).json({ ...vista, desactualizado: true, aviso: 'Último estado conocido, puede estar desactualizado' });
  }

  async enrutar(req: Request, res: Response) {
    const { path, method } = req;
    const tracking = path.match(/^\/api\/v1\/tracking\/([A-Z0-9-]{6,40})(\/detalle)?$/);
    if (tracking && method === 'GET') return this.tracking(req, res, tracking[1], Boolean(tracking[2]));
    let destino: string;
    let timeout: number;
    if (method === 'POST' && /^\/api\/v1\/auth\/(login|logout|registro|contrasena)$/.test(path)) {
      destino = 'usuarios';
      timeout = 8000;
    } else if ((method === 'POST' && /^\/api\/v1\/movimientos\/(envios|escanear|sincronizar|[A-Z0-9-]{6,40}\/(direccion|caso|recuperar))$/.test(path)) ||
      (method === 'GET' && /^\/api\/v1\/movimientos\/(hora|[A-Z0-9-]{6,40}\/direccion)$/.test(path))) {
      destino = 'movimientos';
      timeout = 30000;
    } else throw new NotFoundException('La ruta no existe');
    try {
      const r = await this.enviar(destino, req, timeout);
      res.status(r.status).type('json').send(await r.text());
    } catch { throw new ServiceUnavailableException('Servicio temporalmente no disponible'); }
  }
}

@Controller()
export class GatewayApi {
  constructor(private readonly gateway: Gateway) {}

  @Get('health')
  salud() { return { servicio: 'gateway', instancia: process.env.HOSTNAME, consulta: this.gateway.circuito.estado() }; }

  @All('api/v1/{*ruta}')
  enrutar(@Req() req: Request, @Res() res: Response) { return this.gateway.enrutar(req, res); }
}

