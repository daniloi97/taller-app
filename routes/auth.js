/* ============================================================================
   routes/auth.js — /api/v1/auth (Fase 2: login dual + perfil + cuotas;
   Fase 3: cambio por enlace desde el perfil · Fase 4: identidad personal
   nombre/apellido + teléfono argentino 10 dígitos +54 9)

   ARQUITECTURA DE LA PANTALLA DE BIENVENIDA (dual):
     · Registro:    email + contraseña, o teléfono + OTP + contraseña.
     · Login:       email + contraseña (POST /login), o WhatsApp + OTP
                    (request-otp / verify-otp — flujo de la Fase 1 que vive).
     · Recuperación: con OTP al teléfono (si la cuota mensual lo permite) o
                     con token enviado al email (POST /olvide-password →
                     /reset-password). Mock: ambos "canales" imprimen en la
                     consola del server (Fase 3: WhatsApp Cloud API + envío
                     real de email — este módulo es el único punto a tocar).

   CONTROL DE COSTOS OTP (máx. 2 códigos por usuario y mes calendario):
     · request-otp compara el mes de otp_ultimo_reset con el actual; si cambió
       reinicia otp_conteo_mes = 0. Al llegar a 2 responde 429 pensando en el
       estado de la cuenta: con email registrado sugiere la recuperación por
       email; sin email, pide contacto con soporte.

   BLOQUEO DE LOGIN (máx. 3 intentos fallidos):
     · /login incrementa intentos_fallidos en cada contraseña errónea; el
       mensaje al usuario incluye "Intentos restantes: N". Al 3º error
       responde 403 con { forceReset: true } — el front conmuta solo a la
       vista de restablecer contraseña. Login OK (o password reset) = 0.

   UTILERÍA
     · Hash de contraseñas: scrypt nativo de Node (sin dependencias nuevas),
       formato "scrypt$<salt-hex>$<dk-hex>" + timingSafeEqual.
     · JWT HS256 30 días (igual que Fase 1); SECRETO vía JWT_SECRET o clave
       de desarrollo con AVISO (fail-closed en producción).
   ============================================================================ */
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { camelize } = require('../utils/camel');
const { fail } = require('../utils/errors');
const { normTelefono } = require('../utils/normalizar');

const router = express.Router();

/* ------------------------------------------------------------------ secret */
/* Fail-closed (Fase 5 · C1): sólo el valor EXACTO 'development' habilita el
   modo laxo — vacío, 'production', 'staging', 'test'… todo lo demás es estricto.
   Sin JWT_SECRET en desarrollo se genera una clave EFÍMERA (crypto.randomBytes):
   las sesiones vencen al reiniciar y no existe ningún secreto conocido en el
   repo. Con JWT_SECRET definida se exige fuerza mínima (≥ 32 caracteres y sin
   palabras tipo "cambiar/changeme"). */
const ES_DEV = process.env.NODE_ENV === 'development';
const EXPONER_CODIGOS = ES_DEV && process.env.DEV_EXPOSE_CODES === 'true';

let SECRETO = process.env.JWT_SECRET;
if (!SECRETO) {
  if (!ES_DEV) {
    console.error('[auth] FATAL: JWT_SECRET es obligatorio salvo con NODE_ENV=development.');
    process.exit(1);
  }
  SECRETO = crypto.randomBytes(48).toString('base64');
  console.warn('[auth] AVISO: JWT_SECRET ausente; se usa una clave aleatoria EFÍMERA (las sesiones vencen al reiniciar el server).');
} else if (SECRETO.length < 32 || /cambiar|secreto|changeme/i.test(SECRETO)) {
  console.error('[auth] FATAL: JWT_SECRET débil (mínimo 32 caracteres aleatorios, sin "cambiar"/"changeme").');
  process.exit(1);
}

/* Log de los mocks de canal (OTP/links de reset): SÓLO con la doble llave
   (development + DEV_EXPOSE_CODES=true). En producción queda mudo. */
function mock(mensaje) {
  if (EXPONER_CODIGOS) console.log(mensaje);
}

/* ------------------------------------------------------------- constantes */
const OTP_VIDA_MS = 5 * 60 * 1000;      /* el código vive 5 minutos */
const OTP_MAX_INTENTOS = 5;             /* a la 5ª falla, quemar el código */
/* Anti-spam entre pedidos del MISMO número. En desarrollo/QA se puede acortar
   con AUTH_OTP_REENVIO_MS; producción mantiene el default de 30 s. */
const OTP_REENVIO_MS = Number(process.env.AUTH_OTP_REENVIO_MS) || 30 * 1000;
const JWT_DIAS = 30;                    /* validez del token de sesión */

/* Cuota de códigos: control de costos del canal (2 por usuario y mes) */
const OTP_CUOTA_MENSUAL = 2;

/* Restablecimiento por token de email */
const TOKEN_RESET_VIDA_MS = 15 * 60 * 1000;   /* el token vive 15 minutos */

