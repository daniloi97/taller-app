# TALLER MECÁNICO · HISTORIA CLÍNICA VEHICULAR
# Documentación Técnica Oficial y Manual de Arquitectura

> **Versión del documento:** 1.0 (25/10/2026) — consolidada sobre el commit de
> Fase 4b (`e82dfcb`). Documento generado por auditoría de la base de código:
> **no modifica la aplicación**, describe su estado real.

---

## 1. Resumen Ejecutivo y Visión del Proyecto

**Nombre:** Historia Clínica Vehicular (API: `historia-clinica-vehicular-api`).

**Propósito:** gestión integral de talleres mecánicos mediante el paradigma de
*"historia clínica"* aplicado a vehículos: cada auto tiene una ficha viva con
sus titulares históricos y sus órdenes de trabajo forenses (tareas + repuestos
+ odómetro), al estilo de una historia médica. El titular del taller se
autentica (email + contraseña, o WhatsApp por OTP) y opera el sistema completo.

**Sistema de dos piezas desacopladas:**

| Pieza | Stack | Rol |
|---|---|---|
| Frontend SPA | Vanilla JS (ES2017+: async/await), IIFE, HTML, CSS | UI completa, escáner de cámara con ALPR neuronal 100 % en cliente |
| Backend API | Node.js ≥18 · Express 4 · better-sqlite3 | API REST `/api/v1`, auth JWT, única puerta a la DB relacional |

**Pilares fundamentales:**

1. **Rendimiento en cliente.** El ALPR (reconocimiento de patentes) corre
   100 % en el navegador con ONNX Runtime Web (WebGL/Wasm): la cámara no
   envía un solo frame al servidor. Los pesos neuronales (≈15 MB) viven en
   `models/` y se cargan por HTTP local — los pesos son 100 % locales;
   el runtime `onnxruntime-web` sí carga del CDN en la primera visita
   (para offline total en producción hay que vendorizarlo: ver § 5.3).
2. **Arquitectura cliente-servidor desacoplada.** El front no guarda datos de
   negocio (cero SQLite en el navegador): cada consulta y mutación viaja por
   `fetch` a la API. El estado local se limita a sesión + tema.
3. **Diseño responsivo.** CSS mobile-first (escala fluida, `viewport-fit`,
   bottom sheets modales, temperatura táctil en el escáner).
4. **Offline-first / ligero.** La app es ligera por diseño (sin framework,
   sin bundler, `onnxruntime-web` descargado una sola vez del CDN, modelos
   locales). Los **pesos neuronales (≈15 MB) operan sin red** (`models/`),
   pero el **runtime carga del CDN en la primera visita** — para offline
   total en producción hay que vendorizarlo (detalle en § 5.3). Degradación
   amable: sin conexión queda la lectura manual de patente; sin API avisa
   con mensaje accionable. *(La PWA instalable con service worker queda en
   el roadmap — § 7.)*

---

## 2. Arquitectura General del Sistema

### 2.1 Diagrama conceptual del flujo de datos

