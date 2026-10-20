/* ============================================================================
   server.js — punto de entrada de la API (Express)

   · Middlewares de base: cors + express.json + log de línea.
   · Rutas móntadas bajo /api/v1 en módulos routes/ (clientes, vehiculos,
     ordenes).
   · Manejo centralizado de errores: cualquier throw/fail() cae al final y
     responde JSON homogéneo { error: { codigo, mensaje, detalles } }.
   ============================================================================ */
'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { ApiError } = require('./utils/errors');

const app = express();
app.disable('x-powered-by');

/* ------------------------------------------------------------- básicos */
const ORIGEN = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: ORIGEN === '*' ? true : ORIGEN.split(',').map(function (o) { return o.trim(); }) }));
app.use(express.json({ limit: '200kb' }));

/* Log mínimo de acceso (una línea por request, sólo en desarrollo) */
if (process.env.NODE_ENV !== 'production') {
  app.use(function (req, res, next) {
    const t0 = Date.now();
    res.on('finish', function () {
      console.log('[api] ' + req.method + ' ' + req.originalUrl + ' → ' + res.statusCode + ' (' + (Date.now() - t0) + ' ms)');
    });
    next();
  });
}

/* ---------------------------------------------------------------- rutas */
const api = express.Router();

api.get('/health', function (req, res) {
  res.json({
    ok: true,
    driver: db.driver,
    db: db.DB_PATH,
    consultable: db.chequearConexion()
  });
});

api.use('/clientes', require('./routes/clientes'));
api.use('/vehiculos', require('./routes/vehiculos'));
/* ordenes monta en la raíz: expone tanto /ordenes/* como
   /vehiculos/:vehiculoId/ordenes (sin colisionar con el módulo vehiculos) */
api.use('/', require('./routes/ordenes'));

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
      return res.status(400).json({
        error: { codigo: 'CHEQUEO_DATOS', mensaje: 'Un campo no cumple el dominio definido', detalle: err.message }
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
