/* ============================================================================
   routes/ordenes.js — /api/v1/ordenes (+ listado por vehículo)
   Aislamiento multi-tenant (Fase 5 · C4): toda orden se resuelve vía JOIN con
   vehiculos (v.usuario_id = req.usuario.sub) — recurso ajeno ⇒ 404, sin
   oráculos de enumeración.

   GET    /vehiculos/:vehiculoId/ordenes  Órdenes del vehículo con sus tareas
                                          (tareas_orden) y repuestos
                                          (repuestos_orden) agrupados.
   POST   /ordenes                        ALTA transaccional: cabecera +
                                          N tareas + N repuestos + odómetro
                                          monotónico (sólo sube si el km
                                          ingresado es mayor al actual).
   PUT    /ordenes/:id                    MODIFICACIÓN transaccional: cabecera
                                          + reemplazo completo de tareas y
                                          repuestos enviados + odómetro.
   DELETE /ordenes/:id                    Baja (cascada de detalles por FK).
   ============================================================================ */
'use strict';

const express = require('express');
const db = require('../db');
const { camelize } = require('../utils/camel');
const { fail } = require('../utils/errors');
const { hoyISO, fechaISOoNada, enteroOoNada, monto0 } = require('../utils/normalizar');

const router = express.Router();            /* se monta bajo '/ordenes' */
const routerVehiculos = express.Router();   /* se monta bajo '/vehiculos' */

/* ---------- composición de una orden (POST/PUT devuelven lo creado) ----- */
function ordenCompleta(id) {
  const orden = db.getOne(
    'SELECT id, vehiculo_id, fecha, km, mano_obra, observaciones FROM ordenes_trabajo WHERE id = ?',
    [id]
  );
  if (!orden) return null;
  /* ORDER BY rowid: conserva el orden de inserción (tags del front).
     Portabilidad pg: reemplazar por una columna `creada_en` o `posicion`. */
  orden.tareas = db.selectAll('SELECT id, descripcion FROM tareas_orden WHERE orden_id = ? ORDER BY rowid', [id]);
  orden.repuestos = db.selectAll(
    'SELECT id, nombre, cantidad, precio_unitario FROM repuestos_orden WHERE orden_id = ? ORDER BY rowid',
    [id]
  );
  return orden;
}

/* ---------- normalización de los arrays del body ------------------------ */
function prepararTareas(fail, lista) {
  return lista.map(function (t) {
    const descripcion = String(t == null ? '' : t.descripcion == null ? t : t.descripcion).trim();
    if (!descripcion) fail(400, 'Una de las tareas viene sin descripción');
    return { descripcion: descripcion };
  });
}

function prepararRepuestos(fail, lista) {
  return lista.map(function (r) {
    const nombre = String(r == null ? '' : r.nombre == null ? '' : r.nombre).trim();
    if (!nombre) fail(400, 'Un repuesto viene sin nombre');
    let cantidad = r.cantidad == null || r.cantidad === '' ? 1 : enteroOoNada(r.cantidad);
    if (cantidad == null || cantidad < 1) fail(400, 'La cantidad de "' + nombre + '" debe ser un entero ≥ 1');
    const precio = monto0(r.precioUnitario);
    if (r.precioUnitario != null && Number(r.precioUnitario) < 0) fail(400, 'El precio de "' + nombre + '" no puede ser negativo');
    return { nombre: nombre, cantidad: cantidad, precio: precio };
  });
}

/* ---------- odómetro monotónico: el km del auto NUNCA retrocede ---------- */
function subirOdometro(vehiculoId, km) {
  if (km == null || km < 0) return;
  db.run(
    'UPDATE vehiculos SET km = ? WHERE id = ? AND (km IS NULL OR km < ?)',
    [km, vehiculoId, km]
  );
}

/* =================== GET /vehiculos/:vehiculoId/ordenes ================= */
/* Montado en /vehiculos por server.js → responde /vehiculos/:vid/ordenes.
   3 consultas planas (sin N+1): cabeceras + todos los detalles, agrupados.
   C4: el vehículo debe existir Y ser del taller del token (ajeno ⇒ 404);
   las órdenes y detalles quedan acotados por vehiculo_id. */
