import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, JELLYFIN_URL, JELLYFIN_API_KEY, PORT = 3001 } = process.env;
const JF   = (JELLYFIN_URL ?? '').replace(/\/$/, '');
const JF_H = { 'X-Emby-Authorization': `MediaBrowser Client="DiscordActivity", Device="Server", DeviceId="activity001", Version="1.0.0", Token="${JELLYFIN_API_KEY}"` };

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });
app.use(express.json());
app.use(express.static(join(__dirname, '../dist')));

const JF_FIELDS = 'Overview,ProductionYear,RunTimeTicks,Genres';

app.get('/api/config', (_req, res) => res.json({ clientId: DISCORD_CLIENT_ID }));

app.post('/api/token', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });
  try {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code }),
    });
    res.json({ access_token: (await r.json()).access_token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Novedades
app.get('/api/jellyfin/recent', async (req, res) => {
  const params = new URLSearchParams({
    SortBy: 'DateCreated', SortOrder: 'Descending',
    IncludeItemTypes: 'Movie,Series', Recursive: 'true',
    Limit: '30', Fields: JF_FIELDS,
  });
  try {
    const r = await fetch(`${JF}/Items?${params}`, { headers: JF_H });
    res.json((await r.json()).Items ?? []);
  } catch { res.status(502).json([]); }
});

// Busqueda
app.get('/api/jellyfin/search', async (req, res) => {
  const { q = '', limit = 24 } = req.query;
  const params = new URLSearchParams({ searchTerm: q, IncludeItemTypes: 'Movie,Series', Recursive: 'true', Limit: String(limit), Fields: JF_FIELDS });
  try {
    const r = await fetch(`${JF}/Items?${params}`, { headers: JF_H });
    res.json((await r.json()).Items ?? []);
  } catch { res.status(502).json([]); }
});

// Temporadas
app.get('/api/jellyfin/seasons/:id', async (req, res) => {
  try {
    const r = await fetch(`${JF}/Shows/${req.params.id}/Seasons?Fields=Overview&api_key=${JELLYFIN_API_KEY}`, { headers: JF_H });
    res.json((await r.json()).Items ?? []);
  } catch { res.status(502).json([]); }
});

// Episodios
app.get('/api/jellyfin/episodes/:id', async (req, res) => {
  const { seasonId } = req.query;
  const params = new URLSearchParams({ Fields: 'Overview,RunTimeTicks', SeasonId: seasonId ?? '', api_key: JELLYFIN_API_KEY });
  try {
    const r = await fetch(`${JF}/Shows/${req.params.id}/Episodes?${params}`, { headers: JF_H });
    res.json((await r.json()).Items ?? []);
  } catch { res.status(502).json([]); }
});

// Imagen
app.get('/api/jellyfin/image/:id', async (req, res) => {
  const { type = 'Primary', width = 300 } = req.query;
  try {
    const r = await fetch(`${JF}/Items/${req.params.id}/Images/${type}?maxWidth=${width}`, { headers: JF_H });
    if (!r.ok) return res.status(404).end();
    res.set('Content-Type', r.headers.get('content-type') ?? 'image/jpeg');
    r.body.pipe(res);
  } catch { res.status(502).end(); }
});

// Pistas de audio de un item
app.get('/api/jellyfin/mediainfo/:id', async (req, res) => {
  try {
    const r = await fetch(`${JF}/Items/${req.params.id}?Fields=MediaSources`, { headers: JF_H });
    const data = await r.json();
    const streams = (data.MediaSources?.[0]?.MediaStreams ?? [])
      .filter(s => s.Type === 'Audio')
      .map(s => ({
        index:     s.Index,
        title:     s.DisplayTitle || [s.Language, s.Codec?.toUpperCase(), s.Channels ? s.Channels + 'ch' : ''].filter(Boolean).join(' · '),
        language:  s.Language ?? null,
        codec:     s.Codec ?? null,
        channels:  s.Channels ?? null,
        isDefault: s.IsDefault ?? false,
      }));
    res.json(streams);
  } catch { res.status(502).json([]); }
});

// HLS master playlist
app.get('/api/jellyfin/hls/:id', async (req, res) => {
  const params = new URLSearchParams({
    VideoCodec: 'h264',
    AudioCodec: 'aac',
    MaxWidth: '1920', MaxHeight: '1080',
    MaxStreamingBitrate: '20000000',
    TranscodingMaxAudioChannels: '2',
    AudioBitRate: '192000',
    MediaSourceId: req.params.id,
    api_key: JELLYFIN_API_KEY,
  });
  if (req.query.audioIndex) params.set('AudioStreamIndex', req.query.audioIndex);
  const masterUrl = `${JF}/Videos/${req.params.id}/master.m3u8?${params}`;
  try {
    const r = await fetch(masterUrl, { headers: JF_H });
    if (!r.ok) return res.status(r.status).end();
    let text = await r.text();
    // Jellyfin a veces devuelve BANDWIDTH=0 en streams live — hls.js lo rechaza
    text = text.replace(/BANDWIDTH=0,AVERAGE-BANDWIDTH=0/g, 'BANDWIDTH=2000000,AVERAGE-BANDWIDTH=2000000');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(rewriteM3u8(text, masterUrl));
  } catch { res.status(502).end(); }
});

// HLS segmentos y sub-playlists
app.get('/api/jellyfin/hls-seg', async (req, res) => {
  const u = decodeURIComponent(req.query.u ?? '');
  if (!u) return res.status(400).end();
  try {
    const r  = await fetch(u, { headers: JF_H });
    const ct = r.headers.get('content-type') ?? '';
    if (ct.includes('mpegurl') || u.includes('.m3u8')) {
      let text = await r.text();
      text = text.replace(/BANDWIDTH=0,AVERAGE-BANDWIDTH=0/g, 'BANDWIDTH=2000000,AVERAGE-BANDWIDTH=2000000');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewriteM3u8(text, u));
    } else {
      res.set('Content-Type', ct || 'video/mp2t');
      r.body.pipe(res);
    }
  } catch { res.status(502).end(); }
});

// Fallback stream directo
app.get('/api/jellyfin/stream/:id', async (req, res) => {
  const url = `${JF}/Videos/${req.params.id}/stream?static=true&api_key=${JELLYFIN_API_KEY}`;
  try {
    const headers = { ...JF_H };
    if (req.headers.range) headers['Range'] = req.headers.range;
    const r = await fetch(url, { headers });
    res.status(r.status);
    for (const [k, v] of r.headers.entries())
      if (['content-type','content-length','content-range','accept-ranges'].includes(k.toLowerCase()))
        res.set(k, v);
    r.body.pipe(res);
  } catch { res.status(502).end(); }
});

function rewriteM3u8(text, baseUrl) {
  const base = new URL(baseUrl);
  const dir  = base.origin + base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    let abs;
    if (t.startsWith('http'))   abs = t;
    else if (t.startsWith('/')) abs = base.origin + t;
    else                        abs = dir + t;
    return `/api/jellyfin/hls-seg?u=${encodeURIComponent(abs)}`;
  }).join('\n');
}

