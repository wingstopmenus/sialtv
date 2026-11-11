/* SialTV flash strip — a row of match cards (live, latest result,
   next fixture) driven by the one shared feed. On the live-scores page
   it fills #sialtvFlash; on the homepage and the NPL hub it refreshes
   the baked carousel cards that carry a data-match-no. Baked cards are
   left alone when the feed has nothing newer for them. */
(function () {
  'use strict';
  var POLL_MS = 30 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function chip(name) {
    var bits = String(name || '').trim().split(/\s+/);
    var ini = bits.map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
    return '<span class="sc-chip">' + esc(ini) + '</span>';
  }

  /* Match pages exist for npl, ilt20, sa20 and bbl only; apl and psl
     fall back to the results list until their match pages exist. */
  var MATCH_SEASON = { npl: '2026', ilt20: '2026-27', sa20: '2026-27', bbl: '2026-27' };
  function matchUrl(league, matchNo) {
    var season = MATCH_SEASON[league];
    return season ? '/' + league + '/matches/' + season + '/match-' + matchNo + '/' : '/' + league + '/results/';
  }

  function cardHtml(m, league) {
    var kind = m.status === 'live' ? 'live' : (m.status === 'result' ? 'result' : 'upcoming');
    var label = m.status === 'live' ? 'Live' : (m.status === 'result' ? 'Result' : 'Upcoming');
    var html = '<a class="score-card" data-kind="' + kind + '" data-match-no="' + m.matchNo + '" href="' + matchUrl(league, m.matchNo) + '">';
    html += '<p class="sc-label' + (kind === 'upcoming' ? ' upcoming' : '') + '">' + label + '</p>';
    html += '<p class="sc-match">Match ' + m.matchNo + ' &middot; Kirtipur</p>';
    html += '<p class="sc-row"><span class="sc-team">' + chip(m.team1) + esc(m.team1) + '</span><span class="sc-score">' + esc(m.score1 || '') + (m.overs1 ? ' (' + esc(m.overs1) + ' ov)' : '') + '</span></p>';
    html += '<p class="sc-row"><span class="sc-team">' + chip(m.team2) + esc(m.team2) + '</span><span class="sc-score">' + esc(m.score2 || '') + (m.overs2 ? ' (' + esc(m.overs2) + ' ov)' : '') + '</span></p>';
    html += '<p class="sc-result' + (kind === 'upcoming' ? ' upcoming' : '') + '">' + esc(m.statusText || '') + '</p></a>';
    return html;
  }

  function refreshFlash(root, data, league) {
    /* Baked cards stay: update the ones the feed knows about in place
       (same updater as the carousel) and never drop the older baked
       cards the feed does not carry. Only build from scratch when the
       strip starts empty. */
    if (root.querySelectorAll('.score-card[data-match-no]').length) {
      refreshCarousel(root, data);
      return;
    }
    var p = window.sialtvPick((data && data.matches) || []);
    var cards = [];
    if (p.live) cards.push(p.live);
    if (p.latest && (!p.live || p.latest.matchNo !== p.live.matchNo)) cards.push(p.latest);
    if (p.next) cards.push(p.next);
    if (cards.length) root.innerHTML = cards.map(function (m) { return cardHtml(m, league); }).join('');
  }

  function refreshCarousel(carousel, data) {
    var byNo = {};
    (data.matches || []).forEach(function (m) { byNo[m.matchNo] = m; });
    var cards = carousel.querySelectorAll('.score-card[data-match-no]');
    cards.forEach(function (card) {
      var m = byNo[parseInt(card.getAttribute('data-match-no'), 10)];
      if (!m) return;
      var label = card.querySelector('.sc-label');
      var result = card.querySelector('.sc-result');
      var rows = card.querySelectorAll('.sc-row .sc-score');
      if (label) {
        label.textContent = m.status === 'live' ? 'Live' : (m.status === 'result' ? 'Result' : 'Upcoming');
        label.classList.toggle('upcoming', m.status === 'upcoming');
      }
      if (rows[0]) rows[0].textContent = (m.score1 || '') + (m.overs1 ? ' (' + m.overs1 + ' ov)' : '');
      if (rows[1]) rows[1].textContent = (m.score2 || '') + (m.overs2 ? ' (' + m.overs2 + ' ov)' : '');
      if (result) {
        result.textContent = m.statusText || '';
        result.classList.toggle('upcoming', m.status === 'upcoming');
      }
      card.setAttribute('data-kind', m.status === 'live' ? 'live' : (m.status === 'result' ? 'result' : 'upcoming'));
    });
  }

  function boot() {
    if (!window.sialtvScores) return;
    var flash = document.getElementById('sialtvFlash');
    var carousel = document.getElementById('scoreCarousel');
    if (!flash && !carousel) return;
    var league = (flash && flash.getAttribute('data-league')) || 'npl';
    function load() {
      if (document.hidden) return;
      window.sialtvScores(league).then(function (data) {
        if (!data || !data.matches || !data.matches.length) return;
        if (flash) refreshFlash(flash, data, league);
        if (carousel) refreshCarousel(carousel, data);
      }).catch(function () {});
    }
    load();
    setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
