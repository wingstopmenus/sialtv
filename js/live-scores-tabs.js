/* SialTV live-scores tabs + league chips (2026-11-13).
   Standalone, no dependencies: tabs switch the feed (Live Cricket Score /
   Cricket Schedule / Match Results), chips filter the visible panel by
   league. Hash #live / #schedule / #results deep-links a tab. */
(function () {
  'use strict';
  var EMPTY = {
    results: {
      ilt20: 'No ILT20 results yet — Season 5 starts on Saturday 21 November 2026.',
      apl: 'No APL results yet — the first ball is on Sunday 27 December 2026.'
    }
  };
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  var tabs = $all('[data-ls-tab]');
  var panels = $all('[data-ls-panel]');
  var chips = $all('[data-ls-chip]');
  if (!tabs.length || !panels.length) return;
  var currentTab = 'live';
  var currentChip = 'all';

  function applyChip() {
    var panel = $('.ls-panel[data-ls-panel="' + currentTab + '"]');
    if (!panel) return;
    var anyVisible = false;
    /* Series boxes carry data-league; date groups wrap boxes in Results. */
    $all('.rx-res-box[data-league]', panel).forEach(function (box) {
      var show = currentChip === 'all' || box.getAttribute('data-league') === currentChip;
      box.hidden = !show;
      if (show) anyVisible = true;
    });
    $all('.rx-date-group', panel).forEach(function (g) {
      g.hidden = $all('.rx-res-box:not([hidden])', g).length === 0;
    });
    /* The live panel is NPL-only. */
    var livePanel = $('#livePanel');
    if (livePanel && currentTab === 'live') {
      livePanel.hidden = !(currentChip === 'all' || currentChip === 'npl');
      if (!livePanel.hidden) anyVisible = true;
    }
    var empty = $('[data-ls-empty]', panel);
    if (empty) {
      var msg = (EMPTY[currentTab] && EMPTY[currentTab][currentChip]) || '';
      if (!anyVisible && msg) { empty.textContent = msg; empty.hidden = false; }
      else empty.hidden = true;
    }
  }

  function showTab(name) {
    currentTab = name;
    tabs.forEach(function (b) {
      var on = b.getAttribute('data-ls-tab') === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) b.removeAttribute('tabindex'); else b.setAttribute('tabindex', '-1');
    });
    panels.forEach(function (p) { p.hidden = p.getAttribute('data-ls-panel') !== name; });
    applyChip();
  }

  tabs.forEach(function (b) {
    b.addEventListener('click', function () {
      var name = b.getAttribute('data-ls-tab');
      showTab(name);
      try { history.replaceState(null, '', '#' + name); } catch (e) {}
    });
  });
  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      currentChip = c.getAttribute('data-ls-chip');
      chips.forEach(function (x) { x.setAttribute('aria-pressed', x === c ? 'true' : 'false'); });
      applyChip();
    });
  });
  /* Deep-link: #live / #schedule / #results */
  var hash = (location.hash || '').replace('#', '');
  if (hash === 'schedule' || hash === 'results' || hash === 'live') showTab(hash);
  else showTab('live');
})();
