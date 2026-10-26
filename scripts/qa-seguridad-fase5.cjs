/* ============================================================================
   scripts/qa-seguridad-fase5.cjs — batería de SEGURIDAD de la Fase 5
   (hallazgos C1, C2, C3, C4 + W4 de la auditoría). AUTOCONTENIDA: la propia
   batería arranca y apaga sus servers de prueba (no necesita uno corriendo).

   Qué valida:
     C1 · arranque fail-closed: sin JWT_SECRET con NODE_ENV≠development
          (y con NODE_ENV ausente) el proceso muere (exit≠0 + FATAL en stderr);
          JWT_SECRET débil (<32 chars o con "cambiar") también.
     C2 · sin DEV_EXPOSE_CODES la API NO revela OTP/tokens (sin dev.*) ni
          los mocks imprimen códigos en consola.
     C3 · deny-by-default: /ORDENES, /Ordenes, /VEHICULOS (mayúsculas) → 401;
          health público y mínimo ({ok}); rutas de negocio sin token → 401.
     C4 · aislamiento multi-tenant: dos talleres; A no ve nada de B;
          recurso ajeno → 404 SIEMPRE (nunca 403); UNIQUE compuestos:
          el mismo DNI y la misma patente pueden existir en talleres
          distintos; B no puede crear ordenes sobre un vehículo de A.
     C5 · PUT /profile identidad sin passwordActual → 403 con el mensaje
          exacto de reautenticación.
     W4 · '+549…' y '549…' son la MISMA clave de cuenta (el otp pedido con
          '+' se consume sin '+'); la fila queda guardada sin '+'.

   Uso:  node scripts/qa-seguridad-fase5.cjs          (QA_PORT para otro puerto)
   Sale 0 en verde; 1 con los fallos listados.
   ============================================================================ */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.QA_PORT || 3998;
const BASE = 'http://127.0.0.1:' + PORT + '/api/v1';
const NODE = process.execPath;
const RAIZ = path.join(__dirname, '..');
const DB = path.join('data', 'qa-seguridad-fase5.sqlite');

let ok = 0, mal = 0;
function chequear(nombre, cond, extra) {
  if (cond) { ok++; console.log('OK   ' + nombre); }
  else { mal++; console.log('FALLA ' + nombre + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); }
}

const espera = (ms) => new Promise((res) => setTimeout(res, ms));

async function req(metodo, ruta, cuerpo, token) {
  const init = { method: metodo, headers: { 'Content-Type': 'application/json' } };
  if (cuerpo !== undefined) init.body = JSON.stringify(cuerpo);
  if (token) init.headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + ruta, init);
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, j: json };
}

/* Arranqua un server de prueba (mismo node, env a medida) y devuelve el child.
   Captura salida para poder cotejar que NO se filtro nada por consola (C2). */
function arrancarServer(envExtra) {
  return spawn(NODE, ['server.js'], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DB_PATH: DB,
      NODE_ENV: 'development',
      AUTH_OTP_REENVIO_MS: '300',
      /* vaciar secretos/flags heredados de la sesión */
      JWT_SECRET: '',
      DEV_EXPOSE_CODES: ''
    }, envExtra),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function salidaAcumulada(child) {
  const trozos = [];
  if (child.stdout) trozos.push(child.stdout.read() || '');
  if (child.stderr) trozos.push(child.stderr.read() || '');
  return trozos.join('');
}

async function esperarHealth(child, intentos) {
  for (let i = 0; i < (intentos || 60); i++) {
    try {
      const r = await req('GET', '/health');
      if (r.status === 200) return true;
    } catch (e) { /* aún no escucha */ }
    if (child.exitCode !== null) return false;
    await espera(250);
  }
  return false;
}

function matar(child) {
  try { child.kill(); } catch (e) { /* ya murió */ }
}

