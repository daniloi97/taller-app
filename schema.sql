/* ============================================================================
   TALLER MECÁNICO · HISTORIA CLÍNICA VEHICULAR
   schema.sql — DDL de la base de datos relacional (producción, sin datos)

   MOTORES OBJETIVO   : PostgreSQL 12+ y SQLite 3.30+ (un único script).
   ESTADO ENTREGADO   : 100% limpio — sin INSERT ni datos de prueba.
   IDEMPOTENCIA       : CREATE ... IF NOT EXISTS permite reejecutar el script.

   CONVENCIONES GENERALES
   · Claves primarias sintéticas `id VARCHAR(36)`: UUID v4 generado por la
     aplicación ANTES del INSERT. Así la integridad no depende de datos de
     negocio (DNI, patente, etc.), que sólo llevan índices UNIQUE para la
     búsqueda, no para referenciar.
   · Fechas en DATE / ISO 8601 ('YYYY-MM-DD').
   · Montos en NUMERIC(12,2); kilometraje y año en INTEGER.
   · Nombres en snake_case: la app trabaja con camelCase (vehiculos.clienteId
     ↔ vehiculos.cliente_id) y la capa backend mapea 1 a 1.

   INTEGRIDAD / BORRADO
   · Delete de CLIENTE  : no borra nada — vehículos e historial de dueños
     quedan con cliente_id NULL (el estado de negocio "Propietario
     desconocido"); los snapshots de nombre/DNI del historial sobreviven.
   · Delete de VEHÍCULO : casca todo su rastro (historial de dueños, órdenes
     de trabajo, tareas y repuestos) vía ON DELETE CASCADE.

   NOTA SQLITE: las claves foráneas se activan por CONEXIÓN con
     PRAGMA foreign_keys = ON;
   (hágalo en el driver o en cada sesión del shell; no se escribe acá porque
   PostgreSQL no admite esa sentencia). PostgreSQL la aplica por defecto.

   ORDEN DE ESQUEMA: las tablas se crean en orden de dependencia y se
   agrupan en una única transacción (ambos motores soportan DDL transaccional).
   ============================================================================ */

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) CLIENTES — titulares y su dato de búsqueda (DNI único, no referencia)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
  id         VARCHAR(36)  NOT NULL,
  nombre     VARCHAR(120) NOT NULL,
  dni        VARCHAR(20)  NOT NULL,
  telefono   VARCHAR(30),
  email      VARCHAR(140),
  fecha_alta DATE         NOT NULL DEFAULT CURRENT_DATE,
  CONSTRAINT pk_clientes PRIMARY KEY (id),
  CONSTRAINT ck_clientes_dni CHECK (dni <> '')
);

-- Búsqueda por DNI (reemplaza a la constraint UNIQUE inline; mismo efecto)
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_dni ON clientes (dni);