/* Contraseña: mínimo exigido (API + front avisan igual: 6) */
const PASSWORD_MIN = 6;

/* --------------------------------------------------------------------------------
   Stores en memoria (volátiles a propósito: reiniciar el server invalida todo).
     otps        : telefono → { codigo, creado, expira, intentos, usosMes }
     resetsEmail : token-hex → { email, expira }   (restablecer por email)
   -------------------------------------------------------------------------------- */
const otps = new Map();
const resetsEmail = new Map();

/* ------------------------------------------------------------ validadores */
/* W4: delega en utils/normalizar.js — SÓLO dígitos (el '+' también se
   elimina), así '+54911…' y '54911…' caen en la misma clave de cuenta. */

/* Formato: 8..15 dígitos (sin el '+' del prefijo internacional; la
   normalización sacó todo lo que no era número). Guarda en la BD tal cual. */
function telefonoValido(tel) {
  const solo = tel.replace(/\D/g, '');
  return solo.length >= 8 && solo.length <= 15;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function emailValido(e) { return EMAIL_RE.test(String(e || '').trim()); }

function passwordValido(pw) {
  return typeof pw === 'string' && pw.length >= PASSWORD_MIN;
}

/* ----------------------------------------------------------------- hashing */
/* scrypt nativo: salt aleatorio por contraseña + dk de 64 bytes. El formato
   encadena algoritmo/salt/hash para poder migrar parámetros a futuro. */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + dk.toString('hex');
}

function verificarPassword(pw, guardado) {
  if (!guardado || typeof guardado !== 'string') return false;
  const p = guardado.split('$');
  if (p.length !== 3 || p[0] !== 'scrypt') return false;
  const salt = Buffer.from(p[1], 'hex');
  const esperado = Buffer.from(p[2], 'hex');
  const dk = crypto.scryptSync(pw, salt, esperado.length);
  return crypto.timingSafeEqual(dk, esperado);
}

/* ------------------------------------------------------------- OTP helpers */
function otpActivo(tel) {
  const o = otps.get(tel);
  if (!o) return null;
  if (Date.now() > o.expira) { otps.delete(tel); return null; }
  return o;
}

/* Validar y consumir el código (one-shot, con máx. de intentos fallidos).
   Lo usan verify-otp y reset-password vía OTP. */
function consumirOtp(tel, otp) {
  const guarda = otpActivo(tel);
  if (!guarda) fail(400, 'No hay un código activo para ese número (o venció): pedí uno nuevo');

  if (guarda.codigo !== otp) {
    guarda.intentos += 1;
    if (guarda.intentos >= OTP_MAX_INTENTOS) {
      otps.delete(tel);
      fail(400, 'Código incorrecto: agotaste los 5 intentos. Pedí un código nuevo.');
    }
    fail(400, 'Código incorrecto (intentos usados: ' + guarda.intentos + ' de ' + OTP_MAX_INTENTOS + ')');
  }

  /* One-shot: el código vale un solo uso; vence o se usa */
  otps.delete(tel);
  return guarda;
}

/* ------------------------------------------------------ cuota OTP (/mes) -- */
/* Devuelve la fila FRESCA del usuario y, si cambió el mes calendario desde
   otp_ultimo_reset, reinicia el contador en disco (cuota de códigos = 0). */
function usuarioConCuotaFresca(usuario) {
  if (!usuario) return null;
  const hoy = new Date();
  const mesHoy = String(hoy.getFullYear()) + '-' +
    String(hoy.getMonth() + 1).padStart(2, '0');
  const mesFila = usuario.otp_ultimo_reset
    ? String(usuario.otp_ultimo_reset).slice(0, 7)
    : null;

  let conteo = Number(usuario.otp_conteo_mes || 0);
  if (mesFila !== mesHoy) {
    db.run(
      'UPDATE usuarios SET otp_conteo_mes = 0, otp_ultimo_reset = CURRENT_DATE WHERE id = ?',
      [usuario.id]
    );
    conteo = 0;
  }
  usuario.otp_conteo_mes = conteo;
  return usuario;
}

/* -------------------------------------------------------- JWT + token ------ */
function firmarToken(usuario) {
  /* HS256 fijado (no permitir que el header pida HS512/none). Expira 30d. */
  return jwt.sign(
    { sub: usuario.id, telefono: usuario.telefono, rol: usuario.rol },
    SECRETO,
    { expiresIn: JWT_DIAS + 'd', algorithm: 'HS256' }
  );
}

/* Datos públicos del usuario: NUNCA salen password_hash ni los contadores
   crudos (la cuota viaja como objeto legible para la UI del perfil). */
