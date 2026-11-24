import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  agregar, api, Direccion, direccionLocal, ErrorApi, Escaneo, guardarDireccion, hashPin, marcar, mensaje,
  Pendiente, pendientes, quitar, Sesion, Vista,
} from './datos';
import './estilos.css';

const textos: Record<string, string> = {
  creado: 'Envío creado', envio_creado: 'Envío creado', en_almacen: 'En almacén', ingreso_almacen: 'Ingreso a almacén',
  en_centro_distribucion: 'En centro de distribución', ingreso_centro_distribucion: 'Ingreso a centro de distribución',
  en_ruta: 'En reparto', salida_ruta: 'Salida a ruta', intento_fallido: 'Intento fallido', entregado: 'Entregado',
  en_sucursal: 'En sucursal', paso_sucursal: 'Ingreso a sucursal', direccion_corregida: 'Dirección corregida',
  reintento_programado: 'Reintento programado', entrega_erronea: 'Entrega errónea', recuperado: 'Paquete recuperado',
  contacto_registrado: 'Contacto registrado', caso_cerrado: 'Caso cerrado',
};
const nombre = (tipo: string) => textos[tipo] ?? tipo.replaceAll('_', ' ');
const fecha = (valor: string) => new Date(valor).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const normalizar = (guia: string) => guia.trim().toUpperCase();
const pausa = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function sesionLocal(): Sesion | null {
  try { return JSON.parse(localStorage.getItem('acme-sesion') ?? 'null'); } catch { return null; }
}

