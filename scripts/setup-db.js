/* ============================================================================
   scripts/setup-db.js — script de arranque rápido de la base de datos

   · Crea el directorio de datos si no existe.
   · Aplica schema.sql en estado limpio (IF NOT EXISTS → idempotente:
     lo podés correr sobre una base existente sin tocar los datos).
   · Verifica las 6 tablas y los 8 índices del esquema.
   ============================================================================ */
'use strict';

const db = require('../db');
const path = require('path');

console.log('[setup] Driver : ' + db.driver);
console.log('[setup] BD     : ' + path.resolve(db.DB_PATH));

db.ejecutarSchema();
console.log('[setup] Schema aplicado (CREATE ... IF NOT EXISTS, sin datos):');

const TABLAS = ['clientes', 'vehiculos', 'historial_duenos', 'ordenes_trabajo', 'tareas_orden', 'repuestos_orden'];
const INDICES = db.selectAll("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'", []);

TABLAS.forEach(function (t) {
  const n = db.getOne('SELECT COUNT(*) AS n FROM ' + t).n;
  console.log('        · ' + t + ' (vacía: ' + n + ' filas)');
});
console.log('[setup] Índices: ' + INDICES.map(function (i) { return i.name; }).join(', '));
console.log('[setup] Listo — arrancá la API con "npm start".');
