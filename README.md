# 🔧 Historia Clínica Vehicular · Taller Mecánico

> **Gestión inteligente de talleres mecánicos con escáner neuronal de patentes (ALPR) en el navegador y arquitectura desacoplada.**

![Node.js ≥18](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Vanilla JS](https://img.shields.io/badge/Vanilla%20JS-ES2017%2B-F7DF1E?logo=javascript&logoColor=black)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-3.30%2B-003B57?logo=sqlite&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-12%2B-4169E1?logo=postgresql&logoColor=white)
![ONNX Runtime](https://img.shields.io/badge/ONNX%20Runtime-Web-5C2D91)
[![Licencia](https://img.shields.io/badge/Licencia-MIT-green)](./LICENSE)
![Estado](https://img.shields.io/badge/Estado-pre--deploy%20·%20Fase%205-blue)

---

## 🧠 ¿Qué es Historia Clínica Vehicular?

Es la **historia clínica de un auto, llevada al taller mecánico**. Igual que un
paciente tiene una ficha médica que atraviesa todas sus visitas, cada vehículo
acá tiene una **ficha viva**: quién lo tuvo a su nombre durante cuánto tiempo,
qué se le hizo en cada visita, qué repuestos se usaron y cuánto anduvo su
odómetro. Nada se pierde, nada se pisa, todo queda trazado.

- 📛 Cada **transferencia de titularidad** genera un *snapshot inmutable* del dueño saliente — se puede borrar un cliente y el historial del vehículo sobrevive.
- 📈 El **kilometraje es confiable**: las órdenes actualizan el odómetro hacia arriba, nunca hacia atrás.
- 🚙 Un vehículo puede quedar **"Propietario desconocido"** y seguir recibiendo servicio.
- 📷 La cámara del taller escanea la patente y el sistema abre la ficha automáticamente.

### 🔁 El circuito del taller en un vistazo

```
   📷 RECEPCIÓN RÁPIDA          🚗 FICHA DEL VEHÍCULO           🧾 ÓRDENES DE TRABAJO
   ┌─────────────────┐        ┌──────────────────────┐        ┌────────────────────────┐
   │ Cámara del celu │        │ Titular actual       │        │ Tareas + mano de obra  │
   │ escanea la      │  ────▶ │ Dueños históricos    │  ────▶ │ Repuestos y precios    │
   │ patente (ALPR   │        │ Km · estado · patente│        │ Km actualizado solo    │
   │ neuronal local) │        │ Historia completa 📬 │        │ Todo queda trazado ✅  │
   └─────────────────┘        └──────────────────────┘        └────────────────────────┘
```

---

## ✨ Funcionalidades Principales

### 📷 Reconocimiento Automático de Patentes (ALPR)
Con la cámara del celular o la tablet se escanea la chapa y una red neuronal
detecta la patente y lee los caracteres — **todo procesado 100 % en el
dispositivo**: ninguna foto del taller viaja a un servidor externo, ni en
desarrollo ni en producción. Modelos livianos (~15 MB, servidos desde el
propio proyecto) con YOLOv9 como detector y un OCR entrenado específicamente
para patentes argentinas (Mercosur y antiguo formato). *Nota: el motor
ONNX Runtime Web se carga del CDN en la primera visita — para despliegues
100 % offline puede vendorizarse junto a los pesos (ver
[Documentación Técnica](./DOCUMENTACION_TECNICA.md), § 5.3).*

### 🔍 Búsqueda Dual e Historial Transparente
Un solo cuadro de búsqueda entiende **patente o DNI** sin cambiar de modo.
Vehículos sin titular a la vista, dueños de cada paso con sus fechas y
"autos que tuvo a su nombre" por cliente. La etiqueta "histórico" es registro
con fecha, no archivo muerto.

### 🛠️ Gestión de Órdenes de Trabajo
Cada visita al taller queda como una orden con desglose claro:
**tareas + mano de obra + repuestos (nombre, cantidad, precio)**. El
kilometraje del vehículo se actualiza automáticamente con lo declarado
en la orden, y el detalle completo se puede reabrir y editar.

### 🔐 Acceso Seguro y Flexible
Ingresá con **email + contraseña** o con un **código OTP de 6 dígitos por
WhatsApp** (válido 5 minutos, con protección anti-abuso). Contraseñas con
mínimo de seguridad, bloqueo ante intentos fallidos, y recuperación de cuenta
por enlace de email o por WhatsApp. Tu sesión viaja firmada (JWT) durante 30 días.

> 📞 **Formato del celular (Argentina):** elegí el prefijo fijo **+54 9** y
> escribí **10 dígitos: código de área y número, sin el 0 ni el 15**
> (ej.: `1123456789`). Con eso el sistema te garantiza un OTP correcto.

### 🎨 Interfaz Responsiva e Inclusiva
Diseñada **mobile-first**: se piensa para el mostrador del taller, escalando
para tablet y escritorio. Modo claro y oscuro con conmutación persistente,
formularios con mensajes de error en el campo (sin "sorpresas" al enviar),
y confirmaciones de contraseña con ojo de visibilidad.

---

## 🧰 Stack Tecnológico

| Capa | Tecnología | Por qué |
|---|---|---|
| **Frontend** | Vanilla JS (ES2017+, IIFE) · HTML5 · CSS3 mobile-first | Cero frameworks, cero bundler: arranque instantáneo incluso con red floja |
| **IA en el cliente** | ONNX Runtime Web (WebGL/Wasm) · YOLOv9 + OCR local | Inferencia en el dispositivo: el escáner no depende de la nube ni sube fotos |
| **Backend** | Node.js · Express (API REST `/api/v1`) · JWT · Helmet | Autenticación segura, cabeceras duras y errores homogéneos y humanos |
| **Base de datos** | SQLite (WAL, desarrollo/VPS) · PostgreSQL 12+ (producción gestionada) | Un único esquema portable que corre idéntico en ambos motores |

> 🔬 **¿Querés la arquitectura interna, el diccionario de datos SQL y el
> catálogo completo de endpoints?** Toda la profundidad técnica está consignada
> en la **[Documentación Técnica Oficial →](./DOCUMENTACION_TECNICA.md)**.

---

## 🚀 Guía de Inicio Rápido

### Requisitos previos
- **Node.js v18 o superior** — lo verificás con `node --version`.

### 1 · Cloná e instalá
```bash
git clone https://github.com/daniloi97/taller-app.git historia-clinica-vehicular
cd historia-clinica-vehicular
npm run arranque        # aplica el esquema y levanta la API en :3000
```
El script crea tu `.env` desde `.env.example`, aplica el esquema de la base
de datos y arranca la API en **http://localhost:3000**.

### 2 · Abrí la app
Serví el front con cualquier servidor estático, desde la carpeta del proyecto:
```bash
npx serve .             # o python -m http.server 8800, lo que tengas a mano
```
En `localhost` el front autodetecta la API (`http://localhost:3000/api/v1`).
> 💡 **Abrilo con `http://localhost:8800`**, con `localhost` y no `127.0.0.1`:
> la detección de la API en desarrollo se ancla al host de la página,
> y vía `127.0.0.1` el front buscaría la API mal y daría "sin conexión".

Registrate con **email** o con **celular (+54 9)** y listo: escaneo de
patentes ✅, búsqueda dual ✅, órdenes de trabajo ✅.

### 3 · Windows con un solo click 🪟
Doble click en **`arranque-rapido.cmd`**: crea tu `.env`, instala
dependencias la primera vez, aplica el esquema y levanta la API —
con Node portable si no lo tenés instalado.

> 💡 Salud del servidor: abrí **http://localhost:3000/api/v1/health**
> y deberías ver un `{"ok":true}` mínimo (sin datos de la base; Fase 5 · C3).

---

## 📚 Documentación Extendida y Licencia

Para consultar la **arquitectura interna, el diccionario de datos SQL, la
matriz de límites de seguridad y el catálogo de endpoints de la API**, revisá
la documentación oficial del proyecto:

### 📖 [DOCUMENTACION_TECNICA.md →](./DOCUMENTACION_TECNICA.md)

| Recurso | Qué encontrás ahí |
|---|---|
| [Documentación Técnica](./DOCUMENTACION_TECNICA.md) | Arquitectura 3 capas · esquema de BD completo · API REST · roadmap pre-deploy |
| [models/](./models/README.txt) | Detalle de los modelos neuronales (shapes, licencias de terceros) |
| [scripts/](./scripts) | Baterías de QA automatizado (162 verificaciones verdes) |

**Créditos:** proyecto desarrollado por **daniloi97** 🇦🇷 — con modelos ALPR
de código abierto de los proyectos [fast-alpr](https://github.com/ankandrew/fast-alpr)
y [fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr)
(MIT / Apache-2.0).

**Licencia:** MIT — mirá el archivo [`LICENSE`](./LICENSE).

---

<div align="center">

**Historia Clínica Vehicular** · la historia de tu auto, en un solo lugar 📚🔧

_Si te sirve, dejale una ⭐ al repositorio._

</div>
