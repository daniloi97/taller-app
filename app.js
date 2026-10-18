/* ============================================================================
   TALLER MECÁNICO · HISTORIA CLÍNICA VEHICULAR
   app.js — lógica completa de la aplicación (Vanilla JS, ES5, sin frameworks)

   · Persistencia local en localStorage (taller_db_v1) con datos semilla.
   · Búsqueda dual automática por patente o DNI en un solo input.
   · Un cliente puede tener VARIOS vehículos activos a la vez; cada tarjeta
     permite crear su propia Orden de Trabajo o ver su ficha. Un vehículo
     pasa a "Histórico" sólo por transferencia o desafiliación, y el dueño
     saliente queda registrado en vehiculo.duenos.
   · Escáner con cámara: recorte ROI del visor, pre-procesado (grises +
     Otsu) y Tesseract.js v5 cargado bajo demanda desde su CDN oficial
     (https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js).
     Sin internet la app sigue funcionando: queda la lectura manual.
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
  var LS_KEY = 'taller_db_v1';
  var TEMA_KEY = 'taller_tema';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function uid(p) { return p + '_' + Math.random().toString(36).slice(2, 9); }

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
  function fecha(iso) {
    if (!iso) return '—';
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    try { return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch (e) { return iso; }
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
     2. Base de datos local: seed + persistencia
     ========================================================== */
  var seed = {
    clientes: [
      { id: 'cli_1', nombre: 'Juan Carlos Pérez', dni: '30123456', telefono: '11 5555-1234', email: 'juan.perez@mail.com', desde: '2019-04-11' },
      { id: 'cli_2', nombre: 'María González', dni: '27876543', telefono: '11 4444-9087', email: 'mgonzalez@mail.com', desde: '2020-09-02' },
      { id: 'cli_3', nombre: 'Roberto Díaz', dni: '20456789', telefono: '351 622-3388', email: '', desde: '2015-02-18' }
    ],
    vehiculos: [
      { id: 'veh_1', patente: 'AB123CD', marca: 'Toyota', modelo: 'Corolla XEI 2.0', anio: 2019, color: 'Gris Plata', km: 128400, clienteId: 'cli_1', estado: 'activo', motor: '2ZR-A118842', duenos: [] },
      { id: 'veh_2', patente: 'LKM447', marca: 'Ford', modelo: 'Fiesta Kinetic', anio: 2011, color: 'Rojo', km: 214000, clienteId: null, estado: 'historico', motor: 'CFN-77120', duenos: [ { nombre: 'Juan Carlos Pérez', dni: '30123456', desde: '2012-03-05', hasta: '2021-11-30' }, { nombre: 'Roberto Díaz', dni: '20456789', desde: '2021-11-30', hasta: '2024-06-14' } ] },
      { id: 'veh_3', patente: 'AD998ZZ', marca: 'Volkswagen', modelo: 'Amarok Highline', anio: 2022, color: 'Negro', km: 46300, clienteId: 'cli_2', estado: 'activo', motor: 'DDX-551230', duenos: [] },
      { id: 'veh_4', patente: 'JUV210', marca: 'Renault', modelo: 'Clio Authentique', anio: 2008, color: 'Azul', km: 268900, clienteId: null, estado: 'historico', motor: 'K4M-990211', duenos: [ { nombre: 'María González', dni: '27876543', desde: '2013-07-22', hasta: '2022-02-09' } ] },
      { id: 'veh_5', patente: 'AE451QW', marca: 'Chevrolet', modelo: 'Onix LTZ', anio: 2023, color: 'Blanco', km: 18900, clienteId: 'cli_1', estado: 'activo', motor: 'LXT-330912', duenos: [] }
    ],
    servicios: [
      { id: 'srv_1', vehiculoId: 'veh_1', fecha: '2026-08-14', km: 126800, manoObra: 150000, tareas: ['Cambio de aceite y filtro', 'Service 20.000 km'], repuestos: [ { nombre: 'Filtro de aceite', cantidad: 1, precio: 42000 }, { nombre: 'Aceite 5W30 (4L)', cantidad: 1, precio: 96000 } ], obs: 'Se recomienda revisar tren delantero en el próximo ingreso.' },
      { id: 'srv_2', vehiculoId: 'veh_1', fecha: '2026-03-02', km: 119300, manoObra: 98000, tareas: ['Cambio de pastillas de freno', 'Rectificado de discos'], repuestos: [ { nombre: 'Pastillas delanteras', cantidad: 1, precio: 135000 }, { nombre: 'Líquido de frenos', cantidad: 1, precio: 28000 } ], obs: '' },
      { id: 'srv_3', vehiculoId: 'veh_1', fecha: '2025-11-19', km: 111000, manoObra: 60000, tareas: ['Alineación y balanceo'], repuestos: [], obs: 'Se corrigió convergencia.' },
      { id: 'srv_4', vehiculoId: 'veh_3', fecha: '2026-06-27', km: 44100, manoObra: 210000, tareas: ['Distribución completa', 'Cambio de aceite y filtro'], repuestos: [ { nombre: 'Kit de distribución', cantidad: 1, precio: 480000 }, { nombre: 'Bomba de agua', cantidad: 1, precio: 175000 } ], obs: 'Cliente autoriza recambio de bomba de agua.' },
      { id: 'srv_5', vehiculoId: 'veh_2', fecha: '2020-05-08', km: 198000, manoObra: 45000, tareas: ['Cambio de embrague'], repuestos: [ { nombre: 'Kit de embrague', cantidad: 1, precio: 168000 } ], obs: 'Vehículo luego transferido.' },
      { id: 'srv_6', vehiculoId: 'veh_5', fecha: '2026-09-05', km: 18200, manoObra: 72000, tareas: ['Cambio de aceite y filtro', 'Revisión general'], repuestos: [ { nombre: 'Filtro de aire', cantidad: 1, precio: 31000 }, { nombre: 'Aceite 0W20 (4L)', cantidad: 1, precio: 118000 } ], obs: '' }
    ]
  };

  var DB = cargar();

  function cargar() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && d.clientes && d.vehiculos && d.servicios) return d;
      }
    } catch (e) { /* modo incógnito / file:// restringido */ }
    return JSON.parse(JSON.stringify(seed));
  }
  function guardar() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); return true; }
    catch (e) { return false; }
  }

  /* ==========================================================
     3. Accesores y reglas de negocio
     ========================================================== */
  function clientePorId(id) { return DB.clientes.filter(function (c) { return c.id === id; })[0] || null; }
  function clientePorDni(dni) { var d = norm(dni); return DB.clientes.filter(function (c) { return norm(c.dni) === d; })[0] || null; }
  function vehiculoPorId(id) { return DB.vehiculos.filter(function (v) { return v.id === id; })[0] || null; }
  function vehiculoPorPatente(p) { var n = norm(p); return DB.vehiculos.filter(function (v) { return norm(v.patente) === n; })[0] || null; }

  function serviciosDe(vid) {
    return DB.servicios.filter(function (s) { return s.vehiculoId === vid; })
      .sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
  }
  function totalServicios(vid) {
    return serviciosDe(vid).reduce(function (acc, s) { return acc + costoServicio(s); }, 0);
  }

  function nombrePropietario(v) {
    var c = clientePorId(v.clienteId);
    return c ? c.nombre : 'Propietario desconocido';
  }
  /* Último dueño conocido (aunque ya no sea el titular actual) */
  function ultimoDuenoRegistrado(v) {
    var c = clientePorId(v.clienteId);
    if (c) return c.nombre;
    if (v.duenos && v.duenos.length) return v.duenos[v.duenos.length - 1].nombre;
    return null;
  }

  /* Vehículos de un cliente.
     ACTIVOS: hoy es el titular Y el auto está en circulación — puede
     haber 1, 2 o N a la vez; cada uno recibe sus propias acciones.
     HISTÓRICOS: autos que tuvo a su nombre y ya no tiene (se llega ahí
     únicamente por transferencia o desafiliación). */
  function vehiculosDeCliente(cli) {
    var activos = [], historicos = [];
    DB.vehiculos.forEach(function (v) {
      var esTitularActual = v.clienteId === cli.id;
      var fueDueno = (v.duenos || []).some(function (d) { return norm(d.dni) === norm(cli.dni); });
      if (esTitularActual && v.estado !== 'historico') {
        activos.push(v);
        if (v.estado !== 'activo') v.estado = 'activo';   /* normaliza datos viejos */
      } else if (esTitularActual && v.estado === 'historico') {
        historicos.push(v);
      } else if (fueDueno) {
        historicos.push(v);
      }
    });
    return { activos: activos, historicos: historicos };
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
    RESULTS.innerHTML =
      '<section class="card fade-in"><div class="empty">' +
        ICON.alert +
        '<h3>Sin resultados para “' + esc(q) + '”</h3>' +
        '<p>No encontramos ningún cliente ni vehículo con ese dato.</p>' +
        '<div class="row" style="justify-content:center;flex-wrap:wrap;margin-top:16px">' +
          '<button class="btn primary" data-act="nuevo-registro">' + ICON.plus + ' Registrar cliente</button>' +
          '<button class="btn" data-act="scan">' + ICON.search + ' Escanear otra vez</button>' +
        '</div>' +
      '</div></section>';
  }

  /* ---------- Vista CLIENTE ---------- */
  function renderCliente(cli) {
    var r = vehiculosDeCliente(cli);
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
          '<span class="meta-pill">' + ICON.car + '<b>' + r.activos.length + '</b> activo(s)</span>' +
        '</div>' +
      '</section>';

    /* Vehículos activos: UNA TARJETA POR VEHÍCULO, cada una con sus
       acciones propias (Seleccionar para servicio / Ver ficha). */
    html += '<div class="section"><div class="sec-head"><h2>Vehículos Activos</h2><span class="count">' + r.activos.length + '</span></div>';
    if (r.activos.length) {
      html += '<div class="card">' + r.activos.map(function (v) { return vehRow(v, false); }).join('') + '</div>';
    } else {
      html += '<div class="card"><div class="empty" style="padding:26px 18px">' + ICON.car +
        '<h3>Sin vehículos activos</h3><p>Este cliente no tiene vehículos en circulación registrados.</p></div></div>';
    }
    html += '</div>';

    /* Histórico: sólo transferencias y desafiliaciones de este cliente */
    html += '<div class="section"><div class="sec-head"><h2>Historial de Vehículos Anteriores</h2><span class="count gray">' + r.historicos.length + '</span></div>';
    if (r.historicos.length) {
      html += '<div class="card">' + r.historicos.map(function (v) { return vehRow(v, true); }).join('') + '</div>';
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
      ? 'Histórico · ' + (v.clienteId ? 'titular actual: ' + nombrePropietario(v) : 'sin titular actual')
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
          ' · ' + serviciosDe(v.id).length + ' servicio(s)' +
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
  function renderVehiculo(v) {
    var cli = clientePorId(v.clienteId);
    var svs = serviciosDe(v.id);
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
    var duenos = (v.duenos || []).slice().reverse();
    var cli = clientePorId(v.clienteId);
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
     7. Búsqueda dual e inteligente (un solo input)
     ========================================================== */
  function buscar(raw, tipoForzado) {
    var q = String(raw || '').trim();
    if (!q) { mostrarTodo(tipoForzado || estado.tipo); return; }

    var tipo = tipoForzado || estado.tipo;
    if (tipo === 'auto') tipo = detectarTipo(q);

    /* Búsqueda por DNI */
    if (tipo === 'dni') {
      var cli = clientePorDni(q);
      if (cli) { abrirCliente(cli.id); return; }
      var parcialesDni = DB.clientes.filter(function (c) { return norm(c.dni).indexOf(norm(q)) !== -1; });
      if (parcialesDni.length === 1) { abrirCliente(parcialesDni[0].id); return; }
      if (parcialesDni.length > 1) { renderLista('clientes', parcialesDni); return; }

      /* Fallback: quizás era una patente numérica */
      var vFallback = vehiculoPorPatente(q);
      if (vFallback) { abrirVehiculo(vFallback.id); return; }
      renderSinResultados(q);
      return;
    }

    /* Búsqueda por patente */
    var veh = vehiculoPorPatente(q);
    if (veh) { abrirVehiculo(veh.id); return; }
    var parciales = DB.vehiculos.filter(function (v) { return norm(v.patente).indexOf(norm(q)) !== -1; });
    if (parciales.length === 1) { abrirVehiculo(parciales[0].id); return; }
    if (parciales.length > 1) { renderLista('vehiculos', parciales); return; }

    /* Sin coincidencias como patente: probar como DNI */
    var cli2 = clientePorDni(q);
    if (cli2) { abrirCliente(cli2.id); return; }
    renderSinResultados(q);
  }

  function renderLista(kind, items, titulo) {
    estado.vista = 'inicio'; estado.clienteId = null; estado.vehiculoId = null;
    var html = '<div class="section"><div class="sec-head"><h2>' + esc(titulo || 'Coincidencias') + '</h2>' +
      '<span class="count gray">' + items.length + '</span></div><div class="card fade-in">';
    if (kind === 'clientes') {
      html += items.map(function (c) {
        var r = vehiculosDeCliente(c);
        return '<div class="veh"><div class="veh-ico">' + ICON.user + '</div><div class="veh-body">' +
          '<div class="veh-title"><strong>' + esc(c.nombre) + '</strong><span class="badge">DNI ' + esc(c.dni) + '</span></div>' +
          '<div class="veh-sub">' + r.activos.length + ' vehículo(s) activo(s) · ' + esc(c.telefono || 'sin teléfono') + '</div>' +
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
  function mostrarTodo(tipo) {
    if (tipo === 'patente') {
      var vs = DB.vehiculos.slice().sort(function (a, b) { return a.patente.localeCompare(b.patente); });
      renderLista('vehiculos', vs, 'Todos los vehículos registrados');
    } else if (tipo === 'dni') {
      var cs = DB.clientes.slice().sort(function (a, b) { return a.nombre.localeCompare(b.nombre); });
      renderLista('clientes', cs, 'Todos los clientes registrados');
    } else {
      renderInicio();
    }
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

  function abrirCliente(id) {
    var c = clientePorId(id);
    if (!c) return;
    estado.vista = 'cliente'; estado.clienteId = id; estado.vehiculoId = null;
    renderCliente(c);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function abrirVehiculo(id) {
    var v = vehiculoPorId(id);
    if (!v) return;
    estado.vista = 'vehiculo'; estado.vehiculoId = id; estado.tab = 'historial';
    renderVehiculo(v);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function refrescar() {
    if (estado.vista === 'cliente') {
      var c = clientePorId(estado.clienteId);
      if (c) renderCliente(c); else renderInicio();
    } else if (estado.vista === 'vehiculo') {
      var v = vehiculoPorId(estado.vehiculoId);
      if (v) renderVehiculo(v); else renderInicio();
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
  /* Si llega vehiculoId (tarjeta del cliente), el select preselecciona
     ese auto; si llega sólo clienteId, sus autos activos van al tope. */
  function abrirOT(vehiculoId, clienteId) {
    estado.ctx = { clienteId: clienteId || null };
    var sel = $('#ot-vehiculo');
    var lista = DB.vehiculos.slice().sort(function (a, b) { return a.patente.localeCompare(b.patente); });
    if (clienteId) {
      var delCliente = lista.filter(function (v) { return v.clienteId === clienteId; });
      if (delCliente.length) lista = delCliente.concat(lista.filter(function (v) { return v.clienteId !== clienteId; }));
    }
    sel.innerHTML = '<option value="">Seleccioná un vehículo…</option>' + lista.map(function (v) {
      var marcador = (clienteId && v.clienteId === clienteId && v.estado !== 'historico') ? ' · activo' : '';
      return '<option value="' + esc(v.id) + '">' + esc(v.patente + ' — ' + v.marca + ' ' + v.modelo + ' (' + (v.anio || '—') + ')' + marcador) + '</option>';
    }).join('');
    if (vehiculoId) sel.value = vehiculoId;

    var v = vehiculoId ? vehiculoPorId(vehiculoId) : null;
    $('#ot-sub').textContent = v ? 'Vehículo: ' + v.patente + ' · ' + v.marca + ' ' + v.modelo : 'Cargá los datos del servicio realizado';
    $('#ot-fecha').value = hoy();
    $('#ot-km').value = v && v.km ? v.km : '';
    $('#ot-mano').value = 0;
    $('#ot-obs').value = '';

    $('#ot-tareas').innerHTML = TAREAS_SUGERIDAS.map(function (t) {
      return '<label class="check"><input type="checkbox" value="' + esc(t) + '">' + esc(t) + '</label>';
    }).join('');

    $('#ot-repuestos').innerHTML = '';
    agregarRepuesto();
    calcularTotal();
    abrirModal('#modal-ot');
  }

  function agregarRepuesto() {
    var row = document.createElement('div');
    row.className = 'rep-row mt6';
    row.innerHTML =
      '<input class="inp" placeholder="Repuesto" data-rep="nombre">' +
      '<input class="inp" type="number" min="1" step="1" value="1" data-rep="cantidad" inputmode="numeric" title="Cantidad">' +
      '<input class="inp" type="number" min="0" step="100" value="0" data-rep="precio" inputmode="numeric" title="Precio unitario">' +
      '<button type="button" class="icon-del" data-act="del-repuesto" title="Quitar">' + ICON.trash + '</button>';
    $('#ot-repuestos').appendChild(row);
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

  function guardarOT() {
    var vid = $('#ot-vehiculo').value;
    if (!vid) { toast('Seleccioná un vehículo', true); return; }

    DB.servicios.push({
      id: uid('srv'),
      vehiculoId: vid,
      fecha: $('#ot-fecha').value || hoy(),
      km: Number($('#ot-km').value) || null,
      tareas: $$('#ot-tareas input:checked').map(function (i) { return i.value; }),
      repuestos: leerRepuestos(),
      manoObra: Number($('#ot-mano').value) || 0,
      obs: $('#ot-obs').value.trim()
    });

    /* El kilometraje del vehículo queda actualizado con esta OT */
    var v = vehiculoPorId(vid);
    if (v && Number($('#ot-km').value)) v.km = Number($('#ot-km').value);

    var ok = guardar();
    cerrarModal();
    toast(ok ? 'Orden de trabajo guardada' : 'Orden guardada (sin persistencia local)');
    if (estado.vista === 'vehiculo' && estado.vehiculoId === vid) estado.tab = 'historial';
    refrescar();
  }

  /* ==========================================================
     10. Vehículos (asociar a un cliente)
     ========================================================== */
  function abrirVehiculoModal(clienteId) {
    var c = clientePorId(clienteId);
    if (!c) return;
    estado.ctx = { clienteId: clienteId };
    $('#veh-sub').textContent = 'Se vinculará a ' + c.nombre + ' (DNI ' + esc(c.dni) + ')';
    $('#vehForm').reset();
    $('#v-anio').value = new Date().getFullYear();
    abrirModal('#modal-vehiculo');
  }

  /* Siempre nace 'activo': el cliente puede acumular varios activos. */
  function guardarVehiculo() {
    var form = $('#vehForm');
    if (!form.reportValidity()) return;
    var patente = norm($('#v-patente').value);
    if (patente.length < 5) { toast('La patente parece incompleta', true); return; }
    if (vehiculoPorPatente(patente)) { toast('Ya existe un vehículo con esa patente', true); return; }

    var v = {
      id: uid('veh'),
      patente: patente,
      marca: $('#v-marca').value.trim() || 'Sin marca',
      modelo: $('#v-modelo').value.trim() || 'Sin modelo',
      anio: Number($('#v-anio').value) || null,
      color: $('#v-color').value.trim(),
      km: Number($('#v-km').value) || null,
      motor: $('#v-motor').value.trim(),
      clienteId: estado.ctx.clienteId || null,
      estado: 'activo',
      fechaAlta: hoy(),
      duenos: []
    };
    DB.vehiculos.push(v);
    var ok = guardar();
    cerrarModal();
    toast(ok ? 'Vehículo asociado correctamente' : 'Vehículo asociado (sin persistencia local)');
    estado.vista = 'vehiculo'; estado.vehiculoId = v.id; estado.tab = 'historial';
    refrescar();
  }

  /* ==========================================================
     11. Transferencia de titularidad
     ========================================================== */
  function abrirTransfer(vehiculoId, sinTitular) {
    var v = vehiculoPorId(vehiculoId);
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

  function guardarTransfer() {
    var sinTitular = $('#tr-sin-titular').checked;
    var form = $('#trForm');
    if (!sinTitular && !form.reportValidity()) return;
    var v = vehiculoPorId(estado.ctx.vehiculoId);
    if (!v) return;
    var f = $('#tr-fecha').value || hoy();

    /* El titular saliente queda registrado en el historial del vehículo:
       es lo que lo hace aparecer en "Histórico de Vehículos Anteriores". */
    if (v.clienteId) {
      var actual = clientePorId(v.clienteId);
      if (actual) {
        v.duenos = v.duenos || [];
        v.duenos.push({
          nombre: actual.nombre,
          dni: actual.dni,
          desde: actual.desde || v.fechaAlta || '—',
          hasta: f
        });
      }
    }

    /* Desafiliar: el auto queda activo y sin propietario */
    if (sinTitular) {
      v.clienteId = null;
      v.estado = 'activo';
      var okOff = guardar();
      cerrarModal();
      estado.ctx = {};
      estado.tab = 'propietario';
      toast(okOff ? v.patente + ' desafiliado: queda como "Propietario desconocido"' : v.patente + ' desafiliado (sin persistencia local)');
      abrirVehiculo(v.id);
      return;
    }

    var dni = norm($('#tr-dni').value);
    var nombre = $('#tr-nombre').value.trim();
    var tel = $('#tr-tel').value.trim();

    /* Nuevo titular: reutilizar su ficha o crearla */
    var nuevo = clientePorDni(dni);
    if (!nuevo) {
      nuevo = { id: uid('cli'), nombre: nombre, dni: dni, telefono: tel, email: '', desde: f };
      DB.clientes.push(nuevo);
    } else if (nombre) {
      nuevo.nombre = nombre;
      if (tel && !nuevo.telefono) nuevo.telefono = tel;
    }

    v.clienteId = nuevo.id;
    v.estado = 'activo';
    var ok = guardar();
    cerrarModal();
    toast(ok ? 'Titularidad transferida a ' + nuevo.nombre : 'Titularidad transferida (sin persistencia local)');
    estado.vista = 'vehiculo'; estado.vehiculoId = v.id; estado.tab = 'propietario';
    refrescar();
  }

  /* ==========================================================
     12. Clientes (alta)
     ========================================================== */
  function abrirClienteModal() {
    $('#clForm').reset();
    abrirModal('#modal-cliente');
  }

  function guardarCliente() {
    var form = $('#clForm');
    if (!form.reportValidity()) return;
    var dni = norm($('#c-dni').value);
    if (!dni) { toast('Ingresá un DNI', true); return; }
    if (clientePorDni(dni)) { toast('Ya existe un cliente con ese DNI', true); return; }
    var c = {
      id: uid('cli'),
      nombre: $('#c-nombre').value.trim(),
      dni: dni,
      telefono: $('#c-tel').value.trim(),
      email: $('#c-email').value.trim(),
      desde: hoy()
    };
    DB.clientes.push(c);
    var ok = guardar();
    cerrarModal();
    toast(ok ? 'Cliente registrado' : 'Cliente registrado (sin persistencia local)');
    abrirCliente(c.id);
  }

  /* ==========================================================
     13. Eliminar registros (con confirmación)
     ========================================================== */
  function abrirEliminar(kind, id) {
    var msg = '', sub = 'Esta acción no se puede deshacer';

    if (kind === 'cliente') {
      var c = clientePorId(id);
      if (!c) return;
      var r = vehiculosDeCliente(c);
      if (r.activos.length) {
        toast('No se puede eliminar: ' + esc(c.nombre) + ' tiene ' + r.activos.length + ' vehículo(s) activo(s). Transferí la titularidad primero.', true);
        return;
      }
      estado.ctx = { eliminar: { kind: 'cliente', id: id } };
      $('#del-title').textContent = 'Eliminar cliente';
      sub = c.nombre + ' · DNI ' + c.dni;
      msg = 'Se eliminará la ficha de <b>' + esc(c.nombre) + '</b> (DNI ' + esc(c.dni) + ').' +
        (r.historicos.length
          ? ' Sus ' + r.historicos.length + ' vehículo(s) histórico(s) seguirán existiendo, pero quedarán <b>sin titular asociado</b>.'
          : '') +
        ' Las órdenes de trabajo ya cargadas no se borran.';
    } else {
      var v = vehiculoPorId(id);
      if (!v) return;
      var svs = serviciosDe(v.id);
      estado.ctx = { eliminar: { kind: 'vehiculo', id: id } };
      $('#del-title').textContent = 'Eliminar vehículo';
      sub = v.patente + ' · ' + v.marca + ' ' + v.modelo;
      msg = 'Se eliminará <b>' + esc(v.patente) + ' — ' + esc(v.marca + ' ' + v.modelo) + '</b>' +
        (svs.length ? ' junto con sus <b>' + svs.length + ' orden(es) de trabajo</b>' : '') + '.' +
        (v.clienteId ? ' El titular ' + esc(nombrePropietario(v)) + ' quedará sin este vehículo.' : '');
    }

    $('#del-sub').textContent = sub;
    $('#del-msg').innerHTML = msg;
    abrirModal('#modal-eliminar');
  }

  function confirmarEliminar() {
    var e = estado.ctx.eliminar;
    if (!e) { cerrarModal(); return; }
    var eraCliente = e.kind === 'cliente';
    var cliAfectado = null;

    if (eraCliente) {
      DB.clientes = DB.clientes.filter(function (c) { return c.id !== e.id; });
      DB.vehiculos.forEach(function (v) { if (v.clienteId === e.id) v.clienteId = null; });
    } else {
      var v = vehiculoPorId(e.id);
      cliAfectado = v ? v.clienteId : null;
      /* Cascada: el vehículo arrasa sus órdenes de trabajo */
      DB.vehiculos = DB.vehiculos.filter(function (x) { return x.id !== e.id; });
      DB.servicios = DB.servicios.filter(function (s) { return s.vehiculoId !== e.id; });
    }

    var ok = guardar();
    cerrarModal();
    estado.ctx = {};
    toast((eraCliente ? 'Cliente eliminado' : 'Vehículo eliminado') + (ok ? '' : ' (sin persistencia local)'));

    if (eraCliente) { irAlInicio(); return; }
    estado.vehiculoId = null;
    if (cliAfectado && clientePorId(cliAfectado)) abrirCliente(cliAfectado);
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

    /* Muestra el stream en el <video>. La preview sigue usando
       object-fit:cover y rectROIEnVideo() deshace ese mapeo con los
       videoWidth/Height reales del sensor: así la imagen no se deforma
       y el cálculo de la ROI del OCR queda inalterado, sin importar
       qué lente (1x u otro) terminó activándose. */
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

    /* Restricción avanzada `advanced` = "deseable, no obligatoria": en
       móviles con varios lentes traseros pide el sensor principal (zoom 1x)
       en lugar del ultra gran angular 0.5x que Chromium elige por defecto.
       Los navegadores modernos la ignoran con elegancia si no soportan
       zoom; los que no toleran la clave caen en el intento de abajo. */
    var csPrincipal = {
      video: { facingMode: { ideal: 'environment' }, advanced: [{ zoom: 1.0 }] },
      audio: false
    };

    /* Respaldo: restricciones convencionales, idénticas a las de siempre. */
    var csConvencional = {
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    };

    pedir(csPrincipal)
      .then(mostrar)
      .catch(function () {
        /* OverconstrainedError, clave `advanced` desconocida o error
           propio del lente: se reintenta sin ella antes de rendirse. */
        pedir(csConvencional)
          .then(mostrar)
          .catch(function () {
            msg.textContent = 'No se pudo acceder a la cámara';
            notaScan('Permiso denegado o cámara ocupada. Podés escribir la patente manualmente abajo.');
          });
      });
  }

  /* ==========================================================
     15. Motor OCR (Tesseract.js v5) desde su CDN
     · La librería se descarga una sola vez; los clicks repetidos
       reusan la misma descarga (cola de callbacks).
     · El worker se crea UNA vez y queda PERSISTENTE: así setParameters()
       aplica con garantía el whitelist de caracteres y el modo de
       segmentación (PSM) en cada pasada.
     · Timeout de 20 s: si la red no responde, no se cuelga el usuario.
     ========================================================== */
  var TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  var tesseractEstado = 'no-iniciado';   /* no-iniciado | cargando | listo | error */
  var tesseractCola = [];
  var workerOCR = null;                  /* instancia persistente del worker */

  function cargarTesseract(cb) {
    if (tesseractEstado === 'listo' && workerOCR) { cb(null); return; }
    if (tesseractEstado === 'cargando') { tesseractCola.push(cb); return; }

    tesseractEstado = 'cargando';
    tesseractCola.push(cb);
    notaScan('Descargando el motor de lectura (OCR), se hace una sola vez…');

    function terminar(err) {
      tesseractEstado = err ? 'error' : 'listo';
      var pendientes = tesseractCola.slice();
      tesseractCola = [];
      pendientes.forEach(function (f) { f(err || null); });
    }

    /* Paso 2: crear el worker persistente (con logger de progreso) */
    function pasoWorker() {
      if (!window.Tesseract || !window.Tesseract.createWorker) {
        terminar(new Error('motor incompleto'));
        toast('La librería OCR cargó incompleta. Reintentá.', true);
        return;
      }
      if (workerOCR) { terminar(null); return; }

      window.Tesseract.createWorker('eng', 1, {
        logger: function (m) {
          if (!m) return;
          var msg = $('#scan-msg');
          if (!msg) return;
          var p = Math.round((m.progress || 0) * 100);
          if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
            msg.textContent = 'Iniciando el motor OCR… ' + p + '%';
          } else if (m.status === 'loading language traineddata') {
            msg.textContent = 'Preparando el idioma de lectura… ' + p + '%';
          } else if (m.status === 'recognizing text') {
            msg.textContent = 'Leyendo la chapa… ' + p + '%';
          }
        }
      }).then(function (w) {
        workerOCR = w;
        terminar(null);
      }).catch(function (err) {
        console.error('OCR worker:', err);
        terminar(new Error('worker'));
        toast('No se pudo iniciar el motor OCR', true);
        notaScan('Falló el arranque del OCR. Reintentá o usá la lectura manual.');
      });
    }

    /* Paso 1: descargar la librería si todavía no está en la página */
    function pasoLibreria() {
      var script = document.createElement('script');
      script.src = TESSERACT_CDN;
      script.async = true;

      var temporizador = setTimeout(function () {
        if (window.Tesseract) { pasoWorker(); return; }
        terminar(new Error('timeout'));
        toast('El motor OCR tardó demasiado en descargar', true);
        notaScan('No se pudo descargar el OCR (red lenta o sin internet). Escribí la patente en la lectura manual o reintentá.');
      }, 20000);

      script.onload = function () { clearTimeout(temporizador); pasoWorker(); };
      script.onerror = function () {
        clearTimeout(temporizador);
        terminar(new Error('no se pudo descargar'));
        toast('Error al cargar el motor OCR. Verificá tu conexión a internet.', true);
        notaScan('No se pudo descargar Tesseract.js desde el CDN. Escribí la patente en la lectura manual o reintentá.');
      };

      document.head.appendChild(script);
    }

    if (window.Tesseract) pasoWorker(); else pasoLibreria();
  }

  /* ==========================================================
     16. Pre-procesamiento de la imagen (canvas oculto)
     1) escala si es chica (la tipografía de la chapa es fina),
     2) escala de grises por luminancia (0.299/0.587/0.114),
     3) binarización con el umbral de Otsu (texto negro / fondo blanco).
     ========================================================== */
  function prepararCanvasOCR(src) {
    var w = src.width, h = src.height;
    var escala = (w && w < 1000) ? Math.min(2, 1000 / w) : 1;
    var cv = document.createElement('canvas');
    cv.width = Math.round((w || 640) * escala);
    cv.height = Math.round((h || 480) * escala);
    var ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, 0, 0, cv.width, cv.height);

    try {
      var img = ctx.getImageData(0, 0, cv.width, cv.height);
      var px = img.data;
      var hist = new Array(256);
      for (var i = 0; i < 256; i++) hist[i] = 0;

      for (var p = 0; p < px.length; p += 4) {
        var g = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) | 0;
        px[p] = px[p + 1] = px[p + 2] = g;
        hist[g]++;
      }

      /* Otsu: separa el gris en dos clases maximizando la varianza
         entre clases (caracteres vs fondo metálico). */
      var total = px.length / 4;
      var sumaT = 0;
      for (var q = 0; q < 256; q++) sumaT += q * hist[q];
      var sumaB = 0, wB = 0, mejor = -1, umbral = 127;
      for (var t2 = 0; t2 < 256; t2++) {
        wB += hist[t2];
        if (!wB) continue;
        var wF = total - wB;
        if (!wF) break;
        sumaB += t2 * hist[t2];
        var mB = sumaB / wB, mF = (sumaT - sumaB) / wF;
        var entre = wB * wF * (mB - mF) * (mB - mF);
        if (entre > mejor) { mejor = entre; umbral = t2; }
      }
      /* Imagen uniforme (cámara tapada): Otsu no aporta, queda la gris. */
      if (mejor > 0) {
        for (var r = 0; r < px.length; r += 4) {
          var v = px[r] > umbral ? 255 : 0;
          px[r] = px[r + 1] = px[r + 2] = v;
        }
        ctx.putImageData(img, 0, 0);
      }
    } catch (e) {
      /* getImageData puede fallar con un frame viciado; se sigue con
         la imagen tal cual: mejor intentar que cancelar la lectura. */
    }
    return cv;
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
    if (ex - sx < 24 || ey - sy < 16) return null;   /* encuadre degenerado */

    return { sx: sx, sy: sy, sw: ex - sx, sh: ey - sy };
  }

  /* ==========================================================
     18. Capturar y leer: ROI → pre-procesado → OCR en 2 pasadas
       intento 1 → PSM 7 (línea única: la chapa entera)
       intento 2 → PSM 6 (bloque uniforme: encuadre amplio)
     con whitelist A-Z0-9 y validación por extraerPatenteOTexto().
     ========================================================== */
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

    msg.textContent = 'Preparando el motor de lectura (OCR)…';

    cargarTesseract(function (err) {
      if (turno !== ocrSeq) return;
      if (err) {
        msg.textContent = 'No se pudo cargar el OCR';
        $('#scan-manual').focus();
        return;
      }

      /* Pre-procesamiento: grises + Otsu + escalado */
      var cvListo = prepararCanvasOCR(canvas);

      function leer(intento) {
        var psm = (intento === 1)
          ? (window.Tesseract.PSM ? window.Tesseract.PSM.SINGLE_LINE : '7')
          : (window.Tesseract.PSM ? window.Tesseract.PSM.SINGLE_BLOCK : '6');
        if (intento === 2) msg.textContent = 'Sin chapa clara: segundo intento con encuadre amplio…';

        /* Whitelist: sólo mayúsculas y dígitos (descarta minúsculas,
           tildes y símbolos) */
        workerOCR.setParameters({
          tessedit_pageseg_mode: psm,
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        }).then(function () {
          return workerOCR.recognize(cvListo);
        }).then(function (res) {
          if (turno !== ocrSeq) return;
          var textoBruto = res && res.data ? (res.data.text || '') : '';
          var dato = extraerPatenteOTexto(textoBruto);

          /* Coincidencia limpia: cerrar, volcar en #q y buscar */
          if (dato) { usarLectura(dato); return; }

          /* Sin patrón: segunda pasada con encuadre amplio */
          if (intento === 1) { leer(2); return; }

          /* Lectura poco clara: guiar sin cerrar el modal */
          msg.textContent = 'Lectura poco clara';
          notaScan('No se detectó una patente legible. Acercá el celular a la chapa, encuadrá el recuadro sin reflejos y pulsá "Capturar y leer" de nuevo; o usá la lectura manual.');
          toast('No se pudo leer la chapa. Acercate más o usá la lectura manual.', true);
        }).catch(function (e) {
          if (turno !== ocrSeq) return;
          if (intento === 1) { leer(2); return; }
          console.error('OCR:', e);
          msg.textContent = 'Error durante la lectura';
          notaScan('El procesamiento de imagen falló. Probá de nuevo o ingresá la patente manualmente.');
          toast('Error durante la lectura de la imagen.', true);
        });
      }

      leer(1);
    });
  }

  /* Lectura usada (OCR o manual): cierra, vuelca en #q y busca */
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
    'nuevo-registro': function () { abrirClienteModal(); },
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
    'guardar-ot': function () { guardarOT(); },
    'nuevo-vehiculo': function (el) { abrirVehiculoModal(el.dataset.cliente); },
    'guardar-vehiculo': function () { guardarVehiculo(); },
    transferir: function (el) { abrirTransfer(el.dataset.vehiculo, el.dataset.sinTitular === '1'); },
    'guardar-transfer': function () { guardarTransfer(); },
    'guardar-cliente': function () { guardarCliente(); },
    'sin-titular': function () {
      var vs = DB.vehiculos.filter(function (v) { return !v.clienteId; })
        .sort(function (a, b) { return a.patente.localeCompare(b.patente); });
      if (!vs.length) { toast('No hay vehículos sin titular'); return; }
      renderLista('vehiculos', vs, 'Vehículos sin titular (propietario desconocido)');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    'ver-cliente': function (el) { abrirCliente(el.dataset.cliente); },
    'ver-vehiculo': function (el) { abrirVehiculo(el.dataset.vehiculo); },
    'eliminar-registro': function (el) { abrirEliminar(el.dataset.kind, el.dataset.id); },
    'confirmar-eliminar': function () { confirmarEliminar(); },
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

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!el) {
      if (ev.target.classList && ev.target.classList.contains('backdrop')) cerrarModal();
      return;
    }
    var fn = ACCIONES[el.dataset.act];
    if (fn) { ev.preventDefault(); fn(el, ev); }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && abierto) cerrarModal();
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

  /* Switch "Propietario desconocido" vs. datos del nuevo titular */
  $('#tr-sin-titular').addEventListener('change', alternarDatosTitular);

  /* Autocompletar la ficha de un cliente conocido en la transferencia */
  $('#tr-dni').addEventListener('blur', function () {
    var c = clientePorDni($('#tr-dni').value);
    if (c) {
      $('#tr-nombre').value = c.nombre;
      if (c.telefono) $('#tr-tel').value = c.telefono;
      toast('Cliente encontrado: se reutilizará su ficha');
    }
  });

  /* Elección de tema (se aplica al instante y se persiste) */
  $$('input[name="tema"]').forEach(function (r) {
    r.addEventListener('change', function () { if (r.checked) aplicarTema(r.value); });
  });

  /* ==========================================================
     21. Arranque
     ========================================================== */
  /* Tema: preferencia guardada en este dispositivo (por defecto claro,
     igual que el script anti-parpadeo del <head>) */
  var temaGuardado = 'light';
  try { temaGuardado = localStorage.getItem(TEMA_KEY) || 'light'; } catch (e) {}
  aplicarTema(temaGuardado);

  renderInicio();

  /* Deep-link simple por hash: #patente o #dni */
  if (location.hash.length > 1) {
    var hashVal = decodeURIComponent(location.hash.slice(1));
    $('#q').value = hashVal;
    buscar(hashVal, null);
  }
})();