-- ---------------------------------------------------------------------------
-- 2) VEHÍCULOS — cliente_id NULL = "Propietario desconocido" (vehículo activo
--    que puede recibir órdenes de trabajo sin titular asociado)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehiculos (
  id         VARCHAR(36)  NOT NULL,
  patente    VARCHAR(12)  NOT NULL,
  marca      VARCHAR(60)  NOT NULL DEFAULT 'Sin marca',
  modelo     VARCHAR(80)  NOT NULL DEFAULT 'Sin modelo',
  anio       INTEGER      CHECK (anio IS NULL OR (anio BETWEEN 1900 AND 2100)),
  color      VARCHAR(40),
  km         INTEGER      CHECK (km    IS NULL OR km    >= 0),
  motor      VARCHAR(40),
  cliente_id VARCHAR(36),
  estado     VARCHAR(10)  NOT NULL DEFAULT 'activo'
             CONSTRAINT ck_vehiculos_estado CHECK (estado IN ('activo', 'historico')),
  fecha_alta DATE         NOT NULL DEFAULT CURRENT_DATE,
  CONSTRAINT pk_vehiculos PRIMARY KEY (id),
  CONSTRAINT fk_vehiculos_cliente
    FOREIGN KEY (cliente_id) REFERENCES clientes (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);

-- Patente única (búsqueda por chapa)
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehiculos_patente ON vehiculos (patente);

-- Fichas por titular + borrosos rápidos al desafiliar
CREATE INDEX IF NOT EXISTS idx_vehiculos_cliente_id ON vehiculos (cliente_id);

-- ---------------------------------------------------------------------------
-- 3) HISTORIAL_DUEÑOS — quien fue titular del vehículo y en qué período.
--    *_snapshot conservan el dato tal como era AUNQUE el cliente se borre.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historial_duenos (
  id              VARCHAR(36)  NOT NULL,
  vehiculo_id     VARCHAR(36)  NOT NULL,
  cliente_id      VARCHAR(36),
  nombre_snapshot VARCHAR(120) NOT NULL,
  dni_snapshot    VARCHAR(20)  NOT NULL,
  fecha_desde     DATE,
  fecha_hasta     DATE,
  CONSTRAINT pk_historial_duenos PRIMARY KEY (id),
  CONSTRAINT fk_historial_vehiculo
    FOREIGN KEY (vehiculo_id) REFERENCES vehiculos (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_historial_cliente
    FOREIGN KEY (cliente_id) REFERENCES clientes (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);

-- Soporte de las dos FK (cascada por vehículo / SET NULL por cliente)
CREATE INDEX IF NOT EXISTS idx_historial_duenos_vehiculo ON historial_duenos (vehiculo_id);
CREATE INDEX IF NOT EXISTS idx_historial_duenos_cliente  ON historial_duenos (cliente_id);

-- ---------------------------------------------------------------------------
-- 4) ÓRDENES DE TRABAJO — cabecera de cada ingreso del vehículo al taller
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ordenes_trabajo (
  id            VARCHAR(36)    NOT NULL,
  vehiculo_id   VARCHAR(36)    NOT NULL,
  fecha         DATE           NOT NULL DEFAULT CURRENT_DATE,
  km            INTEGER        CHECK (km IS NULL OR km >= 0),
  mano_obra     NUMERIC(12, 2) NOT NULL DEFAULT 0
                CONSTRAINT ck_ordenes_mano_obra CHECK (mano_obra >= 0),
  observaciones TEXT,
  CONSTRAINT pk_ordenes_trabajo PRIMARY KEY (id),
  CONSTRAINT fk_ordenes_vehiculo
    FOREIGN KEY (vehiculo_id) REFERENCES vehiculos (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

-- Historial cronológico por vehículo
CREATE INDEX IF NOT EXISTS idx_ordenes_vehiculo ON ordenes_trabajo (vehiculo_id);

-- ---------------------------------------------------------------------------
-- 5) TAREAS_ORDEN — tareas realizadas dentro de una orden (1 a N)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tareas_orden (
  id          VARCHAR(36)  NOT NULL,
  orden_id    VARCHAR(36)  NOT NULL,
  descripcion VARCHAR(160) NOT NULL
              CONSTRAINT ck_tareas_descripcion CHECK (descripcion <> ''),
  CONSTRAINT pk_tareas_orden PRIMARY KEY (id),
  CONSTRAINT fk_tareas_orden
    FOREIGN KEY (orden_id) REFERENCES ordenes_trabajo (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tareas_orden ON tareas_orden (orden_id);

-- ---------------------------------------------------------------------------
-- 6) REPUESTOS_ORDEN — repuestos consumidos dentro de una orden (1 a N)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repuestos_orden (
  id              VARCHAR(36)    NOT NULL,
  orden_id        VARCHAR(36)    NOT NULL,
  nombre          VARCHAR(140)   NOT NULL
                  CONSTRAINT ck_repuestos_nombre CHECK (nombre <> ''),
  cantidad        INTEGER        NOT NULL DEFAULT 1
                  CONSTRAINT ck_repuestos_cantidad CHECK (cantidad >= 1),
  precio_unitario NUMERIC(12, 2) NOT NULL DEFAULT 0
                  CONSTRAINT ck_repuestos_precio CHECK (precio_unitario >= 0),
  CONSTRAINT pk_repuestos_orden PRIMARY KEY (id),
  CONSTRAINT fk_repuestos_orden
    FOREIGN KEY (orden_id) REFERENCES ordenes_trabajo (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_repuestos_orden ON repuestos_orden (orden_id);

COMMIT;

/* ============================================================================
   RESUMEN DE ÍNDICES B-TREE
   ----------------------------------------------------------------------------
   idx_clientes_dni            UNIQUE — búsqueda de cliente por DNI
   idx_vehiculos_patente       UNIQUE — búsqueda de chapa (escáner ALPR)
   idx_vehiculos_cliente_id             — fichas por titular / SET NULL en FK
   idx_historial_duenos_vehiculo        — dueños del vehículo (FK CASCADE)
   idx_historial_duenos_cliente         — "autos que tuvo a su nombre"
   idx_ordenes_vehiculo                 — historial cronológico por vehículo
   idx_tareas_orden                     — detalle de tareas por orden
   idx_repuestos_orden                  — detalle de repuestos por orden

   Los índices de patente/DNI se implementan como UNIQUE INDEX para cumplir
   simultáneamente la restricción de unicidad y el nombre de índice pedido
   (evita dos B-Tree redundantes sobre la misma columna).

   SIN INSERT: las tablas quedan creadas y vacías, listas para producción.
   ============================================================================ */