function Acceso({ entrar }: { entrar: (sesion: Sesion) => void }) {
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [registro, setRegistro] = useState(false);
  async function login(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const datos = new FormData(evento.currentTarget);
    const credenciales = { correo: datos.get('correo'), contrasena: datos.get('contrasena') };
    setError('');
    setOcupado(true);
    try {
      if (registro) await api('auth/registro', undefined, { ...credenciales, nombre: datos.get('nombre') });
      entrar(await api<Sesion>('auth/login', undefined, credenciales));
    } catch (error) { setError(mensaje(error)); }
    finally { setOcupado(false); }
  }
  return <form className="panel" onSubmit={login}>
    <h2>{registro ? 'Crear cuenta de cliente' : 'Iniciar sesión'}</h2>
    {registro && <label>Nombre<input name="nombre" autoComplete="name" required /></label>}
    <label>Correo<input name="correo" type="email" autoComplete="username" required /></label>
    <label>Contraseña<input name="contrasena" type="password" autoComplete={registro ? 'new-password' : 'current-password'}
      minLength={registro ? 12 : 1} required /></label>
    {error && <p className="aviso" role="alert">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button disabled={ocupado}>{registro ? 'Crear cuenta' : 'Entrar'}</button>
      <button className="secundario" type="button" onClick={() => setRegistro(!registro)}>
        {registro ? 'Volver al inicio de sesión' : 'Registrarme'}
      </button>
    </div>
  </form>;
}

function Rastreo({ sesion }: { sesion: Sesion | null }) {
  const [guia, setGuia] = useState('');
  const [vista, setVista] = useState<Vista>();
  const [direccion, setDireccion] = useState('');
  const [aviso, setAviso] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const correccion = useRef<{ guia: string; direccion: string; id: string } | null>(null);

  async function buscar(detalle: boolean) {
    const codigo = normalizar(guia);
    if (!/^[A-Z0-9-]{6,40}$/.test(codigo)) { setAviso('Escribe una guía de 6 a 40 caracteres'); return; }
    setOcupado(true);
    setAviso('');
    try {
      const r = await api<Vista>('tracking/' + codigo + (detalle ? '/detalle' : ''), detalle ? sesion?.token : undefined);
      setVista(r);
      setDireccion(r.direccion ?? '');
    } catch (error) { setVista(undefined); setAviso(mensaje(error)); }
    finally { setOcupado(false); }
  }
  async function corregir(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!vista || !sesion) return;
    setOcupado(true);
    setAviso('');
    const valor = direccion.trim();
    if (correccion.current?.guia !== vista.numeroGuia || correccion.current.direccion !== valor) {
      correccion.current = { guia: vista.numeroGuia, direccion: valor, id: crypto.randomUUID() };
    }
    try {
      const r = await api<{ paquete: { direccion: string }; movimiento: { confirmacion: string } }>(
        'movimientos/' + vista.numeroGuia + '/direccion', sesion.token, { id: correccion.current.id, direccion: valor });
      setVista({ ...vista, direccion: r.paquete.direccion });
      setAviso(r.movimiento.confirmacion === 'pendiente' ? 'Corrección pendiente de confirmación' :
        r.movimiento.confirmacion === 'rechazado' ? 'La corrección fue rechazada' : 'Dirección actualizada');
    } catch (error) { setAviso(mensaje(error)); }
    finally { setOcupado(false); }
  }

  return <>
    <form className="panel" onSubmit={e => { e.preventDefault(); void buscar(false); }}>
      <label>Número de guía<input value={guia} onChange={e => setGuia(e.target.value)} placeholder="Ej. ACME-0001" required /></label>
      <div className="flex flex-wrap gap-2">
        <button disabled={ocupado}>Rastrear</button>
        {sesion?.usuario.rol === 'cliente' && <button className="secundario" type="button" disabled={ocupado}
          onClick={() => void buscar(true)}>Ver detalle</button>}
      </div>
    </form>
    {aviso && <p className="estado" role="status">{aviso}</p>}
    {vista && <section className="panel" aria-label="Resultado del rastreo">
      <div><p className="text-sm text-slate-600">{vista.numeroGuia}</p><h2>{nombre(vista.estado)}</h2></div>
      {vista.aviso && <p className="aviso">{vista.aviso}</p>}
      {vista.direccion && <div><p>{vista.destinatario}</p><p className="text-slate-600">{vista.direccion}</p></div>}
      {vista.plan && <p>Próximo intento el {vista.plan.fecha} en la {vista.plan.franja === 'manana' ? 'mañana' : 'tarde'}.</p>}
      <ol className="divide-y divide-slate-200">
        {vista.historial.map((mov, i) => <li key={mov.id ?? i} className="py-2">
          <p className="font-medium">{nombre(mov.tipo)}{mov.confirmacion && mov.confirmacion !== 'confirmado' &&
            <span className="ml-2 text-sm text-amber-800">({mov.confirmacion} de confirmación)</span>}</p>
          <time className="text-sm text-slate-600" dateTime={mov.registradoEn}>{fecha(mov.registradoEn)}</time>
          {mov.sospechoso && <p className="text-sm text-amber-800">Hora del dispositivo sin verificar</p>}
          {(mov.ubicacion || mov.motivo || mov.receptor || mov.direccionNueva) &&
            <p className="text-sm">{[mov.ubicacion, mov.motivo, mov.receptor, mov.direccionNueva].filter(Boolean).join(' · ')}</p>}
        </li>)}
      </ol>
      {vista.direccion && !vista.primeraSalidaEn && sesion && <form className="grid gap-2" onSubmit={corregir}>
        <label>Nueva dirección<input value={direccion} onChange={e => setDireccion(e.target.value)} required maxLength={500} /></label>
        <button className="w-fit" disabled={ocupado || direccion.trim() === vista.direccion}>Corregir dirección</button>
      </form>}
    </section>}
  </>;
}

function Pin({ usuario, desbloquear }: { usuario: string; desbloquear: () => void }) {
  const clave = 'acme-pin:' + usuario;
  const [fallo, setFallo] = useState('');
  const configurado = Boolean(localStorage.getItem(clave));
  async function aceptar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const pin = String(new FormData(evento.currentTarget).get('pin'));
    try {
      const previo = localStorage.getItem(clave);
      const [sal, registrado] = previo?.split(':') ?? [crypto.randomUUID(), ''];
      const hash = await hashPin(pin, sal);
      if (registrado && registrado !== hash) { setFallo('PIN incorrecto'); return; }
      if (!registrado) localStorage.setItem(clave, sal + ':' + hash);
      desbloquear();
    } catch (error) { setFallo(mensaje(error)); }
  }
  return <form className="panel" onSubmit={aceptar}>
    <h2>{configurado ? 'Desbloquear reparto' : 'Configurar PIN de reparto'}</h2>
    <label>PIN de cuatro dígitos<input type="password" name="pin" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required /></label>
    {fallo && <p className="aviso" role="alert">{fallo}</p>}
    <button className="w-fit">{configurado ? 'Desbloquear' : 'Guardar PIN'}</button>
  </form>;
}

