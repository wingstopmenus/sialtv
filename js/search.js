/* SialTV header search — client-side, vanilla JS.
   Lazy-loads /data/search-index.json (titles + URLs from the real pages)
   on first use, filters as you type, shows up to 8 results in a dropdown.
   Keyboard: Down/Up to move, Enter to open, Escape to close. */
(function () {
  'use strict';

  var TYPE_LABEL = { p: 'Player', t: 'Team', m: 'Match', l: 'League', n: 'News', g: 'Page' };
  var MAX_RESULTS = 8;
  var DEBOUNCE_MS = 120;

  var input = document.querySelector('[data-search-input]');
  var list = document.querySelector('[data-search-results]');
  if (!input || !list) return;

  var wrap = input.closest('[data-search]');
  var toggle = wrap ? wrap.querySelector('[data-search-toggle]') : null;
  var box = wrap ? wrap.querySelector('.st-search__box') : null;

  var indexPromise = null;
  var items = null;
  var active = -1;
  var timer = null;

  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetch('/data/search-index.json')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          items = data;
          return data;
        })
        .catch(function () { items = []; return []; });
    }
    return indexPromise;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function search(q) {
    q = q.trim().toLowerCase();
    if (!q || !items) return [];
    var starts = [], contains = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var hay = (it.t + ' ' + it.u).toLowerCase();
      var pos = hay.indexOf(q);
      if (pos < 0) continue;
      if (it.t.toLowerCase().indexOf(q) === 0) starts.push(it);
      else contains.push(it);
      if (starts.length + contains.length >= MAX_RESULTS) break;
    }
    return starts.concat(contains).slice(0, MAX_RESULTS);
  }

  function render(results, q) {
    list.innerHTML = '';
    active = -1;
    input.setAttribute('aria-expanded', results.length ? 'true' : 'false');
    input.removeAttribute('aria-activedescendant');
    if (!q) { list.hidden = true; return; }
    if (!results.length) {
      var li = document.createElement('li');
      li.className = 'st-search__empty';
      li.textContent = 'No results for "' + q + '"';
      list.appendChild(li);
      list.hidden = false;
      return;
    }
    results.forEach(function (it, i) {
      var li = document.createElement('li');
      li.className = 'st-search__item';
      li.id = 'st-search-opt-' + i;
      li.setAttribute('role', 'option');
      var a = document.createElement('a');
      a.href = it.u;
      a.innerHTML = '<span class="st-search__title">' + esc(it.t) + '</span>' +
        '<span class="st-search__type">' + esc(TYPE_LABEL[it.y] || 'Page') + '</span>';
      li.appendChild(a);
      list.appendChild(li);
    });
    list.hidden = false;
  }

  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      loadIndex().then(function () {
        render(search(input.value), input.value.trim());
      });
    }, DEBOUNCE_MS);
  }

  function setActive(i) {
    var opts = list.querySelectorAll('.st-search__item');
    if (!opts.length) return;
    if (i < 0) i = opts.length - 1;
    if (i >= opts.length) i = 0;
    active = i;
    opts.forEach(function (o, j) { o.classList.toggle('st-search__item--active', j === i); });
    input.setAttribute('aria-activedescendant', opts[i].id);
  }

  function close() {
    if (box) box.hidden = true;
    list.hidden = true;
    list.innerHTML = '';
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    if (wrap) wrap.classList.remove('st-search--open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  /* Mobile toggle: opens the full-width search panel under the header. */
  if (toggle && wrap) {
    toggle.addEventListener('click', function () {
      var open = wrap.classList.toggle('st-search--open');
      if (box) box.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.classList.remove('st-nav-open');
      if (open) { loadIndex(); input.focus(); }
      else close();
    });
  }

  input.addEventListener('focus', loadIndex);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { close(); input.blur(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter' && active >= 0) {
      var a = list.querySelectorAll('.st-search__item a')[active];
      if (a) { e.preventDefault(); window.location.href = a.getAttribute('href'); }
    }
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('[data-search]')) close();
  });
})();

/* Back-to-top floating button (2026-11-15) — site-wide, fragment route.
   The masthead fragment carries <button id="st-to-top">; this IIFE wires
   it. It runs after inject(), so the button already exists. Separate IIFE
   on purpose: the search IIFE above returns early when there is no search
   input, and this must not depend on it. No-op when the button is absent
   (fragment fetch failed -> skeleton header, no dead button).
   Shows past 400px, smooth-scrolls to top (instant when the user prefers
   reduced motion — the site's html { scroll-behavior: smooth } already
   flips to auto under prefers-reduced-motion, and we match it here). */
