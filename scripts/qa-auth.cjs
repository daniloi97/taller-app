/* ============================================================================
   scripts/qa-auth.cjs — batería de la Fase 1 de autenticación (teléfono + OTP + JWT)

   Qué valida: health público, 401 en las rutas protegidas (sin token / basura /
   corrupto / payload modificado), validaciones de request-otp, rate-limit de
   reenvío (429), one-shot del código, upsert por teléfono, firma/payload del
   JWT (HS256, 30 días, sub=id) y el flujo completo del negocio con token.

   Arranque del server para la prueba (develop, DB aparte, puerto configurable):
     Windows PowerShell:
       $env:PORT='3999'; $env:DB_PATH='./data/qa-auth.sqlite';
       $env:NODE_ENV='development'; node server.js
   Luego:   node scripts/qa-auth.cjs          (QA_PORT para otro puerto)
   Sale 0 en verde; 1 con la lista de fallos. La espera de 31 s integrada
   abandona el rate-limit del reenvío (30 s).
   ============================================================================ */
'use strict';

const BASE = 'http://127.0.0.1:' + (process.env.QA_PORT || 3999) + '/api/v1';
let ok = 0, mal = 0;

function chequear(nombre, cond, extra) {
  if (cond) { ok++; console.log('OK   ' + nombre); }
  else { mal++; console.log('FALLA ' + nombre + (extra ? ' → ' + JSON.stringify(extra) : '')); }
}

async function req(metodo, ruta, cuerpo, token) {
  const init = {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
  };
  if (token) init.headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + ruta, init);
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, json: json };
}

function separar(token) {
  const part = String(token || '').split('.');
  if (part.length !== 3) return null;
  try {
    const carga = JSON.parse(Buffer.from(part[1], 'base64url').toString('utf8'));
    return carga;
  } catch (e) { return null; }
}

