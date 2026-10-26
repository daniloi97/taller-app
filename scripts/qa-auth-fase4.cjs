/* ============================================================================
   scripts/qa-auth-fase4.cjs — batería de Fase 4 de autenticación:
   identidad personal (nombre/apellido) + teléfono argentino (+54 9, 10
   dígitos, normalización a 549…) probada contra el backend:

     · POST /auth/register
         sin nombre → 400 · sin apellido → 400 ·
         email → 201 y GET /auth/profile devuelve nombre + apellido ·
         telefono 5491123456789 → 201 (formato API, 13 dígitos).
     · POST /auth/verify-otp (flujo legado)
         crea la cuenta y persiste nombre/apellido si viajan en el body.
     · PUT /auth/profile
         nombre y apellido editables · solo uno de los dos no toca el otro ·
         teléfono 5491112345678 → 200 y queda en GET /profile.

   Arranque del server para la prueba (DB aparte, anti-spam acelerado):
     Windows PowerShell:
       $env:PORT='3999'; $env:DB_PATH='./data/qa-fase4.sqlite';
       $env:NODE_ENV='development'; $env:AUTH_OTP_REENVIO_MS='300';
       node server.js
   Luego:   node scripts/qa-auth-fase4.cjs        (QA_PORT para otro puerto)
   Sale 0 en verde; 1 con los fallos listados.
   ============================================================================ */
'use strict';

const BASE = 'http://127.0.0.1:' + (process.env.QA_PORT || 3999) + '/api/v1';

let ok = 0, mal = 0;
function chequear(nombre, cond, extra) {
  if (cond) { ok++; console.log('OK   ' + nombre); }
  else { mal++; console.log('FALLA ' + nombre + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); }
}

async function req(metodo, ruta, cuerpo, token) {
  const init = { method: metodo, headers: { 'Content-Type': 'application/json' } };
  if (cuerpo !== undefined) init.body = JSON.stringify(cuerpo);
  if (token) init.headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + ruta, init);
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, j: json };
}

const espera = (ms) => new Promise((res) => setTimeout(res, ms));