(function () {
  'use strict';

  var btn = document.getElementById('st-to-top');
  if (!btn) return;

  var SHOW_AFTER = 400;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ticking = false;

  function update() {
    ticking = false;
    var y = window.scrollY || window.pageYOffset || 0;
    btn.classList.toggle('is-visible', y > SHOW_AFTER);
  }

  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  btn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  });
  update();
})();

/* Header league links — data-driven (2026-11-16).
   The masthead fragment hardcodes the current leagues as the no-JS
   fallback; this IIFE reconciles both menus (.st-menu on desktop,
   .st-drawer nav on mobile) against /data/nav-leagues.json on every
   page load. A league shows up to and including its Final day and
   disappears from the menu the day after — automatically, with no
   fragment edit and no page rebuild. A league added to the JSON
   appears automatically, in JSON order. Runs after inject(), so the
   fragment is already in the DOM. Separate IIFE on purpose: the
   search IIFE above returns early when there is no search input, and
   this must not depend on it. Silent no-op when the JSON cannot be
   fetched (the hardcoded links stay as they are). */
(function () {
  'use strict';

  var DATA_URL = '/data/nav-leagues.json';

  function utcDateString(d) {
    var m = d.getUTCMonth() + 1;
    var day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function isActive(league, today) {
    // Visible through the Final day; gone the day after. A missing or
    // invalid final date never removes a league.
    if (!league || !league.final) return true;
    var f = String(league.final).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return true;
    return today <= f;
  }

  function closeDrawer() {
    var btn = document.querySelector('.st-burger');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Open menu');
    }
    document.body.classList.remove('st-nav-open');
  }

  function syncMenu(menu, active, isDrawer) {
    if (!menu) return;
    var i, code, link;
    var have = {};
    var existing = menu.querySelectorAll('a[data-league]');
    for (i = 0; i < existing.length; i++) {
      have[existing[i].getAttribute('data-league')] = existing[i];
    }
    // Remove concluded leagues.
    for (i = 0; i < existing.length; i++) {
      code = existing[i].getAttribute('data-league');
      if (!active[code]) existing[i].parentNode.removeChild(existing[i]);
    }
    // Add new leagues and restore JSON order. The menu holds only the
    // Series link + league links, so appending in JSON order puts them
    // after Series in the right sequence (appendChild moves existing
    // nodes instead of duplicating them).
    for (i = 0; i < active.list.length; i++) {
      code = active.list[i].code;
      link = (have[code] && have[code].parentNode) ? have[code] : null;
      if (!link) {
        link = document.createElement('a');
        link.setAttribute('href', active.list[i].href);
        link.setAttribute('data-league', code);
        link.textContent = code;
        if (isDrawer) link.addEventListener('click', closeDrawer);
      }
      menu.appendChild(link);
    }
  }

  function markCurrent(active) {
    var p = window.location.pathname;
    var best = null;
    for (var i = 0; i < active.list.length; i++) {
      var href = active.list[i].href;
      if (p === href || p.indexOf(href) === 0) {
        if (!best || href.length > best.length) best = href;
      }
    }
    if (!best) return;
    [document.querySelector('.st-menu'), document.querySelector('.st-drawer nav')].forEach(function (menu) {
      if (!menu) return;
      menu.querySelectorAll('a[data-league]').forEach(function (a) {
        if (a.getAttribute('href') === best) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      });
    });
  }

  var menus = [document.querySelector('.st-menu'), document.querySelector('.st-drawer nav')];
  if (!menus[0] && !menus[1]) return;

  fetch(DATA_URL, { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('nav leagues ' + r.status); return r.json(); })
    .then(function (data) {
      var today = utcDateString(new Date());
      var list = (data && data.leagues) || [];
      var active = { list: [] };
      for (var i = 0; i < list.length; i++) {
        var lg = list[i];
        if (lg && lg.code && lg.href && isActive(lg, today)) {
          active[lg.code] = true;
          active.list.push(lg);
        }
      }
      syncMenu(menus[0], active, false);
      syncMenu(menus[1], active, true);
      markCurrent(active);
    })
    .catch(function () { /* keep the hardcoded links */ });
})();
