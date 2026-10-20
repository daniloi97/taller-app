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

/* Aplicación de schema SIEMPRE en el arranque: en base vacía crea TODO; sobre una
   base previa re-ejecuta el DDL idempotente (CREATE ... IF NOT EXISTS) y añade
   las tablas nuevas sin perder datos (así la tabla `usuarios` de la Fase 1
   de auth también aparece en un taller.sqlite creado antes del update). */
ejecutarSchema();

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