type Ancla = { ancla: string; servidorMs: number; monotono: number };
const anclas = new Map<string, Ancla>();
type Resultado = { id: string; status: number; mensaje?: string; movimiento?: { tipo: string; confirmacion: string } };
function Reparto({ sesion }: { sesion: Sesion }) {
  const { token, usuario: { id } } = sesion;
  const [guia, setGuia] = useState('');
  const [tipo, setTipo] = useState('salida_ruta');
  const [direccion, setDireccion] = useState<Direccion>();
  const [cola, setCola] = useState<Pendiente[]>([]);
  const [aviso, setAviso] = useState('');
  const [enLinea, setEnLinea] = useState(navigator.onLine);
  const [sincronizando, setSincronizando] = useState(false);
  const activo = useRef(true);
  const enCurso = useRef(false);
  const cambioRed = useRef(false);
  const detenido = useRef(false);
  const guiasVistas = useRef(new Set<string>());

  const refrescarCola = useCallback(async () => { setCola(await pendientes(id)); }, [id]);
  const refrescarHora = useCallback(async () => {
    const inicio = performance.now();
    const r = await api<Omit<Ancla, 'monotono'>>('movimientos/hora', token);
    anclas.set(token, { ...r, monotono: (inicio + performance.now()) / 2 });
  }, [token]);
  const obtenerDireccion = useCallback(async (codigo: string) => {
    guiasVistas.current.add(codigo);
    const dir = await api<Direccion>('movimientos/' + codigo + '/direccion', token);
    await guardarDireccion(id, dir);
    setDireccion(anterior => anterior?.numeroGuia === codigo ? dir : anterior);
    return dir;
  }, [id, token]);

  const sincronizar = useCallback(async () => {
    if (!activo.current || !navigator.onLine || enCurso.current || detenido.current) return;
    enCurso.current = true;
    setSincronizando(true);
    try {
      for (let intento = 0; intento <= 3 && activo.current && navigator.onLine; intento++) {
        const lote = (await pendientes(id)).filter(item => !item.problema);
        if (!lote.length) return;
        try {
          const r = await api<{ resultados: Resultado[] }>('movimientos/sincronizar', token,
            { escaneos: lote.map(item => item.escaneo) });
          let temporal = false;
          for (const item of lote) {
            const resultado = r.resultados.find(x => x.id === item.escaneo.id);
            if (!resultado || resultado.status >= 500) { temporal = true; continue; }
            if (resultado.status === 200) {
              await quitar(item.orden);
              if (resultado.movimiento?.tipo === 'entrega_erronea') setAviso('Entrega errónea registrada. El paquete requiere recuperación.');
              else if (resultado.movimiento?.confirmacion === 'pendiente') setAviso('Entrega recibida y pendiente de confirmación.');
            } else if (resultado.status === 401) {
              throw new ErrorApi(401, resultado.mensaje ?? 'Verifica tu sesión');
            } else await marcar(item, resultado.mensaje ?? 'El servidor rechazó el movimiento');
          }
          for (const codigo of new Set(lote.map(item => item.escaneo.numeroGuia))) {
            void obtenerDireccion(codigo).catch(() => undefined);
          }
          if (!temporal && !(await pendientes(id)).some(item => !item.problema)) return;
          if (!temporal) { intento = -1; continue; }
        } catch (error) {
          if (error instanceof ErrorApi && error.status < 500) {
            setAviso(mensaje(error) + '. Los escaneos siguen guardados en este dispositivo.');
            return;
          }
        }
        if (intento < 3) await pausa(2000 * 2 ** intento * (0.8 + Math.random() * 0.4));
        else {
          detenido.current = true;
          setAviso('La sincronización se reanudará cuando cambie la red.');
        }
      }
    } finally {
      enCurso.current = false;
      setSincronizando(false);
      await refrescarCola();
      if (cambioRed.current && activo.current) {
        cambioRed.current = false;
        detenido.current = false;
        queueMicrotask(() => void sincronizar());
      }
    }
  }, [id, token, obtenerDireccion, refrescarCola]);

  useEffect(() => {
    activo.current = true;
    const cambiarRed = () => {
      setEnLinea(navigator.onLine);
      if (!navigator.onLine) return;
      detenido.current = false;
      cambioRed.current = enCurso.current;
      void refrescarHora().catch(() => undefined);
      for (const codigo of guiasVistas.current) void obtenerDireccion(codigo).catch(() => undefined);
      void sincronizar().catch(error => setAviso(mensaje(error)));
    };
    const conexion = (navigator as Navigator & { connection?: EventTarget }).connection;
    window.addEventListener('online', cambiarRed);
    window.addEventListener('offline', cambiarRed);
    conexion?.addEventListener('change', cambiarRed);
    const reloj = setInterval(() => { if (navigator.onLine) void refrescarHora().catch(() => undefined); }, 60000);
    void refrescarCola().catch(error => setAviso(mensaje(error)));
    cambiarRed();
    return () => {
      activo.current = false;
      clearInterval(reloj);
      window.removeEventListener('online', cambiarRed);
      window.removeEventListener('offline', cambiarRed);
      conexion?.removeEventListener('change', cambiarRed);
    };
  }, [obtenerDireccion, refrescarCola, refrescarHora, sincronizar]);

  async function consultarDireccion() {
    const codigo = normalizar(guia);
    if (!/^[A-Z0-9-]{6,40}$/.test(codigo)) { setAviso('Escribe una guía válida'); return; }
    try {
      if (navigator.onLine) {
        try { setDireccion(await obtenerDireccion(codigo)); setAviso(''); return; }
        catch (error) { setAviso(mensaje(error)); }
      }
      setDireccion(await direccionLocal(id, codigo));
    } catch (error) { setAviso(mensaje(error)); }
  }

  async function escanear(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const datos = new FormData(e.currentTarget);
    const codigo = normalizar(guia);
    setAviso('');
    try {
      const dir = direccion?.numeroGuia === codigo ? direccion : await direccionLocal(id, codigo);
      const referencia = anclas.get(token);
      const mov: Escaneo = {
        id: crypto.randomUUID(), numeroGuia: codigo, tipo, relojLocalMs: Date.now(),
        revisionDireccion: dir?.revisionDireccion, ancla: referencia?.ancla,
        transcurridoMs: referencia ? Math.max(0, performance.now() - referencia.monotono) : undefined,
        motivo: tipo === 'intento_fallido' ? String(datos.get('motivo')) : undefined,
        receptor: tipo === 'entregado' ? String(datos.get('receptor')) : undefined,
      };
      await agregar(id, mov);
      await refrescarCola();
      setAviso('Escaneo guardado en el dispositivo.');
      void sincronizar().catch(error => setAviso(mensaje(error)));
    } catch (error) { setAviso(mensaje(error)); }
  }

  return <>
    <form className="panel" onSubmit={escanear}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2>Registrar movimiento</h2>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-sm">{enLinea ? 'Con conexión' : 'Sin conexión'}</span>
      </div>
      <div className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
        <label>Número de guía<input value={guia} onChange={e => setGuia(e.target.value)} required pattern="[A-Za-z0-9\x2D]{6,40}" /></label>
        <button type="button" className="secundario" onClick={() => void consultarDireccion()}>Consultar dirección</button>
      </div>
      {direccion?.numeroGuia === normalizar(guia) && <div className="estado">
        <p>{direccion.direccion}</p>
        {direccion.plan && <p>Reintento el {direccion.plan.fecha} en la {direccion.plan.franja === 'manana' ? 'mañana' : 'tarde'}.</p>}
      </div>}
      <label>Tipo de movimiento<select value={tipo} onChange={e => setTipo(e.target.value)}>
        <option value="salida_ruta">Salida a ruta</option><option value="entregado">Entregado</option>
        <option value="intento_fallido">Intento fallido</option>
      </select></label>
      {tipo === 'entregado' && <label>Quién recibió<input name="receptor" required maxLength={200} /></label>}
      {tipo === 'intento_fallido' && <label>Motivo<input name="motivo" required maxLength={500} /></label>}
      <button className="w-fit">Guardar escaneo</button>
    </form>
    {aviso && <p className="estado" role="status">{aviso}</p>}
    <section className="panel">
      <h2>Cola de sincronización</h2>
      <p>{cola.length} {cola.length === 1 ? 'movimiento pendiente' : 'movimientos pendientes'}</p>
      {cola.length > 0 && <ul className="divide-y divide-slate-200">
        {cola.map(item => <li key={item.orden} className="py-2">
          <p>{item.escaneo.numeroGuia} · {nombre(item.escaneo.tipo)}</p>
          {item.problema && <p className="text-sm text-amber-800">{item.problema}</p>}
        </li>)}
      </ul>}
      <button className="secundario w-fit" disabled={sincronizando || !enLinea || detenido.current || !cola.some(x => !x.problema)}
        onClick={() => void sincronizar().catch(error => setAviso(mensaje(error)))}>{sincronizando ? 'Sincronizando…' : 'Sincronizar'}</button>
    </section>
  </>;
}

