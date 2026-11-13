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
