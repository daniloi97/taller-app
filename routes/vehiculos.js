/* ============================================================================
   routes/vehiculos.js — /api/v1/vehiculos (+ /:id/transferir)
   Aislamiento multi-tenant (Fase 5 · C4): TODO el CRUD filtra
   usuario_id = req.usuario.sub; recurso ajeno ⇒ 404 (sin oráculos).

   GET    /                        Lista con filtros ?patente= ?sin_titular=1
                                   ?estado=activo|historico ?clienteId=
   GET    /:id                     Ficha: titular actual + historial de dueños
                                   + contador de servicios (cantidadServicios)
   POST   /                        ALTA transaccional, tres modos (como en el
                                   modal del front):
                                   1) clienteId      → cliente existente
                                   2) nuevoCliente{} → alta inline (crea o
                                      reutiliza la ficha por DNI)
                                   3) sinTitular:true → cliente_id = NULL
   PUT    /:id                     Datos básicos: marca, modelo, anio, color,
                                   km, motor (la patente no se edita acá)
   POST   /:id/transferir          Transacción: snapshot del titular saliente
                                   en historial_duenos + asignación del nuevo
                                   (existente o inline) o desafiliación.
   DELETE /:id                     Baja con historia clínica en cascada (FK).
   ============================================================================ */
'use strict';

const express = require('express');
const db = require('../db');
const { camelize } = require('../utils/camel');
const { fail } = require('../utils/errors');
const { normDni, normPatente, hoyISO, fechaISOoNada, enteroOoNada } = require('../utils/normalizar');

const router = express.Router();

const ESTADOS = ['activo', 'historico'];

/* Filas de historial ya camelizadas compuestas para las respuestas */
function historialDe(vehiculoId) {
  return db.selectAll(
    'SELECT id, cliente_id, nombre_snapshot, dni_snapshot, fecha_desde, fecha_hasta' +
    ' FROM historial_duenos WHERE vehiculo_id = ?' +
    ' ORDER BY fecha_hasta IS NULL DESC, fecha_hasta DESC, fecha_desde DESC',
    [vehiculoId]
  );
}

/* Row compuesto del boletín: datos del auto + conteo de servicios
   (la UI del front muestra "N servicio(s)" sin N+1 fetches) */
const CAMPOS_VEHICULO_LISTADO =
  'id, patente, marca, modelo, anio, color, km, motor, cliente_id, estado, fecha_alta,' +
  ' (SELECT COUNT(*) FROM ordenes_trabajo ot WHERE ot.vehiculo_id = vehiculos.id) AS cantidad_servicios';

/* Ficha completa de vehículo (GET /:id, y respuesta de POST/transferir).
   SIEMPRE acotada al taller del token (C4): usuario_id en el WHERE. */
function fichaVehiculo(id, tenantId) {
  const v = db.getOne(
    'SELECT ' + CAMPOS_VEHICULO_LISTADO + ' FROM vehiculos WHERE id = ? AND usuario_id = ?',
    [id, tenantId]
  );
  if (!v) return null;
  const titular = v.cliente_id
    ? db.getOne(
        'SELECT id, nombre, dni, telefono, email, fecha_alta FROM clientes WHERE id = ? AND usuario_id = ?',
        [v.cliente_id, tenantId]
      ) || null
    : null;
  return Object.assign({}, v, {
    titular: titular,
    historialDuenos: historialDe(v.id)
  });
}

/* Alta inline de cliente usada por POST (opción 2) y transferir:
   crea la ficha, o REUTILIZA la existente del MISMO TALLER si el DNI ya está
   registrado (misma semántica que el modal "Nuevo cliente" del front). */
function crearOReutilizarCliente(dato, failFn, tenantId) {
  const nombre = String(dato.nombre == null ? '' : dato.nombre).trim();
  const dni = normDni(dato.dni);
  if (!nombre) failFn(400, 'El nombre del nuevo cliente es obligatorio');
  if (!dni) failFn(400, 'El DNI del nuevo cliente es obligatorio');
  const previo = db.getOne('SELECT id FROM clientes WHERE dni = ? AND usuario_id = ?', [dni, tenantId]);
  if (previo) return { id: previo.id, reutilizado: true };
  const id = db.nuevoId();
  db.run('INSERT INTO clientes (id, usuario_id, nombre, dni, telefono, email) VALUES (?, ?, ?, ?, ?, ?)', [
    id, tenantId, nombre, dni,
    String(dato.telefono == null ? '' : dato.telefono).trim() || null, null
  ]);
  return { id: id, reutilizado: false };
}

