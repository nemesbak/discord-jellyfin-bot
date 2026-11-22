import { DiscordSDK } from '@discord/embedded-app-sdk';
import Hls from 'hls.js';

const P = location.hostname.endsWith('discordsays.com') ? '/.proxy' : '';
let S = '';
const A = ruta => `${P}${ruta}${ruta.includes('?') ? '&' : '?'}s=${encodeURIComponent(S)}`;
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Limpia nombres de Jellyfin que incluyen metadatos en el propio texto
function cleanTitle(s) {
  return String(s ?? '')
    .replace(/[\[{][^\]}\[{]*(?:tmdb|imdb|tvdb)[^\]}\[{]*[\]}]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function setStatus(msg) {
  const p = document.querySelector('#loading p');
  if (p) p.textContent = msg;
}

function sdkReadyWithTimeout(sdk, ms = 8000) {
  return Promise.race([
    sdk.ready(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('SDK timeout')), ms)),
  ]);
}

try {
  setStatus('Obteniendo config…');
  const { clientId } = await fetch(P + '/api/config').then(r => r.json());
  const sdk = new DiscordSDK(clientId);
  setStatus('Esperando Discord…');
  try { await sdkReadyWithTimeout(sdk); } catch { /* sin sync de canal */ }

  // Sesión: el servidor comprueba con Discord que esta actividad es real y de nuestro servidor
  setStatus('Comprobando acceso…');
  const ses = await fetch(P + '/api/sesion', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                               body: JSON.stringify({ instanceId: sdk.instanceId }) })
    .then(r => r.json()).catch(() => ({ error: 'No se pudo conectar con el servidor.' }));
  if (!ses.s) throw new Error(ses.error || 'Sin acceso');
  S = ses.s;

  // WebSocket sync (una sala por instancia de la actividad)
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws      = new WebSocket(`${wsProto}://${location.host}${P}/ws?s=${encodeURIComponent(S)}`);
  let isSyncing = false;
  ws.addEventListener('message', ({ data }) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    isSyncing = true;
    if (msg.type === 'load')  loadVideo(msg.itemId, msg.title, false);
    if (msg.type === 'sync')  loadVideo(msg.itemId, msg.title, false, msg.t, msg.paused);
    if (msg.type === 'play')  { video.currentTime = msg.t; tryPlay(); }
    if (msg.type === 'pause') { video.currentTime = msg.t; video.pause(); }
    if (msg.type === 'seek')  { video.currentTime = msg.t; }
    setTimeout(() => { isSyncing = false; }, 150);
  });
  function broadcast(msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  // ── Video ────────────────────────────────────────────────────────────────
  const video         = document.getElementById('video');
  const videoErr      = document.getElementById('video-error');
  const videoWrap     = document.getElementById('video-wrap');
  const tapToPlay     = document.getElementById('tap-to-play');
  const audioWarn     = document.getElementById('audio-warn');
  const audioSelector = document.getElementById('audio-selector');
  const audioMenu     = document.getElementById('audio-menu');
  const audioBtn      = document.getElementById('audio-btn');
  const audioLabel    = document.getElementById('audio-label');
  let hls             = null;
  let audioCheckTimer = null;
  let currentItemId   = null;
  let currentAudioIndex = null;

  // Detecta si lleva >4s reproduciendo sin audio y avisa
  function startAudioCheck() {
    clearTimeout(audioCheckTimer);
    audioCheckTimer = setTimeout(() => {
      const noAudio = (
        (typeof video.webkitAudioDecodedByteCount !== 'undefined' && video.webkitAudioDecodedByteCount === 0) ||
        (video.audioTracks && video.audioTracks.length === 0)
      );
      if (noAudio && !video.paused && video.currentTime > 2) {
        audioWarn.classList.remove('hidden');
      }
    }, 4000);
  }
  function clearAudioWarn() {
    clearTimeout(audioCheckTimer);
    audioWarn.classList.add('hidden');
  }

  video.addEventListener('playing', () => {
    clearAudioWarn();
    startAudioCheck();
  });

  document.getElementById('audio-retry').addEventListener('click', () => {
    if (!currentItemId) return;
    audioWarn.classList.add('hidden');
    if (hls) { hls.destroy(); hls = null; }
    video.src = A(`/api/jellyfin/stream/${currentItemId}`);
    tryPlay();
  });

  function tryPlay() {
    return video.play().then(() => {
      tapToPlay.classList.add('hidden');
    }).catch(err => {
      // Autoplay bloqueado → mostrar overlay para que el usuario inicie
      if (err?.name !== 'AbortError') tapToPlay.classList.remove('hidden');
    });
  }

  tapToPlay.addEventListener('click', () => {
    tapToPlay.classList.add('hidden');
    video.play().catch(err => {
      console.error('[play]', err, video.error);
      // Si el video tiene un error de media real, mostrarlo
      if (video.error || err?.name === 'NotSupportedError') {
        videoErr.classList.remove('hidden');
      } else {
        tapToPlay.classList.remove('hidden');
      }
    });
  });

  // Listener de error nativo del elemento video
  video.addEventListener('error', () => {
    if (video.error) {
      console.error('[video error]', video.error.code, video.error.message);
      tapToPlay.classList.add('hidden');
      videoErr.classList.remove('hidden');
    }
  });

  video.addEventListener('playing', () => tapToPlay.classList.add('hidden'));

  // ── Selector de pistas de audio ──────────────────────────────────────────
  function closeAudioMenu() {
    audioMenu.classList.add('hidden');
    audioSelector.classList.remove('open');
  }

  audioBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !audioMenu.classList.contains('hidden');
    if (isOpen) {
      closeAudioMenu();
    } else {
      audioMenu.classList.remove('hidden');
      audioSelector.classList.add('open');
    }
  });

  document.addEventListener('click', () => closeAudioMenu());
  audioMenu.addEventListener('click', e => e.stopPropagation());

  async function loadAudioTracks(itemId) {
    audioSelector.classList.add('hidden');
    audioMenu.innerHTML = '';
    currentAudioIndex = null;
    audioLabel.textContent = 'Audio';

    let tracks;
    try {
      tracks = await fetch(A(`/api/jellyfin/mediainfo/${itemId}`)).then(r => r.json());
    } catch { return; }

    if (!tracks || tracks.length < 2) return;

    audioSelector.classList.remove('hidden');

    const defaultTrack = tracks.find(t => t.isDefault) ?? tracks[0];
    currentAudioIndex = defaultTrack.index;
    audioLabel.textContent = defaultTrack.title;

    for (const track of tracks) {
      const opt = document.createElement('div');
      opt.className = 'track-option' + (track.index === defaultTrack.index ? ' active' : '');
      opt.setAttribute('role', 'option');
      opt.textContent = track.title;
      opt.addEventListener('click', () => {
        if (track.index === currentAudioIndex) { closeAudioMenu(); return; }
        currentAudioIndex = track.index;
        audioLabel.textContent = track.title;
        audioMenu.querySelectorAll('.track-option').forEach(el => el.classList.remove('active'));
        opt.classList.add('active');
        closeAudioMenu();
        reloadWithAudio(track.index);
      });
      audioMenu.appendChild(opt);
    }
  }

  function reloadWithAudio(audioIndex) {
    if (!currentItemId) return;
    const t      = video.currentTime;
    const paused = video.paused;
    if (hls) { hls.destroy(); hls = null; }
    clearAudioWarn();
    const src = A(`/api/jellyfin/hls/${currentItemId}?audioIndex=${audioIndex}`);
    const onReady = () => {
      video.currentTime = t;
      if (paused) video.pause(); else tryPlay();
    };
    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: false, maxBufferLength: 30 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, onReady);
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) {
          console.error('[hls fatal reloadAudio]', d.type, d.details);
          hls.destroy(); hls = null;
          video.src = A(`/api/jellyfin/stream/${currentItemId}`);
          video.currentTime = t;
          tapToPlay.classList.remove('hidden');
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.addEventListener('loadedmetadata', onReady, { once: true });
    }
  }

  // ── Cargar vídeo ─────────────────────────────────────────────────────────
  function loadVideo(itemId, title, shouldBroadcast = true, startAt = null, startPaused = false) {
    showView('player');
    document.getElementById('now-playing-title').textContent = title;
    videoErr.classList.add('hidden');
    tapToPlay.classList.add('hidden');
    clearAudioWarn();
    closeAudioMenu();
    currentItemId = itemId;
    currentAudioIndex = null;
    if (hls) { hls.destroy(); hls = null; }

    loadAudioTracks(itemId);

    const src = A(`/api/jellyfin/hls/${itemId}`);
    const onReady = () => {
      if (startAt !== null) video.currentTime = startAt;
      if (startPaused) video.pause(); else tryPlay();
    };

    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: false, maxBufferLength: 30 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, onReady);
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) {
          console.error('[hls fatal loadVideo]', d.type, d.details);
          hls.destroy(); hls = null;
          video.src = A(`/api/jellyfin/stream/${itemId}`);
          if (startAt !== null) video.currentTime = startAt;
          tapToPlay.classList.remove('hidden');
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.addEventListener('loadedmetadata', onReady, { once: true });
    } else {
      video.src = A(`/api/jellyfin/stream/${itemId}`);
      video.addEventListener('canplay', onReady, { once: true });
    }
    if (shouldBroadcast) broadcast({ type: 'load', itemId, title });
  }

  video.addEventListener('play',   () => { if (!isSyncing) broadcast({ type: 'play',  t: video.currentTime }); });
  video.addEventListener('pause',  () => { if (!isSyncing) broadcast({ type: 'pause', t: video.currentTime }); });
  video.addEventListener('seeked', () => { if (!isSyncing) broadcast({ type: 'seek',  t: video.currentTime }); });

  // ── Fullscreen ────────────────────────────────────────────────────────────
  let isFs = false;
  const fsBtn = document.getElementById('fs-btn');

  function requestFs() {
    const el = videoWrap;
    return (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.() ?? Promise.reject());
  }
  function exitFs() {
    return (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.() ?? Promise.reject());
  }

  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      exitFs().catch(() => {});
    } else {
      requestFs().catch(() => {
        isFs = !isFs;
        videoWrap.classList.toggle('fullscreen', isFs);
        fsBtn.textContent = isFs ? '✕' : '⛶';
      });
    }
  });

  const onFsChange = () => {
    const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    fsBtn.textContent = inFs ? '✕' : '⛶';
    if (!inFs) { isFs = false; videoWrap.classList.remove('fullscreen'); }
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // ── Navegación ────────────────────────────────────────────────────────────
  let currentSeries = null;
  const views = ['home','seasons','episodes','player'];
  function showView(name) {
    views.forEach(v => document.getElementById(`view-${v}`).classList.toggle('hidden', v !== name));
  }

  document.getElementById('back-btn').addEventListener('click', () => {
    video.pause();
    if (hls) { hls.destroy(); hls = null; }
    videoWrap.classList.remove('fullscreen');
    isFs = false;
    closeAudioMenu();
    showView(currentSeries ? 'episodes' : 'home');
  });
  document.getElementById('back-to-seasons').addEventListener('click', () => showView('seasons'));
  document.getElementById('back-to-home').addEventListener('click', () => { currentSeries = null; showView('home'); });

  // ── Temporadas ────────────────────────────────────────────────────────────
  async function showSeasons(item) {
    currentSeries = item;
    item._cleanName = cleanTitle(item.Name);
    document.getElementById('series-title').textContent = item._cleanName;
    showView('seasons');
    const seasons = await fetch(A(`/api/jellyfin/seasons/${item.Id}`)).then(r => r.json()).catch(() => []);
    const list = document.getElementById('seasons-list');
    list.innerHTML = '';
    for (const s of seasons) {
      const div = document.createElement('div');
      div.className = 'season-card';
      div.innerHTML = `<div class="season-num">${s.IndexNumber ?? '?'}</div>
        <div><div class="season-name">${esc(s.Name)}</div>
        <div class="season-meta">${s.ChildCount ? s.ChildCount + ' episodios' : ''}</div></div>`;
      div.addEventListener('click', () => showEpisodes(item, s));
      list.appendChild(div);
    }
  }

  // ── Episodios ─────────────────────────────────────────────────────────────
  async function showEpisodes(series, season) {
    document.getElementById('season-title').textContent = `${series.Name} — ${season.Name}`;
    showView('episodes');
    const eps = await fetch(A(`/api/jellyfin/episodes/${series.Id}?seasonId=${season.Id}`)).then(r => r.json()).catch(() => []);
    const list = document.getElementById('episodes-list');
    list.innerHTML = '';
    for (const ep of eps) {
      const div = document.createElement('div');
      div.className = 'ep-item';
      const num = ep.IndexNumber != null ? `E${String(ep.IndexNumber).padStart(2, '0')} · ` : '';
      div.innerHTML = `<div class="ep-play">▶</div>
        <div class="ep-info">
          <div class="ep-name">${num}${esc(ep.Name)}</div>
          <div class="ep-meta">${ep.RunTimeTicks ? fmtTime(ep.RunTimeTicks) : ''}</div>
          ${ep.Overview ? `<div class="ep-overview">${esc(ep.Overview)}</div>` : ''}
        </div>`;
      div.addEventListener('click', () => loadVideo(ep.Id, `${series._cleanName ?? cleanTitle(series.Name)} — ${cleanTitle(ep.Name)}`));
      list.appendChild(div);
    }
  }

  // ── Búsqueda ──────────────────────────────────────────────────────────────
  const searchInput   = document.getElementById('search-input');
  const searchClear   = document.getElementById('search-clear');
  const homeContent   = document.getElementById('home-content');
  const searchContent = document.getElementById('search-content');
  let searchTimeout   = null;

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    searchClear.classList.toggle('hidden', !q);
    clearTimeout(searchTimeout);
    if (!q) {
      homeContent.classList.remove('hidden');
      searchContent.classList.add('hidden');
      return;
    }
    homeContent.classList.add('hidden');
    searchContent.classList.remove('hidden');
    searchTimeout = setTimeout(() => doSearch(q), 350);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input'));
    if (!isMobile) searchInput.focus();
  });

  async function doSearch(q) {
    const grid      = document.getElementById('search-results');
    const noResults = document.getElementById('no-results');
    grid.innerHTML  = '<div class="center-msg">Buscando…</div>';
    noResults.classList.add('hidden');
    const items = await fetch(A(`/api/jellyfin/search?q=${encodeURIComponent(q)}&limit=30`)).then(r => r.json()).catch(() => []);
    renderGrid(grid, noResults, items);
  }

  function renderGrid(grid, noResults, items) {
    grid.innerHTML = '';
    if (!items.length) { noResults.classList.remove('hidden'); return; }
    noResults.classList.add('hidden');
    for (const item of items) grid.appendChild(buildCard(item));
  }

  function buildCard(item) {
    const name  = cleanTitle(item.Name);
    const year  = item.ProductionYear ? `(${item.ProductionYear})` : '';
    // Evitar año duplicado si ya está en el nombre limpio
    const label = (year && !name.includes(year)) ? `${name} ${year}` : name;
    const badge = item.Type === 'Movie'
      ? '<span class="card-badge badge-movie">Película</span>'
      : '<span class="card-badge badge-series">Serie</span>';
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <img src="${A(`/api/jellyfin/image/${item.Id}`)}" alt="" loading="lazy" onerror="this.style.minHeight='120px'">
      <div class="card-overlay">
        <div class="card-title">${esc(label)}</div>
        ${badge}
      </div>`;
    card.addEventListener('click', () => {
      if (item.Type === 'Series') showSeasons(item);
      else loadVideo(item.Id, label);
    });
    return card;
  }

  // ── Novedades ─────────────────────────────────────────────────────────────
  async function loadRecent() {
    const grid = document.getElementById('recent-grid');
    grid.innerHTML = '<div class="center-msg">Cargando…</div>';
    const items = await fetch(A('/api/jellyfin/recent')).then(r => r.json()).catch(() => []);
    grid.innerHTML = '';
    for (const item of items) grid.appendChild(buildCard(item));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtTime(ticks) {
    const s = ticks / 10_000_000;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`;
  }

  // ── Arrancar ──────────────────────────────────────────────────────────────
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
  showView('home');
  loadRecent();
  if (!isMobile) searchInput.focus();

} catch (err) {
  document.querySelector('#loading p').textContent = 'ERROR: ' + err.message;
  console.error('[activity]', err);
}
