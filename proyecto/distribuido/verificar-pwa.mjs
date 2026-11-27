import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as dormir } from 'node:timers/promises';
import { chromium } from 'playwright';

const origen = (process.env.ACME_URL ?? 'http://localhost:8083').replace(/\/$/, '');
const contrasena = process.env.DEMO_PASSWORD ?? 'AcmeDemo2026!';
async function http(ruta, token, datos) {
  const respuesta = await fetch(origen + '/api/v1/' + ruta, {
    method: datos ? 'POST' : 'GET', signal: AbortSignal.timeout(32000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: datos ? JSON.stringify(datos) : undefined,
  });
  assert.ok(respuesta.ok, ruta + ': ' + respuesta.status + ' ' + await respuesta.clone().text());
  return respuesta.json();
}
async function hasta(prueba, ms = 45000) {
  const inicio = Date.now();
  for (;;) {
    try { return await prueba(); }
    catch (error) {
      if (Date.now() - inicio > ms) throw error;
      await dormir(200);
    }
  }
}
const login = rol => http('auth/login', undefined, { correo: rol + '@acme.test', contrasena });
const [cliente, proveedor, almacen] = await Promise.all(['cliente', 'proveedor', 'almacenista'].map(login));
async function preparar() {
  const numeroGuia = 'PWA-' + randomUUID().slice(0, 12).toUpperCase();
  await http('movimientos/envios', proveedor.token, { numeroGuia, clienteId: cliente.usuario.id,
    destinatario: 'Cliente PWA', direccion: 'Domicilio de prueba offline' });
  for (const tipo of ['ingreso_almacen', 'ingreso_centro_distribucion']) {
    await http('movimientos/escanear', almacen.token, { id: randomUUID(), numeroGuia, tipo, ubicacion: 'Nodo PWA' });
  }
  return numeroGuia;
}
const [guiaOffline, guiaRespuestaPerdida] = await Promise.all([preparar(), preparar()]);
const browser = await chromium.launch({ headless: true, executablePath: process.env.ACME_CHROMIUM_PATH });
try {
  const contexto = await browser.newContext();
  const pagina = await contexto.newPage();
  pagina.setDefaultTimeout(15000);
  await pagina.goto(origen + '/?reparto');
  await pagina.getByLabel('Correo', { exact: true }).fill('repartidor@acme.test');
  await pagina.getByLabel('Contraseña', { exact: true }).fill(contrasena);
  await pagina.getByRole('button', { name: 'Entrar', exact: true }).click();
  await pagina.getByLabel('PIN de cuatro dígitos').fill('1234');
  await Promise.all([
    pagina.waitForResponse(r => r.url().endsWith('/movimientos/hora') && r.ok()),
    pagina.getByRole('button', { name: 'Guardar PIN', exact: true }).click(),
  ]);
  await pagina.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve =>
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  async function direccion(guia) {
    await pagina.getByLabel('Número de guía', { exact: true }).fill(guia);
    await pagina.getByRole('button', { name: 'Consultar dirección', exact: true }).click();
    await pagina.getByText('Domicilio de prueba offline', { exact: true }).waitFor();
  }
  const cola = () => pagina.evaluate(() => new Promise((resolve, reject) => {
    const abrir = indexedDB.open('acme-reparto');
    abrir.onerror = () => reject(abrir.error);
    abrir.onsuccess = () => {
      const db = abrir.result;
      const solicitud = db.transaction('cola', 'readonly').objectStore('cola').getAll();
      solicitud.onsuccess = () => { resolve(solicitud.result); db.close(); };
      solicitud.onerror = () => { reject(solicitud.error); db.close(); };
    };
  }));
  await direccion(guiaOffline);
  await contexto.setOffline(true);
  await pagina.getByLabel('Tipo de movimiento').selectOption('salida_ruta');
  await pagina.getByRole('button', { name: 'Guardar escaneo', exact: true }).click();
  await hasta(async () => assert.equal((await cola()).length, 1));
  const [primero] = await cola();

  // Al recargar offline ni el HTML ni la sesión ni la cola dependen del servidor.
  // Alterar Date.now no debe desplazar la hora operativa del siguiente escaneo.
  await pagina.addInitScript(() => {
    const original = Date.now;
    Date.now = () => original() + 86400000;
  });
  await pagina.reload({ waitUntil: 'domcontentloaded' });
  await pagina.getByLabel('PIN de cuatro dígitos').fill('1234');
  await pagina.getByRole('button', { name: 'Desbloquear', exact: true }).click();
  await direccion(guiaOffline);
  await pagina.getByLabel('Tipo de movimiento').selectOption('entregado');
  await pagina.getByLabel('Quién recibió').fill('Receptor offline');
  await pagina.getByRole('button', { name: 'Guardar escaneo', exact: true }).click();
  await hasta(async () => assert.equal((await cola()).length, 2));
  const guardados = await cola();
  assert.equal(guardados[0].escaneo.id, primero.escaneo.id);
  assert.equal(guardados[1].escaneo.ancla, primero.escaneo.ancla);
  assert.ok(guardados[1].escaneo.transcurridoMs >= primero.escaneo.transcurridoMs);
  assert.equal(guardados[1].escaneo.relojIncierto, true);
  console.log('✓ PWA recarga sin red, conserva cola, dirección y ancla; marca la incertidumbre tras reiniciar');

  await contexto.setOffline(false);
  await hasta(async () => assert.equal((await cola()).length, 0));
  const token = await pagina.evaluate(() => JSON.parse(localStorage.getItem('acme-sesion')).token);
  await hasta(async () => {
    const vista = await http('tracking/' + guiaOffline + '/detalle', cliente.token);
    assert.equal(vista.estado, 'entregado');
    const entrega = vista.historial.find(m => m.id === guardados[1].escaneo.id);
    assert.equal(entrega.receptor, 'Receptor offline');
    assert.equal(entrega.sospechoso, true);
  });
  const duplicados = await http('movimientos/sincronizar', token, { escaneos: guardados.map(x => x.escaneo) });
  assert.ok(duplicados.resultados.every(x => x.status === 200 && x.duplicado));
  console.log('✓ Reconexión sincroniza el lote, entrega con receptor y reenvío sin duplicados');

  const intentos = [];
  let perderRespuesta = true;
  await pagina.route('**/api/v1/movimientos/sincronizar', async ruta => {
    if (!perderRespuesta) return ruta.continue();
    intentos.push(Date.now());
    await ruta.fetch(); // El servidor confirma; se pierde solamente la respuesta al celular.
    await ruta.abort('failed');
  });
  await direccion(guiaRespuestaPerdida);
  await pagina.getByLabel('Tipo de movimiento').selectOption('salida_ruta');
  await pagina.getByRole('button', { name: 'Guardar escaneo', exact: true }).click();
  await pagina.getByText('La sincronización se reanudará cuando cambie la red.', { exact: true }).waitFor({ timeout: 35000 });
  assert.equal(intentos.length, 4, 'petición original y tres reintentos');
  for (let i = 1; i < 4; i++) assert.ok(intentos[i] - intentos[i - 1] >= 2000 * 2 ** (i - 1) * 0.8 - 100);
  assert.equal((await cola()).length, 1, 'conserva el UUID aunque el servidor ya guardó el movimiento');
  await dormir(1500);
  assert.equal(intentos.length, 4, 'espera un cambio de red tras agotar los reintentos');
  perderRespuesta = false;
  await contexto.setOffline(true);
  await contexto.setOffline(false);
  await hasta(async () => assert.equal((await cola()).length, 0));
  await hasta(async () => {
    const vista = await http('tracking/' + guiaRespuestaPerdida + '/detalle', cliente.token);
    assert.equal(vista.historial.filter(m => m.tipo === 'salida_ruta').length, 1);
  });
  console.log('✓ Respuesta perdida: reintentos 2/4/8 s con jitter, espera de red y un solo movimiento');
} finally {
  await browser.close();
}
