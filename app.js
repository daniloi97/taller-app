/* ============================================================================
   TALLER MECÁNICO · HISTORIA CLÍNICA VEHICULAR
   app.js — lógica completa de la aplicación (Vanilla JS)

   · Única referencia externa opcional: el motor OCR de Tesseract.js se
     carga bajo demanda desde su CDN oficial
     (https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js)
     SOLO la primera vez que se usa el botón "Capturar y leer" del escáner.
     Si no hay internet, el resto de la app funciona igual y el escáner
     cae con elegancia a la lectura manual.

   Reglas de negocio clave:
   · Un cliente puede tener VARIOS vehículos con estado 'activo' a la vez.
     Cada vehículo activo es independiente y puede recibir órdenes de trabajo.
   · Un vehículo pasa al listado "Histórico / Anteriores" de un cliente sólo
     cuando se transfiere la titularidad a otra persona o se desafilia
     ("Propietario desconocido"); el dueño saliente queda registrado en
     vehiculo.duenos para conservar el historial de propiedad.
   · Persistencia local en localStorage (taller_db_v1) con datos semilla.
   · La lógica se carga desde <script src="app.js"></script> al final del
     <body> para que el parsing del HTML no se bloquee (defer implícito).
   · El script va dentro de una IIFE para no contaminar el ámbito global.
   ============================================================================ */
/* ============================================================================
   TALLER MECÁNICO · HISTORIA CLÍNICA VEHICULAR
   app.js — lógica completa de la aplicación con OCR (Tesseract.js)
   ============================================================================ */
