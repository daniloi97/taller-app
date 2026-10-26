/* ============================================================================
   routes/clientes.js — /api/v1/clientes (aislamiento multi-tenant, Fase 5)

   GET    /              Lista (o filtro ?dni=) — SOLO clientes del taller del
                         usuario del JWT (usuario_id = req.usuario.sub)
   GET    /:id           Ficha: cliente + vehículos activos e históricos
   POST   /              Alta (DNI único POR TALLER; normaliza dígitos)
   PUT    /:id           Contacto: nombre / telefono / email
   DELETE /:id           Baja — los vehículos pasan a cliente_id = NULL
                         (ON DELETE SET NULL del schema.sql) = "Propietario
                         desconocido"; el historial de dueños conserva sus
                         snapshots y pierde sólo la referencia.

   REGLA C4: todo read/write resuelve SIEMPRE dentro del tenant del token.
   Un recurso ajeno responde 404 (nunca 403): sin oráculos de enumeración.
   ============================================================================ */
'use strict';

const express = require('express');
const db = require('../db');
const { camelize } = require('../utils/camel');
const { fail } = require('../utils/errors');
const { normDni } = require('../utils/normalizar');

const router = express.Router();

/* Solo columnas portátiles; nombres de respuesta camelCase vía camelize().
   cantidad: subconsultas agregadas para la UI del front sin N+1 fetches. */
const CAMPOS_CLIENTE =
  'id, nombre, dni, telefono, email, fecha_alta,' +
  ' (SELECT COUNT(*) FROM vehiculos ve WHERE ve.cliente_id = clientes.id AND ve.estado = \'activo\') AS vehiculos_activos';

/* Row compuesto del boletín: datos del auto + conteo de servicios + titular vigente.
   Las subconsultas siempre califican por tabla: `id` a secas colisionaría con
   el `id` interno de ordenes_trabajo (y sería ambiguo en los joins). */
const CAMPOS_VEHICULO_FICHA =
  'id, patente, marca, modelo, anio, color, km, motor, estado, cliente_id, fecha_alta,' +
  ' (SELECT COUNT(*) FROM ordenes_trabajo ot WHERE ot.vehiculo_id = vehiculos.id) AS cantidad_servicios';

/* ------------------------------------------------------- GET / (lista) */
router.get('/', (req, res) => {
  const dni = normDni(req.query.dni);
  let filas;
  if (dni) {
    filas = db.selectAll(
      'SELECT ' + CAMPOS_CLIENTE + ' FROM clientes WHERE dni = ? AND usuario_id = ? ORDER BY nombre',
      [dni, req.usuario.sub]
    );
  } else {
    filas = db.selectAll(
      'SELECT ' + CAMPOS_CLIENTE + ' FROM clientes WHERE usuario_id = ? ORDER BY nombre',
      [req.usuario.sub]
    );
  }
  res.json(camelize(filas));
});

/* ---------------------------- GET /:id (ficha compuesta) --------------- */
router.get('/:id', (req, res) => {
  const cli = db.getOne(
    'SELECT ' + CAMPOS_CLIENTE + ' FROM clientes WHERE id = ? AND usuario_id = ?',
    [req.params.id, req.usuario.sub]
  );
  if (!cli) fail(404, 'Cliente no encontrado');

  /* Titulares actuales del cliente (auto en circulación a su nombre) */
  const activos = db.selectAll(
    'SELECT ' + CAMPOS_VEHICULO_FICHA + ' FROM vehiculos' +
    ' WHERE cliente_id = ? AND estado = ? ORDER BY patente',
    [cli.id, 'activo']
  );

  /* Vehículos que tuvo a su nombre (por periodo en historial_duenos) y ya
     no tiene: periodo-centrado, como el histórico que muestra la ficha.
     La exclusión usa IS (no =): con `=` un auto sin titular ahora mismo
     haría NULL toda la condición y desaparecería del histórico. */
  const historicos = db.selectAll(
    'SELECT v.id, v.patente, v.marca, v.modelo, v.anio, v.color, v.km, v.motor, v.estado, v.cliente_id, v.fecha_alta,' +
    '       (SELECT COUNT(*) FROM ordenes_trabajo ot WHERE ot.vehiculo_id = v.id) AS cantidad_servicios,' +
    '       hd.id AS historial_id, hd.fecha_desde, hd.fecha_hasta, c2.nombre AS titular_actual' +
    '  FROM historial_duenos hd' +
    '  JOIN vehiculos v ON v.id = hd.vehiculo_id' +
    '  LEFT JOIN clientes c2 ON c2.id = v.cliente_id' +
    ' WHERE hd.cliente_id = ?' +
    '   AND NOT (v.cliente_id IS ? AND v.estado IS ?)' +
    ' ORDER BY hd.fecha_hasta DESC',
    [cli.id, cli.id, 'activo']
  );

  res.json(camelize(Object.assign({}, cli, {
    vehiculosActivos: activos,
    vehiculosHistoricos: historicos
  })));
});