routerVehiculos.get('/:vehiculoId/ordenes', (req, res) => {
  const vid = String(req.params.vehiculoId);
  if (!db.getOne('SELECT 1 AS ok FROM vehiculos WHERE id = ? AND usuario_id = ?', [vid, req.usuario.sub])) {
    fail(404, 'Vehículo no encontrado');
  }
  const ordenes = db.selectAll(
    'SELECT id, vehiculo_id, fecha, km, mano_obra, observaciones' +
    ' FROM ordenes_trabajo WHERE vehiculo_id = ?' +
    ' ORDER BY fecha DESC, rowid DESC',
    [vid]
  );
  const tareas = db.selectAll(
    'SELECT t.id, t.orden_id, t.descripcion' +
    ' FROM tareas_orden t JOIN ordenes_trabajo o ON o.id = t.orden_id' +
    ' WHERE o.vehiculo_id = ?' +
    ' ORDER BY o.fecha DESC, o.rowid DESC, t.rowid',
    [vid]
  );
  const repuestos = db.selectAll(
    'SELECT r.id, r.orden_id, r.nombre, r.cantidad, r.precio_unitario' +
    ' FROM repuestos_orden r JOIN ordenes_trabajo o ON o.id = r.orden_id' +
    ' WHERE o.vehiculo_id = ?' +
    ' ORDER BY o.fecha DESC, o.rowid DESC, r.rowid',
    [vid]
  );

  /* agrupación O(n) por id de orden */
  const indice = {};
  ordenes.forEach(function (o) {
    o.tareas = [];
    o.repuestos = [];
    indice[o.id] = o;
  });
  tareas.forEach(function (t) { if (indice[t.orden_id]) indice[t.orden_id].tareas.push(t); });
  repuestos.forEach(function (r) { if (indice[r.orden_id]) indice[r.orden_id].repuestos.push(r); });

  res.json(camelize(ordenes));
});

/* ============================ POST /ordenes ============================= */
router.post('/', (req, res) => {
  const body = req.body || {};
  if (!body.vehiculoId) fail(400, 'Falta vehiculoId');

  const fecha = fechaISOoNada(body.fecha, fail) || hoyISO();
  const km = enteroOoNada(body.km);
  if (km != null && km < 0) fail(400, 'El kilometraje no puede ser negativo');
  const manoObra = monto0(body.manoObra);
  const observaciones = String(body.observaciones == null ? '' : body.observaciones).trim() || null;

  const tareas = prepararTareas(fail, Array.isArray(body.tareas) ? body.tareas : []);
  const repuestos = prepararRepuestos(fail, Array.isArray(body.repuestos) ? body.repuestos : []);

  const ordenId = db.nuevoId();

  db.tx(function () {
    const v = db.getOne(
      'SELECT id FROM vehiculos WHERE id = ? AND usuario_id = ?',
      [String(body.vehiculoId), req.usuario.sub]
    );
    if (!v) fail(404, 'El vehiculoId indicado no existe', { vehiculoId: body.vehiculoId });

    db.run(
      'INSERT INTO ordenes_trabajo (id, vehiculo_id, fecha, km, mano_obra, observaciones)' +
      ' VALUES (?, ?, ?, ?, ?, ?)',
      [ordenId, v.id, fecha, km, manoObra, observaciones]
    );
    tareas.forEach(function (t) {
      db.run('INSERT INTO tareas_orden (id, orden_id, descripcion) VALUES (?, ?, ?)', [db.nuevoId(), ordenId, t.descripcion]);
    });
    repuestos.forEach(function (r) {
      db.run(
        'INSERT INTO repuestos_orden (id, orden_id, nombre, cantidad, precio_unitario) VALUES (?, ?, ?, ?, ?)',
        [db.nuevoId(), ordenId, r.nombre, r.cantidad, r.precio]
      );
    });
    subirOdometro(v.id, km);
  });

  res.status(201).location('/api/v1/ordenes/' + ordenId).json(camelize(ordenCompleta(ordenId)));
});