function usuarioPublico(fila) {
  return {
    id: fila.id,
    telefono: fila.telefono || null,
    email: fila.email || null,
    nombre: fila.nombre || null,
    apellido: fila.apellido || null,
    nombreTaller: fila.nombre_taller || null,
    rol: fila.rol || 'admin',
    cuotaOtp: { usados: Number(fila.otp_conteo_mes || 0), limite: OTP_CUOTA_MENSUAL },
    createdAt: fila.created_at
  };
}

/* Datos personales obligatorios del registro (Fase 4): nombre y apellido.
   Se validan ANTES de crear la fila o gastar un OTP. */
const ID_PERSONAL_MAX = 80;
function textoPersonalValido(v) {
  const t = String(v == null ? '' : v).trim();
  return t.length >= 1 && t.length <= ID_PERSONAL_MAX;
}

/* ---------------------------------------------------------- duplicados --- */
/* Mensaje único y amigable para la cuenta YA registrada (Fase 4b): el
   operador sabe de una vez que debe cambiar de pestaña (ir a Ingresar). */
const MENSAJE_DUPLICADO = 'El correo o teléfono ya se encuentra registrado. Por favor iniciá sesión.';

/* Captura la violación de restricción UNIQUE de la BD ( carrera entre el
   check-then-insert y el INSERT real: idx_usuarios_email /
   idx_usuarios_telefono). Sin esto, la carrera escaparía como 500
   ERROR_INTERNO; con esto se convierte en un 409 con el mismo mensaje. */
function rebotarSiDuplicado(e) {
  if (/UNIQUE constraint failed: usuarios\.(email|telefono)/i.test(String(e.message))) {
    fail(409, MENSAJE_DUPLICADO);
  }
  throw e;   /* cualquier otro error de BD: 500 real, no lo enmascaro */
}

function usuarioPorId(id) {
  return db.getOne('SELECT * FROM usuarios WHERE id = ?', [id]);
}

/* -------------------------------------------------- POST /request-otp ---- */
/* Envía el OTP por el canal teléfono. Aplica (en orden): formato → reset
   mensual → cuota (429 con mensaje según el email) → anti-spam 30 s. */
router.post('/request-otp', function (req, res) {
  const tel = normTelefono((req.body || {}).telefono);
  if (!telefonoValido(tel)) {
    fail(400, 'Número inválido: enviá el WhatsApp en formato internacional sin espacios, p.ej. 5491112345678');
  }

  const usuario = usuarioConCuotaFresca(
    db.getOne('SELECT * FROM usuarios WHERE telefono = ?', [tel])
  );

  if (usuario) {
    const usados = usuario.otp_conteo_mes || 0;
    if (usados >= OTP_CUOTA_MENSUAL) {
      /* Cuota agotada: el mensaje depende de dónde puede recuperarse la
         cuenta (email registrado → token por email; sin email → soporte). */
      if (usuario.email) {
        fail(429, 'Límite de SMS/WhatsApp alcanzado. Utiliza la recuperación por email.');
      }
      fail(429, 'Límite de solicitudes alcanzado. Contacta a soporte: soporte@taller.com');
    }
  }

  const pendiente = otpActivo(tel);
  if (pendiente && (Date.now() - pendiente.creado) < OTP_REENVIO_MS) {
    fail(429, 'Ya se envió un código hace instantes. Esperá un momento para pedir otro.');
  }

  const codigo = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  /* Conteo de usos del mes EN el store: si el teléfono todavía no tiene fila
     (registro nuevo), verify crea la cuenta contabilizando desde acá. */
  const usosMes = usuario ? (usuario.otp_conteo_mes || 0) + 1 : 1;
  otps.set(tel, {
    codigo: codigo, creado: Date.now(), expira: Date.now() + OTP_VIDA_MS,
    intentos: 0, usosMes: usosMes
  });

  if (usuario) {
    db.run(
      'UPDATE usuarios SET otp_conteo_mes = ?, otp_ultimo_reset = CURRENT_DATE WHERE id = ?',
      [usosMes, usuario.id]
    );
  }

  /* Mock del canal: imprime que se "envió" (Fase 3: WhatsApp Cloud API con
     plantilla de OTP). SÓLO con DEV_EXPOSE_CODES=true (Fase 5 · C2). */
  mock('[auth][WHATSAPP-MOCK] → ' + tel + ' · OTP: ' + codigo + ' · vence en 5 minutos');

  const respuesta = {
    enviado: true,
    canal: 'whatsapp-mock',
    expiraEn: Math.round(OTP_VIDA_MS / 1000),
    cuotaOtp: { usados: usosMes, limite: OTP_CUOTA_MENSUAL }
  };
  /* Dato de prueba: doble llave (development + opt-in explícito de QA) */
  if (EXPONER_CODIGOS) respuesta.dev = { otp: codigo };
  res.status(200).json(respuesta);
});

/* -------------------------------------------------- POST /verify-otp ----- */
/* One-shot: valida el código, crea/actualiza la fila en usuarios (upsert por
   teléfono), fija la contraseña si vino (registro dual, o cuenta OTP a la
   que se le agrega contraseña) y firma un JWT de 30 días → { token, usuario }. */
