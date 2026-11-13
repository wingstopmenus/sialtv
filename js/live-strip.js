/* SialTV live strip + score tables (renderer only — no fetch of its own).
   The strip is the thin bar under the header: while a match is live it
   shows the batters at the crease, the bowler, the run rate and the last
   overs; otherwise the latest result and the next match. The tables
   renderer draws the batsmen/bowler tables the live panel uses. No
   photos, no logos — initials only, in the site's no-images style. */
(function () {
  'use strict';
  var POLL_MS = 30 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function ensureCss() {
    if (document.getElementById('slp-strip-css')) return;
    var s = document.createElement('style');
    s.id = 'slp-strip-css';
    s.textContent = [
      '.slp-live b{color:#c92a1e}',
      '.slp-strip-score{font-weight:800;color:#0f1014}',
      '.slp-tables table{width:100%;border-collapse:collapse;font-size:15px}',
      '.slp-tables th{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#8a8f98;text-align:left;padding:10px;border-bottom:1px solid #e5e5e5}',
      '.slp-tables td{padding:10px;border-bottom:1px solid #f0f0f2;font-variant-numeric:tabular-nums}',
      '.slp-tables td.num,.slp-tables th.num{text-align:right;white-space:nowrap}',
      '.slp-ini{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#f4f4f5;color:#0f1014;font-size:11px;font-weight:800;margin-right:8px;vertical-align:middle}',
      '.slp-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:14px 0}',
      '.slp-stat{background:#fafafa;border:1px solid #e9e9ec;border-radius:12px;padding:10px;text-align:center}',
      '.slp-stat small{display:block;font-size:11px;font-weight:800;letter-spacing:.06em;color:#8a8f98;text-transform:uppercase}',
      '.slp-stat b{display:block;font-size:16px;margin-top:2px}',
      '.slp-overs{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px}',
      '.slp-over{flex:1 0 120px;background:#fafafa;border:1px solid #e9e9ec;border-radius:12px;padding:10px}',
      '.slp-over-no{display:block;font-size:11px;font-weight:800;letter-spacing:.06em;color:#8a8f98;text-transform:uppercase}',
      '.slp-balls{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}',
      '.slp-balls b{display:inline-flex;min-width:20px;height:20px;align-items:center;justify-content:center;border-radius:5px;background:#fff;border:1px solid #e0e0e0;font-size:12px}',
      '.slp-balls b.slp-w{background:#c92a1e;color:#fff;border-color:#c92a1e}',
      '.slp-balls b.slp-b{background:#0f1014;color:#fff;border-color:#0f1014}',
      '@media(max-width:640px){.slp-stats{grid-template-columns:repeat(2,1fr)}.slp-tables table{font-size:14px}}'
    ].join('');
    document.head.appendChild(s);
  }

  function initials(name) {
    var bits = String(name || '').trim().split(/\s+/);
    return ((bits[0] || ' ')[0] + (bits.length > 1 ? (bits[bits.length - 1] || ' ')[0] : '')).toUpperCase();
  }

  function face(name) {
    return '<span class="slp-ini" aria-hidden="true">' + esc(initials(name)) + '</span>';
  }

  function rateOf(score, overs) {
    var r = /^(\d+)\//.exec(score || '');
    var o = /^(\d+)(?:\.(\d))?/.exec(String(overs || ''));
    if (!r || !o) return '';
    var balls = parseInt(o[1], 10) * 6 + (parseInt(o[2] || '0', 10) || 0);
    if (!balls) return '';
    return (parseInt(r[1], 10) / (balls / 6)).toFixed(2);
  }

  function statsRow(live, m) {
    function chaseScore() {
      function w(s) { var x = /^(\d+)\/(\d+)/.exec(s || ''); return x ? parseInt(x[2], 10) : -1; }
      if (w(m.score2) >= 10) return [m.score1, m.overs1];
      if (w(m.score1) >= 10) return [m.score2, m.overs2];
      return [m.score1, m.overs1];
    }
    var side = chaseScore();
    var crr = (live && live.crr) || rateOf(side[0], side[1]);
    var lastOver = (live && live.lastOver) || '';
    if (!lastOver && live && live.recentOvers && live.recentOvers.length) {
      lastOver = (Number(live.recentOvers[0].runs) || 0) + '/' + (Number(live.recentOvers[0].wickets) || 0);
    }
    var proj = (live && live.projected) || (crr ? String(Math.round(parseFloat(crr) * 20)) : '');
    var cells = [['CRR', crr || '—'], ['Partnership', (live && live.partnership) || '—'], ['Last over', lastOver || '—'], ['Last 5 ov', (live && live.lastFive) || '—'], ['Projected', proj ? '~' + proj : '—']];
    return '<div class="slp-stats">' + cells.map(function (c) {
      return '<div class="slp-stat"><small>' + esc(c[0]) + '</small><b>' + esc(c[1]) + '</b></div>';
    }).join('') + '</div>';
  }

  function batRows(batters) {
    return batters.map(function (b) {
      return '<tr><td>' + face(b.name) + esc(b.name) + (b.striker ? ' *' : '') + '</td>' +
        '<td class="num">' + esc(b.runs) + '</td><td class="num">' + esc(b.balls) + '</td>' +
        '<td class="num">' + esc(b.fours == null ? '' : b.fours) + '</td><td class="num">' + esc(b.sixes == null ? '' : b.sixes) + '</td>' +
        '<td class="num">' + esc(b.sr == null ? '' : b.sr) + '</td></tr>';
    }).join('');
  }

  function bowlRows(bowlers) {
    return bowlers.map(function (b) {
      return '<tr><td>' + face(b.name) + esc(b.name) + (b.current ? ' *' : '') + '</td>' +
        '<td class="num">' + esc(b.overs == null ? '' : b.overs) + '</td><td class="num">' + esc(b.maidens == null ? '' : b.maidens) + '</td>' +
        '<td class="num">' + esc(b.runs) + '</td><td class="num">' + esc(b.wickets) + '</td>' +
        '<td class="num">' + esc(b.econ == null ? '' : b.econ) + '</td></tr>';
    }).join('');
  }

  function inningsTables(inn) {
    var html = '';
    (inn || []).forEach(function (g) {
      html += '<h3>' + esc(g.team) + ' — ' + esc(g.total || '') + (g.overs ? ' (' + esc(g.overs) + ' ov)' : '') + '</h3>';
      if (g.batting && g.batting.length) {
        html += '<div class="table-scroll slp-tables"><table><thead><tr><th>Batter</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th class="num">SR</th></tr></thead><tbody>';
        html += g.batting.map(function (b) {
          return '<tr><td>' + esc(b.name) + (b.dismissal ? ' <span style="color:#8a8f98">(' + esc(b.dismissal) + ')</span>' : '') + '</td>' +
            '<td class="num">' + esc(b.runs) + '</td><td class="num">' + esc(b.balls == null ? '' : b.balls) + '</td>' +
            '<td class="num">' + esc(b.fours == null ? '' : b.fours) + '</td><td class="num">' + esc(b.sixes == null ? '' : b.sixes) + '</td>' +
            '<td class="num">' + esc(b.sr == null ? '' : b.sr) + '</td></tr>';
        }).join('');
        html += '</tbody></table></div>';
      }
      if (g.bowling && g.bowling.length) {
        html += '<div class="table-scroll slp-tables"><table><thead><tr><th>Bowler</th><th class="num">O</th><th class="num">M</th><th class="num">R</th><th class="num">W</th><th class="num">Econ</th></tr></thead><tbody>';
        html += g.bowling.map(function (b) {
          return '<tr><td>' + esc(b.name) + '</td>' +
            '<td class="num">' + esc(b.overs == null ? '' : b.overs) + '</td><td class="num">' + esc(b.maidens == null ? '' : b.maidens) + '</td>' +
            '<td class="num">' + esc(b.runs) + '</td><td class="num">' + esc(b.wickets) + '</td>' +
            '<td class="num">' + esc(b.econ == null ? '' : b.econ) + '</td></tr>';
        }).join('');
        html += '</tbody></table></div>';
      }
    });
    return html;
  }

  /* Live tables for a match: crease tables + stats while live, full
     innings tables once the match is done. Returns '' when the feed
     carries nothing to draw — the baked tables then stay put. */
  function liveTables(m) {
    ensureCss();
    if (!m) return '';
    var live = m.live || null;
    if (m.status === 'live' && live && ((live.batters && live.batters.length) || (live.bowlers && live.bowlers.length))) {
      var html = '<div class="slp-tables"><table><thead><tr><th>Batter</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th class="num">SR</th></tr></thead><tbody>' +
        batRows(live.batters || []) + '</tbody></table>';
      html += '<table><thead><tr><th>Bowler</th><th class="num">O</th><th class="num">M</th><th class="num">R</th><th class="num">W</th><th class="num">Econ</th></tr></thead><tbody>' +
        bowlRows(live.bowlers || []) + '</tbody></table></div>';
      if (live.lastWicket && live.lastWicket.name) {
        var lw = live.lastWicket;
        html += '<p><strong>Last wicket:</strong> ' + esc(lw.name) + ' ' + esc(lw.runs) + ' (' + esc(lw.balls) + ')' +
          (lw.dismissal ? ' · ' + esc(lw.dismissal) : '') + (lw.fow ? ' · Fall of wicket: ' + esc(lw.fow) : '') + '</p>';
      }
      html += statsRow(live, m);
      return html;
    }
    if (m.scorecard && m.scorecard.innings && m.scorecard.innings.length) {
      var t = inningsTables(m.scorecard.innings);
      if (live) t += statsRow(live, m);
      return t;
    }
    return '';
  }
  window.sialtvLiveTables = liveTables;

  function oversHtml(m) {
    ensureCss();
    var live = m.live || null;
    var overs = (live && live.recentOvers) || m.overTimeline || [];
    if (!overs.length) return '';
    function cls(t) {
      if (t === 'W') return 'slp-w';
      if (t === '4' || t === '6') return 'slp-b';
      return '';
    }
    return '<div class="slp-overs">' + overs.map(function (o) {
      var balls = (o.tokens || []).map(function (t) {
        var c = cls(String(t));
        return '<b' + (c ? ' class="' + c + '"' : '') + '>' + esc(t) + '</b>';
      }).join('');
      return '<div class="slp-over"><span class="slp-over-no">' + esc(String(o.label || '').replace(/^Over /i, 'Over ')) + '</span><span class="slp-balls">' + balls + '</span><span>' + esc((Number(o.runs) || 0) + ' runs, ' + (Number(o.wickets) || 0) + ' wicket' + ((Number(o.wickets) || 0) === 1 ? '' : 's')) + '</span></div>';
    }).join('') + '</div>';
  }
  window.sialtvLiveOvers = oversHtml;

  /* ---- the strip itself ---- */
  /* The feed carries team names with a league suffix ("Karnali Yaks
     (NPL)") — the strip shows the plain name. */
  function shortName(name) {
    return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  /* A side with no score yet (won the toss and fielded) reads
     "Yet to bat" — never a blank "( ov)" slot. Same pattern as
     sticky-bar.js sideLine() / hero-score.js sideScore(). */
  function stripScore(abbr, name, score, overs) {
    var s = esc(abbr || name);
    if (!score) return s + ' Yet to bat';
    return s + ' ' + esc(score) + (overs ? ' (' + esc(overs) + ' ov)' : '');
  }

  function stripHtml(p, showNext) {
    var m = p.live || p.latest;
    var right = '';
    if (p.next && showNext) right = 'Next: ' + esc(shortName(p.next.team1)) + ' vs ' + esc(shortName(p.next.team2)) + ' · Match ' + p.next.matchNo;
    if (p.live) {
      var live = p.live.live || {};
      var bats = (live.batters || []).map(function (b) { return esc(b.name) + ' ' + esc(b.runs) + (b.striker ? '*' : ''); }).join(', ');
      var bowl = (live.bowlers || [])[0];
      var line = '<span class="slp-strip-score">' + stripScore(p.live.abbr1, p.live.team1, p.live.score1, p.live.overs1) + '</span>';
      if (p.live.score2) line += ' vs <span class="slp-strip-score">' + stripScore(p.live.abbr2, p.live.team2, p.live.score2, p.live.overs2) + '</span>';
      if (bats) line += ' · ' + bats;
      /* The feed often carries the bowler with no overs/runs/wickets
         yet — a "0/0" would look broken, so the bowler is shown only
         when it has real figures. (Runs/wickets arrive as strings, so
         '0' is truthy — compare numerically.) */
      if (bowl && (bowl.overs || Number(bowl.runs) || Number(bowl.wickets))) line += ' · ' + esc(bowl.name) + ' ' + esc(bowl.wickets || 0) + '/' + esc(bowl.runs || 0);
      /* CRR from the score when the feed leaves crr empty (it usually
         does). The batting side is the one whose innings is open:
         score1 while the second innings is on (score2 all out), else
         the side with the open innings — same rule as statsRow. */
      var crr = live.crr || (function () {
        function w(s) { var x = /^(\d+)\/(\d+)/.exec(s || ''); return x ? parseInt(x[2], 10) : -1; }
        function balls(o) { var q = String(o || '').split('.'); return (parseInt(q[0] || '0', 10) * 6) + (parseInt(q[1] || '0', 10) || 0); }
        var m = p.live;
        /* Batting side = open innings: a score while the other has
           none, else the side with fewer overs (the other innings is
           complete) — same rule as flash-scores.js crrOf(). The old
           default missed the chase after a completed 20-over innings
           (M24: SPR 125/6 in 20 ov, KAG chasing 12/2 in 1.3 ov). */
        if (m.score2 && !m.score1) return rateOf(m.score2, m.overs2);
        if (m.score1 && !m.score2) return rateOf(m.score1, m.overs1);
        if (w(m.score2) >= 10) return rateOf(m.score1, m.overs1);
        if (w(m.score1) >= 10) return rateOf(m.score2, m.overs2);
        if (balls(m.overs1) > balls(m.overs2)) return rateOf(m.score2, m.overs2);
        return rateOf(m.score1, m.overs1);
      })();
      if (crr) line += ' · CRR ' + esc(crr);
      return { left: '<span class="slp-live"><b><span class="live-dot" aria-hidden="true"></span>LIVE</b></span> · ' + line, right: right };
    }
    if (p.latest) {
      return { left: '<span><b>RESULT</b> · ' + esc(p.latest.statusText || '') + ' (' + esc(shortName(p.latest.team1)) + ' ' + esc(p.latest.score1 || '') + ' vs ' + esc(shortName(p.latest.team2)) + ' ' + esc(p.latest.score2 || '') + ')</span>', right: right };
    }
    if (p.next) {
      if (!showNext) return null;
      return { left: '<span><b>NEXT</b> · ' + esc(shortName(p.next.team1)) + ' vs ' + esc(shortName(p.next.team2)) + ' — Match ' + p.next.matchNo + '</span>', right: esc(p.next.statusText || '') };
    }
    return null;
  }

  function boot() {
    var strip = document.getElementById('sialtvLiveStrip');
    if (!strip || !window.sialtvScores || !window.sialtvPick) return;
    ensureCss();
    var league = strip.getAttribute('data-league') || 'npl';
    /* data-show-next="0" (NPL hub) hides the Next line entirely; default shows it. */
    var showNext = strip.getAttribute('data-show-next') !== '0';
    var wrap = strip.querySelector('.wrap');
    function load() {
      if (document.hidden) return;
      window.sialtvScores(league).then(function (data) {
        var p = window.sialtvPick((data && data.matches) || []);
        var h = stripHtml(p, showNext);
        if (!h || !wrap) return;
        var inner = '<span>' + h.left + '</span>';
        if (showNext || h.right) inner += '<span class="t-time">' + (h.right || '') + ' · <a href="/' + league + '/live-scores/">Live scores</a></span>';
        wrap.innerHTML = inner;
      }).catch(function () {});
    }
    load();
    setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