```
┌──────────────────────────────────────────────────────────────────────┐
│  NAVEGADOR (PWA-ready, SPA Vanilla JS)                               │
│                                                                      │
│  ┌───────────────┐  ┌────────────────┐  ┌─────────────────────────┐ │
│  │ Vistas raíz   │  │ Módulos app.js │  │ Motor ALPR (ONNX)       │ │
│  │ #vista-login  │  │ · apiFetch()   │  │ YOLOv9-t 640 (detector) │ │
│  │ #vista-app    │  │ · esc() /XSS   │  │ arg_cnn_ocr (lector 7)  │ │
│  │ #vista-reset  │  │ · estado DATOS │  │ models/*.onnx locales   │ │
│  └──────┬────────┘  └───────┬────────┘  └─────────────────────────┘ │
│         │                   │ fetch JSON (Bearer JWT)               │
└─────────┼───────────────────┼───────────────────────────────────────┘
          │                   ▼  HTTPS (CORS explícito en prod)
┌──────────────────────────────────────────────────────────────────────┐
│  API REST  Node.js + Express  (/api/v1)                              │
│  server.js → helmet · cors · express.json(200kb) · log de acceso     │
│ ┌──────────────┬──────────────────────────────┬───────────────────┐  │
│ │ routes/auth  │ routes/clientes │ vehiculos   │ routes/ordenes    │  │
│ │ (JWT/OTP)    │ + auth.proteger │ assets      │ (transaccional)   │  │
│ └──────┬───────┴────────┬─────────┴──────┬──────┴───────────────────┘  │
│        │   manejo centralizado de errores (ApiError → JSON homogéneo)  │
└────────┼───────────────┼───────────────┼─────────────────────────────-┘
         ▼               ▼               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  db.js (adapter)  →  SQL relacional                                   │
│  SQLite 3.30+ hoy (better-sqlite3, WAL, FK conectada por PRAGMA)      │
│  PostgreSQL 12+ objetivo (schema.sql idéntico; adapter pg documentado)│
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Modelo de responsabilidad (3 capas)

| Capa | Archivo(s) | Responsabilidad | Prohibición |
|---|---|---|---|
| Transporte | `server.js` | middlewares base, montaje de rutas, 404, manejo centralizado de errores → `{ error: { codigo, mensaje, detalles? } }` | no conoce SQL |
| Dominio | `routes/*.js` | validación de negocio (`fail()` → ApiError), transacciones, normalización | escribe SQL simple y parametrizado |
| Datos | `db.js` + `schema.sql` | conexión, PRAGMAs, migración aditiva, primitivas `selectAll/getOne/run/tx/nuevoId` | no conoce HTTP |

`utils/` compartido: `errors.js` (ApiError + códigos), `camel.js`
(snake_case ↔ camelCase de la API), `normalizar.js` (DNI/patente/fechas/montos).

### 2.3 Arquitectura de Vistas Raíz Independientes

Antes de Fase 1 el login era un **overlay modal** (`.login-vista`, `z-index`)
pisando la app: había conflicto de renderizado (Login ⚡ App ⚡ Modales
compartían el eje de superposición, toasts y foco quedaban atrapados). Se
desacopló el sistema en **dos planos ortogonales**:

**Plano 1 — Vistas Raíz (mutuamente excluyentes, `.vista-raiz`)**
```
#vista-login            → acceso y registro dual (pestañas Ingresar/Registrarse)
#vista-app              → la aplicación completa (con sus propios modales)
#vista-reset-password   → restablecimiento público desde el ENLACE del email
                          (#reset-password?token=...; ancla de la misma página)
Regla única: exactamente una vista activa con clase `.activa`
   `.vista-raiz { display:none !important }`
   `.vista-raiz.activa { display:flex !important; flex-direction:column }`
Conmutación por TRES funciones (`mostrarLogin()` / `mostrarApp()`,
`mostrarVistaReset(token)` para el enlace) — ninguna toca `hidden` (usa clases).
INVARIANTE PROBADO (QA estática + E2E): display(style) ⇔ clase .activa.
```

**Plano 2 — Modales (`backdrop`)**: SIEMPRE dentro de su vista raíz padre
(`#modal-ot`, `#modal-vehiculo`, `#modal-transfer`, `#modal-cliente`,
`#modal-perfil`, `#modal-scan`, `#modal-tema`, `#modal-eliminar`) + `#toasts`
dentro de `#vista-app`. Un modal jamás cubre una vista raíz distinta de
la suya, y el login ya no es `role="dialog"` con `aria-modal`(§ QA
`qa-vistas-raiz.cjs`, 23 checks).

**Nota de trazabilidad con la especificación original:** `#vista-perfil` no
existe como vista raíz independiente; el **perfil es un modal**
(`#modal-perfil`) anidado en `#vista-app`: así el operador edita su ficha sin
salir del flujo y sin el costo de una cuarta vista raíz. Las vistas raíz
reales son las tres superiores.

---

## 3. Especificación de la Base de Datos (`schema.sql`)

**Motor objetivo y compatibilidad:** un único DDL que corre idéntico en
**SQLite 3.30+** (driver actual: `better-sqlite3`, sincrónico) y
**PostgreSQL 12+**. Portabilidad cuidada a mano:
`VARCHAR/NUMERIC/DATE/TIMESTAMP`, FK estándar, `IF NOT EXISTS` idempotente,
sin funciones propietarias. Las **FK de SQLite se activan por CONEXIÓN** con
`PRAGMA foreign_keys = ON` (está en `db.js`); PostgreSQL la aplica por defecto.

**WAL:** `journal_mode=WAL` + `synchronous=NORMAL` — lecturas concurrentes sin
bloquear la escritura del mostrador.

### 3.1 Diccionario de Datos

#### `clientes` — titulares
| Columna | Tipo | Restricciones | Notas |
|---|---|---|---|
| `id` | VARCHAR(36) | PK | **UUID v4 sintética** generada en la APP antes del INSERT |
| `nombre` | VARCHAR(120) | NOT NULL | |
| `dni` | VARCHAR(20) | NOT NULL, CHECK(`<>''`), **UNIQUE `idx_clientes_dni`** | dato de BÚSQUEDA, no de referencia |
| `telefono` | VARCHAR(30) | — | |
| `email` | VARCHAR(140) | — | |
| `fecha_alta` | DATE | NOT NULL, DEFAULT `CURRENT_DATE` | |

#### `vehiculos` — la ficha viva
| Columna | Tipo | Restricciones | Notas |
|---|---|---|---|
| `id` | VARCHAR(36) | PK | UUID sintética |
| `patente` | VARCHAR(12) | NOT NULL, **UNIQUE `idx_vehiculos_patente`** | normalizada `AB123CD` (mayúsc, sin signos) |
| `marca` / `modelo` | VARCHAR(60)/(80) | NOT NULL DEFAULT `'Sin marca'`/`'Sin modelo'` | alta desde escáner sin leer bien el resto |
| `anio` | INTEGER | CHECK NULL ó 1900–2100 | |
| `km` | INTEGER | CHECK NULL ó ≥0 | **odómetro monotónico**: el API sólo actualiza si km nuevo > guardado |
| `color`, `motor` | VARCHAR(40) | — | |
| `cliente_id` | VARCHAR(36) | FK → clientes **ON DELETE SET NULL** | **"Propietario desconocido"**: vehículo activo sin titular (baja de cliente NO borra historial) |
| `estado` | VARCHAR(10) | CHECK `('activo','historico')` | pasa a histórico por transferencia/desafiliación, no por borrado |
| `fecha_alta` | DATE | NOT NULL DEFAULT `CURRENT_DATE` | |

#### `historial_duenos` — boletín de transferencias (snapshot inmutable)
| Columna | Tipo | Restricciones | Notas |
|---|---|---|---|
| `id` | VARCHAR(36) | PK | |
| `vehiculo_id` | VARCHAR(36) | NOT NULL, FK → vehiculos **ON DELETE CASCADE** | |
| `cliente_id` | VARCHAR(36) | FK → clientes **ON DELETE SET NULL** | si el cliente se borra, el snapshot sobrevive |
| `nombre_snapshot` | VARCHAR(120) | NOT NULL | identidad congelada al transferir |
| `dni_snapshot` | VARCHAR(20) | NOT NULL | dato forense a prueba de borrados |
| `fecha_desde` / `fecha_hasta` | DATE | — | período de titularidad |

#### `ordenes_trabajo` — cabeceras del ingreso al taller
`id` PK · `vehiculo_id` FK → vehiculos **ON DELETE CASCADE** · `fecha` DATE
default hoy · `km` (≥0) · `mano_obra` NUMERIC(12,2) (≥0) · `observaciones` TEXT.

#### `tareas_orden` — detalle de tareas (1→N)
`id` PK · `orden_id` FK → ordenes **ON DELETE CASCADE** · `descripcion`
VARCHAR(160) NOT NULL CHECK(`<>''`).

#### `repuestos_orden` — detalle de repuestos (1→N)
`id` PK · `orden_id` FK → ordenes **ON DELETE CASCADE** · `nombre`
VARCHAR(140) NOT NULL · `cantidad` INTEGER ≥1 default 1 · `precio_unitario`
NUMERIC(12,2) ≥0 default 0.

#### `usuarios` — acceso del taller (Fase 1+2+3+4)
| Columna | Tipo | Restricciones | Notas |
|---|---|---|---|
| `id` | VARCHAR(36) | PK | el JWT lleva `sub = id` |
| `telefono` | VARCHAR(30) | **UNIQUE `idx_usuarios_telefono`**, CHECK (`telefono IS NOT NULL OR email IS NOT NULL`) | clave del canal OTP; formato API `549XXXXXXXXXX` *(13 dígitos: `+54 9` + código de área 2 + número 8, sin el 0 ni el 15)* |
| `email` | VARCHAR(140) | **UNIQUE `idx_usuarios_email`** | UNIQUE admite varios NULL |
| `password_hash` | VARCHAR(255) | — | **scrypt** nativo: salt 16B aleatoria + dk 64B, formato `scrypt$<salt>$<dk>`; JAMÁS texto claro |
| `nombre` / `apellido` | VARCHAR(80) | (Fase 4) identidad personal: **obligatorios** en el registro, editables en perfil | |
| `nombre_taller` | VARCHAR(120) | — | nombre comercial en la pill/banner |
| `rol` | VARCHAR(20) | DEFAULT `'admin'` | único rol vigente |
| `otp_conteo_mes` / `otp_ultimo_reset` | INTEGER / DATE | — | **cuota 2 OTP/mes calendario** (control de costos); reinicio en el primer envío de un mes nuevo |
| `intentos_fallidos` | INTEGER | DEFAULT 0 | **bloqueo a los 3 errores** (→ `forceReset`) |
| `created_at` | TIMESTAMP | DEFAULT `CURRENT_TIMESTAMP` | |

Tabla de seguridad **autónoma**: SIN FK hacia el negocio (el JWT la alcanza).
Sin teléfono → cuenta pura email; sin email → OTP-only/banner invita a
vincularlo para poder recuperar la cuenta al agotar los OTP.

### 3.2 Estrategia de Índices (B-Tree)

| Índice | Tabla.col | Tipo | Propósito |
|---|---|---|---|
| `idx_clientes_dni` | clientes.dni | «UNIQUE» | búsqueda por DNI (búsqueda dual del buscador) |
| `idx_vehiculos_patente` | vehiculos.patente | «UNIQUE» | búsqueda por chapa — hot path del **escáner ALPR** |
| `idx_vehiculos_cliente_id` | vehiculos.cliente_id | índice | fichas por titular + soporte FK SET NULL |
| `idx_historial_duenos_vehiculo` | historial_duenos.vehiculo_id | índice | dueños del vehículo (FK CASCADE) |
| `idx_historial_duenos_cliente` | historial_duenos.cliente_id | índice | "autos que tuvo a su nombre" |
| `idx_ordenes_vehiculo` | ordenes_trabajo.vehiculo_id | índice | historial cronológico por vehículo |
| `idx_tareas_orden` | tareas_orden.orden_id | índice | detalle por orden |
| `idx_repuestos_orden` | repuestos_orden.orden_id | índice | detalle por orden |
| `idx_usuarios_telefono` | usuarios.telefono | «UNIQUE» | clave del canal OTP (carrera check-insert 409) |
| `idx_usuarios_email` | usuarios.email | «UNIQUE» | unicidad de acceso email (carrera check-insert 409) |

DNI/patente como **UNIQUE INDEX** combina unicidad + índice de búsqueda en un
solo B-Tree (evita índices redundantes). Los `id` sintéticos (PK) no requieren
índices adicionales para referencias.

**Semántica de borrado (resumen operativo):**

| Se borra | Efecto |
|---|---|
| **CLIENTE** | nada se borra — vehículos quedan `cliente_id = NULL` ("Propietario desconocido"), historial conserva los snapshots |
| **VEHÍCULO** | se borra TODO su rastro en cascada: historial + órdenes + tareas + repuestos (la "historia clínica" completa) |
| **ORDEN** | cae con sus tareas y repuestos (CASCADE) |

---

## 4. Especificación de la API REST (`/api/v1`)

**Convención de errores** (manejo central en `server.js`):
```json
{ "error": { "codigo": "PETICION_VALIDACION|NO_AUTORIZADO|RECURSO_NO_ENCONTRADO|
             CONFLICTO_DATOS|LIMITE_SOLICITUDES|UNICIDAD|FK_INVALIDA|
             CHEQUEO_DATOS|JSON_INVALIDO|ERROR_INTERNO",
             "mensaje": "texto amigable para el operador",
             "detalles": { ... } (opcional) } }
```
Todos los nombres en **camelCase** en respuesta vía `utils/camel.js`
(mapeo: snake_case en BD ↔ camelCase en la API).

### 4.1 Autenticación y Seguridad

**Flujo JWT**
- `jsonwebtoken` con **HS256 fijado**: sólo se acepta el token firmado con el
  algoritmo declarado — un payload reescrito sin resignar → 401 (QA fase1).
- Payload: `{ sub: id, telefono, rol }` · exp + iat **30 días** (`JWT_DIAS`).
- Verificación en el middleware **`proteger`** (`routes/auth.js`,
  reexportado en `module.exports` — lo consumen `server.js` y rutas):
  `Authorization: Bearer <token>` → 401 `{NO_AUTORIZADO}` si falta / venció /
  firma inválida / payload manipulado.
- **Las rutas de negocio montan `proteger`**: clientes y vehiculos directo;
  en `server.js` un comodín de path (`/ordenes|/vehiculos…`) protege el router
  de órdenes sin robar las 404 públicas (QA: `/auth/inventado → 404`, no 401).
- En **producción sin `JWT_SECRET` el server no arranca** (fail-closed);
  desarrollo usa un secreto de desarrollo con AVISO en consola.

**Teléfonos Argentina (+54 9)**
- **Front** (regla estricta): widget de prefijo fijo **+54 9** (no editable),
  input de exactamente **10 dígitos**, leyenda *"código de área, sin el 0 y
  sin el 15 (ej: 1123456789)"*, rechazo de dígitos repetidos
  (`/^(\d)\1{9}$/`) y normalización a **`549` + 10** antes de llamar a la API.
- **Backend** (defensivo, tolerante): `normalizarTelefono` (sólo dígitos y
  `+`) + `telefonoValido` (**8..15 dígitos**). Guarda el formato que llega
  (el registro por front envía `549…`).

**Política de contraseñas**
- Mínimo **6 caracteres** (`PASSWORD_MIN = 6`) en backend y front
  (`PASSWORD_MIN_FRONT`).
- scrypt: salt 16B + dk 64B con `crypto.scrypt` (N por defecto del Node);
  verificación en tiempo constante (`crypto.timingSafeEqual`).
- Fase 3: confirmación en registro + restablecimiento por
  **enlace de email** (token de 24B hex, 1 uso, 15 min) o por
  **OTP de WhatsApp** (con el mismo anti-spam).

**Sanitización / normalización compartida** (`utils/normalizar.js`)
- `normDni` → sólo dígitos · `normPatente` → mayúsculas + alfanumérico.
- `fechaISOoNada` (400 si mal formada) · `enteroOoNada` · `monto0` (≥0, cents).

### 4.2 Catálogo de Endpoints

Leyenda de códigos: **200** ok · **201** creado · **204** sin cuerpo ·
**400** validación · **401** no autorizado · **403** bloqueo · **404** no
existe · **409** conflicto (duplicado / claves UNIQUE / FK) · **429** límite
· **500** interno sin filtrar stack.

#### `GET /api/v1/health` — público (sin auth)
| Códigos | Descripción |
|---|---|
| 200 | `{ok, driver, db (solo dev), consultable}` — en producción NO filtra la ruta de la BD |

#### `/auth/*` — sesión y credenciales (público salvo /profile)
| Método | Ruta | Auth | Body · Parámetros | Respuestas | Descripción funcional |
|---|---|---|---|---|---|
| POST | `/auth/request-otp` | — | `{ telefono }` (8–15 dígitos) | 200 · 400 · 429 | Envía OTP de 6 dígitos por WhatsApp **mock** (consola + `dev.otp` en dev). Anti-spam 30 s (REENVIO_MS), cuota **2/mes** · 429 con mensaje según tenga email vinculado ("Utiliza la recuperación por email") o no (soporte). |
| POST | `/auth/verify-otp` | — | `{ telefono, otp, password?, nombreTaller?, nombre?, apellido? }` | 200 · 400 · 409 | One-shot (5 intentos, quema el código). UPSERT por teléfono: crea cuenta nueva o consolida datos (Fase 4: nombre/apellido via `COALESCE`). Devuelve `{token, usuario}`. |
| POST | `/auth/register` | — | `{ metodo:'email', email, password, nombre*, apellido*, nombreTaller? }` → **alta inmediata** | **201** + token · 400 · 409 duplicado | Registro dual rama email. nombre/apellido **obligatorios** (≤80). 409 con mensaje amigable de duplicado (`CONFLICTO_DATOS`). |
| POST | `/auth/register` | — | `{ metodo:'telefono', telefono, password, nombre*, apellido*, nombreTaller? }` → **prueba de propiedad OTP** | **200** `{necesitaVerificacion, dev.otp}` · 400 · 409 duplicado | Envia OTP y el front cierra el registro con `verify-otp` (mando password + identidad). |
| POST | `/auth/login` | — | `{ email, password }` | 200 · 400 · **401** · **403 `{forceReset}`** | Email + contraseña. 401 inexistente: `"Usuario no registrado o contraseña incorrecta."`; contraseña errada: contador `"Intentos restantes: n"`. Al 3er fallo: 403 fuerza el reset (se abre automáticamente en el front). |
| GET | `/auth/profile` | proteger | — | 200 · 401 | ficha pública: identidad personal (nombre/apellido), email, teléfono, cuota OTP, createdAt. |
| PUT | `/auth/profile` | proteger | `{ nombre?, apellido?, email?, telefono?, nombreTaller? }` | 200 · 400 · 409 | Edita (uno o varios campos; vacío no borra por accidente). **Cambio de teléfono → re-firma el token** (el JWT lo lleva en payload). 409 en email/tel ya usados. |
| POST | `/auth/olvide-password` | — | `{ email }` | 200 (siempre) · 400 | Token de 24B hex 15 min via restablecer por email (mock→consola+`dev.token`). **No enumera** cuentas (responde igual si no existe). |
| POST | `/auth/reset-password` | — | `{ via:'otp', telefono, otp, password }` | 200 · 400 | Reset por OTP (respeta anti-spam/cuota) — limpia `intentos_fallidos`. |
| | | | `{ via:'token', token, password }` | 200 · 400 | Reset por token 15 min one-shot — limpia `intentos_fallidos`. |
| POST | `/auth/request-password-reset-email` | **proteger** | — | 200 · 400 · 401 | Fase 3: genera ENLACE de cambio (mock→consola+`dev.enlace`; llama al front `#reset-password?token=…`). 400 si la cuenta no tiene email vinculado (sugiere perfil). |
| POST | `/auth/confirm-password-reset` | — | `{ token, newPassword }` | 200 · 400 | Consume el enlace one-shot (mismo motor que el reset por token). |

#### `/clientes/*` (protected: `auth.proteger`)
| Método | Ruta | Body · Parámetros | Respuestas | Descripción funcional |
|---|---|---|---|---|
| GET | `/clientes` | query `dni?` | 200 | Lista (`vehiculosActivos` subconsulta, sin N+1) o filtra por DNI exacto. |
| GET | `/clientes/:id` | — | 200 · 404 | Ficha (con subconsultas agregadas). |
| POST | `/clientes` | `{ nombre, dni, telefono?, email? }` | **201** · 400 · 409 DNI | Alta (+ `Location` header). DNI único. |
| PUT | `/clientes/:id` | `{ nombre?, telefono?, email? }` | 200 · 400 · 404 | Edita parcial (sin tocar DNI). |
| DELETE | `/clientes/:id` | — | 200 `{mensaje, vehiculosSinTitular}` · 404 | baja amarilla: FK SET NULL — cuenta cuántos vehículos quedaron sin titular. |

#### `/vehiculos/*` (protected)
| Método | Ruta | Body · Parámetros | Respuestas | Descripción funcional |
|---|---|---|---|---|
| GET | `/vehiculos` | query `patente?` `sin_titular?` `clienteId?` `estado?` | 200 · 400 estado | Búsqueda por patente (normalizada) / lista vehículos sin titular (soporte del escáner ALPR) / estado `activo|historico`. |
| GET | `/vehiculos/:id` | — | 200 · 404 | Ficha compuesta: titular + historialDuenos + `cantidad_servicios`. |
| POST | `/vehiculos` | `{ patente, marca?, …, modo: 'clienteId' \| 'nuevoCliente' \| 'sinTitular' }` | **201** · 400 · 409 patente | Alta en 3 modos: cliente existente / alta-inline **reutilizando** cliente si DNI existe / "Propietario desconocido". |
| PUT | `/vehiculos/:id` | `{ marca?, modelo?, anio?, color?, km?, motor? }` | 200 · 400 · 404 | Edita parcial (km validado ≥0; el odómetro monotónico lo gobiernan las ORDENES). |
| POST | `/vehiculos/:id/transferir` | `{ destino: 'nuevoClienteId' \| 'nuevoCliente' \| 'sinTitular' }` | 200 · 400 · 404 | Transferencia: cierra el período del dueño saliente en `historial_duenos` (snapshot), abre el nuevo; puede quedar sin titular. `estado='historico'` al quedar sin dueño. |
| DELETE | `/vehiculos/:id` | — | 200 `{mensaje, filas}` · 404 | **Cascada completa**: historial + órdenes + tareas + repuestos. |

#### `/ordenes/*` (protected — comodín path sobre el router raíz)
| Método | Ruta | Body · Parámetros | Respuestas | Descripción funcional |
|---|---|---|---|---|
| GET | `/vehiculos/:vehiculoId/ordenes` | — | 200 · 404 | Historial cronológico del vehículo con desglose O(n) de tareas + repuestos (3 consultas planas, sin N+1 ni roundtrips extra). |
| POST | `/ordenes` | `{ vehiculoId, fecha?, km?, manoObra?, observaciones?, tareas: [{descripcion}], repuestos: [{nombre, cantidad, precioUnitario}] }` | **201** (+ `Location`) · 400 · 404 | **Transaccional** (`db.tx`): cabecera + N tareas + N repuestos en un solo bloque atómico; actualiza el odómetro monotónico del vehículo. |
| PUT | `/ordenes/:id` | `{ fecha?, km?, manoObra?, observaciones?, tareas?, repuestos? }` | 200 · 400 · 404 | Reemplaza el desglose (reemplazo transaccional de detalle). |
| DELETE | `/ordenes/:id` | — | **204** · 404 | Baja de orden (tareas+repuestos van con ella por CASCADE). |

*(Los 401 de todo el portafolio de negocio responden `NO_AUTORIZADO`; los 500
nunca exponen stack — QA fase1 cubre los flujos token/OTP y algunos 400/401/404).*

---

## 5. Frontend, Módulos y Flujos de UX

### 5.1 Mapeo de archivos

| Archivo | Tamaño | Responsabilidad |
|---|---|---|
| `index.html` | ~750 líneas | Estructura declarativa: 3 vistas raíz + 8 modales + `#toasts`; carga `app.js` al FINAL del body (sin defer/async — el IIFE controla arranque) |
| `app.js` | ~3.000 líneas | Toda la lógica en UNA IIFE (cero variables globales): API, estado, render, escáner ALPR, auth dual, perfil, restauración de contraseña, tema |
| `styles.css` | ~1.250 líneas | Mobile-first, variables de tema (`--brand`…), vistas raíz (`.vista-raiz`), bottom sheets, ALPR HUD |

### 5.2 Estado global y persistencia

| Clave localStorage | Contenido | Ciclo |
|---|---|---|
| `taller_token` | **JWT** de sesión (30 días) | se emite en cada login/verify/register; se reemplaza si `PUT /profile` cambia el teléfono (re-firma) |
| `taller_usuario` | snapshot del usuario público (nombre/apellido/taller/email) | refresca con `GET /profile` / cada sesión; alimenta pill y banner |
| `taller_tema` | `claro \| oscuro \| auto` | persiste; un mini-script del `<head>` lo aplica antes del primer render (no parpadeo) |

**El front no persiste datos de negocio.** Estado vivo en memoria:
`DATOS = { clientes, vehiculos }` (listas adaptadas) + estado de UI
(selección, búsqueda dual, marcadores). Cada **mutación re-trae lo que
impacta** (sin fetch innecesarios: alta → re-render local).
`apiFetch()` de base: chip/indicador de peticiones en vuelo (contador),
**anti doble-submit** (`conEnvio` bloquea el botón), toasts de error
global + contenedores de error en línea por formulario (`pw-hint`, estado).
Sesión: en 401 de rutas protegidas → cortar sesión + volver a login
(sin bucle: el login auth/* no responde 401 al propio flujo).

### 5.3 Escáner de cámara y OCR ALPR (100 % cliente)

```
(rotación/pausa del usuario) Visor <video> (getUserMedia, cámara trasera)
        │ captura frame a canvas → recorte ROI (aspect ratio 1.35–9.0)
        ▼
┌─────────────────────────┐      ┌────────────────────────────────┐
│ DETECTOR  YOLOv9-t 640  │      │ Entrada: [1,3,640,640] float32 │
│ fast-alpr  (yolo-v9-t…) │ ───▶ │ Salida:  [1,5,8400] boxes+conf │
└─────────────────────────┘      └────────────────────────────────┘
        │ boxes ≥ 0.35 de confianza
        ▼
┌─────────────────────────┐      ┌────────────────────────────────┐
│ LECTOR  arg_cnn_ocr     │      │ Entrada: [1,70,140,1] UINT8    │
│ fast-plate-ocr (Arg)    │ ───▶ │ Salida:  [1,259] ⇒ 7 slots     │
└─────────────────────────┘      └────────────────────────────────┘
        │ texto: "AB123CD" (Mercosur) / antiguo arg
        ▼
   Validación de formato local → normaliza → búsqueda dual automática
        ▼
   GET /vehiculos?patente=… → ficha abierta (o sugerencia de alta)
```

Detalles de ingeniería que hacen viable el pilar "rendimiento en cliente":
- **`onnxruntime-web@1.20.1`** vía CDN (3 urls de respaldo) — se baja UNA
  vez por sesión (cola de callbacks); las **sesiones neuronales se compilan
  UNA vez** (WebGL EP con respaldo **Wasm**) y persisten entre capturas.
- Pesos (≈15 MB) en **`models/`** servidos por HTTP local — los pesos
  forman parte del bundle local. `models/README.txt` documenta shapes y
  licencias (MIT/Apache-2.0).
- Resiliencia: sin cámara/modelos/CDN → banner de la caja de escaneo con
  lectura manual de patente disponible (`cargarOrtScript()` prueba 3 CDNs
  con timeout de 30 s por intento, luego cae a lectura manual).
- 2do intento: recorta banda superior del ROI (`corteBanda = 0.18`) — mejora
  lecturas donde el techo del auto invade el ROI.

> **⚠ Nota de offline-first real (producción).** Hoy el MOTOR
> `onnxruntime-web@1.20.1` se descarga del CDN en la primera sesión: los
> pesos son locales, pero si el taller no tiene conexión en esa primera
> carga, el runtime no compila y el escáner queda en lectura manual (el
> código lo avisa explícitamente). En producción hay que **vendorizar el
> runtime** en el deploy: alojar `ort.all.min.js` + los binarios `.wasm`
> locales (p. ej. `vendor/onnx/`) junto a los pesos `.onnx` y configurar
> `ort.env.wasm.wasmPaths = '/vendor/onnx/'` en el arranque del motor.
> Con eso, escáner + pesos quedan 100 % locales y el CDN deja de ser una
> dependencia operativa. *(Se referencia también desde el pilar 4, § 1.)*

### 5.4 Flujo de autenticación dual (UX del operador)

```
 Pestaña INGRESAR                     Pestaña REGISTRARSE
 ├── Email + contraseña  ──────▶  POST /auth/login
 │   401 → "Usuario no registrado o contraseña incorrecta."
 │          ¿ No tenés cuenta ? → invitación explícita a Registrarse
 │   401 contador → mensaje de intentos restantes; 403 forceReset → auto-reset por email
 ├── WhatsApp (OTP) Δ 2 pasos     POST /auth/request-otp → paso 2
 │   verify-otp  (cuenta nueva o existente: upsert)
 └── Registro:
      · nombre/apellido OBLIGATORIOS (gating del botón con hints en vivo)
      · contacto: email O celular AR (+54 9 · 10 dígitos · sin repetir)
      · claves ≥6 e iguales → 409 amigable EN el campo (hint+banner)
      · rama tel: paso 2 con OTP (paso 2 del panel Ingresar)

 RESTABLECER (público)  #vista-reset-password (enlace desde email)
 ├── por OTP al WhatsApp (cuota/anti-spam)  → POST /auth/reset-password via otp
 └── por token 15 min one-shot (enlace)     → POST /auth/confirm-password-reset
```

### 5.5 Matriz de límites de seguridad (operador/attacker)

| Límite | Valor | Dónde | Efecto al superar |
|---|---|---|---|
| Intentos fallidos de login | **3** | `intentos_fallidos` (BD) | 403 `{forceReset: true}` + conmutación automática a restablecer |
| OTP por usuario/mes | **2** | `otp_conteo_mes/otp_ultimo_reset` (BD) | 429 — con email → "Utiliza la recuperación por email"; sin email → soporte |
| Vida del OTP | **5 min** | en memoria (`otps` Map) | expira; solicitar nuevo |
| Intentos del OTP | **5** | en memoria | código quemado; pedir otro |
| Reenvío de OTP | **30 s** | en memoria | 429 `LIMITE_SOLICITUDES` |
| Token de enlace (email) | **15 min · 1 uso** | `resetsEmail` Map | 400; pedir otro |
| Vida del JWT | **30 días (HS256)** | firma | re-login (401 → corta sesión) |
| Tamaño de body JSON | 200 KB | `express.json` | 400/413 |
| Password mínimo | **6 caracteres** | front + backend | 400 |

*(Los stores de OTP y de reset están EN MEMORIA — costo deliberado para el
desarrollo; la persistencia a tabla/Redis figura en el roadmap § 7.)*

---

## 6. Entorno de Desarrollo, Ejecución y Seguridad

### 6.1 Arranque local

| Vía | Comando | Qué hace |
|---|---|---|
| **Windows 1-click** | `arranque-rapido.cmd` | crea `.env` desde `.env.example` si falta → `npm install` (1ª vez) → aplica schema (`npm run setup`) → `npm start` (usa Node portable v22.23.3 si existe en `tools\`) |
| npm | `npm run arranque` | `npm run setup && npm start` |
| manual | `npm run setup` → `npm start` | `scripts/setup-db.js` (aplica schema idempotente y verifica las tablas del esquema) → `server.js` |

QA (baterías, server QA en `:3000`, DB dedicada):
```powershell
$env:PORT='3000'; $env:DB_PATH='./data/qa-fase4b.sqlite';
$env:NODE_ENV='development'; $env:AUTH_OTP_REENVIO_MS='300';
node server.js
$env:QA_PORT='3000'; node scripts/qa-auth-fase4.cjs   # etc.
```
Front estático: servir el repo por cualquier servidor estático (ej. :8800) —
`API_BASE` mapea `localhost → http://localhost:3000/api/v1` (desarrollo) o
`/api/v1` en el mismo origen (producción: detrás del mismo dominio/proxy).

**Respaldo de la BD con el servidor en caliente (producción):** con SQLite
abierto en modo WAL, NO se copia el archivo `taller.sqlite` plano (la copia
no captura el `-wal` y puede salir corrupta). El mecanismo correcto es un
snapshot consistente dentro del propio motor: `VACUUM INTO
'data/backup-YYYY-MM-DD.sqlite'` (SQL, SQLite 3.27+) o la API de backup
en línea del driver — `better-sqlite3` v11 lo expone como
`db.backup(destination)` (asíncrono, no bloqueante, usa el mecanismo de
backup de SQLite atravesando el WAL) — programado en un cron/Task
Scheduler fuera del proceso Express.

### 6.2 Variables de entorno (`.env.example`)

| Variable | Default | Impacto |
|---|---|---|
| `PORT` | 3000 | puerto HTTP de la API |
| `NODE_ENV` | development | producción: exige `JWT_SECRET`, CORS cerrado, no expone `db` en `/health`, no devuelve `dev.otp` / `dev.token` / `dev.enlace` |
| `CORS_ORIGIN` | `*` (dev) | producción: **lista obligatoria** de orígenes (el server NO arranca con `*` — fail-closed) |
| `JWT_SECRET` | (dev: clave demostrativa + aviso) | firma HS256. Sin él, producción no arranca |
| `DB_DRIVER` | sqlite | hoy sólo `sqlite`; adapter pg documentado en `db.js` |
| `DB_PATH` | `./data/taller.sqlite` | archivo SQLite (se crea con su directorio) |
| `PG*` | — | placeholders para migrar a PostgreSQL |
| `AUTH_OTP_REENVIO_MS` | 30000 | anti-spam de reenvío (QA usa 300) |

### 6.3 Medidas de seguridad implementadas

| Vector | Mitigación |
|---|---|
| **XSS** | `esc()` escapa todo interpolado al DOM; `innerHTML` preferido con datos escapados; atributos construidos con textos seguros (QA estática) |
| **SQLi** | 100 % **consultas parametrizadas** (`?` placeholders por driver); cero concatenación de strings en DML |
| **Cabeceras HTTP** | `helmet()` (CSP, nosniff, X-Frame-Options, HSTS…) + `app.disable('x-powered-by')` |
| **CORS** | reflexivo en dev; producción con lista explícita (fail-closed) |
| **Fuerza bruta login** | contador `intentos_fallidos` — 3 errores → bloqueo + reset obligatorio |
| **Costos SMS/abuso OTP** | cuota 2/mes + anti-spam 30 s + vida 5 min + 5 intentos del código |
| **Enumeración de cuentas** | `/olvide-password` responde igual (200) exista o no; /login ya distingue inexistente (decisión de UX de la Fase 4b) |
| **Secretos** | `.env` fuera del repo (`.gitignore`: `.env`, `.env.*`, `*.env`); `data/` y `*.sqlite*` también ignorados — la DB no se comitea jamás |
| **Errores 500** | no filtran stack al cliente (solo log del server); `SQLITE_*` traducidos a 400/409 específicos |
| **Contraseñas** | scrypt + salt aleatorio por usuario; verificación en tiempo constante |
| **JSON** | límite 200KB; 400 `JSON_INVALIDO` ante cuerpo roto |

---

## 7. Estado Actual y Hoja de Ruta pre-Deploy

### 7.1 Épicas completadas ☑

- [x] **Fase 0 — Núcleo del negocio**: schema portable (6 tablas de negocio + usuarios, 10 índices), CRUD clientes/vehículos, 3 modos de alta ("Propietario desconocido"), transferencias con snapshot inmutable del historial, órdenes de trabajo transaccionales (tareas+repuestos), odómetro monotónico, borrados semánticos correctos (SET NULL vs CASCADE).
- [x] **Fase 1 — Sesión por OTP (WhatsApp mock)**: request/verify OTP, JWT 30d, middleware `proteger`, anti-spam, cuota mensual 2/mes, bloqueo a 3 intentos.
- [x] **Fase 2 — Login dual**: email+contraseña (scrypt), registro dual (email inmediato / teléfono con OTP), perfil GET/PUT, banner de email faltante, 404 públicas no protegidas.
- [x] **Arquitectura de vistas raíz** (desacople Login/App/Reset): se eliminó el overlay, toasts y focos liberados, invariante `.activa` cubierto por QA y E2E.
- [x] **Fase 3 — Confirmación + cambio por enlace**: confirmación de contraseña en el registro, ojo de visibilidad, restablecimiento por token email (one-shot 15 min) y por OTP de WhatsApp desde el perfil.
- [x] **Fase 4 — Identidad personal + teléfono AR**: nombre/apellido obligatorios al registrarse y editables en el perfil; teléfono argentino con prefijo fijo +54 9, 10 dígitos exactos, sin repetidos y normalización `549…`; QA completo y E2E browser.
- [x] **Fase 4b — Duplicados amigables**: 409 con mensaje único en registro (email/tel) + captura de violación UNIQUE (sin 500); login con mensaje de usuario inexistente.
- [x] **QA automatizado**: 5 baterías API (35 + 42 + 18 + 27 + 17 checks) + 23 checks estáticos + E2E browser — **162 verificaciones verdes**.
- [x] **Seguridad base**: helmet, CORS fail-closed, parametrización SQL, XSS escape, gitignore a `.env`/`data`.

### 7.2 Integración pendiente ⚠

- [ ] **Proveedor oficial de API de WhatsApp** — hoy `WHATSAPP-MOCK` (consola del server + `dev.otp`). Integración pre-producción **crítica**: reemplazar el emisor por Cloud API / BSP (production token, webhook de entrega), mantener la cuota y el anti-spam; revisar costos y límites de cuota.
- [ ] **SMTP real** — `/auth/olvide-password` y el enlace de cambio (`request-password-reset-email`) usan `EMAIL-MOCK` (consola). Conectar nodemailer + dominio/remite SPF/DKIM.
- [ ] **PWA instalable** — service worker + `manifest.json` + cache de assets/`models/`: el diseño ya es ligero y el offline de los modelos local existe; falta la capa de instalación y el cacheo del shell.
- [ ] **Persistencia de stores efímeros** — OTPs y tokens de reset viven en `Map` de RAM (se pierden al reiniciar — tolerable en dev). Migrar a tabla `otp_codigos` / Redis con TTL.
- [ ] **PostgreSQL activo** — schema ya compatible; falta activar el adapter `pg` de `db.js` (placeholder `?` → `$n`, `tx` con client dedicado).
- [ ] **Rate limit global** por IP (complemento del anti-spam de OTPs, p.ej. `express-rate-limit`) + registro de auditoría de autenticación.
- [ ] **Tests de carga / WAL en volumen** — SQLite rinde cómodo hasta decenas de miles de filas; planear el punto de migración a PostgreSQL.

### 7.3 Estrategia de Hosting objetivo

```
        BUILD (tal cual, sin bundler: ~1.5 MB de app + 15 MB de modelos)
   ┌─────────────────────┐        ┌───────────────────────────────────┐
   │ index.html          │        │ CDN estático (Netlify/Vercel o el │
   │ app.js · styles.css │◄─HTTPS─┤ nginx del propio VPS) · TLS       │
   │ models/*.onnx 15 MB │        │ (Let's Encrypt)                   │
   └─────────────────────┘        └──────────┬────────────────────┘
                                             │ reverse proxy (nginx/Caddy)
                                  ┌──────────▼───────────────┐
                                  │ Backend API (Express)    │
                                  │ Node 18/22 · systemd/PM2 │  VPS (Docker opcional)
                                  │ helmet CORS_ORIGIN exact │  .env con JWT_SECRET
                                  │ express-rate-limit       │
                                  └──────────┬───────────────┘
                                             │ DB_DRIVER
                                  ┌──────────▼───────────────┐
                                  │ DB gestionada            │
                                  │ PostgreSQL 12+ (fase 2)  │  backups pg_dump diario
                                  │ ó SQLite WAL + snapshot  │  (fase 1 VPS)
                                  └──────────────────────────┘
```
- **Fase de despliegue 1 (VPS único):** front estático servido por nginx/Caddy
  (mismo origen → `API_BASE='/api/v1'`, cero CORS), API Node bajo PM2/systemd,
  DB SQLite WAL con snapshot diario montado en volumen persistente — el
  respaldo se ejecuta en caliente con `VACUUM INTO 'data/backup-…sqlite'`
  o `db.backup()` del driver (§ 6.1), JAMÁS copiando el `.sqlite` plano
  con la WAL abierta (riesgo de corrupción). HTTPS + `CORS_ORIGIN` del
  dominio.
- **Fase de despliegue 2 (gestionada):** DB → PostgreSQL gestionado (RDS/
  Supabase/Neon) activando el adapter pg; API sigue serverless-friendly
  (las rutas Express son balanceables; sea VPS o Function-per-endpoint).
- **Siempre:** JWT_SECRET propio por instalación, `NODE_ENV=production`,
  integraciones de WhatsApp/SMTP concretadas, y monitoreo del log `[api]`.

### 7.4 Regla de oro del repositorio

`DOCUMENTACION_TECNICA.md` y `scripts/qa-*.cjs` son la fuente de verdad del
estado: si `git log` dice Fase N, este documento debe concordar con la versión
(nueva Fase ⇒ actualizar sección 7). **Ningún commit de Fase nueva entra sin
sus baterías verdes y sus E2E.**

---

*Fin del documento. Fuente auditada: `server.js` (~150 líneas), `db.js`,
`schema.sql`, `routes/{auth,clientes,vehiculos,ordenes}.js`, `utils/*`,
`app.js` (~3.000), `index.html`, `styles.css`, `models/*`, `scripts/*`,
`package.json`, `.env.example`, `.gitignore`, `arranque-rapido.cmd`.*
