/* =========================================================================
   Chasing Cardboard — store submission form
   Posts to a Google Apps Script web app, which appends to the review sheet.
   Everything here is best-effort convenience; the container that reads the
   sheet re-validates before anything reaches the map.
   ========================================================================= */
(function () {
  'use strict';

  /* Paste your Apps Script deployment URL here (see apps-script/README.md). */
  var ENDPOINT = 'https://script.google.com/macros/s/AKfycbyyJvCWELtB-62BYAmTN_nXzqeCSoqeRSLIQ0m_M8C3dOaOD-_LRs9wc339lsaGoASaNQ/exec';

  var UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
  var DUPE_RADIUS_KM = 0.6;

  var el = function (id) { return document.getElementById(id); };

  var form = el('form');
  var openedAt = Date.now();
  var picked = null;      // { lat, lng, source }
  var pickMap = null, pickMarker = null;
  var stores = [];        // existing shops, for the duplicate check

  /* --- Existing stores, for duplicate warnings ------------------------- */
  fetch('stores.geojson', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (g) {
      if (!g || !g.features) return;
      stores = g.features.map(function (f) {
        return {
          name: f.properties.name || '',
          key: normalise(f.properties.name || ''),
          lat: f.geometry.coordinates[1],
          lng: f.geometry.coordinates[0]
        };
      });
    })
    .catch(function () { /* duplicate check is a nicety, not a requirement */ });

  /* --- Helpers --------------------------------------------------------- */

  function normalise(s) {
    return String(s).toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\b(ltd|limited|the|store|stores|shop|uk)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function distanceKm(aLat, aLng, bLat, bLng) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (bLat - aLat) * toRad, dLon = (bLng - aLng) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(aLat * toRad) * Math.cos(bLat * toRad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setError(field, message) {
    var node = document.querySelector('.field-error[data-for="' + field + '"]');
    var input = el(field) || document.querySelector('[name="' + field + '"]');
    if (node) { node.textContent = message || ''; node.classList.toggle('is-shown', !!message); }
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    var wrap = node && node.closest('.field');
    if (wrap) wrap.classList.toggle('has-error', !!message);
  }

  function clearErrors() {
    ['name', 'category', 'website', 'address', 'town', 'postcode', 'email']
      .forEach(function (f) { setError(f, ''); });
    el('formError').hidden = true;
  }

  function tidyPostcode(raw) {
    var p = String(raw).toUpperCase().replace(/\s+/g, '');
    return p.length > 3 ? p.slice(0, p.length - 3) + ' ' + p.slice(-3) : p;
  }

  /* --- Validation ------------------------------------------------------ */

  function validate() {
    clearErrors();
    var ok = true;
    var v = function (id) { return (el(id).value || '').trim(); };

    if (v('name').length < 2) { setError('name', 'Please give the shop’s name.'); ok = false; }

    if (!form.querySelector('input[name="category"]:checked')) {
      setError('category', 'Pick the kind of shop this is.'); ok = false;
    }

    if (v('address').length < 3) { setError('address', 'Please give a street address.'); ok = false; }
    if (v('town').length < 2)    { setError('town', 'Which town or city?'); ok = false; }

    if (!UK_POSTCODE.test(v('postcode'))) {
      setError('postcode', 'That doesn’t look like a UK postcode.'); ok = false;
    }

    var site = v('website');
    if (site && !/^https?:\/\/[^\s.]+\.[^\s]{2,}$/i.test(site)) {
      setError('website', 'Include the full address, starting http:// or https://'); ok = false;
    }

    var mail = v('email');
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) {
      setError('email', 'That email doesn’t look right.'); ok = false;
    }

    if (!picked) {
      setError('postcode', 'Please use “Find on map” and drop the pin on the shop.');
      ok = false;
    }

    return ok;
  }

  /* --- Location picker -------------------------------------------------- */

  function buildPickMap(lat, lng) {
    el('locate').hidden = false;

    if (!pickMap) {
      pickMap = L.map('pickMap', { scrollWheelZoom: false, zoomControl: true })
                 .setView([lat, lng], 17);

      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
      }).addTo(pickMap);

      pickMarker = L.marker([lat, lng], {
        draggable: true,
        autoPan: true,
        icon: L.divIcon({
          className: 'cc-pin-wrap',
          html: '<span class="cc-pin" style="--pin:#3b4cca"><svg viewBox="0 0 24 24"><path d="M12 22s8-6.1 8-12a8 8 0 1 0-16 0c0 5.9 8 12 8 12z"/><circle cx="12" cy="10" r="3.1" fill="#fff"/></svg></span>',
          iconSize: [28, 34], iconAnchor: [14, 33]
        })
      }).addTo(pickMap);

      pickMarker.on('dragend', function () {
        var p = pickMarker.getLatLng();
        setPicked(p.lat, p.lng, 'dragged');
      });

      pickMap.on('click', function (e) {
        pickMarker.setLatLng(e.latlng);
        setPicked(e.latlng.lat, e.latlng.lng, 'clicked');
      });
    } else {
      pickMap.setView([lat, lng], 17);
      pickMarker.setLatLng([lat, lng]);
    }

    // Leaflet needs a nudge when its container was hidden at init
    setTimeout(function () { pickMap.invalidateSize(); }, 60);
    setPicked(lat, lng, 'geocoded');
  }

  function setPicked(lat, lng, source) {
    picked = { lat: +lat.toFixed(6), lng: +lng.toFixed(6), source: source };
    el('coordsOut').textContent = 'Pin at ' + picked.lat + ', ' + picked.lng +
      (source === 'geocoded' ? ' — drag it if that’s not quite right.' : ' — nice.');
    setError('postcode', '');
    checkDuplicates();
  }

  function findOnMap() {
    var pc = (el('postcode').value || '').trim();
    if (!UK_POSTCODE.test(pc)) {
      setError('postcode', 'That doesn’t look like a UK postcode.');
      return;
    }
    setError('postcode', '');
    el('postcode').value = tidyPostcode(pc);

    var btn = el('findBtn');
    btn.disabled = true;
    btn.textContent = 'Looking up…';

    var q = [el('address').value, el('town').value, tidyPostcode(pc)]
              .map(function (s) { return (s || '').trim(); })
              .filter(Boolean).join(', ');

    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=' +
              encodeURIComponent(q);

    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (hits) {
        if (hits && hits.length) {
          buildPickMap(parseFloat(hits[0].lat), parseFloat(hits[0].lon));
          el('locateStatus').textContent =
            'Found the address. Drag the pin onto the shop’s door if it’s slightly off.';
          return;
        }
        // Fall back to the postcode alone before giving up
        return fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=' +
                     encodeURIComponent(tidyPostcode(pc)))
          .then(function (r) { return r.json(); })
          .then(function (pcHits) {
            if (pcHits && pcHits.length) {
              buildPickMap(parseFloat(pcHits[0].lat), parseFloat(pcHits[0].lon));
              el('locateStatus').textContent =
                'We could only find the postcode, not the full address — please drag the pin onto the shop.';
            } else {
              setError('postcode', 'We couldn’t find that address. Check the postcode and try again.');
            }
          });
      })
      .catch(function () {
        setError('postcode', 'The address lookup is unavailable right now. Please try again shortly.');
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Find on map';
      });
  }

  /* --- Duplicate check -------------------------------------------------- */

  function checkDuplicates() {
    var warn = el('dupeWarn');
    if (!picked || !stores.length) { warn.hidden = true; return; }

    var typed = normalise(el('name').value || '');
    var near = stores.filter(function (s) {
      return distanceKm(picked.lat, picked.lng, s.lat, s.lng) <= DUPE_RADIUS_KM;
    });

    var hits = near.filter(function (s) {
      if (!typed) return false;
      return s.key === typed || s.key.indexOf(typed) !== -1 || typed.indexOf(s.key) !== -1;
    });

    // Same name anywhere very close, or anything at all within ~50m
    var veryClose = near.filter(function (s) {
      return distanceKm(picked.lat, picked.lng, s.lat, s.lng) <= 0.05;
    });

    var show = hits.concat(veryClose.filter(function (s) { return hits.indexOf(s) === -1; }))
                   .slice(0, 4);

    if (!show.length) { warn.hidden = true; return; }

    el('dupeList').innerHTML = show.map(function (s) {
      var d = distanceKm(picked.lat, picked.lng, s.lat, s.lng);
      var away = d < 0.1 ? 'right here' : (d * 0.621371).toFixed(1) + ' mi away';
      return '<li>' + esc(s.name) + ' <span>· ' + away + '</span></li>';
    }).join('');
    warn.hidden = false;
  }

  /* --- Submit ----------------------------------------------------------- */

  function submit(e) {
    e.preventDefault();

    if (ENDPOINT.indexOf('PASTE_YOUR') === 0) {
      showFormError('This form isn’t connected yet. Please try again later.');
      return;
    }

    if (!validate()) {
      var firstBad = form.querySelector('.has-error input, .has-error textarea, [aria-invalid]');
      if (firstBad) firstBad.focus();
      return;
    }

    var btn = el('submitBtn');
    btn.disabled = true;
    btn.classList.add('is-loading');

    var payload = {
      name:      el('name').value.trim(),
      category:  form.querySelector('input[name="category"]:checked').value,
      website:   el('website').value.trim(),
      notes:     el('notes').value.trim(),
      address:   el('address').value.trim(),
      town:      el('town').value.trim(),
      postcode:  tidyPostcode(el('postcode').value.trim()),
      lat:       picked.lat,
      lng:       picked.lng,
      pinSource: picked.source,
      email:     el('email').value.trim(),
      // Anti-bot signals, checked server-side
      company:   el('company').value,          // honeypot: must stay empty
      elapsed:   Math.round((Date.now() - openedAt) / 1000),
      page:      location.href
    };

    // text/plain keeps this a "simple" request, so no CORS preflight —
    // Apps Script web apps don't answer OPTIONS.
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.ok) {
          form.hidden = true;
          el('done').hidden = false;
          el('done').scrollIntoView({ behavior: 'smooth', block: 'center' });
          try { localStorage.setItem('cc-last-submit', String(Date.now())); } catch (err) {}
        } else {
          showFormError((res && res.error) || 'Something went wrong. Please try again.');
        }
      })
      .catch(function () {
        showFormError('We couldn’t reach the submission service. Please try again in a moment.');
      })
      .then(function () {
        btn.disabled = false;
        btn.classList.remove('is-loading');
      });
  }

  function showFormError(message) {
    var node = el('formError');
    node.textContent = message;
    node.hidden = false;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* --- Wiring ----------------------------------------------------------- */

  el('findBtn').addEventListener('click', findOnMap);

  el('postcode').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); findOnMap(); }
  });

  el('name').addEventListener('input', checkDuplicates);

  el('notes').addEventListener('input', function () {
    el('notesCount').textContent = el('notes').value.length;
  });

  form.addEventListener('submit', submit);

  el('againBtn').addEventListener('click', function () {
    form.reset();
    picked = null;
    openedAt = Date.now();
    el('locate').hidden = true;
    el('dupeWarn').hidden = true;
    el('coordsOut').textContent = '';
    el('notesCount').textContent = '0';
    clearErrors();
    el('done').hidden = true;
    form.hidden = false;
    el('name').focus();
  });

  // Clear a field's error as soon as the person starts fixing it
  form.addEventListener('input', function (e) {
    if (e.target.name && e.target.name !== 'company') setError(e.target.name, '');
  });
})();
