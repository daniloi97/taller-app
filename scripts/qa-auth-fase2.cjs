/* ============================================================================
   scripts/qa-auth-fase2.cjs — batería de Fase 2 de autenticación:
   registro dual (email / tel+OTP), login email+contraseña con bloqueo a
   los 3 intentos, cuota de OTP (2/mes con mensaje según email), reset vía
   OTP y vía token de email, perfil (GET/PUT) y migración de la tabla
   usuarios de una base Fase 1.

   Arranque del server para la prueba (DB aparte, anti-spam acelerado):
     Windows PowerShell:
       $env:PORT='3999'; $env:DB_PATH='./data/qa-fase2.sqlite';
       $env:NODE_ENV='development'; $env:AUTH_OTP_REENVIO_MS='300';
       node server.js
   Luego:   node scripts/qa-auth-fase2.cjs        (QA_PORT para otro puerto)
   Sale 0 en verde; 1 con los fallos listados.
   ============================================================================ */
'use strict';

const BASE = 'http://127.0.0.1:' + (process.env.QA_PORT || 3999) + '/api/v1';
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ_APP = path.join(__dirname, '..');
let ok = 0, mal = 0;
function chequear(nombre, cond, extra) {
  if (cond) { ok++; console.log('OK   ' + nombre); }
  else { mal++; console.log('FALLA ' + nombre + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); }
}
const espera = (ms) => new Promise(r => setTimeout(r, ms));

async function req(metodo, ruta, cuerpo, token) {
  const init = { method: metodo, headers: { 'Content-Type': 'application/json' } };
  if (cuerpo !== undefined) init.body = JSON.stringify(cuerpo);
  if (token) init.headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + ruta, init);
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, j: json };
}

/* --------------------------------------------------------- 1) migración --- */
/* Crea una DB "de Fase 1" (usuarios viejos, sin las columnas nuevas) con un
   child aparte; luego otro child hace require('./db') — que aplica schema +
   migración al boot — y devuelve las columnas y la fila conservada. */
function correrChild(codigo) {
  return execFileSync(process.execPath, ['-e', codigo], {
    cwd: RAIZ_APP, encoding: 'utf8',
    env: Object.assign({}, process.env, { DB_PATH: path.join(RAIZ_APP, 'data', 'qa-migracion.sqlite') })
  });
}
function probarMigracion() {
  const fs = require('fs');
  ['qa-migracion.sqlite', 'qa-migracion.sqlite-wal', 'qa-migracion.sqlite-shm'].forEach(function (f) {
    try { fs.unlinkSync(path.join(RAIZ_APP, 'data', f)); } catch (e) { /* nada */ }
  });

  correrChild([
    "const Database = require('better-sqlite3');",
    'const db = new Database(process.env.DB_PATH);',
    "db.exec(\"CREATE TABLE IF NOT EXISTS usuarios (id VARCHAR(36) NOT NULL, telefono VARCHAR(30) NOT NULL, nombre_taller VARCHAR(120), rol VARCHAR(20) DEFAULT 'admin', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, CONSTRAINT pk_usuarios PRIMARY KEY (id), CONSTRAINT ck_usuarios_telefono CHECK (telefono <> ''))\");",
    'db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_telefono ON usuarios (telefono)");',
    "db.prepare(\"INSERT INTO usuarios (id, telefono, nombre_taller) VALUES ('uuid-viejo-1', '5496000000009', 'Taller Fase 1')\").run();",
    'db.close();'
  ].join('\n'));

  const salida = correrChild([
    "require('./db');",
    "const d = require('better-sqlite3')(process.env.DB_PATH);",
    "const cols = d.prepare('PRAGMA table_info(usuarios)').all().map(c => c.name);",
    "const fila = d.prepare('SELECT * FROM usuarios WHERE id = ?').get('uuid-viejo-1');",
    "const uNueva = d.prepare(\"SELECT COUNT(*) AS n FROM usuarios WHERE otp_conteo_mes IS NOT NULL\").get();",
    'console.log(JSON.stringify({ cols: cols, fila: fila, ######## reservado: uNueva }));',
    'd.close();'
  ].join('\n').replace(' ######## reservado: uNueva ', ' chk: uNueva.n '));

  const cols = salidaPorLinea(salida);
  return JSON.parse(cols.trim());
}