// WebSocket sync
const rooms     = new Map(); // roomId -> Set<ws>
const roomState = new Map(); // roomId -> { itemId, title, t, paused, updatedAt }

wss.on('connection', ws => {
  let roomId = null;
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      roomId = msg.roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);
      // Enviar estado actual al recién llegado
      if (roomState.has(roomId)) {
        const s = roomState.get(roomId);
        const elapsed = s.paused ? 0 : (Date.now() - s.updatedAt) / 1000;
        ws.send(JSON.stringify({
          type: 'sync', itemId: s.itemId, title: s.title,
          t: s.t + elapsed, paused: s.paused,
        }));
      }
      return;
    }

    // Actualizar estado de sala
    if (roomId) {
      const now = Date.now();
      if (msg.type === 'load')  roomState.set(roomId, { itemId: msg.itemId, title: msg.title, t: 0,     paused: false, updatedAt: now });
      else if (roomState.has(roomId)) {
        const s = roomState.get(roomId);
        if      (msg.type === 'play')  { s.t = msg.t; s.paused = false; s.updatedAt = now; }
        else if (msg.type === 'pause') { s.t = msg.t; s.paused = true;  s.updatedAt = now; }
        else if (msg.type === 'seek')  { s.t = msg.t;                   s.updatedAt = now; }
      }
    }

    // Retransmitir a los demás
    if (roomId && rooms.has(roomId)) {
      const p = JSON.stringify(msg);
      for (const peer of rooms.get(roomId))
        if (peer !== ws && peer.readyState === 1) peer.send(p);
    }
  });
  ws.on('close', () => {
    if (roomId && rooms.has(roomId)) {
      rooms.get(roomId).delete(ws);
      if (!rooms.get(roomId).size) {
        rooms.delete(roomId);
        roomState.delete(roomId);
      }
    }
  });
});

server.listen(PORT, () => console.log(`Activity server :${PORT}`));