router.post('/verify-otp', function (req, res) {
  const body = req.body || {};
  const tel = normTelefono(body.telefono);
  if (!telefonoValido(tel)) fail(400, 'Número inválido: volvé al paso 1 y ingresá tu WhatsApp');

  const otp = String(body.otp == null ? '' : body.otp).replace(/\D/g, '');
  if (otp.length !== 6) fail(400, 'El código tiene 6 dígitos');

  const nombreTaller = String(body.nombreTaller == null ? '' : body.nombreTaller).trim();
  if (nombreTaller.length > 120) fail(400, 'El nombre del taller excede los 120 caracteres');

  /* Datos personales (Fase 4): opcionales aquí — el flujo legado de login
     por OTP los manda vacíos; el registro dual los exige en /register. */
  const nombre = String(body.nombre == null ? '' : body.nombre).trim();
  const apellido = String(body.apellido == null ? '' : body.apellido).trim();
  if ((nombre && !textoPersonalValido(nombre)) || (apellido && !textoPersonalValido(apellido))) {
    fail(400, 'Nombre y apellido admiten hasta ' + ID_PERSONAL_MAX + ' caracteres');
  }

  /* Contraseña opcional: se valida ANTES de gastar el código (one-shot),
     para no quemarlo por un typo en el campo. */
  let password = body.password;
  if (password != null && password !== '') {
    if (!passwordValido(password)) {
      fail(400, 'La contraseña debe tener al menos ' + PASSWORD_MIN + ' caracteres');
    }
  } else {
    password = null;
  }

  const guarda = consumirOtp(tel, otp);

  const idNuevo = db.nuevoId();
  try {
    db.tx(function () {
      const previo = db.getOne('SELECT id FROM usuarios WHERE telefono = ?', [tel]);
      if (previo) {
      if (nombreTaller || password || nombre || apellido) {
        db.run(
          'UPDATE usuarios SET nombre = COALESCE(?, nombre), apellido = COALESCE(?, apellido), ' +
          'nombre_taller = CASE WHEN ? <> \'\' THEN ? ELSE nombre_taller END, ' +
          'password_hash = COALESCE(?, password_hash), intentos_fallidos = 0 WHERE id = ?',
          [nombre || null, apellido || null, nombreTaller, nombreTaller,
           password ? hashPassword(password) : null, previo.id]
        );
      } else {
        db.run('UPDATE usuarios SET intentos_fallidos = 0 WHERE id = ?', [previo.id]);
      }
    } else {
      db.run(
        'INSERT INTO usuarios (id, telefono, nombre, apellido, nombre_taller, rol, password_hash, ' +
        'otp_conteo_mes, otp_ultimo_reset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_DATE)',
        [idNuevo, tel, nombre || null, apellido || null, nombreTaller || null, 'admin',
         password ? hashPassword(password) : null, guarda.usosMes || 1]
      );
    }
  });
  } catch (e) {
    /* El INSERT de la rama else puede chocar con idx_usuarios_telefono si
       /register por teléfono creó la fila en la brecha del check anterior */
    rebotarSiDuplicado(e);
  }

  const fila = db.getOne('SELECT * FROM usuarios WHERE telefono = ?', [tel]);
  res.status(200).json({ token: firmarToken(fila), usuario: usuarioPublico(fila) });
});

/* ---------------------------------------------------- POST /register ----- */
/* Registro dual:
     { metodo:'email',    email,    password, nombreTaller? }
       → crea la cuenta y devuelve { token, usuario } (auto-sesión).
     { metodo:'telefono', telefono, password, nombreTaller? }
       → la propiedad del teléfono se prueba con OTP: envía el código (con el
         mismo anti-spam) y devuelve { necesitaVerificacion }. El front cierra
         el registro con verify-otp + password. */
