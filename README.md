# 🎬 Discord Jellyfin Bot

**[English version →](README.en.md)**

Reproduce las películas y series de tu servidor **Jellyfin** directamente en **Discord**, de dos maneras:

| Modo | Qué es | Cómo se ve |
|---|---|---|
| 🤖 **Bot** | Comandos `/play`, `/buscar`… El bot entra en tu canal de voz y emite el vídeo por **Go Live** (pantalla compartida) | Todos en el canal de voz ven el stream del bot |
| 🖥️ **Activity** | App embebida de Discord (como el YouTube Together) con navegación por la biblioteca, HLS y **sincronización watch-together** | Reproductor dentro de Discord, cada uno con su propio player pero sincronizados |

## ✨ Características

**Bot**
- `/play <nombre>` con **autocompletado** en vivo contra tu biblioteca
- Series: selector de **temporada → episodio**
- `/buscar` para explorar la biblioteca, `/estado` para ver qué suena, `/stop` para parar
- Embeds con carátula, sinopsis, duración y enlace a Jellyfin
- Desconexión automática al terminar el vídeo, calidad configurable por variables de entorno

**Activity**
- Novedades y búsqueda con carátulas
- Reproducción HLS (transcodificación de Jellyfin) con fallback a stream directo
- Selector de **pista de audio** (idiomas)
- **Watch-together**: play/pause/seek sincronizados por WebSocket entre todos los del canal

## 📋 Requisitos

- Un servidor **Jellyfin** accesible desde donde corra el bot
- **Node.js 20+** y **FFmpeg** (o simplemente **Docker**, recomendado)
- Una aplicación de Discord (gratis, se crea en 2 minutos, ver abajo)
- Para la **Activity**: una URL pública HTTPS (dominio propio, Cloudflare Tunnel, o ngrok para pruebas)

## 🔑 1. Crear la aplicación de Discord

1. Ve a https://discord.com/developers/applications → **New Application**
2. En **Bot**: pulsa **Reset Token** y guarda el token → `DISCORD_TOKEN`
3. En **General Information**: copia el **Application ID** → `DISCORD_CLIENT_ID`
4. (Solo para la Activity) En **OAuth2**: copia el **Client Secret** → `DISCORD_CLIENT_SECRET`
5. Invita el bot a tu servidor con esta URL (sustituye `TU_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=TU_CLIENT_ID&scope=bot%20applications.commands&permissions=3198464
```

No hace falta activar ningún *privileged intent*.

## ⚙️ 2. Configuración

```bash
git clone https://github.com/nemesbak/discord-jellyfin-bot.git
cd discord-jellyfin-bot
cp .env.example .env
# edita .env con tus valores
```

La API key de Jellyfin se crea en **Panel de control → API Keys**.

## 🐳 3a. Instalación con Docker (recomendado)

```bash
docker compose up -d --build
```

Esto levanta dos contenedores:
- `discord-jellyfin-bot` — el bot (incluye FFmpeg)
- `discord-jellyfin-activity` — el servidor de la Activity en el puerto `3001`

Si solo quieres el bot:

```bash
docker compose up -d --build jellyfin-bot
```

## 💻 3b. Instalación manual (Node)

Necesitas `ffmpeg` en el PATH y herramientas de compilación (para `sodium-native`).

```bash
# Bot
npm install
npm start

# Activity (opcional, en otra terminal)
cd activity
npm install
npm run build
npm start
```

## 🖥️ 4. Configurar la Activity (opcional)

La Activity necesita que Discord cargue tu servidor por **HTTPS público**:

1. Publica el puerto `3001` en una URL HTTPS. Opciones:
   - **Reverse proxy** (Caddy/Nginx/Traefik) con tu dominio
   - **Cloudflare Tunnel** (gratis, sin abrir puertos)
   - **ngrok** para probar: `ngrok http 3001`
2. En el portal de Discord → tu app → **Activities** → habilítalas
3. En **Activities → URL Mappings**: mapea `/` (root) a tu URL pública (sin `https://`)
4. En un canal de voz, pulsa el icono de 🚀 **Actividades** y elige tu app

## 🎮 Comandos del bot

| Comando | Descripción |
|---|---|
| `/play <nombre>` | Busca y reproduce en tu canal de voz (con autocompletado). Series → eliges temporada y episodio |
| `/buscar <nombre>` | Busca en la biblioteca sin reproducir |
| `/estado` | Muestra qué se está reproduciendo y desde cuándo |
| `/stop` | Detiene la reproducción y desconecta el bot |

> El bot emite **una reproducción a la vez** (una conexión de voz por bot). Si alguien lanza `/play` mientras hay otra emisión, la anterior se detiene.

## ☁️ ¿Puedo desplegarlo en Vercel?

**No, y es importante entender por qué.** Vercel (y Netlify, Cloudflare Pages…) son plataformas *serverless*: ejecutan funciones de corta duración que responden a peticiones HTTP. Este proyecto necesita justo lo contrario:

- El **bot** mantiene una conexión WebSocket permanente con el gateway de Discord, una conexión de voz UDP y procesos **FFmpeg** de larga duración — nada de eso puede vivir en una función serverless.
- La **Activity** necesita WebSockets persistentes (sincronización watch-together) y hace de proxy de vídeo en streaming, ambos incompatibles con el modelo serverless de Vercel.

**Alternativas reales para tenerlo 24/7:**

| Opción | Coste | Notas |
|---|---|---|
| **Tu propio servidor / NAS / Raspberry Pi** | 0 € | La mejor opción: normalmente el bot debe estar en la misma red que Jellyfin de todos modos. `docker compose up -d` y listo |
| **Oracle Cloud Always Free** | 0 € | VM ARM gratuita generosa (4 OCPU / 24 GB). Necesitarás que tu Jellyfin sea accesible desde fuera |
| **VPS barato** (Hetzner, Contabo…) | ~4 €/mes | Igual que Oracle pero sin lista de espera |

> ⚠️ Si el bot corre fuera de tu casa, `JELLYFIN_URL` debe ser accesible desde internet (dominio + HTTPS o VPN/tunnel). El vídeo viaja de Jellyfin → bot → Discord, así que la máquina del bot necesita buen ancho de banda de subida.

## 🔧 Solución de problemas

- **El bot entra al canal pero no se ve vídeo** → comprueba que FFmpeg está instalado (en Docker ya viene) y que `JELLYFIN_URL` es accesible *desde el contenedor* (prueba `docker exec discord-jellyfin-bot node -e "fetch(process.env.JELLYFIN_URL).then(r=>console.log(r.status))"`).
- **Vídeo a tirones** → baja `STREAM_BITRATE_KBPS` o la resolución en el `.env`; el cuello de botella suele ser la subida de la red donde corre el bot.
- **La Activity se queda en "Esperando Discord…"** → revisa el URL Mapping en el portal (debe apuntar a la raíz de tu servidor de Activity) y que la URL sea HTTPS válida.
- **No hay audio en la Activity** → usa el botón de reintento que aparece; algunos códecs de audio fuerzan el fallback a stream directo.

## ⚠️ Aviso

La emisión de vídeo en canales de voz usa endpoints de Discord **no documentados oficialmente** (vía [`@dank074/discord-video-stream`](https://github.com/dank074/Discord-video-stream)). Funciona, pero Discord podría cambiarlo en cualquier momento. Úsalo con tu propio contenido y bajo tu responsabilidad.

## 📄 Licencia

[MIT](LICENSE)
