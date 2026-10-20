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
const helmet = require('helmet');
const cors = require('cors');
const db = require('./db');
const { ApiError } = require('./utils/errors');
const auth = require('./routes/auth');

const app = express();
app.disable('x-powered-by');

/* ------------------------------------------------------------- básicos */
const ES_PRODUCCION = process.env.NODE_ENV === 'production';

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
    /* En producción no se filtra la ruta de la BD del servidor */
    db: ES_PRODUCCION ? undefined : db.DB_PATH,
    consultable: db.chequearConexion()
  });
});

/* ---- AUTENTICACIÓN (público): pedir y verificar el OTP por teléfono ---- */
api.use('/auth', auth.router);

/* ---- RUTAS DEL NEGOCIO: exigir Authorization: Bearer <token> (JWT) ------ */
api.use('/clientes', auth.proteger, require('./routes/clientes'));
api.use('/vehiculos', auth.proteger, require('./routes/vehiculos'));
/* ordenes monta en la raíz porque responde a /ordenes/* y a
   /vehiculos/:vehiculoId/ordenes (paths absolutos). Al montarlo con un
   prefijo sus rutas quedarían relativas y no matchearían (verificado en
   pruebas). El proteger comodín evalúa el path: sólo las 2 familias del
   negocio exigen token — cualquier ruta inexistente que llegue acá
   (p.ej. /auth/inventado) sigue respondiendo 404 pública. */
function protegerNegocio(req, res, next) {
  if (req.path.indexOf('/ordenes') === 0 || req.path.indexOf('/vehiculos') === 0) {
    return auth.proteger(req, res, next);
  }
  next();
}
api.use('/', protegerNegocio, require('./routes/ordenes'));

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