router.post('/register', function (req, res) {
  const body = req.body || {};
  const metodo = String(body.metodo || '').trim().toLowerCase();
  const password = String(body.password == null ? '' : body.password);
  const nombreTaller = String(body.nombreTaller == null ? '' : body.nombreTaller).trim();

  /* Datos personales OBLIGATORIOS en el registro (Fase 4) */
  const nombre = String(body.nombre == null ? '' : body.nombre).trim();
  const apellido = String(body.apellido == null ? '' : body.apellido).trim();
  if (!textoPersonalValido(nombre)) fail(400, 'El nombre es obligatorio (máx. ' + ID_PERSONAL_MAX + ' caracteres)');
  if (!textoPersonalValido(apellido)) fail(400, 'El apellido es obligatorio (máx. ' + ID_PERSONAL_MAX + ' caracteres)');
  if (nombreTaller.length > 120) fail(400, 'El nombre del taller excede los 120 caracteres');
  if (!passwordValido(password)) {
    fail(400, 'La contraseña debe tener al menos ' + PASSWORD_MIN + ' caracteres');
  }

  if (metodo === 'email') {
    const email = String(body.email == null ? '' : body.email).trim().toLowerCase();
    if (!emailValido(email)) fail(400, 'Email inválido: revisá el formato (p.ej. taller@correo.com)');

    if (db.getOne('SELECT id FROM usuarios WHERE email = ?', [email])) {
      fail(409, MENSAJE_DUPLICADO);
    }

    const id = db.nuevoId();
    try {
      db.run(
        'INSERT INTO usuarios (id, email, password_hash, nombre, apellido, nombre_taller, rol, ' +
        'otp_conteo_mes) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
        [id, email, hashPassword(password), nombre, apellido, nombreTaller || null, 'admin']
      );
    } catch (e) {
      /* UNIQUE idx_usuarios_email (carrera entre el check y el INSERT) */
      rebotarSiDuplicado(e);
    }
    const fila = usuarioPorId(id);
    return res.status(201).json({ token: firmarToken(fila), usuario: usuarioPublico(fila) });
  }

  if (metodo === 'telefono' || metodo === 'teléfono') {
    const tel = normTelefono(body.telefono);
    if (!telefonoValido(tel)) {
      fail(400, 'Número inválido: enviá el WhatsApp en formato internacional sin espacios, p.ej. 5491112345678');
    }
    if (db.getOne('SELECT id FROM usuarios WHERE telefono = ?', [tel])) {
      fail(409, MENSAJE_DUPLICADO);
    }

    /* Sin fila de usuario todavía: la cuota mensual arranca con la cuenta.
       El anti-spam de 30 s y la prueba de propiedad (OTP) se aplican igual. */
    const pendiente = otpActivo(tel);
    if (pendiente && (Date.now() - pendiente.creado) < OTP_REENVIO_MS) {
      fail(429, 'Ya se envió un código hace instantes. Esperá un momento para pedir otro.');
    }

    const codigo = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    otps.set(tel, {
      codigo: codigo, creado: Date.now(), expira: Date.now() + OTP_VIDA_MS,
      intentos: 0, usosMes: 1
    });
    mock('[auth][WHATSAPP-MOCK] → ' + tel + ' · OTP: ' + codigo + ' · vence en 5 minutos');

    const respuesta = {
      necesitaVerificacion: true,
      enviado: true,
      canal: 'whatsapp-mock',
      expiraEn: Math.round(OTP_VIDA_MS / 1000),
      cuotaOtp: { usados: 1, limite: OTP_CUOTA_MENSUAL }
    };
    if (EXPONER_CODIGOS) respuesta.dev = { otp: codigo };
    return res.status(200).json(respuesta);
  }

  fail(400, 'Método de registro inválido: elegí email o telefono');
});

/* -------------------------------------------------------- POST /login ---- */
/* Email + contraseña. Credenciales erróneas de un usuario EXISTENTE llevan
   contador: "Credenciales incorrectas. Intentos restantes: 2"; el email NO
   registrado recibe el mensaje explícito "Usuario no registrado o
   contraseña incorrecta." (Fase 4b) para que el operador sepa que debe
   registrarse. Al 3º error, 403 con { forceReset: true, error } — el front
   conmuta automáticamente a la vista restablecer contraseña. */
router.post('/login', function (req, res) {
  const body = req.body || {};
  const email = String(body.email == null ? '' : body.email).trim().toLowerCase();
  const password = String(body.password == null ? '' : body.password);

  if (!emailValido(email) || !password) {
    fail(400, 'Completá email y contraseña para ingresar');
  }

  const usuario = db.getOne('SELECT * FROM usuarios WHERE email = ?', [email]);

  /* Sin fila: no hay bloqueo posible (el contador vive en la fila) */
  if (!usuario) {
    fail(401, 'Usuario no registrado o contraseña incorrecta.');
  }

  if (Number(usuario.intentos_fallidos || 0) >= 3) {
    /* Bloqueo vigente: ni la contraseña correcta entra (fue probada en un
       contexto sospechado); recupera el acceso por reset-password, que
       hace intentos_fallidos = 0. Respuesta directa con flag de nivel
       superior para el front. */
    return res.status(403).json({
      forceReset: true,
      error: {
        codigo: 'BLOQUEO_INTENTOS',
        mensaje: 'Demasiados intentos fallidos. Debes restablecer tu contraseña.'
      }
    });
  }
  if (!verificarPassword(password, usuario.password_hash)) {
    const intentos = Number(usuario.intentos_fallidos || 0) + 1;
    db.run('UPDATE usuarios SET intentos_fallidos = ? WHERE id = ?', [intentos, usuario.id]);

    if (intentos >= 3) {
      /* Respuesta directa (sin throw): el cuerpo lleva el flag de nivel
         superior que el front usa para conmutar a "restablecer". */
      return res.status(403).json({
        forceReset: true,
        error: {
          codigo: 'BLOQUEO_INTENTOS',
          mensaje: 'Demasiados intentos fallidos. Debes restablecer tu contraseña.'
        }
      });
    }
    fail(401, 'Credenciales incorrectas. Intentos restantes: ' + (3 - intentos));
  }

  /* Login OK: contador a 0 y token fresco */
  db.run('UPDATE usuarios SET intentos_fallidos = 0 WHERE id = ?', [usuario.id]);
  const fila = usuarioPorId(usuario.id);
  res.status(200).json({ token: firmarToken(fila), usuario: usuarioPublico(fila) });
});