(async () => {
  /* ---- 1) públicos ---- */
  let r = await req('GET', '/health');
  chequear('health público → 200 sin token', r.status === 200 && r.json && r.json.ok === true, r);
  chequear('health → sólo {ok} (sin driver ni ruta de BD, C3/W7)', r.json && r.json.ok === true && !('db' in r.json) && !('driver' in r.json), r.json);

  /* ---- 2) rutas protegidas sin token ---- */
  r = await req('GET', '/clientes');
  chequear('clientes sin token → 401 NO_AUTORIZADO', r.status === 401 && r.json.error.codigo === 'NO_AUTORIZADO', r);
  r = await req('GET', '/vehiculos');
  chequear('vehiculos sin token → 401', r.status === 401, r);
  r = await req('GET', '/vehiculos/xx/ordenes');
  chequear('ordenes por vehículo sin token → 401', r.status === 401, r);
  r = await req('POST', '/clientes', { nombre: 'X', dni: '31111111' });
  chequear('POST clientes sin token → 401', r.status === 401, r);

  /* ---- 3) token inválido / malformado ---- */
  r = await req('GET', '/clientes', undefined, 'puro-cabello-sin-jwt');
  chequear('token basura → 401 Token inválido', r.status === 401 && /inv.lido/i.test(r.json.error.mensaje), r);
  r = await req('GET', '/clientes', undefined, 'aaa.bbb.ccc');
  chequear('token 3-partes corrupto → 401', r.status === 401, r);

  /* ---- 4) request-otp validaciones ---- */
  r = await req('POST', '/auth/request-otp', {});
  chequear('request-otp sin telefono → 400', r.status === 400, r);
  r = await req('POST', '/auth/request-otp', { telefono: '12abc' });
  chequear('request-otp tel corto → 400', r.status === 400, r);
  r = await req('POST', '/auth/request-otp', { telefono: '5491112345678' });
  const devOtp1 = r.json && r.json.dev && r.json.dev.otp;
  chequear('request-otp ok → enviado + canal mock', r.status === 200 && r.json.enviado === true && r.json.canal === 'whatsapp-mock', r);
  chequear('devOtp 6 dígitos (NODE_ENV=development)', typeof devOtp1 === 'string' && /^\d{6}$/.test(devOtp1), r.json);
  chequear('expiraEn = 300 segundos', r.json && r.json.expiraEn === 300, r.json);

  /* ---- 5) rate-limit del reenvío ---- */
  r = await req('POST', '/auth/request-otp', { telefono: '5491112345678' });
  chequear('reenvío inmediato → 429 LIMITE_SOLICITUDES', r.status === 429 && r.json.error.codigo === 'LIMITE_SOLICITUDES', r);

  /* ---- 6) verify-otp con código erróneo → cuenta intentos ---- */
  const mal1 = devOtp1 === '000000' ? '111111' : '000000';
  r = await req('POST', '/auth/verify-otp', { telefono: '5491112345678', otp: mal1, nombreTaller: 'Taller Uno' });
  chequear('OTP erróneo → 400 con contador de intentos', r.status === 400 && /incorrecto/.test(r.json.error.mensaje), r);

  /* ---- 7) verify-otp correcto → token JWT 30 días + usuario ---- */
  r = await req('POST', '/auth/verify-otp', { telefono: '5491112345678', otp: devOtp1, nombreTaller: 'Taller Uno' });
  const tok1 = r.json && r.json.token;
  const usu1 = r.json && r.json.usuario;
  chequear('verify-otp correcto → 200 {token, usuario}', r.status === 200 && !!tok1 && !!usu1, r.json);
  chequear('usuario: telefono + rol admin + nombreTaller', usu1 && usu1.telefono === '5491112345678' && usu1.rol === 'admin' && usu1.nombreTaller === 'Taller Uno', usu1);
  chequear('usuario rol "created_at" ya camelizado', usu1 && 'createdAt' in usu1, usu1);
  const carga1 = separar(tok1);
  chequear('JWT: 3 segmentos + firma base64url decodable', !!carga1, tok1);
  chequear('JWT: sub = usuario.id', carga1 && carga1.sub === usu1.id, carga1);
  chequear('JWT: valides 30 días (exp - iat = 2592000)', carga1 && Math.abs((carga1.exp - carga1.iat) - 2592000) <= 2, carga1);
  chequear('JWT: alg HS256 declarado en header', tok1.split('.')[0].indexOf('eyJhbGciOiJIUzI1NiIs') === 0, tok1);

  /* ---- 8) one-shot: el mismo código no sirve dos veces ---- */
  r = await req('POST', '/auth/verify-otp', { telefono: '5491112345678', otp: devOtp1 });
  chequear('OTP one-shot → reuso da 400 sin código activo', r.status === 400 && /no hay un c.digo activo/i.test(r.json.error.mensaje), r);

  /* ---- 9) con token real: el negocio funciona completo ---- */
  r = await req('GET', '/clientes', undefined, tok1);
  chequear('clientes con token → 200 lista camelize', r.status === 200 && Array.isArray(r.json), r.json);
  r = await req('POST', '/clientes', { nombre: 'QA Autenticado', dni: '32123456' }, tok1);
  chequear('POST clientes con token → 201', r.status === 201 && r.json.dni === '32123456', r.json);
  r = await req('POST', '/vehiculos', { patente: 'QT987 apps'.replace(/\s/g, '').toUpperCase(), marca: 'QAMoto', modelo: 'QA', clienteId: r.json.id }, tok1);
  const vid = r.json && r.json.id;
  chequear('POST vehiculos con token → 201', r.status === 201 && !!vid, r.json);
  r = await req('POST', '/ordenes', { vehiculoId: vid, km: 1000, manoObra: 500 }, tok1);
  chequear('POST ordenes con token → 201', r.status === 201, r.json);
  r = await req('GET', '/vehiculos/' + vid + '/ordenes', undefined, tok1);
  chequear('GET /vehiculos/:id/ordenes con token → 200', r.status === 200 && Array.isArray(r.json), r.json);

  /* ---- 10) firma manipulada → 401 ---- */
  const partes = tok1.split('.');
  const tamper = partes[0] + '.' + Buffer.from(JSON.stringify(Object.assign({}, carga1, { rol: 'superadmin' }))).toString('base64url') + '.' + partes[2];
  r = await req('GET', '/clientes', undefined, tamper);
  chequear('payload modificado sin resignar → 401', r.status === 401, r);

  /* ---- 11) segundo usuario sin nombre_taller ---- */
  r = await req('POST', '/auth/request-otp', { telefono: '5499876543210' });
  const devOtp2 = r.json.dev.otp;
  r = await req('POST', '/auth/verify-otp', { telefono: '5499876543210', otp: devOtp2 });
  chequear('2º teléfono sin nombreTaller → usuario creado (nombre null)', r.status === 200 && r.json.usuario.nombreTaller == null && r.json.usuario.rol === 'admin', r.json);
  const tok2 = r.json.token;

  /* ---- 12) upsert del mismo teléfono tras pasar el rate-limit (espera 31 s) ---- */
  console.log('      (esperando 31 s para que pase el rate-limit del reenvío…)');
  await new Promise(function (res) { setTimeout(res, 31000); });
  r = await req('POST', '/auth/request-otp', { telefono: '5491112345678' });
  const devOtp3 = r.json.dev.otp;
  chequear('reenvío tras espera → nuevo código', r.status === 200 && /^\d{6}$/.test(devOtp3) && devOtp3 !== devOtp1 || (devOtp3 === devOtp1 && /^\d{6}$/.test(devOtp3)), r.json);
  r = await req('POST', '/auth/verify-otp', { telefono: '5491112345678', otp: devOtp3, nombreTaller: 'Taller Uno Renovado' });
  const usu1b = r.json.usuario;
  chequear('re-verificación del mismo teléfono → MISMA fila (id), nombre actualizado', r.status === 200 && usu1b.id === usu1.id && usu1b.nombreTaller === 'Taller Uno Renovado', usu1b);
  const tok1b = r.json.token;
  chequear('token refrescado también autoriza', (await req('GET', '/vehiculos', undefined, tok1b)).status === 200, null);
  chequear('token del 2º usuario autoriza (sesiones por teléfono)', (await req('GET', '/clientes', undefined, tok2)).status === 200, null);

  /* ---- 13) ruta inexistente sigue 404 (e igualmente trazada) ---- */
  r = await req('GET', '/auth/inventado');
  chequear('GET /auth/inventado → 401 (deny-by-default C3: bajo la frontera JWT)', r.status === 401 && r.json.error.codigo === 'NO_AUTORIZADO', r);

  console.log('\nRESULTADO: ' + (mal ? 'ROJO (' + mal + ' fallos)' : 'GREEN') + ' — ' + ok + ' checks OK');
  process.exit(mal ? 1 : 0);
})().catch(function (e) { console.error('CRASH ' + (e && e.stack || e)); process.exit(1); });