/* ------------------------------------------------------- GET / (lista) */
/* LISTA del taller: usuario_id se agrega SIEMPRE (independiente de filtros). */
router.get('/', (req, res) => {
  const conds = ['usuario_id = ?'];
  const params = [req.usuario.sub];
  if (req.query.patente) {
    conds.push('patente = ?');
    params.push(normPatente(req.query.patente));
  }
  if (req.query.sin_titular === 'true' || req.query.sin_titular === '1') {
    conds.push('cliente_id IS NULL');
  }
  if (req.query.clienteId) {
    conds.push('cliente_id = ?');
    params.push(String(req.query.clienteId));
  }
  if (req.query.estado) {
    if (ESTADOS.indexOf(req.query.estado) < 0) fail(400, 'El estado debe ser "activo" o "historico"');
    conds.push('estado = ?');
    params.push(req.query.estado);
  }
  const sql =
    'SELECT ' + CAMPOS_VEHICULO_LISTADO + ' FROM vehiculos WHERE ' + conds.join(' AND ') + ' ORDER BY patente';
  res.json(camelize(db.selectAll(sql, params)));
});

/* ------------------------------------------- GET /:id (ficha completa) */
router.get('/:id', (req, res) => {
  const ficha = fichaVehiculo(req.params.id, req.usuario.sub);
  if (!ficha) fail(404, 'Vehículo no encontrado');
  res.json(camelize(ficha));
});

/* ------------------------------------------------------------ POST / --- */
router.post('/', (req, res) => {
  const body = req.body || {};
  const patente = normPatente(body.patente);
  if (patente.length < 5 || patente.length > 12) {
    fail(400, 'La patente debe tener entre 5 y 12 caracteres alfanuméricos', { recibido: patente || null });
  }

  /* Modo de propietario: obligatorio EXPLÍCITO (1/2/3 como el selector) */
  const modo = body.clienteId != null && body.clienteId !== ''
    ? 'existente'
    : (body.nuevoCliente ? 'nuevo' : (body.sinTitular ? 'desconocido' : null));
  if (!modo) fail(400, 'Indicá el modo de propietario: clienteId (existente), nuevoCliente {nombre,dni} o sinTitular: true');

  if (db.getOne('SELECT 1 AS ok FROM vehiculos WHERE patente = ? AND usuario_id = ?', [patente, req.usuario.sub])) {
    fail(409, 'Ya existe un vehículo con la patente ' + patente);
  }

  const anio = enteroOoNada(body.anio);
  if (anio != null && (anio < 1900 || anio > 2100)) fail(400, 'El año debe estar entre 1900 y 2100');
  const km = enteroOoNada(body.km);
  if (km != null && km < 0) fail(400, 'El kilometraje no puede ser negativo');

  const id = db.nuevoId();

  const resultado = db.tx(function () {
    let clienteId = null;
    let clienteAviso = null;

    if (modo === 'existente') {
      /* C4: la ficha debe existir y pertenecer a MI taller (ajena ⇒ 404). */
      if (!db.getOne('SELECT 1 AS ok FROM clientes WHERE id = ? AND usuario_id = ?', [String(body.clienteId), req.usuario.sub])) {
        fail(404, 'Cliente no encontrado');
      }
      clienteId = String(body.clienteId);
    } else if (modo === 'nuevo') {
      const creado = crearOReutilizarCliente(body.nuevoCliente, fail, req.usuario.sub);
      clienteId = creado.id;
      if (creado.reutilizado) clienteAviso = 'El DNI ya estaba registrado: se reutilizó la ficha del cliente ' + creado.id;
    } /* modo 'desconocido' → clienteId queda NULL */

    db.run(
      'INSERT INTO vehiculos (id, usuario_id, patente, marca, modelo, anio, color, km, motor, cliente_id, estado)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id, req.usuario.sub, patente,
        String(body.marca == null ? '' : body.marca).trim() || 'Sin marca',
        String(body.modelo == null ? '' : body.modelo).trim() || 'Sin modelo',
        anio,
        String(body.color == null ? '' : body.color).trim() || null,
        km,
        String(body.motor == null ? '' : body.motor).trim() || null,
        clienteId,
        'activo'
      ]
    );
    return { clienteAviso: clienteAviso };
  });

  const ficha = fichaVehiculo(id, req.usuario.sub);
  res.status(201);
  res.setHeader('Location', '/api/v1/vehiculos/' + id);
  if (resultado.clienteAviso) res.setHeader('X-Aviso-Negocio', resultado.clienteAviso);
  res.json(camelize(ficha));
});

/* ------------------------------------------------------------ PUT /:id  */
const EDITABLES = { marca: 'marca', modelo: 'modelo', anio: 'anio', color: 'color', km: 'km', motor: 'motor' };

