// HomeStream Cine — cliente de la Activity (v5, 2026-11-22)
import { DiscordSDK } from '@discord/embedded-app-sdk';
import Hls from 'hls.js';

const P = location.hostname.endsWith('discordsays.com') ? '/.proxy' : '';
let S = '';
const A = ruta => `${P}${ruta}${ruta.includes('?') ? '&' : '?'}s=${encodeURIComponent(S)}`;
const $ = id => document.getElementById(id);
const movil = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const api = ruta => fetch(A(ruta)).then(r => (r.ok ? r.json() : Promise.reject(r.status)));
const img = (id, tipo = 'Primary', w = 400) => A(`/api/jellyfin/image/${id}?type=${tipo}&width=${w}`);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const limpio = s => String(s ?? '').replace(/[\[{][^\]}\[{]*(?:tmdb|imdb|tvdb)[^\]}\[{]*[\]}]/gi, '').replace(/\s{2,}/g, ' ').trim();
const hm = ticks => { const m = Math.round((ticks ?? 0) / 6e8); return m ? (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`) : ''; };
const reloj = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
function aviso(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.append(d); setTimeout(() => d.remove(), 3100); }

let sdk = null;
try {
  $('loading').querySelector('p').textContent = 'Conectando con Discord…';
  const { clientId, preview } = await fetch(P + '/api/config').then(r => r.json());
  if (!(preview && !P)) {
    sdk = new DiscordSDK(clientId);
    await Promise.race([sdk.ready(), new Promise((_, no) => setTimeout(() => no(new Error('Discord no responde')), 10000))]);
  }
  const ses = await fetch(P + '/api/sesion', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                               body: JSON.stringify({ instanceId: sdk ? sdk.instanceId : 'preview' }) })
    .then(r => r.json()).catch(() => ({ error: 'No se pudo conectar con HomeStream.' }));
  if (!ses.s) throw new Error(ses.error || 'Sin acceso');
  S = ses.s;
  arrancar();
} catch (e) {
  $('loading').querySelector('.spinner').remove();
  $('loading').querySelector('p').textContent = e.message;
}

function arrancar() {
  // ── sincronización con el resto del canal ────────────────────────────────
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${P}/ws?s=${encodeURIComponent(S)}`);
  let sincronizando = false;
  const enviar = m => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  ws.addEventListener('message', ({ data }) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'gente') { document.querySelectorAll('.gente b').forEach(b => (b.textContent = m.n)); return; }
    sincronizando = true;
    if (m.type === 'load') { reproducir({ Id: m.itemId, Name: m.title, sub: m.sub }, 0, false, false); aviso('Alguien ha puesto ' + m.title); }
    if (m.type === 'sync') reproducir({ Id: m.itemId, Name: m.title, sub: m.sub }, m.t, m.paused, false);
    if (m.type === 'play') { video.currentTime = m.t; video.play().catch(pedirToque); }
    if (m.type === 'pause') { video.currentTime = m.t; video.pause(); }
    if (m.type === 'seek') video.currentTime = m.t;
    setTimeout(() => (sincronizando = false), 200);
  });

  // ── navegación ───────────────────────────────────────────────────────────
  const vistas = ['v-inicio', 'v-buscar', 'v-ficha'];
  const pila = [];
  function ir(v, guardar = true) {
    const actual = vistas.find(x => !$(x).classList.contains('hidden'));
    if (guardar && actual && actual !== v) pila.push(actual);
    vistas.forEach(x => $(x).classList.toggle('hidden', x !== v));
    $('btn-atras').classList.toggle('hidden', v === 'v-inicio');
    $(v).scrollTop = 0;
  }
  function atras() { ir(pila.pop() || 'v-inicio', false); if (!$('v-buscar').classList.contains('hidden')) return; $('q').value = ''; }
  $('btn-atras').onclick = atras;
  $('btn-inicio').onclick = () => { pila.length = 0; $('q').value = ''; ir('v-inicio', false); };

  function tarjeta(it) {
    const b = document.createElement('button');
    b.className = 'tarjeta';
    const tipo = it.Type === 'Series' ? 'SERIE' : '';
    b.innerHTML = `<div class="cartel"><span class="sin">${esc(limpio(it.Name))}</span>
      <img loading="lazy" alt="" src="${img(it.Id, 'Primary', 300)}" onerror="this.remove()">${tipo ? `<span class="etiqueta">${tipo}</span>` : ''}</div>
      <div class="nom">${esc(limpio(it.Name))}</div><div class="sub">${it.ProductionYear ?? ''}</div>`;
    b.onclick = () => ficha(it.Id);
    return b;
  }

  function fila(titulo, items) {
    if (!items?.length) return;
    const f = document.createElement('section');
    f.className = 'fila';
    f.innerHTML = `<h2>${esc(titulo)}</h2><button class="flecha izq" aria-label="Anteriores">‹</button><div class="carril"></div><button class="flecha der" aria-label="Siguientes">›</button>`;
    const c = f.querySelector('.carril');
    items.forEach(it => c.append(tarjeta(it)));
    f.querySelector('.izq').onclick = () => c.scrollBy({ left: -c.clientWidth * .8 });
    f.querySelector('.der').onclick = () => c.scrollBy({ left: c.clientWidth * .8 });
    $('filas').append(f);
  }

  function metaHTML(d) {
    return [d.ProductionYear, d.Type === 'Series' ? (d.ChildCount ? `${d.ChildCount} temporada${d.ChildCount > 1 ? 's' : ''}` : 'Serie') : hm(d.RunTimeTicks),
            d.OfficialRating ? `<span class="chip">${esc(d.OfficialRating)}</span>` : '',
            d.CommunityRating ? `<span class="nota">★ ${d.CommunityRating.toFixed(1)}</span>` : '']
      .filter(Boolean).map(x => `<span>${x}</span>`).join('');
  }

  async function inicio() {
    const [pelis, series, top] = await Promise.all([
      api('/api/jellyfin/recent?type=Movie').catch(() => []),
      api('/api/jellyfin/recent?type=Series').catch(() => []),
      api('/api/jellyfin/top?type=Movie').catch(() => []),
    ]);
    const destacada = top[Math.floor(Math.random() * Math.min(top.length, 8))] || pelis[0];
    if (destacada) {
      const d = await api(`/api/jellyfin/item/${destacada.Id}`).catch(() => destacada);
      $('hero').innerHTML = `<div class="hero-fondo" style="background-image:url('${img(d.Id, 'Backdrop', 1600)}')"></div>
        <div class="hero-info">
          ${d.hasLogo ? `<img class="hero-logo" alt="${esc(limpio(d.Name))}" src="${img(d.Id, 'Logo', 600)}">` : `<h1>${esc(limpio(d.Name))}</h1>`}
          <div class="meta">${metaHTML(d)}</div>
          <p>${esc(d.Overview ?? '')}</p>
          <div class="acciones"><button class="boton" id="hero-ver">▶ Ver juntos</button><button class="boton-sec" id="hero-info">ⓘ Más info</button></div>
        </div>`;
      $('hero-ver').onclick = () => reproducir(d, 0, false, true);
      $('hero-info').onclick = () => ficha(d.Id);
    } else $('hero').remove();
    fila('Películas recién añadidas', pelis);
    fila('Series con capítulos nuevos', series);
    fila('Las mejor valoradas de los últimos años', top.filter(t => t.Id !== destacada?.Id));
  }

  // ── búsqueda ─────────────────────────────────────────────────────────────
  let tBuscar;
  $('q').addEventListener('input', () => {
    clearTimeout(tBuscar);
    const q = $('q').value.trim();
    if (!q) { ir('v-inicio', false); return; }
    tBuscar = setTimeout(async () => {
      if ($('v-buscar').classList.contains('hidden')) ir('v-buscar');
      $('buscar-titulo').textContent = `Resultados de «${q}»`;
      const r = await api(`/api/jellyfin/search?q=${encodeURIComponent(q)}&limit=40`).catch(() => []);
      $('resultados').replaceChildren(...r.map(tarjeta));
      $('sin-resultados').classList.toggle('hidden', r.length > 0);
    }, 300);
  });

  // ── ficha ────────────────────────────────────────────────────────────────
  let serieActual = null, episodiosActuales = [];
  async function ficha(id) {
    ir('v-ficha');
    $('ficha-cab').innerHTML = '<div class="spinner"></div>';
    $('ficha-temporadas').classList.add('hidden');
    const d = await api(`/api/jellyfin/item/${id}`).catch(() => null);
    if (!d) { $('ficha-cab').innerHTML = '<p class="vacio">No se pudo cargar.</p>'; return; }
    const esSerie = d.Type === 'Series';
    $('ficha-cab').innerHTML = `${d.hasBackdrop ? `<div class="hero-fondo" style="background-image:url('${img(d.Id, 'Backdrop', 1600)}')"></div>` : ''}
      <div class="cartel"><img alt="" src="${img(d.Id, 'Primary', 400)}"></div>
      <div class="ficha-texto">
        ${d.hasLogo ? `<img class="hero-logo" alt="${esc(limpio(d.Name))}" src="${img(d.Id, 'Logo', 600)}">` : `<h1>${esc(limpio(d.Name))}</h1>`}
        <div class="meta">${metaHTML(d)}</div>
        ${d.Genres?.length ? `<div class="generos">${esc(d.Genres.slice(0, 4).join(' · '))}</div>` : ''}
        <p>${esc(d.Overview ?? '')}</p>
        ${esSerie ? '' : '<div class="acciones"><button class="boton" id="ficha-ver">▶ Ver juntos</button></div>'}
      </div>`;
    if (!esSerie) { $('ficha-ver').onclick = () => reproducir(d, 0, false, true); return; }
    serieActual = d;
    const temps = await api(`/api/jellyfin/seasons/${d.Id}`).catch(() => []);
    if (!temps.length) return;
    $('ficha-temporadas').classList.remove('hidden');
    $('pestanas').replaceChildren(...temps.map((t, i) => {
      const b = document.createElement('button');
      b.textContent = t.Name;
      b.onclick = () => { $('pestanas').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); temporada(t); };
      if (i === 0) setTimeout(() => b.click());
      return b;
    }));
  }

  async function temporada(t) {
    $('episodios').innerHTML = '<div class="spinner" style="margin:20px auto"></div>';
    episodiosActuales = await api(`/api/jellyfin/episodes/${serieActual.Id}?seasonId=${t.Id}`).catch(() => []);
    $('episodios').replaceChildren(...episodiosActuales.map(e => {
      const b = document.createElement('button');
      b.className = 'ep';
      b.innerHTML = `<div class="ep-img"><img loading="lazy" alt="" src="${img(e.Id, 'Primary', 400)}" onerror="this.remove()"></div>
        <div><div class="ep-t"><span>${e.IndexNumber ?? ''}</span>${esc(limpio(e.Name))}</div>
        <div class="ep-m">${hm(e.RunTimeTicks)}</div><div class="ep-o">${esc(e.Overview ?? '')}</div></div>`;
      b.onclick = () => reproducir(episodio(e), 0, false, true);
      return b;
    }));
    if (!episodiosActuales.length) $('episodios').innerHTML = '<p class="vacio">Esta temporada no tiene episodios.</p>';
  }
  const episodio = e => ({ Id: e.Id, Name: limpio(serieActual?.Name), sub: `T${e.ParentIndexNumber ?? '?'} · E${e.IndexNumber ?? '?'} · ${limpio(e.Name)}` });

  // ── reproductor ──────────────────────────────────────────────────────────
  const video = $('video'), player = $('v-player');
  let hls = null, actual = null, audioIdx = null, directo = false;

  function fuente(id, desde = 0, pausado = false) {
    if (hls) { hls.destroy(); hls = null; }
    $('p-error').classList.add('hidden');
    $('p-spinner').classList.remove('hidden');
    const listo = () => {
      $('p-spinner').classList.add('hidden');
      if (desde) video.currentTime = desde;
      if (!pausado) video.play().catch(pedirToque);
    };
    const hlsUrl = A(`/api/jellyfin/hls/${id}${audioIdx != null ? `?audioIndex=${audioIdx}` : ''}`);
    if (!directo && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, maxBufferLength: 40, backBufferLength: 30 });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.once(Hls.Events.MANIFEST_PARSED, listo);
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else fallo();
      });
    } else {
      video.src = directo || !video.canPlayType('application/vnd.apple.mpegurl') ? A(`/api/jellyfin/stream/${id}`) : hlsUrl;
      video.addEventListener('loadedmetadata', listo, { once: true });
    }
  }
  function fallo() { $('p-spinner').classList.add('hidden'); $('p-error').classList.remove('hidden'); }
  video.addEventListener('error', () => video.error && fallo());
  $('p-directo').onclick = () => { directo = true; fuente(actual.Id, video.currentTime); };

  async function reproducir(item, desde = 0, pausado = false, avisar = true) {
    actual = item; audioIdx = null; directo = false;
    $('p-nombre').textContent = limpio(item.Name);
    $('p-sub').textContent = item.sub ?? '';
    player.classList.remove('hidden');
    despertar();
    fuente(item.Id, desde, pausado);
    pistas(item.Id);
    siguienteVisible();
    if (avisar) enviar({ type: 'load', itemId: item.Id, title: limpio(item.Name), sub: item.sub ?? '' });
    if (movil) orientacion(3);
  }

  function cerrar() {
    video.pause();
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src'); video.load();
    player.classList.add('hidden');
    salirPantalla();
    if (movil) orientacion(1);
  }
  $('p-volver').onclick = cerrar;

  // pistas de audio
  async function pistas(id) {
    $('menu-audio').classList.add('hidden');
    const t = await api(`/api/jellyfin/mediainfo/${id}`).catch(() => []);
    if (t.length < 2) return;
    const def = t.find(x => x.isDefault) ?? t[0];
    audioIdx = def.index;
    $('p-audio-txt').textContent = def.language?.toUpperCase() || 'Audio';
    $('lista-audio').replaceChildren(...t.map(x => {
      const b = document.createElement('button');
      b.textContent = x.title; b.classList.toggle('on', x.index === def.index);
      b.onclick = () => {
        $('lista-audio').classList.add('hidden');
        if (x.index === audioIdx) return;
        audioIdx = x.index;
        $('lista-audio').querySelectorAll('button').forEach(y => y.classList.toggle('on', y === b));
        $('p-audio-txt').textContent = x.language?.toUpperCase() || 'Audio';
        fuente(actual.Id, video.currentTime, video.paused);
      };
      return b;
    }));
    $('menu-audio').classList.remove('hidden');
  }
  $('p-audio').onclick = e => { e.stopPropagation(); $('lista-audio').classList.toggle('hidden'); };
  document.addEventListener('click', () => $('lista-audio').classList.add('hidden'));

  // siguiente episodio
  function siguiente() {
    const i = episodiosActuales.findIndex(e => e.Id === actual?.Id);
    return i >= 0 ? episodiosActuales[i + 1] : null;
  }
  function siguienteVisible() { $('p-siguiente').classList.toggle('hidden', !siguiente()); }
  $('p-siguiente').onclick = () => { const s = siguiente(); if (s) reproducir(episodio(s), 0, false, true); };
  video.addEventListener('ended', () => { const s = siguiente(); if (s) setTimeout(() => reproducir(episodio(s), 0, false, true), 1500); });

  // controles
  function pedirToque() { $('p-grande').classList.remove('hidden'); }
  $('p-grande').onclick = e => { e.stopPropagation(); $('p-grande').classList.add('hidden'); video.play(); };
  const alternar = () => (video.paused ? video.play().catch(pedirToque) : video.pause());
  $('p-play').onclick = alternar;
  video.addEventListener('click', () => { if (!movil) alternar(); });
  video.addEventListener('dblclick', pantalla);
  $('p-menos').onclick = () => (video.currentTime -= 10);
  $('p-mas').onclick = () => (video.currentTime += 10);
  $('p-vol').onclick = () => { video.muted = !video.muted; $('p-vol').textContent = video.muted ? '🔇' : '🔊'; };

  video.addEventListener('play', () => { $('p-play').textContent = '❚❚'; $('p-grande').classList.add('hidden'); if (!sincronizando) enviar({ type: 'play', t: video.currentTime }); despertar(); });
  video.addEventListener('pause', () => { $('p-play').textContent = '▶'; if (!sincronizando) enviar({ type: 'pause', t: video.currentTime }); despertar(true); });
  video.addEventListener('seeked', () => { if (!sincronizando) enviar({ type: 'seek', t: video.currentTime }); });
  video.addEventListener('waiting', () => $('p-spinner').classList.remove('hidden'));
  video.addEventListener('playing', () => $('p-spinner').classList.add('hidden'));

  // barra de progreso
  const barra = $('barra');
  video.addEventListener('timeupdate', pintar);
  video.addEventListener('progress', pintar);
  function pintar() {
    const d = video.duration || 0, t = video.currentTime;
    $('t-actual').textContent = reloj(t);
    $('t-total').textContent = reloj(d);
    if (!d) return;
    const pc = t / d * 100;
    $('barra-hecho').style.width = pc + '%';
    $('barra-bola').style.left = pc + '%';
    const b = video.buffered;
    if (b.length) $('barra-buffer').style.width = (b.end(b.length - 1) / d * 100) + '%';
  }
  const posicion = e => { const r = barra.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  barra.addEventListener('pointermove', e => {
    const p = posicion(e);
    $('barra-tip').classList.remove('hidden');
    $('barra-tip').style.left = p * 100 + '%';
    $('barra-tip').textContent = reloj(p * (video.duration || 0));
  });
  barra.addEventListener('pointerleave', () => $('barra-tip').classList.add('hidden'));
  barra.addEventListener('pointerdown', e => {
    barra.setPointerCapture(e.pointerId); barra.classList.add('arrastra');
    const mover = ev => { $('barra-hecho').style.width = posicion(ev) * 100 + '%'; $('barra-bola').style.left = posicion(ev) * 100 + '%'; };
    const soltar = ev => {
      barra.classList.remove('arrastra');
      barra.removeEventListener('pointermove', mover);
      if (video.duration) video.currentTime = posicion(ev) * video.duration;
    };
    barra.addEventListener('pointermove', mover);
    barra.addEventListener('pointerup', soltar, { once: true });
  });

  // controles que se esconden solos
  let tQuieto;
  function despertar(fijo = false) {
    player.classList.remove('quieto');
    clearTimeout(tQuieto);
    if (!fijo) tQuieto = setTimeout(() => { if (!video.paused) player.classList.add('quieto'); }, 3000);
  }
  ['pointermove', 'pointerdown', 'keydown'].forEach(ev => player.addEventListener(ev, () => despertar(video.paused)));
  player.addEventListener('touchstart', () => { if (player.classList.contains('quieto')) despertar(); }, { passive: true });

  // pantalla completa: dentro de Discord casi siempre la da Discord con su botón; si el navegador deja, también la pedimos
  function pantalla() {
    if (document.fullscreenElement) return salirPantalla();
    const p = player.requestFullscreen?.() ?? player.webkitRequestFullscreen?.();
    Promise.resolve(p).catch(() => aviso('Usa el botón de pantalla completa de Discord, abajo a la derecha de la actividad'));
    if (!p) aviso('Usa el botón de pantalla completa de Discord, abajo a la derecha de la actividad');
  }
  function salirPantalla() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  $('p-full').onclick = pantalla;
  function orientacion(estado) {
    sdk?.commands?.setOrientationLockState?.({ lock_state: estado, picture_in_picture_lock_state: estado, grid_lock_state: estado }).catch(() => {});
  }

  // teclado
  document.addEventListener('keydown', e => {
    if (player.classList.contains('hidden') || e.target.tagName === 'INPUT') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); alternar(); }
    if (e.key === 'ArrowLeft') video.currentTime -= 10;
    if (e.key === 'ArrowRight') video.currentTime += 10;
    if (e.key === 'f') pantalla();
    if (e.key === 'm') $('p-vol').click();
    if (e.key === 'Escape' && !document.fullscreenElement) cerrar();
  });

  $('loading').remove();
  $('app').classList.remove('hidden');
  inicio();
}
