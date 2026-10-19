Modelos ONNX para el escáner de patentes (ALPR) de la Historia Clínica Vehicular.

* yolo-v9-t-640.onnx (7.4 MB)
  Detector de patentes YOLOv9-tiny (640x640). Origen oficial:
  github.com/ankandrew/fast-alpr -> Releases -> Tag "assets".
  Entrada: "images" float32 [1,3,640,640] (RGB /255 con letterbox).
  Salida:  "output0" float32 [1,5,8400] (cx, cy, w, h en px + score), formato Ultralytics.

* arg_cnn_ocr.onnx (7.6 MB)
  Lector de caracteres entrenado especificamente para patentes
  argentinas (Mercosur + antiguas). Origen oficial:
  github.com/ankandrew/fast-plate-ocr -> Releases -> Tag "arg-plates".
  Config oficial (arg_cnn_ocr_config.yaml): 7 espacios fijos,
  alfabeto "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_", relleno "_".
  Entrada: "input" uint8 [1,70,140,1] (gris NHWC, 0..255).
  Salida:  "concatenate" float32 [1,259] (7 espacios x 37 clases).

Licencia de ambos modelos: los proyectos fast-plate-ocr y fast-alpr se
distribuyen bajo MIT / Apache-2.0 (verificar el repo al re-publicar).

Los dos modelos se cargan desde esta carpeta via fetch(): si la app se
serve por HTTP local o de red (por ejemplo `py -m http.server`), la carga
es local e instantanea y no hace falta internet para escanear.
Respaldos de red: las URLs de GitHub incluidas en app.js apuntan a estos
mismos archivos; GitHub no envia cabeceras CORS en sus release assets,
asi que sirven como referencia/documentacion o para quien corra la app
detrás de un proxy propio.
