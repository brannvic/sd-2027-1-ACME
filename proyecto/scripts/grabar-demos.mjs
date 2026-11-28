#!/usr/bin/env node
// Graba GIFs de pruebas reales: navegador del cliente, PWA del repartidor y terminales lado a lado.
// Uso: node scripts/grabar-demos.mjs [escenario ...]   (sin argumentos graba todos)
//      node scripts/grabar-demos.mjs --fallo GUIA DIAS_ATRAS HORA   (fixture de reloj para simular días)
import { chromium } from 'playwright';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as dormir } from 'node:timers/promises';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const origen = (process.env.ACME_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const contrasena = process.env.DEMO_PASSWORD ?? 'AcmeDemo2026!';
const claveInterna = process.env.CLAVE_INTERNA ?? 'acme-interna-demo-78fe00547abc';
const salidaGifs = join(raiz, 'docs', 'demos');
const FPS = 5;
const ANCHO = { cli: 420, rep: 420, term: 760 }, ALTO = 824, CAB = 76;
const shardDe = g => createHash('sha256').update(g).digest()[0] % 4;
const nuevaGuia = () => 'ACME-' + randomUUID().slice(0, 6).toUpperCase();

async function http(ruta, { datos, token } = {}) {
  const r = await fetch(origen + '/api/v1/' + ruta, {
    method: datos ? 'POST' : 'GET', signal: AbortSignal.timeout(32000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: datos ? JSON.stringify(datos) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function ok(ruta, opciones) {
  const r = await http(ruta, opciones);
  if (r.status >= 300) throw new Error(ruta + ' → ' + r.status + ' ' + JSON.stringify(r.json.message ?? r.json));
  return r.json;
}
async function hasta(prueba, segundos = 60) {
  const fin = Date.now() + segundos * 1000;
  for (;;) {
    try { const r = await prueba(); if (r !== false) return r; } catch (error) { if (Date.now() > fin) throw error; }
    if (Date.now() > fin) throw new Error('Tiempo agotado');
    await dormir(500);
  }
}
const login = rol => ok('auth/login', { datos: { correo: rol + '@acme.test', contrasena } });

// ---------- Fixture: tres días de reparto en segundos con anclas de hora firmadas ----------
if (process.argv[2] === '--fallo') {
  const [, , , guia, dias, hora] = process.argv;
  const rep = await login('repartidor');
  const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const reloj = minuto => {
    const t = new Date();
    t.setUTCDate(t.getUTCDate() - Number(dias));
    t.setUTCHours(Number(hora) + 6, minuto, 0, 0); // Ciudad de México, UTC-6
    const datos = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: rep.usuario.id, iss: 'acme-reloj', servidorMs: +t });
    const ancla = datos + '.' + createHmac('sha256', claveInterna).update(datos).digest('base64url');
    return { ancla, transcurridoMs: 0, relojLocalMs: +t, etiqueta: t.toISOString().slice(0, 10) + ' ' + String(hora).padStart(2, '0') + ':' + String(minuto).padStart(2, '0') };
  };
  for (const [tipo, minuto, extra] of [['salida_ruta', 0, {}], ['intento_fallido', 30, { motivo: 'Nadie en casa' }]]) {
    const { etiqueta, ...hora } = reloj(minuto);
    const r = await http('movimientos/escanear', { token: rep.token, datos: { id: randomUUID(), numeroGuia: guia, tipo, ...hora, ...extra } });
    console.log(etiqueta + '  ' + tipo.padEnd(16) + ' → HTTP ' + r.status + (extra.motivo ? '  motivo: ' + extra.motivo : '') + (r.status >= 300 ? '  ' + JSON.stringify(r.json.message) : ''));
    if (r.status >= 300) process.exit(1);
  }
  const dia = reloj(0).etiqueta.slice(0, 10);
  const d = await hasta(async () => {
    const x = await ok('movimientos/' + guia + '/direccion', { token: rep.token });
    return x.estado === 'en_sucursal' || x.plan?.fecha > dia ? x : false;
  }, 45);
  console.log(d.estado === 'en_sucursal' ? 'Reintentos → tercer día con intento fallido: pasa a sucursal'
    : 'Reintentos → nuevo intento ' + d.plan.fecha + ' en la franja de la ' + (d.plan.franja === 'manana' ? 'mañana (09–13 h)' : 'tarde (14–18 h)'));
  process.exit(0);
}

// ---------- Escenario visual ----------
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
function colorear(s) {
  let html = '', i = 0;
  for (const m of s.matchAll(/"(?:[^"\\]|\\.)*"(\s*:)?|\b-?\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b/g)) {
    html += esc(s.slice(i, m.index));
    html += '<span class=' + (m[1] ? 'k' : m[0][0] === '"' ? 's' : 'n') + '>' + esc(m[0]) + '</span>';
    i = m.index + m[0].length;
  }
  return html + esc(s.slice(i));
}
const primero = ['tipo', 'estado', 'registradoEn', 'confirmacion', 'sospechoso', 'motivo', 'receptor', 'ubicacion', 'direccionNueva'];
const ordenar = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) =>
  (primero.indexOf(a) + 1 || 99) - (primero.indexOf(b) + 1 || 99)));
// Vista condensada del JSON real (como jq -c por campo) para que quepa en la terminal.
function pintarJson(valor, ancho = 100) {
  const linea = (k, v, sangria) => {
    const prefijo = k === null ? '' : JSON.stringify(k) + ': ';
    let s = JSON.stringify(v && typeof v === 'object' && !Array.isArray(v) ? ordenar(v) : v);
    if (sangria + prefijo.length + s.length > ancho) s = s.slice(0, ancho - sangria - prefijo.length - 1) + '…';
    return ' '.repeat(sangria) + colorear(prefijo + s);
  };
  if (!valor || typeof valor !== 'object' || JSON.stringify(valor).length <= ancho) return linea(null, valor, 0);
  const filas = ['{'];
  for (const [k, v] of Object.entries(valor)) {
    if (Array.isArray(v) && v.some(x => x && typeof x === 'object')) {
      filas.push('  ' + colorear(JSON.stringify(k) + ': ['), ...v.map(x => linea(null, x, 4)), '  ]');
    } else filas.push(linea(k, v, 2));
  }
  return [...filas, '}'].join('\n');
}
function pintarSalida(texto) {
  const lineas = texto.replace(/\s+$/, '').split('\n');
  const codigo = /^HTTP (\d{3})$/.exec(lineas.at(-1) ?? '');
  if (codigo) lineas.pop();
  const cuerpo = lineas.join('\n');
  let html;
  try { html = cuerpo.trim() ? pintarJson(JSON.parse(cuerpo)) : ''; } catch { html = colorear(cuerpo); }
  if (codigo) {
    const n = Number(codigo[1]);
    html += (html ? '\n' : '') + '<b class=' + (n < 300 ? 'ok' : n < 500 ? 'wa' : 'ko') + '>HTTP ' + n + '</b>';
  }
  return html;
}

const rc = String.raw`
set -o pipefail
acme() { node distribuido/acme.mjs "$@"; }
api() { curl -s -X "$1" "$ACME_URL/api/v1/$2" ${'$'}{3:+-H "authorization: Bearer $3"} ${'$'}{4:+-H "content-type: application/json" --data-raw "$4"} -w '\nHTTP %{http_code}\n'; }
uuid() { node -e 'console.log(crypto.randomUUID())'; }
shard() { node -p "'$1 → shard' + require('crypto').createHash('sha256').update('$1').digest()[0] % 4"; }
`;

const monitor = String.raw`
const dns = require('dns').promises; const { Pool } = require('pg');
const pools = [0, 1, 2, 3].map(i => { const p = new Pool({ host: 'shard' + i, user: 'acme', database: 'acme',
  password: process.env.DB_PASSWORD, connectionTimeoutMillis: 700, max: 1 }); p.on('error', () => {}); return p; });
const get = (url, opciones = {}, ms = 800) => fetch(url, { ...opciones, signal: AbortSignal.timeout(ms) }).then(r => r.json());
const auth = { authorization: 'Basic ' + Buffer.from('acme:' + process.env.RABBIT_PASSWORD).toString('base64') };
async function ciclo() {
  const [gw, pg, colas, outbox] = await Promise.all([
    dns.lookup('gateway', { all: true }).then(ips => Promise.all(ips.map(x => get('http://' + x.address + ':8080/health').catch(() => null)))).catch(() => []),
    Promise.all([1, 2, 3].map(n => get('http://usuarios-pg' + n + ':8008/patroni', {}, 1500).then(r => ({ name: 'usuarios-pg' + n,
      role: r.role === 'primary' ? 'leader' : r.quorum_standby ? 'quorum_standby' : r.sync_standby ? 'sync_standby' : 'replica', state: r.state })).catch(() => null)))
      .then(x => x.filter(Boolean)),
    get('http://rabbit:15672/api/queues', { headers: auth }).then(q => q.map(x => ({ name: x.name, messages: x.messages ?? 0, consumers: x.consumers ?? 0 }))).catch(() => null),
    Promise.all(pools.map(p => p.query('SELECT count(*)::int AS n FROM outbox WHERE NOT publicado').then(r => r.rows[0].n).catch(() => null))),
  ]);
  process.stdout.write(JSON.stringify({ gw, pg, colas, outbox }) + '\n');
}
setInterval(ciclo, 1000); ciclo();
`;