function App() {
  const [sesion, setSesion] = useState(sesionLocal);
  const [vista, setVista] = useState(new URLSearchParams(location.search).has('reparto') ? 'reparto' : 'rastreo');
  const [desbloqueado, setDesbloqueado] = useState(false);
  const [acceso, setAcceso] = useState(false);
  const [aviso, setAviso] = useState('');

  useEffect(() => {
    if (!desbloqueado) return;
    const reloj = setTimeout(() => setDesbloqueado(false), 10 * 60 * 1000);
    return () => clearTimeout(reloj);
  }, [desbloqueado]);

  function entrar(nueva: Sesion) {
    anclas.clear();
    setSesion(nueva);
    setAcceso(false);
    setDesbloqueado(false);
    localStorage.setItem('acme-sesion', JSON.stringify(nueva));
    if (nueva.usuario.rol === 'repartidor') setVista('reparto');
  }
  async function salir() {
    if (!sesion) return;
    try {
      await api('auth/logout', sesion.token, {});
    } catch (error) {
      if (!(error instanceof ErrorApi && error.status === 401)) { setAviso(mensaje(error)); return; }
    }
    localStorage.removeItem('acme-sesion');
    anclas.clear();
    setSesion(null);
    setDesbloqueado(false);
    setVista('rastreo');
    setAviso('');
  }

  return <>
    <header className="bg-[#152a47] text-white">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-5">
        <span className="text-lg font-bold tracking-tight">ACME Paquetería</span>
        <button className="secundario" onClick={() => setAcceso(!acceso)}>
          {acceso ? 'Volver' : sesion ? 'Mi sesión' : 'Iniciar sesión'}
        </button>
      </div>
    </header>
    <main className="mx-auto grid max-w-3xl gap-5 px-5 py-7 sm:py-10">
      {acceso ? <h1>Mi sesión</h1> : <h1>{vista === 'rastreo' ? 'Rastreo de paquetes' : 'Reparto'}</h1>}
      {sesion?.usuario.rol === 'repartidor' && !acceso && <nav className="flex gap-2" aria-label="Vistas">
        <button className={vista === 'rastreo' ? '' : 'secundario'} onClick={() => setVista('rastreo')}>Rastreo</button>
        <button className={vista === 'reparto' ? '' : 'secundario'} onClick={() => setVista('reparto')}>Reparto</button>
      </nav>}
      {aviso && <p className="aviso" role="alert">{aviso}</p>}
      {acceso ? (sesion ? <section className="panel">
        <p>{sesion.usuario.nombre} · {sesion.usuario.rol}</p>
        <div className="flex flex-wrap gap-2">
          <button className="secundario" onClick={() => { setSesion(null); setDesbloqueado(false); }}>Cambiar o renovar sesión</button>
          <button onClick={() => void salir()}>Cerrar sesión</button>
        </div>
      </section> : <Acceso entrar={entrar} />) :
        vista === 'rastreo' ? <Rastreo key={sesion?.usuario.id ?? 'publico'} sesion={sesion} /> :
        sesion?.usuario.rol !== 'repartidor' ? <Acceso entrar={entrar} /> :
        desbloqueado ? <Reparto sesion={sesion} /> : <Pin usuario={sesion.usuario.id} desbloquear={() => setDesbloqueado(true)} />}
    </main>
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(console.error);