/* ============================ PUT /ordenes/:id ========================== */
/* C4: la orden se resuelve vía JOIN con su vehículo — si el vehículo es de
   otro taller, la orden "no existe" para este token (404, nunca 403). */
router.put('/:id', (req, res) => {
  const orden = db.getOne(
    'SELECT o.* FROM ordenes_trabajo o JOIN vehiculos v ON v.id = o.vehiculo_id' +
    ' WHERE o.id = ? AND v.usuario_id = ?',
    [req.params.id, req.usuario.sub]
  );
  if (!orden) fail(404, 'Orden de trabajo no encontrada');

  const body = req.body || {};
  const fecha = fechaISOoNada(body.fecha, fail);
  const km = body.km != null && body.km !== '' ? enteroOoNada(body.km) : null;
  if (body.km != null && body.km !== '' && (km == null || km < 0)) fail(400, 'El kilometraje debe ser un entero ≥ 0');

  /* Cabecera: sólo los campos presentes (edición parcial). `undefined`
     supone "no vino del cliente" y nunca se toca. */
  const set = [];
  const params = [];
  if (body.fecha != null) { set.push('fecha = ?'); params.push(fecha || orden.fecha); }
  if (body.km != null) { set.push('km = ?'); params.push(km); }
  if (body.manoObra != null) { set.push('mano_obra = ?'); params.push(monto0(body.manoObra)); }
  if (body.observaciones != null) { set.push('observaciones = ?'); params.push(String(body.observaciones).trim() || null); }

  const reemplazaTareas = Array.isArray(body.tareas);
  const reemplazaRepuestos = Array.isArray(body.repuestos);
  const tareas = reemplazaTareas ? prepararTareas(fail, body.tareas) : [];
  const repuestos = reemplazaRepuestos ? prepararRepuestos(fail, body.repuestos) : [];

  db.tx(function () {
    if (set.length) {
      db.run('UPDATE ordenes_trabajo SET ' + set.join(', ') + ' WHERE id = ?',
        params.concat([orden.id]));
    }
    if (reemplazaTareas) {
      db.run('DELETE FROM tareas_orden WHERE orden_id = ?', [orden.id]);
      tareas.forEach(function (t) {
        db.run('INSERT INTO tareas_orden (id, orden_id, descripcion) VALUES (?, ?, ?)', [db.nuevoId(), orden.id, t.descripcion]);
      });
    }
    if (reemplazaRepuestos) {
      db.run('DELETE FROM repuestos_orden WHERE orden_id = ?', [orden.id]);
      repuestos.forEach(function (r) {
        db.run(
          'INSERT INTO repuestos_orden (id, orden_id, nombre, cantidad, precio_unitario) VALUES (?, ?, ?, ?, ?)',
          [db.nuevoId(), orden.id, r.nombre, r.cantidad, r.precio]
        );
      });
    }
    /* El odómetro sube con el km editado (mismo criterio que el alta) */
    subirOdometro(orden.vehiculo_id, km);
  });

  res.json(camelize(ordenCompleta(orden.id)));
});

/* =========================== DELETE /ordenes/:id ======================== */
/* C4: misma resolución por JOIN que el PUT (ajeno ⇒ 404). */
router.delete('/:id', (req, res) => {
  const orden = db.getOne(
    'SELECT o.id FROM ordenes_trabajo o JOIN vehiculos v ON v.id = o.vehiculo_id' +
    ' WHERE o.id = ? AND v.usuario_id = ?',
    [req.params.id, req.usuario.sub]
  );
  if (!orden) fail(404, 'Orden de trabajo no encontrada');

  db.tx(function () {
    db.run('DELETE FROM ordenes_trabajo WHERE id = ?', [orden.id]);
  });

  res.status(204).send();
});

module.exports = { router: router, routerVehiculos: routerVehiculos };