/* ------------------------------------------- POST /olvide-password ------- */
/* Dispara el restablecimiento por EMAIL: genera un token de un solo uso
   (15 min) y lo "envía" — mock: consola del server + campo dev en desarrollo
   (Fase 3: SMTP/service real). Responde igual si el email existe o no para
   no revelar qué cuentas están registradas. */
router.post('/olvide-password', function (req, res) {
  const email = String((req.body || {}).email == null ? '' : req.body.email).trim().toLowerCase();
  if (!emailValido(email)) fail(400, 'Email inválido: revisá el formato (p.ej. taller@correo.com)');

  const usuario = db.getOne('SELECT * FROM usuarios WHERE email = ?', [email]);
  const respuesta = { ok: true, mensaje: 'Si el email está registrado, te enviamos un token para restablecer la contraseña (válido 15 minutos).' };

  if (usuario) {
    const token = crypto.randomBytes(24).toString('hex');
    resetsEmail.set(token, { email: email, expira: Date.now() + TOKEN_RESET_VIDA_MS });
    mock('[auth][EMAIL-MOCK] → ' + email + ' · token de restablecimiento: ' + token + ' · vence en 15 minutos');
    if (EXPONER_CODIGOS) respuesta.dev = { token: token };
  }
  res.status(200).json(respuesta);
});

/* ---------------------------------------- POST /reset-password ----------- */
/* Cambia la contraseña por dos caminos (el campo via decide):
     via 'otp'   : { telefono, otp, password } — OTP al WhatsApp
     via 'token' : { token, password }         — token recibido por email
   Éxito ⇒ password_hash nuevo + intentos_fallidos = 0 (sale del bloqueo). */
router.post('/reset-password', function (req, res) {
  const body = req.body || {};
  const password = String(body.password == null ? '' : body.password);
  if (!passwordValido(password)) {
    fail(400, 'La nueva contraseña debe tener al menos ' + PASSWORD_MIN + ' caracteres');
  }

  if (body.via === 'otp') {
    const tel = normTelefono(body.telefono);
    if (!telefonoValido(tel)) fail(400, 'Número inválido: usá el formato internacional (549…)');
    const otp = String(body.otp == null ? '' : body.otp).replace(/\D/g, '');
    if (otp.length !== 6) fail(400, 'El código tiene 6 dígitos');

    consumirOtp(tel, otp);   /* prueba de propiedad + one-shot + 5 intentos */

    const usuario = db.getOne('SELECT * FROM usuarios WHERE telefono = ?', [tel]);
    if (!usuario) fail(404, 'No hay cuenta con ese número: registrate primero');

    db.run(
      'UPDATE usuarios SET password_hash = ?, intentos_fallidos = 0 WHERE id = ?',
      [hashPassword(password), usuario.id]
    );
    return res.status(200).json({ ok: true, mensaje: 'Contraseña restablecida: ingresá con tu nueva contraseña.' });
  }

  if (body.via === 'token') {
    const token = String(body.token == null ? '' : body.token).trim();
    const guarda = resetsEmail.get(token);
    if (!guarda || Date.now() > guarda.expira) {
      resetsEmail.delete(token);
      fail(400, 'Token inválido o vencido: pedí uno nuevo (¿Olvidaste tu contraseña?)');
    }

    const usuario = db.getOne('SELECT * FROM usuarios WHERE email = ?', [guarda.email]);
    if (!usuario) fail(404, 'No hay cuenta con ese email: registrate primero');

    db.run(
      'UPDATE usuarios SET password_hash = ?, intentos_fallidos = 0 WHERE id = ?',
      [hashPassword(password), usuario.id]
    );
    resetsEmail.delete(token);     /* one-shot: vale un solo uso */
    return res.status(200).json({ ok: true, mensaje: 'Contraseña restablecida: ingresá con tu nueva contraseña.' });
  }

  fail(400, 'Indicá el via de restablecimiento: otp o token');
});

/* ---------------------------------------------- middleware proteger ------ */
/* Los 401 salen como ApiError → middleware central de server.js responde
   { error: { codigo: 'NO_AUTORIZADO', mensaje } } (uniforme con el resto). */
