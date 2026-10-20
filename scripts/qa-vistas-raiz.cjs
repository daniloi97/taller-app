/* ============================================================================
   scripts/qa-vistas-raiz.cjs — QA estática del refactor "Conmutación de
   Vistas Raíz" (Enfoque B) + F5 (parte estructural).

   Qué valida (sin navegador, sólo lectura de los archivos):
     1. index.html tiene las dos vistas raíz hermana en el <body>:
        #vista-login y #vista-app con la clase .vista-raiz.
     2. los modales y los toasts viven DENTRO de #vista-app.
     3. ya no existe la arquitectura vieja: ni .login-vista overlay ni el
        atributo [hidden]/role="dialog" en la vista de login, ni .sin-sesion.
     4. styles.css define las reglas de conmutación demandadas:
        .vista-raiz{display:none!important...} y
        .vista-raiz.activa{display:flex!important; flex-direction:column}.
        con #vista-login centrado SIN z-index ni fondos de superposición.
     5. app.js conmuta con .activa (mostrarLogin / mostrarApp), ya no toca
        .hidden de la vista raíz de login, el botón Enter de #login-taller
        verifica el OTP (F2) y emite el log de sesión (F4).

   Uso:   node scripts/qa-vistas-raiz.cjss   (o npm-agnostic con node fijo)
   Sale 0 si todo está en verde; 1 con la lista de fallos.
   ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(RAIZ, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(RAIZ, 'app.js'), 'utf8');

let ok = 0, mal = 0;
function check(nombre, cond) {
  if (cond) { ok++; console.log('OK   ' + nombre); }
  else { mal++; console.log('FALLA ' + nombre); }
}

/* 1) dos vistas raíz hermanas en el body */
check('index.html: #vista-login presente con clase vista-raiz',
  /<section[^>]*\bvista-raiz\b[^>]*id="vista-login"/.test(html));
check('index.html: #vista-app presente con clase vista-raiz',
  /<div[^>]*\bvista-raiz\b[^>]*id="vista-app"/.test(html));

/* 2) modales + toasts DENTRO de #vista-app (orden índice en el archivo) */
const iApp = html.indexOf('id="vista-app"');
const iCierreApp = html.indexOf('<!-- /#vista-app -->');
check('index.html: #vista-app abre antes que los modales',
  iApp > 0 && html.indexOf('id="modal-ot"', iApp) > iApp);
check('index.html: modal-ot queda dentro de #vista-app',
  iApp > 0 && html.indexOf('id="modal-ot"', iApp) > iApp && html.indexOf('id="modal-ot"', iApp) < iCierreApp);
check('index.html: modal-scan queda dentro de #vista-app',
  iApp > 0 && html.indexOf('id="modal-scan"', iApp) > iApp && html.indexOf('id="modal-scan"', iApp) < iCierreApp);
check('index.html: #toasts queda dentro de #vista-app',
  iApp > 0 && html.indexOf('id="toasts"', iApp) > iApp && html.indexOf('id="toasts"', iApp) < iCierreApp);

/* 3) la arquitectura vieja desapareció */
check('index.html: ya no existe .login-vista (overlay modal)', !html.includes('login-vista'));
check('index.html: la vista login ya no es role="dialog" con aria-modal',
  !/<section[^>]*vista-login[^>]*role="dialog"/.test(html) &&
  !/<section[^>]*vista-login[\s\S]{0,80}?aria-modal/.test(html));
check('styles.css: ya no existe el bloque .login-vista del overlay', !css.includes('.login-vista'));
check('styles.css: se eliminó body.sin-sesion', !css.includes('sin-sesion'));
check('app.js: removido body.classList sin-sesion', !js.includes('sin-sesion'));
check('app.js: ya no existe #login-vista (id viejo)', !js.includes("login-vista"));
check('app.js: la vista login raíz ya no se conmuta por atributo hidden',
  !/v-login'\)\s*\.\s*hidden/.test(js));

/* 4) reglas de conmutación de vistas raíz (specc-performance) */
check('styles.css: .vista-raiz{display:none!important} presente',
  /\.vista-raiz\s*\{[^}]*display\s*:\s*none\s*!important/.test(css));
check('styles.css: .vista-raiz lleva min-height:100vh',
  /\.vista-raiz\s*\{[^}]*min-height\s*:\s*100vh/.test(css));
check('styles.css: .vista-raiz.activa{display:flex!important; flex-direction:column} presente',
  /\.vista-raiz\.activa\s*\{[^}]*display\s*:\s*flex\s*!important[^}]*flex-direction\s*:\s*column/.test(css));
check('styles.css: #vista-login centrado sin z-index de overlay',
  /#vista-login\s*\{[^}]*align-items\s*:\s*center[^}]*justify-content\s*:\s*center/.test(css) &&
  !/#vista-login\s*\{[^}]*z-index/.test(css));

/* 5) conmutación de sesión en app.js (F2 / F4)
   El contenido de cada función se mide por ventana (decl → +500 chars). */
const winLogin = js.slice(js.indexOf('function mostrarLogin'), js.indexOf('function mostrarLogin') + 500);
const winApp = js.slice(js.indexOf('function mostrarApp'), js.indexOf('function mostrarApp') + 500);

check('app.js: mostrarLogin activa #vista-login y desactiva #vista-app',
  /login\.classList\.add\('activa'\)/.test(winLogin) && /app\.classList\.remove\('activa'\)/.test(winLogin));
check('app.js: mostrarApp activa #vista-app y desactiva #vista-login',
  /app\.classList\.add\('activa'\)/.test(winApp) && /login\.classList\.remove\('activa'\)/.test(winApp));
check('app.js: ambas funciones leen las dos vistas raíz',
  winLogin.includes("$('#vista-login')") && winLogin.includes("$('#vista-app')") &&
  winApp.includes("$('#vista-login')") && winApp.includes("$('#vista-app')"));
check('app.js (F2): keydown Enter en #login-taller dispara login-verificar',
  /login-taller'\)\.addEventListener\('keydown'[\s\S]{0,120}?key === 'Enter'[\s\S]{0,120}?login-verificar/.test(js));
check('app.js (F4): console.info al verificar el OTP',
  js.includes("console.info('[auth] Token guardado y sesión iniciada')"));
check('app.js: el boot activa la vista según el token',
  /tokenSesion\(\)\)\s*\{\s*mostrarLogin\(\)[\s\S]{0,200}\}\s*else\s*\{[\s\S]{0,120}?mostrarApp\(\)/.test(js));

console.log('\nRESULTADO: ' + (mal ? 'ROJO (' + mal + ' fallos)' : 'GREEN') + ' — ' + ok + ' checks OK');
process.exit(mal ? 1 : 0);
