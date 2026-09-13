/* =========================================================================
   Chasing Cardboard — interactive store map
   Leaflet + OpenStreetMap, fed by stores.geojson (built from Google My Maps
   by tools/sync-map.mjs).
   ========================================================================= */
(function () {
  'use strict';

  var CATEGORIES = {
    independent: { label: 'Independent stores',  color: '#3b4cca' },
    occasional:  { label: 'Occasional stockists', color: '#c2185b' },
    chain:       { label: 'Retail chains',        color: '#e0a800' }
  };
  var FALLBACK = { label: 'Other', color: '#6b7194' };

  // The idle wanderer. Off until there's artwork worth showing — flip this to
  // true to switch it back on. ccWander() in the console still works either
  // way, so you can preview a sprite without enabling it for visitors.
  var WANDERER_ENABLED = false;
  // How long the map sits untouched before the wanderer strolls past
  var IDLE_SECONDS = 60;
  var UK_CENTRE = [54.2, -2.6];

  var el = function (id) { return document.getElementById(id); };

  var state = {
    shops: [],          // { name, category, lat, lng, marker, ... }
    active: {},         // category slug -> boolean
    query: '',
    origin: null,       // [lat, lng] from "near me" or a place search
    originLabel: ''
  };

  /* --- Map ------------------------------------------------------------- */

  var map = L.map('map', {
    center: UK_CENTRE,
    zoom: 6,
    zoomControl: false,
    // Stop people scrolling off into the Atlantic forever
    maxBounds: [[47.5, -14.0], [61.5, 5.0]],
    maxBoundsViscosity: 0.6
  });

  L.control.zoom({ position: 'topright' }).addTo(map);

  /* CARTO basemap key — public by design (it ships in the page), but it is
     yours: keep it when editing this file, or the tiles come back watermarked. */
  var CARTO_KEY = 'cb1_3gd3_1_ffd440054428da5fd7fd46b3';

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=' + CARTO_KEY, {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; ' +
      '<a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(map);

  var clusters = L.markerClusterGroup({
    maxClusterRadius: 55,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    chunkedLoading: true,
    iconCreateFunction: function (cluster) {
      var n = cluster.getChildCount();
      var size = n < 10 ? 38 : n < 50 ? 46 : 54;
      return L.divIcon({
        html: '<span>' + n + '</span>',
        className: 'cc-cluster' + (n < 10 ? ' cc-cluster-sm' : n < 50 ? ' cc-cluster-md' : ' cc-cluster-lg'),
        iconSize: L.point(size, size)
      });
    }
  });
  map.addLayer(clusters);

  /* --- Helpers --------------------------------------------------------- */

  function cat(slug) { return CATEGORIES[slug] || FALLBACK; }

  /* Both pin shapes ship in every marker and CSS decides which one shows, so
     switching theme is instant and never rebuilds the markers. The pixel pin
     is drawn on a 14x17 grid (1 unit = 2 CSS px) with crispEdges, so every
     block lands on a whole pixel. */
  function pinIcon(slug, active) {
    var c = cat(slug);
    return L.divIcon({
      className: 'cc-pin-wrap',
      html:
        '<span class="cc-pin' + (active ? ' is-active' : '') + '" style="--pin:' + c.color + '">' +

          // Classic: the familiar teardrop
          '<svg class="pin-shape pin-classic" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M12 22s8-6.1 8-12a8 8 0 1 0-16 0c0 5.9 8 12 8 12z"/>' +
            '<circle cx="12" cy="10" r="3.1" fill="#fff"/>' +
          '</svg>' +

          // Pixel: a chunky signpost, outlined and bevelled like a 16-bit sprite
          '<svg class="pin-shape pin-pixel" viewBox="0 0 14 17" shape-rendering="crispEdges" aria-hidden="true">' +
            // board
            '<g class="px-dark">' +
              '<rect x="1" y="0" width="12" height="10"/>' +
              '<rect x="6" y="10" width="2" height="7"/>' +   // post
            '</g>' +
            '<rect class="px-body" x="2" y="1" width="10" height="8"/>' +
            '<g class="px-hi"><rect x="2" y="1" width="10" height="1"/><rect x="2" y="2" width="1" height="6"/></g>' +
            '<g class="px-sh"><rect x="2" y="8" width="10" height="1"/><rect x="11" y="2" width="1" height="6"/></g>' +
            '<rect class="px-dot" x="5" y="3" width="4" height="4"/>' +
          '</svg>' +

        '</span>',
      iconSize: [28, 34],
      iconAnchor: [14, 34],
      popupAnchor: [0, -32]
    });
  }

  function distanceKm(a, b) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (b[0] - a[0]) * toRad, dLon = (b[1] - a[1]) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function formatDistance(km) {
    var miles = km * 0.621371;
    return miles < 0.2 ? 'here' :
           miles < 10  ? miles.toFixed(1) + ' mi' :
                         Math.round(miles) + ' mi';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function normalise(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* --- Popups ---------------------------------------------------------- */

  function popupHtml(shop) {
    var c = cat(shop.category);
    var dir = 'https://www.google.com/maps/dir/?api=1&destination=' + shop.lat + ',' + shop.lng;
    var search = 'https://www.google.com/maps/search/' +
                 encodeURIComponent(shop.name) + '/@' + shop.lat + ',' + shop.lng + ',16z';

    var html =
      '<div class="cc-popup">' +
        '<span class="cc-badge" style="--pin:' + c.color + '">' + esc(c.label) + '</span>' +
        '<h3>' + esc(shop.name) + '</h3>';

    if (shop.notes) html += '<p class="cc-popup-notes">' + esc(shop.notes) + '</p>';
    if (state.origin) html += '<p class="cc-popup-dist">' + formatDistance(distanceKm(state.origin, [shop.lat, shop.lng])) + ' from ' + esc(state.originLabel) + '</p>';

    html +=
        '<div class="cc-popup-actions">' +
          '<a class="cc-btn-sm cc-btn-solid" href="' + dir + '" target="_blank" rel="noopener">Directions</a>' +
          (shop.url
            ? '<a class="cc-btn-sm" href="' + esc(shop.url) + '" target="_blank" rel="noopener">Website</a>'
            : '<a class="cc-btn-sm" href="' + search + '" target="_blank" rel="noopener">Look up</a>') +
        '</div>' +
      '</div>';
    return html;
  }

  /* --- Filtering + list ------------------------------------------------ */

  function matchesFilters(shop) {
    if (!state.active[shop.category]) return false;
    if (state.query && shop.search.indexOf(state.query) === -1) return false;
    return true;
  }

  function applyFilters() {
    clusters.clearLayers();
    var visible = [];
    for (var i = 0; i < state.shops.length; i++) {
      var s = state.shops[i];
      if (matchesFilters(s)) { visible.push(s); clusters.addLayer(s.marker); }
    }
    state.matched = visible;
    renderList();
    updateCounts();
    return visible;
  }

  /** The list shows what's in view, nearest first — or, when a search is
      active, every match wherever it is. */
  function listCandidates() {
    var matched = state.matched || [];
    if (state.query) return matched.slice(0, 200);
    var bounds = map.getBounds();
    var out = [];
    for (var i = 0; i < matched.length; i++) {
      if (bounds.contains(matched[i].latlng)) out.push(matched[i]);
    }
    return out.slice(0, 200);
  }

  function renderList() {
    var list = el('shopList');
    var items = listCandidates();
    var from = state.origin || [map.getCenter().lat, map.getCenter().lng];

    items.sort(function (a, b) {
      return distanceKm(from, [a.lat, a.lng]) - distanceKm(from, [b.lat, b.lng]);
    });

    el('listCount').textContent =
      items.length === 0 ? 'No shops' :
      items.length === 1 ? '1 shop' :
      items.length + ' shops' + (items.length >= 200 ? '+' : '');

    el('listScope').textContent = state.query ? 'matching your search'
                              : state.origin  ? 'near ' + state.originLabel
                                              : 'in this area';

    if (items.length === 0) {
      list.innerHTML =
        '<li class="cc-empty">' +
          '<p><strong>Nothing here yet.</strong></p>' +
          '<p>' + (state.query
            ? 'No shop names match &ldquo;' + esc(state.query) + '&rdquo;. Try a town name to jump there instead.'
            : 'Try zooming out, or turning a category back on.') + '</p>' +
          '<a class="cc-btn-sm cc-btn-solid" href="submit.html">Add a shop</a>' +
        '</li>';
      return;
    }

    var html = '';
    for (var i = 0; i < items.length; i++) {
      var s = items[i];
      var c = cat(s.category);
      var d = state.origin ? formatDistance(distanceKm(state.origin, [s.lat, s.lng])) : '';
      html +=
        '<li>' +
          '<button class="cc-card" data-idx="' + s.idx + '" type="button">' +
            '<span class="cc-card-dot" style="--pin:' + c.color + '"></span>' +
            '<span class="cc-card-body">' +
              '<span class="cc-card-name">' + esc(s.name) + '</span>' +
              '<span class="cc-card-meta">' + esc(c.label) + (d ? ' &middot; ' + d : '') + '</span>' +
            '</span>' +
          '</button>' +
        '</li>';
    }
    list.innerHTML = html;
  }

  function updateCounts() {
    Object.keys(CATEGORIES).forEach(function (slug) {
      var node = el('count-' + slug);
      if (!node) return;
      var n = 0;
      for (var i = 0; i < state.shops.length; i++) {
        if (state.shops[i].category === slug) n++;
      }
      node.textContent = n;
    });
  }

  function focusShop(idx, opts) {
    var s = state.shops[idx];
    if (!s) return;
    var zoom = Math.max(map.getZoom(), 14);
    map.flyTo(s.latlng, zoom, { duration: 0.6 });
    map.once('moveend', function () {
      clusters.zoomToShowLayer(s.marker, function () { s.marker.openPopup(); });
    });
    if (opts && opts.closeSheet) closeSheet();
  }

  /* --- Search ---------------------------------------------------------- */

  var searchTimer;
  function onSearchInput(value) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      if (checkMagic(value)) return;
      state.query = normalise(value);
      applyFilters();
      el('geoHint').hidden = !(state.query && state.matched.length === 0);
    }, 180);
  }

  /** Look a town or postcode up via Nominatim and fly there. */
  function geocode(term) {
    var status = el('searchStatus');
    status.textContent = 'Looking up “' + term + '”…';

    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=' +
              encodeURIComponent(term);

    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (results) {
        if (!results || !results.length) {
          status.textContent = 'Couldn’t find that place. Try a town or postcode.';
          return;
        }
        var hit = results[0];
        setOrigin([parseFloat(hit.lat), parseFloat(hit.lon)], hit.display_name.split(',')[0]);
        map.flyTo(state.origin, 12, { duration: 0.8 });
        el('search').value = '';
        state.query = '';
        el('geoHint').hidden = true;
        status.textContent = '';
        applyFilters();
      })
      .catch(function () {
        status.textContent = 'Place search is unavailable right now.';
      });
  }

  function setOrigin(latlng, label) {
    state.origin = latlng;
    state.originLabel = label;

    if (state.originMarker) map.removeLayer(state.originMarker);
    state.originMarker = L.marker(latlng, {
      icon: L.divIcon({ className: 'cc-you', html: '<span></span>', iconSize: [18, 18] }),
      interactive: false,
      keyboard: false
    }).addTo(map);

    el('clearOrigin').hidden = false;
    el('originLabel').textContent = label;
  }

  function clearOrigin() {
    state.origin = null;
    state.originLabel = '';
    if (state.originMarker) { map.removeLayer(state.originMarker); state.originMarker = null; }
    el('clearOrigin').hidden = true;
    renderList();
  }

  function locateMe() {
    var status = el('searchStatus');
    if (!navigator.geolocation) {
      status.textContent = 'Your browser doesn’t support location. Try searching a town instead.';
      return;
    }
    status.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        setOrigin([pos.coords.latitude, pos.coords.longitude], 'you');
        map.flyTo(state.origin, 12, { duration: 0.8 });
        status.textContent = '';
        renderList();
      },
      function (err) {
        status.textContent = err.code === 1
          ? 'Location permission denied — search a town or postcode instead.'
          : 'Couldn’t get your location. Try searching instead.';
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  /* --- Theme ------------------------------------------------------------ */

  var THEME_KEY = 'cc-map-theme';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-map-theme', theme);

    // Tolerate a page that predates the toggle (usually a cached index.html):
    // the theme still applies, and nothing downstream of here gets skipped.
    var btn = el('themeToggle');
    if (!btn) return;

    var pixel = theme !== 'classic';
    btn.setAttribute('aria-pressed', pixel ? 'true' : 'false');
    var label = btn.querySelector('.theme-label');
    if (label) label.textContent = pixel ? 'Classic view' : 'Pixel view';
    btn.title = pixel ? 'Switch back to the plain map' : 'Switch to the pixel map';

    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
    applyTheme(['pixel', 'classic', 'night'].indexOf(saved) !== -1 ? saved : 'pixel');
  }

  function toggleTheme() {
    var now = document.documentElement.getAttribute('data-map-theme');
    // 'night' is the unlockable one — the button can leave it but never reach it
    applyTheme(now === 'classic' ? 'pixel' : 'classic');
  }

  /* =======================================================================
     Easter eggs. Nothing here affects the map's actual job, and each one
     fails quietly if a piece is missing.
     ======================================================================= */

  function toast(title, line) {
    var old = document.querySelector('.cc-toast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'cc-toast';
    t.innerHTML = '<strong>' + esc(title) + '</strong><span>' + esc(line) + '</span>';
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('is-going'); }, 4200);
    setTimeout(function () { if (t.parentNode) t.remove(); }, 5000);
  }

  /* --- 1. The old cheat code unlocks the night map ---------------------- */
  var KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown',
                'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
  var konamiAt = 0;

  function watchKonami(e) {
    // Never eat keystrokes meant for the search box
    if (document.activeElement &&
        /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;

    var got = String(e.key || '').toLowerCase();
    if (got === KONAMI[konamiAt]) {
      konamiAt++;
      if (konamiAt === KONAMI.length) {
        konamiAt = 0;
        applyTheme('night');
        toast('Night map unlocked', 'Hit the view button to get back to daylight.');
      }
    } else {
      konamiAt = (got === KONAMI[0]) ? 1 : 0;
    }
  }

  /* --- 2. The wanderer, out for a stroll --------------------------------
     The artwork lives in sprites/wanderer.png and is yours to replace —
     see sprites/README.md. Nothing here knows what it looks like. */

  var idleTimer, wandering = false;

  function sendWanderer() {
    if (wandering || document.hidden) return;
    var holder = document.querySelector('.map-holder');
    if (!holder) return;
    wandering = true;

    var w = document.createElement('div');
    w.className = 'cc-wanderer';
    if (Math.random() < 0.5) w.classList.add('is-backwards');
    holder.appendChild(w);

    setTimeout(function () {
      if (w.parentNode) w.remove();
      wandering = false;
    }, 19000);
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(sendWanderer, IDLE_SECONDS * 1000);
  }

  /* --- 3. Say the magic word in the search box -------------------------- */
  var MAGIC = ['shiny', 'holo', 'foil', 'sparkle'];
  var foilTimer;

  function checkMagic(value) {
    if (MAGIC.indexOf(String(value).trim().toLowerCase()) === -1) return false;
    document.body.classList.add('is-foil');
    clearTimeout(foilTimer);
    foilTimer = setTimeout(function () { document.body.classList.remove('is-foil'); }, 4500);
    toast('Foil finish', 'Every pin on the map, briefly worth a great deal more.');
    return true;
  }

  function initEggs() {
    document.addEventListener('keydown', watchKonami);

    /* Preview hook — works whether or not the wanderer is enabled, so you can
       check a new sprite without turning it on for everyone. */
    window.ccWander = function () { wandering = false; sendWanderer(); };

    if (!WANDERER_ENABLED) return;

    ['mousemove', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
      document.addEventListener(ev, resetIdle, { passive: true });
    });
    map.on('moveend zoomend', resetIdle);
    resetIdle();

    if (/wander/.test(location.hash + location.search)) {
      setTimeout(window.ccWander, 600);
    }
  }

  /* --- Mobile sheet ---------------------------------------------------- */

  function openSheet()  { document.body.classList.add('sheet-open');  el('sheetToggle').setAttribute('aria-expanded', 'true'); }
  function closeSheet() { document.body.classList.remove('sheet-open'); el('sheetToggle').setAttribute('aria-expanded', 'false'); }

  /* --- Wiring ---------------------------------------------------------- */

  function wireUp() {
    el('search').addEventListener('input', function (e) { onSearchInput(e.target.value); });

    el('search').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var raw = e.target.value.trim();
      if (!raw) return;
      // A single strong name match? Go straight there. Otherwise treat it as a place.
      if (state.matched && state.matched.length === 1) focusShop(state.matched[0].idx, { closeSheet: true });
      else geocode(raw);
    });

    el('geoSearchBtn').addEventListener('click', function () {
      var raw = el('search').value.trim();
      if (raw) geocode(raw);
    });

    el('nearMe').addEventListener('click', locateMe);
    el('clearOrigin').addEventListener('click', clearOrigin);

    Object.keys(CATEGORIES).forEach(function (slug) {
      var box = el('cat-' + slug);
      if (!box) return;
      box.addEventListener('change', function () {
        state.active[slug] = box.checked;
        applyFilters();
      });
    });

    // Event delegation for the (frequently re-rendered) list
    el('shopList').addEventListener('click', function (e) {
      var btn = e.target.closest('.cc-card');
      if (btn) focusShop(Number(btn.dataset.idx), { closeSheet: true });
    });

    el('shopList').addEventListener('mouseover', function (e) {
      var btn = e.target.closest('.cc-card');
      if (!btn) return;
      var s = state.shops[Number(btn.dataset.idx)];
      if (s && s.marker._icon) s.marker._icon.querySelector('.cc-pin').classList.add('is-active');
    });

    el('shopList').addEventListener('mouseout', function (e) {
      var btn = e.target.closest('.cc-card');
      if (!btn) return;
      var s = state.shops[Number(btn.dataset.idx)];
      if (s && s.marker._icon) s.marker._icon.querySelector('.cc-pin').classList.remove('is-active');
    });

    if (el('themeToggle')) el('themeToggle').addEventListener('click', toggleTheme);

    el('sheetToggle').addEventListener('click', function () {
      document.body.classList.contains('sheet-open') ? closeSheet() : openSheet();
    });
    el('sheetClose').addEventListener('click', closeSheet);

    map.on('moveend', function () { if (!state.query) renderList(); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSheet();
      // "/" focuses search, the way every map app you've used does it
      if (e.key === '/' && document.activeElement !== el('search')) {
        e.preventDefault();
        el('search').focus();
      }
    });
  }

  /* --- Boot ------------------------------------------------------------ */

  function build(geojson) {
    var feats = geojson.features || [];

    state.shops = feats.map(function (f, i) {
      var coords = f.geometry.coordinates;
      var p = f.properties || {};
      var shop = {
        idx: i,
        name: p.name || 'Unnamed shop',
        category: CATEGORIES[p.category] ? p.category : 'independent',
        notes: p.notes || '',
        url: p.url || '',
        lat: coords[1],
        lng: coords[0]
      };
      shop.latlng = L.latLng(shop.lat, shop.lng);
      shop.search = normalise(shop.name);
      shop.marker = L.marker(shop.latlng, {
        icon: pinIcon(shop.category, false),
        title: shop.name,
        alt: shop.name
      });
      shop.marker.bindPopup(function () { return popupHtml(shop); }, {
        className: 'cc-popup-wrap',
        closeButton: true,
        maxWidth: 260
      });
      return shop;
    });

    Object.keys(CATEGORIES).forEach(function (slug) { state.active[slug] = true; });

    applyFilters();

    var updated = geojson.metadata && geojson.metadata.generated;
    el('dataMeta').textContent =
      state.shops.length + ' shops' +
      (updated ? ' · updated ' + new Date(updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

    initTheme();
    initEggs();
    el('mapLoading').hidden = true;
    wireUp();
  }

  function fail(title, message, extra) {
    el('mapLoading').innerHTML =
      '<div class="cc-loading-inner">' +
        '<p><strong>' + esc(title) + '</strong></p>' +
        '<p>' + esc(message) + '</p>' +
        (extra ? '<pre class="cc-loading-hint">' + esc(extra) + '</pre>' : '') +
      '</div>';
  }

  // Opening the file directly? Browsers refuse to fetch anything from a
  // file:// page, so the shop data can never load. Say so plainly rather than
  // showing a mystery error.
  if (location.protocol === 'file:') {
    fail(
      'Serve this folder over HTTP.',
      'Browsers block data files on file:// pages, so the shops can’t load. ' +
      'Run a local server from the site folder and open the localhost address instead:',
      'python -m http.server 8000\nthen open http://localhost:8000'
    );
    return;
  }

  try {
    console.log(
      '%c Chasing Cardboard %c a community map of UK shops selling Pokémon cards ',
      'background:#2b3050;color:#ede68c;font-weight:bold;padding:4px 6px;border-radius:3px 0 0 3px',
      'background:#73cea5;color:#2b3050;padding:4px 6px;border-radius:0 3px 3px 0'
    );
    console.log('Know a shop that\'s missing? https://chasingcardboard.github.io/submit.html');
    console.log('There are a few things hidden in here. Try the old cheat code on your keyboard.');
  } catch (e) {}

  fetch('stores.geojson', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(build)
    .catch(function (err) {
      fail(
        'The map couldn’t load.',
        'Store data isn’t available right now (' + err.message + '). Please try again shortly.'
      );
    });
})();
