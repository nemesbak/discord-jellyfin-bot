// Servidor de la Discord Activity «Jellyfin» (v4, 2026-11-22).
// - Solo funciona dentro de una Activity real de nuestro servidor de Discord: el cliente manda su instanceId,
//   lo comprobamos con la API de Discord (bot de la app) y damos una sesión firmada de 12 h.
// - Proxy a Jellyfin solo hacia JELLYFIN_URL (antes era un proxy abierto a cualquier URL).
// - Jellyfin 12 solo acepta la cabecera «Authorization: MediaBrowser Token=…» (api_key en la URL da 401).
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Readable } from 'stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Opcional: claves desde un archivo montado (ENV_FILE), para no ponerlas en la plantilla. ENV_MAP=destino:origen,...
if (process.env.ENV_FILE && fs.existsSync(process.env.ENV_FILE)) {
  const f = Object.fromEntries(fs.readFileSync(process.env.ENV_FILE, 'utf8').split(/\r?\n/)
    .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^["']|["']$/g, '')]));
  for (const par of (process.env.ENV_MAP ?? '').split(',').filter(Boolean)) {
    const [dst, src] = par.split(':');
    if (!process.env[dst] && f[src]) process.env[dst] = f[src];
  }
}
const E = (k, d) => (process.env[k] ?? d ?? '').trim();
const CLIENT_ID = E('DISCORD_CLIENT_ID');
const BOT_TOKEN = E('DISCORD_BOT_TOKEN');
const GUILDS    = E('DISCORD_GUILDS').split(',').map(s => s.trim()).filter(Boolean);
const SECRET    = E('SESSION_SECRET');
const JF        = E('JELLYFIN_URL').replace(/\/$/, '');
const JF_KEY    = E('JELLYFIN_API_KEY');
const PORT      = +E('PORT', '3001');
const MAX_BITRATE = E('MAX_BITRATE', '8000000');
const PREVIEW = E('PREVIEW') === '1';   // solo para probar fuera de Discord en la red local; NUNCA en el contenedor público
for (const [k, v] of Object.entries({ CLIENT_ID, BOT_TOKEN, SECRET, JF, JF_KEY }))
  if (!v) { console.error(`✗ Falta ${k}`); process.exit(1); }

const JF_H = { Authorization: `MediaBrowser Client="Discord Activity", Device="Servidor", DeviceId="discord-activity", Version="4.0.0", Token="${JF_KEY}"` };
const JF_ORIGIN = new URL(JF).origin;

// ── sesiones firmadas (sin base de datos) ───────────────────────────────────
const firmar = d => crypto.createHmac('sha256', SECRET).update(d).digest('base64url');
function nuevaSesion(instanceId, userIds) {
  const d = Buffer.from(JSON.stringify({ i: instanceId, u: userIds, e: Date.now() + 12 * 3600e3 })).toString('base64url');
  return `${d}.${firmar(d)}`;
}
function leerSesion(s) {
  if (!s || typeof s !== 'string') return null;
  const [d, f] = s.split('.');
  if (!d || !f || f.length !== 43) return null;
  if (!crypto.timingSafeEqual(Buffer.from(f), Buffer.from(firmar(d)))) return null;
  const v = JSON.parse(Buffer.from(d, 'base64url').toString());
  return v.e > Date.now() ? v : null;
}

const cacheMiembros = new Map();   // uid -> { t, ok }
async function esMiembro(uid) {
  if (!/^\d{5,25}$/.test(String(uid))) return false;
  const c = cacheMiembros.get(uid);
  if (c && c.t > Date.now() - 600e3) return c.ok;
  let ok = false;
  for (const g of GUILDS) {
    const r = await fetch(`https://discord.com/api/v10/guilds/${g}/members/${uid}`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
    if (r.ok) { ok = true; break; }
  }
  cacheMiembros.set(uid, { t: Date.now(), ok });
  return ok;
}

// Comprueba con Discord que la instancia existe, es de esta app y está en uno de nuestros servidores
const cacheInst = new Map();
async function instanciaValida(instanceId) {
  if (!/^[\w-]{4,80}$/.test(instanceId ?? '')) return null;
  const c = cacheInst.get(instanceId);
  if (c && c.t > Date.now() - 60e3) return c.v;
  const r = await fetch(`https://discord.com/api/v10/applications/${CLIENT_ID}/activity-instances/${encodeURIComponent(instanceId)}`,
                        { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
  let v = null;
  if (r.ok) {
    const d = await r.json();
    const guild = d.location?.guild_id;
    if (!GUILDS.length || GUILDS.includes(guild)) v = { guild, users: d.users ?? [] };
    // en privado (MD con el bot o grupo): vale si TODOS los que están son miembros de nuestro servidor
    else if (!guild && GUILDS.length && (d.users ?? []).length) {
      let todos = true;
      for (const u of d.users) if (!(await esMiembro(u))) { todos = false; break; }
      if (todos) v = { guild: GUILDS[0], users: d.users, privado: true };
    }
  }
  cacheInst.set(instanceId, { t: Date.now(), v });
  return v;
}

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ noServer: true });
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
// Discord a veces entrega las rutas con el prefijo /.proxy
app.use((req, _res, next) => { if (req.url.startsWith('/.proxy/')) req.url = req.url.slice(7); next(); });
app.use(express.static(join(__dirname, '../dist'), { maxAge: '1h', index: 'index.html' }));

app.get('/api/config', (_req, res) => res.json({ clientId: CLIENT_ID, preview: PREVIEW }));

app.post('/api/sesion', async (req, res) => {
  try {
    if (PREVIEW && req.body?.instanceId === 'preview') return res.json({ s: nuevaSesion('preview', []) });
    const v = await instanciaValida(req.body?.instanceId);
    if (!v) return res.status(403).json({ error: 'Solo para miembros del servidor de HomeStream en Discord.' });
    res.json({ s: nuevaSesion(req.body.instanceId, v.users) });
  } catch (e) {
    console.error('sesion', e.message);
    res.status(502).json({ error: 'No se pudo comprobar la actividad con Discord.' });
  }
});

// todo lo de /api/jellyfin necesita sesión (?s= para que valga también en <img>, <video> y hls.js)
app.use('/api/jellyfin', (req, res, next) => {
  const s = leerSesion(req.query.s || req.get('x-sesion'));
  if (!s) return res.status(401).json({ error: 'Sesión caducada: vuelve a abrir la actividad.' });
  req.sesion = req.query.s || req.get('x-sesion');
  next();
});

const jf = (ruta, extra = {}) => fetch(`${JF}${ruta}`, { headers: { ...JF_H, ...extra } });
const id = v => /^[a-f0-9]{32}$/i.test(v ?? '') ? v : null;
const CAMPOS = 'Overview,ProductionYear,RunTimeTicks,Genres';

async function lista(res, ruta) {
  try {
    const r = await jf(ruta);
    res.json(r.ok ? ((await r.json()).Items ?? []) : []);
  } catch { res.status(502).json([]); }
}

// ── quién está en la sala (nombres y avatares de Discord, vía el bot) ──────
const cacheMiembro = new Map();   // guild:uid -> { t, v }
async function miembro(guild, uid) {
  const k = `${guild}:${uid}`, c = cacheMiembro.get(k);
  if (c && c.t > Date.now() - 600e3) return c.v;
  let v = { id: uid, nombre: 'Alguien', avatar: null };
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guild}/members/${uid}`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
    if (r.ok) {
      const m = await r.json();
      v = { id: uid, nombre: m.nick || m.user?.global_name || m.user?.username || 'Alguien',
            avatar: m.avatar ? `guilds/${guild}/users/${uid}/avatars/${m.avatar}` : m.user?.avatar ? `avatars/${uid}/${m.user.avatar}` : null };
    }
  } catch {}
  cacheMiembro.set(k, { t: Date.now(), v });
  return v;
}
app.get('/api/jellyfin/gente', async (req, res) => {
  const s = leerSesion(req.sesion);
  if (s.i === 'preview') return res.json([]);
  cacheInst.delete(s.i);                                   // lista fresca
  const inst = await instanciaValida(s.i).catch(() => null);
  if (!inst) return res.json([]);
  res.json(await Promise.all(inst.users.slice(0, 25).map(u => miembro(inst.guild, u))));
});
app.get('/api/jellyfin/avatar', async (req, res) => {        // los avatares pasan por aquí (Discord no deja cargar su CDN dentro de la actividad)
  const p = String(req.query.p ?? '');
  if (!/^(avatars\/\d+\/\w+|guilds\/\d+\/users\/\d+\/avatars\/\w+)$/.test(p)) return res.status(400).end();
  try {
    const r = await fetch(`https://cdn.discordapp.com/${p}.png?size=64`);
    if (!r.ok) return res.status(404).end();
    res.set('Content-Type', 'image/png').set('Cache-Control', 'private, max-age=86400');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

app.get('/api/jellyfin/recent', (req, res) => lista(res, `/Items?${new URLSearchParams({
  SortBy: 'DateCreated', SortOrder: 'Descending', Recursive: 'true', Limit: '30', Fields: CAMPOS,
  IncludeItemTypes: ['Movie', 'Series'].includes(req.query.type) ? req.query.type : 'Movie,Series',
  ImageTypes: 'Primary' })}`));

app.get('/api/jellyfin/top', (req, res) => lista(res, `/Items?${new URLSearchParams({
  SortBy: 'CommunityRating', SortOrder: 'Descending', Recursive: 'true', Limit: '30', Fields: CAMPOS,
  IncludeItemTypes: ['Movie', 'Series'].includes(req.query.type) ? req.query.type : 'Movie',
  MinPremiereDate: new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10), MinCommunityRating: '7',
  ImageTypes: 'Backdrop' })}`));

app.get('/api/jellyfin/item/:id', async (req, res) => {
  if (!id(req.params.id)) return res.status(400).json({});
  try {
    const d = ((await (await jf(`/Items?Ids=${req.params.id}&Fields=Overview,Genres,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,ChildCount`)).json()).Items ?? [])[0] ?? {};
    const { Id, Name, Overview, Genres, ProductionYear, RunTimeTicks, OfficialRating, CommunityRating, Type, ImageTags, BackdropImageTags, ChildCount, SeriesId, SeriesName } = d;
    res.json({ Id, Name, Overview, Genres, ProductionYear, RunTimeTicks, OfficialRating, CommunityRating, Type, ChildCount, SeriesId, SeriesName,
               hasLogo: !!ImageTags?.Logo, hasBackdrop: !!BackdropImageTags?.length });
  } catch { res.status(502).json({}); }
});

app.get('/api/jellyfin/search', (req, res) => lista(res, `/Items?${new URLSearchParams({
  searchTerm: String(req.query.q ?? '').slice(0, 100), IncludeItemTypes: 'Movie,Series', Recursive: 'true',
  Limit: String(Math.min(+req.query.limit || 24, 50)), Fields: CAMPOS })}`));

// ── explorar como en Jellyfin: bibliotecas, géneros y listado con filtros ───
const TIPOS_BIB = { movies: 'Movie', tvshows: 'Series', mixed: 'Movie,Series', homevideos: 'Movie', musicvideos: '' };
app.get('/api/jellyfin/libraries', async (_req, res) => {
  try {
    const d = await (await jf('/Library/MediaFolders')).json();
    res.json((d.Items ?? []).filter(b => (b.CollectionType ?? 'mixed') in TIPOS_BIB && TIPOS_BIB[b.CollectionType ?? 'mixed'])
      .filter(b => !/descubre|pide/i.test(b.Name))                       // biblioteca virtual de Favarr
      .map(b => ({ Id: b.Id, Name: b.Name.replace(/^\d+\.\s*/, ''), tipo: TIPOS_BIB[b.CollectionType ?? 'mixed'] })));
  } catch { res.status(502).json([]); }
});

// géneros que vienen en inglés de algunos metadatos (ya existen en castellano)
const INGLES = new Set(['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History',
  'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'Sci-Fi & Fantasy', 'Thriller', 'War', 'Western', 'Action & Adventure',
  'Kids', 'News', 'Reality', 'Soap', 'Talk', 'War & Politics', 'TV Movie', 'Sport', 'Musical', 'Biography', 'Suspense']);
const tipoOk = t => (['Movie', 'Series', 'Movie,Series'].includes(t) ? t : 'Movie,Series');
app.get('/api/jellyfin/genres', async (req, res) => {
  const p = new URLSearchParams({ SortBy: 'SortName', Recursive: 'true', IncludeItemTypes: tipoOk(req.query.type) });
  if (id(req.query.parentId)) p.set('ParentId', req.query.parentId);
  try {
    const d = await (await jf(`/Genres?${p}`)).json();
    res.json((d.Items ?? []).filter(g => !INGLES.has(g.Name)).map(g => ({ Id: g.Id, Name: g.Name })));
  } catch { res.status(502).json([]); }
});

const ORDEN = { recientes: ['DateCreated', 'Descending'], nota: ['CommunityRating,SortName', 'Descending'],
                az: ['SortName', 'Ascending'], anio: ['PremiereDate,SortName', 'Descending'], azar: ['Random', 'Ascending'] };
app.get('/api/jellyfin/browse', async (req, res) => {
  const [SortBy, SortOrder] = ORDEN[req.query.sort] ?? ORDEN.recientes;
  const p = new URLSearchParams({ SortBy, SortOrder, Recursive: 'true', IncludeItemTypes: tipoOk(req.query.type), Fields: CAMPOS,
    StartIndex: String(Math.max(0, +req.query.start || 0)), Limit: String(Math.min(+req.query.limit || 60, 100)), EnableTotalRecordCount: 'true' });
  if (id(req.query.parentId)) p.set('ParentId', req.query.parentId);
  if (id(req.query.genreId)) p.set('GenreIds', req.query.genreId);
  if (/^\d{4}$/.test(req.query.decada ?? '')) p.set('Years', Array.from({ length: 10 }, (_, i) => +req.query.decada + i).join(','));
  try {
    const d = await (await jf(`/Items?${p}`)).json();
    res.json({ items: d.Items ?? [], total: d.TotalRecordCount ?? 0 });
  } catch { res.status(502).json({ items: [], total: 0 }); }
});

app.get('/api/jellyfin/seasons/:id', (req, res) => {
  if (!id(req.params.id)) return res.status(400).json([]);
  lista(res, `/Shows/${req.params.id}/Seasons?Fields=Overview`);
});

app.get('/api/jellyfin/episodes/:id', (req, res) => {
  if (!id(req.params.id) || !id(req.query.seasonId)) return res.status(400).json([]);
  lista(res, `/Shows/${req.params.id}/Episodes?${new URLSearchParams({ Fields: 'Overview,RunTimeTicks', SeasonId: req.query.seasonId, EnableImageTypes: 'Primary,Thumb' })}`);
});

async function tubo(r, res, cabeceras = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
  res.status(r.status);
  for (const k of cabeceras) { const v = r.headers.get(k); if (v) res.set(k, v); }
  if (!r.body) return res.end();
  Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
}

app.get('/api/jellyfin/image/:id', async (req, res) => {
  if (!id(req.params.id)) return res.status(400).end();
  const tipo = ['Primary', 'Backdrop', 'Thumb', 'Logo'].includes(req.query.type) ? req.query.type : 'Primary';
  try {
    const r = await jf(`/Items/${req.params.id}/Images/${tipo}?maxWidth=${Math.min(+req.query.width || 300, 1920)}`);
    if (!r.ok) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400');
    tubo(r, res, ['content-type', 'content-length']);
  } catch { res.status(502).end(); }
});

app.get('/api/jellyfin/mediainfo/:id', async (req, res) => {
  if (!id(req.params.id)) return res.status(400).json([]);
  try {
    const d = ((await (await jf(`/Items?Ids=${req.params.id}&Fields=MediaSources`)).json()).Items ?? [])[0] ?? {};
    res.json((d.MediaSources?.[0]?.MediaStreams ?? []).filter(s => s.Type === 'Audio').map(s => ({
      index: s.Index, language: s.Language ?? null, codec: s.Codec ?? null, channels: s.Channels ?? null,
      isDefault: s.IsDefault ?? false,
      title: s.DisplayTitle || [s.Language, s.Codec?.toUpperCase(), s.Channels ? s.Channels + 'ch' : ''].filter(Boolean).join(' · '),
    })));
  } catch { res.status(502).json([]); }
});

// HLS: el master y las sub-listas se reescriben para que todo vuelva por aquí (con la sesión)
function reescribir(texto, base, s, pre = '') {   // pre: '../' desde /hls/:id, '' desde /hls-seg
  const b = new URL(base);
  return texto.replace(/BANDWIDTH=0,AVERAGE-BANDWIDTH=0/g, 'BANDWIDTH=2000000,AVERAGE-BANDWIDTH=2000000')
    .split('\n').map(l => {
      const t = l.trim();
      if (t.startsWith('#')) return l.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${pre}${seg(new URL(u, b).href, s)}"`);
      return t ? pre + seg(new URL(t, b).href, s) : l;
    }).join('\n');
}
const seg = (abs, s) => `hls-seg?u=${encodeURIComponent(abs)}&s=${encodeURIComponent(s)}`;

app.get('/api/jellyfin/hls/:id', async (req, res) => {
  if (!id(req.params.id)) return res.status(400).end();
  const p = new URLSearchParams({
    MediaSourceId: req.params.id, VideoCodec: 'h264', AudioCodec: 'aac', MaxWidth: '1920', MaxHeight: '1080',
    MaxStreamingBitrate: MAX_BITRATE, VideoBitrate: MAX_BITRATE, TranscodingMaxAudioChannels: '2', AudioBitRate: '192000',
    SegmentContainer: 'ts', PlaySessionId: crypto.createHash('sha1').update(req.sesion + req.params.id).digest('hex').slice(0, 32),
  });
  if (/^\d{1,3}$/.test(req.query.audioIndex ?? '')) p.set('AudioStreamIndex', req.query.audioIndex);
  const url = `${JF}/Videos/${req.params.id}/master.m3u8?${p}`;
  try {
    const r = await fetch(url, { headers: JF_H });
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(reescribir(await r.text(), url, req.sesion, '../'));
  } catch { res.status(502).end(); }
});

app.get('/api/jellyfin/hls-seg', async (req, res) => {
  let u;
  try { u = new URL(String(req.query.u ?? '')); } catch { return res.status(400).end(); }
  if (u.origin !== JF_ORIGIN) return res.status(403).end();       // nunca a otro sitio
  try {
    const r = await fetch(u, { headers: JF_H });
    const ct = r.headers.get('content-type') ?? '';
    if (ct.includes('mpegurl') || u.pathname.endsWith('.m3u8')) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(reescribir(await r.text(), u.href, req.sesion));
    }
    tubo(r, res);
  } catch { res.status(502).end(); }
});

app.get('/api/jellyfin/stream/:id', async (req, res) => {
  if (!id(req.params.id)) return res.status(400).end();
  try {
    const r = await jf(`/Videos/${req.params.id}/stream?static=true`, req.headers.range ? { Range: req.headers.range } : {});
    tubo(r, res);
  } catch { res.status(502).end(); }
});

// ── sincronización: una sala por instancia de la Activity ──────────────────
const salas = new Map();   // instanceId -> { socks:Set, estado }
// Cine del viernes: el bot (mismo contenedor) deja una peli puesta en pausa para cualquier cine que se abra
let destacada = null;
app.post('/api/destacada', express.json(), (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const ok = crypto.createHash('sha256').update(BOT_TOKEN).digest('hex');
  if (!/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(ip) || req.get('x-bot') !== ok) return res.status(403).end();
  const d = req.body || {};
  if (!id(d.itemId)) return res.status(400).end();
  destacada = { itemId: d.itemId, title: String(d.title ?? '').slice(0, 200), sub: String(d.sub ?? '').slice(0, 200),
                hasta: Date.now() + Math.min(Number(d.horas) || 4, 12) * 3600e3 };
  res.json({ ok: true });
});
server.on('upgrade', (req, sock, head) => {
  const u = new URL(req.url, 'http://x');
  const ruta = u.pathname.replace(/^\/\.proxy/, '');
  const s = leerSesion(u.searchParams.get('s'));
  if (ruta !== '/ws' || !s) return sock.destroy();
  wss.handleUpgrade(req, sock, head, ws => { ws.sala = s.i; wss.emit('connection', ws); });
});

wss.on('connection', ws => {
  if (!salas.has(ws.sala)) {
    const dest = destacada && destacada.hasta > Date.now()
      ? { itemId: destacada.itemId, title: destacada.title, sub: destacada.sub, t: 0, paused: true, updatedAt: Date.now() } : null;
    salas.set(ws.sala, { socks: new Set(), estado: dest, cola: [] });
  }
  const sala = salas.get(ws.sala);
  sala.socks.add(ws);
  const gente = () => { const p = JSON.stringify({ type: 'gente', n: sala.socks.size }); for (const o of sala.socks) if (o.readyState === 1) o.send(p); };
  gente();
  ws.send(JSON.stringify({ type: 'cola', cola: sala.cola }));
  if (sala.estado) {
    const e = sala.estado, pasado = e.paused ? 0 : (Date.now() - e.updatedAt) / 1000;
    ws.send(JSON.stringify({ type: 'sync', itemId: e.itemId, title: e.title, sub: e.sub, t: e.t + pasado, paused: e.paused }));
  }
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const todos = p => { for (const o of sala.socks) if (o.readyState === 1) o.send(p); };
    if (m.type === 'cola') {                       // la cola entera, la cambie quien la cambie
      if (!Array.isArray(m.cola)) return;
      sala.cola = m.cola.filter(x => id(x?.itemId)).slice(0, 50)
        .map(x => ({ itemId: x.itemId, title: String(x.title ?? '').slice(0, 200), sub: String(x.sub ?? '').slice(0, 200) }));
      return todos(JSON.stringify({ type: 'cola', cola: sala.cola }));
    }
    if (m.type === 'siguiente') {                  // terminó lo que se veía: pasa al primero de la cola (solo una vez)
      if (!sala.cola.length || (sala.estado && sala.estado.itemId !== m.desde)) return;
      const x = sala.cola.shift();
      sala.estado = { ...x, t: 0, paused: false, updatedAt: Date.now() };
      todos(JSON.stringify({ type: 'load', ...x, desdeCola: true }));
      return todos(JSON.stringify({ type: 'cola', cola: sala.cola }));
    }
    if (!['load', 'play', 'pause', 'seek'].includes(m.type)) return;
    const ahora = Date.now();
    if (m.type === 'load') { if (!id(m.itemId)) return; sala.estado = { itemId: m.itemId, title: String(m.title ?? '').slice(0, 200), sub: String(m.sub ?? '').slice(0, 200), t: 0, paused: false, updatedAt: ahora }; }
    else if (sala.estado) {
      const t = Number(m.t); if (!Number.isFinite(t)) return;
      Object.assign(sala.estado, { t, updatedAt: ahora }, m.type === 'play' ? { paused: false } : m.type === 'pause' ? { paused: true } : {});
    }
    const p = JSON.stringify(m);
    for (const o of sala.socks) if (o !== ws && o.readyState === 1) o.send(p);
  });
  ws.on('close', () => { sala.socks.delete(ws); if (!sala.socks.size) salas.delete(ws.sala); else gente(); });
});

server.listen(PORT, () => console.log(`Activity Jellyfin en :${PORT}`));
