/* ==========================================================================
   X96Q Launcher — « tvOS Signature »
   Zones verticales : 'top' (Paramètres) → 'dock' (Favoris) → 'apps' (Toutes)
   Entrée unique : window.onRemoteKey(nom, repeat), appelée par MainActivity.kt
   (et par le clavier dans un navigateur, pour l'aperçu).
   ========================================================================== */
(function () {
  'use strict';

  var STAGE_W = 1920;
  var STAGE_H = 1080;
  var PAD_X = 68;

  // Doit correspondre à style.css (largeur de tuile + marge droite)
  var ROW_METRICS = {
    dock: { tileW: 290, gap: 26 },
    apps: { tileW: 245, gap: 28 }
  };

  var DOCK_SIZE_DEFAULT = 5;
  var STORAGE_DOCK = 'x96q.dock.v2';
  var STORAGE_LAST = 'x96q.lastFocus.v2';
  var STORAGE_WEATHER = 'x96q.weather.v1';

  var WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=33.92&longitude=-6.91&current_weather=true';
  var WEATHER_TTL = 30 * 60 * 1000;

  var DOCK_PRIORITY = [
    /nuvio/i, /youtube\.tv|youtube/i, /smarttube|liskovsoft/i, /netflix/i, /stremio/i, /disney/i,
    /amazonvideo|primevideo/i, /spotify/i, /plex/i, /cloudstream|lagradost/i, /kodi|xbmc/i, /airscreen/i
  ];

  // ------------------------------------------------------------------ Catalogue éditorial
  // Catégorie (badge) + description d'une ligne. Le premier motif qui correspond l'emporte.
  var CATALOG = [
    [/nuvio/i, 'Streaming', 'Films, séries et sources directes en haute définition'],
    [/smarttube|liskovsoft/i, 'Streaming', 'YouTube sans publicité, pensé pour la télécommande'],
    [/youtube/i, 'Streaming', 'Vidéos, abonnements et créateurs en 4K'],
    [/netflix/i, 'Streaming', 'Séries, films et documentaires originaux'],
    [/stremio/i, 'Streaming', 'Catalogue multimédia et extensions'],
    [/cloudstream|lagradost/i, 'Streaming', 'Films, séries et animés via vos dépôts d’extensions'],
    [/disney/i, 'Streaming', 'Disney, Pixar, Marvel, Star Wars et National Geographic'],
    [/amazonvideo|primevideo|amazon\.avod/i, 'Streaming', 'Films, séries et sport en streaming'],
    [/tivimate|iptv|smarters|ottnavigator/i, 'Télévision', 'Chaînes en direct et guide des programmes'],
    [/molotov|canal|francetv|arte|mytf1|m6|bein/i, 'Télévision', 'Chaînes TV en direct et replay'],
    [/plex/i, 'Divertissement', 'Votre médiathèque personnelle, partout'],
    [/kodi|xbmc/i, 'Divertissement', 'Centre multimédia local et réseau'],
    [/twitch/i, 'Divertissement', 'Directs, jeux vidéo et communautés'],
    [/videolan|vlc/i, 'Lecteur', 'Lecteur vidéo universel, tous formats'],
    [/mxtech|mxplayer|justplayer/i, 'Lecteur', 'Lecteur vidéo rapide pour fichiers locaux'],
    [/spotify/i, 'Musique', 'Musique et podcasts en streaming'],
    [/deezer|soundcloud|tidal|music/i, 'Musique', 'Musique en streaming'],
    [/airscreen|ionitech|airplay|miracast/i, 'Outils', 'Diffusez depuis votre téléphone : AirPlay, Cast, Miracast'],
    [/android\.vending|play\.store/i, 'Outils', 'Applications et jeux pour votre téléviseur'],
    [/chrome|browser|firefox|tvbro/i, 'Outils', 'Navigation web sur grand écran'],
    [/documentsui|file|explorer|xplore/i, 'Outils', 'Fichiers, clés USB et stockage'],
    [/downloader|aftvnews/i, 'Outils', 'Téléchargez et installez des fichiers'],
    [/settings|tvsettings/i, 'Système', 'Réglages du boîtier Android'],
    [/weather|meteo/i, 'Outils', 'Prévisions météo locales']
  ];
  var CATEGORY_LABEL = {
    video: 'Streaming', audio: 'Musique', game: 'Jeux', image: 'Photos', social: 'Social',
    news: 'Actualités', maps: 'Navigation', productivity: 'Outils'
  };
  var DEFAULT_DESC = 'Application installée sur votre boîtier TV';

  function describe(app) {
    if (app._meta) return app._meta;
    var hay = app.packageName + ' ' + app.name;
    for (var i = 0; i < CATALOG.length; i++) {
      if (CATALOG[i][0].test(hay)) return (app._meta = { cat: CATALOG[i][1], desc: CATALOG[i][2] });
    }
    return (app._meta = {
      cat: CATEGORY_LABEL[app.category] || (app.isTv ? 'Application TV' : 'Application'),
      desc: DEFAULT_DESC
    });
  }

  // ------------------------------------------------------------------ Mise à l'échelle

  function fitStage() {
    var w = window.innerWidth || document.documentElement.clientWidth || STAGE_W;
    var h = window.innerHeight || document.documentElement.clientHeight || STAGE_H;
    var s = Math.min(w / STAGE_W, h / STAGE_H);
    if (!isFinite(s) || s <= 0) s = 1;
    document.documentElement.style.zoom = String(s);
  }
  fitStage();
  window.addEventListener('resize', fitStage);

  var bridge = window.AndroidBridge || createMockBridge();

  // ------------------------------------------------------------------ Utilitaires

  function readJson(key, fallback) {
    try { var raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function writeJson(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* indisponible */ }
  }

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return { r: 74, g: 84, b: 104 };
    var n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function mix(c, t, k) {
    return { r: Math.round(c.r + (t.r - c.r) * k), g: Math.round(c.g + (t.g - c.g) * k), b: Math.round(c.b + (t.b - c.b) * k) };
  }
  function rgb(c) { return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')'; }
  function rgba(c, a) { return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }
  var WHITE = { r: 255, g: 255, b: 255 };

  function palette(app) {
    if (app._palette) return app._palette;
    var base = hexToRgb(app.accentColor);
    return (app._palette = { base: base, light: mix(base, WHITE, 0.55), glow: mix(base, WHITE, 0.25) });
  }

  // ------------------------------------------------------------------ État

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    clock: $('clock'), date: $('date'), settings: $('settings'),
    weather: $('weather'), weatherIcon: $('weatherIcon'), weatherTemp: $('weatherTemp'), weatherSep: $('weatherSep'),
    heroCopy: $('heroCopy'), heroBadge: $('heroBadge'), heroTitle: $('heroTitle'),
    heroDesc: $('heroDesc'), heroHint: $('heroHint'),
    haloA: $('haloA'), haloB: $('haloB'), toast: $('toast'), countApps: $('countApps')
  };

  var rows = {
    dock: { key: 'dock', track: $('trackDock'), items: [], tiles: [], col: 0 },
    apps: { key: 'apps', track: $('trackApps'), items: [], tiles: [], col: 0 }
  };
  var ROW_ORDER = ['dock', 'apps'];

  var state = { apps: [], byPkg: {}, dock: [], zone: 'dock', focusedTile: null, loaded: false };

  // ------------------------------------------------------------------ Horloge

  var timeFmt = null, dateFmt = null, clockTimer = 0;
  try {
    timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
    dateFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch (e) { /* repli manuel */ }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  var lastClock = '', lastDate = '';
  /**
   * Vérifiée chaque seconde (coût négligeable) ; le DOM n'est modifié qu'au changement de minute.
   * Reste exacte même si le boîtier sort de veille ou si l'heure réseau est corrigée.
   */
  function tick() {
    var now = new Date();
    var t = timeFmt ? timeFmt.format(now) : pad(now.getHours()) + ':' + pad(now.getMinutes());
    if (t !== lastClock) { lastClock = t; els.clock.textContent = t; }
    if (dateFmt) {
      var d = dateFmt.format(now);
      d = d.charAt(0).toUpperCase() + d.slice(1);
      if (d !== lastDate) { lastDate = d; els.date.textContent = d; }
    }
  }
  function startClock() {
    tick();
    clearInterval(clockTimer);
    clockTimer = setInterval(tick, 1000);
  }

  // ------------------------------------------------------------------ Météo (Témara / Rabat)

  var WEATHER_ICONS = {
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z"/></svg>',
    partly: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3.5v1.4M3.5 8.5h1.4M4.9 4.9l1 1M12.1 4.9l-1 1"/><path d="M5.6 11.2a3.2 3.2 0 1 1 5.9-2.4"/><path d="M8 19.5h9.3a3.7 3.7 0 0 0 .4-7.4 5 5 0 0 0-9.5 1.3A3.1 3.1 0 0 0 8 19.5z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M7 18.5h10.5a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18.5z"/></svg>',
    fog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M7 13.5h10.5a3.6 3.6 0 0 0 .3-7.2 5 5 0 0 0-9.6 1.4A3 3 0 0 0 7 13.5z"/><path d="M4 17h16M6 20.5h12"/></svg>',
    rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14.5h10.5a3.8 3.8 0 0 0 .4-7.6 5.2 5.2 0 0 0-10 1.4A3.1 3.1 0 0 0 7 14.5z"/><path d="M9 17.5l-1 3M13 17.5l-1 3M17 17.5l-1 3"/></svg>',
    snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14.5h10.5a3.8 3.8 0 0 0 .4-7.6 5.2 5.2 0 0 0-10 1.4A3.1 3.1 0 0 0 7 14.5z"/><path d="M8.5 18.5h.01M12 20h.01M15.5 18.5h.01"/></svg>',
    storm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14.5h10.5a3.8 3.8 0 0 0 .4-7.6 5.2 5.2 0 0 0-10 1.4A3.1 3.1 0 0 0 7 14.5z"/><path d="M12.5 15.5l-2 3.5h3l-2 3.5"/></svg>'
  };

  function weatherIconKey(code, isDay) {
    if (code === 0) return isDay ? 'sun' : 'moon';
    if (code === 1 || code === 2) return isDay ? 'partly' : 'cloud';
    if (code === 3) return 'cloud';
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    return 'cloud';
  }

  function renderWeather(w) {
    if (!w || typeof w.temperature !== 'number') {
      els.weather.classList.add('is-hidden');
      els.weatherSep.classList.add('is-hidden');
      return;
    }
    els.weatherIcon.innerHTML = WEATHER_ICONS[weatherIconKey(w.weathercode, w.is_day !== 0)];
    els.weatherTemp.textContent = Math.round(w.temperature) + '°';
    els.weather.classList.remove('is-hidden');
    els.weatherSep.classList.remove('is-hidden');
  }

  var weatherTimer = 0;
  function loadWeather() {
    clearTimeout(weatherTimer);
    var cached = readJson(STORAGE_WEATHER, null);
    var age = cached ? Date.now() - cached.t : Infinity;
    if (cached) renderWeather(cached.w);                    // affichage immédiat, même périmé
    else renderWeather(null);
    if (age < WEATHER_TTL) {                                 // cache frais : aucune requête
      weatherTimer = setTimeout(loadWeather, WEATHER_TTL - age + 1000);
      return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', WEATHER_URL, true);
    xhr.timeout = 8000;
    xhr.onload = function () {
      try {
        var w = JSON.parse(xhr.responseText).current_weather;
        if (w && typeof w.temperature === 'number') {
          writeJson(STORAGE_WEATHER, { t: Date.now(), w: w });
          renderWeather(w);
          weatherTimer = setTimeout(loadWeather, WEATHER_TTL);
          return;
        }
      } catch (e) { /* réponse invalide */ }
      weatherTimer = setTimeout(loadWeather, 5 * 60 * 1000);
    };
    xhr.onerror = xhr.ontimeout = function () { weatherTimer = setTimeout(loadWeather, 5 * 60 * 1000); };
    try { xhr.send(); } catch (e) { weatherTimer = setTimeout(loadWeather, 5 * 60 * 1000); }
  }

  // ------------------------------------------------------------------ Données

  function loadApps() {
    var list = [];
    try { list = JSON.parse(bridge.getInstalledApps() || '[]'); } catch (e) { list = []; }
    state.apps = list;
    state.byPkg = {};
    list.forEach(function (a) { state.byPkg[a.packageName] = a; });

    var dock = (readJson(STORAGE_DOCK, null) || []).filter(function (p) { return !!state.byPkg[p]; });
    if (!dock.length) dock = defaultDock(list);           // le dock n'est JAMAIS vide
    state.dock = dock;
    writeJson(STORAGE_DOCK, dock);
    state.loaded = true;
  }

  function defaultDock(list) {
    var picked = [];
    DOCK_PRIORITY.forEach(function (re) {
      if (picked.length >= DOCK_SIZE_DEFAULT) return;
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (picked.indexOf(a.packageName) === -1 && (re.test(a.packageName) || re.test(a.name))) {
          picked.push(a.packageName);
          return;
        }
      }
    });
    [true, false].forEach(function (tv) {
      list.forEach(function (a) {
        if (picked.length < DOCK_SIZE_DEFAULT && !!a.isTv === tv && picked.indexOf(a.packageName) === -1) picked.push(a.packageName);
      });
    });
    return picked;
  }

  function inDock(pkg) { return state.dock.indexOf(pkg) !== -1; }

  // ------------------------------------------------------------------ Rendu des tuiles

  function buildTile(app, showPin) {
    var p = palette(app);
    var tile = document.createElement('div');
    tile.className = 'tile';
    tile.setAttribute('data-pkg', app.packageName);

    var face = document.createElement('div');
    face.className = 'tile-face';

    var glow = document.createElement('div');
    glow.className = 'tile-glow';
    glow.style.backgroundImage = 'radial-gradient(closest-side, ' + rgba(p.glow, 0.42) + ' 0%, ' + rgba(p.glow, 0.14) + ' 55%, ' + rgba(p.glow, 0) + ' 100%)';
    face.appendChild(glow);

    // L'icône native (PNG Base64) est toujours prioritaire ; la lettre n'est qu'un repli.
    if (app.icon && app.icon.indexOf('data:image') === 0) {
      var img = document.createElement('img');
      img.className = 'tile-icon';
      img.alt = '';
      img.onerror = function () { img.parentNode && img.parentNode.replaceChild(monogram(app), img); };
      img.src = app.icon;
      face.appendChild(img);
    } else {
      face.appendChild(monogram(app));
    }

    if (showPin && inDock(app.packageName)) {
      var pin = document.createElement('span');
      pin.className = 'tile-pin';
      face.appendChild(pin);
    }

    var label = document.createElement('p');
    label.className = 'tile-label';
    label.textContent = app.name;

    tile.appendChild(face);
    tile.appendChild(label);
    return tile;
  }

  function monogram(app) {
    var mono = document.createElement('span');
    mono.className = 'tile-monogram';
    mono.textContent = (app.name || '?').charAt(0).toUpperCase();
    return mono;
  }

  function renderRow(row, items, showPin) {
    row.items = items;
    var frag = document.createDocumentFragment();
    row.tiles = items.map(function (app) { var t = buildTile(app, showPin); frag.appendChild(t); return t; });
    row.track.textContent = '';
    row.track.appendChild(frag);
    if (row.col >= items.length) row.col = Math.max(0, items.length - 1);
  }

  function renderAll() {
    renderRow(rows.dock, state.dock.map(function (p) { return state.byPkg[p]; }).filter(Boolean), false);
    renderRow(rows.apps, state.apps, true);
    els.countApps.textContent = state.apps.length ? String(state.apps.length) : '';
  }

  function renderSkeleton() {
    ROW_ORDER.forEach(function (k) {
      var frag = document.createDocumentFragment();
      for (var i = 0; i < 7; i++) {
        var t = document.createElement('div');
        t.className = 'tile is-skeleton';
        t.innerHTML = '<div class="tile-face"></div><p class="tile-label"></p>';
        frag.appendChild(t);
      }
      rows[k].track.appendChild(frag);
    });
  }

  // ------------------------------------------------------------------ Focus & navigation

  function currentRow() { return state.zone === 'top' ? null : rows[state.zone]; }
  function currentApp() { var r = currentRow(); return r ? r.items[r.col] || null : null; }

  function applyFocus(repeat) {
    if (state.focusedTile) state.focusedTile.classList.remove('is-focused', 'is-pressed');
    els.settings.classList.toggle('is-focused', state.zone === 'top');

    var row = currentRow();
    if (row) {
      var tile = row.tiles[row.col] || null;
      if (tile) tile.classList.add('is-focused');
      state.focusedTile = tile;
      scrollRow(row);
      var app = row.items[row.col];
      if (app) writeJson(STORAGE_LAST, { pkg: app.packageName, zone: state.zone });
    } else {
      state.focusedTile = null;
    }
    updateHero(!repeat);
  }

  function trackX(row, col) {
    var m = ROW_METRICS[row.key];
    var n = row.items.length;
    if (!n) return 0;
    var trackW = n * m.tileW + (n - 1) * m.gap;
    var visible = STAGE_W - PAD_X * 2;
    var center = col * (m.tileW + m.gap) + m.tileW / 2;
    var x = (STAGE_W / 2 - PAD_X) - center;
    var minX = Math.min(0, visible - trackW);
    return Math.round(Math.max(minX, Math.min(0, x)));
  }
  function scrollRow(row) { row.track.style.transform = 'translate3d(' + trackX(row, row.col) + 'px,0,0)'; }

  function nearestCol(fromRow, toRow) {
    if (!toRow.items.length) return 0;
    var fm = ROW_METRICS[fromRow.key], tm = ROW_METRICS[toRow.key];
    var fromCenter = trackX(fromRow, fromRow.col) + fromRow.col * (fm.tileW + fm.gap) + fm.tileW / 2;
    var best = 0, bestD = Infinity;
    for (var c = 0; c < toRow.items.length; c++) {
      var cx = trackX(toRow, c) + c * (tm.tileW + tm.gap) + tm.tileW / 2;
      var d = Math.abs(cx - fromCenter);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  function moveHorizontal(delta, repeat) {
    var row = currentRow();
    if (!row) return;
    var next = row.col + delta;
    if (next < 0 || next >= row.items.length) { if (!repeat) bump(delta); return; }
    row.col = next;
    applyFocus(repeat);
  }

  function moveVertical(delta, repeat) {
    if (state.zone === 'top') {
      if (delta > 0) { state.zone = 'dock'; applyFocus(repeat); }
      return;
    }
    var idx = ROW_ORDER.indexOf(state.zone) + delta;
    if (idx < 0) { state.zone = 'top'; applyFocus(repeat); return; }
    if (idx >= ROW_ORDER.length) { if (!repeat) bump(0); return; }
    var from = rows[state.zone], to = rows[ROW_ORDER[idx]];
    if (!to.items.length) return;
    to.col = nearestCol(from, to);
    state.zone = to.key;
    applyFocus(repeat);
  }

  function bump(dir) {
    var tile = state.focusedTile;
    if (!tile) return;
    var cls = dir < 0 ? 'is-bump-left' : dir > 0 ? 'is-bump-right' : 'is-bump-down';
    tile.classList.remove('is-bump-left', 'is-bump-right', 'is-bump-down');
    void tile.offsetWidth;
    tile.classList.add(cls);
    setTimeout(function () { tile.classList.remove(cls); }, 180);
  }

  // ------------------------------------------------------------------ Scène héroïque

  var heroKey = null;
  var haloFront = els.haloA;
  var haloTimer = 0;
  var haloColorKey = null;

  function updateHero(animate) {
    if (!state.loaded) return;
    var app = currentApp();
    var key = app ? app.packageName : '#settings';
    var changed = key !== heroKey;
    heroKey = key;

    if (!app) {
      els.heroCopy.style.setProperty('--accent-tint', 'rgba(255,255,255,0.10)');
      els.heroCopy.style.setProperty('--accent-light', 'rgba(255,255,255,0.85)');
      els.heroBadge.textContent = 'Système';
      els.heroTitle.textContent = 'Paramètres';
      els.heroDesc.textContent = 'Réseau, affichage, son et applications du boîtier';
      els.heroHint.classList.add('is-hidden');
      scheduleHalo({ r: 120, g: 132, b: 160 });
    } else {
      var p = palette(app);
      var meta = describe(app);
      els.heroCopy.style.setProperty('--accent-tint', rgba(p.base, 0.18));
      els.heroCopy.style.setProperty('--accent-light', rgb(p.light));
      els.heroBadge.textContent = meta.cat;
      els.heroTitle.textContent = app.name;          // jamais le packageName
      els.heroDesc.textContent = meta.desc;
      els.heroHint.textContent = inDock(app.packageName)
        ? 'Appui long OK • Retirer des favoris'
        : 'Appui long OK • Épingler aux favoris';
      els.heroHint.classList.remove('is-hidden');
      scheduleHalo(p.base);
    }

    if (changed && animate) {
      els.heroCopy.classList.remove('is-entering');
      void els.heroCopy.offsetWidth;
      els.heroCopy.classList.add('is-entering');
    }
  }

  /** Le halo n'est repeint qu'une fois la navigation posée (aucune repeinte pendant un défilement rapide). */
  function scheduleHalo(color) {
    clearTimeout(haloTimer);
    haloTimer = setTimeout(function () { setHalo(color); }, 140);
  }

  function setHalo(c) {
    var k = c.r + ',' + c.g + ',' + c.b;
    if (k === haloColorKey) return;
    haloColorKey = k;
    var light = mix(c, WHITE, 0.35);
    var back = haloFront === els.haloA ? els.haloB : els.haloA;
    // Halo principal sur ~70 % de la largeur + éclat plus clair dans l'angle : deux dégradés, peints une fois.
    back.style.backgroundImage =
      'radial-gradient(ellipse 620px 440px at 90% 4%, ' + rgba(light, 0.34) + ' 0%, ' + rgba(light, 0) + ' 100%),' +
      'radial-gradient(ellipse 1344px 900px at 78% 14%, ' + rgba(c, 0.52) + ' 0%, ' + rgba(c, 0.22) + ' 42%, ' +
        rgba(c, 0.06) + ' 72%, ' + rgba(c, 0) + ' 100%)';
    back.classList.add('is-visible');
    haloFront.classList.remove('is-visible');
    haloFront = back;
  }

  // ------------------------------------------------------------------ Actions

  var toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('is-visible'); }, 1800);
  }

  function activate() {
    if (state.zone === 'top') {
      if (!bridge.openSystemSettings()) toast('Paramètres indisponibles');
      return;
    }
    var app = currentApp();
    if (!app) return;
    var tile = state.focusedTile;
    if (tile) {
      tile.classList.add('is-pressed');
      setTimeout(function () { tile.classList.remove('is-pressed'); }, 140);
    }
    var ok = false;
    try { ok = bridge.launchApp(app.packageName); } catch (e) { ok = false; }
    if (ok === false) toast('Impossible d’ouvrir ' + app.name);
  }

  function togglePin() {
    var app = currentApp();
    if (!app) return;
    var pkg = app.packageName;
    if (inDock(pkg)) {
      if (state.dock.length <= 1) { toast('Le dock garde au moins une application'); return; }
      state.dock = state.dock.filter(function (p) { return p !== pkg; });
      toast(app.name + ' retiré des favoris');
    } else {
      state.dock = state.dock.concat(pkg);
      toast(app.name + ' épinglé aux favoris');
    }
    writeJson(STORAGE_DOCK, state.dock);

    var zone = state.zone;
    renderAll();
    if (zone === 'apps') {
      var i = indexOfPkg(rows.apps, pkg);
      if (i >= 0) rows.apps.col = i;
    }
    scrollRow(rows.dock);
    heroKey = null;
    applyFocus(false);
  }

  function indexOfPkg(row, pkg) {
    for (var i = 0; i < row.items.length; i++) if (row.items[i].packageName === pkg) return i;
    return -1;
  }

  function onBack() {
    if (state.zone === 'top') { state.zone = 'dock'; applyFocus(false); return; }
    if (state.zone === 'apps') { rows.dock.col = nearestCol(rows.apps, rows.dock); state.zone = 'dock'; applyFocus(false); return; }
    if (rows.dock.col > 0) { rows.dock.col = 0; applyFocus(false); return; }
    bump(-1);
  }

  function onHome() {
    state.zone = 'dock';
    rows.dock.col = 0;
    rows.apps.col = 0;
    scrollRow(rows.apps);
    applyFocus(false);
  }

  function reload() {
    var app = currentApp();
    var pkg = app && app.packageName;
    var zone = state.zone;
    loadApps();
    renderAll();
    if (zone !== 'top') {
      var i = pkg ? indexOfPkg(rows[zone], pkg) : -1;
      if (i >= 0) rows[zone].col = i;
    }
    scrollRow(rows.dock);
    scrollRow(rows.apps);
    heroKey = null;
    applyFocus(false);
  }

  // ------------------------------------------------------------------ Entrée télécommande

  window.onRemoteKey = function (name, repeat) {
    if (!state.loaded) return;
    repeat = !!repeat;
    switch (name) {
      case 'ArrowLeft':  moveHorizontal(-1, repeat); break;
      case 'ArrowRight': moveHorizontal(1, repeat); break;
      case 'ArrowUp':    moveVertical(-1, repeat); break;
      case 'ArrowDown':  moveVertical(1, repeat); break;
      case 'Enter':      activate(); break;
      case 'LongEnter':
      case 'Menu':       togglePin(); break;
      case 'Back':       onBack(); break;
    }
  };

  // Clavier : aperçu navigateur uniquement (sur le boîtier, MainActivity intercepte tout).
  var kbEnterTimer = 0, kbEnterDown = false, kbEnterLong = false;
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      if (kbEnterDown) return;
      kbEnterDown = true; kbEnterLong = false;
      kbEnterTimer = setTimeout(function () { kbEnterLong = true; window.onRemoteKey('LongEnter', false); }, 550);
      return;
    }
    var map = { ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
      Escape: 'Back', Backspace: 'Back', GoBack: 'Back', ContextMenu: 'Menu', m: 'Menu' };
    if (map[e.key]) { e.preventDefault(); window.onRemoteKey(map[e.key], e.repeat); }
  }, true);
  document.addEventListener('keyup', function (e) {
    if (!(e.key === 'Enter' || e.keyCode === 13)) return;
    e.preventDefault();
    clearTimeout(kbEnterTimer);
    if (kbEnterDown && !kbEnterLong) window.onRemoteKey('Enter', false);
    kbEnterDown = false;
  }, true);

  window.Launcher = {
    onBack: onBack,
    onHome: onHome,
    onMenu: togglePin,
    onResume: function () { tick(); fitStage(); loadWeather(); },   // météo : rafraîchie seulement si le cache a plus de 30 min
    reload: reload
  };

  // ------------------------------------------------------------------ Démarrage

  function start() {
    startClock();
    loadWeather();
    renderSkeleton();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        loadApps();
        renderAll();
        var last = readJson(STORAGE_LAST, null);
        if (last && (last.zone === 'dock' || last.zone === 'apps')) {
          var i = indexOfPkg(rows[last.zone], last.pkg);
          if (i >= 0) { state.zone = last.zone; rows[last.zone].col = i; }
        }
        scrollRow(rows.dock);
        scrollRow(rows.apps);
        applyFocus(false);
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // ------------------------------------------------------------------ Aperçu navigateur

  function createMockBridge() {
    // [nom, package, accent, TV, icône sur fond blanc ?]
    var demo = [
      ['NuvioTV', 'com.nuvio.tv', '#7B5CFF', 1, 0], ['YouTube', 'com.google.android.youtube.tv', '#FF0000', 1, 1],
      ['Netflix', 'com.netflix.ninja', '#E50914', 1, 0], ['AirScreen', 'com.ionitech.airscreen', '#2FB8A6', 1, 1],
      ['Stremio', 'com.stremio.one', '#8A5AF0', 1, 0], ['Spotify', 'com.spotify.tv.android', '#1DB954', 1, 0],
      ['Disney+', 'com.disney.disneyplus', '#113CCF', 1, 0], ['Prime Video', 'com.amazon.amazonvideo.livingroom', '#1A98FF', 1, 0],
      ['CloudStream', 'com.lagradost.cloudstream3', '#3D7BF7', 0, 0], ['Kodi', 'org.xbmc.kodi', '#17B2E7', 1, 1],
      ['VLC', 'org.videolan.vlc', '#FF8800', 1, 0], ['Plex', 'com.plexapp.android', '#E5A00D', 1, 0],
      ['Chrome', 'com.android.chrome', '#4285F4', 0, 1], ['Fichiers', 'com.android.documentsui', '#4A5468', 0, 0],
      ['Google Play Store', 'com.android.vending', '#01875F', 1, 1], ['Twitch', 'tv.twitch.android.app', '#9146FF', 1, 0],
      ['SmartTube', 'com.liskovsoft.smarttubetv.beta', '#E62117', 1, 0], ['Downloader', 'com.esaba.downloader', '#F2A300', 1, 0]
    ];
    function iconFor(name, color, white) {
      var c = document.createElement('canvas'); c.width = c.height = 128;
      var x = c.getContext('2d');
      x.fillStyle = white ? '#FFFFFF' : color; x.fillRect(0, 0, 128, 128);
      x.fillStyle = white ? color : '#FFFFFF';
      x.font = '800 66px Inter, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(name.charAt(0), 64, 68);
      return c.toDataURL('image/png');
    }
    var apps = demo.map(function (d) {
      return { name: d[0], packageName: d[1], accentColor: d[2], isTv: !!d[3], category: '', icon: iconFor(d[0], d[2], d[4]) };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    return {
      getInstalledApps: function () { return JSON.stringify(apps); },
      getAppBanner: function () { return ''; },
      launchApp: function (pkg) { console.log('[aperçu] launchApp', pkg); return true; },
      openSystemSettings: function () { console.log('[aperçu] openSystemSettings'); return true; }
    };
  }
})();
