/* ============================================================================
   db.js — capa de acceso a datos (driver-a-agnostic)

   Motor actual: SQLite vía better-sqlite3 (sincronía + rendimiento nativo).
   El schema.sql del proyecto corre idéntico en PostgreSQL 12+; el adapter
   pg queda así:

     1. `npm i pg`
     2. DB_DRIVER=pg + variables PG* en .env
     3. Reemplazar el bloque de conexión por un pg.Pool y adaptar los tres
        primitives (selectAll/getOne/run) a `pool.query(sql, params)` y
        reescribir placeholders `?` → `$1, $2…` (el ORDER BY rowid de
        tareas/repuestos pasa a ORDER BY id de creación).
     4. tx(fn): BEGIN … fn con await … COMMIT / ROLLBACK con client dedicado.

   API expuesta (ESTRUCTURA síncrona — better-sqlite3):
     · selectAll(sql, params) → filas []
     · getOne(sql, params)    → fila | undefined
     · run(sql, params)       → { changes }
     · tx(fn)                 → atomicidad; fn debe ser SÍNCRONO (todas las
       llamadas sobre los primitives dentro de fn corren en un solo bloque,
       garantizado por el event loop de Node) — así la transacción nunca
       intercala con otro request.
     · nuevoId()              → crypto.randomUUID() nativo (req. Nº 3)

   Arranque: si la base está vacía (sin tabla `clientes`) aplica schema.sql
   automáticamente; `npm run setup` también lo fuerza en cualquier momento
   (IF NOT EXISTS → idempotente).
   ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const DRIVER = (process.env.DB_DRIVER || 'sqlite').toLowerCase();
const DB_PATH = process.env.DB_PATH || './data/taller.sqlite';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/* ---------------------------------------------------------------- conexión */
let sqlite = null;

if (DRIVER === 'sqlite') {
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
  sqlite = new Database(DB_PATH);
  /* PRAGMA foreign_keys = ON: obligatorio por conexión en SQLite (req. Nº 1) */
  sqlite.pragma('foreign_keys = ON');
  /* WAL: lecturas concurrentes sin bloquear escrituras del taller */
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
} else {
  throw new Error(
    'DB_DRIVER="' + DRIVER + '" aún no está activo en esta versión. ' +
    'Usá DB_DRIVER=sqlite o migrá con el adapter pg documentado arriba de este archivo.'
  );
}

/* ------------------------------------------------------------- primitives */
const selectAll = (sql, params = []) => sqlite.prepare(sql).all(...params);
const getOne = (sql, params = []) => sqlite.prepare(sql).get(...params);
const exec = (sql) => sqlite.exec(sql);           /* DDL / scripts */
const run = (sql, params = []) => sqlite.prepare(sql).run(...params); /* { changes } */

/* Transacción atómica: fn SÍNCRONA (ver nota del encabezado) */
const tx = (fn) => sqlite.transaction(fn)();

/* ---------------------------------------------- esquema inicial (opcional) */
function ejecutarSchema() {
  exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

/* ORDEN CRÍTICO: la migración corre ANTES del schema — sobre una base
   Fase 1 la tabla `usuarios` existe sin las columnas nuevas, y el schema
   (CREATE UNIQUE INDEX ... ON usuarios (email)) fallaría "no such column"
   si el índice se creara primero. Con la migración previa: la DB vieja
   recibe las columnas ANTES (boot sobrevive y fusiona Fases) y la DB
   nueva no tiene tabla aún (PRAGMA vacía → la migración no hace nada;
   el schema crea todo). El schema se aplica SIEMPRE: en base vacía crea
   TODO y sobre una base previa re-ejecuta el DDL idempotente. */
migrarUsuariosFase2();
ejecutarSchema();

/* ---------------------------------------------------------------- migración */
/* Migración ADITIVA para bases anteriores (idempotente): ALTER TABLE sólo si
   falta la columna, inspeccionando antes PRAGMA table_info. Con esto la
   tabla `usuarios` de la Fase 1 (teléfono + OTP) gana sin perder datos los
   campos de la Fase 2 (email, password_hash, cuota de OTP y bloqueo de
   intentos) y de la Fase 4 (nombre/apellido, identidad personal).
   NOTA: ADD COLUMN con DEFAULT (constante) es válido en SQLite;
   CURRENT_DATE se deja NULL y la lógica de cuota lo trata como
   "primera vez este mes". */
function migrarUsuariosFase2() {
  const cols = selectAll('PRAGMA table_info(usuarios)');
  if (!cols.length) return;          /* tabla aún no creada (schema la hace) */
  const presentes = {};
  cols.forEach(function (c) { presentes[c.name] = true; });

  const campos = {
    email:             'ALTER TABLE usuarios ADD COLUMN email VARCHAR(140)',
    password_hash:     'ALTER TABLE usuarios ADD COLUMN password_hash VARCHAR(255)',
    nombre:            'ALTER TABLE usuarios ADD COLUMN nombre VARCHAR(80)',
    apellido:          'ALTER TABLE usuarios ADD COLUMN apellido VARCHAR(80)',
    otp_conteo_mes:    'ALTER TABLE usuarios ADD COLUMN otp_conteo_mes INTEGER DEFAULT 0',
    otp_ultimo_reset:  'ALTER TABLE usuarios ADD COLUMN otp_ultimo_reset DATE',
    intentos_fallidos: 'ALTER TABLE usuarios ADD COLUMN intentos_fallidos INTEGER DEFAULT 0'
  };
  Object.keys(campos).forEach(function (col) {
    if (!presentes[col]) {
      exec(campos[col]);
      console.log('[db][migracion] usuarios.' + col + ' agregada (migración de auth)');
    }
  });

  /* índices únicos (IF NOT EXISTS → idempotentes; admiten NULL repetidos).
     Si una base legada ya trae emails/teléfonos duplicados, el CREATE
     UNIQUE INDEX fallaría y tiraría abajo el arranque: se registra el
     aviso y la app arranca igual (los check-then-insert de auth siguen
       protegiendo; limpiar duplicados antes de forzar el índice). */
  ['telefono', 'email'].forEach(function (col) {
    try {
      exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_' + col + ' ON usuarios (' + col + ')');
    } catch (e) {
      console.log('[db][migracion] idx_usuarios_' + col + ' NO creado: la base ya tiene '
        + col + ' duplicados — deduplicar y reintentar (' + e.message + ')');
    }
  });
}

function nuevoId() {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------- salud */
function chequearConexion() {
  return getOne('SELECT COUNT(*) AS n FROM clientes').n >= 0;
}

module.exports = {
  driver: DRIVER,
  DB_PATH,
  selectAll, getOne, run, exec, tx,
  nuevoId,
  ejecutarSchema,
  chequearConexion
};
