/* SialTV live-scores tabs + league chips (2026-11-13).
   Standalone, no dependencies: tabs switch the feed (Live Cricket Score /
   Cricket Schedule / Match Results), chips filter the visible panel by
   league. Hash #live / #schedule / #results deep-links a tab.

   DEDUPE (2026-11-16): the page is ONE series-grouped list (the Live
   tab). The Schedule + Results tabs are JS VIEWS derived from that
   list — same cards, different grouping/filter — not separate renders:
   Schedule = the upcoming cards, grouped by series; Results = the
   result cards, regrouped by date (date H2s, as before). The poller
   (js/live-scores.js) calls window.sialtvRebuildTabViews() after it
   changes the list, so the views track the live list with no reload. */
(function () {
  'use strict';
  var EMPTY = {
    live: {
      ilt20: 'No ILT20 match live right now — Season 5 starts on Saturday 21 November 2026, 6:30 PM GST. The first match is Desert Vipers against MI Emirates in Dubai.',
      apl: 'No APL match live right now — the first ball is on Sunday 27 December 2026, 5:30 PM AFT, in the UAE.'
    },
    schedule: {
      npl: 'No NPL fixture scheduled — the season ended on Saturday 21 November 2026.',
      ilt20: 'No ILT20 fixture scheduled — Season 5 starts on Saturday 21 November 2026, 6:30 PM GST.',
      apl: 'No APL fixture scheduled yet — the first ball is on Sunday 27 December 2026, 5:30 PM AFT, in the UAE.'
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

  /* "Sunday, 15 November 2026" / "Sun, 15 Nov" — the Results view's
     date-group H2 + pill, identical to the baked groups they replace
     (and to the poller's dateGroupHtml, now removed). */
  function fmtDateLong(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso + 'T00:00:00Z'));
    } catch (e) { return iso; }
  }
  function fmtHead(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso + 'T00:00:00Z');
      var wd = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', weekday: 'short' }).format(d);
      var dm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'short' }).format(d);
      return wd + ', ' + dm;
    } catch (e) { return iso; }
  }

  /* Is this card an upcoming match? The status div carries class
     "upcoming" (real fixtures and the APL coming-soon card alike);
     result/live cards carry no such class. */
  function isUpcoming(card) {
    var st = card.querySelector('.rx-res-status');
    return !!st && st.classList.contains('upcoming');
  }
  function isResult(card) {
    return !!card.getAttribute('data-date');
  }

  /* The one list: the Live tab's series boxes, in page order. */
  function listBoxes() {
    return $all('#tab-live .rx-res-box[data-league]');
  }

  /* Schedule view: the upcoming cards, grouped by series — a clone of
     each list box with the played cards removed. A box with no upcoming
     card is left out (the empty message covers it). */
  function buildScheduleView() {
    var view = $('#scheduleView');
    if (!view) return;
    view.innerHTML = '';
    listBoxes().forEach(function (box) {
      var clone = box.cloneNode(true);
      clone.hidden = false; /* the list box may be chip-hidden; the view is filtered by applyChip() */
      var cards = $all('.rx-res-card', clone);
      var kept = 0;
      cards.forEach(function (c) {
        if (!isUpcoming(c)) c.parentNode.removeChild(c);
        else kept++;
      });
      if (kept) view.appendChild(clone);
    });
  }

  /* Results view: the result cards, regrouped by date (newest first),
     one date group per (date, league) — the same shape the baked
     results groups had (date H2, pill, series box, 2-col grid). */
  function buildResultsView() {
    var view = $('#liveResults');
    if (!view) return;
    view.innerHTML = '';
    var groups = {};
    var order = [];
    listBoxes().forEach(function (box) {
      var league = box.getAttribute('data-league');
      $all('.rx-res-card', box).forEach(function (card) {
        if (!isResult(card)) return;
        var date = card.getAttribute('data-date') || '';
        var key = date + '|' + league;
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(card.cloneNode(true));
      });
    });
    order.sort(function (a, b) { return b.localeCompare(a); });
    order.forEach(function (key) {
      var parts = key.split('|');
      var date = parts[0], league = parts[1];
      var g = document.createElement('div');
      g.className = 'rx-date-group';
      g.id = 'date-' + date;
      g.setAttribute('data-date', date);
      var pill = document.createElement('div');
      pill.className = 'rx-date-pill';
      var span = document.createElement('span');
      span.textContent = fmtHead(date);
      pill.appendChild(span);
      var box = document.createElement('div');
      box.className = 'rx-res-box';
      box.setAttribute('data-league', league);
      var h2 = document.createElement('h2');
      h2.className = 'rx-res-boxhead';
      h2.textContent = fmtDateLong(date);
      var grid = document.createElement('div');
      grid.className = 'rx-res-grid';
      groups[key].forEach(function (c) { grid.appendChild(c); });
      box.appendChild(h2);
      box.appendChild(grid);
      g.appendChild(pill);
      g.appendChild(box);
      view.appendChild(g);
    });
  }

  /* Rebuild both views from the current list. Called at load and by the
     poller after it changes the list (window.sialtvRebuildTabViews).
     Re-applying the chip keeps a filtered view filtered; re-running the
     logo enhancement covers clones built from not-yet-enhanced cards. */
  function rebuildTabViews() {
    buildScheduleView();
    buildResultsView();
    enhanceLogos();
    applyChip();
  }
  window.sialtvRebuildTabViews = rebuildTabViews;

  /* The league chips hide whole series boxes (and whole date groups
     in Results) in the current tab. */
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
     poller rebuilds — and the view clones — are covered too. */
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
     The poller-built cards already carry logos themselves. Idempotent:
     a card whose chip is already an img is left alone, so rebuilding
     the views (or a second call) never rewrites a card. */
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
  /* Build the views from the baked list first, then enhance logos
     (the clones inherit whatever the list cards carry). If the logo
     map is not ready yet, the retry loop enhances list + views alike. */
  rebuildTabViews();
  if (!window.sialtvTeamLogos) {
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
