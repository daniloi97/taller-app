/* ============================================================================
   TALLER MECÁNICO · HISTORIA CLÍNICA VEHICULAR
   app.js — lógica completa de la aplicación (Vanilla JS, ES5, sin frameworks)

   · Persistencia vía API REST (fetch): clientes, vehículos y órdenes
     residen en el servidor (Node.js/Express + SQLite). El front no
     guarda datos — cada consulta y mutación (altas, transferencias,
     órdenes, bajas) viaja por HTTP con apiFetch(). El indicador de
     actividad y el bloqueo anti doble-submit acompañan a cada request.
     En localStorage quedan: el tema elegido (taller_tema), el token de
     sesión (taller_token) y el usuario logueado (taller_usuario).
   · Búsqueda dual automática por patente o DNI en un solo input.
   · Un cliente puede tener VARIOS vehículos activos a la vez; cada tarjeta
     permite crear su propia Orden de Trabajo o ver su ficha. Un vehículo
     pasa a "Histórico" sólo por transferencia o desafiliación, y el dueño
     saliente queda registrado en vehiculo.duenos.
   · Escáner con cámara — ALPR con redes neuronales (ONNX Runtime Web,
     WebGL/Wasm): ROI del visor → detector de chapa YOLOv9-tiny → lector
     de 7 espacios entrenado con patentes argentinas (fast-plate-ocr) →
     validación por formato → búsqueda automática. onnxruntime-web se
     baja del CDN una sola vez; los pesos viven en models/ junto a este
     archivo, así que el escaneo no necesita internet.
     Sin modelos disponibles la app sigue funcionando: queda la lectura manual.
   · Tema claro / oscuro / automático: oculto en data-theme y persistido
     en taller_tema. El mini-script del <head> aplica el valor guardado
     antes del primer render para evitar parpadeo; este módulo lo mantiene
     sincronizado (ícono del botón + radios + cambios del sistema).
   · Se carga vía <script src="app.js"></script> al final del <body> y todo
     vive dentro de una IIFE: cero variables globales.
   ============================================================================ */
