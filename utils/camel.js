/* ============================================================================
   utils/camel.js — transformación snake_case ↔ camelCase (req. Nº 2)

   El schema.sql usa snake_case (cliente_id, mano_obra, precio_unitario,
   fecha_alta, nombre_snapshot…); la API consume y devuelve camelCase
   (clienteId, manoObra, precioUnitario, fechaAlta, nombreSnapshot…).

   `camelize()` se aplica en TODA res.json() de la API: transforma objetos y
   arrays de forma profunda (incluye los objetos anidados `titular`,
   `periodo`, `tareas`, `repuestos` de las respuestas compuestas).
   ============================================================================ */
'use strict';

/* snake_case → camelCase: cliente_id → clienteId, mano_obra → manoObra */
function snakeACamel(clave) {
  return String(clave).replace(/_([a-z0-9])/gi, function (coincidencia, letra) {
    return letra.toUpperCase();
  });
}

/* Transformación profunda: objetos (claves), arrays (elementos), escalares
   (pasan intactos). Los valores null/undefined/primitivos no se copian. */
function camelize(valor) {
  if (Array.isArray(valor)) return valor.map(camelize);
  if (valor && typeof valor === 'object') {
    const salida = {};
    for (const clave of Object.keys(valor)) {
      salida[snakeACamel(clave)] = camelize(valor[clave]);
    }
    return salida;
  }
  return valor;
}

module.exports = { snakeACamel, camelize };
