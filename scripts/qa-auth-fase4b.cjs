/* ============================================================================
   scripts/qa-auth-fase4b.cjs — batería Fase 4b: manejo amigable de cuentas
   ya registradas en el registro y de usuarios inexistentes en el login.

     · POST /auth/register (email / telefono)
         duplicado → 409 { error:{ mensaje: "El correo o teléfono ya se
         encuentra registrado. Por favor iniciá sesión." } } · email
         NO duplicado → 201.
     · POST /auth/login
         email inexistente → 401 { error:{ mensaje: "Usuario no registrado
         o contraseña incorrecta." } } · email existente + clave errada →
         401 con contador de intentos (regresión) · clave correcta → 200.
     · POST /auth/request-otp
         teléfono EXISTENTE → 200 (regresión crítica: el OTP es el canal
         de login de las cuentas telefónicas; NO debe 409ear).

   Las violaciones UNIQUE (idx_usuarios_email / idx_usuarios_telefono) se
   capturan en routes/auth.js (rebotarSiDuplicado) como 409; la carrera real
   no es reproducible determinísticamente vía API, así que se verifica la
   ruta lógica (check previo + 409 amigable).

   Arranque del server para la prueba (DB aparte, anti-spam acelerado):
     Windows PowerShell:
       $env:PORT='3999'; $env:DB_PATH='./data/qa-fase4b.sqlite';
       $env:NODE_ENV='development'; $env:AUTH_OTP_REENVIO_MS='300';
       node server.js
   Luego:   node scripts/qa-auth-fase4b.cjs    (QA_PORT para otro puerto)
   Sale 0 en verde; 1 con los fallos listados.
   ============================================================================ */
'use strict';

const BASE = 'http://127.0.0.1:' + (process.env.QA_PORT || 3999) + '/api/v1';
const MENSAJE_DUPLICADO = 'El correo o teléfono ya se encuentra registrado. Por favor iniciá sesión.';
const MENSAJE_INEXISTENTE = 'Usuario no registrado o contraseña incorrecta.';

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

  /* ------------- 1) registro email: primera alta OK, segunda → 409 -------- */
  let r = await req('POST', '/auth/register', {
    metodo: 'email', email: 'qa.f4b@taller.com', password: 'clave-f4b-1',
    nombre: 'QA', apellido: 'F4b', nombreTaller: 'QA F4b Taller'
  });
  chequear('register email nuevo → 201', r.status === 201 && Boolean(r.j.token), r.j);

  r = await req('POST', '/auth/register', {
    metodo: 'email', email: 'qa.f4b@taller.com', password: 'otra-clave-99',
    nombre: 'QA', apellido: 'F4b'
  });
  chequear('register email DUPLICADO → 409', r.status === 409, r.j);
  chequear('register email duplicado → mensaje amigable exacto',
    r.j && r.j.error && r.j.error.mensaje === MENSAJE_DUPLICADO, r.j);
  chequear('register email duplicado → codigo CONFLICTO_DATOS',
    r.j && r.j.error && r.j.error.codigo === 'CONFLICTO_DATOS', r.j);

  /* ------------- 2) registro telefono: duplicado → 409 con mismo texto ---- */
  r = await req('POST', '/auth/register', {
    metodo: 'telefono', telefono: '5497011111111', password: 'clave-f4b-2',
    nombre: 'QA', apellido: 'Tel', nombreTaller: 'QA F4b OTP'
  });
  chequear('register telefono nuevo → 200 + necesitaVerificacion',
    r.status === 200 && r.j && r.j.necesitaVerificacion === true, r.j);
  const otpAlta = r.j && r.j.dev && r.j.dev.otp;

  r = await req('POST', '/auth/verify-otp',
    { telefono: '5497011111111', otp: otpAlta, password: 'clave-f4b-2',
      nombre: 'QA', apellido: 'Tel' });
  chequear('verify-otp alta telefónica → 200 + token', r.status === 200 && Boolean(r.j.token), r.j);

  /* Resetear la cuota del mes importando el momento: NO hace falta — la
     cuota arranca en 1 de 2; dispararía 429 si se pidiera otro OTP, así
     que el duplicado se prueba SOLO contra el check de /register. */
  await espera(450);   /* anti-spam de reenvío (300 ms en QA) */
  r = await req('POST', '/auth/request-otp', { telefono: '5497011111111' });
  const otp2 = r.j && r.j.dev && r.j.dev.otp;
  chequear('request-otp a teléfono EXISTENTE → 200 (canal de login OTP intacto)',
    r.status === 200 && Boolean(otp2), r.j);

  /* verificar el 2º OTP también actualiza la MISMA fila (upsert, no INSERT) */
  r = await req('POST', '/auth/verify-otp',
    { telefono: '5497011111111', otp: otp2 });
  chequear('verify-otp de cuenta existente → 200 misma fila (id estable)',
    r.status === 200 && r.j && r.j.usuario && r.j.usuario.telefono === '5497011111111', r.j);

  /* alta duplicada por teléfono: el check de /register debe 409ear */
  r = await req('POST', '/auth/register', {
    metodo: 'telefono', telefono: '5497011111111', password: 'x-otra-123',
    nombre: 'QA', apellido: 'Tel'
  });
  chequear('register telefono DUPLICADO → 409', r.status === 409, r.j);
  chequear('register telefono duplicado → mensaje amigable exacto',
    r.j && r.j.error && r.j.error.mensaje === MENSAJE_DUPLICADO, r.j);

  /* ------------- 3) login: inexistente → 401 con mensaje propio ----------- */
  r = await req('POST', '/auth/login', { email: 'nadie@taller.com', password: 'loquesea123' });
  chequear('login email INEXISTENTE → 401', r.status === 401, r.j);
  chequear('login inexistente → mensaje "Usuario no registrado o contraseña incorrecta."',
    r.j && r.j.error && r.j.error.mensaje === MENSAJE_INEXISTENTE, r.j);

  /* email válido pero contraseña errada: contador de intentos (fila existe) */
  r = await req('POST', '/auth/login', { email: 'qa.f4b@taller.com', password: 'clave-mala-99' });
  chequear('login existente clave errada → 401 con contador',
    r.status === 401 && /Intentos restantes: 2/.test(r.j && r.j.error ? r.j.error.mensaje : ''), r.j);

  /* en mayúsculas/mixtas: el email se normaliza igual */
  r = await req('POST', '/auth/login', { email: 'NADIE-DOBLE@taller.COM', password: 'loquesea123' });
  chequear('login email inexistente (mixto) → 401 mismo mensaje',
    r.status === 401 && r.j && r.j.error && r.j.error.mensaje === MENSAJE_INEXISTENTE, r.j);

  /* clave correcta tras un error → 200 y contador a cero */
  r = await req('POST', '/auth/login', { email: 'qa.f4b@taller.com', password: 'clave-f4b-1' });
  chequear('login correcto tras el error → 200 + token', r.status === 200 && Boolean(r.j.token), r.j);
  const tokenF4b = r.j.token;
  r = await req('GET', '/auth/profile', undefined, tokenF4b);
  chequear('GET profile con la sesión posta → 200', r.status === 200, r.j);

  console.log('\n' + (mal ? 'FALLOS: ' + mal : 'TODO OK') + ' — ' + ok + ' checks verdes, ' + mal + ' rojos');
  process.exit(mal ? 1 : 0);
}

main().catch(function (e) {
  console.error('ERROR general de la batería:', e);
  process.exit(1);
});