async function main() {
  const h = await req('GET', '/health');
  chequear('health público responde 200', h.status === 200, h);

  /* ----------------------- 1) /register exige nombre y apellido (Fase 4) --- */
  let r = await req('POST', '/auth/register', {
    metodo: 'email', email: 'qa.f4sinnombre@taller.com', password: 'clave123'
  });
  chequear('register SIN nombre → 400 (obligatorio, Fase 4)', r.status === 400, r.j);

  r = await req('POST', '/auth/register', {
    metodo: 'email', email: 'qa.f4sinapellido@taller.com', password: 'clave123', nombre: 'QA'
  });
  chequear('register SIN apellido → 400 (obligatorio, Fase 4)', r.status === 400, r.j);

  r = await req('POST', '/auth/register', {
    metodo: 'email', email: 'qa.f4largo@taller.com', password: 'clave123',
    nombre: 'N'.repeat(81), apellido: 'Apellido'
  });
  chequear('register con nombre de 81 caracteres → 400 (máx. 80)', r.status === 400, r.j);

  /* ------------------- 2) registro email completo → 201 + profile los trae - */
  r = await req('POST', '/auth/register', {
    metodo: 'email', email: 'qa.fase4@taller.com', password: 'clave-f4-1234',
    nombre: 'María', apellido: 'González', nombreTaller: 'QA F4 Taller'
  });
  chequear('register email CON nombre/apellido → 201 + token', r.status === 201 && Boolean(r.j.token), r.j);
  chequear('register → usuario público trae nombre/apellido',
    r.j && r.j.usuario && r.j.usuario.nombre === 'María' && r.j.usuario.apellido === 'González', r.j);

  const tokenMaria = r.j.token;
  r = await req('GET', '/auth/profile', undefined, tokenMaria);
  chequear('GET /auth/profile devuelve nombre + apellido',
    r.status === 200 && r.j && r.j.usuario && r.j.usuario.nombre === 'María'
    && r.j.usuario.apellido === 'González', r.j);

  /* ------------------------- 3) teléfono argentino: formato API 549 + 10 --- */
  r = await req('POST', '/auth/register', {
    metodo: 'telefono', telefono: '5491123456789', password: 'clave-f4-tel',
    nombre: 'Juan', apellido: 'Pérez', nombreTaller: 'QA F4 OTP'
  });
  chequear('register tel 5491123456789 → 200 + necesitaVerificacion',
    r.status === 200 && r.j && r.j.necesitaVerificacion === true, r.j);
  const otpJuan = r.j && r.j.dev && r.j.dev.otp;

  r = await req('POST', '/auth/verify-otp', {
    telefono: '5491123456789', otp: otpJuan, password: 'clave-f4-tel',
    nombre: 'Juan', apellido: 'Pérez', nombreTaller: 'QA F4 OTP'
  });
  chequear('verify-otp del registro tel → 200 + token', r.status === 200 && Boolean(r.j.token), r.j);
  chequear('verify-otp → usuario con nombre/apellido y teléfono completo',
    r.j && r.j.usuario && r.j.usuario.nombre === 'Juan' && r.j.usuario.apellido === 'Pérez'
    && r.j.usuario.telefono === '5491123456789', r.j);
  const tokenJuan = r.j.token;

  /* corta/larga fuera del rango del backend sigue rechazada */
  r = await req('POST', '/auth/register', {
    metodo: 'telefono', telefono: '5491123', password: 'clave-f4-x', nombre: 'Q', apellido: 'X'
  });
  chequear('register tel de 7 dígitos → 400', r.status === 400, r.j);

  /* ------------------ 4) verify-otp legado también persiste nombre/apellido - */
  r = await req('POST', '/auth/request-otp', { telefono: '5497369990401' });
  const otpDev = r.j && r.j.dev && r.j.dev.otp;
  chequear('request-otp → 200 con OTP en desarrollo', r.status === 200 && Boolean(otpDev), r.j);

  r = await req('POST', '/auth/verify-otp', {
    telefono: '5497369990401', otp: otpDev,
    nombre: 'Lucía', apellido: 'Fernández', password: 'clave-f4-otp'
  });
  chequear('verify-otp con nombre/apellido → 200 + token', r.status === 200 && Boolean(r.j.token), r.j);
  chequear('verify-otp → usuario público con nombre/apellido',
    r.j && r.j.usuario && r.j.usuario.nombre === 'Lucía' && r.j.usuario.apellido === 'Fernández', r.j);
  const tokenLucia = r.j.token;

  r = await req('GET', '/auth/profile', undefined, tokenLucia);
  chequear('GET /profile de la cuenta OTP-persistida trae nombre/apellido',
    r.status === 200 && r.j && r.j.usuario && r.j.usuario.nombre === 'Lucía', r.j);

  /* ---------------------- 5) PUT /profile: editar identidad personal -------- */
  r = await req('PUT', '/auth/profile', { nombre: 'María Elena' }, tokenMaria);
  chequear('PUT /profile nombre solo → 200', r.status === 200, r.j);
  r = await req('GET', '/auth/profile', undefined, tokenMaria);
  chequear('el nombre cambió y el apellido quedó intacto',
    r.j && r.j.usuario && r.j.usuario.nombre === 'María Elena' && r.j.usuario.apellido === 'González', r.j);

  r = await req('PUT', '/auth/profile',
    { nombre: 'Juan Carlos', apellido: 'Pérez Rossi' }, tokenJuan);
  chequear('PUT /profile nombre+apellido sin identidad (no pide reauth) → 200', r.status === 200, r.j);

  /* C5: cambiar email exige passwordActual (403 sin ella / con má) */
  r = await req('PUT', '/auth/profile', { email: 'qa.f4.juan@taller.com' }, tokenJuan);
  chequear('PUT /profile email SIN passwordActual → 403 reauth', r.status === 403, r.j);
  r = await req('PUT', '/auth/profile',
    { nombre: 'Juan Carlos', apellido: 'Pérez Rossi', email: 'qa.f4.juan@taller.com', passwordActual: 'clave-mala-00' }, tokenJuan); //gitleaks:allow
  chequear('PUT /profile email con passwordActual incorrecta → 403', r.status === 403, r.j);
  r = await req('PUT', '/auth/profile',
    { nombre: 'Juan Carlos', apellido: 'Pérez Rossi', email: 'qa.f4.juan@taller.com', passwordActual: 'clave-f4-tel' }, tokenJuan); //gitleaks:allow
  chequear('PUT /profile nombre+apellido+email (reauth OK) → 200', r.status === 200, r.j);
  r = await req('GET', '/auth/profile', undefined, tokenJuan);
  chequear('GET /profile refleja identidad personal editada',
    r.status === 200 && r.j && r.j.usuario && r.j.usuario.nombre === 'Juan Carlos'
    && r.j.usuario.apellido === 'Pérez Rossi' && r.j.usuario.email === 'qa.f4.juan@taller.com', r.j);

  r = await req('PUT', '/auth/profile',
    { nombre: 'N'.repeat(81) }, tokenLucia);
  chequear('PUT /profile nombre de 81 → 400', r.status === 400, r.j);

  r = await req('PUT', '/auth/profile', { nombre: '' }, tokenLucia);
  r = await req('GET', '/auth/profile', undefined, tokenLucia);
  chequear('PUT /profile nombre vacío no lo borra (queda "Lucía")',
    r.j && r.j.usuario && r.j.usuario.nombre === 'Lucía', r.j);

  /* ---------------------- 6) PUT /profile teléfono argentino --------------- */
  r = await req('PUT', '/auth/profile', { telefono: '5491133224466' }, tokenMaria);
  chequear('PUT /profile teléfono SIN passwordActual → 403 reauth', r.status === 403, r.j);
  r = await req('PUT', '/auth/profile', { telefono: '5491133224466', passwordActual: 'clave-f4-1234' }, tokenMaria); //gitleaks:allow
  chequear('PUT /profile teléfono 549… (reauth OK) → 200', r.status === 200, r.j);
  r = await req('GET', '/auth/profile', undefined, tokenMaria);
  chequear('GET /profile devuelve el teléfono actualizado',
    r.j && r.j.usuario && r.j.usuario.telefono === '5491133224466', r.j);

  r = await req('PUT', '/auth/profile', { telefono: '54911', passwordActual: 'clave-f4-1234' }, tokenMaria); //gitleaks:allow
  chequear('PUT /profile teléfono de 5 dígitos (reauth OK) → 400', r.status === 400, r.j);

  /* ---------------------- 7) regresión: flujo legado sigue completo -------- */
  await espera(450);
  r = await req('POST', '/auth/request-otp', { telefono: '5497369990401' });
  const otpDev2 = r.j && r.j.dev && r.j.dev.otp;
  chequear('request-otp reenvío (anti-spam ≥300ms) → 200', r.status === 200 && Boolean(otpDev2), r.j);
  r = await req('POST', '/auth/verify-otp', { telefono: '5497369990401', otp: otpDev2 });
  chequear('verify-otp SIN nombre (legado) → 200 + token', r.status === 200 && Boolean(r.j.token), r.j);

  r = await req('POST', '/auth/login', { email: 'qa.fase4@taller.com', password: 'clave-f4-1234' });
  chequear('login email de la cuenta F4 → 200 + token', r.status === 200 && Boolean(r.j.token), r.j);

  console.log('\n' + (mal ? 'FALLOS: ' + mal : 'TODO OK') + ' — ' + ok + ' checks verdes, ' + mal + ' rojos');
  process.exit(mal ? 1 : 0);
}

main().catch(function (e) {
  console.error('ERROR general de la batería:', e);
  process.exit(1);
});