router.put('/:id', (req, res) => {
  const v = db.getOne('SELECT id FROM vehiculos WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.sub]);
  if (!v) fail(404, 'Vehículo no encontrado');

  const body = req.body || {};
  const claves = Object.keys(EDITABLES).filter(function (k) { return body[k] != null; });
  if (!claves.length) fail(400, 'Nada que actualizar: enviá marca, modelo, anio, color, km o motor');

  const anio = body.anio != null && body.anio !== '' ? enteroOoNada(body.anio) : null;
  if (body.anio != null && body.anio !== '' && (anio == null || anio < 1900 || anio > 2100)) fail(400, 'El año debe ser un número entre 1900 y 2100');
  const km = body.km != null && body.km !== '' ? enteroOoNada(body.km) : null;
  if (body.km != null && body.km !== '' && (km == null || km < 0)) fail(400, 'El kilometraje debe ser un número entero ≥ 0');

  db.tx(function () {
    claves.forEach(function (k) {
      let valor;
      if (k === 'anio') valor = enteroOoNada(body.anio);
      else if (k === 'km') valor = enteroOoNada(body.km);
      else valor = String(body[k]).trim() || null;
      db.run('UPDATE vehiculos SET ' + EDITABLES[k] + ' = ? WHERE id = ? AND usuario_id = ?', [valor, v.id, req.usuario.sub]);
    });
  });

  res.json(camelize(fichaVehiculo(v.id, req.usuario.sub)));
});

/* --------------------------------------------- POST /:id/transferir ---- */
router.post('/:id/transferir', (req, res) => {
  const v = db.getOne('SELECT * FROM vehiculos WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.sub]);
  if (!v) fail(404, 'Vehículo no encontrado');

  const body = req.body || {};
  const fechaHasta = fechaISOoNada(body.fecha, fail) || hoyISO();

  const modo = body.sinTitular
    ? 'desafiliar'
    : (body.nuevoClienteId ? 'existente' : (body.nuevoCliente ? 'nuevo' : null));
  if (!modo) fail(400, 'Indicá el destino: nuevoClienteId (cliente registrado), nuevoCliente {nombre,dni} o sinTitular: true');

  db.tx(function () {
    /* 1) Snapshot del titular saliente → historial_duenos (req. del sp) */
    if (v.cliente_id) {
      const saliente = db.getOne('SELECT nombre, dni, fecha_alta FROM clientes WHERE id = ?', [v.cliente_id]);
      if (saliente) {
        db.run(
          'INSERT INTO historial_duenos' +
          ' (id, vehiculo_id, cliente_id, nombre_snapshot, dni_snapshot, fecha_desde, fecha_hasta)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            db.nuevoId(), v.id, v.cliente_id,
            saliente.nombre, saliente.dni,
            saliente.fecha_alta || v.fecha_alta,
            fechaHasta
          ]
        );
      }
    }

    /* 2) Nuevo titular o desafiliación; el auto (re)queda en circulación.
       C4: la ficha destino debe ser del mismo taller (ajena ⇒ 404). */
    let nuevoId = null;
    if (modo === 'existente') {
      if (!db.getOne('SELECT 1 AS ok FROM clientes WHERE id = ? AND usuario_id = ?', [String(body.nuevoClienteId), req.usuario.sub])) {
        fail(404, 'Cliente no encontrado');
      }
      nuevoId = String(body.nuevoClienteId);
    } else if (modo === 'nuevo') {
      nuevoId = crearOReutilizarCliente(body.nuevoCliente, fail, req.usuario.sub).id;
    } /* 'desafiliar': nuevoId queda NULL */

    db.run('UPDATE vehiculos SET cliente_id = ?, estado = ? WHERE id = ? AND usuario_id = ?', [nuevoId, 'activo', v.id, req.usuario.sub]);
  });

  res.json(camelize(fichaVehiculo(v.id, req.usuario.sub)));
});

/* --------------------------------------------------- DELETE /:id ------- */
router.delete('/:id', (req, res) => {
  const v = db.getOne('SELECT id FROM vehiculos WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.sub]);
  if (!v) fail(404, 'Vehículo no encontrado');

  let lifetime = 0;
  db.tx(function () {
    lifetime = db.run('DELETE FROM vehiculos WHERE id = ? AND usuario_id = ?', [v.id, req.usuario.sub]).changes;
  });

  /* ON DELETE CASCADE borró historial_duenos / ordenes_trabajo y los
     detalles de cada orden (tareas_orden + repuestos_orden) */
  res.json({ mensaje: 'Vehículo eliminado junto con su historia clínica (cascada)', id: v.id, filas: lifetime });
});

module.exports = router;