const htmlCabecera = `<style>
body{margin:0;width:1600px;height:${CAB}px;background:#152a47;color:#fff;font:14px 'Segoe UI',system-ui,sans-serif;overflow:hidden}
.r1{height:44px;display:flex;align-items:center;gap:14px;padding:0 16px}
#t{font-weight:700;font-size:16px;white-space:nowrap}
#c{flex:1;color:#e2e8f0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
#c b{color:#fde68a;font-weight:600}
#c.fin{color:#bbf7d0;font-weight:700} #c.mal{color:#fecaca;font-weight:700}
#x{background:#f59e0b;color:#111;border-radius:999px;padding:2px 10px;font-weight:700;display:none}
.r2{height:32px;display:grid;grid-template-columns:${ANCHO.cli}px ${ANCHO.rep}px ${ANCHO.term}px;background:#0e1d33;font-size:12.5px;color:#bfdbfe}
.r2 div{display:flex;align-items:center;gap:6px;padding:0 12px;border-right:1px solid #1e3a5f}
.r2 span{color:#64748b}
</style><div class=r1><span id=t></span><span id=c></span><span id=x></span></div>
<div class=r2><div>🌐 Cliente <span>· navegador · localhost:8080</span></div><div>📱 Repartidor <span>· PWA · /?reparto</span></div>
<div>⌨️ Terminales <span>· comandos reales sobre el clúster de Docker Compose</span></div></div>`;

const htmlTerminal = `<style>
body{margin:0;background:#0b1020;font:12px/1.38 'Cascadia Mono',Consolas,monospace;color:#d6deeb;height:${ALTO}px;
display:grid;grid-template-rows:432px 150px 1fr;gap:4px;padding:4px;box-sizing:border-box;overflow:hidden}
.p{background:#0f172a;border:1px solid #1e293b;border-radius:6px;display:flex;flex-direction:column;overflow:hidden;min-height:0}
.b{background:#1e293b;color:#94a3b8;padding:3px 10px;font:600 11px 'Segoe UI',system-ui;display:flex;justify-content:space-between}
pre{margin:0;padding:5px 9px;flex:1;overflow:hidden;white-space:pre-wrap;word-break:break-all;min-height:0;font:inherit}
.ok{color:#4ade80}.ko{color:#f87171}.wa{color:#fbbf24}.di{color:#64748b}.k{color:#7dd3fc}.s{color:#a5d6a7}.n{color:#fcd34d}
#t2{font-size:11px}.pr{color:#c084fc}.cm{color:#7dd3fc}.v{display:block;margin:1px 0;font-weight:700}
</style>
<div class=p><div class=b><span>Terminal 1 · operador — bash</span><span>~/proyecto</span></div><pre id=t1></pre></div>
<div class=p><div class=b><span>Terminal 2 · watch -n1 estado del clúster</span><span id=hora></span></div><pre id=t2></pre></div>
<div class=p><div class=b><span>Terminal 3 · docker compose logs -f (servicios de aplicación)</span><span>solo registran errores</span></div><pre id=t3></pre></div>
<script>
window.put = (id, html, reemplazar) => {
  const e = document.getElementById(id);
  if (reemplazar) e.innerHTML = html; else e.insertAdjacentHTML('beforeend', html);
  if (e.childNodes.length > 1500) for (let i = 0; i < 500; i++) e.firstChild.remove();
  e.scrollTop = e.scrollHeight;
};
</script>`;

class Estudio {
  async abrir() {
    this.browser = await chromium.launch({ headless: true, executablePath: process.env.ACME_CHROMIUM_PATH });
    const pagina = async (ancho, alto) => (await this.browser.newContext({ viewport: { width: ancho, height: alto } })).newPage();
    this.cab = await pagina(1600, CAB);
    this.term = await pagina(ANCHO.term, ALTO);
    await this.cab.setContent(htmlCabecera);
    await this.term.setContent(htmlTerminal);
    this.rcArchivo = join(tmpdir(), 'acme-demos-rc.sh');
    writeFileSync(this.rcArchivo, rc);
    this.estadoDocker = new Map();
    this.idsDocker = new Map();
    this.monitorDatos = null;
    this.iniciarMonitor();
  }
  iniciarMonitor() {
    try { execFileSync('docker', ['rm', '-f', 'acme-demo-monitor'], { stdio: 'ignore' }); } catch { /* no existía */ }
    this.monitor = spawn('docker', ['run', '--rm', '--name', 'acme-demo-monitor',
      // La imagen hereda etiquetas de Compose: se sobrescriben para que no cuente como parte del proyecto.
      '--label', 'com.docker.compose.project=acme-demo', '--label', 'com.docker.compose.service=monitor', '--network', 'acme-distribuido_default',
      '-e', 'UV_THREADPOOL_SIZE=64', '-e', 'DB_PASSWORD=' + (process.env.DB_PASSWORD ?? 'acme_desarrollo'), '-e', 'RABBIT_PASSWORD=' + (process.env.RABBIT_PASSWORD ?? 'acme_broker'),
      '--entrypoint', 'node', 'acme-distribuido:local', '-e', monitor], { stdio: ['ignore', 'pipe', 'ignore'] });
    let resto = '';
    this.monitor.stdout.on('data', d => {
      const partes = (resto + d).split('\n');
      resto = partes.pop();
      for (const p of partes) try { this.monitorDatos = JSON.parse(p); } catch { /* línea parcial */ }
    });
    this.watch = setInterval(() => void this.pintarWatch().catch(() => undefined), 1000);
  }
  async pintarWatch() {
    const { stdout: salida } = await promisify(execFile)('docker', ['ps', '-a', '--filter', 'label=com.docker.compose.project=acme-distribuido', '--format',
      '{{.ID}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.compose.container-number"}}|{{.State}}']);
    for (const l of salida.trim().split('\n')) {
      const [id, servicio, numero, estado] = l.split('|');
      this.estadoDocker.set(servicio + '-' + numero, estado);
      this.idsDocker.set(id, servicio + '-' + numero);
    }
    const d = this.monitorDatos ?? {};
    const pt = n => this.estadoDocker.get(n) === 'running' ? '<span class=ok>●</span>' : '<span class=ko>●</span>';
    const grupo = (s, n) => s + ' ' + Array.from({ length: n }, (_, i) => pt(s + '-' + (i + 1))).join('');
    const vivo = s => this.estadoDocker.get(s) === 'running';
    const l1 = ['nginx', 'movimientos', 'usuarios', 'proyeccion', 'reintentos', 'revocaciones'].map(s => s + ' ' + pt(s + '-1'));
    const outbox = (d.outbox ?? []).map((n, i) => i + ':' + (n === null ? '<span class=ko>—</span>' : n > 0 ? '<span class=wa>' + n + '</span>' : n));
    const shards = [0, 1, 2, 3].map(i => i + pt('shard' + i + '-1')).join(' ');
    const roles = { leader: '<span class=pr>LÍDER</span>', quorum_standby: 'quórum', sync_standby: 'síncrona', replica: 'réplica' };
    const miembros = new Map((d.pg ?? []).map(m => [m.name, m]));
    const pgs = [1, 2, 3].map(i => {
      const m = miembros.get('usuarios-pg' + i);
      return 'pg' + i + pt('usuarios-pg' + i + '-1') + ' ' + (!vivo('usuarios-pg' + i + '-1') ? '<span class=ko>caído</span>' : m ? (roles[m.role] ?? m.role) : '<span class=wa>…</span>');
    });
    const mayoria = [1, 2, 3].filter(i => vivo('usuarios-pg' + i + '-1')).length;
    const colas = d.colas === null || !vivo('rabbit-1') ? '<span class=ko>broker inalcanzable</span>' : (d.colas ?? [])
      .filter(q => !q.name.startsWith('amq.') && !q.name.endsWith('.fallidos'))
      .map(q => q.name + ' ' + (q.messages ? '<span class=wa>' + q.messages + '</span>' : 0) + '/' + q.consumers).join(' · ') || '—';
    const gws = (d.gw ?? []).filter(Boolean).map(g => {
      const nombre = [...this.idsDocker].find(([id]) => g.instancia?.startsWith(id))?.[1] ?? g.instancia;
      const e = g.consulta.estado;
      return nombre + ' <span class=' + (e === 'cerrado' ? 'ok' : e === 'abierto' ? 'ko' : 'wa') + '>' + e + '</span> ' + g.consulta.fallas + '/' + g.consulta.muestras;
    });
    const filas = [
      grupo('gateway', 3) + '  ' + grupo('consulta', 3) + '  ' + l1.join('  '),
      'shards ' + shards + '   outbox sin publicar → ' + (outbox.join('  ') || '—'),
      'usuarios-pg ' + pgs.join('  ') + '  · mayoría ' + (mayoria >= 2 ? '<span class=ok>' : '<span class=ko>') + mayoria + '/3</span>  etcd ' +
        [1, 2, 3].map(i => pt('etcd' + i + '-1')).join(''),
      'rabbit ' + pt('rabbit-1') + ' colas msj/consumidores: ' + colas,
      'breaker→Consulta: ' + (gws.join(' · ') || '<span class=ko>sin gateways</span>'),
      'redis ' + pt('redis-1') + '  mongo-consulta ' + pt('mongo-consulta-1') + '  mongo-reintentos ' + pt('mongo-reintentos-1'),
    ];
    await this.term.evaluate(([html, hora]) => { window.put('t2', html, true); document.getElementById('hora').textContent = hora; },
      [filas.join('\n'), new Date().toLocaleTimeString('es-MX', { hour12: false })]);
  }
  iniciarLogs() {
    this.logs?.kill();
    this.logs = spawn('docker', ['compose', 'logs', '-f', '--no-color', '--timestamps', '--tail', '0', 'gateway', 'consulta', 'movimientos',
      'usuarios', 'proyeccion', 'reintentos', 'revocaciones'], { cwd: raiz, stdio: ['ignore', 'pipe', 'pipe'] });
    let resto = '';
    const vistas = new Set();
    const leer = d => {
      const partes = (resto + d).split('\n');
      resto = partes.pop();
      const html = partes.map(l => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').trim())
        .filter(l => l && !vistas.has(l) && vistas.add(l)).map(l => {
          const m = /^(\S+)\s+\|\s?(\d{4}-\d\d-\d\dT\S+)\s(.*)$/.exec(l);
          if (!m) return '<span class=di>' + esc(l.slice(0, 150)) + '</span>';
          const hora = new Date(m[2]).toLocaleTimeString('es-MX', { hour12: false });
          return '<span class=di>' + esc(hora) + '</span> <span class=cm>' + esc(m[1]) + '</span> ' + esc(m[3].slice(0, 150));
        }).join('\n');
      if (html) void this.term.evaluate(h => window.put('t3', h + '\n'), html).catch(() => undefined);
    };
    this.logs.stdout.on('data', leer);
  }
  async nuevaEscena(nombre, titulo) {
    this.nombre = nombre;
    this.resultados = [];
    this.dir = mkdtempSync(join(tmpdir(), 'acme-gif-'));
    this.ctxCli = await this.browser.newContext({ viewport: { width: ANCHO.cli, height: ALTO }, locale: 'es-MX', timezoneId: 'America/Mexico_City' });
    this.ctxRep = await this.browser.newContext({ viewport: { width: ANCHO.rep, height: ALTO }, locale: 'es-MX', timezoneId: 'America/Mexico_City' });
    this.cli = await this.ctxCli.newPage();
    this.rep = await this.ctxRep.newPage();
    for (const p of [this.cli, this.rep]) p.setDefaultTimeout(20000);
    await this.cli.goto(origen + '/');
    await this.rep.goto(origen + '/?reparto');
    await this.term.evaluate(() => { for (const id of ['t1', 't3']) window.put(id, '', true); });
    await this.cab.evaluate(t => {
      document.getElementById('t').textContent = t;
      const c = document.getElementById('c');
      c.className = ''; c.textContent = '';
    }, titulo);
    this.vars = { ACME_URL: origen, ACME_CONTRASENA: contrasena };
    this.iniciarLogs();
    await this.calentarBreakers();
  }
  // Un breaker semiabierto solo se cierra con tráfico (5 % de prueba): se calienta antes de grabar.
  async calentarBreakers() {
    this.guiaCalentar ??= await crearGuia();
    await hasta(async () => {
      await Promise.all(Array.from({ length: 30 }, () => http('tracking/' + this.guiaCalentar)));
      const gw = (this.monitorDatos?.gw ?? []).filter(Boolean);
      return gw.length === 3 && gw.every(x => x.consulta.estado === 'cerrado');
    }, 180);
  }
  grabar() {
    this.cuadros = 0;
    this.saltar = 1;
    this.grabando = true;
    // Con Docker ocupado las capturas pueden ir por debajo de FPS: se mide la tasa real para reproducir a velocidad real.
    this.normales = 0;
    this.msNormales = 0;
    this.captura = (async () => {
      for (let tick = 0; this.grabando; tick++) {
        const inicio = Date.now(), normal = this.saltar === 1;
        if (tick % this.saltar === 0) {
          const n = String(this.cuadros++).padStart(5, '0');
          await Promise.all([this.cab, this.cli, this.rep, this.term].map((p, k) =>
            p.screenshot({ path: join(this.dir, k + '_' + n + '.png') }).catch(() => undefined)));
        }
        await dormir(Math.max(0, 1000 / FPS - (Date.now() - inicio)));
        if (normal) { this.normales++; this.msNormales += Date.now() - inicio; }
      }
    })();
  }
  async terminar() {
    const total = this.resultados.length, bien = this.resultados.filter(r => r.ok).length;
    await this.cab.evaluate(([texto, todo]) => {
      const c = document.getElementById('c');
      c.className = todo ? 'fin' : 'mal';
      c.textContent = texto;
    }, [(bien === total ? '✓ ' : '✗ ') + bien + ' de ' + total + ' verificaciones del PRD superadas', bien === total]);
    await dormir(4000);
    this.grabando = false;
    await this.captura;
    this.logs?.kill();
    mkdirSync(salidaGifs, { recursive: true });
    const gif = join(salidaGifs, this.nombre + '.gif');
    const fps = Math.min(FPS, Math.max(1, this.normales / (this.msNormales / 1000))).toFixed(2);
    const entradas = [0, 1, 2, 3].flatMap(k => ['-framerate', fps, '-i', join(this.dir, k + '_%05d.png')]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...entradas, '-filter_complex',
      '[1][2][3]hstack=inputs=3[f];[0][f]vstack=inputs=2,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];' +
      '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', gif]);
    rmSync(this.dir, { recursive: true, force: true });
    await this.ctxCli.close();
    await this.ctxRep.close();
    console.log((bien === total ? '✓ ' : '✗ ') + this.nombre + ': ' + bien + '/' + total + ' → ' + gif + ' (' + fps + ' fps de captura)');
    for (const r of this.resultados) console.log('   ' + (r.ok ? '✓' : '✗') + ' ' + r.texto + (r.detalle ? ' — ' + r.detalle : ''));
    return { nombre: this.nombre, resultados: this.resultados };
  }
  async cerrar() {
    clearInterval(this.watch);
    this.monitor?.kill();
    try { execFileSync('docker', ['rm', '-f', 'acme-demo-monitor'], { stdio: 'ignore' }); } catch { /* ya terminó */ }
    this.logs?.kill();
    await this.browser?.close();
  }