function proteger(req, res, next) {
  const cabecera = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(cabecera);
  if (!m) fail(401, 'Falta el token de sesión: mandá la cabecera Authorization: Bearer <token>');

  let payload;
  try {
    payload = jwt.verify(m[1], SECRETO, { algorithms: ['HS256'] });
  } catch (e) {
    fail(401, e && e.name === 'TokenExpiredError'
      ? 'Sesión vencida: ingresá de nuevo'
      : 'Token inválido: iniciá sesión de nuevo');
  }

  req.usuario = payload;
  next();
}

/* ------------------------------------------------------ GET /profile ----- */
/* Datos frescos del usuario autenticado (el JWT puede traer datos viejos si
   el email/teléfono cambiaron después de firmarlo). */
router.get('/profile', proteger, function (req, res) {
  const fila = usuarioPorId(req.usuario.sub);
  if (!fila) fail(401, 'La cuenta del token ya no existe: iniciá sesión de nuevo');
  res.status(200).json({ usuario: usuarioPublico(usuarioConCuotaFresca(fila)) });
});

/* ------------------------------------------------------ PUT /profile ----- */
/* Perfil: vincular o modificar email, teléfono y nombre del taller.
   · Cada campo es OPCIONAL: sólo se actualizan los que viajan (asi un campo
     vacío no limpia por accidente el dato de recuperación).
   · email se guarda en minúsculas (unicidad case-insensitive).
   · si cambia el teléfono se re-firma el token (el JWT lo lleva en payload).
   · Cuotas e intentos NO se tocan por acá (son de seguridad, no de perfil).
   · REAUTENTICACIÓN (Fase 5 · C5): cambiar email o teléfono altera los
     identificadores de acceso/recuperación de la cuenta ⇒ se exige la
     contraseña actual (verificada contra password_hash con scrypt). Cuentas
     OTP-only (sin hash) verifican identidad con un OTP de su propio teléfono
     (pedirlo antes vía POST /auth/request-otp y pasarlo como otpActual). */
router.put('/profile', proteger, function (req, res) {
  const fila = usuarioPorId(req.usuario.sub);
  if (!fila) fail(401, 'La cuenta del token ya no existe: iniciá sesión de nuevo');

  const body = req.body || {};

  /* Cambios de identidad ANTES de validar nada más: sin confirmación se
     corta acá (403) y ni se consulta la unicidad del dato nuevo. */
  if (body.email !== undefined || body.telefono !== undefined) {
    if (fila.password_hash) {
      if (!verificarPassword(String(body.passwordActual == null ? '' : body.passwordActual), fila.password_hash)) {
        fail(403, 'Confirmá tu contraseña actual para cambiar email o teléfono');
      }
    } else if (fila.telefono) {
      consumirOtp(fila.telefono, String(body.otpActual == null ? '' : body.otpActual).replace(/\D/g, ''));
    } else {
      fail(403, 'No se puede verificar tu identidad para este cambio');
    }
  }

  const sets = [];
  const params = [];

  if (body.email !== undefined) {
    const email = String(body.email == null ? '' : body.email).trim().toLowerCase();
    if (email && !emailValido(email)) fail(400, 'Email inválido: revisá el formato (p.ej. taller@correo.com)');
    if (email) {
      const otro = db.getOne('SELECT id FROM usuarios WHERE email = ? AND id <> ?', [email, fila.id]);
      if (otro) fail(409, 'Ese email ya pertenece a otra cuenta');
      sets.push('email = ?'); params.push(email);
    }
  }

  if (body.telefono !== undefined) {
    const tel = normTelefono(body.telefono);
    if (tel && !telefonoValido(tel)) {
      fail(400, 'Número inválido: usá el formato internacional sin espacios, p.ej. 5491112345678');
    }
    if (tel) {
      const otro = db.getOne('SELECT id FROM usuarios WHERE telefono = ? AND id <> ?', [tel, fila.id]);
      if (otro) fail(409, 'Ese número ya pertenece a otra cuenta');
      sets.push('telefono = ?'); params.push(tel);
    }
  }

  if (body.nombre !== undefined || body.apellido !== undefined) {
    /* Identidad personal (Fase 4): editable desde el perfil. Se intenta
       actualizar en un solo SET cuando iliengo ambos; si uno viene solo,
       sólo ese campo viaja (vacío no borra por accidente). */
    const nombre = String(body.nombre == null ? '' : body.nombre).trim();
    const apellido = String(body.apellido == null ? '' : body.apellido).trim();
    if ((nombre && !textoPersonalValido(nombre)) || (apellido && !textoPersonalValido(apellido))) {
      fail(400, 'Nombre y apellido admiten hasta ' + ID_PERSONAL_MAX + ' caracteres');
    }
    if (nombre) { sets.push('nombre = ?'); params.push(nombre); }
    if (apellido) { sets.push('apellido = ?'); params.push(apellido); }
  }

  if (body.nombreTaller !== undefined) {
    const nombreTaller = String(body.nombreTaller == null ? '' : body.nombreTaller).trim();
    if (nombreTaller.length > 120) fail(400, 'El nombre del taller excede los 120 caracteres');
    sets.push('nombre_taller = ?'); params.push(nombreTaller || null);
  }

  if (!sets.length) fail(400, 'No hay cambios que guardar: enviá nombre, apellido, email, telefono o nombreTaller');

  db.run('UPDATE usuarios SET ' + sets.join(', ') + ' WHERE id = ?', params.concat([fila.id]));

  const actualizada = usuarioPorId(fila.id);
  const respuesta = { usuario: usuarioPublico(actualizada) };
  /* Teléfono cambiado ⇒ token nuevo (el JWT viejo trae el teléfono anterior). */
  if (actualizada.telefono !== fila.telefono) respuesta.token = firmarToken(actualizada);
  res.status(200).json(respuesta);
});

