/* ============================================================================
   scripts/qa-auth-fase3.cjs — batería de Fase 3 de autenticación:
   confirmación de contraseña en registro (front), ojo de visibilidad (front)
   y el flujo de CAMBIO DE CONTRASEÑA POR ENLACE DE EMAIL:

     · POST /auth/request-password-reset-email  (protegido por sesión)
         sin sesión → 401 · sin email vinculado → 400 · con email → 200 con
         dev.enlace = {FRONT_URL}#reset-password?token=... (desarrollo)
     · POST /auth/confirm-password-reset { token, newPassword }
         token inválido → 400 · token vencido/ya usado → 400 (one-shot) ·
         contraseña corta → 400 · válido → 200 y login con la nueva clave.

   Arranque del server para la prueba (DB aparte, anti-spam acelerado):
     Windows PowerShell:
       $env:PORT='3999'; $env:DB_PATH='./data/qa-fase3.sqlite';
       $env:NODE_ENV='development'; $env:AUTH_OTP_REENVIO_MS='300';
       node server.js
   Luego:   node scripts/qa-auth-fase3.cjs        (QA_PORT para otro puerto)
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

async function main() {
  const h = await req('GET', '/health');
  chequear('health público responde 200', h.status === 200, h);

  /* ---------------------------------------------------- 1) cuenta de regalo */
  let r = await req('POST', '/auth/register', {
    metodo: 'email', email: 'qa.fase3@taller.com',
    password: 'clave123', nombre: 'QA', apellido: 'Fase Tres', nombreTaller: 'QA Fase3 Taller'
  });
  chequear('register email → 201 + token (PASSWORD_MIN=6 permite clave de 8)', r.status === 201 && Boolean(r.j.token), r.j);
  const tokenUsuario = r.j.token;

  r = await req('POST', '/auth/register', { metodo: 'email', email: 'qa.f3corta@taller.com', password: 'corta', nombre: 'QA', apellido: 'Corta' });
  chequear('register con contraseña de 5 → 400 (mínimo 6)', r.status === 400, r.j);

  /* --------------------------------------------- 2) request SIN sesión → 401 */
  r = await req('POST', '/auth/request-password-reset-email', {});
  chequear('request-password-reset-email sin sesión → 401', r.status === 401, r);

  r = await req('POST', '/auth/request-password-reset-email', {}, 'token-basura.xyz.aaa');
  chequear('request-password-reset-email con token inválido → 401', r.status === 401, r.status);

  /* ------------------------------------------ 3) request con sesión sin email */
  const tel = '5499000000031';
  r = await req('POST', '/auth/register', { metodo: 'telefono', telefono: tel, password: 'clave123', nombre: 'QA', apellido: 'Sin Email', nombreTaller: 'QA OTP Sin Email' });
  const otp1 = r.j.dev && r.j.dev.otp;
  r = await req('POST', '/auth/verify-otp', { telefono: tel, otp: otp1, password: 'clave123' });
  chequear('cuenta OTP-only registrada y verificada', r.status === 200 && Boolean(r.j.token), r.j);
  const tokenSinEmail = r.j.token;

  r = await req('POST', '/auth/request-password-reset-email', {}, tokenSinEmail);
  chequear('request con sesión SIN email → 400 con aviso de perfil',
    r.status === 400 && /email/i.test(r.j.error.mensaje), r.j);

  /* ------------------------------------- 4) request con email → dev.enlace */
  r = await req('POST', '/auth/request-password-reset-email', {}, tokenUsuario);
  chequear('request con sesión y email → 200', r.status === 200, r.j);
  const enlace = r.j.dev && r.j.dev.enlace;
  chequear('dev.enlace presente en desarrollo', Boolean(enlace), r.j);
  chequear('el enlace apunta a la vista raíz reset con token',
    /#reset-password\?token=[a-f0-9]{16,}/.test(enlace || ''), enlace);
  const tokenEnlace = enlace.split('token=')[1];

  r = await req('POST', '/auth/request-password-reset-email', {}, tokenUsuario);
  chequear('2º request inmediato (sin cooldown) → 200 con token distinto',
    r.status === 200 && r.j.dev && r.j.dev.token !== tokenEnlace, r.j && r.j.dev);

  /* --------------------------------------- 5) confirm-password-reset */
  r = await req('POST', '/auth/confirm-password-reset', { token: 'falso-token-abc', newPassword: 'nueva123' });
  chequear('confirm con token inexistente → 400', r.status === 400, r.j);

  r = await req('POST', '/auth/confirm-password-reset', { token: tokenEnlace, newPassword: '12345' });
  chequear('confirm con contraseña corta (5) → 400 mínimo 6', r.status === 400, r.j);

  r = await req('POST', '/auth/confirm-password-reset', { token: tokenEnlace, newPassword: 'nuevaClave9' });
  chequear('confirm válido → 200 ok', r.status === 200 && r.j.ok, r.j);

  r = await req('POST', '/auth/confirm-password-reset', { token: tokenEnlace, newPassword: 'reuso-token-1' });
  chequear('confirm con token ya usado → 400 (one-shot)', r.status === 400, r.j);

  r = await req('POST', '/auth/login', { email: 'qa.fase3@taller.com', password: 'nuevaClave9' });
  chequear('login con la contraseña nueva → 200', r.status === 200 && Boolean(r.j.token), r.j);

  r = await req('POST', '/auth/login', { email: 'qa.fase3@taller.com', password: 'clave123' });
  chequear('la contraseña vieja ya NO entra → 401', r.status === 401, r.status);

  /* ------------------- 6) reset vía token del email público sigue vivo (F2) */
  r = await req('POST', '/auth/olvide-password', { email: 'qa.fase3@taller.com' });
  const tokPub = r.j.dev && r.j.dev.token;
  r = await req('POST', '/auth/reset-password', { via: 'token', token: tokPub, password: 'otra-mp Mini9' });
  chequear('regresión: /reset-password via token sigue funcionando', r.status === 200 && r.j.ok, r.j);

  console.log('\nRESULTADO: ' + (mal ? 'ROJO (' + mal + ' fallos)' : 'GREEN') + ' — ' + ok + ' checks OK');
  process.exit(mal ? 1 : 0);
}

main().catch(function (e) {
  console.error('BATERÍA abortada: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