async function main() {
  /* ================================================= C1: arranque fail-closed */
  console.log('- C1 · secreto JWT fail-closed -');

  const casosC1 = [
    { nombre: 'NODE_ENV=production sin JWT_SECRET → exit≠0', env: { NODE_ENV: 'production' }, seguro: false },
    { nombre: 'NODE_ENV ausente sin JWT_SECRET → exit≠0 (estrito)', env: { NODE_ENV: '' }, seguro: false },
    { nombre: 'JWT_SECRET débil (corto, "cambiar") → exit≠0', env: { NODE_ENV: 'production', JWT_SECRET: 'clavedeprueba-cambiar' }, seguro: false }
  ];
  casosC1.forEach(function (caso) {
    /* la prueba real es un arranque entero del server (fail-closed esperado) */
    const arranque = spawnSync(NODE, ['server.js'], {
      cwd: RAIZ,
      env: Object.assign({}, process.env, caso.env, { DB_PATH: DB }),
      timeout: 15000,
      encoding: 'utf8'
    });
    chequear(caso.nombre, arranque.status !== 0 && /FATAL/.test((arranque.stderr || '') + (arranque.stdout || '')), {
      exit: arranque.status, stderr: (arranque.stderr || '').slice(0, 160)
    });
  });

  /* y el camino feliz de desarrollo: sin JWT_SECRET ARRANCA (clave efímera) */
  const devSinSecret = arrancarServer({});
  const devArranco = await esperarHealth(devSinSecret);
  matar(devSinSecret);
  chequear('NODE_ENV=development sin JWT_SECRET → SÍ arranca (clave efímera)', devArranco, 'no escuchó');

  /* ===================================== C2: sin DEV_EXPOSE_CODES no hay dev.* */
  console.log('- C2 · OTP/tokens fuera de respuestas y logs -');

  const s2 = arrancarServer({});
  const listo2 = await esperarHealth(s2);
  let salidaAcum2 = '';
  if (listo2) {
    let r = await req('POST', '/auth/request-otp', { telefono: '5491230000041' });
    chequear('request-otp SIN flag → 200 y SIN dev.otp', r.status === 200 && !(r.j && r.j.dev), r.j);

    r = await req('POST', '/auth/olvide-password', { email: 'nadie-fase5@taller.com' });
    chequear('olvide-password SIN flag → 200 y SIN dev.token', r.status === 200 && !(r.j && r.j.dev), r.j);

    r = await req('POST', '/auth/register', { metodo: 'email', email: 'qa5.c2@taller.com', password: 'clave-c2-7777', nombre: 'QA', apellido: 'Cinco Dos' });
    chequear('register SIN flag → 201 y SIN dev.*', r.status === 201 && !(r.j && r.j.dev), r.j);

    /* los mocks de consola no imprimen OTP ni tokens */
    await espera(400);
    salidaAcum2 = salidaAcumulada(s2);
    chequear('consola SIN códigos (sin "OTP:" ni "token de restablecimiento")',
      !/OTP:/.test(salidaAcum2) && !/token de restablecimiento/.test(salidaAcum2),
      salidaAcum2.slice(-400));
  }
  matar(s2);
  chequear('el server de la sección C2 quedó vivo toda la prueba', listo2, null);

  /* ============================ C3: deny-by-default (mayúsculas incluidas) === */
  console.log('- C3 · autenticación global sin bypass -');

  const s3 = arrancarServer({ DEV_EXPOSE_CODES: 'true' });
  const listo3 = await esperarHealth(s3);
  if (listo3) {
    let r = await req('GET', '/ORDENES/x');
    chequear('GET /ORDENES/x (mayúsculas) → 401', r.status === 401, r);
    r = await req('GET', '/Ordenes/x');
    chequear('GET /Ordenes/x (Cap+min) → 401', r.status === 401, r);
    r = await req('GET', '/VEHICULOS');
    chequear('GET /VEHICULOS → 401', r.status === 401, r);
    r = await req('GET', '/Clientes');
    chequear('GET /Clientes → 401', r.status === 401, r);
    r = await req('POST', '/ordenes', { vehiculoId: 'x' });
    chequear('POST /ordenes sin token → 401', r.status === 401, r);
    r = await req('GET', '/health');
    chequear('health → 200 y cuerpo mínimo {ok} (sin driver/db)',
      r.status === 200 && r.j && r.j.ok === true && Object.keys(r.j).length === 1, r.j);

    /* C5 (mensaje exacto) usando una cuenta con contraseña */
    r = await req('POST', '/auth/register', { metodo: 'email', email: 'qa5.c5@taller.com', password: 'clave-c5-8888', nombre: 'QA', apellido: 'Cinco Cinco' });
    const tokenC5 = r.j.token;
    r = await req('PUT', '/auth/profile', { email: 'qa5.c5b@taller.com' }, tokenC5);
    chequear('C5: PUT email sin passwordActual → 403 + mensaje exacto',
      r.status === 403 && r.j.error && r.j.error.mensaje === 'Confirmá tu contraseña actual para cambiar email o teléfono', r.j);
  }
  matar(s3);

  /* ==================================== C4: aislamiento multi-tenant + W4 ==== */
  console.log('- C4 · dos talleres, 404 (nunca 403) · W4 · el "+" no divide cuentas -');

  const s4 = arrancarServer({ DEV_EXPOSE_CODES: 'true' });
  const listo4 = await esperarHealth(s4);
  if (listo4) {
    let r = await req('POST', '/auth/register', { metodo: 'email', email: 'qa5.taller-a@taller.com', password: 'clave-qa5-a1', nombre: 'Taller', apellido: 'Alfa' });
    chequear('taller A registrado → token', r.status === 201 && !!r.j.token, r.j);
    const tokenA = r.j.token;

    /* datos del taller A */
    r = await req('POST', '/clientes', { nombre: 'Cliente de A', dni: '37111222' }, tokenA);
    chequear('A crea cliente → 201', r.status === 201, r.j);
    const idCliA = r.j.id;

    r = await req('POST', '/vehiculos', { patente: 'QA5AA99', clienteId: idCliA }, tokenA);
    chequear('A crea vehículo → 201', r.status === 201, r.j);
    const idVehA = r.j.id;

    r = await req('POST', '/ordenes', { vehiculoId: idVehA, km: 15000, manoObra: 800, tareas: [{ descripcion: 'Cambio de aceite' }] }, tokenA);
    chequear('A crea orden en su vehículo → 201', r.status === 201, r.j);
    const idOrdA = r.j.id;

    /* taller B */
    r = await req('POST', '/auth/register', { metodo: 'email', email: 'qa5.taller-b@taller.com', password: 'clave-qa5-b2', nombre: 'Taller', apellido: 'Bravo' });
    const tokenB = r.j.token;

    r = await req('GET', '/clientes', undefined, tokenB);
    chequear('B lista clientes → VACÍA (no ve a los de A)', r.status === 200 && Array.isArray(r.j) && r.j.length === 0, r.j);
    r = await req('GET', '/vehiculos', undefined, tokenB);
    chequear('B lista vehículos → VACÍA', r.status === 200 && Array.isArray(r.j) && r.j.length === 0, r.j);

    /* recurso ajeno → 404 SIEMPRE (nunca 403) */
    r = await req('GET', '/clientes/' + idCliA, undefined, tokenB);
    chequear('B lee cliente ajeno → 404', r.status === 404, r.j);
    r = await req('GET', '/vehiculos/' + idVehA, undefined, tokenB);
    chequear('B lee vehículo ajeno → 404', r.status === 404, r.j);
    r = await req('GET', '/vehiculos/' + idVehA + '/ordenes', undefined, tokenB);
    chequear('B lee ordenes del vehículo ajeno → 404', r.status === 404, r.j);
    r = await req('PUT', '/clientes/' + idCliA, { telefono: '54' }, tokenB);
    chequear('B edita cliente ajeno → 404', r.status === 404, r.j);
    r = await req('DELETE', '/clientes/' + idCliA, undefined, tokenB);
    chequear('B borra cliente ajeno → 404', r.status === 404, r.j);
    r = await req('PUT', '/vehiculos/' + idVehA, { km: 1 }, tokenB);
    chequear('B edita vehículo ajeno → 404', r.status === 404, r.j);
    r = await req('POST', '/vehiculos/' + idVehA + '/transferir', { sinTitular: true }, tokenB);
    chequear('B transfiere vehículo ajeno → 404', r.status === 404, r.j);
    r = await req('DELETE', '/vehiculos/' + idVehA, undefined, tokenB);
    chequear('B borra vehículo ajeno → 404', r.status === 404, r.j);
    r = await req('PUT', '/ordenes/' + idOrdA, { manoObra: 1 }, tokenB);
    chequear('B edita orden ajena → 404', r.status === 404, r.j);
    r = await req('DELETE', '/ordenes/' + idOrdA, undefined, tokenB);
    chequear('B borra orden ajena → 404', r.status === 404, r.j);
    r = await req('POST', '/ordenes', { vehiculoId: idVehA, manoObra: 1, tareas: [{ descripcion: 'x' }] }, tokenB);
    chequear('B crea orden SOBRE vehículo ajeno → 404', r.status === 404, r.j);

    /* unicidad COMPUESTA: el mismo DNI y la misma patente viven en los 2 talleres */
    r = await req('POST', '/clientes', { nombre: 'Cliente de B (mismo DNI)', dni: '37111222' }, tokenB);
    chequear('B crea cliente con el MISMO DNI que A → 201 (UNIQUE por taller)', r.status === 201, r.j);
    const idCliB = r.j.id;
    r = await req('POST', '/vehiculos', { patente: 'QA5AA99', clienteId: idCliB }, tokenB);
    chequear('B crea vehículo con la MISMA patente que A → 201 (UNIQUE por taller)', r.status === 201, r.j);
    const idVehB = r.j.id;

    /* A tampoco ve lo de B */
    r = await req('POST', '/clientes', { nombre: 'Duplicado interno', dni: '37111222' }, tokenA);
    chequear('A duplica SU PROPIO DNI → 409 (internal unique por taller)', r.status === 409, r.j);
    r = await req('POST', '/vehiculos', { patente: 'QA5AA99', sinTitular: true }, tokenA);
    chequear('A duplica SU PROPIA patente → 409', r.status === 409, r.j);
    r = await req('PUT', '/vehiculos/' + idVehB, { km: 1 }, tokenA);
    chequear('A edita vehículo de B → 404', r.status === 404, r.j);

    /* por la chapa, B también recibe cliente de A si pide su id directo (404 ya probado) */
    r = await req('GET', '/vehiculos?patente=QA5AA99', undefined, tokenB);
    chequear('B filtra por la chapa compartida → sólo SU vehículo', r.status === 200 && r.j.length === 1 && r.j[0].id === idVehB, r.j);

    /* ------------------------------- W4: el '+' es invisible para la clave ---- */
    const telW4 = '5491230000042';
    r = await req('POST', '/auth/request-otp', { telefono: '+' + telW4 });
    const otpW4 = r.j && r.j.dev && r.j.dev.otp;
    chequear('request-otp CON "+" → 200 + dev.otp', r.status === 200 && !!otpW4, r.j);
    r = await req('POST', '/auth/verify-otp', { telefono: telW4, otp: otpW4, password: 'clave-w4-3333' });
    chequear('verify-otp SIN "+" consume el OTP pedido CON "+" → 200', r.status === 200 && !!r.j.token, r.j);
    chequear('usuario queda con teléfono sin "+"', r.j && r.j.usuario && r.j.usuario.telefono === telW4, r.j.usuario);
  }
  matar(s4);
  chequear('la batería completa corrió con server vivo', listo4, null);

  console.log('\n' + (mal ? 'FALLOS: ' + mal : 'TODO OK') + ' — ' + ok + ' checks verdes, ' + mal + ' rojos');
  process.exit(mal ? 1 : 0);
}

main().catch(function (e) {
  console.error('ERROR general de la batería:', e);
  process.exit(1);
});