/* ==================== FASE 3 · cambio de contraseña desde el perfil ======= */

/* ------------------------- POST /request-password-reset-email ------------ */
/* Solicitud de cambio de contraseña por email, DESDE EL PERFIL (requiere
   sesión activa — a diferencia de /olvide-password que es público). Genera
   un token temporal de 15 min (mismo store resetsEmail que /reset-password
   via 'token') y "envía" el correo con el enlace de restablecimiento:
     {FRONT_URL}#reset-password?token=XYZ
   Mock: consola del server + dev.enlace en desarrollo (SMTP real: fase de
   producción). */
router.post('/request-password-reset-email', proteger, function (req, res) {
  const fila = usuarioPorId(req.usuario.sub);
  if (!fila) fail(401, 'La cuenta del token ya no existe: iniciá sesión de nuevo');

  if (!emailValido(fila.email)) {
    fail(400, 'Tu cuenta no tiene un email vinculado: cargalo en tu perfil primero.');
  }

  const token = crypto.randomBytes(24).toString('hex');
  resetsEmail.set(token, { email: fila.email, expira: Date.now() + TOKEN_RESET_VIDA_MS });

  const front = (process.env.FRONT_URL || 'http://localhost:5500/').replace(/\/+$/, '');
  const enlace = front + '/#reset-password?token=' + token;
  mock('[auth][EMAIL-MOCK] → usuario ' + fila.id + ' · enlace de cambio de contraseña (15 min) [sin email en el log: PII]');

  const respuesta = {
    ok: true,
    mensaje: 'Si el email está vinculado, te enviamos el enlace (válido 15 minutos): ' + fila.email,
    expiraEn: Math.round(TOKEN_RESET_VIDA_MS / 1000)
  };
  /* En desarrollo con opt-in, el enlace vuelve en la respuesta para probarlo
     sin correo (la consola ya no registra el email: Fase 5 · C2). */
  if (EXPONER_CODIGOS) respuesta.dev = { token: token, enlace: enlace };
  res.status(200).json(respuesta);
});

/* ------------------------- POST /confirm-password-reset ------------------ */
/* Confirmación desde la vista raíz #vista-reset-password (el usuario llegó
   por el enlace del email). Recibe { token, newPassword }, valida que el
   token exista y no esté vencido, actualiza password_hash + limpia el
   bloqueo y ANULA el token (one-shot). Comparte store con /reset-password
   via 'token' pero con campo distinto — el front de la vista lo llama. */
router.post('/confirm-password-reset', function (req, res) {
  const body = req.body || {};
  const token = String(body.token == null ? '' : body.token).trim();
  const newPassword = String(body.newPassword == null ? '' : body.newPassword);

  if (!token) fail(400, 'Falta el token del enlace de cambio de contraseña');
  if (!passwordValido(newPassword)) {
    fail(400, 'La nueva contraseña debe tener al menos ' + PASSWORD_MIN + ' caracteres');
  }

  const guarda = resetsEmail.get(token);
  if (!guarda || Date.now() > guarda.expira) {
    resetsEmail.delete(token);
    fail(400, 'El enlace es inválido o ya venció (15 min): pedí uno nuevo desde tu perfil.');
  }

  const usuario = db.getOne('SELECT * FROM usuarios WHERE email = ?', [guarda.email]);
  if (!usuario) {
    resetsEmail.delete(token);
    fail(404, 'No hay cuenta con el email del enlace: registrate primero');
  }

  db.run(
    'UPDATE usuarios SET password_hash = ?, intentos_fallidos = 0 WHERE id = ?',
    [hashPassword(newPassword), usuario.id]
  );
  resetsEmail.delete(token);     /* one-shot: el enlace vale un solo uso */
  /* C2: el log de evento registra el ID del usuario, jamás su email (PII). */
  console.log('[auth] Contraseña actualizada vía enlace para usuario ' + usuario.id);
  res.status(200).json({ ok: true, mensaje: 'Contraseña actualizada: ingresá con tu nueva contraseña.' });
});

module.exports = { router: router, proteger: proteger };
