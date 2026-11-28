export interface AnclaServidor { ancla: string; servidorMs: number }
interface Guardado extends AnclaServidor { transcurridoMs: number; incierto: boolean }
type Almacen = Pick<Storage, 'getItem' | 'setItem'>;

// El reloj de pared solo se adjunta para detectar discrepancias. Nunca calcula
// la hora operativa. Tras un cierre se desconoce la duración del intervalo apagado.
export class RelojOffline {
  private referencia?: Guardado & { inicio: number };
  private readonly clave: string;

  constructor(usuario: string, private readonly almacen: Almacen,
    private readonly monotono: () => number = () => performance.now(),
    private readonly pared: () => number = Date.now) {
    this.clave = 'acme-reloj:' + usuario;
    try {
      const dato: Guardado | null = JSON.parse(almacen.getItem(this.clave) ?? 'null');
      if (dato && typeof dato.ancla === 'string' && Number.isFinite(dato.servidorMs) &&
          Number.isFinite(dato.transcurridoMs) && dato.transcurridoMs >= 0) {
        this.referencia = { ...dato, inicio: monotono(), incierto: true };
      }
    } catch { /* Se podrá guardar offline y marcar la hora como no verificable. */ }
  }

  anclar(ancla: AnclaServidor, inicio = this.monotono()) {
    this.referencia = { ...ancla, inicio, transcurridoMs: 0, incierto: false };
    this.guardar();
  }

  private transcurrido() {
    const r = this.referencia!;
    return r.transcurridoMs + Math.max(0, this.monotono() - r.inicio);
  }

  guardar() {
    if (!this.referencia) return;
    const { ancla, servidorMs, incierto } = this.referencia;
    try {
      this.almacen.setItem(this.clave, JSON.stringify({ ancla, servidorMs, incierto, transcurridoMs: this.transcurrido() }));
    } catch { /* Una falla de persistencia no impide registrar en IndexedDB. */ }
  }

  capturar() {
    const r = this.referencia;
    const captura = { ancla: r?.ancla, transcurridoMs: r ? this.transcurrido() : undefined,
      relojLocalMs: this.pared(), relojIncierto: !r || r.incierto };
    this.guardar();
    return captura;
  }
}