(function () {
  'use strict';

  /* ==========================================================
     1. Utilidades generales
     ========================================================== */
  var TEMA_KEY = 'taller_tema';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&#38;').replace(/</g, '&#60;').replace(/>/g, '&#62;')
      .replace(/"/g, '&#34;').replace(/'/g, '&#39;');
  }
  function money(n) {
    var v = Number(n) || 0;
    try {
      return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(v);
    } catch (e) { return '$ ' + v.toLocaleString('es-AR'); }
  }
  function num(n) { return (Number(n) || 0).toLocaleString('es-AR'); }
  /* Defensa XSS: fecha() alimenta innerHTML en varias vistas. Si el valor
     de la BD viene malformado (p.ej. DB editada a mano o import externo),
     se escapa en lugar de inyectarse crudo. Las fechas válidas jamás
     entran por acá (requires YYYY-MM-DD y se validan en la API). */
  function fecha(iso) {
    if (!iso) return '—';
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return esc(iso);
    try { return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch (e) { return esc(iso); }
  }
  function hoy() { return new Date().toISOString().slice(0, 10); }
  function norm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function iniciales(nombre) {
    return String(nombre || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }
  function costoServicio(s) {
    var rep = (s.repuestos || []).reduce(function (a, r) {
      return a + (Number(r.cantidad) || 0) * (Number(r.precio) || 0);
    }, 0);
    return rep + (Number(s.manoObra) || 0);
  }
  function costoRepuestos(s) {
    return (s.repuestos || []).reduce(function (a, r) {
      return a + (Number(r.cantidad) || 0) * (Number(r.precio) || 0);
    }, 0);
  }

  /* Detección automática del tipo de búsqueda (patente o DNI) */
  function detectarTipo(raw) {
    var v = norm(raw);
    if (!v) return 'auto';
    if (/^\d{7,8}$/.test(v) || /^\d{11}$/.test(v)) return 'dni';
    if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(v)) return 'patente';   /* Mercosur AB123CD */
    if (/^[A-Z]{3}\d{3}$/.test(v)) return 'patente';           /* Antigua ABC123 */
    if (/^[A-Z]\d{3}[A-Z]{3}$/.test(v)) return 'patente';      /* Antigua A123BCD */
    if (/^\d{6}$/.test(v) || /^\d{3}$/.test(v)) return 'patente';
    if (/[A-Z]/.test(v) && /\d/.test(v)) return 'patente';
    if (/^\d+$/.test(v)) return 'dni';
    return 'auto';
  }

  /* ==========================================================
     Extracción de PATENTE del texto crudo del OCR.
     El taller escanea chapas, no documentos: deliberadamente se
     ignoran las secuencias de dígitos (DNIs, montos, odómetros)
     para no generar búsquedas sin sentido.
     Formatos aceptados:
       · Mercosur       XX-NNN-XX  (AB 123 CD — el OCR suele separar grupos)
       · Antigua        XXX-NNN    (ABC 123)
       · Antigua larga  X-NNN-XXX  (A 123 BCD)
     Devuelve la patente normalizada o null si no hay lectura
     confiable (nunca devuelve texto basura).
     ========================================================== */
  function extraerPatenteOTexto(texto) {
    var t = String(texto || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    if (!t) return null;

    var patrones = [
      /\b[A-Z]{2}\s*\d{3}\s*[A-Z]{2}\b/,   /* Mercosur: AB 123 CD */
      /\b[A-Z]{3}\s*\d{3}\b/,              /* Antigua corta: ABC 123 */
      /\b[A-Z]\s*\d{3}\s*[A-Z]{3}\b/       /* Antigua larga: A 123 BCD */
    ];

    /* Pasada normal: cada grupo puede venir espaciado */
    for (var i = 0; i < patrones.length; i++) {
      var m = t.match(patrones[i]);
      if (m) return norm(m[0]);
    }

    /* Rescate: OCR que partió los grupos de forma irregular
       ("AB1 23CD"). Se reintentan los patrones sin ningún espacio. */
    var tSin = t.replace(/\s+/g, '');
    if (tSin !== t) {
      for (var j = 0; j < patrones.length; j++) {
        var m2 = tSin.match(patrones[j]);
        if (m2) return m2[0];
      }
    }

    return null;
  }

  /* ==========================================================
     2. Capa de datos: API REST (fetch) + foto en memoria
     La persistencia ya no es local: cada consulta/mutación viaja al
     servidor (Express + SQLite). `DATOS` guarda la última lectura
     (clientes, vehículos, fichas y órdenes) para que los renders y los
     accesores síncronos, con las mismas formas de objeto que antes,
     trabajen sin refetch innecesario. Cada mutación re-trae lo que
     impacta antes de volver a renderizar.
     ========================================================== */
  const API_BASE = window.location.origin.includes('localhost')
    ? 'http://localhost:3000/api/v1'
    : '/api/v1';

  var DATOS = {
    clientes: null,        /* lista adaptada (GET /clientes) */
    vehiculos: null,       /* lista adaptada (GET /vehiculos) */
    fichaCliente: null,    /* ficha compuesta del cliente abierto */
    fichaVehiculo: null,   /* ficha compuesta del vehículo abierto */
    ordenes: []            /* órdenes adaptadas del vehículo abierto */
  };

  /* ---------------------------------------------------------------
     Sesión (Fase 1 de autenticación: teléfono + OTP → JWT de 30 días)
     · localStorage: taller_token (JWT firmado) + taller_usuario.
     · apiFetch adjunta Authorization: Bearer <token> si existe.
     · Un 401 de la API invälida la sesión y regresa al login.
     --------------------------------------------------------------- */
  var TOKEN_KEY = 'taller_token';
  var USUARIO_KEY = 'taller_usuario';

  function tokenSesion() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function usuarioSesion() {
    try { var u = JSON.parse(localStorage.getItem(USUARIO_KEY) || 'null'); return u || null; }
    catch (e) { return null; }
  }

  function guardarSesion(token, usuario) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* private mode */ }
    try { localStorage.setItem(USUARIO_KEY, JSON.stringify(usuario || null)); } catch (e) {}
  }

  function limpiarSesion() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    try { localStorage.removeItem(USUARIO_KEY); } catch (e) {}
  }

  /* ---------------------------------------------------------------
     Helper genérico de la API (requisito 1):
       · cabecera 'Content-Type: application/json' por defecto;
       · si !response.ok extrae el mensaje del JSON de error y lanza
         una excepción (el toast ya le avisó al usuario);
       · si falla la red/servidor, alerta con toast(msg, true).
     Convención: options.body se pasa como OBJETO y se serializa aquí.
     Un Error lanzado lleva .status (0 = sin conexión, N = código HTTP).
     --------------------------------------------------------------- */
  async function apiFetch(endpoint, options) {
    var opts = options || {};
    var init = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store'
    };
    /* Sesión: el JWT de taller_token viaja en TODAS las peticiones */
    var token = tokenSesion();
    if (token) init.headers.Authorization = 'Bearer ' + token;
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    var respuesta;
    try {
      respuesta = await fetch(API_BASE + endpoint, init);
    } catch (e) {
      var msgRed = 'No hay conexión con la API (' + API_BASE + '). ¿Está levantado el servidor?';
      toast(msgRed, true);
      throw Object.assign(new Error(msgRed), { status: 0 });
    }

    if (!respuesta.ok) {
      /* Token vencido/inválido en una ruta protegida: cortar sesión y
         regresar al login (no hay bucle: /auth/* no responde 401). */
      if (respuesta.status === 401) {
        limpiarSesion();
        mostrarSesionUI();
        mostrarLogin('Tu sesión venció o el token no es válido. Ingresá de nuevo.');
        var msg401 = 'Sesión vencida: volvé a ingresar con tu WhatsApp';
        toast(msg401, true);
        throw Object.assign(new Error(msg401), { status: 401 });
      }
      var msg = 'Error HTTP ' + respuesta.status;
      try {
        var cuerpo = await respuesta.json();
        if (cuerpo && cuerpo.error && cuerpo.error.mensaje) msg = cuerpo.error.mensaje;
      } catch (e) { /* cuerpo no-JSON: queda el mensaje genérico */ }
      toast(msg, true);
      throw Object.assign(new Error(msg), { status: respuesta.status });
    }

    if (respuesta.status === 204) return null;
    var texto = await respuesta.text();
    if (!texto) return null;
    try { return JSON.parse(texto); } catch (e) { return texto; }
  }

  /* ---------------------------------------------------------------
     Wrapper con indicador visual: chip flotante que muestra cuántas
     consultas están en vuelo (contador, no booleano: los Promise.all
     de la app disparan varias a la vez).
     --------------------------------------------------------------- */
  var peticionesEnVuelo = 0;
  var chipEstiloInyectado = false;

  function chipOcupado() {
    var chip = document.getElementById('api-busy');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'api-busy';
      chip.hidden = true;
      chip.setAttribute('role', 'status');
      chip.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg> ' +
        '<span>Consultando la base…</span>';
      /* El display NO viaja por cssText: un "display:flex" inline pisa el
         [hidden]{display:none} del hoja del browser (estilo inline gana)
         y el chip quedaba visible para siempre. Lo maneja api() con
         style.display explícito flex/none, que siempre decide. */
      chip.style.cssText =
        'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:9999;' +
        'align-items:center;gap:7px;padding:7px 12px;border-radius:999px;' +
        'font-size:12px;font-weight:600;background:#111827;color:#e5e7eb;' +
        'border:1px solid rgba(148,163,184,.35);box-shadow:0 8px 24px rgba(0,0,0,.35);' +
        'pointer-events:none';
      chip.querySelector('svg').style.cssText = 'animation:api-spin .9s linear infinite;';
      document.body.appendChild(chip);
      chip.style.display = 'none';   /* estado inicial: oculto SIEMPRE */
      if (!chipEstiloInyectado) {
        var st = document.createElement('style');
        st.textContent = '@keyframes api-spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(st);
        chipEstiloInyectado = true;
      }
    }
    return chip;
  }

  async function api(endpoint, options) {
    peticionesEnVuelo++;
    var chip = chipOcupado();
    chip.hidden = false;
    chip.style.display = 'flex';
    try {
      return await apiFetch(endpoint, options);
    } finally {
      /* Oculto ESTRICTO al terminar la promesa: finally corra con éxito,
         error de red o error HTTP — jamás queda el indicador colgado. */
      peticionesEnVuelo--;
      if (peticionesEnVuelo <= 0) {
        peticionesEnVuelo = 0;
        chip.hidden = true;
        chip.style.display = 'none';
      }
    }
  }

  /* ---------------------------------------------------------------
     Bloqueo anti doble-submit: deshabilita el botón pulsado mientras
     corre la promesa y devuelve TRUE si la mutación terminó bien.
     Los errores ya notificaron al usuario; el flujo decide si cierra
     el modal o lo deja abierto para corregir/reintentar.
     --------------------------------------------------------------- */
  async function conEnvio(btn, tarea) {
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    var ok = false;
    try { await tarea(); ok = true; }
    catch (e) { /* apiFetch ya mostró el toast del error */ }
    finally {
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    }
    return ok;
  }

  /* ---------------------------------------------------------------
     Adaptadores: modelo de la API (nombres ya camelCase, fechas
     fechaAlta, historialDuenos con snapshots) → modelo que consume
     la UI (cliente con `desde`, vehículo con `duenos` por periodo y
     titular inline, orden con tareas como textos y `obs`).
     --------------------------------------------------------------- */
  function adapCliente(c) {
    return {
      id: c.id,
      nombre: c.nombre,
      dni: c.dni,
      telefono: c.telefono || '',
      email: c.email || '',
      desde: c.fechaAlta || c.desde || null,
      fechaAlta: c.fechaAlta || null,
      /* agregado por la API (lista/fichas): nº de autos activos a su nombre */
      vehiculosActivos: c.vehiculosActivos != null ? c.vehiculosActivos : null
    };
  }

  function adapVehiculo(v) {
    return {
      id: v.id,
      patente: v.patente,
      marca: v.marca || 'Sin marca',
      modelo: v.modelo || 'Sin modelo',
      anio: v.anio || null,
      color: v.color || '',
      km: v.km || null,
      motor: v.motor || '',
      clienteId: v.clienteId || null,
      estado: v.estado || 'activo',
      fechaAlta: v.fechaAlta || null,
      titular: v.titular ? adapCliente(v.titular) : null,
      /* nombre resuelto por la API para los históricos (dueño ACTUAL,
         no es el cliente de la ficha que estamos viendo) */
      nombreTitularActual: (v.titular && v.titular.nombre) || v.titularActual || null,
      /* historial de dueños con la MISMA forma que usaba la UI local */
      duenos: (v.historialDuenos || []).map(function (h) {
        return { nombre: h.nombreSnapshot, dni: h.dniSnapshot, desde: h.fechaDesde, hasta: h.fechaHasta };
      }),
      cantidadServicios: v.cantidadServicios != null ? v.cantidadServicios : 0
    };
  }

  function adapOrden(o) {
    return {
      id: o.id,
      vehiculoId: o.vehiculoId,
      fecha: o.fecha,
      km: o.km,
      manoObra: Number(o.manoObra) || 0,
      obs: o.observaciones || '',
      tareas: (o.tareas || []).map(function (t) { return t.descripcion; }),
      repuestos: (o.repuestos || []).map(function (r) {
        return { nombre: r.nombre, cantidad: r.cantidad, precio: r.precioUnitario };
      })
    };
  }

  /* ---------------------------------------------------------------
     Lecturas: siempre desde la API (frescas); quedan plasmadas en
     DATOS para los accesores y renders. Fallan con Error·status.
     --------------------------------------------------------------- */
  async function traerClientes() {
    DATOS.clientes = (await api('/clientes')).map(adapCliente);
    return DATOS.clientes;
  }

  async function traerVehiculos() {
    DATOS.vehiculos = (await api('/vehiculos')).map(adapVehiculo);
    return DATOS.vehiculos;
  }

  async function traerFichaCliente(id) {
    var f = await api('/clientes/' + encodeURIComponent(id));
    DATOS.fichaCliente = Object.assign(adapCliente(f), {
      vehiculosActivos: (f.vehiculosActivos || []).map(adapVehiculo),
      vehiculosHistoricos: (f.vehiculosHistoricos || []).map(adapVehiculo)
    });
    return DATOS.fichaCliente;
  }

  async function traerFichaVehiculo(id) {
    var f = await api('/vehiculos/' + encodeURIComponent(id));
    DATOS.fichaVehiculo = adapVehiculo(f);   /* la ficha trae titular + historial */
    return DATOS.fichaVehiculo;
  }

  async function traerOrdenes(vehiculoId) {
    DATOS.ordenes = (await api('/vehiculos/' + encodeURIComponent(vehiculoId) + '/ordenes')).map(adapOrden);
    return DATOS.ordenes;
  }

  /* ==========================================================
     3. Accesores (sobre la última foto de la API) y reglas de negocio
     ========================================================== */
  function clientePorId(id) {
    if (!DATOS.clientes || id == null) return null;
    return DATOS.clientes.filter(function (c) { return c.id === id; })[0] || null;
  }
  function vehiculoPorId(id) {
    if (!DATOS.vehiculos || id == null) return null;
    return DATOS.vehiculos.filter(function (v) { return v.id === id; })[0] || null;
  }
  function vehiculoPorPatente(p) {
    var n = norm(p);
    if (!n || !DATOS.vehiculos) return null;
    return DATOS.vehiculos.filter(function (v) { return norm(v.patente) === n; })[0] || null;
  }

  /* La orden abierta de la ficha (la selección de ediciones sale de acá) */
  function ordenPorId(id) {
    return (DATOS.ordenes || []).filter(function (s) { return s.id === id; })[0] || null;
  }

  function nombrePropietario(v) {
    if (!v) return 'Propietario desconocido';
    if (v.titular && v.titular.nombre) return v.titular.nombre;
    if (v.nombreTitularActual) return v.nombreTitularActual;
    var c = v.clienteId ? clientePorId(v.clienteId) : null;
    return c ? c.nombre : 'Propietario desconocido';
  }
  /* Último dueño conocido (aunque ya no sea el titular actual) */
  function ultimoDuenoRegistrado(v) {
    var c = v.clienteId ? clientePorId(v.clienteId) : null;
    if (c) return c.nombre;
    if (v.duenos && v.duenos.length) return v.duenos[v.duenos.length - 1].nombre;
    return null;
  }

  /* ==========================================================
     4. Estado de la UI
     ========================================================== */
  var estado = {
    tipo: 'auto',          /* auto | patente | dni */
    vista: 'inicio',       /* inicio | cliente | vehiculo */
    clienteId: null,
    vehiculoId: null,
    tab: 'historial',      /* historial | propietario | duenos */
    ctx: {}                /* contexto temporal de modales */
  };

  var TAREAS_SUGERIDAS = [
    'Cambio de aceite y filtro', 'Service programado', 'Alineación y balanceo',
    'Cambio de pastillas de freno', 'Distribución', 'Cambio de embrague',
    'Batería', 'Neumáticos', 'Revisión general', 'Diagnóstico electrónico'
  ];

  /* ==========================================================
     5. Iconos (SVG inline, sin dependencias)
     ========================================================== */
  var ICON = {
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    car: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17h14M6 17v2M18 17v2M4.5 12.5 6 7a1.5 1.5 0 0 1 1.4-1h9.2A1.5 1.5 0 0 1 18 7l1.5 5.5"/><path d="M3 12.5h18v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><circle cx="7.5" cy="15" r="1"/><circle cx="16.5" cy="15" r="1"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
    id: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.5"/><circle cx="8.5" cy="11" r="2.2"/><path d="M5 16.5c.7-1.5 2-2.3 3.5-2.3s2.8.8 3.5 2.3M15 9h4M15 13h4"/></svg>',
    wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4 3 8l4 4"/><path d="M3 8h13a4 4 0 0 1 0 8h-2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    lapiz: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.4-3 8.2-7 9-4-.8-7-4.6-7-9V6z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    temaAuto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3.2a8.8 8.8 0 0 0 0 17.6z" fill="currentColor" stroke="none"/></svg>'
  };

  /* ==========================================================
     6. Render principal
     ========================================================== */
  var RESULTS = $('#results');
  var Q_PH_BASE = 'Ingrese Patente o DNI del cliente...';

  function renderInicio() {
    RESULTS.innerHTML =
      '<section class="card fade-in">' +
        '<div class="empty">' +
          ICON.search +
          '<h3>Buscá un cliente o un vehículo</h3>' +
          '<p>Ingresá una <b>patente</b> o un <b>DNI</b> en el buscador. El tipo de búsqueda se detecta automáticamente.</p>' +
          '<div class="hints">' +
            '<div class="hint"><div class="n">1</div><p>Patente Mercosur: <code>AB123CD</code> · antigua: <code>LKM447</code></p></div>' +
            '<div class="hint"><div class="n">2</div><p>DNI del cliente: <code>30123456</code> (7 u 8 dígitos)</p></div>' +
            '<div class="hint"><div class="n">3</div><p>Escaneá la chapa con la cámara: botón <b>QR/scan</b></p></div>' +
          '</div>' +
          '<div class="row" style="justify-content:center;flex-wrap:wrap;margin-top:16px">' +
            '<button class="btn" data-act="sin-titular">' + ICON.shield + ' Ver vehículos sin titular</button>' +
            '<button class="btn" data-act="chip" data-type="patente">' + ICON.car + ' Todos los vehículos</button>' +
            '<button class="btn" data-act="chip" data-type="dni">' + ICON.user + ' Todos los clientes</button>' +
          '</div>' +
        '</div>' +
      '</section>';
  }

  function renderSinResultados(q) {
    /* nq = consulta normalizada (misma regla que norm()). Todo-dígitos =>
       el alta sugerida es la de CLIENTE con el DNI precargado; cualquier
       otra cosa (patente/fra ge o texto del escáner) abre el alta de
       VEHÍCULO con la patente ya en el campo. */
    var nq = norm(q);
    var esDni = /^\d+$/.test(nq);
    RESULTS.innerHTML =
      '<section class="card fade-in"><div class="empty">' +
        ICON.alert +
        '<h3>Sin resultados para “' + esc(q) + '”</h3>' +
        '<p>No encontramos ningún cliente ni vehículo con ese dato.</p>' +
        '<div class="row" style="justify-content:center;flex-wrap:wrap;margin-top:16px">' +
          (esDni
            ? '<button class="btn primary" data-act="nuevo-cliente" data-dni="' + esc(nq) + '">' + ICON.plus + ' Registrar cliente DNI ' + esc(nq) + '</button>' +
              '<button class="btn" data-act="chip" data-type="dni">' + ICON.user + ' Ver todos los clientes</button>'
            : '<button class="btn primary" data-act="nuevo-vehiculo" data-patente="' + esc(nq) + '">' + ICON.car + ' Registrar vehículo ' + esc(nq) + '</button>' +
              '<button class="btn" data-act="scan">' + ICON.search + ' Escanear otra vez</button>') +
        '</div>' +
      '</div></section>';
  }

  /* ---------- Vista CLIENTE ---------- */
  /* Recibe la FICHA compuesta de la API: cliente + vehículos activos
     e históricos (con fechas de periodo ya resueltas por el servidor). */
  function renderCliente(cli) {
    var activos = cli.vehiculosActivos || [];
    var historicos = cli.vehiculosHistoricos || [];
    var html = '';

    html +=
      '<section class="card entity-hd fade-in">' +
        '<div class="eh-row">' +
          '<div class="avatar">' + esc(iniciales(cli.nombre)) + '</div>' +
          '<div style="flex:1;min-width:180px">' +
            '<h2>' + esc(cli.nombre) + '</h2>' +
            '<div class="sub">Cliente registrado' + (cli.desde ? ' desde ' + fecha(cli.desde) : '') + '</div>' +
          '</div>' +
          '<span class="badge ok" style="background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.24);color:#e8eefb">' +
            ICON.shield + ' Ficha activa</span>' +
          '<button type="button" class="hd-btn" data-act="eliminar-registro" data-kind="cliente" data-id="' + esc(cli.id) + '" title="Eliminar cliente" aria-label="Eliminar cliente">' + ICON.trash + '</button>' +
        '</div>' +
        '<div class="hd-meta">' +
          '<span class="meta-pill">' + ICON.id + '<b>' + esc(cli.dni) + '</b></span>' +
          '<span class="meta-pill">' + ICON.phone + (cli.telefono ? '<b>' + esc(cli.telefono) + '</b>' : 'Sin teléfono') + '</span>' +
          (cli.email ? '<span class="meta-pill">' + ICON.user + esc(cli.email) + '</span>' : '') +
          '<span class="meta-pill">' + ICON.car + '<b>' + activos.length + '</b> activo(s)</span>' +
        '</div>' +
      '</section>';

    /* Vehículos activos: UNA TARJETA POR VEHÍCULO, cada una con sus
       acciones propias (Seleccionar para servicio / Ver ficha). */
    html += '<div class="section"><div class="sec-head"><h2>Vehículos Activos</h2><span class="count">' + activos.length + '</span></div>';
    if (activos.length) {
      html += '<div class="card">' + activos.map(function (v) { return vehRow(v, false); }).join('') + '</div>';
    } else {
      html += '<div class="card"><div class="empty" style="padding:26px 18px">' + ICON.car +
        '<h3>Sin vehículos activos</h3><p>Este cliente no tiene vehículos en circulación registrados.</p></div></div>';
    }
    html += '</div>';

    /* Histórico: sólo transferencias y desafiliaciones de este cliente */
    html += '<div class="section"><div class="sec-head"><h2>Historial de Vehículos Anteriores</h2><span class="count gray">' + historicos.length + '</span></div>';
    if (historicos.length) {
      html += '<div class="card">' + historicos.map(function (v) { return vehRow(v, true); }).join('') + '</div>';
    } else {
      html += '<div class="card"><div class="empty" style="padding:24px 18px">' + ICON.clock +
        '<h3>Sin antecedentes</h3><p>No hay vehículos transferidos para este cliente.</p></div></div>';
    }
    html += '</div>';

    html += '<div class="section">' +
      '<button class="btn primary full" data-act="nuevo-vehiculo" data-cliente="' + esc(cli.id) + '">' +
        ICON.plus + ' Asociar Nuevo Vehículo a este Cliente</button>' +
      '<button class="btn full mt10" data-act="nueva-ot" data-cliente="' + esc(cli.id) + '">' +
        ICON.wrench + ' Nueva Orden de Trabajo</button>' +
    '</div>';

    RESULTS.innerHTML = html;
  }

  function vehRow(v, historico) {
    var duenoTxt = historico
      ? 'Histórico · ' + (v.nombreTitularActual || (v.clienteId ? nombrePropietario(v) : '') || 'sin titular actual')
      : '';
    return '<div class="veh ' + (historico ? 'off' : '') + '">' +
      '<div class="veh-ico">' + ICON.car + '</div>' +
      '<div class="veh-body">' +
        '<div class="veh-title">' +
          '<span class="plate">' + esc(v.patente) + '</span>' +
          '<strong>' + esc(v.marca) + ' ' + esc(v.modelo) + '</strong>' +
          (historico
            ? '<span class="badge off">' + ICON.clock + ' Anterior</span>'
            : '<span class="badge ok">' + ICON.check + ' Activo</span>') +
        '</div>' +
        '<div class="veh-sub">' +
          'Año ' + esc(v.anio || '—') +
          (v.color ? ' · ' + esc(v.color) : '') +
          (v.km ? ' · ' + num(v.km) + ' km' : '') +
          ' · ' + (v.cantidadServicios || 0) + ' servicio(s)' +
          (duenoTxt ? ' · ' + esc(duenoTxt) : '') +
        '</div>' +
        '<div class="veh-actions">' +
          (historico
            ? '<button class="btn sm" data-act="ver-vehiculo" data-vehiculo="' + esc(v.id) + '">' + ICON.clock + ' Ver historial</button>'
            : '<button class="btn sm primary" data-act="nueva-ot" data-vehiculo="' + esc(v.id) + '" data-cliente="' + esc(v.clienteId || '') + '">' + ICON.wrench + ' Seleccionar para servicio</button>' +
              '<button class="btn sm" data-act="ver-vehiculo" data-vehiculo="' + esc(v.id) + '">' + ICON.search + ' Ver ficha</button>') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ---------- Vista VEHÍCULO ---------- */
  /* Recibe la ficha compuesta: titular resuelto, historial de dueños y
     órdenes ya adaptadas (DATOS.ordenes trae el historial de servicios). */
  function renderVehiculo(v) {
    var cli = v.titular || (v.clienteId ? clientePorId(v.clienteId) : null);
    var svs = DATOS.ordenes || [];
    var html = '';

    html +=
      '<section class="card entity-hd fade-in">' +
        '<div class="eh-row">' +
          '<div class="avatar" style="font-size:13px;letter-spacing:1.4px;font-weight:800">' + esc(v.patente.slice(0, 3)) + '</div>' +
          '<div style="flex:1;min-width:180px">' +
            '<span class="plate lg">' + esc(v.patente) + '</span>' +
            '<h2 style="margin-top:9px">' + esc(v.marca || '—') + ' ' + esc(v.modelo || '') + '</h2>' +
            '<div class="sub">Año ' + esc(v.anio || '—') + (v.color ? ' · ' + esc(v.color) : '') + '</div>' +
          '</div>' +
          (v.estado === 'historico'
            ? '<span class="badge" style="background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.24);color:#e8eefb">' + ICON.clock + ' Histórico</span>'
            : '<span class="badge" style="background:rgba(16,185,129,.22);border-color:rgba(16,185,129,.45);color:#d1fae5">' + ICON.check + ' Activo</span>') +
          '<button type="button" class="hd-btn" data-act="eliminar-registro" data-kind="vehiculo" data-id="' + esc(v.id) + '" title="Eliminar vehículo" aria-label="Eliminar vehículo">' + ICON.trash + '</button>' +
        '</div>' +
        '<div class="hd-meta">' +
          (cli
            ? '<span class="meta-pill">' + ICON.user + '<b>' + esc(cli.nombre) + '</b></span>'
            : '<span class="meta-pill warn">' + ICON.user + '<b>Propietario desconocido</b></span>') +
          '<span class="meta-pill">' + ICON.wrench + '<b>' + svs.length + '</b> servicios</span>' +
          '<span class="meta-pill">' + ICON.clock + 'Últ. ' + (svs[0] ? fecha(svs[0].fecha) : '—') + '</span>' +
          (v.km ? '<span class="meta-pill">' + ICON.car + '<b>' + num(v.km) + '</b> km</span>' : '') +
        '</div>' +
      '</section>';

    if (v.estado !== 'historico') {
      html += '<div class="section"><button class="btn primary full" data-act="nueva-ot" data-vehiculo="' + esc(v.id) + '">' +
        ICON.wrench + ' Nueva Orden de Trabajo para ' + esc(v.patente) + '</button></div>';
    }
    if (cli) {
      html += '<div class="section"><button class="btn full" data-act="ver-cliente" data-cliente="' + esc(cli.id) + '">' +
        ICON.user + ' Ver ficha del cliente: ' + esc(cli.nombre) + '</button></div>';
    }

    html += '<div class="section"><div class="card">' +
      '<div class="tabs" role="tablist">' +
        tabBtn('historial', 'Historial de Servicios') +
        tabBtn('propietario', 'Propietario Actual') +
        tabBtn('duenos', 'Histórico de Dueños') +
      '</div>' +
      '<div class="tabpanel ' + (estado.tab === 'historial' ? 'active' : '') + '" data-panel="historial">' + panelHistorial(svs) + '</div>' +
      '<div class="tabpanel ' + (estado.tab === 'propietario' ? 'active' : '') + '" data-panel="propietario">' + panelPropietario(v, cli) + '</div>' +
      '<div class="tabpanel ' + (estado.tab === 'duenos' ? 'active' : '') + '" data-panel="duenos">' + panelDuenos(v) + '</div>' +
    '</div></div>';

    RESULTS.innerHTML = html;
  }

  function tabBtn(key, label) {
    return '<button class="tab ' + (key === estado.tab ? 'active' : '') + '" role="tab" data-act="tab" data-tab="' + key + '" ' +
      'aria-selected="' + (key === estado.tab) + '">' + esc(label) + '</button>';
  }

  function panelHistorial(svs) {
    if (!svs.length) {
      return '<div class="empty" style="padding:26px 10px">' + ICON.wrench +
        '<h3>Sin servicios registrados</h3><p>Todavía no hay órdenes de trabajo para este vehículo.</p></div>';
    }
    var total = svs.reduce(function (a, s) { return a + costoServicio(s); }, 0);

    var items = svs.map(function (s) {
      var rep = costoRepuestos(s);
      var costo = costoServicio(s);
      return '<div class="tl-item">' +
        '<div class="tl-hd"><time>' + fecha(s.fecha) + '</time>' +
          (s.km ? '<span class="km">' + num(s.km) + ' km</span>' : '') +
        '</div>' +
        '<div class="tl-body">' +
          '<div class="tags">' +
            (s.tareas || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') +
            (s.repuestos || []).map(function (r) {
              return '<span class="tag rep">' + ICON.box + ' ' + esc(r.nombre) + ' ×' + (Number(r.cantidad) || 1) + '</span>';
            }).join('') +
          '</div>' +
          (s.obs ? '<p class="small muted mt10">' + esc(s.obs) + '</p>' : '') +
          '<div class="tl-foot">' +
            '<button type="button" class="tl-edit" data-act="editar-ot" data-id="' + esc(s.id) + '" title="Editar esta orden de trabajo" aria-label="Editar orden de trabajo">' + ICON.lapiz + ' Editar</button>' +
            '<span class="xsmall muted">Mano de obra ' + money(s.manoObra) + (rep ? ' · Repuestos ' + money(rep) : '') + '</span>' +
            '<span class="tl-cost">' + money(costo) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="row between" style="margin-bottom:14px;gap:12px;flex-wrap:wrap">' +
        '<span class="badge">' + ICON.wrench + svs.length + ' intervención(es)</span>' +
        '<span class="small muted">Gasto acumulado: <b class="mono">' + money(total) + '</b></span>' +
      '</div>' +
      '<div class="tl">' + items + '</div>';
  }

  function kv(k, v) {
    return '<div class="kv"><dt>' + esc(k) + '</dt><dd>' + v + '</dd></div>';
  }

  function panelPropietario(v, cli) {
    if (!cli) {
      var ult = ultimoDuenoRegistrado(v);
      return '<div class="alert">' + ICON.alert +
        '<div><b>Propietario desconocido.</b><br>El vehículo está activo pero no tiene titular asociado.' +
        (ult ? ' Último titular registrado: <b>' + esc(ult) + '</b>.' : '') +
        ' Podés asignarle uno o mantenerlo desafiliado.</div>' +
        '</div>' +
        '<button class="btn primary full mt14" data-act="transferir" data-vehiculo="' + esc(v.id) + '">' + ICON.swap + ' Asignar titular</button>';
    }
    return '<div class="owner" style="background:var(--panel-2);align-items:center">' +
        '<div class="avatar">' + esc(iniciales(cli.nombre)) + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div class="strong">' + esc(cli.nombre) + '</div>' +
          '<div class="small muted">Titular actual desde ' + (cli.desde ? fecha(cli.desde) : '—') + '</div>' +
        '</div>' +
        '<span class="badge ok">' + ICON.check + ' Titular</span>' +
      '</div>' +
      '<dl class="mt14">' +
        kv('DNI / CUIT', '<span class="mono">' + esc(cli.dni) + '</span>') +
        kv('Teléfono', cli.telefono ? '<a href="tel:' + esc(cli.telefono.replace(/[^\d+]/g, '')) + '">' + esc(cli.telefono) + '</a>' : '<span class="muted">Sin datos</span>') +
        kv('Email', cli.email ? esc(cli.email) : '<span class="muted">Sin datos</span>') +
        kv('Vehículo', esc(v.marca + ' ' + v.modelo + ' (' + (v.anio || '—') + ')')) +
        kv('N° motor / chasis', '<span class="mono">' + esc(v.motor || '—') + '</span>') +
        kv('Kilometraje', v.km ? num(v.km) + ' km' : '—') +
      '</dl>' +
      '<div class="row mt18" style="flex-wrap:wrap">' +
        '<button class="btn" data-act="ver-cliente" data-cliente="' + esc(cli.id) + '">' + ICON.user + ' Ver ficha completa</button>' +
        '<button class="btn danger" data-act="transferir" data-vehiculo="' + esc(v.id) + '">' + ICON.swap + ' Transferir Titularidad</button>' +
        '<button class="btn danger" data-act="transferir" data-vehiculo="' + esc(v.id) + '" data-sin-titular="1">' + ICON.user + ' Desafiliar (Propietario desconocido)</button>' +
      '</div>';
  }

  function panelDuenos(v) {
    /* La API entrega los periodos de más nuevo a más viejo (como se
       muestran). En el modelo local se guardaban a la inversa y acá se
       revertían; ahora llegan listos. */
    var duenos = (v.duenos || []);
    var cli = v.titular || (v.clienteId ? clientePorId(v.clienteId) : null);
    var html = '';

    if (cli) {
      html += '<p class="xsmall muted" style="margin-bottom:9px;text-transform:uppercase;letter-spacing:.6px;font-weight:700">Titular actual</p>' +
        '<div class="owner" style="border-color:var(--brand-line);background:var(--brand-soft)">' +
          '<div class="avatar">' + esc(iniciales(cli.nombre)) + '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="strong">' + esc(cli.nombre) + '</div>' +
            '<div class="small muted">DNI ' + esc(cli.dni) + '</div>' +
          '</div>' +
          '<span class="badge ok">Actual</span>' +
        '</div>';
    }

    html += '<p class="xsmall muted mt18" style="margin-bottom:9px;text-transform:uppercase;letter-spacing:.6px;font-weight:700">Propietarios anteriores</p>';
    if (!duenos.length) {
      html += '<div class="empty" style="padding:22px 10px">' + ICON.clock +
        '<h3>Sin dueños anteriores</h3><p>Este vehículo siempre estuvo a nombre del titular actual.</p></div>';
    } else {
      html += duenos.map(function (d) {
        return '<div class="owner">' +
          '<div class="avatar">' + esc(iniciales(d.nombre)) + '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="strong">' + esc(d.nombre) + '</div>' +
            '<div class="small muted">DNI ' + esc(d.dni) + '</div>' +
            '<div class="xsmall muted mt6">' + fecha(d.desde) + ' → ' + fecha(d.hasta) + '</div>' +
          '</div>' +
          '<span class="badge off">Anterior</span>' +
        '</div>';
      }).join('');
    }
    return html;
  }

  /* ==========================================================
     7. Búsqueda dual e inteligente (un solo input) — vía API
     Coincidencia exacta primero: la API normaliza patente/DNI.
     Después parciales, recorriendo la lista completa del taller
     (conjuntos acotados: una consulta por búsqueda).
     ========================================================== */
  function renderCargando(msg) {
    RESULTS.innerHTML =
      '<section class="card fade-in"><div class="empty" style="padding:30px 18px">' +
        ICON.clock +
        '<h3>' + esc(msg || 'Cargando…') + '</h3>' +
        '<p>Comunicándonos con la base del taller…</p>' +
      '</div></section>';
  }

  function renderErrorCarga() {
    RESULTS.innerHTML =
      '<section class="card fade-in"><div class="empty" style="padding:30px 18px">' +
        ICON.alert +
        '<h3>No se pudo cargar la ficha</h3>' +
        '<p>La API no respondió correctamente. Levantá el servidor (arranque-rapido.cmd) e intentá de nuevo.</p>' +
        '<div class="row" style="justify-content:center;flex-wrap:wrap;margin-top:16px">' +
          '<button class="btn primary" data-act="reintentar">' + ICON.check + ' Reintentar</button>' +
        '</div>' +
      '</div></section>';
  }

  async function buscar(raw, tipoForzado) {
    var q = String(raw || '').trim();
    if (!q) { mostrarTodo(tipoForzado || estado.tipo); return; }

    var tipo = tipoForzado || estado.tipo;
    if (tipo === 'auto') tipo = detectarTipo(q);
    var nq = norm(q);
    /* Un DNI es solo dígitos: evito pedir ?dni= con texto (el servidor lo
       normaliza a vacío y devolvería TODA la lista, abriendo cualquier
       ficha como si fuera coincidencia exacta). */
    var puedeSerDni = /^\d+$/.test(nq);

    /* Estado de carga de la búsqueda: botón lupa deshabilitado */
    var btnBuscar = $('#searchForm .btn-search');
    if (btnBuscar) btnBuscar.disabled = true;
    try {
      if (tipo === 'dni') {
        /* Exacto primero (normalizado en el servidor) */
        if (puedeSerDni) {
          var exacto = await api('/clientes?dni=' + encodeURIComponent(nq));
          if (exacto && exacto.length) { abrirCliente(exacto[0].id); return; }
        }

        /* Parciales: sobre la lista completa del taller */
        var todos = await traerClientes();
        var parcialesDni = todos.filter(function (c) { return norm(c.dni).indexOf(norm(q)) !== -1; });
        if (parcialesDni.length === 1) { abrirCliente(parcialesDni[0].id); return; }
        if (parcialesDni.length > 1) { renderLista('clientes', parcialesDni); return; }

        /* Fallback: quizás era una patente numérica */
        var vFallback = await api('/vehiculos?patente=' + encodeURIComponent(norm(q)));
        if (vFallback && vFallback.length) { abrirVehiculo(vFallback[0].id); return; }
        renderSinResultados(q);
        return;
      }

      /* Búsqueda por patente: exacto primero */
      var veh = await api('/vehiculos?patente=' + encodeURIComponent(norm(q)));
      if (veh && veh.length) { abrirVehiculo(veh[0].id); return; }

      var listaVeh = await traerVehiculos();
      var parciales = listaVeh.filter(function (v) { return norm(v.patente).indexOf(norm(q)) !== -1; });
      if (parciales.length === 1) { abrirVehiculo(parciales[0].id); return; }
      if (parciales.length > 1) { renderLista('vehiculos', parciales); return; }

      /* Sin coincidencias como patente: probar como DNI (solo dígitos) */
      if (puedeSerDni) {
        var cliExacto = await api('/clientes?dni=' + encodeURIComponent(nq));
        if (cliExacto && cliExacto.length) { abrirCliente(cliExacto[0].id); return; }
      }
      renderSinResultados(q);
    } catch (e) {
      renderInicio();   /* el toast del error ya salió */
    } finally {
      if (btnBuscar) btnBuscar.disabled = false;
    }
  }

  function renderLista(kind, items, titulo) {
    estado.vista = 'inicio'; estado.clienteId = null; estado.vehiculoId = null;
    var html = '<div class="section"><div class="sec-head"><h2>' + esc(titulo || 'Coincidencias') + '</h2>' +
      '<span class="count gray">' + items.length + '</span></div><div class="card fade-in">';
    if (kind === 'clientes') {
      html += items.map(function (c) {
        var nActivos = c.vehiculosActivos != null ? c.vehiculosActivos : 0;
        return '<div class="veh"><div class="veh-ico">' + ICON.user + '</div><div class="veh-body">' +
          '<div class="veh-title"><strong>' + esc(c.nombre) + '</strong><span class="badge">DNI ' + esc(c.dni) + '</span></div>' +
          '<div class="veh-sub">' + nActivos + ' vehículo(s) activo(s) · ' + esc(c.telefono || 'sin teléfono') + '</div>' +
          '<div class="veh-actions"><button class="btn sm primary" data-act="ver-cliente" data-cliente="' + esc(c.id) + '">' + ICON.search + ' Abrir ficha</button></div>' +
        '</div></div>';
      }).join('');
    } else {
      html += items.map(function (v) { return vehRow(v, v.estado === 'historico'); }).join('');
    }
    html += '</div></div>';
    RESULTS.innerHTML = html;
  }

  /* Listado completo cuando no hay término de búsqueda */
  async function mostrarTodo(tipo) {
    try {
      if (tipo === 'patente') {
        var vs = await traerVehiculos();
        vs = vs.slice().sort(function (a, b) { return String(a.patente).localeCompare(String(b.patente)); });
        renderLista('vehiculos', vs, 'Todos los vehículos registrados');
      } else if (tipo === 'dni') {
        var cs = await traerClientes();
        cs = cs.slice().sort(function (a, b) { return a.nombre.localeCompare(b.nombre); });
        renderLista('clientes', cs, 'Todos los clientes registrados');
      } else {
        renderInicio();
      }
    } catch (e) { renderErrorCarga(); return; }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function irAlInicio() {
    estado.vista = 'inicio'; estado.clienteId = null; estado.vehiculoId = null; estado.tipo = 'auto';
    $$('.chip').forEach(function (c) { c.classList.toggle('active', c.dataset.type === 'auto'); });
    $('#q').value = '';
    $('#q').placeholder = Q_PH_BASE;
    renderInicio();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* Fichas: cargan por HTTP antes de renderizar. `opts` evita el
     skeleton/scroll cuando son re-renderizados por refrescar(). */
  async function abrirCliente(id, opts) {
    var o = opts || {};
    estado.vista = 'cliente'; estado.clienteId = id; estado.vehiculoId = null;
    if (!o.sinCargando) renderCargando('Cargando la ficha del cliente…');
    var ficha;
    try { ficha = await traerFichaCliente(id); }
    catch (e) { renderErrorCarga(); return; }
    renderCliente(ficha);
    if (!o.sinScroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function abrirVehiculo(id, opts) {
    var o = opts || {};
    estado.vista = 'vehiculo'; estado.vehiculoId = id;
    if (!o.conservarTab) estado.tab = 'historial';
    if (!o.sinCargando) renderCargando('Cargando la historia clínica del vehículo…');
    var ficha;
    try {
      var par = await Promise.all([traerFichaVehiculo(id), traerOrdenes(id)]);
      ficha = par[0];
    } catch (e) { renderErrorCarga(); return; }
    renderVehiculo(ficha);
    if (!o.sinScroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* Re-render de lo visible con datos frescos (tras una mutación o un
     error): sin skeleton ni salto de scroll; conserva la pestaña activa. */
  async function refrescar() {
    if (estado.vista === 'cliente') {
      if (estado.clienteId) await abrirCliente(estado.clienteId, { sinCargando: true, sinScroll: true });
      else renderInicio();
    } else if (estado.vista === 'vehiculo') {
      if (estado.vehiculoId) await abrirVehiculo(estado.vehiculoId, { sinCargando: true, sinScroll: true, conservarTab: true });
      else renderInicio();
    } else {
      renderInicio();
    }
  }

  /* ==========================================================
     8. Modales (estado centralizado: scroll + limpieza de cámara)
     ========================================================== */
  var abierto = null;

  function abrirModal(id) {
    var m = $(id);
    if (!m) return;
    if (abierto && abierto !== m) abierto.classList.remove('open');
    m.classList.add('open');
    abierto = m;
    document.body.style.overflow = 'hidden';
    var foco = m.querySelector('input, select, textarea, button');
    if (foco && window.innerWidth > 720) setTimeout(function () { foco.focus(); }, 60);
  }

  /* Única salida de modales: libera el scroll y detiene la cámara/OCR */
  function cerrarModal() {
    if (!abierto) return;
    abierto.classList.remove('open');
    abierto = null;
    document.body.style.overflow = '';
    detenerCamara();
  }

  function toast(msg, esError) {
    var t = document.createElement('div');
    t.className = 'toast' + (esError ? ' err' : '');
    t.innerHTML = (esError ? ICON.alert : ICON.check) + '<span>' + esc(msg) + '</span>';
    $('#toasts').appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .25s ease, transform .25s ease';
      t.style.opacity = '0';
      t.style.transform = 'translateY(10px)';
      setTimeout(function () { t.remove(); }, 260);
    }, 3200);
  }

  /* ==========================================================
     9. Orden de Trabajo (modal)
     ========================================================== */
  /* Select de vehículos para una orden: TODOS los activos (con o sin
     titular) ordenados por patente; los del cliente en contexto van al
     tope. Los sin titular se marcan "(Sin titular)". */
  async function llenarVehiculosOT(clienteId, forzarId) {
    var sel = $('#ot-vehiculo');
    sel.disabled = false;
    var lista;
    try { lista = await traerVehiculos(); }
    catch (e) { lista = []; }
    lista = lista.slice().sort(function (a, b) { return String(a.patente).localeCompare(String(b.patente)); });
    lista = lista.filter(function (v) { return v.estado !== 'historico'; });
    if (clienteId) {
      var delCliente = lista.filter(function (v) { return v.clienteId === clienteId; });
      if (delCliente.length) lista = delCliente.concat(lista.filter(function (v) { return v.clienteId !== clienteId; }));
    }
    /* En edición se fuerza el vehículo de la orden aunque sea histórico.
       Puede estar filtrando el listado: sale de la caché o de la ficha. */
    if (forzarId) {
      var forzado = (DATOS.fichaVehiculo && DATOS.fichaVehiculo.id === forzarId)
        ? DATOS.fichaVehiculo
        : vehiculoPorId(forzarId);
      if (forzado && lista.indexOf(forzado) < 0) lista = [forzado].concat(lista);
    }
    sel.innerHTML = '<option value="">Seleccioná un vehículo…</option>' + lista.map(function (v) {
      var etiqueta = v.patente + ' — ' + v.marca + ' ' + v.modelo + ' (' + (v.anio || '—') + ')';
      if (clienteId && v.clienteId === clienteId) etiqueta += ' · activo';
      if (!v.clienteId) etiqueta += ' (Sin titular)';
      return '<option value="' + esc(v.id) + '">' + esc(etiqueta) + '</option>';
    }).join('');
  }

  /* Grilla de tareas sugeridas; las guardadas que ya no están en la
     lista se agregan al final y quedan marcadas. */
  function renderTareasOT(seleccionadas) {
    var sel = (seleccionadas || []).slice();
    var lista = TAREAS_SUGERIDAS.slice();
    sel.forEach(function (t) { if (lista.indexOf(t) < 0) lista.push(t); });
    $('#ot-tareas').innerHTML = lista.map(function (t) {
      return '<label class="check"><input type="checkbox" value="' + esc(t) + '"' +
        (sel.indexOf(t) >= 0 ? ' checked' : '') + '>' + esc(t) + '</label>';
    }).join('');
  }

  function filaRepuesto(nombre, cantidad, precio) {
    return '<div class="rep-row mt6">' +
      '<input class="inp" placeholder="Repuesto" data-rep="nombre" value="' + esc(nombre || '') + '">' +
      '<input class="inp" type="number" min="1" step="1" value="' + (Number(cantidad) || 1) + '" data-rep="cantidad" inputmode="numeric" title="Cantidad">' +
      '<input class="inp" type="number" min="0" step="100" value="' + (Number(precio) || 0) + '" data-rep="precio" inputmode="numeric" title="Precio unitario">' +
      '<button type="button" class="icon-del" data-act="del-repuesto" title="Quitar">' + ICON.trash + '</button>' +
    '</div>';
  }

  /* Alta de una orden: preselección por tarjeta, o vehículos del
     cliente en contexto al tope del listado. */
  async function abrirOT(vehiculoId, clienteId) {
    estado.ctx = { clienteId: clienteId || null, editarId: null };
    await llenarVehiculosOT(clienteId, vehiculoId);
    if (vehiculoId) $('#ot-vehiculo').value = vehiculoId;

    var v = vehiculoId ? vehiculoPorId(vehiculoId) : null;
    $('#ot-title').textContent = 'Nueva Orden de Trabajo';
    $('#ot-sub').textContent = v ? 'Vehículo: ' + v.patente + ' · ' + v.marca + ' ' + v.modelo : 'Cargá los datos del servicio realizado';
    $('#ot-fecha').value = hoy();
    $('#ot-km').value = v && v.km ? v.km : '';
    $('#ot-mano').value = 0;
    $('#ot-obs').value = '';

    renderTareasOT(null);
    $('#ot-repuestos').innerHTML = '';
    agregarRepuesto();
    calcularTotal();
    abrirModal('#modal-ot');
  }

  /* Edición de una orden del historial: mismo modal, formulario
     precargado (fecha, km, tareas, repuestos, mano de obra, obs).
     El vehículo no se cambia — la orden ya le pertenece — para no
     desordenar la historia clínica de otro auto. */
  async function abrirEdicionOT(id) {
    var s = ordenPorId(id);
    if (!s) { toast('La orden ya no existe', true); return; }
    var v = vehiculoPorId(s.vehiculoId);

    estado.ctx = { clienteId: v ? v.clienteId : null, editarId: s.id };
    await llenarVehiculosOT(null, s.vehiculoId);
    var sel = $('#ot-vehiculo');
    sel.value = s.vehiculoId;
    sel.disabled = true;

    $('#ot-title').textContent = 'Editar Orden de Trabajo';
    $('#ot-sub').textContent = 'Editando la orden del ' + fecha(s.fecha) +
      (v ? ' · ' + v.patente + ' — ' + v.marca + ' ' + v.modelo : '');
    $('#ot-fecha').value = (s.fecha && /^\d{4}-\d{2}-\d{2}$/.test(s.fecha)) ? s.fecha : hoy();
    $('#ot-km').value = s.km || '';
    $('#ot-mano').value = Number(s.manoObra) || 0;
    $('#ot-obs').value = s.obs || '';

    renderTareasOT(s.tareas);
    var reps = (s.repuestos || []).filter(function (r) { return r && r.nombre; });
    $('#ot-repuestos').innerHTML = reps.map(function (r) {
      return filaRepuesto(r.nombre, r.cantidad, r.precio);
    }).join('');
    if (!reps.length) agregarRepuesto();
    calcularTotal();
    abrirModal('#modal-ot');
  }

  function agregarRepuesto() {
    $('#ot-repuestos').insertAdjacentHTML('beforeend', filaRepuesto('', 1, 0));
  }

  function leerRepuestos() {
    return $$('#ot-repuestos .rep-row').map(function (r) {
      return {
        nombre: $('[data-rep="nombre"]', r).value.trim(),
        cantidad: Number($('[data-rep="cantidad"]', r).value) || 0,
        precio: Number($('[data-rep="precio"]', r).value) || 0
      };
    }).filter(function (r) { return r.nombre && r.cantidad > 0; });
  }

  /* Calculadora dinámica: mano de obra + Σ(cantidad × precio) */
  function calcularTotal() {
    var mano = Number($('#ot-mano').value) || 0;
    var rep = leerRepuestos().reduce(function (a, r) { return a + r.cantidad * r.precio; }, 0);
    $('#ot-total').textContent = money(mano + rep);
  }

  async function guardarOT(btn) {
    var editId = estado.ctx.editarId || null;
    var sActual = editId ? ordenPorId(editId) : null;
    if (editId && !sActual) { cerrarModal(); toast('La orden ya no existe', true); return; }

    var vid = sActual ? sActual.vehiculoId : $('#ot-vehiculo').value;
    if (!vid) { toast('Seleccioná un vehículo', true); return; }

    var datos = {
      fecha: $('#ot-fecha').value || hoy(),
      km: Number($('#ot-km').value) || null,
      tareas: $$('#ot-tareas input:checked').map(function (i) { return { descripcion: i.value }; }),
      repuestos: leerRepuestos().map(function (r) {
        return { nombre: r.nombre, cantidad: r.cantidad, precioUnitario: r.precio };
      }),
      manoObra: Number($('#ot-mano').value) || 0,
      observaciones: $('#ot-obs').value.trim()
    };

    /* POST (alta) o PUT (edición, reemplaza tareas y repuestos). El
       odómetro monotónico lo aplica el servidor: un km menor o igual
       (p. ej. al editar una orden vieja) no retrocede la ficha. */
    var ok = await conEnvio(btn, async function () {
      if (sActual) await api('/ordenes/' + encodeURIComponent(editId), { method: 'PUT', body: datos });
      else await api('/ordenes', { method: 'POST', body: Object.assign({ vehiculoId: vid }, datos) });
    });
    if (!ok) return;   /* el modal queda abierto: corregir y reintentar */

    cerrarModal();
    estado.ctx = {};
    toast(sActual ? 'Orden actualizada' : 'Orden de trabajo guardada');
    if (estado.vista === 'vehiculo' && estado.vehiculoId === vid) estado.tab = 'historial';
    refrescar();
  }

  /* ==========================================================
     10. Vehículos (asociar a un cliente)
     ========================================================== */
  /* Alta de vehículo con 3 modos de propietario (radios #v-modo):
     · existente  → se elige el titular en #v-cliente (preseleccionado
       si se llega desde la ficha de un cliente).
     · nuevo      → se crea la ficha del titular inline y se vincula.
     · desconocido→ nace "Propietario desconocido" (clienteId null). */
  async function abrirVehiculoModal(clienteId, patente) {
    /* Lista de clientes existentes desde la API (modo "existente") */
    try { await traerClientes(); } catch (e) { /* toast ya avisado; el select queda vacío */ }
    var c = clientePorId(clienteId);
    estado.ctx = { clienteId: c ? c.id : null };

    var sel = $('#v-cliente');
    var clientes = (DATOS.clientes || []).slice().sort(function (a, b) { return a.nombre.localeCompare(b.nombre); });
    sel.innerHTML = '<option value="">Elegí un cliente…</option>' + clientes.map(function (x) {
      return '<option value="' + esc(x.id) + '">' + esc(x.nombre + ' · DNI ' + x.dni) + '</option>';
    }).join('');

    $('#vehForm').reset();   /* los radios vuelven a "Cliente existente" */
    $('#v-anio').value = new Date().getFullYear();
    /* Patente buscada/escaneada que motivó el alta: vuelve tras el reset */
    if (patente) $('#v-patente').value = norm(patente);
    if (c) sel.value = c.id;

    $('#veh-sub').textContent = c
      ? 'Se vinculará a ' + c.nombre + ' (DNI ' + esc(c.dni) + ').' +
        ' Podés cambiar el modo de propietario si necesitás otro destino.'
      : 'Elegí el propietario: un cliente registrado, un alta nueva o dejalo sin titular.';
    cambiarModoPropietario();
    abrirModal('#modal-vehiculo');
  }

  function modoPropietarioVeh() {
    var r = document.querySelector('input[name="v-modo"]:checked');
    return r ? r.value : 'existente';
  }

  /* Visibilidad por modo: sólo los campos activos son required, así el
     reportValidity valida exactamente lo que el usuario está viendo. */
  function cambiarModoPropietario() {
    var modo = modoPropietarioVeh();
    $('#veh-holder').hidden = modo !== 'existente';
    $('#veh-nuevo-holder').hidden = modo !== 'nuevo';
    $('#v-modo-hint').textContent = modo === 'nuevo'
      ? 'Creamos la ficha del titular ahora y la vinculamos al vehículo.'
      : (modo === 'desconocido'
        ? 'El vehículo queda activo y sin titular: disponible para recibir órdenes de trabajo.'
        : 'Asociá el vehículo a un titular ya registrado.');
    $('#v-cliente').required = (modo === 'existente');
    $('#v-cli-nombre').required = (modo === 'nuevo');
    $('#v-cli-dni').required = (modo === 'nuevo');
  }

  /* Siempre nace 'activo': el cliente puede acumular varios activos y
     el sin titular queda disponible para órdenes de trabajo enseguida. */
  async function guardarVehiculo(btn) {
    var form = $('#vehForm');
    if (!form.reportValidity()) return;
    var patente = norm($('#v-patente').value);
    if (patente.length < 5) { toast('La patente parece incompleta', true); return; }
    if (DATOS.vehiculos && vehiculoPorPatente(patente)) { toast('Ya existe un vehículo con esa patente', true); return; }

    /* Propietario efectivo según el modo elegido */
    var modo = modoPropietarioVeh();
    var body = {
      patente: patente,
      marca: $('#v-marca').value.trim() || null,
      modelo: $('#v-modelo').value.trim() || null,
      anio: Number($('#v-anio').value) || null,
      color: $('#v-color').value.trim() || null,
      km: Number($('#v-km').value) || null,
      motor: $('#v-motor').value.trim() || null
    };

    if (modo === 'existente') {
      var clienteIdElegido = $('#v-cliente').value || null;
      if (!clienteIdElegido) { toast('Elegí el cliente propietario', true); return; }
      body.clienteId = clienteIdElegido;
    } else if (modo === 'nuevo') {
      /* Alta del titular inline: el servidor crea la ficha o REUTILIZA
         la existente por DNI (avisamos cuando pasa lo segundo, con la
         misma consulta que haría el modo local). */
      var dniVeh = norm($('#v-cli-dni').value);
      body.nuevoCliente = {
        nombre: $('#v-cli-nombre').value.trim(),
        dni: dniVeh,
        telefono: $('#v-cli-tel').value.trim()
      };
      if (dniVeh) {
        try {
          var porDniVeh = await api('/clientes?dni=' + encodeURIComponent(dniVeh));
          if (porDniVeh && porDniVeh.length) {
            toast('Ya existe un cliente con ese DNI: se reutilizará su ficha');
            body.clienteId = porDniVeh[0].id;
            delete body.nuevoCliente;
          }
        } catch (e) { /* sin respuesta previa: el servidor decide al crear */ }
      }
    } else {
      body.sinTitular = true;   /* modo 'desconocido': clienteId NULL */
    }

    /* El servidor valida unicidad de patente (409) y nace 'activo'. */
    var creado = null;
    var ok = await conEnvio(btn, async function () {
      creado = await api('/vehiculos', { method: 'POST', body: body });
    });
    if (!ok || !creado) return;   /* modal abierto y reintentable */

    cerrarModal();
    toast(creado.clienteId
      ? 'Vehículo asociado correctamente'
      : 'Vehículo registrado: queda como "Propietario desconocido"');
    abrirVehiculo(creado.id);
  }

  /* ==========================================================
     11. Transferencia de titularidad
     ========================================================== */
  function abrirTransfer(vehiculoId, sinTitular) {
    /* Preferimos la ficha (trae el titular resuelto por la API) */
    var v = (DATOS.fichaVehiculo && DATOS.fichaVehiculo.id === vehiculoId)
      ? DATOS.fichaVehiculo
      : vehiculoPorId(vehiculoId);
    if (!v) return;
    estado.ctx = { vehiculoId: vehiculoId };
    $('#trForm').reset();
    $('#tr-fecha').value = hoy();
    $('#tr-sin-titular').checked = !!sinTitular;
    alternarDatosTitular();
    $('#tr-sub').textContent = 'Vehículo ' + v.patente + ' · titular actual: ' + nombrePropietario(v);
    abrirModal('#modal-transfer');
  }

  /* Con "Propietario desconocido" los datos del nuevo titular no aplican */
  function alternarDatosTitular() {
    var off = $('#tr-sin-titular').checked;
    var datos = $('#tr-datos');
    if (datos) datos.style.display = off ? 'none' : '';
    $$('#tr-datos input').forEach(function (i) { i.disabled = off; });
  }

  async function guardarTransfer(btn) {
    var sinTitular = $('#tr-sin-titular').checked;
    var form = $('#trForm');
    if (!sinTitular && !form.reportValidity()) return;
    var ficha = (DATOS.fichaVehiculo && DATOS.fichaVehiculo.id === estado.ctx.vehiculoId)
      ? DATOS.fichaVehiculo
      : vehiculoPorId(estado.ctx.vehiculoId);
    if (!ficha) { cerrarModal(); return; }
    var f = $('#tr-fecha').value || hoy();

    var body = { fecha: f };

    if (!sinTitular) {
      var dni = norm($('#tr-dni').value);
      var nombre = $('#tr-nombre').value.trim();
      var tel = $('#tr-tel').value.trim();

      /* Nuevo titular: si el DNI ya está registrado se reutiliza su ficha
         (nuevoClienteId); si no, el servidor hace el alta inline. El
         snapshot del titular SALIENTE lo arma el servidor en la misma
         transacción (historial_duenos) — ya no lo simulamos acá. */
      var nuevo = null;
      if (dni) {
        try {
          var porDni = await api('/clientes?dni=' + encodeURIComponent(dni));
          if (porDni && porDni.length) nuevo = porDni[0];
        } catch (e) { /* sin respuesta: el servidor decide al crear */ }
      }
      if (nuevo) {
        body.nuevoClienteId = nuevo.id;
        /* Como antes: si el operador escribió el nombre, la ficha del
           cliente se actualiza (best effort, no bloquea la transferencia). */
        var cambio = {};
        if (nombre && nombre !== nuevo.nombre) cambio.nombre = nombre;
        if (tel && !nuevo.telefono) cambio.telefono = tel;
        if (Object.keys(cambio).length) {
          api('/clientes/' + encodeURIComponent(nuevo.id), { method: 'PUT', body: cambio }).catch(function () {});
        }
      } else {
        body.nuevoCliente = { nombre: nombre, dni: dni, telefono: tel };
      }
    } else {
      body.sinTitular = true;   /* desafiliar: el auto queda activo y sin propietario */
    }

    var respuesta = null;
    var ok = await conEnvio(btn, async function () {
      respuesta = await api('/vehiculos/' + encodeURIComponent(ficha.id) + '/transferir', { method: 'POST', body: body });
    });
    if (!ok || !respuesta) return;   /* modal abierto para corregir */

    cerrarModal();
    estado.ctx = {};

    if (sinTitular) {
      toast(ficha.patente + ' desafiliado: queda como "Propietario desconocido"');
      abrirVehiculo(ficha.id);
      return;
    }

    toast('Titularidad transferida a ' + ((respuesta.titular && respuesta.titular.nombre) || 'el nuevo titular'));
    estado.vista = 'vehiculo'; estado.vehiculoId = ficha.id; estado.tab = 'propietario';
    abrirVehiculo(ficha.id, { conservarTab: true, sinScroll: true });
  }

  /* ==========================================================
     12. Clientes (alta)
     ========================================================== */
  function abrirClienteModal(dni) {
    $('#clForm').reset();
    /* DNI buscado sin resultados: el alta sale con el número ya cargado */
    if (dni) $('#c-dni').value = norm(dni);
    abrirModal('#modal-cliente');
  }

  async function guardarCliente(btn) {
    var form = $('#clForm');
    if (!form.reportValidity()) return;
    var dni = norm($('#c-dni').value);
    if (!dni) { toast('Ingresá un DNI', true); return; }

    /* Chequeo previo de duplicado (mejor mensaje; el índice UNIQUE de la
       API igual devolvería 409). Sin conexión religamos: decide el POST. */
    try {
      var pre = await api('/clientes?dni=' + encodeURIComponent(dni));
      if (pre && pre.length) { toast('Ya existe un cliente con ese DNI', true); return; }
    } catch (e) { /* seguimos; si falla el POST ya avisa */ }

    var body = {
      nombre: $('#c-nombre').value.trim(),
      dni: dni,
      telefono: $('#c-tel').value.trim(),
      email: $('#c-email').value.trim()
    };

    var creado = null;
    var ok = await conEnvio(btn, async function () {
      creado = await api('/clientes', { method: 'POST', body: body });
    });
    if (!ok || !creado) return;   /* modal abierto y reintentable */

    cerrarModal();
    toast('Cliente registrado');
    abrirCliente(creado.id);
  }

  /* ==========================================================
     13. Eliminar registros (con confirmación)
     ========================================================== */
  async function abrirEliminar(kind, id) {
    var msg = '', sub = 'Esta acción no se puede deshacer';

    if (kind === 'cliente') {
      var c;
      try { c = await traerFichaCliente(id); }
      catch (e) { return; }   /* toast de error ya mostrado */
      var activos = c.vehiculosActivos || [];
      var historicos = c.vehiculosHistoricos || [];
      if (activos.length) {
        toast('No se puede eliminar: ' + c.nombre + ' tiene ' + activos.length + ' vehículo(s) activo(s). Transferí la titularidad primero.', true);
        return;
      }
      estado.ctx = { eliminar: { kind: 'cliente', id: id } };
      $('#del-title').textContent = 'Eliminar cliente';
      sub = c.nombre + ' · DNI ' + c.dni;
      msg = 'Se eliminará la ficha de <b>' + esc(c.nombre) + '</b> (DNI ' + esc(c.dni) + ').' +
        (historicos.length
          ? ' Sus ' + historicos.length + ' vehículo(s) histórico(s) seguirán existiendo, pero quedarán <b>sin titular asociado</b>.'
          : '') +
        ' Las órdenes de trabajo ya cargadas no se borran.';
    } else {
      var v;
      try { v = await traerFichaVehiculo(id); }
      catch (e) { return; }
      estado.ctx = { eliminar: { kind: 'vehiculo', id: id } };
      $('#del-title').textContent = 'Eliminar vehículo';
      sub = v.patente + ' · ' + v.marca + ' ' + v.modelo;
      msg = 'Se eliminará <b>' + esc(v.patente) + ' — ' + esc(v.marca + ' ' + v.modelo) + '</b>' +
        (v.cantidadServicios ? ' junto con sus <b>' + v.cantidadServicios + ' orden(es) de trabajo</b>' : '') + '.' +
        (v.titular ? ' El titular ' + esc(nombrePropietario(v)) + ' quedará sin este vehículo.' : '');
    }

    $('#del-sub').textContent = sub;
    $('#del-msg').innerHTML = msg;
    abrirModal('#modal-eliminar');
  }

  async function confirmarEliminar(btn) {
    var e = estado.ctx.eliminar;
    if (!e) { cerrarModal(); return; }
    var eraCliente = e.kind === 'cliente';

    /* Quién reacciona DESPUÉS del delete: para el vehículo es el titular
       vigente (le reabrimos su ficha); los cascades los hace la FK. */
    var titularVeh = (!eraCliente && DATOS.fichaVehiculo && DATOS.fichaVehiculo.id === e.id)
      ? DATOS.fichaVehiculo.titular
      : null;

    var ok = await conEnvio(btn, async function () {
      await api((eraCliente ? '/clientes/' : '/vehiculos/') + encodeURIComponent(e.id), { method: 'DELETE' });
    });
    if (!ok) return;   /* el modal queda abierto si falló */

    cerrarModal();
    estado.ctx = {};
    DATOS.fichaCliente = null; DATOS.fichaVehiculo = null;
    toast(eraCliente
      ? 'Cliente eliminado'
      : 'Vehículo eliminado junto con su historia clínica');

    if (eraCliente) { irAlInicio(); return; }
    estado.vehiculoId = null;
    if (titularVeh) abrirCliente(titularVeh.id);
    else { estado.vista = 'inicio'; renderInicio(); }
  }

  /* ==========================================================
     14. Escáner de cámara
     ========================================================== */
  var stream = null;
  var ocrSeq = 0;              /* invalida lecturas OCR huérfanas al cerrar el modal */

  function detenerCamara() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    var vid = $('#scan-video');
    if (vid) vid.srcObject = null;
    ocrSeq++;                  /* toda OCR en curso queda descartada */
  }

  function abrirEscaner() {
    $('#scan-manual').value = '';
    $('#scan-note').hidden = true;
    abrirModal('#modal-scan');
    iniciarCamara();
  }

  function notaScan(txt) {
    $('#scan-note').hidden = false;
    $('#scan-note-txt').textContent = txt;
  }

function iniciarCamara() {
    var msg = $('#scan-msg');
    var video = $('#scan-video');
    msg.textContent = 'Iniciando cámara…';

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.textContent = 'Cámara no disponible';
      notaScan('Cámara no accesible en este navegador (o contexto no seguro). Usá el campo manual de abajo.');
      return;
    }

    function mostrar(s) {
      stream = s;
      video.srcObject = s;
      video.play().catch(function () {});
      msg.textContent = 'Apuntá la patente dentro del recuadro';
      notaScan('Presioná "Capturar y leer" para leer la chapa impresa (Mercosur o antigua).');
    }

    function pedir(cs) {
      return navigator.mediaDevices.getUserMedia(cs);
    }

    /* Intento 1: Fuerza Zoom 2x (encuadre cómodo desde más lejos) */
    var csZoom2 = {
      video: { facingMode: { ideal: 'environment' }, advanced: [{ zoom: 2.0 }] },
      audio: false
    };

    /* Intento 2: Si no soporta 2x, busca Zoom 1x (lente principal) */
    var csZoom1 = {
      video: { facingMode: { ideal: 'environment' }, advanced: [{ zoom: 1.0 }] },
      audio: false
    };

    /* Intento 3: Respaldo convencional sin parámetros de zoom */
    var csConvencional = {
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    };

    /* Cascada de promesas: 2x -> 1x -> Convencional */
    pedir(csZoom2)
      .then(mostrar)
      .catch(function () {
        pedir(csZoom1)
          .then(mostrar)
          .catch(function () {
            pedir(csConvencional)
              .then(mostrar)
              .catch(function () {
                msg.textContent = 'No se pudo acceder a la cámara';
                notaScan('Permiso denegado o cámara ocupada. Podés escribir la patente manualmente abajo.');
              });
          });
      });
  }

  /* ==========================================================
     15. Motor ALPR (ONNX Runtime Web + modelos fast-plate-ocr)
     · onnxruntime-web (inferencia WebGL/Wasm) se descarga del CDN
       una sola vez; los clicks repetidos reusan la misma cola.
     · Los pesos viven en models/ junto a app.js: carga local e
       instantánea cuando la app se sirve por http. Como respaldo
       documentado quedan las URLs oficiales de GitHub.
     · Detector: YOLOv9-tiny de chapa (fast-alpr). Lector: CNN de
       7 espacios entrenada con patentes argentinas (fast-plate-ocr).
     · Las sesiones se compilan UNA vez (WebGL con respaldo Wasm)
       y quedan persistentes entre capturas.
     ========================================================== */
  var ORT_CDNS = [
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.all.min.js',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js',
    'https://unpkg.com/onnxruntime-web@1.20.1/dist/ort.all.min.js'
  ];
  var ALPR = {
    detIn: 640,                                   /* lado de entrada del detector */
    lectorAn: 140, lectorAl: 70, slots: 7,        /* entrada del lector (config oficial) */
    alfa: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_',
    umbralBox: 0.35,                              /* confianza mínima del detector */
    arMin: 1.35, arMax: 9.0,                      /* aspecto ancho/alto plausible de una chapa */
    corteBanda: 0.18,                             /* 2do intento: recorta la franja superior */
    /* Orígenes de los pesos: primero el paquete local (models/),
       después los release assets oficiales (requieren proxy CORS en
       despliegues remotos: GitHub no envía cabeceras CORS ahí). */
    detURLs: [
      'models/yolo-v9-t-640.onnx',
      'https://github.com/ankandrew/fast-alpr/releases/download/assets/yolo-v9-t-640.onnx'
    ],
    reURLs: [
      'models/arg_cnn_ocr.onnx',
      'https://github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates/arg_cnn_ocr.onnx'
    ]
  };
  var alpr = { estado: 'no-iniciado', cola: [], rt: null };   /* rt = { ort, det, red } */
  var ortScriptIniciado = false;
  var ortScriptCola = [];

  /* Descarga el runtime y lo deja en window.ort (cola + multi-CDN) */
  function cargarOrtScript(cb) {
    if (window.ort) { cb(null); return; }
    ortScriptCola.push(cb);
    if (ortScriptIniciado) return;
    ortScriptIniciado = true;
    var i = 0;

    function terminar(err) {
      var pendientes = ortScriptCola.slice();
      ortScriptCola = [];
      pendientes.forEach(function (f) { f(err || null); });
    }

    function intentar() {
      if (window.ort) { terminar(null); return; }
      if (i >= ORT_CDNS.length) {
        terminar(new Error('sin CDN'));
        toast('No se pudo cargar el motor neuronal (sin internet)', true);
        notaScan('No se pudo descargar onnxruntime-web desde el CDN. Escribí la patente en la lectura manual o reintentá con conexión.');
        return;
      }
      var script = document.createElement('script');
      script.src = ORT_CDNS[i++];
      script.async = true;

      var temporizador = setTimeout(function () {
        if (window.ort) return;
        script.onload = script.onerror = null;
        intentar();
      }, 30000);

      script.onload = function () { clearTimeout(temporizador); script.onload = script.onerror = null; intentar(); };
      script.onerror = function () { clearTimeout(temporizador); script.onload = script.onerror = null; intentar(); };

      document.head.appendChild(script);
    }
    intentar();
  }

  /* Descarga un modelo binario probando cada URL en orden, con progreso */
  function descargarModelo(urls, cb, aviso) {
    var i = 0;

    function intentar() {
      fetch(urls[i]).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var total = Number(r.headers.get('content-length')) || 0;
        if (!r.body || !r.body.getReader) {
          return r.arrayBuffer().then(function (b) { if (aviso) aviso(1); return b; });
        }
        var lector = r.body.getReader();
        var partes = [], tomado = 0;

        function paso() {
          return lector.read().then(function (d) {
            if (d.done) {
              var todo = new Uint8Array(tomado), off = 0;
              partes.forEach(function (p) { todo.set(p, off); off += p.length; });
              return todo.buffer;
            }
            partes.push(d.value);
            tomado += d.value.length;
            if (total && aviso) aviso(tomado / total);
            return paso();
          });
        }
        return paso();
      }).then(function (buf) {
        cb(null, buf);
      }).catch(function (e) {
        i++;
        if (i < urls.length) intentar(); else cb(e);
      });
    }
    intentar();
  }

  /* Crea una sesión probando WebGL primero y Wasm como respaldo.
     Se incluye una corrida de caldeo: los backends pueden fallar
     EN LA CORRIDA aunque compilen el grafo (WebGL no soporta,
     p. ej., el Resize nearest del YOLO): si el caldeo tira error,
     se reintenta con el próximo EP para no quedar a media cadena. */
  function crearSesion(ort, datos, prueba, cb) {
    var eps = ['webgl', 'wasm'];
    var i = 0;

    function probar() {
      if (i >= eps.length) { cb(new Error('sin backend disponible')); return; }
      ort.InferenceSession.create(datos, { executionProviders: [eps[i++]] }).then(function (s) {
        if (!prueba) { cb(null, s); return; }
        var arr = new (prueba.tipo === 'float32' ? Float32Array : Uint8Array)(prueba.n);
        var feeds = {};
        feeds[s.inputNames[0]] = new ort.Tensor(prueba.tipo, arr, prueba.dims);
        s.run(feeds).then(function () {
          cb(null, s);
        }).catch(function () { probar(); });
      }).catch(function () { probar(); });
    }
    probar();
  }

  /* Orquestador: runtime + detector + lector (persistente, con cola) */
  function cargarALPR(cb) {
    if (alpr.estado === 'listo' && alpr.rt) { cb(null); return; }
    if (alpr.estado === 'cargando') { alpr.cola.push(cb); return; }

    alpr.estado = 'cargando';
    alpr.cola.push(cb);
    var msg = $('#scan-msg');

    function terminar(err) {
      alpr.estado = err ? 'error' : 'listo';
      var pendientes = alpr.cola.slice();
      alpr.cola = [];
      pendientes.forEach(function (f) { f(err || null); });
    }

    function falloModelos(err) {
      console.error('ALPR modelos:', err);
      terminar(new Error('modelos'));
      msg.textContent = 'No se pudieron cargar los modelos';
      toast('No se pudieron cargar los modelos de lectura', true);
      notaScan('Los pesos del detector y del lector viven en la carpeta models/ junto a app.js: serví la app con un servidor local (ej. “py -m http.server”) para que se carguen. Mientras tanto, usá la lectura manual.');
    }

    function pasoDetector(ort) {
      descargarModelo(ALPR.detURLs, function (err, datos) {
        if (err) { falloModelos(err); return; }
        msg.textContent = 'Compilando el detector (red neuronal)…';
        crearSesion(ort, datos,
          { tipo: 'float32', dims: [1, 3, ALPR.detIn, ALPR.detIn], n: 3 * ALPR.detIn * ALPR.detIn },
          function (err2, det) {
            if (err2) { falloModelos(err2); return; }
            pasoLector(ort, det);
          });
      }, function (p) {
        if (p < 1) msg.textContent = 'Descargando detector de chapas… ' + Math.round(p * 100) + '%';
      });
    }

    function pasoLector(ort, det) {
      descargarModelo(ALPR.reURLs, function (err, datos) {
        if (err) { falloModelos(err); return; }
        msg.textContent = 'Compilando el lector de caracteres…';
        crearSesion(ort, datos,
          { tipo: 'uint8', dims: [1, ALPR.lectorAl, ALPR.lectorAn, 1], n: ALPR.lectorAl * ALPR.lectorAn },
          function (err2, red) {
            if (err2) { falloModelos(err2); return; }
            alpr.rt = { ort: ort, det: det, red: red };
            terminar(null);
          });
      }, function (p) {
        if (p < 1) msg.textContent = 'Descargando lector de patentes… ' + Math.round(p * 100) + '%';
      });
    }

    msg.textContent = 'Iniciando el motor neuronal…';
    cargarOrtScript(function (err) {
      if (err) { terminar(err); return; }
      pasoDetector(window.ort);
    });
  }

  /* ==========================================================
     16. Tensores de entrada (canvas → datos numéricos)
     · Detector: letterbox a 640×640 (gris replicado en RGB, /255,
       float32 CHW). Devuelve la escala y el offset para mapear
       las cajas de vuelta a píxeles de la imagen original.
     · Lector: recorte estirado a 140×70 en uint8 gris NHWC, tal
       como espera arg_cnn_ocr (la normalización vive adentro del
       modelo). El binarizado con Otsu se eliminó: las redes
       convolucionales rinden mejor con la luz natural.
     ========================================================== */
  function prepararTensorDetector(ort, src) {
    var S = ALPR.detIn;
    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, S, S);

    var escala = Math.min(S / src.width, S / src.height);
    var dibW = src.width * escala, dibH = src.height * escala;
    var offX = (S - dibW) / 2, offY = (S - dibH) / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, offX, offY, dibW, dibH);

    var im = ctx.getImageData(0, 0, S, S);
    var px = im.data;
    var N = S * S;
    var arr = new Float32Array(3 * N);
    for (var i = 0; i < N; i++) {
      var v = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
      arr[i] = v; arr[N + i] = v; arr[2 * N + i] = v;
    }
    return {
      tensor: new ort.Tensor('float32', arr, [1, 3, S, S]),
      escala: escala, offX: offX, offY: offY
    };
  }

  function prepararTensorLector(ort, srcCrop) {
    var an = ALPR.lectorAn, al = ALPR.lectorAl;
    var cv = document.createElement('canvas');
    cv.width = an; cv.height = al;
    var ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(srcCrop, 0, 0, an, al);

    var im = ctx.getImageData(0, 0, an, al);
    var px = im.data;
    var u8 = new Uint8Array(an * al);
    for (var i = 0; i < u8.length; i++) {
      u8[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) | 0;
    }
    return new ort.Tensor('uint8', u8, [1, al, an, 1]);
  }

  /* Salida del lector [1, 259] = 7 espacios × 37 clases: argmax por
     espacio y descarte del relleno '_'. */
  function decodificarSalidaLector(t) {
    if (!t || !t.data || !t.dims || t.dims.length !== 2) return '';
    var K = ALPR.alfa.length;
    var texto = '';
    for (var s = 0; s < ALPR.slots; s++) {
      var bi = 0, bv = -Infinity;
      for (var c = 0; c < K && (s * K + c) < t.data.length; c++) {
        var v = t.data[s * K + c];
        if (v > bv) { bv = v; bi = c; }
      }
      texto += ALPR.alfa.charAt(bi);
    }
    return texto.replace(/_/g, '');
  }

  /* ==========================================================
     17. ROI: coordenadas del recuadro del visor en píxeles de cámara.
     Video con object-fit:cover ⇒ la pantalla no mapea 1:1: hay que
     deshacer la escala y el centrado de cover.
     ========================================================== */
  function rectROIEnVideo() {
    var video = $('#scan-video');
    if (!video || !video.parentNode) return null;
    var frame = video.parentNode.querySelector('.scan-frame');
    var vr = video.getBoundingClientRect();
    var fr = frame ? frame.getBoundingClientRect() : null;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !vr.width || !vr.height) return null;

    /* Sin recuadro medible: caja central (proporción del inset 16%) */
    if (!fr || !fr.width || !fr.height) {
      return { sx: vw * 0.16, sy: vh * 0.16, sw: vw * 0.68, sh: vh * 0.68 };
    }

    /* Recuadro en fracción de la pantalla */
    var px1 = (fr.left - vr.left) / vr.width, px2 = (fr.right - vr.left) / vr.width;
    var py1 = (fr.top - vr.top) / vr.height, py2 = (fr.bottom - vr.top) / vr.height;

    var escala = Math.max(vr.width / vw, vr.height / vh);
    var dibW = vw * escala, dibH = vh * escala;
    var offX = (vr.width - dibW) / 2, offY = (vr.height - dibH) / 2;

    var sx = (px1 * vr.width - offX) / escala;
    var sy = (py1 * vr.height - offY) / escala;
    var ex = (px2 * vr.width - offX) / escala;
    var ey = (py2 * vr.height - offY) / escala;

    sx = Math.max(0, Math.min(vw, sx)); sy = Math.max(0, Math.min(vh, sy));
    ex = Math.max(0, Math.min(vw, ex)); ey = Math.max(0, Math.min(vh, ey));
    if (ex - sx < 24 || ey - sy < 16) return null;

    return { sx: sx, sy: sy, sw: ex - sx, sh: ey - sy };
  }

  /* ==========================================================
     18. Capturar y leer: ROI → detector → recorte alineado → lector
       · El YOLOv9-tiny devuelve N candidatas; se quedan las que
         superan el umbral con aspecto de patente y se aplica NMS
         (IoU 0.5) para descartar duplicados del mismo box.
       · La mejor caja (convertida a píxeles del ROI) se recorta con
         margen horizontal. Si el texto leído no da una patente con
         formato, se reintenta una vez recortando la franja superior
         (por si el visor incluyó la banda celeste Mercosur).
       · Sin detección: se lee el centro del ROI, apostando por el
         encuadre manual del usuario (como en el flujo anterior).
       · El texto pasa por extraerPatenteOTexto(): sin formato
         válido se guía al usuario hacia la lectura manual.
     ========================================================== */
  function iouBox(a, b) {
    var aL = a.cx - a.w / 2, aT = a.cy - a.h / 2, aR = a.cx + a.w / 2, aB = a.cy + a.h / 2;
    var bL = b.cx - b.w / 2, bT = b.cy - b.h / 2, bR = b.cx + b.w / 2, bB = b.cy + b.h / 2;
    var x = Math.min(aR, bR) - Math.max(aL, bL);
    var y = Math.min(aB, bB) - Math.max(aT, bT);
    if (x <= 0 || y <= 0) return 0;
    var inter = x * y;
    return inter / (a.w * a.h + b.w * b.h - inter);
  }

  /* Corre el detector sobre la imagen ROI y devuelve la mejor caja
     en píxeles de esa imagen: { sx, sy, sw, sh } (o null). */
  function detectarChapa(rt, src, cb) {
    var pre = prepararTensorDetector(rt.ort, src);
    var feeds = {};
    feeds[rt.det.inputNames[0]] = pre.tensor;

    rt.det.run(feeds).then(function (sal) {
      var t = sal[rt.det.outputNames[0]];
      if (!t || !t.data || !t.dims || t.dims.length !== 3) { cb(null, null); return; }

      /* [1,5,N] es el layout verificado de yolo-v9-t-640 (formato
         Ultralytics); también se cubre el invertido [1,N,5]. */
      var horizontal = t.dims[1] === 5;
      var C = horizontal ? 5 : t.dims[1];
      var N = horizontal ? t.dims[2] : t.dims[1];
      if (C !== 5) { cb(null, null); return; }

      var cands = [];
      for (var j = 0; j < N; j++) {
        var s = horizontal ? t.data[4 * N + j] : t.data[j * 5 + 4];
        if (s < ALPR.umbralBox) continue;
        var cx = horizontal ? t.data[0 * N + j] : t.data[j * 5];
        var cy = horizontal ? t.data[1 * N + j] : t.data[j * 5 + 1];
        var w = horizontal ? t.data[2 * N + j] : t.data[j * 5 + 2];
        var h = horizontal ? t.data[3 * N + j] : t.data[j * 5 + 3];
        if (h < 8 || w < 14) continue;
        var ar = w / h;
        if (ar < ALPR.arMin || ar > ALPR.arMax) continue;
        cands.push({ cx: cx, cy: cy, w: w, h: h, s: s });
      }
      cands.sort(function (a, b) { return b.s - a.s; });

      /* NMS greedy: descarta solapes > 50% entre aceptadas */
      var elegidas = [];
      for (var k = 0; k < cands.length && elegidas.length < 4; k++) {
        var c2 = cands[k], ok = true;
        for (var m = 0; m < elegidas.length; m++) {
          if (iouBox(c2, elegidas[m]) > 0.5) { ok = false; break; }
        }
        if (ok) elegidas.push(c2);
      }

      if (!elegidas.length) { cb(null, null); return; }

      /* De píxeles del letterbox 640×640 a píxeles de la imagen ROI */
      var bb = elegidas[0];
      var sx = (bb.cx - bb.w / 2 - pre.offX) / pre.escala;
      var sy = (bb.cy - bb.h / 2 - pre.offY) / pre.escala;
      var sw = bb.w / pre.escala;
      var sh = bb.h / pre.escala;
      sx = Math.max(0, sx); sy = Math.max(0, sy);
      sw = Math.min(src.width - sx, sw); sh = Math.min(src.height - sy, sh);
      if (sw < 14 || sh < 8) { cb(null, null); return; }

      cb(null, { sx: sx, sy: sy, sw: sw, sh: sh, s: bb.s });
    }).catch(function (e) { cb(e, null); });
  }

  /* Recorta la caja con margen horizontal; corteTop descarta la
     franja superior (banda celeste Mercosur) del recorte. */
  function recortarCaja(src, caja, corteTop) {
    var pad = 0.05;
    var sx = Math.max(0, caja.sx - caja.sw * pad);
    var sy = Math.max(0, caja.sy + caja.sh * corteTop - caja.sh * pad);
    var sw = Math.min(src.width - sx, caja.sw * (1 + 2 * pad));
    var sh = Math.min(src.height - sy, caja.sh * (1 - corteTop + pad));
    if (sw < 10 || sh < 6) return null;

    var cv = document.createElement('canvas');
    cv.width = Math.round(sw); cv.height = Math.round(sh);
    cv.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    return cv;
  }

  /* Sin detección: caja central del ROI (~73% del área) */
  function cajaCentrada(src) {
    return {
      sx: src.width * 0.135, sy: src.height * 0.240,
      sw: src.width * 0.730, sh: src.height * 0.520
    };
  }

  /* Vuelco post-OCR: la lectura NUNCA dispara la búsqueda sola. Queda
     en #scan-manual para que el operador revise y corrija cualquier
     carácter confundido (B/8, S/5, D/0…) y confirme con "Usar" o Enter,
     que re-evalúa la búsqueda sobre la base local. */
  function volcarLectura(txt, dudosa) {
    var v = String(txt || '').trim().toUpperCase();
    var msg = $('#scan-msg');
    var inp = $('#scan-manual');
    msg.textContent = dudosa
      ? 'Lectura dudosa: revisá o corregí el texto'
      : 'Chapa leída — revisá y confirmá con "Usar"';
    inp.value = v;
    notaScan('El texto del lector se volcó en el campo de abajo. Si algún carácter viene mal (B/8, S/5, D/0…), corregilo y presioná "Usar" para buscar.');
    if (window.innerWidth > 720) { inp.focus(); if (inp.select) inp.select(); }
    if (dudosa) toast('No se pudo confirmar el formato de la chapa; revisá la lectura.', true);
  }

  function capturarYLeer() {
    var video = $('#scan-video');
    var msg = $('#scan-msg');

    if (!stream || !video || video.readyState < 2) {
      toast('La cámara no está activa: abrí el escáner de nuevo.', true);
      return;
    }

    /* Cada lectura tiene un turno: si el usuario cierra el modal a
       mitad de camino, el resultado tardío se descarta. */
    ocrSeq++;
    var turno = ocrSeq;

    /* ROI: sólo los píxeles del recuadro del visor */
    var vw = video.videoWidth || 640, vh = video.videoHeight || 480;
    var roi = rectROIEnVideo() || { sx: vw * 0.16, sy: vh * 0.16, sw: vw * 0.68, sh: vh * 0.68 };

    var canvas = document.createElement('canvas');
    canvas.width = Math.min(1600, Math.round(roi.sw));
    canvas.height = Math.round(roi.sh * (canvas.width / roi.sw));
    canvas.getContext('2d').drawImage(
      video,
      roi.sx, roi.sy, roi.sw, roi.sh,
      0, 0, canvas.width, canvas.height
    );

    msg.textContent = 'Preparando el motor neuronal…';

    cargarALPR(function (err) {
      if (turno !== ocrSeq) return;
      if (err) {
        msg.textContent = 'No se pudo cargar el motor';
        $('#scan-manual').focus();
        return;
      }
      var rt = alpr.rt;

      function leerCaja(caja, corteTop) {
        var crop = recortarCaja(canvas, caja, corteTop);
        if (!crop) { fallaLectura(); return; }

        var tIn = prepararTensorLector(rt.ort, crop);
        var feedsL = {};
        feedsL[rt.red.inputNames[0]] = tIn;
        rt.red.run(feedsL).then(function (sal) {
          if (turno !== ocrSeq) return;
          var tt = sal[rt.red.outputNames[0]];
          var bruto = decodificarSalidaLector(tt);
          var dato = extraerPatenteOTexto(bruto);

          /* Formato válido: se vuelca en el campo manual para revisión;
             el usuario confirma con "Usar" (re-evalúa la búsqueda). */
          if (dato) { volcarLectura(dato, false); return; }

          /* Sin patrón: segundo recorte sin la banda superior */
          if (corteTop < ALPR.corteBanda) { leerCaja(caja, ALPR.corteBanda); return; }

          /* El lector vio algo legible pero sin formato: se ofrece igual
             para que el operador corrija los caracteres equivocados. */
          if (bruto && bruto.length >= 4) { volcarLectura(bruto, true); return; }

          fallaLectura();
        }).catch(function (e) {
          if (turno !== ocrSeq) return;
          console.error('ALPR lector:', e);
          fallaLectura();
        });
      }

      function fallaLectura() {
        msg.textContent = 'Lectura poco clara';
        notaScan('No se detectó una patente legible. Acercá el celular a la chapa, encuadrá el recuadro sin reflejos y pulsá "Capturar y leer" de nuevo; o usá la lectura manual.');
        toast('No se pudo leer la chapa. Acercate más o usá la lectura manual.', true);
      }

      detectarChapa(rt, canvas, function (err2, cajaDet) {
        if (turno !== ocrSeq) return;
        if (err2) {
          console.error('ALPR detector:', err2);
          msg.textContent = 'Error al localizar la chapa';
          notaScan('La detección falló. Probá de nuevo o ingresá la patente manualmente.');
          toast('Error al localizar la chapa en la imagen.', true);
          $('#scan-manual').focus();
          return;
        }

        var caja = cajaDet || cajaCentrada(canvas);
        msg.textContent = cajaDet ? 'Leyendo la patente…' : 'Sin chapa clara al frente: probando el centro del visor…';
        leerCaja(caja, 0);
      });
    });
  }

  /* Lectura usada (detector o manual): cierra, vuelca en #q y busca */
  function usarLectura(val) {
    var v = String(val || '').trim();
    cerrarModal();
    if (!v) { toast('No se detectó ningún dato legible', true); return; }
    $('#q').value = v.toUpperCase();
    buscar(v, estado.tipo);
  }

  /* ==========================================================
     19. Tema claro / oscuro / automático
     Contrato con el CSS:
       data-theme="light"  → forzar claro
       data-theme="dark"   → forzar oscuro (independiente del OS)
       data-theme="auto"   → decide el sistema (prefers-color-scheme)
     El <head> ya aplicó el valor guardado; aquí se mantiene sincronizado.
     ========================================================== */
  function leyendoSistemaOscuro() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
    catch (e) { return false; }
  }

  function aplicarTema(modo) {
    if (modo !== 'light' && modo !== 'dark' && modo !== 'auto') modo = 'light';
    estado.tema = modo;
    document.documentElement.setAttribute('data-theme', modo);
    try { localStorage.setItem(TEMA_KEY, modo); } catch (e) {}
    $$('input[name="tema"]').forEach(function (r) { r.checked = (r.value === modo); });
    actualizarBotonTema();
  }

  function actualizarBotonTema() {
    var modo = estado.tema || 'auto';
    var ico = $('#tema-icono');
    if (ico) ico.innerHTML = modo === 'auto' ? ICON.temaAuto : (modo === 'dark' ? ICON.moon : ICON.sun);
    var btn = $('#btn-tema');
    if (btn) {
      var efectivo = modo === 'dark' || (modo === 'auto' && leyendoSistemaOscuro());
      var txt = modo === 'auto'
        ? 'Automático (' + (efectivo ? 'oscuro' : 'claro') + ' según el sistema)'
        : (modo === 'dark' ? 'Oscuro' : 'Claro');
      btn.title = 'Tema: ' + txt;
      btn.setAttribute('aria-label', 'Cambiar tema. Actual: ' + txt);
    }
  }

  function abrirTema() {
    var modo = estado.tema || 'auto';
    $$('input[name="tema"]').forEach(function (r) { r.checked = (r.value === modo); });
    abrirModal('#modal-tema');
  }

  /* Modo "auto": seguir los cambios del sistema en vivo */
  if (window.matchMedia) {
    var mqTema = window.matchMedia('(prefers-color-scheme: dark)');
    var alCambiarSistema = function () { if ((estado.tema || 'auto') === 'auto') actualizarBotonTema(); };
    if (mqTema.addEventListener) mqTema.addEventListener('change', alCambiarSistema);
    else if (mqTema.addListener) mqTema.addListener(alCambiarSistema);
  }

  /* ==========================================================
     20. Delegación de eventos centralizada (data-act)
     ========================================================== */
  var ACCIONES = {
    chip: function (el) {
      estado.tipo = el.dataset.type;
      $$('.chip').forEach(function (c) { c.classList.toggle('active', c.dataset.type === estado.tipo); });
      var q = $('#q').value.trim();
      if (q) buscar(q, null);
      else mostrarTodo(estado.tipo);
    },
    home: function () { irAlInicio(); },
    tema: function () { abrirTema(); },
    /* Botón [+ Nuevo]: despliega el menú rápido (cliente / vehículo).
       Todo otro clic lo cierra: resto de acciones, clic suelto o Escape. */
    'nuevo-registro': function () {
      var menu = $('#nuevo-menu');
      if (menu) menu.hidden = !menu.hidden;
    },
    'menu-nuevo-cliente': function () { cerrarMenuNuevo(); abrirClienteModal(); },
    'menu-nuevo-vehiculo': function () { cerrarMenuNuevo(); abrirVehiculoModal(null); },
    /* Sesión (Fase 2): pestañas, login dual, registro, restablecer,
       perfil y cierre de sesión */
    'login-tab': function (el) { mostrarPanelLogin(el.dataset.tab || 'ingresar'); },
    'login-tab-volver': function () { mostrarPanelLogin('ingresar'); },
    'login-pass': function (el) { loginCorreo(el); },
    'login-por-otp': function () { verPasoIngresar('tel'); },
    'login-por-email': function () { verPasoIngresar('email'); },
    'login-olvide': function () { mostrarPanelLogin('reset'); },
    'login-enviar': function (el) { loginEnviar(el); },
    'login-verificar': function (el) { loginVerificar(el); },
    'login-cambiar-numero': function () { volverPaso1(); },
    registrar: function (el) { registrar(el); },
    'reset-otp-enviar': function (el) { resetEnviarOtp(el); },
    'reset-confirmar': function (el) { resetConfirmarOtp(el); },
    'reset-email-enviar': function (el) { resetEnviarEmail(el); },
    'reset-confirmar-token': function (el) { resetConfirmarToken(el); },
    perfil: function () { abrirPerfil(); },
    'guardar-perfil': function (el) { guardarPerfil(el); },
    /* Fase 3: enlace de cambio de contraseña (perfil) y confirmación
       en la vista raíz #vista-reset-password */
    'pedir-reset-email': function (el) { pedirResetEmail(el); },
    'actualizar-password': function (el) { actualizarPasswordFinal(el); },
    'rp-volver-login': function () {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      mostrarLogin();
    },
    logout: function () { cerrarSesion(); },
    scan: function () { abrirEscaner(); },
    capturar: function () { capturarYLeer(); },
    'usar-manual': function () {
      var v = $('#scan-manual').value.trim();
      if (!v) { toast('Escribí una patente para buscar', true); return; }
      usarLectura(v);
    },
    /* Orden de trabajo: por tarjeta (data-vehiculo, preselección forzada)
       o genérica desde el cliente (data-cliente). */
    'nueva-ot': function (el) { abrirOT(el.dataset.vehiculo || null, el.dataset.cliente || null); },
    'add-repuesto': function () { agregarRepuesto(); calcularTotal(); },
    'del-repuesto': function (el) {
      var row = el.closest('.rep-row');
      if (row) row.remove();
      calcularTotal();
    },
    'guardar-ot': function (el) { guardarOT(el); },
    /* Editar una orden del historial: abre el mismo modal precargado */
    'editar-ot': function (el) { cerrarMenuNuevo(); abrirEdicionOT(el.dataset.id); },
    /* Alta de vehículo: desde la ficha (data-cliente) o desde la pantalla
       de sin resultados del buscador/escáner (data-patente: la consulta
       que no arrojó coincidencia, precargada para no perderla). */
    'nuevo-vehiculo': function (el) { abrirVehiculoModal(el.dataset.cliente || null, el.dataset.patente || null); },
    'nuevo-cliente': function (el) { abrirClienteModal(el.dataset.dni || null); },
    'guardar-vehiculo': function (el) { guardarVehiculo(el); },
    transferir: function (el) { abrirTransfer(el.dataset.vehiculo, el.dataset.sinTitular === '1'); },
    'guardar-transfer': function (el) { guardarTransfer(el); },
    'guardar-cliente': function (el) { guardarCliente(el); },
    'sin-titular': async function () {
      var vs;
      try { vs = await traerVehiculos(); }
      catch (e) { return; }   /* toast del error ya mostrado */
      vs = vs.filter(function (v) { return !v.clienteId && v.estado !== 'historico'; })
        .sort(function (a, b) { return String(a.patente).localeCompare(String(b.patente)); });
      if (!vs.length) { toast('No hay vehículos sin titular'); return; }
      renderLista('vehiculos', vs, 'Vehículos sin titular (propietario desconocido)');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    'ver-cliente': function (el) { abrirCliente(el.dataset.cliente); },
    'ver-vehiculo': function (el) { abrirVehiculo(el.dataset.vehiculo); },
    'eliminar-registro': function (el) { abrirEliminar(el.dataset.kind, el.dataset.id); },
    'confirmar-eliminar': function (el) { confirmarEliminar(el); },
    /* Reintentar tras un fallo de carga de ficha (renderErrorCarga) */
    reintentar: function () { refrescar(); },
    'cerrar-modal': function () { cerrarModal(); },
    tab: function (el) {
      estado.tab = el.dataset.tab;
      $$('.tab').forEach(function (t) {
        t.classList.toggle('active', t === el);
        t.setAttribute('aria-selected', t === el);
      });
      $$('.tabpanel').forEach(function (p) { p.classList.toggle('active', p.dataset.panel === estado.tab); });
    }
  };

  function cerrarMenuNuevo() {
    var menu = $('#nuevo-menu');
    if (menu && !menu.hidden) menu.hidden = true;
  }

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!el) {
      if (ev.target.classList && ev.target.classList.contains('backdrop')) cerrarModal();
      else {
        /* Clic suelto: sólo cierra el menú si fue fuera de su contenedor */
        var menu = $('#nuevo-menu');
        if (!(menu && menu.contains(ev.target))) cerrarMenuNuevo();
      }
      return;
    }
    var fn = ACCIONES[el.dataset.act];
    if (fn) {
      if (el.dataset.act !== 'nuevo-registro') cerrarMenuNuevo();
      ev.preventDefault();
      fn(el, ev);
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { if (abierto) cerrarModal(); else cerrarMenuNuevo(); }
  });

  /* Búsqueda al enviar el formulario */
  $('#searchForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    buscar($('#q').value, null);
  });

  /* Ningún form de la app recarga la página con Enter */
  document.addEventListener('submit', function (ev) { ev.preventDefault(); });

  /* Sugerencia visual del tipo detectado mientras se escribe */
  var tipoDetectadoTimer = null;
  $('#q').addEventListener('input', function () {
    var q = $('#q').value.trim();
    if (!q) {
      estado.tipo = 'auto';
      $$('.chip').forEach(function (c) { c.classList.toggle('active', c.dataset.type === 'auto'); });
      return;
    }
    clearTimeout(tipoDetectadoTimer);
    tipoDetectadoTimer = setTimeout(function () {
      if (estado.tipo !== 'auto') return;
      var t = detectarTipo(q);
      if (t === 'auto') return;
      var inp = $('#q');
      inp.placeholder = t === 'dni' ? 'Búsqueda por DNI detectada…' : 'Búsqueda por patente detectada…';
      setTimeout(function () { inp.placeholder = Q_PH_BASE; }, 1600);
    }, 420);
  });

  /* Cálculo de total en vivo (mano de obra + repuestos) */
  $('#ot-mano').addEventListener('input', calcularTotal);
  $('#ot-repuestos').addEventListener('input', calcularTotal);

  /* Enter en la lectura manual del escáner */
  $('#scan-manual').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['usar-manual'](); }
  });

  /* Enter en el login: paso 1 envía el código, paso 2 verifica */
  $('#login-tel').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['login-enviar']($('#login-enviar')); }
  });
  $('#login-otp').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['login-verificar']($('#login-verificar')); }
  });
  /* Enter en "Nombre del taller": también verifica (mismo botón) */
  $('#login-taller').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['login-verificar']($('#login-verificar')); }
  });
  /* Enter en el login por email: dispara el mismo botón Ingresar */
  ['#login-email', '#login-clave'].forEach(function (sel) {
    $(sel).addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['login-pass']($('#login-boton-pass')); }
    });
  });
  /* Enter en el registro y en el restablecimiento */
  ['#reg-tel', '#reg-password', '#reg-nombre', '#reg-apellido'].forEach(function (sel) {
    $(sel).addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['registrar']($('#reg-crear')); }
    });
  });
  ['#reset-otp', '#reset-clave-otp'].forEach(function (sel) {
    $(sel).addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['reset-confirmar']($('#reset-confirmar')); }
    });
  });
  $('#reset-tel').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['reset-otp-enviar']($('#reset-otp-enviar')); }
  });
  $('#reset-email').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['reset-email-enviar']($('#reset-email-enviar')); }
  });
  ['#reset-token', '#reset-clave-token'].forEach(function (sel) {
    $(sel).addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['reset-confirmar-token']($('#reset-confirmar-token')); }
    });
  });

  /* Radios del registro (Email ↔ WhatsApp) y del restablecimiento
     (OTP ↔ token de email): conmutan los campos visibles */
  $$('input[name="reg-modo"]').forEach(function (r) {
    r.addEventListener('change', function () {
      var checked = document.querySelector('input[name="reg-modo"]:checked');
      if (checked) toggleModoRegistro(checked.value);
      validarFormRegistro();   /* el campo requerido cambia: refrescar hints */
    });
  });
  $$('input[name="reset-modo"]').forEach(function (r) {
    r.addEventListener('change', function () {
      var checked = document.querySelector('input[name="reset-modo"]:checked');
      if (checked) elegirResetMetodo(checked.value);
    });
  });

  /* Validación en vivo del registro (Fase 4): cada 'input' en cualquier
     campo obligatorio refresca hints + estado del botón Crear */
  ['#reg-password', '#reg-password-confirm', '#reg-nombre', '#reg-apellido',
   '#reg-email', '#reg-tel'].forEach(function (sel) {
    $(sel).addEventListener('input', validarFormRegistro);
  });

  /* Fase 4: los inputs de teléfono aceptan SOLO dígitos (máx. 10) — corrige
     pegado de texto con signos; y al cambiar el método de contacto también
     se refresca la validación (el campo requerido cambia). */
  ['#login-tel', '#reg-tel', '#reset-tel', '#pf-tel'].forEach(function (sel) {
    var inp = $(sel);
    if (!inp) return;
    inp.addEventListener('input', function () {
      var limpio = limpiarTelefonoLocal(inp.value);
      if (limpio !== inp.value) inp.value = limpio;
    });
  });
  ['#reset-new-password', '#reset-new-password-confirm'].forEach(function (sel) {
    $(sel).addEventListener('input', validarClaveResetVR);
  });

  /* Enter en los formularios nuevos (Fase 3) */
  ['#reg-password', '#reg-password-confirm'].forEach(function (sel) {
    $(sel).addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['registrar']($('#reg-crear')); }
    });
  });
  ['#reset-new-password', '#reset-new-password-confirm'].forEach(function (sel) {
    $(sel).addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); ACCIONES['actualizar-password']($('#btn-actualizar-contrasena')); }
    });
  });

  /* Ojo de visibilidad (Fase 3): UN solo listener delegado para TODOS
     los .btn-toggle-password (registro, login, reset y vista raíz).
     Alterna type password↔text e intercambia el ícono. */
  var SVG_OJO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  var SVG_OJO_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  document.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('.btn-toggle-password') : null;
    if (!btn) return;
    var campo = $('#' + btn.dataset.target);
    if (!campo) return;
    var mostrar = campo.type === 'password';
    campo.type = mostrar ? 'text' : 'password';
    btn.innerHTML = mostrar ? SVG_OJO_OFF : SVG_OJO;
    btn.classList.toggle('activo', mostrar);
    btn.setAttribute('aria-label', mostrar ? 'Ocultar contraseña' : 'Mostrar contraseña');
    campo.focus();
  });

  /* Switch "Propietario desconocido" vs. datos del nuevo titular */
  $('#tr-sin-titular').addEventListener('change', alternarDatosTitular);

  /* Modo de propietario en el alta de vehículo: cambia los visibles */
  $$('input[name="v-modo"]').forEach(function (r) {
    r.addEventListener('change', cambiarModoPropietario);
  });

  /* Autocompletar la ficha de un cliente conocido en la transferencia
     (consulta puntual a la API: exacto por DNI normalizado) */
  $('#tr-dni').addEventListener('blur', function () {
    var dni = norm($('#tr-dni').value);
    if (!dni) return;
    api('/clientes?dni=' + encodeURIComponent(dni)).then(function (r) {
      if (r && r.length) {
        $('#tr-nombre').value = r[0].nombre;
        if (r[0].telefono) $('#tr-tel').value = r[0].telefono;
        toast('Cliente encontrado: se reutilizará su ficha');
      }
    }).catch(function () { /* sin conexión: queda la carga manual */ });
  });

  /* Elección de tema (se aplica al instante y se persiste) */
  $$('input[name="tema"]').forEach(function (r) {
    r.addEventListener('change', function () { if (r.checked) aplicarTema(r.value); });
  });

  /* ==========================================================
     21. Sesión, login dual y perfil (Fase 2 de autenticación)
     Pantalla de bienvenida con pestañas [Ingresar] / [Registrarse]:
     · Ingreso por email + contraseña (contador de intentos; a los 3
       la vista salta sola a restablecer contraseña).
     · Ingreso por WhatsApp + OTP (dos pasos, Fase 1, sigue vivo).
     · Registro: Email+Contraseña o WhatsApp(OTP)+Contraseña.
     · Recuperación: OTP al WhatsApp (si la cuota mensual lo permite)
       o token al email (mock: consola del server).
     · Modal Perfil: vincular email/teléfono; banner si la cuenta es
       OTP-only (sin email no hay recuperación por token).
     ========================================================== */
  var telefonoLogin = '';        /* teléfono en juego entre paso 1 y paso 2 */
  var registroPorOtp = false;    /* el paso 2 cierra un REGISTRO (no un ingreso) */
  var claveRegistro = '';        /* contraseña del registro por OTP (paso 2) */

  /* Mínimo de contraseña del FRONT (validación en vivo). Coincide con
     PASSWORD_MIN del backend (routes/auth.js): 6. */
  var PASSWORD_MIN_FRONT = 6;

  /* ---------------------------------------------------------------
     apiCrudo: fetch del endpoint tal cual devuelve { status, cuerpo }
     SIN toasts ni excepciones — para pantallas de login/registro que
     pintan el mensaje del servidor EN LÍNEA (contador de intentos,
     cuota 429, forceReset 403). apiFetch sigue siendo el camino feliz
     del resto de la app.
     --------------------------------------------------------------- */
  async function apiCrudo(endpoint, options) {
    var opts = options || {};
    var init = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store'
    };
    var token = tokenSesion();
    if (token) init.headers.Authorization = 'Bearer ' + token;
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    try {
      var respuesta = await fetch(API_BASE + endpoint, init);
      var texto = await respuesta.text();
      var cuerpo = null;
      try { cuerpo = texto ? JSON.parse(texto) : null; } catch (e) { cuerpo = null; }
      return { status: respuesta.status, cuerpo: cuerpo };
    } catch (e) {
      var msgRed = 'No hay conexión con la API (' + API_BASE + '). ¿Está levantado el servidor?';
      return { status: 0, cuerpo: { error: { mensaje: msgRed } } };
    }
  }

  function setEstado(mensaje, esError) {
    var est = $('#login-estado');
    if (!est) return;
    est.textContent = mensaje || '';
    est.classList.toggle('err', !!esError);
  }

  /* Vista raíz LOGIN: única visible hasta verificar el OTP. La
     conmutación es por clase .activa entre #vista-login y
     #vista-app (modelo de vistas raíz; sin overlays ocultos). */
  function mostrarLogin(mensajeEstado) {
    var login = $('#vista-login');
    var app = $('#vista-app');
    var rp = $('#vista-reset-password');
    if (login) login.classList.add('activa');
    if (app) app.classList.remove('activa');
    if (rp) rp.classList.remove('activa');
    registroPorOtp = false;
    claveRegistro = '';
    mostrarPanelLogin('ingresar', null);
    /* Logout / vencimiento: formularios limpios (también los otros paneles,
       para que nada quede precargado entre sesiones de la misma máquina) */
    ['login-email', 'login-clave', 'login-tel', 'login-otp', 'login-taller',
     'reg-taller', 'reg-email', 'reg-tel', 'reg-password', 'reg-password-confirm',
     'reg-nombre', 'reg-apellido',
     'reset-tel', 'reset-otp', 'reset-clave-otp',
     'reset-email', 'reset-token', 'reset-clave-token'].forEach(function (id) {
      var campo = $('#' + id);
      if (campo) campo.value = '';
    });
    validarFormRegistro();      /* resetea hints + estado del botón Crear */
    var rEmail = $('#reg-modo-email');
    if (rEmail) rEmail.checked = true;
    toggleModoRegistro('email');
    var rOtpReset = $('#reset-modo-otp');
    if (rOtpReset) rOtpReset.checked = true;
    elegirResetMetodo('otp');
    setEstado(mensajeEstado || '');
    var tel = $('#login-email') || $('#login-tel');
    if (tel) tel.focus();
  }

  /* VISTA RAÍZ APP: activa el dashboard del taller (sesión válida) */
  function mostrarApp() {
    var login = $('#vista-login');
    var app = $('#vista-app');
    var rp = $('#vista-reset-password');
    if (app) app.classList.add('activa');
    if (login) login.classList.remove('activa');
    if (rp) rp.classList.remove('activa');
  }

  /* Topbar: nombre del taller logueado + banner de perfil incompleto
     (cuentas OTP-only: sin email la recuperación por token no existe) */
  function mostrarSesionUI() {
    var u = usuarioSesion();
    var pill = $('#sesion-taller');
    if (pill) pill.textContent = u && u.nombreTaller ? u.nombreTaller : '';
    var banner = $('#banner-perfil');
    if (banner) banner.hidden = !(u && !u.email);
  }

  /* ---------------------------------------------------------------
     Pestañas del login: [Ingresar] / [Registrarse] / [Restablecer
     contraseña] (panel de recuperación: lo abren el enlace
     "¿Olvidaste tu contraseña?" y el bloqueo por intentos). Cada
     panel se muestra/oculta por hidden.
     --------------------------------------------------------------- */
  function mostrarPanelLogin(panel, mensajeEstado) {
    $$('.login-tab').forEach(function (t) {
      var on = t.dataset.tab === panel;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on);
    });
    var pIngresar = $('#login-panel-ingresar');
    var pRegistrar = $('#login-panel-registrarse');
    var pReset = $('#login-panel-reset');
    if (pIngresar) pIngresar.hidden = panel !== 'ingresar';
    if (pRegistrar) pRegistrar.hidden = panel !== 'registrarse';
    if (pReset) pReset.hidden = panel !== 'reset';
    /* El panel Ingresar siempre arranca de cero (camino email) */
    if (panel === 'ingresar') verPasoIngresar('email');
    setEstado(mensajeEstado || '');
    var foco = panel === 'ingresar' ? $('#login-email')
             : panel === 'registrarse' ? $('#reg-taller')
             : $('#reset-tel');
    if (foco) foco.focus();
  }

  /* Alternar caminos dentro de Ingresar: email+contraseña ↔ WhatsApp OTP */
  function verPasoIngresar(cual) {
    var pe = $('#login-paso-email');
    var p1 = $('#login-paso1');
    var p2 = $('#login-paso2');
    if (pe) pe.hidden = cual !== 'email';
    if (p1) p1.hidden = cual === 'email';
    if (p2) p2.hidden = true;
    var foco = cual === 'email' ? $('#login-email') : $('#login-tel');
    if (foco) foco.focus();
  }

  /* Radios del registro: cambia los campos email ↔ teléfono */
  function toggleModoRegistro(modo) {
    var esEmail = modo !== 'telefono';
    var ce = $('#reg-campo-email');
    var ct = $('#reg-campo-telefono');
    if (ce) ce.hidden = !esEmail;
    if (ct) ct.hidden = esEmail;
  }

  /* Radios del reset: OTP al WhatsApp ↔ token al email */
  function elegirResetMetodo(modo) {
    var rO = $('#reset-modo-otp'), rT = $('#reset-modo-token');
    if (rO) rO.checked = modo === 'otp';
    if (rT) rT.checked = modo === 'token';
    var co = $('#reset-campos-otp');
    var ct = $('#reset-campos-token');
    if (co) co.hidden = modo !== 'otp';
    if (ct) ct.hidden = modo !== 'token';
  }

  /* ------------------------------------------------------------------
     INGRESO email + contraseña (login con contador de intentos)
     El cuerpo del error viaja EN LÍNEA a #login-estado: "Credenciales
     incorrectas. Intentos restantes: 2". Con forceReset (3ª falla) la
     vista conmuta ella sola a Restablecer (por email si hay uno
     precargado; el modo OTP queda para la cuenta que tiene solo tel).
     ------------------------------------------------------------------ */
  async function loginCorreo(btn) {
    var email = String($('#login-email').value || '').trim();
    var clave = String($('#login-clave').value || '');
    if (!email || !clave) { setEstado('Completá email y contraseña', true); return; }
    await conEnvio(btn, async function () {
      var r = await apiCrudo('/auth/login', {
        method: 'POST', body: { email: email, password: clave }
      });

      if (r.status === 200 && r.cuerpo && r.cuerpo.token) {
        guardarSesion(r.cuerpo.token, r.cuerpo.usuario || null);
        mostrarSesionUI();
        mostrarApp();
        console.info('[auth] Token guardado y sesión iniciada');
        var nombre = r.cuerpo.usuario && r.cuerpo.usuario.nombreTaller;
        toast('Ingresaste al taller' + (nombre ? ' — ' + nombre : ''));
        arrancarDatos();
        return;
      }

      /* 3ª contraseña errónea: bloqueo → conmutación automática a reset */
      if (r.status === 403 && r.cuerpo && r.cuerpo.forceReset) {
        var msj = r.cuerpo.error && r.cuerpo.error.mensaje
          ? r.cuerpo.error.mensaje
          : 'Demasiados intentos fallidos. Debes restablecer tu contraseña.';
        mostrarPanelLogin('reset', msj);
        /* Con el email que ya había escrito es natural hacer el reseteo
           vía token al email; el modo OTP queda a mano en los radios. */
        var campoEmail = $('#reset-email');
        if (campoEmail && email) campoEmail.value = email;
        elegirResetMetodo(email ? 'token' : 'otp');
        return;
      }

      var msg = (r.cuerpo && r.cuerpo.error && r.cuerpo.error.mensaje) || ('Error HTTP ' + r.status);
      setEstado(msg, true);
    });
  }

  /* Paso 1 (WhatsApp OTP) → pedir código. ConEnvio desactiva el botón. */
  async function loginEnviar(btn) {
    /* Teléfono AR (Fase 4): 10 dígitos locales → el API recibe 549 + dígitos */
    var tel = normalizarTelefonoArg($('#login-tel').value);
    if (!tel) {
      toast('Número inválido: necesitamos 10 dígitos con código de área, sin el 0 y sin el 15 (ej: 1123456789)', true);
      return;
    }
    telefonoLogin = tel;
    var ok = await conEnvio(btn, async function () {
      var r = await apiCrudo('/auth/request-otp', { method: 'POST', body: { telefono: tel } });
      if (r.status === 200) {
        setEstado(r.cuerpo && r.cuerpo.dev && r.cuerpo.dev.otp
          ? 'Código ' + r.cuerpo.dev.otp + ' — (visible sólo porque el backend está en desarrollo)'
          : 'Código enviado: revisá tu chat de WhatsApp.');
        return;
      }
      /* Cuota mensual agotada y demás 429/400: mensaje del server en línea */
      var msg = (r.cuerpo && r.cuerpo.error && r.cuerpo.error.mensaje) || ('Error HTTP ' + r.status);
      setEstado(msg, true);
      throw new Error(msg);
    });
    if (!ok) return;               /* el estado en línea ya avisó */
    $('#login-paso1').hidden = true;
    $('#login-paso2').hidden = false;
    $('#login-fila-taller').hidden = registroPorOtp;
    $('#login-otp').focus();
  }

  /* Paso 2 → verificar OTP: sirve para INGRESAR por WhatsApp y para CERRAR
     el registro por teléfono (con la contraseña elegida en Registrarse). */
  async function loginVerificar(btn) {
    var otp = String($('#login-otp').value || '').replace(/\D/g, '');
    if (otp.length !== 6) { toast('Ingresá el código de 6 dígitos', true); return; }
    var nombreTaller = registroPorOtp
      ? String($('#reg-taller').value || '').trim()
      : String($('#login-taller').value || '').trim();
    var cuerpo = { telefono: telefonoLogin, otp: otp, nombreTaller: nombreTaller };
    if (registroPorOtp) {
      /* El registro por teléfono completa los datos personales al verificar */
      cuerpo.password = claveRegistro;
      cuerpo.nombre = String($('#reg-nombre').value || '').trim();
      cuerpo.apellido = String($('#reg-apellido').value || '').trim();
    }

    var verificado = null;
    var ok = await conEnvio(btn, async function () {
      verificado = await api('/auth/verify-otp', { method: 'POST', body: cuerpo });
    });
    if (!ok || !verificado || !verificado.token) return;
    registroPorOtp = false;
    claveRegistro = '';
    guardarSesion(verificado.token, verificado.usuario || null);
    mostrarSesionUI();
    mostrarApp();
    console.info('[auth] Token guardado y sesión iniciada');
    var nombre = verificado.usuario && verificado.usuario.nombreTaller;
    toast('Ingresaste al taller' + (nombre ? ' — ' + nombre : ''));
    arrancarDatos();
  }

  function volverPaso1() {
    $('#login-paso1').hidden = false;
    $('#login-paso2').hidden = true;
    $('#login-fila-taller').hidden = false;
    setEstado('');
    $('#login-tel').focus();
  }

  /* ------------------------------------------------------------------
     REGISTRO dual: { metodo:'email' } alta inmediata + auto-sesión;
     { metodo:'telefono' } prueba de propiedad con OTP (el paso 2 del
     panel Ingresar hace la verificación con claveRegistro).
     ------------------------------------------------------------------ */
  async function registrar(btn) {
    var radio = document.querySelector('input[name="reg-modo"]:checked');
    var modo = radio ? radio.value : 'email';
    var taller = String($('#reg-taller').value || '').trim();
    var clave = String($('#reg-password').value || '');
    /* Datos personales obligatorios (Fase 4) */
    var nombre = String($('#reg-nombre').value || '').trim();
    var apellido = String($('#reg-apellido').value || '').trim();

    if (!nombre) { setEstado('Ingresá tu nombre', true); return; }
    if (!apellido) { setEstado('Ingresá tu apellido', true); return; }
    if (clave.length < PASSWORD_MIN_FRONT) { setEstado('La contraseña debe tener al menos ' + PASSWORD_MIN_FRONT + ' caracteres', true); return; }

    if (modo === 'email') {
      var email = String($('#reg-email').value || '').trim();
      if (!email) { setEstado('Ingresá el email de la cuenta', true); return; }
      var creado = null;
      var fin = await conEnvio(btn, async function () {
        creado = await api('/auth/register', {
          method: 'POST',
          body: { metodo: 'email', email: email, password: clave,
                  nombre: nombre, apellido: apellido, nombreTaller: taller }
        });
      });
      if (!fin || !creado || !creado.token) return;   /* el toast ya avisó */
      registroPorOtp = false;
      claveRegistro = '';
      guardarSesion(creado.token, creado.usuario || null);
      mostrarSesionUI();
      mostrarApp();
      console.info('[auth] Token guardado y sesión iniciada');
      var nombreT = creado.usuario && creado.usuario.nombreTaller;
      toast('Cuenta creada' + (nombreT ? ' — ' + nombreT : '') + ': ingresaste al taller');
      arrancarDatos();
      return;
    }

    /* Registro por teléfono: 10 dígitos AR (sin repetir) → prefijo 549 */
    var tel = normalizarTelefonoArg($('#reg-tel').value);
    if (!tel) {
      setEstado('Celular inválido: necesitamos 10 dígitos con código de área, sin el 0 y sin el 15 (ej: 1123456789)', true);
      return;
    }
    var resp = null;
    fin = await conEnvio(btn, async function () {
      resp = await api('/auth/register', {
        method: 'POST',
        body: { metodo: 'telefono', telefono: tel, password: clave,
                nombre: nombre, apellido: apellido, nombreTaller: taller }
      });
    });
    if (!fin || !resp || !resp.necesitaVerificacion) return;
    registroPorOtp = true;
    claveRegistro = clave;
    telefonoLogin = tel;
    mostrarPanelLogin('ingresar');            /* el OTP se cierra en su paso 2 */
    $('#login-paso1').hidden = true;
    $('#login-paso2').hidden = false;
    $('#login-fila-taller').hidden = true;    /* el taller ya lo escribió acá */
    setEstado(resp.dev && resp.dev.otp
      ? 'Código ' + resp.dev.otp + ' — (visible sólo porque el backend está en desarrollo)'
      : 'Código enviado: revisá tu chat de WhatsApp (' + tel + ')');
    $('#login-otp').focus();
  }

  /* ------------------------------------------------------------------
     RESTABLECER contraseña: por OTP al WhatsApp (si la cuota del mes lo
     permite) o por token enviado al email (mock → consola del server;
     en desarrollo el token arriba también como dato en línea).
     ------------------------------------------------------------------ */
  async function resetEnviarOtp(btn) {
    var tel = normalizarTelefonoArg($('#reset-tel').value);
    if (!tel) {
      setEstado('Número inválido: necesitamos 10 dígitos con código de área, sin el 0 y sin el 15 (ej: 1123456789)', true);
      return;
    }
    var r = null;
    await conEnvio(btn, async function () {
      r = await apiCrudo('/auth/request-otp', { method: 'POST', body: { telefono: tel } });
      if (r.status === 200) {
        setEstado(r.cuerpo && r.cuerpo.dev && r.cuerpo.dev.otp
          ? 'Código ' + r.cuerpo.dev.otp + ' — (visible sólo porque el backend está en desarrollo)'
          : 'Código enviado: revisá tu chat de WhatsApp.');
        return;
      }
      var msg = (r.cuerpo && r.cuerpo.error && r.cuerpo.error.mensaje) || ('Error HTTP ' + r.status);
      setEstado(msg, true);
      /* 429 por cuota con email registrado: la salida natural es el token */
      if (r.status === 429 && /email/i.test(msg)) {
        var campo = $('#reset-email');
        var u = usuarioSesion();
        if (campo && u && u.email) campo.value = u.email;
        elegirResetMetodo('token');
      }
    });
  }

  async function resetConfirmarOtp(btn) {
    var tel = normalizarTelefonoArg($('#reset-tel').value);
    var otp = String($('#reset-otp').value || '').replace(/\D/g, '');
    var clave = String($('#reset-clave-otp').value || '');
    if (otp.length !== 6) { setEstado('Ingresá el código de 6 dígitos', true); return; }
    if (clave.length < 8) { setEstado('La nueva contraseña debe tener al menos 8 caracteres', true); return; }
    var r = null;
    await conEnvio(btn, async function () {
      r = await apiCrudo('/auth/reset-password', {
        method: 'POST',
        body: { via: 'otp', telefono: tel, otp: otp, password: clave }
      });
      if (r.status === 200) {
        mostrarPanelLogin('ingresar', 'Contraseña restablecida: ingresá con tu nueva contraseña.');
        return;
      }
      setEstado((r.cuerpo && r.cuerpo.error && r.cuerpo.error.mensaje) || ('Error HTTP ' + r.status), true);
    });
  }

  async function resetEnviarEmail(btn) {
    var email = String($('#reset-email').value || '').trim();
    if (!email) { setEstado('Ingresá el email de la cuenta', true); return; }
    var r = null;
    await conEnvio(btn, async function () {
      r = await apiCrudo('/auth/olvide-password', { method: 'POST', body: { email: email } });
      if (r.status === 200) {
        var msg = r.cuerpo && r.cuerpo.mensaje ? r.cuerpo.mensaje : 'Token enviado (si el email está registrado).';
        /* Mock de desarrollo: el token llega por consola del server — y acá */
        if (r.cuerpo && r.cuerpo.dev && r.cuerpo.dev.token) {
          msg += ' Token: ' + r.cuerpo.dev.token;
        }
        setEstado(msg);
        return;
      }
      setEstado((r.cuerpo && r.cuerpo.error && r.cuerpo.error.mensaje) || ('Error HTTP ' + r.status), true);
    });
  }

  async function resetConfirmarToken(btn) {
    var token = String($('#reset-token').value || '').trim();
    var clave = String($('#reset-clave-token').value || '');
    if (!token) { setEstado('Pegá el token que llegó al email', true); return; }
    if (clave.length < 8) { setEstado('La nueva contraseña debe tener al menos 8 caracteres', true); return; }
    var r = null;
    await conEnvio(btn, async function () {
      r = await apiCrudo('/auth/reset-password', {
        method: 'POST',
        body: { via: 'token', token: token, password: clave }
      });
      if (r.status === 200) {
        mostrarPanelLogin('ingresar', 'Contraseña restablecida: ingresá con tu nueva contraseña.');
        return;
      }
      setEstado((r.cuerpo && r.cuerpo.error && r.cuerpo.error.mensaje) || ('Error HTTP ' + r.status), true);
    });
  }

  /* ------------------------------------------------------------------
     PERFIL (modal dentro de la app): precarga desde taller_usuario y
     datos frescos del server. Guardar → PUT /auth/profile; si cambia
     el teléfono la API re-firma el token y se reemplaza.
     ------------------------------------------------------------------ */
  async function abrirPerfil() {
    var u = usuarioSesion() || {};
    /* Fase 4: identidad personal + teléfono en formato local (10 dígitos) */
    $('#pf-nombre').value = u.nombre || '';
    $('#pf-apellido').value = u.apellido || '';
    $('#pf-email').value = u.email || '';
    $('#pf-tel').value = telefonoLocalDesdeGuardado(u.telefono);
    $('#pf-taller').value = u.nombreTaller || '';
    $('#pf-creada').textContent = u.createdAt ? String(u.createdAt).slice(0, 10) : '—';
    $('#pf-cuota').textContent = u.cuotaOtp ? (u.cuotaOtp.usados + '/' + u.cuotaOtp.limite) : '—';
    /* Fase 3: estado del email + línea de reset limpia en cada apertura */
    estadoEmailEnPerfil(u);
    var pfe = $('#pf-reset-estado');
    if (pfe) { pfe.textContent = ''; pfe.classList.remove('err'); }
    abrirModal('#modal-perfil');
    try {
      var fresco = await api('/auth/profile');
      if (fresco && fresco.usuario) {
        var v = fresco.usuario;
        $('#pf-nombre').value = v.nombre || '';
        $('#pf-apellido').value = v.apellido || '';
        $('#pf-email').value = v.email || '';
        $('#pf-tel').value = telefonoLocalDesdeGuardado(v.telefono);
        $('#pf-taller').value = v.nombreTaller || '';
        $('#pf-creada').textContent = v.createdAt ? String(v.createdAt).slice(0, 10) : '—';
        $('#pf-cuota').textContent = v.cuotaOtp ? (v.cuotaOtp.usados + '/' + v.cuotaOtp.limite) : '—';
        /* Datos frescos al localStorage: el banner y la pill no se atrasan */
        guardarSesion(tokenSesion(), v);
        mostrarSesionUI();
        estadoEmailEnPerfil(v);
      }
    } catch (e) { /* 401/Red: ya se notificó; el modal queda editable */ }
  }

  async function guardarPerfil(btn) {
    var datos = {};
    var nombre = String($('#pf-nombre').value || '').trim();
    var apellido = String($('#pf-apellido').value || '').trim();
    var email = String($('#pf-email').value || '').trim();
    var telLocal = limpiarTelefonoLocal($('#pf-tel').value);
    var taller = String($('#pf-taller').value || '').trim();
    if (nombre) datos.nombre = nombre;
    if (apellido) datos.apellido = apellido;
    if (email) datos.email = email;
    /* Fase 4: 10 dígitos válidos → enviamos 549 + dígitos; vacío no toca;
       si tipeó algo incompleto o repetido, lo rechazamos aquí para no
       gastar un PUT que el servidor va a rechazar. */
    if (telLocal) {
      if (!telefonoLocalValido(telLocal)) {
        toast('Celular inválido: 10 dígitos con código de área, sin el 0 y sin el 15 (ej: 1123456789)', true);
        return;
      }
      datos.telefono = '549' + telLocal;
    }
    if (taller) datos.nombreTaller = taller;
    if (!Object.keys(datos).length) { toast('No hay cambios: completá algún dato'); return; }

    var fin = await conEnvio(btn, async function () {
      var r = await api('/auth/profile', { method: 'PUT', body: datos });
      guardarSesion(r && r.token ? r.token : tokenSesion(), (r && r.usuario) || usuarioSesion());
    });
    if (!fin) return;
    cerrarModal();
    mostrarSesionUI();
    toast('Perfil actualizado');
  }

  /* ==================================================================
     FASE 3 · confirmación de contraseña + cambio por enlace de email
     ================================================================== */

  /* ==================================================================
     FASE 4 · teléfono argentino (+54 9): prefijo fijo, 10 dígitos,
     rechazo de dígitos repetidos y normalización para la API.
     ================================================================== */
  var TEL_DIGITOS = 10;
  /* Números tramposos: todos los dígitos iguales (1111111111, 0000000000…) */
  var TEL_REPETIDO_RE = /^(\d)\1{9}$/;
  var EMAIL_RE_FRONT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /* Sólo dígitos, máx. 10 (corre en cada 'input' — recorta pegado tipeado) */
  function limpiarTelefonoLocal(valor) {
    return String(valor || '').replace(/\D/g, '').slice(0, TEL_DIGITOS);
  }

  /* Reglas de validez: exactamente 10 dígitos y NO todos idénticos */
  function telefonoLocalValido(valor) {
    var d = limpiarTelefonoLocal(valor);
    return d.length === TEL_DIGITOS && !TEL_REPETIDO_RE.test(d);
  }

  /* Normalización para la API: concatena el prefijo país+celular.
     ej: 1123456789 → 5491123456789 (el formato que la API guarda). */
  function normalizarTelefonoArg(valor) {
    var d = limpiarTelefonoLocal(valor);
    return d.length === TEL_DIGITOS ? '549' + d : '';
  }

  /* El número guardado por la API viene completo (549XXXXXXXXXX);
     para el input mostramos el local de 10 dígitos si es de ese formato. */
  function telefonoLocalDesdeGuardado(guardado) {
    var t = String(guardado || '');
    if (/^549\d{10}$/.test(t)) return t.slice(3);
    return t.length === TEL_DIGITOS && !TEL_REPETIDO_RE.test(t) ? t : '';
  }

  /* Hint de validación en vivo bajo un campo de contraseña:
     '' → neutro; err → rojo con mensaje; ok → verde "Correcto". */
  function setHint(sel, ok, err) {
    var el = $(sel);
    if (!el) return;
    el.textContent = err ? ('⚠ ' + err) : (ok ? '✓ Correcto' : '');
    el.className = 'pw-hint' + (err ? ' err' : (ok ? ' ok' : ''));
  }

  /* Registro (Fase 4): validación EN VIVO de TODO el formulario —
     nombre/apellido obligatorios, contacto según método (email válido o
     celular AR de 10 dígitos sin repetir), clave ≥ 6 y ambas iguales.
     El botón "Crear cuenta" queda disabled hasta que todo pase. */
  function validarFormRegistro() {
    var a = $('#reg-password'), b = $('#reg-password-confirm');
    var crear = $('#reg-crear');
    if (!a || !b) return;
    var radio = document.querySelector('input[name="reg-modo"]:checked');
    var modo = radio ? radio.value : 'email';
    var esEmail = modo !== 'telefono';

    /* Datos personales obligatorios */
    var okNombre = ($('#reg-nombre').value || '').trim().length >= 1;
    var okApellido = ($('#reg-apellido').value || '').trim().length >= 1;

    /* Claves */
    var clave = a.value;
    var okA = clave.length >= PASSWORD_MIN_FRONT;
    setHint('#reg-password-estado', okA, (!okA && clave.length) ? ('Mínimo ' + PASSWORD_MIN_FRONT + ' caracteres') : '');
    var okB = okA && b.value.length > 0 && b.value === clave;
    setHint('#reg-confirm-estado', okB, (okA && b.value && b.value !== clave) ? 'Las contraseñas no coinciden' : '');

    /* Contacto según el método elegido (con aviso en línea si tipeó algo) */
    var okContacto = false;
    if (esEmail) {
      var email = ($('#reg-email').value || '').trim();
      okContacto = EMAIL_RE_FRONT.test(email);
      setHint('#reg-email-estado', okContacto, (!okContacto && email) ? 'Formato de email inválido' : '');
    } else {
      var telLocal = $('#reg-tel').value;
      okContacto = telefonoLocalValido(telLocal);
      var avisoTel = '';
      if (!okContacto && telLocal.length) {
        avisoTel = TEL_REPETIDO_RE.test(telLocal)
          ? 'El número no puede repetir el mismo dígito (ej: 1111111111)'
          : 'Faltan dígitos: necesitamos exactamente 10';
      }
      setHint('#reg-tel-estado', okContacto, avisoTel);
    }

    if (crear) crear.disabled = !(okNombre && okApellido && okA && okB && okContacto);
  }

  /* Vista raíz #vista-reset-password: misma regla (≥6 + coinciden)
     → habilita #btn-actualizar-contrasena. */
  function validarClaveResetVR() {
    var a = $('#reset-new-password'), b = $('#reset-new-password-confirm');
    var btn = $('#btn-actualizar-contrasena');
    if (!a || !b) return;
    var clave = a.value;
    var okA = clave.length >= PASSWORD_MIN_FRONT;
    setHint('#rp-clave-estado', okA, (!okA && clave.length) ? ('Mínimo ' + PASSWORD_MIN_FRONT + ' caracteres') : '');
    var okB = okA && b.value.length > 0 && b.value === clave;
    setHint('#rp-confirm-estado', okB, (okA && b.value && b.value !== clave) ? 'Las contraseñas no coinciden' : '');
    if (btn) btn.disabled = !(okA && okB);
  }

  /* Perfil: estado del email → badge verde / aviso + habilitación del
     botón "Enviar enlace de cambio de contraseña". Corre al abrir el
     modal y después de cualquier PUT de perfil fresco. */
  function estadoEmailEnPerfil(u) {
    var tiene = Boolean(u && u.email);
    var badge = $('#pf-badge-email');
    var aviso = $('#pf-aviso-email');
    var btn = $('#btn-solicitar-reset');
    if (badge) badge.hidden = !tiene;
    if (aviso) aviso.hidden = tiene;
    if (btn) btn.disabled = !tiene;
  }

  /* Solicitud del ENLACE de cambio (perfil → POST protegido). En
     desarrollo la respuesta trae dev.enlace: se muestra en línea para
     poder probar el flujo sin buzón de correo real. */
  async function pedirResetEmail(btn) {
    var est = $('#pf-reset-estado');
    var fin = await conEnvio(btn, async function () {
      var r = await apiCrudo('/auth/request-password-reset-email', { method: 'POST' });
      if (r.status === 200) {
        var msg = '✅ Enlace enviado a tu email (válido 15 minutos).';
        if (r.cuerpo && r.cuerpo.dev && r.cuerpo.dev.enlace) {
          msg = '✅ (mock dev) Enlace: ' + r.cuerpo.dev.enlace;
        }
        if (est) { est.textContent = msg; est.classList.remove('err'); }
        else toast('Enlace de cambio de contraseña enviado');
        return;
      }
      var msgErr = (r.cuerpo && r.cuerpo.error && r.cuerpo.error.mensaje) || ('Error HTTP ' + r.status);
      if (est) { est.textContent = msgErr; est.classList.add('err'); }
      else toast(msgErr, true);
    });
  }

  /* Token del enlace en juego (lo fija mostrarVistaReset al detectar
     la URL; lo consume actualizarPasswordFinal). */
  var tokenResetActual = '';

  /* VISTA RAÍZ RESET: activa SÓLO #vista-reset-password (el usuario
     llegó por el enlace del email — puede o no tener sesión previa). */
  function mostrarVistaReset(token, mensajeEstado) {
    var login = $('#vista-login');
    var app = $('#vista-app');
    var rp = $('#vista-reset-password');
    if (rp) rp.classList.add('activa');
    if (login) login.classList.remove('activa');
    if (app) app.classList.remove('activa');
    tokenResetActual = token || '';
    ['reset-new-password', 'reset-new-password-confirm'].forEach(function (id) {
      var c = $('#' + id);
      if (c) c.value = '';
    });
    validarClaveResetVR();
    var est = $('#rp-estado');
    if (est) {
      est.textContent = mensajeEstado || '';
      est.classList.toggle('err', Boolean(mensajeEstado));
    }
  }

  /* Detección de la URL del enlace: el hash es #reset-password?token=XYZ
     (también se acepta ?token= en el query con ese hash). Devuelve el
     token o null si la URL no corresponde a la vista reset. */
  function deteccionResetUrl() {
    var hash = location.hash || '';
    if (hash.indexOf('reset-password') === -1) return null;
    var m = /token=([^&]+)/.exec(hash) || /token=([^&]+)/.exec(location.search || '');
    return { token: m ? decodeURIComponent(m[1]) : '' };
  }

  /* Confirmación del cambio desde la vista raíz (POST público con token
     one-shot). Éxito: congela el formulario, toast, limpia la sesión
     (la próxima entrada es con la clave nueva) y a los 2 segundos redirige
     a #vista-login con el hash limpio. */
  async function actualizarPasswordFinal(btn) {
    var a = $('#reset-new-password'), b = $('#reset-new-password-confirm');
    var est = $('#rp-estado');
    if (!tokenResetActual) {
      if (est) { est.textContent = 'Este enlace no trae un token válido: pedí uno nuevo desde tu Perfil.'; est.classList.add('err'); }
      return;
    }
    if ((a.value || '').length < PASSWORD_MIN_FRONT) {
      validarClaveResetVR();
      return;
    }
    if (a.value !== b.value) {
      validarClaveResetVR();
      return;
    }
    var ok = false;
    await conEnvio(btn, async function () {
      var r = await apiCrudo('/auth/confirm-password-reset', {
        method: 'POST',
        body: { token: tokenResetActual, newPassword: a.value }
      });
      ok = r.status === 200;
      if (!ok) {
        var msg = (r.cuerpo && r.cuerpo.error && r.cuerpo.error.mensaje) || ('Error HTTP ' + r.status);
        if (est) { est.textContent = msg; est.classList.add('err'); }
        else toast(msg, true);
      }
    });
    if (!ok) return;

    /* Éxito: formulario desactivado + toast + redirect programado */
    [a, b].forEach(function (c) { c.disabled = true; });
    var btnAct = $('#btn-actualizar-contrasena');
    if (btnAct) btnAct.disabled = true;
    if (est) { est.textContent = '✅ Contraseña actualizada: te llevamos al ingreso…'; est.classList.remove('err'); }
    toast('Contraseña actualizada: ingresá con tu nueva contraseña');
    limpiarSesion();             /* re-login con la contraseña nueva */
    setTimeout(function () {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      mostrarLogin('Contraseña actualizada: ingresá con tu nueva contraseña.');
      [a, b].forEach(function (c) { c.disabled = false; });
      validarClaveResetVR();
    }, 2000);
  }



  /* Salir: borra token+usuario, resetea navegación y datos en memoria y
     vuelve a la pantalla de login */
  function cerrarSesion() {
    limpiarSesion();
    estado.vista = 'inicio';
    estado.clienteId = null;
    estado.vehiculoId = null;
    estado.tab = 'historial';
    estado.ctx = {};
    DATOS.clientes = null;
    DATOS.vehiculos = null;
    DATOS.fichaCliente = null;
    DATOS.fichaVehiculo = null;
    DATOS.ordenes = [];
    cerrarMenuNuevo();
    if (abierto) cerrarModal();
    $('#q').value = '';
    renderInicio();
    mostrarSesionUI();
    mostrarLogin();
  }

  /* Datos + deep-link: corre recién con sesión activa (tras el login o
     al arrancar con un token guardado). */
  function arrancarDatos() {
    (async function () {
      try { await Promise.all([traerClientes(), traerVehiculos()]); }
      catch (e) { /* apiFetch ya notificó una sola vez */ }
    })();
    /* Deep-link simple por hash: #patente o #dni */
    if (location.hash.length > 1) {
      var hashVal = decodeURIComponent(location.hash.slice(1));
      $('#q').value = hashVal;
      buscar(hashVal, null);
    }
  }

  /* ==========================================================
     22. Arranque
     ========================================================== */
  /* Tema: preferencia guardada en este dispositivo (por defecto claro,
     igual que el script anti-parpadeo del <head>) */
  var temaGuardado = 'light';
  try { temaGuardado = localStorage.getItem(TEMA_KEY) || 'light'; } catch (e) {}
  aplicarTema(temaGuardado);

  renderInicio();

  /* Gate de sesión (Fase 1 de auth): sin taller_token la app queda cubierta
     por la pantalla de login; con token guardado arranca directo — si el
     token ya no vale, el primer 401 corta la sesión y muestra el login.
     EXCEPCIÓN (Fase 3): si la URL trae el enlace de reset-password la
     vista #vista-reset-password gana antes que cualquiera de las dos. */
  mostrarSesionUI();
  var detUrl = deteccionResetUrl();
  if (detUrl) {
    mostrarVistaReset(detUrl.token, detUrl.token
      ? ''
      : 'El enlace no trae un token: volvé a pedilo desde tu Perfil una vez dentro.');
  } else if (!tokenSesion()) {
    mostrarLogin();          /* gate: la vista login es la activa hasta verificar */
  } else {
    mostrarApp();            /* sesión guardada: el dashboard es la vista activa; si
                                el token no vale, el primer 401 corta y vuelve al login */
    arrancarDatos();
  }

  /* hashchange (deep-links de la app + llegada del enlace por email):
     el guard limita la reacción al hash de la vista reset — los demás
     hashes (#patente, #dni…) son de búsqueda y no conmutan vistas. */
  window.addEventListener('hashchange', function () {
    if ((location.hash || '').indexOf('reset-password') === -1) return;   /* guard */
    var det = deteccionResetUrl();
    if (det) mostrarVistaReset(det.token, det.token ? '' : 'El enlace no trae un token: pedí uno nuevo desde tu Perfil.');
  });

  /* Estado inicial de la validación en vivo del registro (botón disabled) */
  validarFormRegistro();
  validarClaveResetVR();
})();