/* El boot del child loguea la migración por stdout; el JSON va en la última línea */
function salidaPorLinea(salida) {
  const lineas = salida.trim().split(/\r?\n/);
  return lineas[lineas.length - 1];
}

/* ------------------------------------------------------------------ main -- */
async function main() {
  const h = await req('GET', '/health');
  chequear('health público responde 200', h.status === 200, h);

  /* -------------------------------------------------- 2) migración Fase 1 */
  const mig = probarMigracion();
  ['email', 'password_hash', 'otp_conteo_mes', 'otp_ultimo_reset', 'intentos_fallidos'].forEach(function (col) {
    chequear('migración: columna ' + col + ' agregada a usuarios Fase 1', mig.cols.indexOf(col) >= 0, mig.cols);
  });
  chequear('migración: la fila vieja sobrevivió', mig.fila && mig.fila.telefono === '5496000000009', mig.fila);
  chequear('migración: la fila vieja quedó con intentos_fallidos = 0', mig.fila && Number(mig.fila.intentos_fallidos) === 0, mig.fila);

  /* ------------------------------------------- 3) registro dual: email --- */
  let r = await req('POST', '/auth/register', { metodo: 'email', email: 'qa.fase2@taller.com', password: 'clave-qa-1234', nombre: 'QA', apellido: 'Fase Dos', nombreTaller: 'QA Fase2 Taller' });
  chequear('register email → 201 + token JWT', r.status === 201 && typeof r.j.token === 'string' && r.j.token.split('.').length === 3, r.j);
  chequear('register email → usuario con email y sin password_hash en la respuesta',
    r.j && r.j.usuario && r.j.usuario.email === 'qa.fase2@taller.com' && !('password_hash' in r.j.usuario), r.j);
  chequear('register email → cuota visible 0/2', r.j && r.j.usuario.cuotaOtp && r.j.usuario.cuotaOtp.usados === 0, r.j);

  r = await req('POST', '/auth/register', { metodo: 'email', email: 'qa.fase2@taller.com', password: 'otra-clave-999', nombre: 'QA', apellido: 'Fase Dos' });
  chequear('register email duplicado → 409', r.status === 409, r.j);

  r = await req('POST', '/auth/register', { metodo: 'email', email: 'corta@taller.com', password: '123', nombre: 'QA', apellido: 'Corta' });
  chequear('register con contraseña corta → 400', r.status === 400, r.j);

  r = await req('POST', '/auth/register', { metodo: 'palomita', email: 'x@taller.com', password: '12345678', nombre: 'QA', apellido: 'Palomita' });
  chequear('register con método inventado → 400', r.status === 400, r.j);

  /* ------------------------------------ 4) login email + bloqueo 3 errores */
  r = await req('POST', '/auth/login', { email: 'qa.fase2@taller.com', password: 'clave-qa-1234' });
  chequear('login email OK → 200 + token', r.status === 200 && Boolean(r.j.token), r.j);
  const tokenUser1 = r.j.token;

  r = await req('POST', '/auth/login', { email: 'qa.fase2@taller.com', password: 'incorrecta' });
  chequear('login 1er error → 401 "Intentos restantes: 2"', r.status === 401 && /Intentos restantes: 2/.test(r.j.error.mensaje), r.j);

  r = await req('POST', '/auth/login', { email: 'qa.fase2@taller.com', password: 'incorrecta' });
  chequear('login 2º error → 401 "Intentos restantes: 1"', r.status === 401 && /Intentos restantes: 1/.test(r.j.error.mensaje), r.j);

  r = await req('POST', '/auth/login', { email: 'qa.fase2@taller.com', password: 'incorrecta' });
  chequear('login 3er error → 403 forceReset:true', r.status === 403 && r.j.forceReset === true, r.j);
  chequear('403 mensaje exacto de bloqueo',
    r.j.error && r.j.error.mensaje === 'Demasiados intentos fallidos. Debes restablecer tu contraseña.', r.j.error);

  /* Bloqueo vigente: ni la contraseña CORRECTA entra (sale con reset) */
  r = await req('POST', '/auth/login', { email: 'qa.fase2@taller.com', password: 'clave-qa-1234' });
  chequear('login correcto tras bloqueo → sigue 403 forceReset', r.status === 403 && r.j.forceReset === true, r.j);

  /* ------------------------------------------ 5) reset por token de email */
  r = await req('POST', '/auth/olvide-password', { email: 'qa.fase2@taller.com' });
  chequear('olvide-password → 200 + dev.token (desarrollo)', r.status === 200 && r.j.dev && r.j.dev.token, r.j);
  const tokenReset = r.j.dev.token;

  r = await req('POST', '/auth/reset-password', { via: 'token', token: tokenReset, password: 'nueva-clave-77' });
  chequear('reset via token → 200 ok', r.status === 200 && r.j.ok, r.j);

  r = await req('POST', '/auth/login', { email: 'qa.fase2@taller.com', password: 'nueva-clave-77' });
  chequear('login con la contraseña nueva → 200 (bloqueo limpiado)', r.status === 200 && Boolean(r.j.token), r.j);

  r = await req('POST', '/auth/reset-password', { via: 'token', token: tokenReset, password: 'reuso-de-token-1' });
  chequear('reset con token ya usado → 400 (one-shot)', r.status === 400, r.j);

  r = await req('POST', '/auth/olvide-password', { email: 'nadie-aca@taller.com' });
  chequear('olvide-password con email desconocido → 200 SIN dev.token (no enumera)',
    r.status === 200 && !r.j.dev, r.j);

  /* ------------------------------- 6) registro por teléfono + OTP (dual) */
  r = await req('POST', '/auth/register', { metodo: 'telefono', telefono: '5497000000001', password: 'clave-otp-1234', nombre: 'QA', apellido: 'Otp Uno', nombreTaller: 'QA OTP Taller' }); //gitleaks:allow
  chequear('register teléfono → necesitaVerificacion', r.status === 200 && r.j.necesitaVerificacion === true, r.j);
  const otpReg = r.j.dev && r.j.dev.otp;

  r = await req('POST', '/auth/verify-otp', { telefono: '5497000000001', otp: otpReg, password: 'clave-otp-1234', nombreTaller: 'QA OTP Taller' }); //gitleaks:allow
  chequear('verify-otp con password → 200 + token', r.status === 200 && Boolean(r.j.token) && r.j.usuario.nombreTaller === 'QA OTP Taller', r.j);
  chequear('verify crea la cuota en 1/2 (contó el envío del registro)', r.j.usuario.cuotaOtp.usados === 1, r.j.usuario);
  const tokenUser2 = r.j.token;

  /* --------------------- 7) cuota OTP 2/mes: mensajes según cuenta email */
  await espera(450);   /* auth OTP anti-spam acelerado en QA */
  r = await req('POST', '/auth/request-otp', { telefono: '5497000000001' });
  chequear('cuota 2/2: 2º envío OK (usados=2)', r.status === 200 && r.j.cuotaOtp.usados === 2, r.j);

  await espera(450);
  r = await req('POST', '/auth/request-otp', { telefono: '5497000000001' });
  chequear('cuota agotada sin email → 429 soporte@taller.com', r.status === 429 &&
    r.j.error.mensaje === 'Límite de solicitudes alcanzado. Contacta a soporte: soporte@taller.com', r.j.error);

  /* Vincular email vía perfil (usuario 2 tiene token del verify).
     C5: cambiar identidad exige la contraseña actual (de verify-otp). */
  r = await req('PUT', '/auth/profile', { email: 'qa.otp2@taller.com', passwordActual: 'clave-otp-1234' }, tokenUser2); //gitleaks:allow
  chequear('PUT profile → email vinculado (C5: passwordActual OK)', r.status === 200 && r.j.usuario.email === 'qa.otp2@taller.com', r.j);

  /* nueva sesión con la versión actualizada (el email cambió, el token existe) */
  const p1 = await req('GET', '/auth/profile', undefined, tokenUser2);
  chequear('GET profile → datos frescos con el email vinculado', p1.status === 200 && p1.j.usuario.email === 'qa.otp2@taller.com', p1.j);

  await espera(450);
  r = await req('POST', '/auth/request-otp', { telefono: '5497000000001' });
  chequear('cuota agotada CON email → 429 "Utiliza la recuperación por email."', r.status === 429 &&
    r.j.error.mensaje === 'Límite de SMS/WhatsApp alcanzado. Utiliza la recuperación por email.', r.j.error);

  /* ---------------------------------------------- 8) perfil (GET / PUT) */
  r = await req('GET', '/auth/profile');
  chequear('GET profile sin token → 401', r.status === 401, r.status);

  r = await req('GET', '/auth/profile', undefined, tokenUser1);
  chequear('GET profile → usuario + cuota', r.status === 200 && r.j.usuario && r.j.usuario.cuotaOtp.limite === 2, r.j);

  /* C5: sin passwordActual NO se llega ni a la unicidad → 403 */
  r = await req('PUT', '/auth/profile', { email: 'qa.fase2@taller.com' }, tokenUser2);
  chequear('PUT profile con email ajeno SIN passwordActual → 403 reauth', r.status === 403, r.j);

  r = await req('PUT', '/auth/profile', { email: 'qa.fase2@taller.com', passwordActual: 'clave-bad-999' }, tokenUser2); //gitleaks:allow
  chequear('PUT profile con passwordActual incorrecta → 403', r.status === 403, r.j);

  r = await req('PUT', '/auth/profile', { email: 'qa.fase2@taller.com', passwordActual: 'clave-otp-1234' }, tokenUser2); //gitleaks:allow
  chequear('PUT profile con email ajeno + passwordActual OK → 409', r.status === 409, r.j);

  r = await req('PUT', '/auth/profile', { nombreTaller: 'QA Fase2 Taller Editado' }, tokenUser1);
  chequear('PUT profile nombre del taller → cambia y vuelve', r.status === 200 &&
    r.j.usuario.nombreTaller === 'QA Fase2 Taller Editado', r.j);

  /* ------------------------------- 9) reset por OTP (el otro camino) */
  r = await req('POST', '/auth/register', { metodo: 'telefono', telefono: '5497000000002', password: 'clave-otp-02aa', nombre: 'QA', apellido: 'Otp Dos', nombreTaller: 'QA OTP Dos' });
  await espera(450);
  const otp2 = r.j.dev && r.j.dev.otp;
  r = await req('POST', '/auth/verify-otp', { telefono: '5497000000002', otp: otp2, password: 'clave-otp-02aa' });
  chequear('register teléfono 2 verificado', r.status === 200 && Boolean(r.j.token), r.j);
  const tokenUser3 = r.j.token;

  r = await req('PUT', '/auth/profile', { email: 'qa.otp3@taller.com', passwordActual: 'clave-otp-02aa' }, tokenUser3); //gitleaks:allow
  chequear('usuario 3 con email vinculado (C5 OK)', r.status === 200 && r.j.usuario.email === 'qa.otp3@taller.com', r.j);

  await espera(450);   /* este usuario comió 1 envío por el registro */
  r = await req('POST', '/auth/request-otp', { telefono: '5497000000002' });
  chequear('usuario 3: 2º envío del mes OK', r.status === 200, r.j);
  const otpReset = r.j.dev.otp;

  r = await req('POST', '/auth/reset-password', { via: 'otp', telefono: '5497000000002', otp: otpReset, password: 'reset-otp-9999' });
  chequear('reset via OTP → 200 ok', r.status === 200 && r.j.ok, r.j);

  r = await req('POST', '/auth/login', { email: 'qa.otp3@taller.com', password: 'reset-otp-9999' });
  chequear('login con la contraseña del reset por OTP → 200', r.status === 200 && Boolean(r.j.token), r.j);

  console.log('\nRESULTADO: ' + (mal ? 'ROJO (' + mal + ' fallos)' : 'GREEN') + ' — ' + ok + ' checks OK');
  process.exit(mal ? 1 : 0);
}

main().catch(function (e) {
  console.error('BATERÍA abortada: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
