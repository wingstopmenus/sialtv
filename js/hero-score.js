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

  /* Match pages exist for npl, ilt20, sa20 and bbl only; apl and psl
     fall back to the results list until their match pages exist. */
  var MATCH_SEASON = { npl: '2026', ilt20: '2026-27', sa20: '2026-27', bbl: '2026-27' };
  function matchUrl(league, matchNo) {
    var season = MATCH_SEASON[league];
    return season ? '/' + league + '/matches/' + season + '/match-' + matchNo + '/' : '/' + league + '/results/';
  }

  /* The feed carries team names with a league suffix ("Biratnagar
     Kings (NPL)") — the card shows the plain name. CRR is computed
     from the score when the feed leaves crr empty (it usually does). */
  function shortName(name) {
    return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  }
  function crrOf(m) {
    var live = m.live || null;
    if (live && live.crr) return live.crr;
    /* The batting side is the one with an open innings: the side with
       a score while the other has none (first innings — M24: team1
       fielded, team2 batting), else the side whose innings is still
       open. An innings ends at 10 wickets or when its overs run out,
       so with both scores present the batting side is the one with
       fewer overs — the 10-wicket-only check missed the chase after
       a completed 20-over innings (M24: SPR 125/6 in 20 ov, KAG
       chasing 22/2 in 3.2 ov — CRR is KAG's, not SPR's 6.25). */
    function wkts(s) { var x = /^(\d+)\/(\d+)/.exec(String(s || '')); return x ? parseInt(x[2], 10) : -1; }
    function balls(o) { var p = String(o || '').split('.'); return (parseInt(p[0] || '0', 10) * 6) + (parseInt(p[1] || '0', 10) || 0); }
    var s = '', o = '';
    if (m.score2 && !m.score1) { s = m.score2; o = m.overs2; }
    else if (m.score1 && !m.score2) { s = m.score1; o = m.overs1; }
    else if (m.score1 && m.score2) {
      if (wkts(m.score2) >= 10) { s = m.score1; o = m.overs1; }
      else if (wkts(m.score1) >= 10) { s = m.score2; o = m.overs2; }
      else if (balls(m.overs1) > balls(m.overs2)) { s = m.score2; o = m.overs2; }
      else { s = m.score1; o = m.overs1; }
    }
    if (!s || !o) return '';
    var runs = parseInt(String(s).split('/')[0], 10);
    var parts = String(o).split('.');
    var ov = parseInt(parts[0] || '0', 10) + (parseInt(parts[1] || '0', 10) / 6);
    if (!runs || !ov) return '';
    return (runs / ov).toFixed(2);
  }

  /* A side with no score yet (won the toss and fielded) reads
     "Yet to bat" — never a blank slot or a dangling "( ov)". Same
     pattern as sticky-bar.js sideLine(). */
  function sideScore(name, score, overs) {
    var s = shortName(name);
    if (!score) return s + ' Yet to bat';
    return s + ' ' + esc(score) + (overs ? ' (' + esc(overs) + ' ov)' : '');
  }

  /* The feed's statusText carries the league suffix on every team
     ("Biratnagar Kings (NPL) need 27 runs...") — the card shows the
     plain name. */
  function cleanStatus(s) {
    return String(s || '').replace(/\s*\([A-Z0-9]+\)/g, '');
  }

  function render(root, data, league) {
    var p = window.sialtvPick((data && data.matches) || []);
    var m = p.live || p.latest;
    var html = '';
    if (m) {
      var label = p.live ? 'Live now' : 'Latest result · Match ' + m.matchNo;
      html += '<p class="lead-kicker">' + (p.live ? '<span class="live-dot" aria-hidden="true"></span>' : '') + esc(label) + '</p>';
      html += '<h3 class="lead-head"><a href="' + matchUrl(league, m.matchNo) + '">' + sideScore(m.team1, m.score1, m.overs1) + ' vs ' + sideScore(m.team2, m.score2, m.overs2) + '</a></h3>';
      html += '<p class="lead-score">' + esc(cleanStatus(m.statusText)) + '</p>';
      if (p.live && m.live) {
        var bits = [];
        if (m.live.batters && m.live.batters.length) bits.push(m.live.batters.map(function (b) { return esc(b.name) + ' ' + esc(b.runs) + (b.striker ? '*' : ''); }).join(', '));
        var crr = crrOf(m);
        if (crr) bits.push('CRR ' + esc(crr));
        if (bits.length) html += '<p class="lead-stand">' + bits.join(' &middot; ') + '</p>';
      }
    }
    if (p.next) {
      html += '<p class="lead-stand">Next: <a href="' + matchUrl(league, p.next.matchNo) + '">' + esc(shortName(p.next.team1)) + ' vs ' + esc(shortName(p.next.team2)) + '</a> &middot; Match ' + p.next.matchNo + '</p>';
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
        if (!data || !data.matches || !data.matches.length) return;
        /* The feed only carries live + upcoming while no match is on,
           so a poll with no live match and no result must NOT wipe
           the baked latest-result card — it stays until the feed can
           actually improve it. */
        var p = window.sialtvPick(data.matches);
        if (!p.live && !p.latest) return;
        render(root, data, league);
      }).catch(function () {});
    }
    load();
    setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
