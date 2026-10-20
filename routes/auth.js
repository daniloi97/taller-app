/* ============================================================================
   routes/auth.js — /api/v1/auth (Fase 1: teléfono + OTP simulado + JWT)

   POST /auth/request-otp   { telefono }
                            → genera OTP de 6 dígitos (5 min de vida), lo
                              imprime en la consola del servidor (mock de
                              WhatsApp) y con NODE_ENV=development también
                              lo devuelve en la respuesta (para probar sin
                              celular). Rate-limit: 30 s entre pedidos.
   POST /auth/verify-otp    { telefono, otp, nombreTaller? }
                            → one-shot: valida, crea/actualiza la fila en
                              usuarios (upsert por teléfono) y firma un JWT
                              de 30 días. Devuelve { token, usuario }.

   Middlewares exportados:
     proteger(req,res,next) → exige Authorization: Bearer <token>; inyecta
       req.usuario con el payload del JWT. Se monta DELANTE de clientes,
       vehiculos y ordenes (health y /auth quedan públicos).

   FASE 2 (WhatsApp real): reemplazar el console.log del mock por el envío
   a la Cloud API de WhatsApp (plantilla de OTP); el resto no cambia.

   SECRETO: JWT_SECRET en .env. Sin ella: en desarrollo se usa una clave
   de desarrollo con AVISO en consola; en producción el proceso NO termina
   de arrancar (fail-closed, igual que el guard de CORS de server.js).
   ============================================================================ */
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { camelize } = require('../utils/camel');
const { fail } = require('../utils/errors');

const router = express.Router();

/* ------------------------------------------------------------------ secret */
const SECRETO_DEV = 'secreto-de-desarrollo-cambiar';
const SECRETO = process.env.JWT_SECRET ||
  (process.env.NODE_ENV === 'production' ? null : SECRETO_DEV);
if (!SECRETO) {
  console.error('[auth] FATAL: con NODE_ENV=production es obligatorio definir JWT_SECRET en el entorno.');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.warn('[auth] AVISO: JWT_SECRET no está en .env — estoy usando una clave de desarrollo porque no es producción.');
}

/* ------------------------------------------------------------- constantes */
const OTP_VIDA_MS = 5 * 60 * 1000;      /* el código vive 5 minutos */
const OTP_MAX_INTENTOS = 5;             /* a la 5ª falla, quemar el código */
const OTP_REENVIO_MS = 30 * 1000;       /* anti-spam: 30 s entre envíos */
const JWT_DIAS = 30;                    /* validez del token de sesión */

/* --------------------------------------------------------------------------------
   Store de OTP en memoria (Fase 1): telefono → { codigo, creado, expira, intentos }
   Volatil a propósito: un reinicio del server invalida los códigos pendientes.
   -------------------------------------------------------------------------------- */
const otps = new Map();

function normalizarTelefono(valor) {
  return String(valor == null ? '' : valor).replace(/[^\d+]/g, '');
}

/* Formato: 8..15 dígitos (acepta el '+' de prefijo internacional; el resto
   se normalizó fuera: sin espacios/guiones). Guarda en la BD tal cual. */
function telefonoValido(tel) {
  const solo = tel.replace(/\D/g, '');
  return solo.length >= 8 && solo.length <= 15;
}

function otpActivo(tel) {
  const o = otps.get(tel);
  if (!o) return null;
  if (Date.now() > o.expira) { otps.delete(tel); return null; }
  return o;
}

function firmarToken(usuario) {
  /* HS256 fijado (no permitir que el header pida HS512/none). Expira 30d. */
  return jwt.sign(
    { sub: usuario.id, telefono: usuario.telefono, rol: usuario.rol },
    SECRETO,
    { expiresIn: '30d', algorithm: 'HS256' }
  );
}

/* -------------------------------------------------- POST /request-otp ---- */
router.post('/request-otp', function (req, res) {
  const tel = normalizarTelefono((req.body || {}).telefono);
  if (!telefonoValido(tel)) {
    fail(400, 'Número inválido: enviá el WhatsApp en formato internacional sin espacios, p.ej. 5491112345678');
  }

  const pendiente = otpActivo(tel);
  if (pendiente && (Date.now() - pendiente.creado) < OTP_REENVIO_MS) {
    fail(429, 'Ya se envió un código hace instantes. Esperá un momento para pedir otro.');
  }

  const codigo = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  otps.set(tel, { codigo: codigo, creado: Date.now(), expira: Date.now() + OTP_VIDA_MS, intentos: 0 });

  /* Mock del canal: Fase 1 imprime; Fase 2 llama a la Cloud API de WhatsApp
     (plantilla de OTP) con el mismo codigo generado acá. */
  console.log('[auth][WHATSAPP-MOCK] → ' + tel + ' · OTP: ' + codigo + ' · vence en 5 minutos');

  const respuesta = { enviado: true, canal: 'whatsapp-mock', expiraEn: Math.round(OTP_VIDA_MS / 1000) };
  /* Dato de prueba alineado al spec: únicamente en desarrollo */
  if (process.env.NODE_ENV === 'development') respuesta.dev = { otp: codigo };
  res.status(200).json(respuesta);
});

/* -------------------------------------------------- POST /verify-otp ----- */
router.post('/verify-otp', function (req, res) {
  const body = req.body || {};
  const tel = normalizarTelefono(body.telefono);
  if (!telefonoValido(tel)) fail(400, 'Número inválido: volvé al paso 1 y ingresá tu WhatsApp');

  const otp = String(body.otp == null ? '' : body.otp).replace(/\D/g, '');
  if (otp.length !== 6) fail(400, 'El código tiene 6 dígitos');

  const nombreTaller = String(body.nombreTaller == null ? '' : body.nombreTaller).trim();

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

  /* Upsert por teléfono: primer ingreso crea el usuario (rol admin);
     ingresos posteriores sólo actualizan el nombre del taller si vino. */
  const idNuevo = db.nuevoId();
  db.tx(function () {
    const previo = db.getOne('SELECT id FROM usuarios WHERE telefono = ?', [tel]);
    if (previo) {
      if (nombreTaller) {
        db.run('UPDATE usuarios SET nombre_taller = ? WHERE id = ?', [nombreTaller, previo.id]);
      }
    } else {
      db.run(
        'INSERT INTO usuarios (id, telefono, nombre_taller, rol) VALUES (?, ?, ?, ?)',
        [idNuevo, tel, nombreTaller || null, 'admin']
      );
    }
  });

  const usuario = db.getOne('SELECT id, telefono, nombre_taller, rol, created_at FROM usuarios WHERE telefono = ?', [tel]);
  res.status(200).json({ token: firmarToken(usuario), usuario: camelize(usuario) });
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
      ? 'Sesión vencida: ingresá de nuevo con tu WhatsApp'
      : 'Token inválido: iniciá sesión de nuevo');
  }

  req.usuario = payload;
  next();
}

module.exports = { router: router, proteger: proteger };
