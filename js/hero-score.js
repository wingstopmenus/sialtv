/* SialTV hero live card — the live/latest/next card in the hero area
   of the homepage and the match-coverage card on the NPL hub.
   Live match first, then the latest result, then the next fixture.
   Baked content stays put until the feed answers, so the card is never
   empty and never shows a score the feed has not given it. */
(function () {
  'use strict';
  var POLL_MS = 30 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render(root, data, league) {
    var p = window.sialtvPick((data && data.matches) || []);
    var m = p.live || p.latest;
    var html = '';
    if (m) {
      var label = p.live ? 'Live now' : 'Latest result · Match ' + m.matchNo;
      html += '<p class="lead-kicker">' + (p.live ? '<span class="live-dot" aria-hidden="true"></span>' : '') + esc(label) + '</p>';
      html += '<h3 class="lead-head">' + esc(m.team1) + ' ' + esc(m.score1 || '') + (m.overs1 ? ' (' + esc(m.overs1) + ' ov)' : '') + ' vs ' + esc(m.team2) + ' ' + esc(m.score2 || '') + (m.overs2 ? ' (' + esc(m.overs2) + ' ov)' : '') + '</h3>';
      html += '<p class="lead-score">' + esc(m.statusText || '') + '</p>';
      if (p.live && m.live) {
        var bits = [];
        if (m.live.batters && m.live.batters.length) bits.push(m.live.batters.map(function (b) { return esc(b.name) + ' ' + esc(b.runs) + (b.striker ? '*' : ''); }).join(', '));
        if (m.live.crr) bits.push('CRR ' + esc(m.live.crr));
        if (bits.length) html += '<p class="lead-stand">' + bits.join(' &middot; ') + '</p>';
      }
    }
    if (p.next) {
      html += '<p class="lead-stand">Next: ' + esc(p.next.team1) + ' vs ' + esc(p.next.team2) + ' &middot; Match ' + p.next.matchNo + '</p>';
    }
    html += '<p class="lead-links"><a href="/' + league + '/live-scores/">' + league.toUpperCase() + ' live scores</a> &middot; <a href="/' + league + '/results/">' + league.toUpperCase() + ' results</a> &middot; <a href="/' + league + '/points-table/">' + league.toUpperCase() + ' points table</a></p>';
    if (data.fetchedAt && window.sialtvFmtUpdated) {
      html += '<p class="note">' + esc(window.sialtvFmtUpdated(data.fetchedAt)) + '</p>';
    }
    root.innerHTML = html;
  }

  function boot() {
    var root = document.getElementById('heroLiveCard');
    if (!root || !window.sialtvScores) return;
    var league = root.getAttribute('data-league') || 'npl';
    function load() {
      if (document.hidden) return;
      window.sialtvScores(league).then(function (data) {
        if (data && data.matches && data.matches.length) render(root, data, league);
      }).catch(function () {});
    }
    load();
    setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
