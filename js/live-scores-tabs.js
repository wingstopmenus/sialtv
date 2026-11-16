/* SialTV live-scores tabs + league chips (2026-11-13).
   Standalone, no dependencies: tabs switch the feed (Live Cricket Score /
   Cricket Schedule / Match Results), chips filter the visible panel by
   league. Hash #live / #schedule / #results deep-links a tab. */
(function () {
  'use strict';
  var EMPTY = {
    live: {
      ilt20: 'No ILT20 match live right now — Season 5 starts on Saturday 21 November 2026, 6:30 PM GST. The first match is Desert Vipers against MI Emirates in Dubai.',
      apl: 'No APL match live right now — the first ball is on Sunday 27 December 2026, 5:30 PM AFT, in the UAE.'
    },
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

  /* The featured match centre moved below the series list (redesign
     2026-11-16) — it is NPL content, so the league chips hide it exactly
     like the NPL-only #livePanel. */
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
    var centre = $('#slpCentre');
    if (centre && currentTab === 'live') {
      centre.hidden = !(currentChip === 'all' || currentChip === 'npl');
      if (!centre.hidden) anyVisible = true;
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
  /* Reset (Cricinfo chip row): back to All. The button carries no
     data-ls-chip, so it is wired separately and never joins the chips list. */
  var reset = $('[data-ls-reset]');
  if (reset) {
    reset.addEventListener('click', function () {
      currentChip = 'all';
      chips.forEach(function (x) { x.setAttribute('aria-pressed', x.getAttribute('data-ls-chip') === 'all' ? 'true' : 'false'); });
      applyChip();
    });
  }
  /* Whole-card click (Cricinfo: the card itself is the link). The footer
     links stay for keyboard / no-JS users; a click on a link, button, or
     a text selection is left alone. Delegated on document so cards the
     poller rebuilds in the Results tab are covered too. */
  document.addEventListener('click', function (e) {
    var card = e.target && e.target.closest ? e.target.closest('.rx-res-card') : null;
    if (!card) return;
    if (e.target.closest('a, button')) return;
    try { if (window.getSelection && String(window.getSelection())) return; } catch (err) {}
    var link = card.querySelector('.rx-res-links a');
    if (link && link.getAttribute('href')) window.location.href = link.getAttribute('href');
  });
  /* Team logos on the baked list cards: the strip's logo map
     (window.sialtvTeamLogos, loaded by the strip loader) replaces the
     .ls-code chip in each team row. The chip stays when the map has no
     entry (TBC rows) or when JS is off — it is the fallback, not a bug.
     The poller-built cards already carry logos themselves. */
  function enhanceLogos() {
    var map = window.sialtvTeamLogos;
    if (!map) return false;
    $all('.rx-res-card .rx-res-team').forEach(function (row) {
      var chip = row.querySelector('.ls-code');
      var nameEl = row.querySelector('.rx-tname b');
      if (!chip || !nameEl) return;
      var img = map[nameEl.textContent.trim()];
      if (!img) return;
      var tmp = document.createElement('span');
      tmp.innerHTML = img;
      var im = tmp.firstChild;
      if (im) {
        im.setAttribute('alt', nameEl.textContent.trim() + ' logo');
        chip.replaceWith(im);
      }
    });
    return true;
  }
  if (!enhanceLogos()) {
    var tries = 0;
    var iv = setInterval(function () {
      if (enhanceLogos() || ++tries >= 20) clearInterval(iv);
    }, 500);
  }
  /* Deep-link: #live / #schedule / #results */
  var hash = (location.hash || '').replace('#', '');
  if (hash === 'schedule' || hash === 'results' || hash === 'live') showTab(hash);
  else showTab('live');
})();