  // --- acciones visibles ---
  async paso(html) {
    await this.cab.evaluate(h => { document.getElementById('c').innerHTML = h; }, html);
    await dormir(900);
  }
  async t1(html) { await this.term.evaluate(h => window.put('t1', h), html); }
  async nota(texto) { await this.t1('<span class=di># ' + esc(texto) + '</span>\n'); }
  async acelerar(factor, fn) {
    this.saltar = factor;
    await this.cab.evaluate(f => { const x = document.getElementById('x'); x.textContent = '⏩ ×' + f; x.style.display = 'inline'; }, factor);
    try { return await fn(); } finally {
      this.saltar = 1;
      await this.cab.evaluate(() => { document.getElementById('x').style.display = 'none'; });
    }
  }
  async teclearComando(cmd) {
    await this.t1('<span class=ok>acme@demo</span>:<span class=k>~/proyecto</span>$ ');
    const paso = Math.max(6, Math.ceil(cmd.length / 40));
    for (let i = 0; i < cmd.length; i += paso) {
      await this.t1(esc(cmd.slice(i, i + paso)));
      await dormir(70);
    }
    await this.t1('\n');
    await dormir(250);
  }
  // Ejecuta en bash el comando que se teclea en pantalla. modo 'flujo' muestra líneas en vivo.
  async comando(cmd, { modo = 'bloque', hastaQue, maxSeg = 120 } = {}) {
    await this.teclearComando(cmd);
    const hijo = spawn('bash', ['-c', 'source "' + this.rcArchivo.replaceAll('\\', '/') + '"; ' + cmd], {
      cwd: raiz, env: { ...process.env, ...this.vars, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let salida = '', errores = '';
    hijo.stdout.on('data', d => {
      salida += d;
      if (modo === 'flujo') void this.t1(esc(String(d)));
    });
    hijo.stderr.on('data', d => {
      errores += d;
      if (modo === 'flujo') void this.t1('<span class=di>' + esc(String(d)) + '</span>');
    });
    const fin = new Promise(resolve => hijo.on('close', resolve));
    let cortado = false;
    if (hastaQue) {
      const limite = Date.now() + maxSeg * 1000;
      while (hijo.exitCode === null && Date.now() < limite) {
        if (await hastaQue(salida).catch(() => false)) break;
        await dormir(400);
      }
      if (hijo.exitCode === null) { cortado = true; hijo.kill(); }
    }
    const codigo = await fin;
    if (modo !== 'flujo') {
      const html = pintarSalida(salida);
      if (html) await this.t1(html + '\n');
      if (errores.trim()) await this.t1('<span class=ko>' + esc(errores.trim()) + '</span>\n');
    }
    if (cortado) await this.t1('^C\n');
    await dormir(700);
    return { salida, errores, codigo };
  }
  async verificar(texto, prueba, segundos = 0) {
    let bien = false, detalle = '';
    const fin = Date.now() + segundos * 1000;
    for (;;) {
      try { if (await prueba() !== false) { bien = true; break; } detalle = 'condición no cumplida'; }
      catch (error) { detalle = error.message.split('\n')[0]; }
      if (Date.now() >= fin) break;
      await dormir(600);
    }
    this.resultados.push({ texto, ok: bien, detalle: bien ? '' : detalle });
    await this.t1('<span class="v ' + (bien ? 'ok' : 'ko') + '">' + (bien ? '✓ ' : '✗ ') + esc(texto) + (bien ? '' : ' — ' + esc(detalle)) + '</span>');
    await dormir(1200);
    return bien;
  }
}

// --- acciones en el navegador ---
async function resaltar(loc) {
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  await loc.evaluate(e => { e.style.outline = '3px solid #f59e0b'; e.style.outlineOffset = '2px'; }).catch(() => undefined);
  await dormir(450);
}
async function clic(loc) {
  await resaltar(loc);
  const elemento = await loc.elementHandle(); // el texto del botón puede cambiar tras el clic
  await loc.click();
  await dormir(300);
  await elemento?.evaluate(e => { e.style.outline = ''; }).catch(() => undefined);
}
async function teclear(loc, texto) {
  await resaltar(loc);
  await loc.fill('');
  await loc.pressSequentially(texto, { delay: 30 });
  await loc.evaluate(e => { e.style.outline = ''; }).catch(() => undefined);
}
const boton = (p, nombre) => p.getByRole('button', { name: nombre, exact: true });
const campo = (p, nombre) => p.getByLabel(nombre); // el <select> va dentro de su <label>: su nombre incluye las opciones
async function entrar(p, rol, visible = true) {
  if (await boton(p, 'Iniciar sesión').isVisible()) await (visible ? clic : x => x.click())(boton(p, 'Iniciar sesión'));
  const f = visible ? teclear : (loc, t) => loc.fill(t);
  await f(campo(p, 'Correo'), rol + '@acme.test');
  await f(campo(p, 'Contraseña'), contrasena);
  await (visible ? clic : x => x.click())(boton(p, 'Entrar'));
}
async function prepararRepartidor(p, pin = '1234') {
  await entrar(p, 'repartidor', false);
  await campo(p, 'PIN de cuatro dígitos').fill(pin);
  await Promise.all([
    p.waitForResponse(r => r.url().endsWith('/movimientos/hora') && r.ok()),
    boton(p, 'Guardar PIN').click(),
  ]);
  await p.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });
}
const textoVisible = (p, texto) => p.getByText(texto, { exact: false }).first().isVisible();
const cola = p => p.evaluate(() => new Promise((resolve, reject) => {
  const abrir = indexedDB.open('acme-reparto');
  abrir.onerror = () => reject(abrir.error);
  abrir.onsuccess = () => {
    const s = abrir.result.transaction('cola', 'readonly').objectStore('cola').getAll();
    s.onsuccess = () => { resolve(s.result); abrir.result.close(); };
    s.onerror = () => reject(s.error);
  };
}));

// --- datos de preparación (no se graban) ---
let sesiones;
async function tokens() {
  sesiones ??= Object.fromEntries(await hasta(() => Promise.all(['cliente', 'repartidor', 'almacenista', 'proveedor', 'administrador']
    .map(async rol => [rol, await login(rol)])), 120));
  return sesiones;
}
async function crearGuia({ hastaEstado = 'centro', guia = nuevaGuia(), direccion = 'Av. Reforma 222, Juárez, CDMX' } = {}) {
  const s = await tokens();
  await ok('movimientos/envios', { token: s.proveedor.token, datos: { numeroGuia: guia, clienteId: s.cliente.usuario.id, destinatario: 'Ana Pérez', direccion } });
  const pasos = { creado: [], almacen: ['ingreso_almacen'], centro: ['ingreso_almacen', 'ingreso_centro_distribucion'] }[hastaEstado];
  for (const tipo of pasos) {
    await ok('movimientos/escanear', { token: s.almacenista.token, datos: { id: randomUUID(), numeroGuia: guia, tipo, ubicacion: tipo === 'ingreso_almacen' ? 'Almacén Vallejo' : 'Centro Iztapalapa' } });
  }
  await hasta(async () => (await http('tracking/' + guia)).status === 200 || false, 30);
  return guia;
}
const guiaEnShard = (s, distinto = false) => { for (;;) { const g = nuevaGuia(); if ((shardDe(g) === s) !== distinto) return g; } };
async function varsSesion(estudio) {
  const s = await tokens();
  Object.assign(estudio.vars, {
    TOK_CLIENTE: s.cliente.token, TOK_REP: s.repartidor.token, TOK_ALM: s.almacenista.token, TOK_ADMIN: s.administrador.token,
    CLIENTE_ID: s.cliente.usuario.id,
  });
}
const docker = (...args) => execFileSync('docker', ['compose', ...args], { cwd: raiz, stdio: 'ignore' });
const restaurar = () => { try { docker('start'); } catch { /* algún servicio sin contenedores detenidos */ } };

// ============================ Escenarios ============================
const escenarios = {
  async '01-flujo-completo'(e) {
    await e.nuevaEscena('01-flujo-completo', '01 · Happy path: de la orden a la entrega');
    await varsSesion(e);
    await prepararRepartidor(e.rep);
    const G = nuevaGuia();
    e.vars.G = G;
    e.grabar();
    await e.paso('<b>F1</b> El proveedor confirma la orden → se crea el envío en Movimientos');
    await e.nota('Tokens obtenidos antes con POST /auth/login: $TOK_CLIENTE, $TOK_REP, $TOK_ALM, …');
    await e.comando('ACME_CORREO=proveedor@acme.test acme envio ' + G + ' $CLIENTE_ID "Ana Pérez" "Av. Reforma 222, Juárez, CDMX"');
    await e.paso('<b>§2</b> Movimientos reparte por hash del número de guía: este paquete vive en un solo shard');
    await e.comando('shard ' + G);
    await e.paso('<b>F1</b> El almacenista registra almacén y centro de distribución con la CLI');
    await e.comando('ACME_CORREO=almacenista@acme.test acme almacen ' + G + ' "Almacén Vallejo"');
    await e.comando('ACME_CORREO=almacenista@acme.test acme centro ' + G + ' "Centro Iztapalapa"');
    await e.paso('<b>F3.1</b> Vista ligera sin sesión: línea de tiempo sin nombre ni dirección');
    await teclear(campo(e.cli, 'Número de guía'), G);
    await clic(boton(e.cli, 'Rastrear'));
    await e.verificar('F3.1 Vista ligera muestra la línea de tiempo sin nombre ni dirección', async () => {
      await clic(boton(e.cli, 'Rastrear'));
      return await textoVisible(e.cli, 'Ingreso a centro de distribución') && !(await textoVisible(e.cli, 'Ana Pérez'));
    }, 20);
    await e.paso('<b>F3.3</b> El titular inicia sesión → vista detallada con destinatario y dirección');
    await entrar(e.cli, 'cliente');
    await teclear(campo(e.cli, 'Número de guía'), G);
    await clic(boton(e.cli, 'Ver detalle'));
    await e.verificar('F3.3 El titular ve el detalle completo', () => textoVisible(e.cli, 'Av. Reforma 222'), 10);
    await e.paso('<b>F3.4</b> Corrige la dirección antes de "salida a ruta": se acepta y se registra como movimiento');
    await teclear(campo(e.cli, 'Nueva dirección'), 'Av. Insurgentes Sur 1602, Crédito Constructor, CDMX');
    await clic(boton(e.cli, 'Corregir dirección'));
    await e.verificar('F3.4 Corrección aceptada antes de salir a ruta', () => textoVisible(e.cli, 'Dirección actualizada'), 10);
    await e.paso('<b>F3.5</b> Propagación: la PWA del repartidor ya recibe la dirección nueva');
    await teclear(campo(e.rep, 'Número de guía'), G);
    await clic(boton(e.rep, 'Consultar dirección'));
    await e.verificar('F3.5 El repartidor recibe la dirección corregida', () => textoVisible(e.rep, 'Insurgentes Sur 1602'), 10);
    await e.paso('<b>F1</b> El repartidor registra "Salida a ruta" desde la PWA');
    await campo(e.rep, 'Tipo de movimiento').selectOption('salida_ruta');
    await clic(boton(e.rep, 'Guardar escaneo'));
    await hasta(async () => (await cola(e.rep)).length === 0, 20);
    await e.paso('<b>F1.6</b> "Entregado" es terminal y exige indicar quién recibió');
    await campo(e.rep, 'Tipo de movimiento').selectOption('entregado');
    await dormir(500);
    await teclear(campo(e.rep, 'Quién recibió'), 'Ana Pérez (titular)');
    await clic(boton(e.rep, 'Guardar escaneo'));
    await e.verificar('F1.3 La cola de la PWA se vacía: el servidor confirmó cada UUID', async () => (await cola(e.rep)).length === 0, 20);
    await e.paso('<b>§7</b> Outbox → RabbitMQ → Proyección: el cliente ve el estado final en su línea de tiempo');
    await e.verificar('F1 El cliente ve "Entregado" y quién recibió', async () => {
      await clic(boton(e.cli, 'Ver detalle'));
      return textoVisible(e.cli, 'Ana Pérez (titular)');
    }, 30);
    await e.cli.getByText('Ana Pérez (titular)').scrollIntoViewIfNeeded();
    await e.paso('<b>F3.4</b> Una corrección después de salir a ruta se rechaza');
    const r = await e.comando('api POST movimientos/' + G + '/direccion "$TOK_CLIENTE" \'{"id":"\'$(uuid)\'","direccion":"Calle tardía 9"}\'');
    await e.verificar('F3.4 Corrección tras "salida a ruta" → 409', () => /HTTP 409/.test(r.salida));
    await e.paso('<b>F3.1</b> La vista pública sigue sin exponer nombre ni dirección');
    const p = await e.comando('api GET tracking/' + G);
    await e.verificar('F3.1 Respuesta pública solo trae estado e historial', () => {
      const json = JSON.parse(p.salida.split('\nHTTP')[0]);
      return json.estado === 'entregado' && !('direccion' in json) && !('destinatario' in json);
    });
    return e.terminar();
  },

  async '02-errores-validacion'(e) {
    await e.nuevaEscena('02-errores-validacion', '02 · Errores: token, permisos, validación e idempotencia');
    await varsSesion(e);
    const G = await crearGuia();
    e.vars.G = G;
    const correo = 'otro-' + randomUUID().slice(0, 8) + '@acme.test';
    await ok('auth/registro', { datos: { correo, nombre: 'Otro cliente', contrasena: 'Otro-Cliente-2026!' } });
    e.vars.TOK_OTRO = (await ok('auth/login', { datos: { correo, contrasena: 'Otro-Cliente-2026!' } })).token;
    await clic(boton(e.cli, 'Iniciar sesión'));
    await campo(e.cli, 'Correo').fill(correo);
    await campo(e.cli, 'Contraseña').fill('Otro-Cliente-2026!');
    await boton(e.cli, 'Entrar').click();
    await campo(e.cli, 'Número de guía').waitFor();
    await prepararRepartidor(e.rep);
    await e.rep.reload();
    await campo(e.rep, 'PIN de cuatro dígitos').waitFor();
    e.grabar();
    await e.paso('<b>F3.1</b> Guía inexistente → 404');
    await teclear(campo(e.cli, 'Número de guía'), 'ACME-NO-EXISTE');
    await clic(boton(e.cli, 'Rastrear'));
    const r404 = await e.comando('api GET tracking/ACME-NO-EXISTE');
    await e.verificar('F3.1 Guía inexistente → 404', () => /HTTP 404/.test(r404.salida));
    await e.paso('<b>F3.3</b> Un cliente con sesión que no es el titular pide el detalle → 403');
    await teclear(campo(e.cli, 'Número de guía'), G);
    const [detalle] = await Promise.all([e.cli.waitForResponse(r => r.url().endsWith('/detalle')), clic(boton(e.cli, 'Ver detalle'))]);
    const r403 = await e.comando('api GET tracking/' + G + '/detalle "$TOK_OTRO"');
    await e.verificar('F3.3 Quien no es titular recibe 403 (web y API)', async () => detalle.status() === 403 &&
      /HTTP 403/.test(r403.salida) && !(await textoVisible(e.cli, 'Ana Pérez')));
    await e.paso('<b>F1.1</b> Escaneo sin token o con token falso → 401');
    const sin = await e.comando('api POST movimientos/escanear "" \'{"id":"\'$(uuid)\'","numeroGuia":"' + G + '","tipo":"salida_ruta"}\'');
    const falso = await e.comando('api POST movimientos/escanear "token-falso" \'{"id":"\'$(uuid)\'","numeroGuia":"' + G + '","tipo":"salida_ruta"}\'');
    await e.verificar('F1.1 Sin token y con token falso → 401', () => /HTTP 401/.test(sin.salida) && /HTTP 401/.test(falso.salida));
    await e.paso('<b>F1.6</b> "Entregado" sin indicar quién recibió → 400');
    const r400 = await e.comando('api POST movimientos/escanear "$TOK_REP" \'{"id":"\'$(uuid)\'","numeroGuia":"' + G + '","tipo":"entregado"}\'');
    await e.verificar('F1.6 Entregado sin receptor → 400', () => /HTTP 400/.test(r400.salida));
    await e.paso('<b>F1.2</b> Idempotencia: el mismo UUID dos veces → 200 y no se crea otro registro');
    e.vars.U = randomUUID();
    await e.comando('export U=' + e.vars.U + '   # UUID generado en el celular');
    const cuerpo = '\'{"id":"\'$U\'","numeroGuia":"' + G + '","tipo":"salida_ruta"}\'';
    const a = await e.comando('api POST movimientos/escanear "$TOK_REP" ' + cuerpo);
    const b = await e.comando('api POST movimientos/escanear "$TOK_REP" ' + cuerpo);
    await e.verificar('F1.2 Segundo envío → 200 con duplicado:true', () => /"duplicado":\s*false/.test(a.salida) && /"duplicado":\s*true/.test(b.salida) && /HTTP 200/.test(b.salida));
    await e.verificar('F1.2 La línea de tiempo tiene una sola "salida a ruta"', async () =>
      (await ok('tracking/' + G)).historial.filter(m => m.tipo === 'salida_ruta').length === 1, 15);
    await e.paso('<b>§4</b> Un movimiento que no corresponde al estado actual se rechaza');
    const r409 = await e.comando('api POST movimientos/escanear "$TOK_REP" \'{"id":"\'$(uuid)\'","numeroGuia":"' + G + '","tipo":"salida_ruta"}\'');
    await e.verificar('§4 "Salida a ruta" con otro UUID estando en reparto → 409', () => /HTTP 409/.test(r409.salida));
    await e.paso('<b>§7</b> PIN local: si no coincide, la PWA se bloquea aunque el token siga vigente');
    await teclear(campo(e.rep, 'PIN de cuatro dígitos'), '9999');
    await clic(boton(e.rep, 'Desbloquear'));
    await e.verificar('§7 PIN incorrecto bloquea la PWA', () => textoVisible(e.rep, 'PIN incorrecto'), 5);
    await teclear(campo(e.rep, 'PIN de cuatro dígitos'), '1234');
    await clic(boton(e.rep, 'Desbloquear'));
    await e.verificar('§7 Con el PIN correcto se desbloquea', () => boton(e.rep, 'Guardar escaneo').isVisible(), 5);
    return e.terminar();
  },

  async '03-offline-pwa'(e) {
    await e.nuevaEscena('03-offline-pwa', '03 · Repartidor sin conexión: cola local, lote al reconectar y hora confiable');
    await varsSesion(e);
    const G = await crearGuia();
    e.vars.G = G;
    await entrar(e.cli, 'cliente', false);
    await campo(e.cli, 'Número de guía').fill(G);
    await boton(e.cli, 'Ver detalle').click();
    await prepararRepartidor(e.rep);
    await campo(e.rep, 'Número de guía').fill(G);
    await boton(e.rep, 'Consultar dirección').click();
    await e.rep.getByText('Av. Reforma 222').waitFor();
    e.rep.on('request', r => { if (r.url().includes('/sincronizar')) void e.nota('PWA → POST /api/v1/movimientos/sincronizar (' + (JSON.parse(r.postData() ?? '{}').escaneos?.length ?? '?') + ' escaneos en un lote)'); });
    e.rep.on('response', r => { if (r.url().includes('/sincronizar')) void e.nota('PWA ← HTTP ' + r.status() + ' con resultado por UUID'); });
    e.grabar();
    await e.paso('<b>§2.4</b> El repartidor pierde la señal en la última milla');
    await e.ctxRep.setOffline(true);
    await e.nota('Red del celular desactivada (Chromium DevTools · offline)');
    await e.paso('<b>F1.3</b> Recarga la PWA sin red: el service worker sirve la app y pide el PIN local');
    await e.rep.reload({ waitUntil: 'domcontentloaded' });
    await teclear(campo(e.rep, 'PIN de cuatro dígitos'), '1234');
    await clic(boton(e.rep, 'Desbloquear'));
    await teclear(campo(e.rep, 'Número de guía'), G);
    await clic(boton(e.rep, 'Consultar dirección'));
    await e.verificar('F1.3 Sin red, la PWA muestra la dirección guardada en IndexedDB', () => textoVisible(e.rep, 'Av. Reforma 222'), 10);
    await e.paso('<b>F1.3</b> Registra salida a ruta y entrega: se guardan en el dispositivo');
    await campo(e.rep, 'Tipo de movimiento').selectOption('salida_ruta');
    await clic(boton(e.rep, 'Guardar escaneo'));
    await dormir(800);
    await campo(e.rep, 'Tipo de movimiento').selectOption('entregado');
    await teclear(campo(e.rep, 'Quién recibió'), 'Vecino del 3B');
    await clic(boton(e.rep, 'Guardar escaneo'));
    await e.verificar('F1.3 Dos escaneos esperan en la cola local', async () => (await cola(e.rep)).length === 2, 10);
    const lote = (await cola(e.rep)).map(x => x.escaneo);
    const archivo = join(tmpdir(), 'acme-lote-pwa.json');
    writeFileSync(archivo, JSON.stringify({ escaneos: lote }));
    e.vars.LOTE = archivo.replaceAll('\\', '/');
    await e.paso('<b>§4</b> Mientras tanto el servidor no sabe nada: el estado llega atrasado, pero nunca ambiguo');
    await e.comando('api GET tracking/' + G + ' | grep -oE \'"estado":"[a-z_]+"|HTTP [0-9]+\'');
    await clic(boton(e.cli, 'Ver detalle'));
    await e.paso('<b>F1.3</b> Vuelve la señal → la cola se envía en un solo lote');
    await e.ctxRep.setOffline(false);
    await e.nota('Red del celular restablecida');
    await e.verificar('F1.3 La cola se vacía al reconectar', async () => (await cola(e.rep)).length === 0, 30);
    await e.verificar('F1.3 El cliente ve la entrega en su línea de tiempo', async () => {
      await clic(boton(e.cli, 'Ver detalle'));
      return textoVisible(e.cli, 'Vecino del 3B');
    }, 30);
    await e.paso('<b>F1.5</b> Se recargó sin red: la hora sale del ancla del servidor + cronómetro y se marca para revisión');
    await e.verificar('F1.5 La entrega queda marcada "Hora del dispositivo sin verificar"', () => textoVisible(e.cli, 'Hora del dispositivo sin verificar'), 10);
    await e.paso('<b>F1.2</b> Reenviar el mismo lote (mismos UUID) no duplica');
    const d = await e.comando('api POST movimientos/sincronizar "$TOK_REP" "$(cat $LOTE)"');
    await e.verificar('F1.2 Reenvío del lote → todos duplicado:true', () => (d.salida.match(/"duplicado":true/g) ?? []).length === 2);
    return e.terminar();
  },

  async '04-respuesta-perdida'(e) {
    await e.nuevaEscena('04-respuesta-perdida', '04 · Respuesta perdida: reintentos 2/4/8 s con jitter, espera de red y sin duplicados');
    await varsSesion(e);
    const G = await crearGuia();
    e.vars.G = G;
    await entrar(e.cli, 'cliente', false);
    await campo(e.cli, 'Número de guía').fill(G);
    await boton(e.cli, 'Ver detalle').click();
    await prepararRepartidor(e.rep);
    await campo(e.rep, 'Número de guía').fill(G);
    await boton(e.rep, 'Consultar dirección').click();
    await e.rep.getByText('Av. Reforma 222').waitFor();
    const intentos = [];
    let perder = true;
    await e.rep.route('**/api/v1/movimientos/sincronizar', async ruta => {
      if (!perder) return ruta.continue();
      intentos.push(Date.now());
      const r = await ruta.fetch();
      const n = intentos.length;
      void e.t1('<span class=wa>[red] intento ' + n + (n > 1 ? ' (+' + ((intentos[n - 1] - intentos[n - 2]) / 1000).toFixed(1) + ' s)' : '') +
        ' · el servidor respondió ' + r.status() + ' pero la respuesta se pierde</span>\n');
      await ruta.abort('failed');
    });
    e.grabar();
    await e.paso('<b>F1.4</b> Simulamos una red que entrega la petición pero pierde la respuesta');
    await e.nota('Proxy de Playwright: reenvía al servidor real y descarta la respuesta');
    await campo(e.rep, 'Tipo de movimiento').selectOption('salida_ruta');
    await clic(boton(e.rep, 'Guardar escaneo'));
    await e.paso('<b>F1.4</b> La PWA reintenta a los 2, 4 y 8 s con jitter, conservando el mismo UUID');
    await e.verificar('F1.4 Tras 3 reintentos espera a que cambie la red', () => textoVisible(e.rep, 'La sincronización se reanudará cuando cambie la red'), 30);
    await e.verificar('F1.4 Esperas crecientes ≈2/4/8 s', () => intentos.length === 4 &&
      [1, 2, 3].every(i => intentos[i] - intentos[i - 1] >= 2000 * 2 ** (i - 1) * 0.8 - 150));
    await e.paso('El servidor sí guardó el movimiento desde el primer intento');
    await e.comando('api GET tracking/' + G + ' | grep -o \'"tipo":"[a-z_]*"\'');
    await e.paso('<b>F1.4</b> Cambia la red → reenvía el lote con el mismo UUID → 200 duplicado');
    perder = false;
    await e.ctxRep.setOffline(true);
    await dormir(600);
    await e.ctxRep.setOffline(false);
    await e.nota('Cambio de red (offline → online)');
    await e.verificar('F1.4 La cola queda vacía', async () => (await cola(e.rep)).length === 0, 20);
    await e.verificar('F1.4 Al final hay una sola "salida a ruta"', async () => {
      await clic(boton(e.cli, 'Ver detalle'));
      return (await ok('tracking/' + G)).historial.filter(m => m.tipo === 'salida_ruta').length === 1 && textoVisible(e.cli, 'Salida a ruta');
    }, 20);
    return e.terminar();
  },

  async '05-reintentos'(e) {
    await e.nuevaEscena('05-reintentos', '05 · Reintentos: franjas alternadas, 3 días, sucursal y decisión del proveedor');
    await varsSesion(e);
    const G = await crearGuia();
    e.vars.G = G;
    await entrar(e.cli, 'cliente', false);
    await campo(e.cli, 'Número de guía').fill(G);
    await boton(e.cli, 'Ver detalle').click();
    await prepararRepartidor(e.rep);
    e.grabar();
    await e.nota('Fixture de pruebas: firma anclas de hora del servidor en días pasados para simular 3 días en segundos');
    const franjas = [];
    for (const [dia, dias, hora] of [[1, 4, 10], [2, 3, 15], [3, 2, 10]]) {
      await e.paso('<b>F2</b> Día ' + dia + ' · salida a las ' + hora + ':00 e intento fallido → Reintentos ' + (dia < 3 ? 'programa otra franja' : 'escala'));
      const r = await e.comando('node scripts/grabar-demos.mjs --fallo ' + G + ' ' + dias + ' ' + hora);
      franjas.push(/mañana|tarde|sucursal/.exec(r.salida)?.[0]);
      await clic(boton(e.cli, 'Ver detalle'));
      if (dia === 1) {
        await e.verificar('F2.1 Fallo en la mañana → reintento en la tarde del día siguiente', () => franjas[0] === 'tarde');
        await e.paso('<b>F2.4</b> La cola entrega dos veces el mismo evento de intento fallido: tomamos el evento del outbox…');
        await e.comando('docker compose exec -T shard' + shardDe(G) + ' psql -U acme -d acme -tAc "SELECT evento FROM outbox WHERE evento->\'movimiento\'->>\'tipo\'=\'intento_fallido\' AND evento->\'paquete\'->>\'numeroGuia\'=\'' + G + '\'" > /tmp/evento.json; head -c 230 /tmp/evento.json; echo …');
        await e.paso('<b>F2.4</b> …y lo publicamos otra vez en RabbitMQ desde dentro del clúster');
        await e.comando('docker compose exec -T reintentos node -e "require(\'amqplib\').connect(process.env.RABBIT_URL).then(async c=>{const ch=await c.createConfirmChannel(),e=require(\'fs\').readFileSync(0,\'utf8\');ch.publish(\'acme.eventos\',JSON.parse(e).clave,Buffer.from(e),{persistent:true});await ch.waitForConfirms();console.log(\'evento reentregado a acme.eventos\');await c.close()})" < /tmp/evento.json');
        await dormir(2500);
        const m = await e.comando('docker compose exec -T mongo-reintentos mongosh reintentos --quiet --eval "const r=db.intentos_entrega.findOne({_id:\'' + G + '\'});print(JSON.stringify({version:r.version,programaciones:r.programaciones.map(p=>[p.fecha,p.franja,p.estado])}))"');
        await e.verificar('F2.4 Evento reentregado → sigue existiendo un solo reintento programado', () =>
          JSON.parse(m.salida).programaciones.filter(p => p[2] === 'pendiente').length === 1 && JSON.parse(m.salida).programaciones.length === 1);
        await e.verificar('F2.3 Un intento fallido nunca es terminal (estado intento_fallido con plan)', async () =>
          (await ok('movimientos/' + G + '/direccion', { token: sesiones.repartidor.token })).estado === 'intento_fallido');
      }
      if (dia === 2) await e.verificar('F2.1 Fallo en la tarde → reintento en la mañana', () => franjas[1] === 'mañana');
    }
    await e.verificar('F2.5 Tercer día con fallo → "En sucursal", pendiente de contacto', async () => {
      await clic(boton(e.cli, 'Ver detalle'));
      return textoVisible(e.cli, 'En sucursal');
    }, 30);
    await e.paso('<b>F2.6</b> El administrador registra que el cliente no respondió y la decisión del proveedor');
    await e.comando('ACME_CORREO=administrador@acme.test acme decision ' + G + ' regresar "Sin respuesta tras 3 llamadas"');
    await e.verificar('F2.6 El caso se cierra con la decisión del proveedor', async () => {
      await clic(boton(e.cli, 'Ver detalle'));
      return (await ok('tracking/' + G + '/detalle', { token: sesiones.cliente.token })).decisionProveedor === 'regresar';
    }, 30);
    return e.terminar();
  },

  async '06-caida-shard'(e) {
    await e.nuevaEscena('06-caida-shard', '06 · Cae un shard de Movimientos: solo ~25 % de las guías se afecta');
    await varsSesion(e);
    const X = shardDe(nuevaGuia());
    const [GA, GB] = [guiaEnShard(X), guiaEnShard(X, true)];
    const [HA, HB] = [guiaEnShard(X), guiaEnShard(X, true)];
    await Promise.all([crearGuia({ guia: GA }), crearGuia({ guia: GB }), crearGuia({ guia: HA, hastaEstado: 'creado' }), crearGuia({ guia: HB, hastaEstado: 'creado' })]);
    Object.assign(e.vars, { GA, GB, HA, HB });
    await prepararRepartidor(e.rep);
    e.grabar();
    try {
      await e.paso('<b>§2.1</b> Cada guía vive en un shard por hash; elegimos guías en shards distintos');
      await e.comando('for g in $GA $HA $GB $HB; do shard $g; done', { modo: 'flujo' });
      await e.paso('<b>§7</b> Se cae el shard ' + X + ' (su PostgreSQL deja de responder)');
      await e.comando('docker compose stop shard' + X, { modo: 'flujo' });
      await e.paso('<b>§2.1</b> Escrituras: la guía del shard caído responde 503; la de otro shard sigue');
      const caida = await e.comando('ACME_CORREO=almacenista@acme.test acme almacen $HA "Almacén Vallejo"');
      const sana = await e.comando('ACME_CORREO=almacenista@acme.test acme almacen $HB "Almacén Vallejo"');
      await e.verificar('§2.1 Guía del shard caído → 503 temporal', () => /503/.test(caida.errores));
      await e.verificar('§2.1 Guía de otro shard → aceptada', () => sana.codigo === 0);
      await e.paso('<b>§7</b> El repartidor escanea ambas: la del shard caído queda en su cola y se reintenta');
      for (const g of [GB, GA]) {
        await teclear(campo(e.rep, 'Número de guía'), g);
        await campo(e.rep, 'Tipo de movimiento').selectOption('salida_ruta');
        await clic(boton(e.rep, 'Guardar escaneo'));
        await dormir(1200);
      }
      await e.verificar('§7 Solo queda pendiente la guía del shard caído', async () => {
        const c = await cola(e.rep);
        return c.length === 1 && c[0].escaneo.numeroGuia === GA;
      }, 15);
      await e.paso('<b>§2.3</b> Las lecturas no dependen del shard: Consulta responde desde su copia (MongoDB)');
      await teclear(campo(e.cli, 'Número de guía'), GA);
      await clic(boton(e.cli, 'Rastrear'));
      await e.verificar('§2.3 El cliente sigue rastreando la guía del shard caído', () => textoVisible(e.cli, 'En centro de distribución'), 10);
      await e.paso('<b>§7</b> El shard vuelve: la PWA reenvía el UUID pendiente');
      await e.comando('docker compose start shard' + X, { modo: 'flujo' });
      await e.acelerar(4, () => hasta(async () => {
        if ((await cola(e.rep)).length === 0) return true;
        if (await textoVisible(e.rep, 'cuando cambie la red')) { await e.ctxRep.setOffline(true); await dormir(500); await e.ctxRep.setOffline(false); }
        return false;
      }, 90).catch(() => undefined));
      await e.verificar('§7 La cola se vacía y el movimiento llega a la línea de tiempo', async () => {
        await clic(boton(e.cli, 'Rastrear'));
        return (await cola(e.rep)).length === 0 && textoVisible(e.cli, 'En reparto');
      }, 30);
    } finally { restaurar(); }
    return e.terminar();
  },

  async '07-rabbit-caido'(e) {
    await e.nuevaEscena('07-rabbit-caido', '07 · RabbitMQ caído: el outbox acumula, nada se pierde, solo se atrasa');
    await varsSesion(e);
    const G = await crearGuia({ hastaEstado: 'creado' });
    const G2 = await crearGuia({ hastaEstado: 'creado' });
    Object.assign(e.vars, { G, G2 });
    await campo(e.cli, 'Número de guía').fill(G);
    await boton(e.cli, 'Rastrear').click();
    e.grabar();
    try {
      await e.paso('<b>§7</b> Se cae el broker de eventos');
      await e.comando('docker compose stop rabbit', { modo: 'flujo' });
      await e.paso('<b>§9</b> Movimientos sigue aceptando: el evento se guarda en el outbox en la misma transacción');
      const a = await e.comando('ACME_CORREO=almacenista@acme.test acme almacen ' + G + ' "Almacén Vallejo"');
      const b = await e.comando('ACME_CORREO=almacenista@acme.test acme centro ' + G + ' "Centro Iztapalapa"');
      await e.verificar('§7 Escrituras aceptadas con el broker caído', () => a.codigo === 0 && b.codigo === 0);
      await e.paso('<b>§4</b> Consulta muestra el último estado conocido: atrasado, pero claro');
      await clic(boton(e.cli, 'Rastrear'));
      await e.verificar('§4 El cliente sigue viendo "Envío creado"', () => textoVisible(e.cli, 'Envío creado'), 10);
      await e.paso('<b>§7</b> Sin broker la proyección no puede confirmar que está al día: Consulta responde 502 y el gateway usa Redis con aviso');
      await e.verificar('§7 Respuesta desde Redis marcada "puede estar desactualizado"', async () => {
        await clic(boton(e.cli, 'Rastrear'));
        return textoVisible(e.cli, 'puede estar desactualizado');
      }, 15);
      await e.paso('<b>Límite</b> Una guía que no está en Redis (fría, TTL 12 h) no tiene respaldo mientras el broker está caído');
      await e.comando('docker compose exec -T redis redis-cli DEL tracking:$G2');
      const fria = await e.comando('api GET tracking/$G2');
      await e.verificar('Límite: guía fuera de Redis → 503 durante la caída del broker', () => /HTTP 503/.test(fria.salida));
      await e.verificar('§9 El outbox del shard tiene eventos sin publicar', () => (e.monitorDatos?.outbox ?? []).some(n => n > 0), 10);
      await e.paso('<b>§9</b> El broker vuelve: el publicador vacía el outbox y la proyección se pone al día');
      await e.comando('docker compose start rabbit', { modo: 'flujo' });
      await e.acelerar(5, () => hasta(async () => (await ok('tracking/' + G)).estado === 'en_centro_distribucion', 90).catch(() => undefined));
      await e.verificar('§7 Ningún evento se perdió: el cliente ve almacén y centro', async () => {
        await clic(boton(e.cli, 'Rastrear'));
        return textoVisible(e.cli, 'Ingreso a centro de distribución');
      }, 30);
      await e.verificar('§9 Outbox vacío', () => (e.monitorDatos?.outbox ?? []).every(n => n === 0), 20);
      const vuelta = await e.comando('api GET tracking/$G2 | grep -oE \'"estado":"[a-z_]+"|HTTP [0-9]+\'');
      await e.verificar('§7 La guía fría vuelve a consultarse al regresar el broker', () => /HTTP 200/.test(vuelta.salida));
    } finally { restaurar(); }
    return e.terminar();
  },

  async '08-consulta-breaker'(e) {
    await e.nuevaEscena('08-consulta-breaker', '08 · Consulta caída: réplicas, circuit breaker y respaldo en Redis');
    await varsSesion(e);
    const G = await crearGuia();
    e.vars.G = G;
    await ok('tracking/' + G);
    e.grabar();
    try {
      await e.paso('<b>§7</b> Cae 1 de 3 réplicas de Consulta → el gateway prueba otra réplica viva');
      await e.comando('docker stop acme-distribuido-consulta-1', { modo: 'flujo' });
      await teclear(campo(e.cli, 'Número de guía'), G);
      await clic(boton(e.cli, 'Rastrear'));
      await e.verificar('§7 Con una réplica caída el cliente no nota nada', async () =>
        await textoVisible(e.cli, 'En centro de distribución') && !(await textoVisible(e.cli, 'desactualizado')), 10);
      await e.paso('<b>F3.2</b> Caen las 3 réplicas → el gateway responde desde Redis con un aviso');
      await e.comando('docker compose stop consulta', { modo: 'flujo' });
      await clic(boton(e.cli, 'Rastrear'));
      await e.verificar('F3.2 Guía en caché → último estado conocido con aviso', () => textoVisible(e.cli, 'puede estar desactualizado'), 10);
      await e.paso('<b>F3.2</b> Una guía que no está en caché → 503');
      await teclear(campo(e.cli, 'Número de guía'), 'ACME-SIN-CACHE');
      await clic(boton(e.cli, 'Rastrear'));
      const r = await e.comando('api GET tracking/ACME-SIN-CACHE');
      await e.verificar('F3.2 Sin caché → 503', () => /HTTP 503/.test(r.salida));
      await e.paso('<b>§2.3</b> Pico de lecturas: 360 consultas; con ≥50 % de fallas en 100 el breaker se abre');
      await e.comando('seq 360 | xargs -P 24 -I{} curl -s -o /dev/null -w "%{http_code} " $ACME_URL/api/v1/tracking/$G; echo', { modo: 'flujo' });
      await e.verificar('§7 Breaker abierto en los 3 gateways; los clientes siguen recibiendo 200 desde Redis', () =>
        (e.monitorDatos?.gw ?? []).filter(Boolean).every(g => g.consulta.estado === 'abierto') && e.monitorDatos.gw.length === 3, 10);
      await teclear(campo(e.cli, 'Número de guía'), G);
      await clic(boton(e.cli, 'Rastrear'));
      await e.paso('<b>§7</b> Consulta vuelve; tras 1 min abierto, el 5 % del tráfico prueba y el breaker se cierra');
      await e.comando('docker compose start consulta', { modo: 'flujo' });
      await e.acelerar(10, () => e.comando('while sleep 0.15; do curl -s -o /dev/null -w "%{http_code} " $ACME_URL/api/v1/tracking/$G; done', {
        modo: 'flujo', maxSeg: 150,
        hastaQue: async () => (e.monitorDatos?.gw ?? []).filter(Boolean).length === 3 && e.monitorDatos.gw.every(g => g?.consulta.estado === 'cerrado'),
      }));
      await e.verificar('§7 Breaker cerrado de nuevo en los 3 gateways', () =>
        (e.monitorDatos?.gw ?? []).filter(Boolean).every(g => g.consulta.estado === 'cerrado'), 10);
      await clic(boton(e.cli, 'Rastrear'));
      await e.verificar('F3.2 El cliente vuelve a ver datos frescos, sin aviso', async () =>
        !(await textoVisible(e.cli, 'desactualizado')) && textoVisible(e.cli, 'En centro de distribución'), 10);
    } finally { restaurar(); }
    return e.terminar();
  },

  async '09-quorum-usuarios'(e) {
    await e.nuevaEscena('09-quorum-usuarios', '09 · Usuarios: consistencia por quórum, pero los tokens emitidos siguen sirviendo');
    await varsSesion(e);
    const G = await crearGuia();
    e.vars.G = G;
    e.vars.CRED = JSON.stringify({ correo: 'cliente@acme.test', contrasena });
    await prepararRepartidor(e.rep);
    await campo(e.rep, 'Número de guía').fill(G);
    await boton(e.rep, 'Consultar dirección').click();
    await e.rep.getByText('Av. Reforma 222').waitFor();
    const nodos = ['usuarios-pg1', 'usuarios-pg2', 'usuarios-pg3'];
    await hasta(() => e.monitorDatos?.pg?.some(m => m.role === 'leader') ?? false, 30);
    const lider = e.monitorDatos.pg.find(m => m.role === 'leader').name;
    const resto = nodos.filter(n => n !== lider);
    const bucleLogin = 'while true; do echo "$(date +%T) login cliente → HTTP $(curl -s -o /dev/null -w \'%{http_code}\' -X POST $ACME_URL/api/v1/auth/login -H \'content-type: application/json\' -d "$CRED")"; sleep 2; done';
    e.grabar();
    try {
      await e.paso('<b>§4</b> Usuarios: 3 PostgreSQL con Patroni en modo quórum y etcd para elegir líder');
      await e.comando('docker compose exec usuarios-pg1 /opt/patroni/bin/patronictl -c /etc/patroni.yml list', { modo: 'flujo' });
      await e.paso('<b>§7</b> Cae el líder (' + lider + ') → Patroni promueve otra réplica con mayoría 2/3; el login sigue respondiendo');
      await e.comando('docker compose stop ' + lider, { modo: 'flujo' });
      await e.comando(bucleLogin, { modo: 'flujo', maxSeg: 60, hastaQue: async s => (s.match(/HTTP 200/g) ?? []).length >= 5 });
      await e.verificar('§7 Patroni promovió un nuevo líder con mayoría 2/3', () => e.monitorDatos?.pg?.some(m => m.role === 'leader' && m.name !== lider), 40);
      await e.paso('<b>§4</b> Cae otro nodo → sin mayoría nadie puede iniciar sesión: se prefiere negar el servicio');
      await e.comando('docker compose stop ' + resto[0], { modo: 'flujo' });
      await e.acelerar(4, () => e.comando(bucleLogin, { modo: 'flujo', maxSeg: 60, hastaQue: async s => /HTTP 503\n$/.test(s) }));
      await entrar(e.cli, 'cliente');
      await e.verificar('§4 Sin quórum el login devuelve 503 (también en la web)', async () =>
        (await e.cli.getByRole('alert').textContent().catch(() => '')).length > 0, 15);
      await e.paso('<b>§4</b> Pero el token del repartidor sigue sirviendo: se verifica localmente');
      await campo(e.rep, 'Tipo de movimiento').selectOption('salida_ruta');
      await clic(boton(e.rep, 'Guardar escaneo'));
      await e.verificar('§4 "Salida a ruta" aceptada sin quórum', async () => (await cola(e.rep)).length === 0, 20);
      await e.paso('<b>F1.1</b> "Entregado" sin poder verificar la revocación → pendiente de confirmación, no terminal');
      await campo(e.rep, 'Tipo de movimiento').selectOption('entregado');
      await teclear(campo(e.rep, 'Quién recibió'), 'Ana Pérez');
      await clic(boton(e.rep, 'Guardar escaneo'));
      await e.verificar('F1.1 La PWA avisa: entrega pendiente de confirmación', () => textoVisible(e.rep, 'pendiente de confirmación'), 45);
      const p = await e.comando('api GET movimientos/' + G + '/direccion "$TOK_REP" | grep -o \'"estado":"[a-z_]*"\'');
      await e.verificar('F1.1 El paquete sigue "en_ruta" (no terminal)', () => /en_ruta/.test(p.salida));
      await e.paso('<b>§4</b> Vuelve la mayoría → se reconcilia la entrega pendiente');
      await e.comando('docker compose start ' + lider + ' ' + resto[0], { modo: 'flujo' });
      await e.acelerar(6, () => hasta(async () => (await ok('movimientos/' + G + '/direccion', { token: sesiones.repartidor.token })).estado === 'entregado', 120).catch(() => undefined));
      await e.verificar('§4 La entrega pendiente queda confirmada', async () =>
        (await ok('movimientos/' + G + '/direccion', { token: sesiones.repartidor.token })).estado === 'entregado', 30);
      await e.paso('<b>§4</b> Con quórum otra vez, el cliente entra y ve la entrega');
      await e.acelerar(3, () => hasta(async () => (await http('auth/login', { datos: { correo: 'cliente@acme.test', contrasena } })).status === 200, 60));
      await clic(boton(e.cli, 'Entrar'));
      await teclear(campo(e.cli, 'Número de guía'), G);
      await clic(boton(e.cli, 'Ver detalle'));
      await e.verificar('§4 El cliente ve "Entregado" con quien recibió', async () => {
        await clic(boton(e.cli, 'Ver detalle'));
        return (await ok('tracking/' + G + '/detalle', { token: sesiones.cliente.token })).estado === 'entregado' && textoVisible(e.cli, 'Entregado');
      }, 30);
    } finally { restaurar(); }
    return e.terminar();
  },

  async '10-replicas-gateway'(e) {
    await e.nuevaEscena('10-replicas-gateway', '10 · Réplicas del gateway: Nginx reparte entre las copias vivas');
    await varsSesion(e);
    const G = await crearGuia();
    e.vars.G = G;
    await prepararRepartidor(e.rep);
    // curl es nativo de Windows (MSYS_NO_PATHCONV): la ruta del archivo va en formato C:/… para que curl y grep vean el mismo.
    e.vars.H = join(tmpdir(), 'acme-health.json').replaceAll('\\', '/');
    const ronda = 'for i in $(seq 6); do curl -s -o "$H" -w "%{http_code} %{time_total}s " $ACME_URL/health; grep -o \'"instancia":"[a-f0-9]*"\' "$H" || echo "(sin respuesta de un gateway)"; done';
    e.grabar();
    try {
      await e.paso('<b>§7</b> Nginx (único puerto publicado) reparte las peticiones entre 3 gateways');
      const antes = await e.comando(ronda, { modo: 'flujo' });
      await e.verificar('§7 Responden 3 instancias distintas', () => new Set(antes.salida.match(/[a-f0-9]{12}/g)).size === 3);
      await e.paso('<b>§7</b> Caen 2 de 3 gateways');
      await e.comando('docker stop acme-distribuido-gateway-1 acme-distribuido-gateway-2', { modo: 'flujo' });
      const transicion = await e.comando(ronda, { modo: 'flujo' });
      const fallidas = (transicion.salida.match(/^(?!200 )\d{3} /gm) ?? []).length;
      await e.nota('Observación: ' + fallidas + ' de 6 peticiones fallaron mientras Nginx aún tenía las IP caídas en su DNS (valid=5s, connect 2 s c/u)');
      await e.paso('<b>§7</b> Pasada la ventana de DNS de Nginx (5 s), todo lo atiende la copia viva');
      await dormir(5000);
      const despues = await e.comando(ronda, { modo: 'flujo' });
      await e.verificar('§7 Tras ≤5 s, las 6 peticiones → 200 desde la copia viva', () => new Set(despues.salida.match(/[a-f0-9]{12}/g)).size === 1 &&
        (despues.salida.match(/^200 /gm) ?? []).length === 6);
      await e.paso('El cliente y el repartidor siguen operando sin enterarse');
      await teclear(campo(e.cli, 'Número de guía'), G);
      await clic(boton(e.cli, 'Rastrear'));
      await e.verificar('§7 El cliente rastrea con un solo gateway', () => textoVisible(e.cli, 'En centro de distribución'), 10);
      await teclear(campo(e.rep, 'Número de guía'), G);
      await clic(boton(e.rep, 'Consultar dirección'));
      await campo(e.rep, 'Tipo de movimiento').selectOption('salida_ruta');
      await clic(boton(e.rep, 'Guardar escaneo'));
      await e.verificar('§7 El repartidor registra con un solo gateway', async () => (await cola(e.rep)).length === 0, 15);
      await e.paso('Se restablecen las copias');
      await e.comando('docker start acme-distribuido-gateway-1 acme-distribuido-gateway-2', { modo: 'flujo' });
    } finally { restaurar(); }
    return e.terminar();
  },
};

const elegidos = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(escenarios);
const estudio = new Estudio();
await estudio.abrir();
mkdirSync(salidaGifs, { recursive: true });
const archivoInforme = join(salidaGifs, 'resultados.json');
const informe = existsSync(archivoInforme) ? JSON.parse(readFileSync(archivoInforme, 'utf8')) : [];
const anotar = r => { const i = informe.findIndex(x => x.nombre === r.nombre); if (i >= 0) informe[i] = r; else informe.push(r); };
try {
  for (const nombre of elegidos) {
    if (!escenarios[nombre]) throw new Error('Escenario desconocido: ' + nombre);
    try { anotar(await escenarios[nombre](estudio)); }
    catch (error) {
      console.error('✗ ' + nombre + ' se interrumpió: ' + error.stack);
      estudio.grabando = false;
      restaurar();
      await estudio.ctxCli?.close().catch(() => undefined);
      await estudio.ctxRep?.close().catch(() => undefined);
      anotar({ nombre, error: error.message });
    }
  }
} finally {
  await estudio.cerrar();
  writeFileSync(archivoInforme, JSON.stringify(informe, null, 2));
}
process.exit(informe.every(r => !r.error && r.resultados.every(x => x.ok)) ? 0 : 1);
