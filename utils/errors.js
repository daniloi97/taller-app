/* ============================================================================
   utils/errors.js — errores de negocio con estado HTTP + ApiError
   El middleware central de server.js los traduce a JSON homogéneo:
     { "error": { "codigo": "...", "mensaje": "...", "detalles": [...] } }
   ============================================================================ */
'use strict';

class ApiError extends Error {
  constructor(status, mensaje, detalles) {
    super(mensaje);
    this.name = 'ApiError';
    this.status = status;              /* código HTTP */
    this.codigo = CODIGOS[status] || 'ERROR';
    if (detalles) this.detalles = detalles;
  }
}

const CODIGOS = {
  401: 'NO_AUTORIZADO',
  400: 'PETICION_VALIDACION',
  403: 'REAUTENTICACION',
  404: 'RECURSO_NO_ENCONTRADO',
  409: 'CONFLICTO_DATOS',
  429: 'LIMITE_SOLICITUDES',
  500: 'ERROR_INTERNO'
};

/* fail(400, '…') lanza ApiError: interrumpe la ruta y cae al middleware */
function fail(status, mensaje, detalles) {
  throw new ApiError(status, mensaje, detalles);
}

module.exports = { ApiError, fail };
