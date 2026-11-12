/* ==========================================================================
   X96Q Launcher — logique de l'interface 10-foot
   - Navigation spatiale à la télécommande (flèches, OK, Retour)
   - Favoris épinglables (localStorage)
   - Défilement horizontal centré, uniquement via transform
   ========================================================================== */
(function () {
  'use strict';

  // Doit correspondre à --card-w / --card-gap / --safe dans style.css
  var CARD_W = 248;
  var CARD_GAP = 24;
  var SAFE = 48;
  var STAGE_W = 1920;

  var LONG_PRESS_MS = 550;
  var STORAGE_FAVORITES = 'x96q.favorites.v1';
  var STORAGE_LAST = 'x96q.lastFocus.v1';

  // ------------------------------------------------------------------ Pont natif

  var bridge = window.AndroidBridge || createMockBridge();

  function createMockBridge() {
    // Aperçu dans un navigateur de bureau : données factices.
    var names = ['YouTube', 'Netflix', 'Prime Video', 'Disney+', 'Plex', 'Kodi', 'VLC', 'Spotify',
      'Twitch', 'Molotov', 'France tv', 'Arte', 'myCANAL', 'Google Play Store', 'Chrome', 'Fichiers',
      'Musique', 'Galerie', 'Météo', 'SmartTube', 'Stremio', 'Apple TV', 'Deezer', 'TED'];
    var apps = names.map(function (n) {
      return { name: n, packageName: 'com.example.' + n.toLowerCase().replace(/[^a-z0-9]/g, ''), icon: '', isTv: true };
    });
    return {
      getInstalledApps: function () { return JSON.stringify(apps); },
      launchApp: function (pkg) { console.log('[mock] launchApp', pkg); return true; },
      openSystemSettings: function () { console.log('[mock] openSystemSettings'); return true; }
    };
  }

  // ------------------------------------------------------------------ Stockage

  function readJson(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJson(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* stockage indisponible */ }
  }

  // ------------------------------------------------------------------ État

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    clock: $('clock'), date: $('date'), settings: $('settingsButton'),
    heroTile: $('heroTile'), heroIcon: $('heroIcon'), heroText: $('heroText'),
    heroKicker: $('heroKicker'), heroTitle: $('heroTitle'), heroMeta: $('heroMeta'),
    heroHints: $('heroHints'), hintPrimary: $('hintPrimary'), hintPin: $('hintPin'),
    ambientA: $('ambientA'), ambientB: $('ambientB'), toast: $('toast')
  };

  var rows = {
    favorites: { key: 'favorites', el: $('rowFavorites'), track: $('trackFavorites'), count: $('countFavorites'), items: [], cards: [], col: 0 },
    all:       { key: 'all',       el: $('rowAll'),       track: $('trackAll'),       count: $('countAll'),       items: [], cards: [], col: 0 }
  };

  var state = {
    apps: [],
    byPkg: {},
    favorites: readJson(STORAGE_FAVORITES, []),
    zone: 'rows',      // 'top' | 'rows'
    rowIndex: 0,       // index dans activeRows()
    focusedCard: null,
    loaded: false
  };

  function activeRows() {
    var list = [];
    if (rows.favorites.items.length) list.push(rows.favorites);
    list.push(rows.all);
    return list;
  }

  // ------------------------------------------------------------------ Horloge

  var timeFmt, dateFmt;
  try {
    timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
    dateFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  } catch (e) { timeFmt = null; }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  var clockTimer = 0;
  function tick() {
    clearTimeout(clockTimer);
    var now = new Date();
    els.clock.textContent = timeFmt ? timeFmt.format(now) : pad(now.getHours()) + ':' + pad(now.getMinutes());
    els.clock.setAttribute('datetime', now.toISOString());
    if (dateFmt) {
      var d = dateFmt.format(now);
      els.date.textContent = d.charAt(0).toUpperCase() + d.slice(1); // « Jeudi 12 novembre »
    }
    // Recalage sur la minute suivante (pas de timer à la seconde inutile).
    clockTimer = setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  }

  // ------------------------------------------------------------------ Données

  function loadApps() {
    var list = [];
    try { list = JSON.parse(bridge.getInstalledApps() || '[]'); } catch (e) { list = []; }
    state.apps = list;
    state.byPkg = {};
    list.forEach(function (a) { state.byPkg[a.packageName] = a; });

    // Nettoie les favoris d'apps désinstallées.
    var cleaned = state.favorites.filter(function (p) { return !!state.byPkg[p]; });
    if (cleaned.length !== state.favorites.length) {
      state.favorites = cleaned;
      writeJson(STORAGE_FAVORITES, cleaned);
    }
    state.loaded = true;
  }

  function isFavorite(pkg) { return state.favorites.indexOf(pkg) !== -1; }

  // ------------------------------------------------------------------ Rendu

  function monogramFor(name) {
    var span = document.createElement('span');
    span.className = 'monogram';
    span.textContent = (name || '?').trim().charAt(0).toUpperCase();
    return span;
  }

  function buildCard(app, showPin) {
    var card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('data-pkg', app.packageName);

    var face = document.createElement('div');
    face.className = 'card-face';
    if (app.icon) {
      var img = document.createElement('img');
      img.className = 'card-icon';
      img.width = 80; img.height = 80;
      img.alt = '';
      img.decoding = 'async';
      img.src = app.icon;
      face.appendChild(img);
    } else {
      face.appendChild(monogramFor(app.name));
    }
    if (showPin && isFavorite(app.packageName)) {
      var pin = document.createElement('span');
      pin.className = 'card-pin';
      face.appendChild(pin);
    }

    var label = document.createElement('p');
    label.className = 'card-label';
    label.textContent = app.name;

    card.appendChild(face);
    card.appendChild(label);
    return card;
  }

  function renderRow(row, items, showPin) {
    row.items = items;
    var frag = document.createDocumentFragment();
    row.cards = items.map(function (app) {
      var c = buildCard(app, showPin);
      frag.appendChild(c);
      return c;
    });
    row.track.textContent = '';
    row.track.appendChild(frag);
    row.count.textContent = items.length ? String(items.length) : '';
    if (row.col >= items.length) row.col = Math.max(0, items.length - 1);
  }

  function renderSkeleton() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 7; i++) {
      var c = document.createElement('div');
      c.className = 'card is-skeleton';
      c.innerHTML = '<div class="card-face"></div><p class="card-label"></p>';
      frag.appendChild(c);
    }
    rows.all.track.appendChild(frag);
  }

  function renderAll() {
    var favApps = state.favorites.map(function (p) { return state.byPkg[p]; }).filter(Boolean);
    renderRow(rows.favorites, favApps, false);
    renderRow(rows.all, state.apps, true);

    rows.favorites.el.classList.toggle('is-empty', favApps.length === 0);
  }

  // ------------------------------------------------------------------ Focus

  function currentRow() {
    var list = activeRows();
    if (state.rowIndex >= list.length) state.rowIndex = list.length - 1;
    if (state.rowIndex < 0) state.rowIndex = 0;
    return list[state.rowIndex];
  }

  function currentApp() {
    if (state.zone !== 'rows') return null;
    var row = currentRow();
    return row ? row.items[row.col] || null : null;
  }

  function applyFocus(opts) {
    opts = opts || {};
    if (state.focusedCard) state.focusedCard.classList.remove('is-focused', 'is-pressed');
    els.settings.classList.toggle('is-focused', state.zone === 'top');

    var list = activeRows();
    rows.favorites.el.classList.remove('is-active');
    rows.all.el.classList.remove('is-active');

    if (state.zone === 'rows') {
      var row = currentRow();
      row.el.classList.add('is-active');
      var card = row.cards[row.col] || null;
      if (card) card.classList.add('is-focused');
      state.focusedCard = card;
      scrollRow(row);
      var app = row.items[row.col];
      if (app) writeJson(STORAGE_LAST, { pkg: app.packageName, row: row.key });
    } else {
      state.focusedCard = null;
    }

    // Les deux rangées sont toujours visibles ; la rangée Favoris vide reste en place (message d'aide).
    rows.favorites.el.classList.remove('is-hidden');
    updateHero(!opts.repeat);
    return list;
  }

  /** Centre la carte active ; bornes : début aligné sur la safe zone, fin aussi. */
  function scrollRow(row) {
    var n = row.items.length;
    if (!n) { row.track.style.transform = 'translate3d(0,0,0)'; return; }
    var trackW = n * CARD_W + (n - 1) * CARD_GAP;
    var visibleW = STAGE_W - SAFE * 2;
    var center = row.col * (CARD_W + CARD_GAP) + CARD_W / 2;
    var x = (STAGE_W / 2 - SAFE) - center;
    var minX = Math.min(0, visibleW - trackW);
    if (x > 0) x = 0;
    if (x < minX) x = minX;
    row.track.style.transform = 'translate3d(' + Math.round(x) + 'px,0,0)';
  }

  function moveHorizontal(delta, repeat) {
    if (state.zone === 'top') return;
    var row = currentRow();
    var next = row.col + delta;
    if (next < 0 || next >= row.items.length) { bump(delta); return; }
    row.col = next;
    applyFocus({ repeat: repeat });
  }

  function moveVertical(delta, repeat) {
    var list = activeRows();
    if (state.zone === 'top') {
      if (delta > 0) { state.zone = 'rows'; state.rowIndex = 0; applyFocus({ repeat: repeat }); }
      return;
    }
    var next = state.rowIndex + delta;
    if (next < 0) { state.zone = 'top'; applyFocus({ repeat: repeat }); return; }
    if (next >= list.length) { bump(0); return; }
    state.rowIndex = next;
    applyFocus({ repeat: repeat });
  }

  function bump(dir) {
    var card = state.focusedCard;
    if (!card) return;
    var cls = dir < 0 ? 'is-bump-left' : dir > 0 ? 'is-bump-right' : 'is-bump-down';
    card.classList.remove('is-bump-left', 'is-bump-right', 'is-bump-down');
    void card.offsetWidth; // relance l'animation
    card.classList.add(cls);
    setTimeout(function () { card.classList.remove(cls); }, 180);
  }

  // ------------------------------------------------------------------ Hero

  var colorCache = {};
  var ambientFront = els.ambientA;
  var ambientTimer = 0;
  var heroPkg = null;

  function updateHero(animate) {
    if (!state.loaded) return;

    if (state.zone === 'top') {
      setHero({
        kicker: 'Système', title: 'Paramètres', meta: 'Réseau, affichage, son et applications Android',
        icon: '', glyph: true, name: 'P', pinned: false, primary: 'Ouvrir', showPin: false, key: '#settings'
      }, animate);
      setAmbient(null);
      return;
    }

    var app = currentApp();
    if (!app) {
      setHero({ kicker: 'Accueil', title: 'Aucune application', meta: 'Installez une application pour la voir ici.',
        icon: '', name: '—', pinned: false, primary: '', showPin: false, key: '#empty' }, animate);
      return;
    }
    var pinned = isFavorite(app.packageName);
    setHero({
      kicker: pinned ? '<span class="is-pinned">Favori</span>' : (app.isTv ? 'Application TV' : 'Application'),
      title: app.name, meta: app.packageName, icon: app.icon, name: app.name, pinned: pinned,
      primary: 'Ouvrir', showPin: true, key: app.packageName
    }, animate);

    clearTimeout(ambientTimer);
    ambientTimer = setTimeout(function () { setAmbient(app); }, 140); // évite de repeindre pendant un défilement rapide
  }

  function setHero(h, animate) {
    var changed = heroPkg !== h.key;
    heroPkg = h.key;

    els.heroKicker.innerHTML = h.kicker;
    els.heroTitle.textContent = h.title;
    els.heroMeta.textContent = h.meta;
    els.hintPrimary.textContent = h.primary;
    els.hintPin.textContent = h.pinned ? 'Retirer des favoris' : 'Épingler aux favoris';
    els.heroHints.children[1].style.display = h.showPin ? '' : 'none';
    els.heroHints.classList.toggle('is-hidden', !h.primary);

    var old = els.heroTile.querySelector('.monogram, .pill-icon');
    if (old) old.remove();
    if (h.icon) {
      els.heroTile.classList.remove('is-empty');
      if (els.heroIcon.getAttribute('src') !== h.icon) els.heroIcon.src = h.icon;
    } else {
      els.heroTile.classList.add('is-empty');
      els.heroIcon.removeAttribute('src');
      els.heroTile.appendChild(h.glyph ? els.settings.querySelector('svg').cloneNode(true) : monogramFor(h.name));
    }

    if (changed && animate) {
      els.heroText.classList.remove('is-entering');
      void els.heroText.offsetWidth;
      els.heroText.classList.add('is-entering');
    }
  }

  /** Couleur moyenne (pixels opaques, ni trop clairs ni trop sombres) de l'icône 96 px. */
  function dominantColor(app, cb) {
    if (colorCache[app.packageName] !== undefined) { cb(colorCache[app.packageName]); return; }
    if (!app.icon) { colorCache[app.packageName] = null; cb(null); return; }
    var img = new Image();
    img.onload = function () {
      try {
        var size = 16;
        var canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        var d = ctx.getImageData(0, 0, size, size).data;
        var r = 0, g = 0, b = 0, n = 0;
        for (var i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 200) continue;
          var max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2]);
          if (max < 32 || min > 224) continue;           // ignore noir/blanc
          var sat = max - min;
          var w = 1 + sat / 32;                           // favorise les pixels saturés
          r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w;
        }
        var color = n ? 'rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')' : null;
        colorCache[app.packageName] = color;
        cb(color);
      } catch (e) { colorCache[app.packageName] = null; cb(null); }
    };
    img.onerror = function () { colorCache[app.packageName] = null; cb(null); };
    img.src = app.icon;
  }

  function setAmbient(app) {
    var back = ambientFront === els.ambientA ? els.ambientB : els.ambientA;
    if (!app) {
      ambientFront.classList.remove('is-visible');
      return;
    }
    dominantColor(app, function (color) {
      if (currentApp() !== app) return;
      if (!color) { ambientFront.classList.remove('is-visible'); return; }
      // Halo plat, peint une seule fois par couleur ; seule l'opacité est ensuite animée.
      back.style.background = 'radial-gradient(closest-side, ' + color + ', rgba(7,8,12,0))';
      back.classList.add('is-visible');
      ambientFront.classList.remove('is-visible');
      ambientFront = back;
    });
  }

  // ------------------------------------------------------------------ Actions

  var toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('is-visible'); }, 1600);
  }

  function activate() {
    if (state.zone === 'top') {
      if (!bridge.openSystemSettings()) toast('Paramètres indisponibles');
      return;
    }
    var app = currentApp();
    if (!app) return;
    var card = state.focusedCard;
    if (card) {
      card.classList.add('is-pressed');
      setTimeout(function () { card.classList.remove('is-pressed'); }, 140);
    }
    var ok = false;
    try { ok = bridge.launchApp(app.packageName); } catch (e) { ok = false; }
    if (ok === false) toast('Impossible d’ouvrir ' + app.name);
  }

  function togglePin() {
    var app = currentApp();
    if (!app) return;
    var pkg = app.packageName;
    var row = currentRow();
    var wasFavRow = row === rows.favorites;

    if (isFavorite(pkg)) {
      state.favorites = state.favorites.filter(function (p) { return p !== pkg; });
      toast('Retiré des favoris');
    } else {
      state.favorites = state.favorites.concat(pkg);
      toast('Épinglé aux favoris');
    }
    writeJson(STORAGE_FAVORITES, state.favorites);

    renderAll();
    // Garder le focus sur la même application, quelle que soit la rangée.
    var list = activeRows();
    if (wasFavRow) {
      if (!rows.favorites.items.length) {
        state.rowIndex = list.indexOf(rows.all);
        rows.all.col = Math.max(0, indexOfPkg(rows.all, pkg));
      }
    } else {
      state.rowIndex = list.indexOf(rows.all);
    }
    heroPkg = null;
    applyFocus();
  }

  function indexOfPkg(row, pkg) {
    for (var i = 0; i < row.items.length; i++) if (row.items[i].packageName === pkg) return i;
    return -1;
  }

  /** RETOUR : ne quitte jamais, ramène progressivement au début. */
  function onBack() {
    if (state.zone === 'top') { state.zone = 'rows'; state.rowIndex = 0; applyFocus(); return; }
    var row = currentRow();
    if (row.col > 0) { row.col = 0; applyFocus(); return; }
    if (state.rowIndex > 0) { state.rowIndex = 0; applyFocus(); return; }
    bump(-1);
  }

  function onHome() {
    state.zone = 'rows';
    state.rowIndex = 0;
    rows.favorites.col = 0;
    rows.all.col = 0;
    applyFocus();
  }

  function reload() {
    var pkg = currentApp() && currentApp().packageName;
    var rowKey = state.zone === 'rows' ? currentRow().key : null;
    loadApps();
    renderAll();
    restoreFocus(pkg, rowKey);
    heroPkg = null;
    applyFocus();
  }

  function restoreFocus(pkg, rowKey) {
    var list = activeRows();
    var row = rowKey === 'favorites' && rows.favorites.items.length ? rows.favorites : (rowKey ? rows.all : list[0]);
    state.rowIndex = Math.max(0, list.indexOf(row));
    if (pkg) {
      var i = indexOfPkg(row, pkg);
      if (i >= 0) row.col = i;
    }
  }

  // ------------------------------------------------------------------ Clavier

  var enterDownAt = 0;
  var enterTimer = 0;
  var enterConsumed = false;

  function isEnter(e) {
    return e.key === 'Enter' || e.key === 'Select' || e.keyCode === 13 || e.keyCode === 23;
  }

  document.addEventListener('keydown', function (e) {
    if (!state.loaded) { e.preventDefault(); return; }
    var repeat = !!e.repeat;

    if (isEnter(e)) {
      e.preventDefault();
      if (repeat || enterDownAt) return;
      enterDownAt = Date.now();
      enterConsumed = false;
      if (state.zone === 'rows') {
        enterTimer = setTimeout(function () { enterConsumed = true; togglePin(); }, LONG_PRESS_MS);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); moveHorizontal(-1, repeat); break;
      case 'ArrowRight': e.preventDefault(); moveHorizontal(1, repeat); break;
      case 'ArrowUp':    e.preventDefault(); moveVertical(-1, repeat); break;
      case 'ArrowDown':  e.preventDefault(); moveVertical(1, repeat); break;
      case 'Backspace':
      case 'Escape':
      case 'GoBack':
      case 'BrowserBack':
        e.preventDefault(); if (!repeat) onBack(); break;
      case 'ContextMenu':
      case 'p':
        e.preventDefault(); if (!repeat) togglePin(); break;
    }
  }, true);

  document.addEventListener('keyup', function (e) {
    if (!isEnter(e)) return;
    e.preventDefault();
    clearTimeout(enterTimer);
    var wasDown = enterDownAt;
    enterDownAt = 0;
    if (wasDown && !enterConsumed) activate();
  }, true);

  // Pas de souris sur TV, mais clic utile pour l'aperçu dans un navigateur.
  document.addEventListener('click', function (e) {
    var card = e.target.closest && e.target.closest('.card');
    if (e.target.closest && e.target.closest('#settingsButton')) { state.zone = 'top'; applyFocus(); activate(); return; }
    if (!card) return;
    var list = activeRows();
    for (var r = 0; r < list.length; r++) {
      var i = list[r].cards.indexOf(card);
      if (i >= 0) { state.zone = 'rows'; state.rowIndex = r; list[r].col = i; applyFocus(); activate(); return; }
    }
  });

  window.addEventListener('blur', function () { clearTimeout(enterTimer); enterDownAt = 0; });

  // ------------------------------------------------------------------ API appelée par le natif

  window.Launcher = {
    onBack: onBack,
    onHome: onHome,
    onMenu: togglePin,
    onResume: function () { clearTimeout(enterTimer); enterDownAt = 0; tick(); },
    reload: reload
  };

  // ------------------------------------------------------------------ Démarrage

  function start() {
    tick();
    renderSkeleton();
    // Deux frames : le squelette est peint avant l'appel (potentiellement long) au pont natif.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        loadApps();
        renderAll();
        var last = readJson(STORAGE_LAST, null);
        restoreFocus(last && last.pkg, last && last.row);
        applyFocus();
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