(function () {
  'use strict';

  /* ==========================================================
     0. Utilidades generales
     ========================================================== */
  var LS_KEY = 'taller_db_v1';

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
    return String(nombre || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }

  /* Detección automática del tipo de búsqueda */
  function detectarTipo(raw) {
    var v = norm(raw);
    if (!v) return 'auto';
    if (/^\d{7,8}$/.test(v) || /^\d{11}$/.test(v)) return 'dni';
    if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(v)) return 'patente';   // Mercosur AB123CD
    if (/^[A-Z]{3}\d{3}$/.test(v)) return 'patente';           // Antigua ABC123
    if (/^[A-Z]\d{3}[A-Z]{3}$/.test(v)) return 'patente';      // Antigua A123BCD
    if (/^\d{6}$/.test(v) || /^\d{3}$/.test(v)) return 'patente';
    if (/[A-Z]/.test(v) && /\d/.test(v)) return 'patente';
    if (/^\d+$/.test(v)) return 'dni';
    return 'auto';
  }

  /* ==========================================================
     Extrae un dato válido (patente o DNI) del texto crudo del OCR.
     Devuelve el valor NORMALIZADO (mayúsculas, sin separadores)
     o null si no hay ninguna lectura confiable. La función nunca
     devuelve texto basura: si no reconoce un patrón, devuelve null
     para que la UI invite a reintentar o usar la lectura manual.
     ========================================================== */
  function extraerPatenteOTexto(texto) {
    /* Normalización: mayúsculas, separadores no alfanuméricos → espacios */
    var t = String(texto || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    if (!t) return null;

    /* 1) Patente Mercosur: AB 123 CD (el OCR suele separar los grupos) */
    var mMe = t.match(/\b[A-Z]{2}\s*\d{3}\s*[A-Z]{2}\b/);
    if (mMe) return norm(mMe[0]);

    /* 2) Patente antigua: ABC 123 / A 123 BCD */
    var mAn = t.match(/\b[A-Z]{3}\s*\d{3}\b/);
    if (mAn) return norm(mAn[0]);
    var mAnB = t.match(/\b[A-Z]\s*\d{3}\s*[A-Z]{3}\b/);
    if (mAnB) return norm(mAnB[0]);

    /* 3) DNI: 7 u 8 dígitos aislados (con o sin puntos) */
    var mDni = t.match(/\b\d{7,8}\b/);
    if (mDni) return mDni[0];
    /* Documentos impresos como "30.123.456": probar los dígitos unidos */
    var mDniPtos = t.match(/\b\d{2,3}[ .]\d{3}[ .]\d{3}\b/);
    if (mDniPtos) return mDniPtos[0].replace(/[^0-9]/g, '');

    /* 4) Último recurso disciplinado: UN token alfanumérico con letras
       y números mezclados (patente mal encuadrada u parcialmente leída) */
    var mMix = t.match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{5,8}\b/);
    if (mMix) return mMix[0];

    return null;
  }

  /* ==========================================================
     1. Base de Datos Local (seed)
     ========================================================== */
  var seed = {
    clientes: [
      { id: 'cli_1', nombre: 'Juan Carlos Pérez', dni: '30123456', telefono: '11 5555-1234', email: 'juan.perez@mail.com', desde: '2019-04-11' },
      { id: 'cli_2', nombre: 'María González', dni: '27876543', telefono: '11 4444-9087', email: 'mgonzalez@mail.com', desde: '2020-09-02' },
      { id: 'cli_3', nombre: 'Roberto Díaz', dni: '20456789', telefono: '351 622-3388', email: '', desde: '2015-02-18' }
    ],
    vehiculos: [
      { id: 'veh_1', patente: 'AB123CD', marca: 'Toyota', modelo: 'Corolla XEI 2.0', anio: 2019, color: 'Gris Plata', km: 128400, clienteId: 'cli_1', estado: 'activo', motor: '2ZR-A118842', duenos: [] },
      { id: 'veh_2', patente: 'LKM447', marca: 'Ford', modelo: 'Fiesta Kinetic', anio: 2011, color: 'Rojo', km: 214000, clienteId: null, estado: 'historico', motor: 'CFN-77120', duenos: [{ nombre: 'Juan Carlos Pérez', dni: '30123456', desde: '2012-03-05', hasta: '2021-11-30' }, { nombre: 'Roberto Díaz', dni: '20456789', desde: '2021-11-30', hasta: '2024-06-14' }] },
      { id: 'veh_3', patente: 'AD998ZZ', marca: 'Volkswagen', modelo: 'Amarok Highline', anio: 2022, color: 'Negro', km: 46300, clienteId: 'cli_2', estado: 'activo', motor: 'DDX-551230', duenos: [] },
      { id: 'veh_4', patente: 'JUV210', marca: 'Renault', modelo: 'Clio Authentique', anio: 2008, color: 'Azul', km: 268900, clienteId: null, estado: 'historico', motor: 'K4M-990211', duenos: [{ nombre: 'María González', dni: '27876543', desde: '2013-07-22', hasta: '2022-02-09' }] },
      { id: 'veh_5', patente: 'AE451QW', marca: 'Chevrolet', modelo: 'Onix LTZ', anio: 2023, color: 'Blanco', km: 18900, clienteId: 'cli_1', estado: 'activo', motor: 'LXT-330912', duenos: [] }
    ],
    servicios: [
      { id: 'srv_1', vehiculoId: 'veh_1', fecha: '2026-08-14', km: 126800, manoObra: 150000, tareas: ['Cambio de aceite y filtro', 'Service 20.000 km'], repuestos: [{ nombre: 'Filtro de aceite', cantidad: 1, precio: 42000 }, { nombre: 'Aceite 5W30 (4L)', cantidad: 1, precio: 96000 }], obs: 'Se recomienda revisar tren delantero en el próximo ingreso.' },
      { id: 'srv_2', vehiculoId: 'veh_1', fecha: '2026-03-02', km: 119300, manoObra: 98000, tareas: ['Cambio de pastillas de freno', 'Rectificado de discos'], repuestos: [{ nombre: 'Pastillas delanteras', cantidad: 1, precio: 135000 }, { nombre: 'Líquido de frenos', cantidad: 1, precio: 28000 }], obs: '' },
      { id: 'srv_3', vehiculoId: 'veh_1', fecha: '2025-11-19', km: 111000, manoObra: 60000, tareas: ['Alineación y balanceo'], repuestos: [], obs: 'Se corrigió convergencia.' },
      { id: 'srv_4', vehiculoId: 'veh_3', fecha: '2026-06-27', km: 44100, manoObra: 210000, tareas: ['Distribución completa', 'Cambio de aceite y filtro'], repuestos: [{ nombre: 'Kit de distribución', cantidad: 1, precio: 480000 }, { nombre: 'Bomba de agua', cantidad: 1, precio: 175000 }], obs: 'Cliente autoriza recambio de bomba de agua.' },
      { id: 'srv_5', vehiculoId: 'veh_2', fecha: '2020-05-08', km: 198000, manoObra: 45000, tareas: ['Cambio de embrague'], repuestos: [{ nombre: 'Kit de embrague', cantidad: 1, precio: 168000 }], obs: 'Vehículo luego transferido.' },
      { id: 'srv_6', vehiculoId: 'veh_5', fecha: '2026-09-05', km: 18200, manoObra: 72000, tareas: ['Cambio de aceite y filtro', 'Revisión general'], repuestos: [{ nombre: 'Filtro de aire', cantidad: 1, precio: 31000 }, { nombre: 'Aceite 0W20 (4L)', cantidad: 1, precio: 118000 }], obs: '' }
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
    } catch (e) {}
    return JSON.parse(JSON.stringify(seed));
  }
  function guardar() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); return true; }
    catch (e) { return false; }
  }

  /* ==========================================================
     2. Accesores y Reglas
     ========================================================== */
  function clientePorId(id) { return DB.clientes.filter(function (c) { return c.id === id; })[0] || null; }
  function clientePorDni(dni) { var d = norm(dni); return DB.clientes.filter(function (c) { return norm(c.dni) === d; })[0] || null; }
  function vehiculoPorId(id) { return DB.vehiculos.filter(function (v) { return v.id === id; })[0] || null; }
  function vehiculoPorPatente(p) { var n = norm(p); return DB.vehiculos.filter(function (v) { return norm(v.patente) === n; })[0] || null; }
  function serviciosDe(vid) {
    return DB.servicios.filter(function (s) { return s.vehiculoId === vid; })
      .sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
  }
  function nombrePropietario(v) {
    var c = clientePorId(v.clienteId);
    return c ? c.nombre : 'Propietario desconocido';
  }
  function ultimoDuenoRegistrado(v) {
    var c = clientePorId(v.clienteId);
    if (c) return c.nombre;
    if (v.duenos && v.duenos.length) return v.duenos[v.duenos.length - 1].nombre;
    return null;
  }
  function vehiculosDeCliente(cli) {
    var activos = [], historicos = [];
    DB.vehiculos.forEach(function (v) {
      var esTitularActual = v.clienteId === cli.id;
      var fueDueno = (v.duenos || []).some(function (d) { return norm(d.dni) === norm(cli.dni); });
      if (esTitularActual && (v.estado !== 'historico')) {
        activos.push(v);
        if (v.estado !== 'activo') v.estado = 'activo';
      } else if (esTitularActual && v.estado === 'historico') {
        historicos.push(v);
      } else if (fueDueno) {
        historicos.push(v);
      }
    });
    return { activos: activos, historicos: historicos };
  }

  /* ==========================================================
     3. Estado de UI
     ========================================================== */
  var estado = {
    tipo: 'auto',
    vista: 'inicio',
    clienteId: null,
    vehiculoId: null,
    tab: 'historial',
    ctx: {}
  };

  var TAREAS_SUGERIDAS = [
    'Cambio de aceite y filtro', 'Service programado', 'Alineación y balanceo',
    'Cambio de pastillas de freno', 'Distribución', 'Cambio de embrague',
    'Batería', 'Neumáticos', 'Revisión general', 'Diagnóstico electrónico'
  ];

  /* ==========================================================
     4. Iconos (SVG inline)
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
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.4-3 8.2-7 9-4-.8-7-4.6-7-9V6z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    temaAuto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3.2a8.8 8.8 0 0 0 0 17.6z" fill="currentColor" stroke="none"/></svg>'
  };

  /* ==========================================================
     5. Render Principal
     ========================================================== */
  var RESULTS = $('#results');

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
            '<div class="hint"><div class="n">3</div><p>Usa la cámara con <b>Capturar y leer</b> para fotografiar la patente</p></div>' +
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

  /* Vista CLIENTE */
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
          '<span class="badge ok" style="background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.24);color:#e8eefb">' + ICON.shield + ' Ficha activa</span>' +
          '<button type="button" class="hd-btn" data-act="eliminar-registro" data-kind="cliente" data-id="' + esc(cli.id) + '" title="Eliminar cliente">' + ICON.trash + '</button>' +
        '</div>' +
        '<div class="hd-meta">' +
          '<span class="meta-pill">' + ICON.id + '<b>' + esc(cli.dni) + '</b></span>' +
          '<span class="meta-pill">' + ICON.phone + (cli.telefono ? '<b>' + esc(cli.telefono) + '</b>' : 'Sin teléfono') + '</span>' +
          (cli.email ? '<span class="meta-pill">' + ICON.user + esc(cli.email) + '</span>' : '') +
          '<span class="meta-pill">' + ICON.car + '<b>' + r.activos.length + '</b> activo(s)</span>' +
        '</div>' +
      '</section>';

    html += '<div class="section"><div class="sec-head"><h2>Vehículos Activos</h2><span class="count">' + r.activos.length + '</span></div>';
    if (r.activos.length) {
      html += '<div class="card">' + r.activos.map(function (v) { return vehRow(v, false); }).join('') + '</div>';
    } else {
      html += '<div class="card"><div class="empty" style="padding:26px 18px">' + ICON.car + '<h3>Sin vehículos activos</h3></div></div>';
    }
    html += '</div>';

    html += '<div class="section"><div class="sec-head"><h2>Historial de Vehículos Anteriores</h2><span class="count gray">' + r.historicos.length + '</span></div>';
    if (r.historicos.length) {
      html += '<div class="card">' + r.historicos.map(function (v) { return vehRow(v, true); }).join('') + '</div>';
    } else {
      html += '<div class="card"><div class="empty" style="padding:24px 18px">' + ICON.clock + '<h3>Sin antecedentes</h3></div></div>';
    }
    html += '</div>';

    html += '<div class="section">' +
      '<button class="btn primary full" data-act="nuevo-vehiculo" data-cliente="' + esc(cli.id) + '">' + ICON.plus + ' Asociar Nuevo Vehículo a este Cliente</button>' +
      '<button class="btn full mt10" data-act="nueva-ot" data-cliente="' + esc(cli.id) + '">' + ICON.wrench + ' Nueva Orden de Trabajo</button>' +
    '</div>';

    RESULTS.innerHTML = html;
  }

  function vehRow(v, historico) {
    var duenoTxt = historico ? 'Histórico · ' + (v.clienteId ? 'titular: ' + nombrePropietario(v) : 'sin titular') : '';
    return '<div class="veh ' + (historico ? 'off' : '') + '">' +
      '<div class="veh-ico">' + ICON.car + '</div>' +
      '<div class="veh-body">' +
        '<div class="veh-title">' +
          '<span class="plate">' + esc(v.patente) + '</span>' +
          '<strong>' + esc(v.marca) + ' ' + esc(v.modelo) + '</strong>' +
          (historico ? '<span class="badge off">Anterior</span>' : '<span class="badge ok">Activo</span>') +
        '</div>' +
        '<div class="veh-sub">Año ' + esc(v.anio || '—') + (v.color ? ' · ' + esc(v.color) : '') + (v.km ? ' · ' + num(v.km) + ' km' : '') + ' · ' + serviciosDe(v.id).length + ' servicio(s)' + (duenoTxt ? ' · ' + esc(duenoTxt) : '') + '</div>' +
        '<div class="veh-actions">' +
          (historico
            ? '<button class="btn sm" data-act="ver-vehiculo" data-vehiculo="' + esc(v.id) + '">' + ICON.clock + ' Ver historial</button>'
            : '<button class="btn sm primary" data-act="nueva-ot" data-vehiculo="' + esc(v.id) + '" data-cliente="' + esc(v.clienteId || '') + '">' + ICON.wrench + ' Seleccionar para servicio</button>' +
              '<button class="btn sm" data-act="ver-vehiculo" data-vehiculo="' + esc(v.id) + '">' + ICON.search + ' Ver ficha</button>') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* Vista VEHÍCULO */
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
          (v.estado === 'historico' ? '<span class="badge">' + ICON.clock + ' Histórico</span>' : '<span class="badge ok">' + ICON.check + ' Activo</span>') +
          '<button type="button" class="hd-btn" data-act="eliminar-registro" data-kind="vehiculo" data-id="' + esc(v.id) + '" title="Eliminar vehículo">' + ICON.trash + '</button>' +
        '</div>' +
        '<div class="hd-meta">' +
          (cli ? '<span class="meta-pill">' + ICON.user + '<b>' + esc(cli.nombre) + '</b></span>' : '<span class="meta-pill warn">' + ICON.user + '<b>Propietario desconocido</b></span>') +
          '<span class="meta-pill">' + ICON.wrench + '<b>' + svs.length + '</b> servicios</span>' +
          '<span class="meta-pill">' + ICON.clock + 'Últ. ' + (svs[0] ? fecha(svs[0].fecha) : '—') + '</span>' +
          (v.km ? '<span class="meta-pill">' + ICON.car + '<b>' + num(v.km) + '</b> km</span>' : '') +
        '</div>' +
      '</section>';

    if (cli) {
      html += '<div class="section"><button class="btn full" data-act="ver-cliente" data-cliente="' + esc(cli.id) + '">' + ICON.user + ' Ver ficha del cliente: ' + esc(cli.nombre) + '</button></div>';
    }

    html += '<div class="section"><div class="card">' +
      '<div class="tabs" role="tablist">' +
        tabBtn('historial', 'Historial de Servicios', estado.tab) +
        tabBtn('propietario', 'Propietario Actual', estado.tab) +
        tabBtn('duenos', 'Histórico de Dueños', estado.tab) +
      '</div>' +
      '<div class="tabpanel ' + (estado.tab === 'historial' ? 'active' : '') + '" data-panel="historial">' + panelHistorial(svs) + '</div>' +
      '<div class="tabpanel ' + (estado.tab === 'propietario' ? 'active' : '') + '" data-panel="propietario">' + panelPropietario(v, cli) + '</div>' +
      '<div class="tabpanel ' + (estado.tab === 'duenos' ? 'active' : '') + '" data-panel="duenos">' + panelDuenos(v) + '</div>' +
    '</div></div>';

    RESULTS.innerHTML = html;
  }

  function tabBtn(key, label, active) {
    return '<button class="tab ' + (key === active ? 'active' : '') + '" role="tab" data-act="tab" data-tab="' + key + '">' + esc(label) + '</button>';
  }

  function panelHistorial(svs) {
    if (!svs.length) return '<div class="empty">' + ICON.wrench + '<h3>Sin servicios registrados</h3></div>';
    var total = svs.reduce(function (a, s) { return a + (Number(s.manoObra) || 0) + (s.repuestos || []).reduce(function (x, r) { return x + (Number(r.cantidad) || 0) * (Number(r.precio) || 0); }, 0); }, 0);
    var items = svs.map(function (s) {
      var rep = (s.repuestos || []).reduce(function (a, r) { return a + (Number(r.cantidad) || 0) * (Number(r.precio) || 0); }, 0);
      var costo = (Number(s.manoObra) || 0) + rep;
      return '<div class="tl-item"><div class="tl-hd"><time>' + fecha(s.fecha) + '</time>' + (s.km ? '<span class="km">' + num(s.km) + ' km</span>' : '') + '</div>' +
        '<div class="tl-body"><div class="tags">' + (s.tareas || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') +
        (s.repuestos || []).map(function (r) { return '<span class="tag rep">' + ICON.box + ' ' + esc(r.nombre) + ' ×' + (Number(r.cantidad) || 1) + '</span>'; }).join('') + '</div>' +
        (s.obs ? '<p class="small muted mt10">' + esc(s.obs) + '</p>' : '') +
        '<div class="tl-foot"><span class="xsmall muted">Mano de obra ' + money(s.manoObra) + (rep ? ' · Repuestos ' + money(rep) : '') + '</span><span class="tl-cost">' + money(costo) + '</span></div></div></div>';
    }).join('');
    return '<div class="row between mb14"><span class="badge">' + ICON.wrench + svs.length + ' servicio(s)</span><span class="small muted">Total: <b class="mono">' + money(total) + '</b></span></div><div class="tl">' + items + '</div>';
  }

  function panelPropietario(v, cli) {
    if (!cli) {
      var ult = ultimoDuenoRegistrado(v);
      return '<div class="alert">' + ICON.alert + '<div><b>Propietario desconocido.</b>' + (ult ? ' Último titular: ' + esc(ult) : '') + '</div></div>' +
        '<button class="btn primary full mt14" data-act="transferir" data-vehiculo="' + esc(v.id) + '">' + ICON.swap + ' Asignar titular</button>';
    }
    return '<div class="owner" style="background:#fff"><div class="avatar">' + esc(iniciales(cli.nombre)) + '</div><div style="flex:1"><div class="strong">' + esc(cli.nombre) + '</div><div class="small muted">DNI ' + esc(cli.dni) + '</div></div></div>' +
      '<div class="row mt18"><button class="btn" data-act="ver-cliente" data-cliente="' + esc(cli.id) + '">' + ICON.user + ' Ver ficha</button><button class="btn danger" data-act="transferir" data-vehiculo="' + esc(v.id) + '">' + ICON.swap + ' Transferir</button></div>';
  }

  function panelDuenos(v) {
    var duenos = (v.duenos || []).slice().reverse();
    var cli = clientePorId(v.clienteId);
    var html = cli ? '<div class="owner" style="background:#eff6ff"><div class="avatar">' + esc(iniciales(cli.nombre)) + '</div><div style="flex:1"><div class="strong">' + esc(cli.nombre) + '</div><div class="small muted">Titular actual</div></div></div>' : '';
    if (!duenos.length) return html + '<div class="empty"><h3>Sin dueños anteriores</h3></div>';
    return html + duenos.map(function (d) {
      return '<div class="owner mt10"><div class="avatar">' + esc(iniciales(d.nombre)) + '</div><div style="flex:1"><div class="strong">' + esc(d.nombre) + '</div><div class="small muted">' + fecha(d.desde) + ' → ' + fecha(d.hasta) + '</div></div></div>';
    }).join('');
  }

  /* ==========================================================
     6. Buscador Dual
     ========================================================== */
  function buscar(raw, tipoForzado) {
    var q = String(raw || '').trim();
    if (!q) { mostrarTodo(tipoForzado || estado.tipo); return; }

    var tipo = tipoForzado || estado.tipo;
    if (tipo === 'auto') tipo = detectarTipo(q);

    if (tipo === 'dni') {
      var cli = clientePorDni(q);
      if (cli) { abrirCliente(cli.id); return; }
      var parcialDni = DB.clientes.filter(function (c) { return norm(c.dni).indexOf(norm(q)) !== -1; });
      if (parcialDni.length === 1) { abrirCliente(parcialDni[0].id); return; }
      if (parcialDni.length > 1) { renderLista('clientes', parcialDni); return; }
      var vFallback = vehiculoPorPatente(q);
      if (vFallback) { abrirVehiculo(vFallback.id); return; }
      renderSinResultados(q);
      return;
    }

    var veh = vehiculoPorPatente(q);
    if (veh) { abrirVehiculo(veh.id); return; }
    var parciales = DB.vehiculos.filter(function (v) { return norm(v.patente).indexOf(norm(q)) !== -1; });
    if (parciales.length === 1) { abrirVehiculo(parciales[0].id); return; }
    if (parciales.length > 1) { renderLista('vehiculos', parciales); return; }

    var cli2 = clientePorDni(q);
    if (cli2) { abrirCliente(cli2.id); return; }
    renderSinResultados(q);
  }

  function renderLista(kind, items, titulo) {
    estado.vista = 'inicio';
    var html = '<div class="section"><div class="sec-head"><h2>' + esc(titulo || 'Coincidencias') + '</h2><span class="count gray">' + items.length + '</span></div><div class="card fade-in">';
    if (kind === 'clientes') {
      html += items.map(function (c) {
        return '<div class="veh"><div class="veh-ico">' + ICON.user + '</div><div class="veh-body"><div class="veh-title"><strong>' + esc(c.nombre) + '</strong><span class="badge">DNI ' + esc(c.dni) + '</span></div><div class="veh-actions"><button class="btn sm primary" data-act="ver-cliente" data-cliente="' + esc(c.id) + '">Abrir ficha</button></div></div></div>';
      }).join('');
    } else {
      html += items.map(function (v) { return vehRow(v, v.estado === 'historico'); }).join('');
    }
    html += '</div></div>';
    RESULTS.innerHTML = html;
  }

  function mostrarTodo(tipo) {
    if (tipo === 'patente') renderLista('vehiculos', DB.vehiculos, 'Todos los vehículos');
    else if (tipo === 'dni') renderLista('clientes', DB.clientes, 'Todos los clientes');
    else renderInicio();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function irAlInicio() {
    estado.vista = 'inicio'; estado.clienteId = null; estado.vehiculoId = null; estado.tipo = 'auto';
    $('#q').value = '';
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
    if (estado.vista === 'cliente') { var c = clientePorId(estado.clienteId); if (c) renderCliente(c); else renderInicio(); }
    else if (estado.vista === 'vehiculo') { var v = vehiculoPorId(estado.vehiculoId); if (v) renderVehiculo(v); else renderInicio(); }
    else renderInicio();
  }

  /* ==========================================================
     7. Modales y Operaciones
     ========================================================== */
  var abierto = null;
  function abrirModal(id) {
    var m = $(id);
    if (!m) return;
    m.classList.add('open');
    abierto = m;
    document.body.style.overflow = 'hidden';
  }
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
    setTimeout(function () { t.remove(); }, 3200);
  }

  function abrirOT(vehiculoId, clienteId) {
    var sel = $('#ot-vehiculo');
    sel.innerHTML = DB.vehiculos.map(function (v) {
      return '<option value="' + esc(v.id) + '">' + esc(v.patente + ' — ' + v.marca + ' ' + v.modelo) + '</option>';
    }).join('');
    if (vehiculoId) sel.value = vehiculoId;
    $('#ot-fecha').value = hoy();
    $('#ot-mano').value = 0;
    $('#ot-obs').value = '';
    $('#ot-tareas').innerHTML = TAREAS_SUGERIDAS.map(function (t) { return '<label class="check"><input type="checkbox" value="' + esc(t) + '">' + esc(t) + '</label>'; }).join('');
    $('#ot-repuestos').innerHTML = '';
    calcularTotal();
    abrirModal('#modal-ot');
  }

  function calcularTotal() {
    var mano = Number($('#ot-mano').value) || 0;
    $('#ot-total').textContent = money(mano);
  }

  function guardarOT() {
    var vid = $('#ot-vehiculo').value;
    if (!vid) { toast('Seleccioná un vehículo', true); return; }
    DB.servicios.push({
      id: uid('srv'), vehiculoId: vid, fecha: $('#ot-fecha').value || hoy(),
      km: Number($('#ot-km').value) || null,
      tareas: $$('#ot-tareas input:checked').map(function (i) { return i.value; }),
      repuestos: [], manoObra: Number($('#ot-mano').value) || 0,
      obs: $('#ot-obs').value.trim()
    });
    guardar();
    cerrarModal();
    toast('Orden de trabajo guardada');
    refrescar();
  }

  function abrirVehiculoModal(clienteId) {
    estado.ctx = { clienteId: clienteId };
    $('#vehForm').reset();
    abrirModal('#modal-vehiculo');
  }

  function guardarVehiculo() {
    var patente = norm($('#v-patente').value);
    if (!patente) { toast('Ingresá una patente válida', true); return; }
    var v = {
      id: uid('veh'), patente: patente, marca: $('#v-marca').value.trim() || 'Sin marca',
      modelo: $('#v-modelo').value.trim() || 'Sin modelo', anio: Number($('#v-anio').value) || null,
      clienteId: estado.ctx.clienteId || null, estado: 'activo', duenos: []
    };
    DB.vehiculos.push(v);
    guardar();
    cerrarModal();
    toast('Vehículo asociado');
    abrirVehiculo(v.id);
  }

  function abrirTransfer(vehiculoId, sinTitular) {
    estado.ctx = { vehiculoId: vehiculoId };
    $('#trForm').reset();
    $('#tr-fecha').value = hoy();
    abrirModal('#modal-transfer');
  }

  function guardarTransfer() {
    var v = vehiculoPorId(estado.ctx.vehiculoId);
    if (!v) return;
    var dni = norm($('#tr-dni').value);
    var nombre = $('#tr-nombre').value.trim();
    var nuevo = clientePorDni(dni) || { id: uid('cli'), nombre: nombre, dni: dni, desde: hoy() };
    if (!clientePorDni(dni)) DB.clientes.push(nuevo);
    v.clienteId = nuevo.id;
    v.estado = 'activo';
    guardar();
    cerrarModal();
    toast('Titularidad transferida');
    refrescar();
  }

  function abrirClienteModal() {
    $('#clForm').reset();
    abrirModal('#modal-cliente');
  }
  function guardarCliente() {
    var dni = norm($('#c-dni').value);
    if (!dni) { toast('Ingresá un DNI', true); return; }
    var c = { id: uid('cli'), nombre: $('#c-nombre').value.trim(), dni: dni, desde: hoy() };
    DB.clientes.push(c);
    guardar();
    cerrarModal();
    toast('Cliente registrado');
    abrirCliente(c.id);
  }

  function abrirEliminar(kind, id) {
    estado.ctx = { eliminar: { kind: kind, id: id } };
    $('#del-title').textContent = 'Eliminar ' + kind;
    $('#del-msg').textContent = '¿Confirmás la eliminación del registro?';
    abrirModal('#modal-eliminar');
  }

  function confirmarEliminar() {
    var e = estado.ctx.eliminar;
    if (e.kind === 'cliente') DB.clientes = DB.clientes.filter(function (c) { return c.id !== e.id; });
    else DB.vehiculos = DB.vehiculos.filter(function (v) { return v.id !== e.id; });
    guardar();
    cerrarModal();
    toast('Registro eliminado');
    irAlInicio();
  }

  /* ==========================================================
     8. Escáner de Cámara + OCR (Tesseract.js)
     ========================================================== */
  var stream = null;
  var ocrSeq = 0;              /* invalida lecturas OCR huérfanas al cerrar/cambiar de modal */

  function detenerCamara() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    var vid = $('#scan-video');
    if (vid) vid.srcObject = null;
    ocrSeq++;                  /* toda OCR en curso queda descartada y no toca la UI */
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
      notaScan('Cámara no accesible en este navegador. Usá el campo manual.');
      return;
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        video.play().catch(function () {});
        msg.textContent = 'Apuntá la patente o DNI dentro del recuadro';
        notaScan('Presioná "Capturar y leer" para procesar el texto impreso en la chapa o documento.');
      })
      .catch(function () {
        msg.textContent = 'No se pudo acceder a la cámara';
        notaScan('Permiso denegado. Podés ingresar la patente o DNI manualmente abajo.');
      });
  }

  /* ==========================================================
     Carga dinámica del motor OCR (Tesseract.js v5) desde su CDN.
     - Se inyecta una sola vez: los clicks repetidos reutilizan la misma descarga.
     - cb(error) reporta el resultado; un timeout de 20 s evita dejar
       al usuario colgado si la red no responde.
     ========================================================== */
  var TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  var tesseractEstado = 'no-iniciado';   // no-iniciado | cargando | listo | error
  var tesseractCola = [];                // callbacks esperando la carga

  function cargarTesseract(cb) {
    if (window.Tesseract) { tesseractEstado = 'listo'; cb(null); return; }

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

    var script = document.createElement('script');
    script.src = TESSERACT_CDN;
    script.async = true;

    var temporizador = setTimeout(function () {
      if (window.Tesseract) { terminar(null); return; }
      terminar(new Error('timeout'));
      toast('El motor OCR tardó demasiado en descargar', true);
      notaScan('No se pudo descargar el OCR (red lenta o sin internet). Usá la lectura manual de abajo o reintentá.');
    }, 20000);

    script.onload = function () {
      clearTimeout(temporizador);
      if (window.Tesseract) terminar(null);
      else terminar(new Error('carga incompleta'));
    };
    script.onerror = function () {
      clearTimeout(temporizador);
      terminar(new Error('no se pudo descargar'));
      toast('Error al cargar el motor OCR. Verificá tu conexión a internet.', true);
      notaScan('No se pudo descargar Tesseract.js desde el CDN. Usá la lectura manual de abajo o reintentá.');
    };

    document.head.appendChild(script);
  }

  /* ==========================================================
     Captura de fotograma + OCR + búsqueda automática
     ========================================================== */
  function capturarYLeer() {
    var video = $('#scan-video');
    var msg = $('#scan-msg');

    if (!stream || !video || video.readyState < 2) {
      toast('La cámara no está activa: abrí el escáner de nuevo.', true);
      return;
    }

    /* Cada lectura tiene un número de turno: si el usuario cierra el
       modal a mitad de camino, el resultado tardío se descarta. */
    ocrSeq++;
    var turno = ocrSeq;

    /* 1) Fotograma actual del <video> dibujado en un canvas interno.
       Se limita el tamaño (ancho máx. 1600 px) para que el OCR no arrastre. */
    var ancho = video.videoWidth || 640;
    var alto = video.videoHeight || 480;
    var escala = Math.min(1, 1600 / ancho);
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(ancho * escala);
    canvas.height = Math.round(alto * escala);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    /* 2) Motor OCR: cargar (una vez) y reconocer con progreso en vivo */
    msg.textContent = 'Preparando el motor de lectura (OCR)…';

    cargarTesseract(function (err) {
      if (turno !== ocrSeq) return;          /* se cerró el escáner mientras tanto */
      if (err) {
        msg.textContent = 'No se pudo cargar el OCR';
        $('#scan-manual').focus();
        return;
      }

      window.Tesseract.recognize(canvas, 'eng', {
        logger: function (m) {
          if (turno !== ocrSeq || !m) return;
          var p = Math.round((m.progress || 0) * 100);
          if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
            msg.textContent = 'Iniciando el motor OCR… ' + p + '%';
          } else if (m.status === 'loading language traineddata') {
            msg.textContent = 'Preparando el inglés (eng)… ' + p + '%';
          } else if (m.status === 'recognizing text') {
            msg.textContent = 'Leyendo texto… ' + p + '%';
          }
        }
      }).then(function (res) {
        if (turno !== ocrSeq) return;
        var textoBruto = res && res.data ? (res.data.text || '') : '';
        var dato = extraerPatenteOTexto(textoBruto);

        /* 3) Con coincidencia limpia: cerrar, volcar en #q y buscar */
        if (dato) { usarLectura(dato); return; }

        /* 4) Lectura poco clara: guiar al usuario sin cerrar el modal */
        msg.textContent = 'Lectura poco clara';
        notaScan('No se detectó una patente o DNI legible. Enfocá de nuevo con buena luz y la chapa bien encuadrada, pulsá "Capturar y leer" otra vez, o usá la lectura manual.');
        toast('No se pudo extraer un dato claro. Probá de nuevo o usá la lectura manual.', true);
      }).catch(function (e) {
        if (turno !== ocrSeq) return;
        console.error('OCR:', e);
        msg.textContent = 'Error durante la lectura';
        notaScan('El procesamiento de imagen falló. Probá de nuevo o ingresá el dato manualmente.');
        toast('Error durante la lectura de la imagen.', true);
      });
    });
  }

  function usarLectura(val) {
    var v = String(val || '').trim();
    cerrarModal();
    if (!v) { toast('No se detectó ningún dato legible', true); return; }
    $('#q').value = v.toUpperCase();
    buscar(v, estado.tipo);
  }

  /* ==========================================================
     9. Delegación de Eventos
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
    'eliminar-registro': function (el) { abrirEliminar(el.dataset.kind, el.dataset.id); },
    'confirmar-eliminar': function () { confirmarEliminar(); },
    scan: function () { abrirEscaner(); },
    capturar: function () { capturarYLeer(); },
    'usar-manual': function () {
      var v = $('#scan-manual').value.trim();
      if (!v) { toast('Escribí un valor para buscar', true); return; }
      usarLectura(v);
    },
    'nuevo-registro': function () { abrirClienteModal(); },
    'nueva-ot': function (el) { abrirOT(el.dataset.vehiculo || null, el.dataset.cliente || null); },
    'nuevo-vehiculo': function (el) { abrirVehiculoModal(el.dataset.cliente); },
    transferir: function (el) { abrirTransfer(el.dataset.vehiculo, el.dataset.sinTitular === '1'); },
    'sin-titular': function () {
      var vs = DB.vehiculos.filter(function (v) { return !v.clienteId; });
      renderLista('vehiculos', vs, 'Vehículos sin titular');
    },
    'ver-cliente': function (el) { abrirCliente(el.dataset.cliente); },
    'ver-vehiculo': function (el) { abrirVehiculo(el.dataset.vehiculo); },
    'cerrar-modal': function () { cerrarModal(); },
    'guardar-ot': function () { guardarOT(); },
    'guardar-vehiculo': function () { guardarVehiculo(); },
    'guardar-transfer': function () { guardarTransfer(); },
    'guardar-cliente': function () { guardarCliente(); },
    tab: function (el) {
      estado.tab = el.dataset.tab;
      $$('.tab').forEach(function (t) { t.classList.toggle('active', t === el); });
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

  $('#searchForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    buscar($('#q').value, null);
  });

  document.addEventListener('submit', function (ev) { ev.preventDefault(); });

  /* Arranque */
  renderInicio();

})();