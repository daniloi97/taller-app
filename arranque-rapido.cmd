@echo off
rem ============================================================
rem  Historia Clinica Vehicular - arranque rapido (Windows)
rem  1. crea .env desde .env.example si no existe
rem  2. instala dependencias (solo la primera vez)
rem  3. aplica schema.sql  +  levanta la API
rem  Equivalente a: npm run arranque
rem ============================================================
setlocal
cd /d "%~dp0"

rem -- Node portable en ubicacion fija (si no hay Node en el sistema) --
if exist "C:\Users\cuky_\tools\node-v22.23.3-win-x64\node.exe" (
  set "PATH=C:\Users\cuky_\tools\node-v22.23.3-win-x64;%PATH%"
)

if not exist .env (
  echo [setup] Creando .env desde .env.example...
  copy /y .env.example .env >nul
)

if not exist node_modules (
  echo [setup] Instalando dependencias...
  call npm install --no-audit --no-fund || goto :fallo
)

echo [setup] Aplicando schema.sql...
call npm run setup || goto :fallo

echo [api] Arrancando servidor...
call npm start
goto :fin

:fallo
echo.
echo [setup] FALLO: revisa el mensaje de error de arriba.

:fin
endlocal
