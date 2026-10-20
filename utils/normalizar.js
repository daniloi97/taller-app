/* ============================================================================
   utils/normalizar.js — normalización de datos de negocio (misma regla que
   usa el front en app.js) + utilidades de fecha ISO 8601 (YYYY-MM-DD).
   ============================================================================ */
'use strict';

/* DNI: sólo dígitos (el front envía lo ya normalizado; la API re-normaliza
   por defensa: "30.123.456" y "30123456" llegan a la misma clave) */
function normDni(valor) {
  return String(valor == null ? '' : valor).replace(/\D/g, '');
}

/* Patente: mayúsculas + alfanumérico ("ab 123 cd" → "AB123CD") */
function normPatente(valor) {
  return String(valor == null ? '' : valor).toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/* Fecha de hoy en ISO 8601 (zona UTC del servidor, coherente con CURRENT_DATE) */
function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

/* Valida y devuelve una fecha ISO; fail 400 si llega malformada */
function fechaISOoNada(valor, fail) {
  if (valor == null || valor === '') return null;
  const s = String(valor);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(400, 'La fecha "' + s + '" no es una fecha ISO 8601 válida (YYYY-MM-DD)');
  return s;
}

/* Entero positivo o null (kilometraje, año…) */
function enteroOoNada(valor) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/* Numérico ≥ 0 para montos (mano de obra, precio unitario) */
function monto0(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}

module.exports = { normDni, normPatente, hoyISO, fechaISOoNada, enteroOoNada, monto0 };
