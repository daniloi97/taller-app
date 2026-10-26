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

/* Teléfono: SÓLO dígitos (Fase 5 · W4). El '+' se elimina también, así
   '+5491123456789' y '5491123456789' llegan a la MISMA clave en usuarios:
   sin variantes por separado, no hay bypass de la cuota OTP ni cuentas
   duplicadas. La migración de db.js limpia los '+' ya guardados. */
function normTelefono(valor) {
  return String(valor == null ? '' : valor).replace(/\D/g, '');
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

module.exports = { normDni, normPatente, normTelefono, hoyISO, fechaISOoNada, enteroOoNada, monto0 };
