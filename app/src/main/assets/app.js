/* ==========================================================================
   X96Q Launcher — navigation spatiale tvOS
   Zones verticales : 'top' (Paramètres) → 'dock' (Favoris) → 'apps' (Toutes)
   Entrée unique : window.onRemoteKey(nom, repeat), appelée par MainActivity.kt
   (et par le clavier dans un navigateur, pour l'aperçu).
   ========================================================================== */
(function () {
  'use strict';

  var STAGE_W = 1920;
  var STAGE_H = 1080;
  var PAD_X = 64;

  // Doit correspondre à style.css
  var ROW_METRICS = {
    dock: { tileW: 270, gap: 32 },
    apps: { tileW: 230, gap: 28 }
  };

  var DOCK_SIZE_DEFAULT = 5;
  var STORAGE_DOCK = 'x96q.dock.v2';
  var STORAGE_LAST = 'x96q.lastFocus.v2';

  // Applications proposées en priorité dans le dock au premier démarrage.
  var DOCK_PRIORITY = [
    /nuvio/i,
    /youtube\.tv|youtube/i,
    /smarttube|liskovsoft/i,
    /netflix/i,
    /stremio/i,
    /disney/i,
    /amazonvideo|primevideo|avod/i,
    /spotify/i,
    /plex/i,
    /cloudstream|lagradost/i,
    /kodi|xbmc/i,
    /airscreen/i
  ];

  // Catégorie affichée dans la scène (badge).
  var STREAMING = /nuvio|youtube|smarttube|liskovsoft|netflix|stremio|disney|amazonvideo|primevideo|plex|cloudstream|lagradost|kodi|xbmc|molotov|canal|francetv|arte|twitch|vlc|mxtech|hbo|max|paramount|crunchyroll|tivimate|iptv/i;
  var CATEGORY_LABEL = {
    video: 'Streaming', audio: 'Musique', game: 'Jeu', image: 'Photos', social: 'Social',
    news: 'Actualités', maps: 'Navigation', productivity: 'Outils'
  };

  // ------------------------------------------------------------------ Mise à l'échelle

  /** Ajuste le canevas 1920×1080 à l'écran réel, quelle que soit la densité du boîtier. */
  function fitStage() {
    var w = window.innerWidth || document.documentElement.clientWidth || STAGE_W;
    var h = window.innerHeight || document.documentElement.clientHeight || STAGE_H;
    var s = Math.min(w / STAGE_W, h / STAGE_H);
    if (!isFinite(s) || s <= 0) s = 1;
    document.documentElement.style.zoom = String(s);
  }
  fitStage();
  window.addEventListener('resize', fitStage);

  // ------------------------------------------------------------------ Pont natif

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
  function mix(c, target, t) {
    return {
      r: Math.round(c.r + (target.r - c.r) * t),
      g: Math.round(c.g + (target.g - c.g) * t),
      b: Math.round(c.b + (target.b - c.b) * t)
    };
  }
  function rgb(c) { return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')'; }
  function rgba(c, a) { return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }

  var BLACK = { r: 6, g: 7, b: 10 };
  var WHITE = { r: 255, g: 255, b: 255 };

  function palette(app) {
    if (app._palette) return app._palette;
    var base = hexToRgb(app.accentColor);
    app._palette = {
      base: base,
      dark: mix(base, BLACK, 0.45),
      light: mix(base, WHITE, 0.55)
    };
    return app._palette;
  }

  // ------------------------------------------------------------------ État

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    clock: $('clock'), date: $('date'), settings: $('settings'),
    heroCopy: $('heroCopy'), heroBadge: $('heroBadge'), heroTitle: $('heroTitle'), heroHint: $('heroHint'),
    heroPoster: $('heroPoster'), heroBanner: $('heroBanner'), heroIcon: $('heroIcon'), heroGlyph: $('heroGlyph'),
    ambientA: $('ambientA'), ambientB: $('ambientB'), toast: $('toast'), countApps: $('countApps')
  };
  els.heroGlyph.appendChild(els.settings.querySelector('svg').cloneNode(true));

  var rows = {
    dock: { key: 'dock', el: $('rowDock'), track: $('trackDock'), items: [], tiles: [], col: 0 },
    apps: { key: 'apps', el: $('rowApps'), track: $('trackApps'), items: [], tiles: [], col: 0 }
  };
  var ROW_ORDER = ['dock', 'apps'];

  var state = {
    apps: [],
    byPkg: {},
    dock: [],
    zone: 'dock',          // 'top' | 'dock' | 'apps'
    focusedTile: null,
    loaded: false
  };
  var banners = {};        // packageName → data URI ('' = aucune)

  // ------------------------------------------------------------------ Horloge

  var timeFmt = null, dateFmt = null, clockTimer = 0;
  try {
    timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
    dateFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  } catch (e) { /* repli manuel */ }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function tick() {
    clearTimeout(clockTimer);
    var now = new Date();
    els.clock.textContent = timeFmt ? timeFmt.format(now) : pad(now.getHours()) + ':' + pad(now.getMinutes());
    if (dateFmt) els.date.textContent = dateFmt.format(now);
    clockTimer = setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  }

  // ------------------------------------------------------------------ Données

  function loadApps() {
    var list = [];
    try { list = JSON.parse(bridge.getInstalledApps() || '[]'); } catch (e) { list = []; }
    state.apps = list;
    state.byPkg = {};
    list.forEach(function (a) { state.byPkg[a.packageName] = a; });

    var stored = readJson(STORAGE_DOCK, null);
    var dock = (stored || []).filter(function (p) { return !!state.byPkg[p]; });
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
    // Complète avec les applications TV, puis les autres.
    [true, false].forEach(function (tv) {
      list.forEach(function (a) {
        if (picked.length < DOCK_SIZE_DEFAULT && !!a.isTv === tv && picked.indexOf(a.packageName) === -1) {
          picked.push(a.packageName);
        }
      });
    });
    return picked;
  }

  function inDock(pkg) { return state.dock.indexOf(pkg) !== -1; }

  function categoryLabel(app) {
    if (CATEGORY_LABEL[app.category]) return CATEGORY_LABEL[app.category];
    if (STREAMING.test(app.packageName) || STREAMING.test(app.name)) return 'Streaming';
    return app.isTv ? 'Application TV' : 'Application';
  }

  // ------------------------------------------------------------------ Rendu

  function buildTile(app, showPin) {
    var p = palette(app);
    var tile = document.createElement('div');
    tile.className = 'tile';
    tile.setAttribute('data-pkg', app.packageName);

    var face = document.createElement('div');
    face.className = 'tile-face';
    face.style.backgroundImage = 'linear-gradient(135deg, ' + rgb(p.dark) + ' 0%, #12151E 100%)';

    if (app.icon) {
      var img = document.createElement('img');
      img.className = 'tile-icon';
      img.alt = '';
      img.src = app.icon;
      face.appendChild(img);
    } else {
      var mono = document.createElement('span');
      mono.className = 'tile-monogram';
      mono.textContent = (app.name || '?').charAt(0).toUpperCase();
      face.appendChild(mono);
    }
    if (banners[app.packageName]) attachBanner(tile, face, banners[app.packageName]);

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

  function attachBanner(tile, face, uri) {
    if (tile.classList.contains('has-banner')) return;
    var b = document.createElement('img');
    b.className = 'tile-banner';
    b.alt = '';
    b.src = uri;
    face.insertBefore(b, face.firstChild);
    tile.classList.add('has-banner');
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
    ['dock', 'apps'].forEach(function (k) {
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

  /** Charge les bannières TV en tâche de fond, une par frame, dock d'abord. */
  var bannerQueue = [];
  function queueBanners() {
    if (!bridge.getAppBanner) return;
    var seen = {};
    bannerQueue = [];
    rows.dock.items.concat(rows.apps.items).forEach(function (a) {
      if (a.isTv && !seen[a.packageName] && banners[a.packageName] === undefined) {
        seen[a.packageName] = true;
        bannerQueue.push(a.packageName);
      }
    });
    setTimeout(pumpBanners, 300);
  }
  function pumpBanners() {
    var pkg = bannerQueue.shift();
    if (!pkg) return;
    var uri = '';
    try { uri = bridge.getAppBanner(pkg) || ''; } catch (e) { uri = ''; }
    banners[pkg] = uri;
    if (uri) {
      ['dock', 'apps'].forEach(function (k) {
        rows[k].tiles.forEach(function (t) {
          if (t.getAttribute('data-pkg') === pkg) attachBanner(t, t.firstChild, uri);
        });
      });
      if (currentApp() && currentApp().packageName === pkg) updatePoster(currentApp(), false);
    }
    setTimeout(pumpBanners, 32);
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

  /** Défilement horizontal centré, borné au début et à la fin (translate3d uniquement). */
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
  function scrollRow(row) {
    row.track.style.transform = 'translate3d(' + trackX(row, row.col) + 'px,0,0)';
  }

  /** Colonne de la rangée cible la plus proche horizontalement de la tuile actuelle (comme tvOS). */
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
    var from = rows[state.zone];
    var to = rows[ROW_ORDER[idx]];
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
  var ambientFront = els.ambientA;
  var ambientTimer = 0;
  var posterTimer = 0;

  function updateHero(animate) {
    if (!state.loaded) return;
    var app = currentApp();
    var key = app ? app.packageName : '#settings';
    var changed = key !== heroKey;
    heroKey = key;

    if (!app) {
      els.heroCopy.style.setProperty('--accent-light', 'rgba(255,255,255,0.7)');
      els.heroBadge.textContent = 'Système';
      els.heroTitle.textContent = 'Paramètres';
      els.heroHint.textContent = 'Réseau, affichage, son et applications';
      setPosterGlyph();
      clearTimeout(ambientTimer);
      setAmbient(null);
    } else {
      var p = palette(app);
      els.heroCopy.style.setProperty('--accent-light', rgb(p.light));
      els.heroBadge.textContent = categoryLabel(app);
      els.heroTitle.textContent = app.name;          // jamais le packageName
      els.heroHint.textContent = inDock(app.packageName)
        ? 'Appui long OK • Retirer des favoris'
        : 'Appui long OK • Épingler aux favoris';

      clearTimeout(posterTimer);
      // Pendant un défilement rapide, l'affiche attend que la navigation se pose.
      posterTimer = setTimeout(function () { updatePoster(app, true); }, animate ? 0 : 120);
      clearTimeout(ambientTimer);
      ambientTimer = setTimeout(function () { setAmbient(app); }, 120);
    }

    if (changed && animate) {
      els.heroCopy.classList.remove('is-entering');
      void els.heroCopy.offsetWidth;
      els.heroCopy.classList.add('is-entering');
    }
  }

  function updatePoster(app, animate) {
    if (currentApp() !== app) return;
    var p = palette(app);
    var poster = els.heroPoster;
    poster.className = 'hero-poster';
    poster.style.backgroundImage = 'linear-gradient(135deg, ' + rgb(p.dark) + ' 0%, #12151E 100%)';
    var uri = banners[app.packageName];
    if (uri) {
      if (els.heroBanner.getAttribute('src') !== uri) els.heroBanner.src = uri;
      poster.classList.add('has-banner');
    } else if (app.icon) {
      if (els.heroIcon.getAttribute('src') !== app.icon) els.heroIcon.src = app.icon;
      poster.classList.add('has-icon');
    }
    if (animate) { void poster.offsetWidth; poster.classList.add('is-entering'); }
  }

  function setPosterGlyph() {
    clearTimeout(posterTimer);
    els.heroPoster.className = 'hero-poster has-glyph';
    els.heroPoster.style.backgroundImage = 'linear-gradient(135deg, #252A36 0%, #12151E 100%)';
  }

  function setAmbient(app) {
    var back = ambientFront === els.ambientA ? els.ambientB : els.ambientA;
    if (!app) { ambientFront.classList.remove('is-visible'); return; }
    var c = palette(app).base;
    // Fondu complet avant la moitié de l'écran et avant le dock : le bas reste noir profond.
    back.style.backgroundImage =
      'radial-gradient(ellipse 960px 620px at 100% 0%, ' + rgba(c, 1) + ' 0%, ' + rgba(c, 0.35) + ' 45%, ' + rgba(c, 0) + ' 100%)';
    back.classList.add('is-visible');
    ambientFront.classList.remove('is-visible');
    ambientFront = back;
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
    heroKey = null;
    applyFocus(false);
  }

  function indexOfPkg(row, pkg) {
    for (var i = 0; i < row.items.length; i++) if (row.items[i].packageName === pkg) return i;
    return -1;
  }

  /** RETOUR : jamais de sortie. Apps → dock ; dock → première tuile ; Paramètres → dock. */
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
      var row = rows[zone];
      var i = pkg ? indexOfPkg(row, pkg) : -1;
      if (i >= 0) row.col = i;
    }
    scrollRow(rows.dock);
    scrollRow(rows.apps);
    heroKey = null;
    applyFocus(false);
    queueBanners();
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

  // Clavier : utilisé seulement hors Android (aperçu navigateur). Sur le boîtier, MainActivity
  // intercepte toutes les touches avant la WebView.
  var kbEnterTimer = 0, kbEnterDown = false, kbEnterLong = false;
  document.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      if (kbEnterDown) return;
      kbEnterDown = true; kbEnterLong = false;
      kbEnterTimer = setTimeout(function () { kbEnterLong = true; window.onRemoteKey('LongEnter', false); }, 550);
      return;
    }
    var map = { ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
      Escape: 'Back', Backspace: 'Back', GoBack: 'Back', ContextMenu: 'Menu', m: 'Menu' };
    if (map[k]) { e.preventDefault(); window.onRemoteKey(map[k], e.repeat); }
  }, true);
  document.addEventListener('keyup', function (e) {
    if (!(e.key === 'Enter' || e.keyCode === 13)) return;
    e.preventDefault();
    clearTimeout(kbEnterTimer);
    if (kbEnterDown && !kbEnterLong) window.onRemoteKey('Enter', false);
    kbEnterDown = false;
  }, true);

  // ------------------------------------------------------------------ API native

  window.Launcher = {
    onBack: onBack,
    onHome: onHome,
    onMenu: togglePin,
    onResume: function () { tick(); fitStage(); },
    reload: reload
  };

  // ------------------------------------------------------------------ Démarrage

  function start() {
    tick();
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
        queueBanners();
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // ------------------------------------------------------------------ Aperçu navigateur

  function createMockBridge() {
    var demo = [
      ['NuvioTV', 'com.nuvio.tv', '#7B5CFF', 1], ['YouTube', 'com.google.android.youtube.tv', '#FF0000', 1],
      ['Netflix', 'com.netflix.ninja', '#E50914', 1], ['AirScreen', 'com.ionitech.airscreen', '#2FB8A6', 1],
      ['Stremio', 'com.stremio.one', '#8A5AF0', 1], ['Spotify', 'com.spotify.tv.android', '#1DB954', 1],
      ['Disney+', 'com.disney.disneyplus', '#113CCF', 1], ['Prime Video', 'com.amazon.amazonvideo.livingroom', '#1A98FF', 1],
      ['CloudStream', 'com.lagradost.cloudstream3', '#3D7BF7', 0], ['Kodi', 'org.xbmc.kodi', '#17B2E7', 1],
      ['VLC', 'org.videolan.vlc', '#FF8800', 1], ['Plex', 'com.plexapp.android', '#E5A00D', 1],
      ['Chrome', 'com.android.chrome', '#4285F4', 0], ['Fichiers', 'com.android.documentsui', '#4A5468', 0],
      ['Google Play Store', 'com.android.vending', '#01875F', 1], ['Twitch', 'tv.twitch.android.app', '#9146FF', 1],
      ['SmartTube', 'com.liskovsoft.smarttubetv.beta', '#E62117', 1], ['Météo', 'com.example.weather', '#3A8DDE', 0]
    ];
    function iconFor(name, color) {
      var c = document.createElement('canvas'); c.width = c.height = 128;
      var x = c.getContext('2d');
      x.fillStyle = color; x.beginPath();
      if (x.roundRect) x.roundRect(0, 0, 128, 128, 30); else x.rect(0, 0, 128, 128);
      x.fill();
      x.fillStyle = '#fff'; x.font = '800 64px Inter, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(name.charAt(0), 64, 68);
      return c.toDataURL('image/png');
    }
    function bannerFor(name, color) {
      var c = document.createElement('canvas'); c.width = 480; c.height = 270;
      var x = c.getContext('2d');
      x.fillStyle = '#0B0C10'; x.fillRect(0, 0, 480, 270);
      x.fillStyle = color; x.font = '800 64px Inter, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(name, 240, 140);
      return c.toDataURL('image/png');
    }
    var apps = demo.map(function (d) {
      return { name: d[0], packageName: d[1], accentColor: d[2], isTv: !!d[3], category: '', icon: iconFor(d[0], d[2]) };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    var withBanner = { 'com.google.android.youtube.tv': 1, 'com.netflix.ninja': 1, 'com.disney.disneyplus': 1, 'com.spotify.tv.android': 1 };
    return {
      getInstalledApps: function () { return JSON.stringify(apps); },
      getAppBanner: function (pkg) {
        if (!withBanner[pkg]) return '';
        var a = apps.filter(function (x) { return x.packageName === pkg; })[0];
        return bannerFor(a.name, a.accentColor);
      },
      launchApp: function (pkg) { console.log('[aperçu] launchApp', pkg); return true; },
      openSystemSettings: function () { console.log('[aperçu] openSystemSettings'); return true; }
    };
  }
})();
