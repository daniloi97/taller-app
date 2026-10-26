/* ============================================================================
   server.js — punto de entrada de la API (Express)

   · Middlewares de base: cors + express.json + log de línea.
   · Rutas móntadas bajo /api/v1. DENY-BY-DEFAULT (Fase 5 · C3): health y /auth
     quedan arriba del `proteger` global — TODO lo montado debajo exige JWT
     válido (sin listas de bloqueo por indexOf ni distinción de mayúsculas).
   · Manejo centralizado de errores: cualquier throw/fail() cae al final y
     responde JSON homogéneo { error: { codigo, mensaje, detalles } }.
   ============================================================================ */
'use strict';

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const db = require('./db');
const { ApiError } = require('./utils/errors');
const auth = require('./routes/auth');

const app = express();
app.disable('x-powered-by');

/* ------------------------------------------------------------- básicos */
/* Fail-closed (Fase 5 · C1): sólo el valor EXACTO 'development' es laxo.
   NODE_ENV ausente, 'prod', 'staging', 'test'… ⇒ modo estricto. */
const ES_DEV = process.env.NODE_ENV === 'development';
const ES_PRODUCCION = !ES_DEV;

/* Cabeceras de seguridad HTTP (CSP, nosniff, X-Frame-Options, HSTS…).
   Sobre APIs que sólo responden JSON son inofensivas y protegen si algún
   día se sirve HTML desde acá. */
app.use(helmet());

/* CORS: reflexivo por defecto (dev local). En producción se EXIGE una lista
   de orígenes — el proceso se niega a arrancar si no está configurada. */
const ORIGEN = process.env.CORS_ORIGIN || '*';
if (ES_PRODUCCION && (!process.env.CORS_ORIGIN || ORIGEN === '*')) {
  console.error('[api] FATAL: con NODE_ENV=production no se admite CORS abierto (*). Seteá CORS_ORIGIN con los orígenes del frontend (separados por coma).');
  process.exit(1);
}
app.use(cors({ origin: ORIGEN === '*' ? true : ORIGEN.split(',').map(function (o) { return o.trim(); }) }));
app.use(express.json({ limit: '200kb' }));

/* Log mínimo de acceso (una línea por request, sólo fuera de producción) */
if (!ES_PRODUCCION) {
  app.use(function (req, res, next) {
    const t0 = Date.now();
    res.on('finish', function () {
      console.log('[api] ' + req.method + ' ' + req.originalUrl + ' → ' + res.statusCode + ' (' + (Date.now() - t0) + ' ms)');
    });
    next();
  });
}

/* ---------------------------------------------------------------- rutas */
/* DENY-BY-DEFAULT (Fase 5 · C3): 1) health público · 2) /auth público
   (sus rutas privadas ya llevan proteger) · 3) proteger GLOBAL — todo lo
   montado debajo exige JWT sin importar mayúsculas ni rutas nuevas;
   4-6) los routers de negocio, sin proteger duplicado en cada uno. */
const api = express.Router();

/* Health mínimo ({ok}): sin driver ni ruta de la BD (C3/W7) — 503 si la
   base no responde. */
api.get('/health', function (req, res) {
  const ok = !!db.chequearConexion();
  res.status(ok ? 200 : 503).json({ ok: ok });
});

api.use('/auth', auth.router);

api.use(auth.proteger);   /* ← frontera: abajo reina el JWT */

const clientes = require('./routes/clientes');
api.use('/clientes', clientes);

const vehiculos = require('./routes/vehiculos');
api.use('/vehiculos', vehiculos);

const ordenes = require('./routes/ordenes');
api.use('/vehiculos', ordenes.routerVehiculos);   /* GET /vehiculos/:vid/ordenes */
api.use('/ordenes', ordenes.router);              /* POST / · GET/PUT/DELETE /:id */

app.use('/api/v1', api);

/* ------------------------------------------- 404 de rutas no definidas */
app.use('/api', function (req, res) {
  res.status(404).json({
    error: {
      codigo: 'RUTA_NO_ENCONTRADA',
      mensaje: 'La ruta ' + req.method + ' ' + req.originalUrl + ' no existe en esta API'
    }
  });
});

/* ---------------------- manejo centralizado de errores ---------------- */
app.use(function (err, req, res, next) {
  /* errores de negocio explícitos (fail/spec respuestas) */
  if (err instanceof ApiError) {
    const cuerpo = { error: { codigo: err.codigo, mensaje: err.message } };
    if (err.detalles) cuerpo.error.detalles = err.detalles;
    return res.status(err.status).json(cuerpo);
  }

  /* body JSON malformado de express.json() */
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { codigo: 'JSON_INVALIDO', mensaje: 'El cuerpo de la petición no es JSON válido' }
    });
  }

  /* violaciones de integridad del motor (backstop de las validaciones) */
  if (err && typeof err.code === 'string' && err.code.indexOf('SQLITE_') === 0) {
    if (err.code.indexOf('UNIQUE') > 0) {
      return res.status(409).json({
        error: { codigo: 'UNICIDAD', mensaje: 'El registro viola una clave única (dni o patente)' }
      });
    }
    if (err.code.indexOf('FOREIGNKEY') > 0) {
      return res.status(409).json({
        error: { codigo: 'FK_INVALIDA', mensaje: 'La referencia indicada no existe' }
      });
    }
    if (err.code.indexOf('CHECK') > 0) {
      /* Los mensajes del driver pueden incluir fragmentos del SQL y los
         valores que fallaron: quedan sólo en el log del servidor. */
      console.error('[api][SQLITE CHECK] ' + (err.stack || err.message));
      return res.status(400).json({
        error: { codigo: 'CHEQUEO_DATOS', mensaje: 'Un campo no cumple el dominio definido' }
      });
    }
  }

  /* desconocidos: log completo + 500 genérico (sin filtrar stack al cliente) */
  console.error('[api][ERROR] ' + (err && err.stack ? err.stack : err));
  res.status(500).json({
    error: { codigo: 'ERROR_INTERNO', mensaje: 'Error interno del servidor' }
  });
});

/* -------------------------------------------------------- arranque ---- */
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, function () {
  console.log('[api] Historia Clínica Vehicular escuchando en http://localhost:' + PORT);
  console.log('[api] Driver: ' + db.driver + ' · BD: ' + db.DB_PATH);
  console.log('[api] Health check: GET /api/v1/health');
});
