/* SialTV live card widget — the sidebar card on league hubs.
   Live score while a match is on, otherwise the latest result plus the
   next match, with the honest "Updated ..." line. Direction D red links.
   Polls the shared feed every 30 seconds, skips while the tab is hidden. */
(function () {
  'use strict';
  var POLL_MS = 30 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fmtShort(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)) + ' NST';
    } catch (e) { return iso; }
  }

  function render(root, data, league) {
    var p = window.sialtvPick((data && data.matches) || []);
    var m = p.live || p.latest;
    var html = '';
    if (m) {
      var label = p.live ? '<span class="slw-dot"></span>Live now' : 'Latest result &middot; Match ' + m.matchNo;
      html += '<p class="slw-label">' + label + '</p>';
      html += '<p class="slw-score">' + esc(m.team1) + ' ' + esc(m.score1 || '') + (m.overs1 ? ' <span>(' + esc(m.overs1) + ' ov)</span>' : '') + '<br>' + esc(m.team2) + ' ' + esc(m.score2 || '') + (m.overs2 ? ' <span>(' + esc(m.overs2) + ' ov)</span>' : '') + '</p>';
      html += '<p class="slw-line">' + esc(m.statusText || '') + '</p>';
      if (p.live && m.live && m.live.batters && m.live.batters.length) {
        var bats = m.live.batters.map(function (b) { return esc(b.name) + ' ' + esc(b.runs) + (b.striker ? '*' : ''); }).join(', ');
        html += '<p class="slw-line">' + bats + (m.live.crr ? ' &middot; CRR ' + esc(m.live.crr) : '') + '</p>';
      }
    }
    if (p.next) {
      html += '<p class="slw-line">Next: ' + esc(p.next.team1) + ' vs ' + esc(p.next.team2) + ' &middot; Match ' + p.next.matchNo + '</p>';
    }
    html += '<p class="slw-updated">' + (data.fetchedAt ? 'Updated ' + esc(fmtShort(data.fetchedAt)) : 'Last checked: 11 November 2026') + ' &middot; <a href="/' + league + '/live-scores/">' + league.toUpperCase() + ' Live Scores</a></p>';
    root.innerHTML = html || '<p class="slw-line">No match data right now.</p>';
  }

  function boot() {
    var roots = [];
    var w = document.getElementById('sialtvLiveWidget');
    if (w) roots.push(w);
    var list = document.querySelectorAll('[data-sialtv-live-card]');
    for (var i = 0; i < list.length; i++) roots.push(list[i]);
    if (!roots.length || !window.sialtvScores) return;
    roots.forEach(function (root) {
      var league = root.getAttribute('data-league') || 'npl';
      function load() {
        if (document.hidden) return;
        window.sialtvScores(league).then(function (data) {
          if (data && data.matches && data.matches.length) render(root, data, league);
        }).catch(function () {
          root.innerHTML = '<p class="slw-line">Live scores could not be loaded just now. <a href="/' + league + '/results/">' + league.toUpperCase() + ' Results</a></p>';
        });
      }
      load();
      setInterval(load, POLL_MS);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
