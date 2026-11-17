# Shunel 1.0

Aplicación musical web con búsqueda de YouTube, reproductor oficial, cola, biblioteca, favoritos e historial local.

## Requisitos

- Proyecto desplegado en Vercel.
- YouTube Data API v3 habilitada en Google Cloud.
- API Key configurada como variable de entorno en Vercel con el nombre `YOUTUBE_API_KEY`.

## Instalación

1. Sube el contenido de esta carpeta a la raíz de un proyecto de Vercel.
2. En Vercel abre Settings → Environment Variables.
3. Crea `YOUTUBE_API_KEY` con tu clave de YouTube Data API v3.
4. Guarda y vuelve a desplegar.
5. Abre el dominio HTTPS de tu proyecto.

## Estructura

- `api/search.js`: endpoint servidor que consulta YouTube Data API.
- `js/search.js`: cliente de búsqueda.
- `js/player.js`: integración con YouTube IFrame API.
- `js/queue.js`: cola de reproducción.
- `js/library.js`: biblioteca, favoritos e historial.
- `js/storage.js`: persistencia local.
- `js/ui.js`: renderizado e interacción de interfaz.
- `js/app.js`: integración y eventos principales.
- `css/`: estilos de la aplicación.

## Funcionamiento

- Las búsquedas se realizan desde `/api/search`.
- La clave de YouTube se mantiene en el servidor.
- El video se reproduce en un reproductor oficial de YouTube visible en la página (no se oculta ni se extrae el audio).
- Biblioteca, favoritos, historial y cola se guardan en `localStorage` del navegador.
- Los datos locales no se sincronizan entre dispositivos ni navegadores.

## Límites conocidos

- La reproducción depende de que YouTube permita insertar el video. Algunos videos pueden estar bloqueados por región, edad, derechos o configuración del canal.
- La reproducción automática puede estar limitada por el navegador o por YouTube.
- La barra de progreso y los controles dependen de la disponibilidad de la IFrame API.
- La cuota de YouTube Data API v3 se aplica a las búsquedas.
- La cola se conserva localmente, pero la pista actual no se restaura automáticamente tras recargar.
- No incluye letras, radio algorítmica ni recomendaciones automáticas en esta versión.

## Seguridad

No guardes la API Key en HTML, JavaScript del navegador ni `localStorage`. Configura restricciones de API y cuota en Google Cloud. La clave de servidor debe estar únicamente en las variables de entorno de Vercel.