/* ------------------------------------------------------------- POST / -- */
router.post('/', (req, res) => {
  const body = req.body || {};
  const nombre = String(body.nombre == null ? '' : body.nombre).trim();
  const dni = normDni(body.dni);
  const telefono = String(body.telefono == null ? '' : body.telefono).trim() || null;
  const email = String(body.email == null ? '' : body.email).trim() || null;

  if (!nombre) fail(400, 'El nombre es obligatorio');
  if (!dni) fail(400, 'El DNI es obligatorio (sólo dígitos)');

  /* Valida unicidad EN EL TALLER antes del insert: el índice UNIQUE compuesto
     (usuario_id, dni) es el backstop — el mismo DNI puede existir en otro taller
     sin bloquear este alta. */
  if (db.getOne('SELECT 1 AS ok FROM clientes WHERE dni = ? AND usuario_id = ?', [dni, req.usuario.sub])) {
    fail(409, 'Ya existe un cliente con el DNI ' + dni);
  }

  const id = db.nuevoId();
  db.tx(function () {
    db.run(
      'INSERT INTO clientes (id, usuario_id, nombre, dni, telefono, email) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.usuario.sub, nombre, dni, telefono, email]
    );
  });

  const creado = db.getOne('SELECT ' + CAMPOS_CLIENTE + ' FROM clientes WHERE id = ?', [id]);
  res.status(201).location('/api/v1/clientes/' + id).json(camelize(creado));
});

/* ------------------------------------------------------------- PUT /:id  */
/* Actualiza SOLO datos de contacto: el DNI es clave de negocio y no viaja */
router.put('/:id', (req, res) => {
  const cli = db.getOne('SELECT id FROM clientes WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.sub]);
  if (!cli) fail(404, 'Cliente no encontrado');

  const body = req.body || {};
  const CAMBIABLES = { nombre: 'nombre', telefono: 'telefono', email: 'email' };
  const claves = Object.keys(CAMBIABLES).filter(function (k) { return body[k] != null; });
  if (!claves.length) fail(400, 'Nada que actualizar: enviá uno de nombre, telefono, email');

  db.tx(function () {
    claves.forEach(function (k) {
      const valor = String(body[k]).trim() || null;
      db.run('UPDATE clientes SET ' + CAMBIABLES[k] + ' = ? WHERE id = ?', [valor, cli.id]);
    });
  });

  const actualizado = db.getOne('SELECT ' + CAMPOS_CLIENTE + ' FROM clientes WHERE id = ?', [cli.id]);
  res.json(camelize(actualizado));
});

/* ---------------------------------------------------- DELETE /:id ------ */
router.delete('/:id', (req, res) => {
  const cli = db.getOne('SELECT id FROM clientes WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.sub]);
  if (!cli) fail(404, 'Cliente no encontrado');

  const conexos = db.getOne('SELECT COUNT(*) AS n FROM vehiculos WHERE cliente_id = ?', [cli.id]).n;

  db.tx(function () {
    db.run('DELETE FROM clientes WHERE id = ?', [cli.id]);
  });

  /* La FK ON DELETE SET NULL dejó cada vehículo conexo con cliente_id NULL
     ("Propietario desconocido"); el historial de dueños conservó sus
     snapshots y sólo perdió la referencia del cliente borrado. */
  res.json({
    mensaje: 'Cliente eliminado; ' + conexos + ' vehículo(s) quedaron como "Propietario desconocido"',
    id: cli.id,
    vehiculosSinTitular: conexos
  });
});

module.exports = router;
