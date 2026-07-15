# 🎬 Discord Jellyfin Bot

**[Versión en español →](README.md)**

Play movies and TV shows from your **Jellyfin** server directly in **Discord**, in two ways:

| Mode | What it is |
|---|---|
| 🤖 **Bot** | Slash commands (`/play`, `/buscar`…). The bot joins your voice channel and streams the video via **Go Live** |
| 🖥️ **Activity** | Discord embedded app with library browsing, HLS playback, audio-track selection and **watch-together sync** over WebSocket |

## Features

- `/play <name>` with live **autocomplete** against your library
- TV shows: **season → episode** picker
- `/buscar` (search), `/estado` (now playing), `/stop`
- Rich embeds with poster, synopsis, runtime and Jellyfin link
- Auto-disconnect when the video ends; stream quality configurable via env vars
- Activity: recent items, search, HLS with direct-stream fallback, audio-track selector, watch-together play/pause/seek sync

## Requirements

- A **Jellyfin** server reachable from wherever the bot runs
- **Node.js 20+** and **FFmpeg** — or just **Docker** (recommended)
- A Discord application (free)
- For the **Activity**: a public HTTPS URL (own domain, Cloudflare Tunnel, or ngrok for testing)

## Setup

1. Create an app at https://discord.com/developers/applications — grab the **Bot Token**, **Application ID**, and (Activity only) the **OAuth2 Client Secret**.
2. Invite the bot: `https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=3198464`
3. Configure:

```bash
git clone https://github.com/nemesbak/discord-jellyfin-bot.git
cd discord-jellyfin-bot
cp .env.example .env   # fill in your values
```

4. Run with Docker (bot + activity):

```bash
docker compose up -d --build
```

Or manually: `npm install && npm start` (bot, needs ffmpeg in PATH), and in `activity/`: `npm install && npm run build && npm start`.

5. **Activity only**: expose port `3001` over public HTTPS, enable Activities in the Discord portal, and set **URL Mappings** root `/` to your public URL.

## Can I deploy this on Vercel?

**No.** Vercel is serverless: short-lived HTTP functions. This project needs a persistent Discord gateway WebSocket, a UDP voice connection, long-running FFmpeg processes, and persistent WebSockets for watch-together sync. Run it 24/7 on your own server/NAS/Raspberry Pi (best option — it usually needs LAN access to Jellyfin anyway), an Oracle Cloud Always Free VM, or a cheap VPS.

## Disclaimer

Video streaming in voice channels uses officially **undocumented** Discord endpoints (via [`@dank074/discord-video-stream`](https://github.com/dank074/Discord-video-stream)). Use with your own content, at your own risk.

## License

[MIT](LICENSE)
