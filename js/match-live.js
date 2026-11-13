/* SialTV match-page live updater — the match page itself goes live.
   Loads AFTER js/live-scores.js and reuses its shared fetcher
   (window.sialtvScores): the PHP endpoint first, the committed static
   snapshot second. No parallel fetcher, no second poll loop.

   What it does, and only while the match is actually on:
   - match-head status chip: "Match yet to begin" -> LIVE (red dot) -> Result
   - the match-head live score block (team scores, toss, current run rate)
   - the Scorecard tab: live batting/bowling tables from the feed, in the
     same markup as the baked scorecard (Batter/Dismissal/R/B/4s/6s/SR,
     Bowler/O/M/R/W/Econ), plus extras, total and fall of wickets
     (derived from the feed's ball-by-ball — never invented).
   - the Live tab: current batters/bowlers, last wicket, recent overs
     with ball chips, and a Match Centre (recent balls) with a link to
     the full Commentary tab.
   - the Commentary tab: the full ball-by-ball from the feed.
   - the Overs tab: over-by-over summary with ball chips.
   - the Live Stats tab: current run rate, partnership, last five balls,
     projected score and powerplay.

   The endpoint's live block is the primary source. Where it is thin,
   the scorecard and the ball-by-ball (both carried by the same feed)
   are the fallback — the figures are never invented, only derived
   from feed data that is already on the page.

   GOLDEN RULE: a baked result is never touched. If the page already
   shows a result (the H1 says "X beat Y by Z runs", or the match-head
   carries a Result chip), this module does nothing at all — no fetch,
   no poll. The match-day bake owns the finished page. A live
   scorecard that already shows fall of wickets is NOT a baked result
   (a live match has wickets too). Likewise the Summary tab is never
   touched: it is generated at bake time, and on a live page it holds
   the pre-match preview. When the feed says the match is over, the
   module shows the final state once and stops polling; the bake
   replaces the page.

   Polling: every 30 seconds while live or near kickoff; every 5 minutes
   while the match is still upcoming and kickoff is more than 15 minutes
   away (kickoffIso comes from the feed's static snapshot). Skips work
   while the tab is hidden. A failed fetch changes nothing — the page
   stays exactly as baked. */
(function () {
  'use strict';
  var POLL_MS = 30 * 1000;
  var SLOW_MS = 5 * 60 * 1000;
  var NEAR_MS = 15 * 60 * 1000;
  var FEED_API = '/api/live-scores.php?league=';
  var STATIC_FEED = { npl: '/data/live-scores.json', ilt20: '/data/ilt20-live-scores.json', sa20: '/data/sa20-live-scores.json', bbl: '/data/bbl-live-scores.json' };
  var SEASON = { npl: '2026', ilt20: '2026-27', sa20: '2026-27', bbl: '2026-27' };
  var timer = null;
  var scoreLineEl = null;
  var scorecardEl = null;
  var liveTabEl = null;
  var commentaryEl = null;
  var oversEl = null;
  var statsEl = null;
  var chipEl = null;

  function esc(s) {
    if (window.sialtvEsc) return window.sialtvEsc(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* /npl/matches/2026/match-22/ -> {league:'npl', matchNo:22} */
  function parseIdentity() {
    var m = /^\/([a-z]+)\/matches\/([^/]+)\/match-(\d+)\//.exec(location.pathname || '');
    if (!m) return null;
    var league = m[1];
    if (!SEASON[league]) return null;
    return { league: league, season: SEASON[league], matchNo: parseInt(m[3], 10) };
  }

  /* A baked result page: the H1 says who won ("X beat Y by Z runs"), or
     the match-head carries a Result chip. A live scorecard showing fall
     of wickets does NOT mean baked — a live match has wickets too. */
  function isBaked() {
    var h1 = document.querySelector('.match-head h1') ||
      document.querySelector('.hero h1');
    if (h1 && /beat|won by|tied|no result|abandoned/i.test(h1.textContent || '')) return true;
    var hero = document.querySelector('.match-head') || document.querySelector('.hero');
    if (hero) {
      var chips = hero.querySelectorAll('.hero-chip');
      for (var c = 0; c < chips.length; c++) {
        if (/^\s*result\s*$/i.test(chips[c].textContent || '')) return true;
      }
    }
    return false;
  }

  /* Page team names from the fixture heading ("Team1 vs Team2, ..."),
     so the live line never drifts from the page's own spelling. The
     "vs" must sit before the first comma — finals headings start with
     the stage name ("Qualifier 1, ... — 1st vs 2nd"), not teams. */
  function pageTeamNames() {
    var fx = document.getElementById('fixture');
    if (!fx) return null;
    var h2 = fx.querySelector('h2');
    if (!h2) return null;
    var m = /^([^,]+?)\s+vs\s+([^,]+?),/.exec((h2.textContent || '').trim());
    if (!m) return null;
    return [m[1].trim(), m[2].trim()];
  }

  function ensureCss() {
    if (document.getElementById('slp-match-live-css')) return;
    var s = document.createElement('style');
    s.id = 'slp-match-live-css';
    s.textContent = [
      '.slp-live-score{font-weight:800;font-size:19px;line-height:1.45;margin:14px 0 0;color:#0f1014}',
      '.slp-live-score small{display:block;font-weight:400;font-size:14px;color:#666;margin-top:4px}',
      '.slp-live-chip{background:#c92a1e!important;border-color:#c92a1e!important;color:#fff!important}',
      '.slp-ball{display:inline-block;min-width:22px;text-align:center;padding:2px 6px;margin:0 3px 3px 0;border:1px solid #e0e0e0;border-radius:999px;font-weight:700;font-size:13px}',
      '.slp-ball-w{background:#c92a1e;border-color:#c92a1e;color:#fff}',
      '.slp-ball-6{background:#0f5132;border-color:#0f5132;color:#fff}',
      '.slp-ball-4{background:#1d4ed8;border-color:#1d4ed8;color:#fff}'
    ].join('');
    document.head.appendChild(s);
  }

  function fmtUpdated(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      var hh = String(d.getUTCHours()).padStart(2, '0');
      var mm = String(d.getUTCMinutes()).padStart(2, '0');
      return 'Updated ' + hh + ':' + mm + ' UTC';
    } catch (e) { return ''; }
  }

  function ballsFromOvers(ov) {
    var m = /^(\d+)(?:\.(\d))?$/.exec(String(ov || '').trim());
    if (!m) return 0;
    return parseInt(m[1], 10) * 6 + parseInt(m[2] || '0', 10);
  }

  function sideScore(name, score, overs) {
    if (!score) return esc(name) + ' yet to bat';
    var s = esc(name) + ' ' + esc(score);
    if (overs) s += ' (' + esc(overs) + ' ov)';
    return s;
  }

  function scoreLineHtml(m, names, fetchedAt) {
    var t1 = (names && names[0]) || m.team1 || '';
    var t2 = (names && names[1]) || m.team2 || '';
    var line = '<strong>' + sideScore(t1, m.score1, m.overs1) + ' v ' +
      sideScore(t2, m.score2, m.overs2) + '</strong>';
    var sub = esc(m.statusText || (m.status === 'live' ? 'Live' : 'Result'));
    var upd = fmtUpdated(fetchedAt);
    line += '<small>' + sub + (upd ? ' &middot; ' + upd : '') + '</small>';
    return line;
  }

  function batRows(batters) {
    return (batters || []).map(function (b) {
      var notOut = String(b.dismissal || '').toLowerCase() === 'not out';
      var runs = esc(b.runs) + (notOut ? '*' : '');
      return '<tr><td>' + esc(b.name) + (b.crease ? ' *' : '') + '</td>' +
        '<td>' + esc(b.dismissal || '') + '</td>' +
        '<td>' + runs + '</td><td>' + esc(b.balls == null ? '' : b.balls) + '</td>' +
        '<td>' + esc(b.fours == null ? '' : b.fours) + '</td>' +
        '<td>' + esc(b.sixes == null ? '' : b.sixes) + '</td>' +
        '<td>' + esc(b.sr == null ? '' : b.sr) + '</td></tr>';
    }).join('');
  }

  function bowlRows(bowlers) {
    return (bowlers || []).map(function (b) {
      return '<tr><td>' + esc(b.name) + (b.current ? ' *' : '') + '</td>' +
        '<td>' + esc(b.overs == null ? '' : b.overs) + '</td>' +
        '<td>' + esc(b.maidens == null ? '' : b.maidens) + '</td>' +
        '<td>' + esc(b.runs) + '</td><td>' + esc(b.wickets) + '</td>' +
        '<td>' + esc(b.econ == null ? '' : b.econ) + '</td></tr>';
    }).join('');
  }

  /* The innings with a batter at the crease (the innings in progress). */
  function battingInnings(m) {
    var inns = (m.scorecard && m.scorecard.innings) || [];
    var g = null, i, j;
    for (i = 0; i < inns.length; i++) {
      var bat = inns[i].batting || [];
      for (j = 0; j < bat.length; j++) {
        if (bat[j].crease) { g = inns[i]; break; }
      }
      if (g) break;
    }
    if (!g && inns.length) g = inns[inns.length - 1];
    return g;
  }

  /* The innings with bowling figures (the fielding side's innings). */
  function bowlingInnings(m) {
    var inns = (m.scorecard && m.scorecard.innings) || [];
    for (var i = 0; i < inns.length; i++) {
      if ((inns[i].bowling || []).length) return inns[i];
    }
    return null;
  }

  /* CRR = current innings runs * 6 / balls bowled. The header scores
     are authoritative — the scorecard lags or duplicates innings during
     a chase, so picking the batting innings from it returned SPR's
     completed 125/6 (20 ov) — CRR 6.25 — while KAG were chasing
     (M24fix2 flag, 2026-11-13). Same batting-side rule as crrOf in
     flash-scores.js: a score while the other has none, else the side
     with fewer overs (an innings ends at 10 wickets or when its overs
     run out). Falls back to the batting innings' total when the header
     scores are missing. */
  function crrFromInnings(m) {
    var live = m.live || null;
    if (live && live.crr) return live.crr;
    function wkts(s) { var x = /^(\d+)\/(\d+)/.exec(String(s || '')); return x ? parseInt(x[2], 10) : -1; }
    function balls(o) { var q = String(o || '').split('.'); return (parseInt(q[0] || '0', 10) * 6) + (parseInt(q[1] || '0', 10) || 0); }
    var s = '', o = '';
    if (m.score2 && !m.score1) { s = m.score2; o = m.overs2; }
    else if (m.score1 && !m.score2) { s = m.score1; o = m.overs1; }
    else if (m.score1 && m.score2) {
      if (wkts(m.score2) >= 10) { s = m.score1; o = m.overs1; }
      else if (wkts(m.score1) >= 10) { s = m.score2; o = m.overs2; }
      else if (balls(m.overs1) > balls(m.overs2)) { s = m.score2; o = m.overs2; }
      else { s = m.score1; o = m.overs1; }
    }
    if (s && o) {
      var runs = parseInt(String(s).split('/')[0], 10);
      var b = balls(o);
      if (runs && b) return (runs * 6 / b).toFixed(2);
    }
    var g = battingInnings(m);
    if (!g) return '';
    var tm = /^(\d+)\//.exec(String(g.total || ''));
    var r2 = tm ? parseInt(tm[1], 10) : 0;
    var b2 = ballsFromOvers(g.overs);
    if (!r2 || !b2) return '';
    return (r2 * 6 / b2).toFixed(2);
  }

  function partnershipFromLive(live) {
    var bats = (live && live.batters) || [];
    if (bats.length < 2) return null;
    var runs = 0, balls = 0;
    bats.slice(0, 2).forEach(function (b) {
      runs += parseInt(b.runs || '0', 10);
      balls += parseInt(b.balls || '0', 10);
    });
    return { runs: runs, balls: balls };
  }

  /* Bowlers for the Live tab. The endpoint's live bowlers carry the
     figures; if they are empty (an older feed), the scorecard's bowling
     table — the same feed, correctly parsed — is the fallback. The
     bowler with the most balls bowled is the one bowling now. */
  function bowlersForLive(m) {
    var live = m.live || {};
    var bowls = live.bowlers || [];
    var usable = bowls.filter(function (b) {
      return (b.overs !== '' && b.overs != null) || parseInt(b.wickets || '0', 10) > 0 || parseInt(b.runs || '0', 10) > 0;
    });
    if (usable.length) return usable;
    var g = bowlingInnings(m);
    if (!g || !(g.bowling || []).length) return bowls;
    var rows = (g.bowling || []).slice();
    var best = null, bestBalls = -1;
    rows.forEach(function (b) {
      var n = ballsFromOvers(b.overs);
      if (n > bestBalls) { bestBalls = n; best = b; }
    });
    return rows.map(function (b) {
      return { name: b.name, overs: b.overs, maidens: b.maidens, runs: b.runs, wickets: b.wickets, econ: b.econ, current: b === best };
    });
  }

  /* Fall of wickets, derived from the ball-by-ball: walk the balls in
     order, accumulate the runs, and note the score each time a wicket
     falls. Never invented — every entry comes from a feed ball. */
  function fowFromCommentary(m) {
    var balls = (m.commentary || []).slice().reverse();
    var out = [];
    var runs = 0, wkts = 0;
    var g = battingInnings(m);
    var batByName = {};
    (g && g.batting || []).forEach(function (b) { batByName[String(b.name).toLowerCase()] = b; });
    balls.forEach(function (b) {
      runs += parseInt(b.runs || '0', 10);
      var dism = String(b.dismissal || '').trim();
      if (dism) {
        wkts++;
        var row = batByName[String(b.batsman || '').toLowerCase()] || null;
        out.push({
          name: b.batsman || '',
          runs: row ? row.runs : '',
          balls: row ? row.balls : '',
          dismissal: dism,
          score: runs + '/' + wkts,
          over: b.over || ''
        });
      }
    });
    return out;
  }

  /* The last wicket. Prefers the endpoint's live.lastWicket; falls back
     to the most recent dismissal in the ball-by-ball, then to the last
     dismissed batter in the scorecard. */
  function lastWicketForLive(m) {
    var live = m.live || {};
    if (live.lastWicket && live.lastWicket.name) return live.lastWicket;
    var fow = fowFromCommentary(m);
    if (fow.length) {
      var last = fow[fow.length - 1];
      return { name: last.name, runs: last.runs, balls: last.balls, dismissal: last.dismissal, fow: last.score, over: last.over };
    }
    var g = battingInnings(m);
    var dismissed = ((g && g.batting) || []).filter(function (b) {
      return String(b.dismissal || '').toLowerCase() !== 'not out';
    });
    if (!dismissed.length) return null;
    var d = dismissed[dismissed.length - 1];
    return { name: d.name, runs: d.runs, balls: d.balls, dismissal: d.dismissal, fow: '', over: '' };
  }

  /* Extras, derived from the feed: the team total minus the batting sum
     is the extras total; the wide / no-ball / bye split comes from the
     ball-by-ball short text. */
  function extrasFromFeed(m) {
    var g = battingInnings(m);
    if (!g) return null;
    var team = String(g.team || '');
    var hdr = null;
    if (team && m.team1 && team.indexOf(m.team1) !== -1 && m.score1) hdr = m.score1;
    else if (team && m.team2 && team.indexOf(m.team2) !== -1 && m.score2) hdr = m.score2;
    var tm = /^(\d+)\//.exec(String(hdr || g.total || ''));
    if (!tm) return null;
    var total = parseInt(tm[1], 10);
    var batRuns = 0;
    (g.batting || []).forEach(function (b) { batRuns += parseInt(b.runs || '0', 10); });
    var extras = total - batRuns;
    if (extras <= 0) return { total: 0, parts: [] };
    var w = 0, nb = 0, b = 0, lb = 0;
    (m.commentary || []).forEach(function (cb) {
      var s = String(cb.short || '').toLowerCase();
      if (s.indexOf('wide') !== -1) w += parseInt(cb.runs || '0', 10) || 1;
      else if (s.indexOf('no ball') !== -1) nb += parseInt(cb.runs || '0', 10) || 1;
      else if (s.indexOf('leg bye') !== -1) lb += parseInt(cb.runs || '0', 10) || 0;
      else if (s.indexOf('bye') !== -1) b += parseInt(cb.runs || '0', 10) || 0;
    });
    var parts = [];
    if (b) parts.push('b ' + b);
    if (lb) parts.push('lb ' + lb);
    if (w) parts.push('w ' + w);
    if (nb) parts.push('nb ' + nb);
    return { total: extras, parts: parts };
  }

  /* One ball chip: W (red), 6 (green), 4 (blue), wide "1w", no-ball
     "1nb", a run, or a dot. */
  function ballChip(t) {
    var s = String(t);
    if (s === 'W') return '<span class="slp-ball slp-ball-w">W</span>';
    if (s === '6') return '<span class="slp-ball slp-ball-6">6</span>';
    if (s === '4') return '<span class="slp-ball slp-ball-4">4</span>';
    if (s === '0') return '<span class="slp-ball">&bull;</span>';
    return '<span class="slp-ball">' + esc(s) + '</span>';
  }

  function oversChipsHtml(overs) {
    if (!overs || !overs.length) return '';
    var html = '<h3>Recent overs</h3>';
    overs.forEach(function (o) {
      var toks = (o.tokens || []).map(ballChip).join('');
      html += '<p><b>' + esc(o.label || '') + ':</b> ' + toks + ' <span>&middot; ' + esc(String(o.runs)) + '/' + esc(String(o.wickets)) + (o.bowler ? ' &middot; ' + esc(o.bowler) : '') + '</span></p>';
    });
    return html;
  }

  /* Match Centre: the most recent balls, most recent first, with the
     ball label, the feed's short text and the dismissal line on a
     wicket. Limited to the last 12 balls so the Live tab stays short. */
  function matchCentreHtml(m, limit) {
    var balls = m.commentary || [];
    if (!balls.length) return '';
    var rows = balls.slice(0, limit || 12).map(function (b) {
      var chip = '';
      var dism = String(b.dismissal || '').trim();
      if (dism) chip = ballChip('W');
      else if (String(b.short || '').toLowerCase().indexOf('wide') !== -1) chip = ballChip((parseInt(b.runs || '0', 10) || 1) + 'w');
      else if (String(b.short || '').toLowerCase().indexOf('no ball') !== -1) chip = ballChip((parseInt(b.runs || '0', 10) || 1) + 'nb');
      else chip = ballChip(String(b.runs == null ? '0' : b.runs));
      var line = '<b>' + esc(b.over || '') + '</b> ' + chip + ' ' + esc(b.short || b.text || '');
      if (dism) line += '<br><span>' + esc(dism) + '</span>';
      return '<p>' + line + '</p>';
    }).join('');
    return '<h3>Match Centre</h3>' + rows +
      '<p><a href="#commentary" data-slp-goto="commentary">Read Full Commentary &rsaquo;</a></p>';
  }

  /* Merge new balls into the baked Commentary tab: prepend only the balls
     that are not already on the page (keyed by over + short text). The
     feed's commentary is a rolling window, so replacing the whole list
     would drop early balls. New balls go in most-recent-first order. */
  function mergeCommentary(m, container) {
    var balls = m.commentary || [];
    if (!balls.length) return;
    var seen = {};
    var ps = container.querySelectorAll('[data-ball]');
    for (var i = 0; i < ps.length; i++) seen[ps[i].getAttribute('data-ball')] = true;
    var h3 = container.querySelector('h3');
    if (!h3) return;
    var fresh = [];
    for (var j = balls.length - 1; j >= 0; j--) {
      var b = balls[j];
      var key = (b.over || '') + '|' + (b.short || '');
      if (!seen[key]) fresh.push(b);
    }
    fresh.forEach(function (b) {
      var dism = String(b.dismissal || '').trim();
      var chip = '';
      if (dism) chip = ballChip('W');
      else if (String(b.short || '').toLowerCase().indexOf('wide') !== -1) chip = ballChip((parseInt(b.runs || '0', 10) || 1) + 'w');
      else if (String(b.short || '').toLowerCase().indexOf('no ball') !== -1) chip = ballChip((parseInt(b.runs || '0', 10) || 1) + 'nb');
      else chip = ballChip(String(b.runs == null ? '0' : b.runs));
      var p = document.createElement('p');
      p.setAttribute('data-ball', (b.over || '') + '|' + (b.short || ''));
      var line = '<b>' + esc(b.over || '') + '</b> ' + chip + ' ' + esc(b.text || b.short || '');
      if (dism) line += '<br><span>' + esc(dism) + '</span>';
      p.innerHTML = line;
      h3.parentNode.insertBefore(p, h3.nextSibling);
    });
  }

  /* Live tab body, in the baked scorecard's own markup (.t-nums,
     .table-scroll, h3). What the feed does NOT carry is omitted, not
     faked: no career columns (Mat/Runs/HS/Ave, Mat/Wkts/BBI/Ave), no
     "This bowler" / "Last 10 ov" / "This spell" / 0s-4s-6s columns,
     no wagon wheel or pitch maps (no data). */
  function liveTabHtml(m, fetchedAt) {
    var live = m.live || {};
    var bats = live.batters || [];
    var bowls = bowlersForLive(m);
    var overs = live.recentOvers || m.overTimeline || [];
    if (m.status === 'upcoming' || (!bats.length && !bowls.length && !overs.length)) {
      return '<p class="slp-live-note">Match yet to begin. Live updates appear here once the match starts.</p>';
    }
    var html = '';
    var crr = bats.length ? crrFromInnings(m) : '';
    var scoreBits = [];
    if (m.score1) scoreBits.push(esc(m.team1 || '') + ' ' + esc(m.score1) + (m.overs1 ? ' (' + esc(m.overs1) + ' ov)' : ''));
    if (m.score2) scoreBits.push(esc(m.team2 || '') + ' ' + esc(m.score2) + (m.overs2 ? ' (' + esc(m.overs2) + ' ov)' : ''));
    if (scoreBits.length) html += '<p><strong>' + scoreBits.join(' &middot; ') + '</strong></p>';
    var meta = [];
    if (crr) meta.push('Current RR: ' + esc(crr));
    if (live.lastOver) meta.push('Last over: ' + esc(live.lastOver));
    if (m.toss) meta.push(esc(m.toss));
    if (meta.length) html += '<p>' + meta.join(' &middot; ') + '</p>';
    if (bats.length) {
      html += '<h3>Batters</h3><div class="table-scroll"><table class="t-nums"><thead><tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody>';
      html += bats.map(function (b) {
        return '<tr><td>' + esc(b.name) + (b.striker ? ' *' : '') + '</td><td>' + esc(b.runs) + '</td><td>' + esc(b.balls) + '</td><td>' + esc(b.fours == null ? '' : b.fours) + '</td><td>' + esc(b.sixes == null ? '' : b.sixes) + '</td><td>' + esc(b.sr == null ? '' : b.sr) + '</td></tr>';
      }).join('');
      html += '</tbody></table></div>';
      var pship = partnershipFromLive(live);
      if (pship) {
        html += '<p><b>Partnership:</b> ' + pship.runs + ' runs (' + pship.balls + ' balls) — ' + esc(bats[0].name) + ' ' + esc(bats[0].runs) + ' (' + esc(bats[0].balls) + ') &amp; ' + esc(bats[1].name) + ' ' + esc(bats[1].runs) + ' (' + esc(bats[1].balls) + ')</p>';
      }
    }
    if (bowls.length) {
      html += '<h3>Bowlers</h3><div class="table-scroll"><table class="t-nums"><thead><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr></thead><tbody>';
      html += bowls.map(function (b) {
        return '<tr><td>' + esc(b.name) + (b.current ? ' *' : '') + '</td><td>' + esc(b.overs == null ? '' : b.overs) + '</td><td>' + esc(b.maidens == null ? '' : b.maidens) + '</td><td>' + esc(b.runs) + '</td><td>' + esc(b.wickets) + '</td><td>' + esc(b.econ == null ? '' : b.econ) + '</td></tr>';
      }).join('');
      html += '</tbody></table></div><p class="note">* At the crease / bowling now.</p>';
    }
    var lw = lastWicketForLive(m);
    if (lw) {
      html += '<p><b>Last wicket:</b> ' + esc(lw.name) + ' ' + esc(lw.runs) + ' (' + esc(lw.balls) + ') — ' + esc(lw.dismissal || '') + (lw.fow ? ', ' + esc(lw.fow) : '') + (lw.over ? ' (' + esc(lw.over) + ' ov)' : '') + '</p>';
    }
    html += oversChipsHtml(overs);
    html += matchCentreHtml(m, 12);
    var upd = fmtUpdated(fetchedAt);
    html += '<p class="note">Live score' + (upd ? ' — ' + upd : '') + '. The full scorecard is on the Scorecard tab.</p>';
    return html;
  }

  /* Scorecard tab: live batting/bowling tables in the baked scorecard's
     own markup, plus extras, total and fall of wickets — all derived
     from the feed, never invented. */
  function tablesHtml(m, fetchedAt) {
    var inns = (m.scorecard && m.scorecard.innings) || [];
    if (!inns.length) return '<p>Match in progress — the scorecard will appear here shortly.</p>';
    var html = '';
    var fow = fowFromCommentary(m);
    inns.forEach(function (g) {
      var hasBat = (g.batting || []).length > 0;
      var hasBowl = (g.bowling || []).length > 0;
      if (!hasBat && !hasBowl) return;
      var team = String(g.team || '');
      var hdr = null;
      if (team && m.team1 && team.indexOf(m.team1) !== -1 && m.score1) hdr = [m.score1, m.overs1];
      else if (team && m.team2 && team.indexOf(m.team2) !== -1 && m.score2) hdr = [m.score2, m.overs2];
      var total = hdr ? hdr[0] : (g.total || '');
      var overs = hdr ? hdr[1] : (g.overs || '');
      html += '<h3>' + esc(team) + ' — ' + esc(total) + (overs ? ' (' + esc(overs) + ' ov)' : '') + '</h3>';
      if (hasBat) {
        html += '<div class="table-scroll"><table class="t-nums"><thead><tr><th>Batter</th><th>Dismissal</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody>';
        html += batRows(g.batting);
        html += '</tbody></table></div>';
        var ex = extrasFromFeed(m);
        if (ex && ex.total > 0) {
          html += '<p><b>Extras:</b> ' + ex.total + (ex.parts.length ? ' (' + ex.parts.join(', ') + ')' : '') + '</p>';
        }
        html += '<p><b>Total:</b> ' + esc(total) + (overs ? ' (' + esc(overs) + ' overs)' : '') + '</p>';
        if (fow.length) {
          html += '<p><b>Fall of wickets:</b> ' + fow.map(function (w) {
            return esc(w.score) + ' (' + esc(w.name) + ', ' + esc(w.over) + ' ov)';
          }).join(', ') + '</p>';
        }
      }
      if (hasBowl) {
        html += '<div class="table-scroll"><table class="t-nums"><thead><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr></thead><tbody>';
        html += bowlRows(g.bowling);
        html += '</tbody></table></div>';
      }
      if (g.yet && g.yet.length) {
        html += '<p>Yet to bat: ' + g.yet.map(esc).join(', ') + '.</p>';
      }
    });
    var upd = fmtUpdated(fetchedAt);
    html += '<p class="note">Live score' + (upd ? ' — ' + upd : '') + '. The full scorecard appears here after the match.</p>';
    return html;
  }

  /* Commentary tab: the full ball-by-ball, most recent first. */
  function commentaryHtml(m, fetchedAt) {
    var balls = m.commentary || [];
    if (!balls.length) return '<p class="slp-live-note">No ball-by-ball commentary yet. It appears here once the match starts.</p>';
    var html = '<h3>Ball by ball</h3>';
    html += balls.map(function (b) {
      var dism = String(b.dismissal || '').trim();
      var chip = '';
      if (dism) chip = ballChip('W');
      else if (String(b.short || '').toLowerCase().indexOf('wide') !== -1) chip = ballChip((parseInt(b.runs || '0', 10) || 1) + 'w');
      else if (String(b.short || '').toLowerCase().indexOf('no ball') !== -1) chip = ballChip((parseInt(b.runs || '0', 10) || 1) + 'nb');
      else chip = ballChip(String(b.runs == null ? '0' : b.runs));
      var line = '<p><b>' + esc(b.over || '') + '</b> ' + chip + ' ' + esc(b.text || b.short || '');
      if (dism) line += '<br><span>' + esc(dism) + '</span>';
      return line + '</p>';
    }).join('');
    var upd = fmtUpdated(fetchedAt);
    html += '<p class="note">Live commentary' + (upd ? ' — ' + upd : '') + '.</p>';
    return html;
  }

  /* Overs tab: over-by-over summary with ball chips. */
  function oversHtml(m, fetchedAt) {
    var overs = (m.live && m.live.recentOvers) || m.overTimeline || [];
    if (!overs.length) return '<p class="slp-live-note">No overs yet. The over-by-over summary appears here once the match starts.</p>';
    var html = '<h3>Over by over</h3>';
    html += overs.map(function (o) {
      var toks = (o.tokens || []).map(ballChip).join('');
      return '<p><b>' + esc(o.label || '') + ':</b> ' + toks + ' <span>&middot; ' + esc(String(o.runs)) + '/' + esc(String(o.wickets)) + (o.bowler ? ' &middot; ' + esc(o.bowler) : '') + '</span></p>';
    }).join('');
    var upd = fmtUpdated(fetchedAt);
    html += '<p class="note">Live overs' + (upd ? ' — ' + upd : '') + '.</p>';
    return html;
  }

  /* Live Stats tab: run rate, partnership, last five balls, projected
     score and powerplay — all arithmetic on feed data, never invented. */
  function statsHtml(m, fetchedAt) {
    var live = m.live || {};
    var bats = live.batters || [];
    if (m.status === 'upcoming' || !bats.length) {
      return '<p class="slp-live-note">Live stats appear here once the match starts.</p>';
    }
    var crr = crrFromInnings(m);
    var g = battingInnings(m);
    var balls = g ? ballsFromOvers(g.overs) : 0;
    var html = '<h3>Live stats</h3>';
    var rows = [];
    if (crr) rows.push(['Current run rate', crr]);
    var pship = partnershipFromLive(live);
    if (pship) rows.push(['Partnership', pship.runs + ' runs (' + pship.balls + ' balls)']);
    var allBalls = (m.commentary || []).slice().reverse();
    if (allBalls.length) {
      var last5 = allBalls.slice(-5).map(function (b) {
        var dism = String(b.dismissal || '').trim();
        if (dism) return 'W';
        if (String(b.short || '').toLowerCase().indexOf('wide') !== -1) return (parseInt(b.runs || '0', 10) || 1) + 'w';
        if (String(b.short || '').toLowerCase().indexOf('no ball') !== -1) return (parseInt(b.runs || '0', 10) || 1) + 'nb';
        return String(b.runs == null ? '0' : b.runs);
      });
      rows.push(['Last 5 balls', last5.map(function (t) { return t === '0' ? '•' : t; }).join(' ')]);
    }
    if (crr && balls > 0 && balls < 120) {
      var rem = 120 - balls;
      var proj = Math.round(parseFloat(crr) * 20);
      rows.push(['Projected score', proj + ' (at the current run rate, 20 overs)']);
    }
    if (balls > 0 && balls <= 36 && allBalls.length) {
      var ppRuns = 0;
      allBalls.slice(0, 36).forEach(function (b) { ppRuns += parseInt(b.runs || '0', 10); });
      rows.push(['Powerplay', 'Mandatory, overs 0.1–6 — ' + ppRuns + ' runs so far']);
    }
    if (!rows.length) return '<p class="slp-live-note">Live stats appear here once the match starts.</p>';
    html += '<div class="table-scroll"><table><tbody>' + rows.map(function (r) {
      return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
    var upd = fmtUpdated(fetchedAt);
    html += '<p class="note">Live stats' + (upd ? ' — ' + upd : '') + '.</p>';
    return html;
  }

  /* Worm chart (M24 fix2, 2026-11-13): the sidebar worm is baked HTML.
     On every poll, re-render it from the feed so it follows the match:
     innings 1 uses the baked series (data-worm-series) sliced to the
     completed overs; the chase (score1 set) derives its series from the
     endpoint's overTimeline + the current total. Only overs the feed
     actually reports are plotted — nothing is invented. Same SVG
     geometry as the bake (560x180, 25px/over, 130/maxRuns). */
  var wormLastKey = '';
  function wormSvg(points, team, score, overs, maxRuns) {
    var scale = 130 / maxRuns;
    var X = function (o) { return 40 + o * 25; };
    var Y = function (r) { return 150 - r * scale; };
    var f = function (n) { return (Math.round(n * 100) / 100).toString(); };
    var h = '<svg viewBox="0 0 560 180" width="100%" role="img" aria-label="Worm chart: ' + esc(team) + ' runs by over">';
    var o, r;
    for (o = 0; o <= 20; o += 5) {
      h += '<line x1="' + f(X(o)) + '" y1="20" x2="' + f(X(o)) + '" y2="150" stroke="#e8e4f2"/>';
      h += '<text x="' + f(X(o)) + '" y="168" font-size="11" text-anchor="middle" fill="#666">' + o + '</text>';
    }
    for (r = 0; r <= maxRuns; r += 25) {
      h += '<line x1="40" y1="' + f(Y(r)) + '" x2="540" y2="' + f(Y(r)) + '" stroke="#f0edf7"/>';
      h += '<text x="34" y="' + f(Y(r) + 4) + '" font-size="11" text-anchor="end" fill="#666">' + r + '</text>';
    }
    h += '<polyline points="' + points.map(function (p) { return f(X(p[0])) + ',' + f(Y(p[1])); }).join(' ') + '" fill="none" stroke="#c92a1e" stroke-width="2.5"/>';
    points.forEach(function (p) {
      h += '<circle cx="' + f(X(p[0])) + '" cy="' + f(Y(p[1])) + '" r="4" fill="#c92a1e"/>';
    });
    h += '<text x="40" y="14" font-size="12" font-weight="700" fill="#0f1014">' + esc(team) + ' — ' + esc(score) + ' (' + esc(overs) + ' ov)</text></svg>';
    return h;
  }
  function parseScoreRuns(s) {
    if (!s) return null;
    var mm = /^(\d+)\/(\d+)/.exec(String(s).trim());
    return mm ? { runs: parseInt(mm[1], 10), wkts: parseInt(mm[2], 10) } : null;
  }
  function overNo(label) {
    var mm = /(\d+)/.exec(String(label || ''));
    return mm ? parseInt(mm[1], 10) : null;
  }
  function renderWorm(m) {
    var wrap = document.getElementById('worm-chart');
    if (!wrap) return;
    var team, score, overs, points, maxRuns;
    var baked = null;
    try { baked = JSON.parse(wrap.getAttribute('data-worm-series') || 'null'); } catch (e) { baked = null; }
    var bakedTeam = wrap.getAttribute('data-worm-team') || '';
    if (m.score1) {
      var tot = parseScoreRuns(m.score1);
      if (!tot) return;
      var tl = (m.overTimeline || []).slice().sort(function (a, b) { return overNo(a.label) - overNo(b.label); });
      var oversDone = Math.floor(parseFloat(m.overs1) || 0);
      points = [];
      var later = 0;
      for (var i = tl.length - 1; i >= 0; i--) {
        var n = overNo(tl[i].label);
        if (n == null) continue;
        points.unshift([n, tot.runs - later]);
        later += (tl[i].runs || 0);
      }
      if (!points.length) points = [[oversDone, tot.runs]];
      team = m.team1 || bakedTeam;
      score = m.score1;
      overs = m.overs1 || String(oversDone);
      maxRuns = Math.max(125, Math.ceil(tot.runs / 25) * 25);
    } else {
      if (!baked || !baked.length) return;
      var done = Math.floor(parseFloat(m.overs2) || 0);
      if (done > baked.length - 1) done = baked.length - 1;
      points = [];
      for (var o = 0; o <= done; o++) points.push([o, baked[o]]);
      team = bakedTeam;
      score = m.score2 || String(baked[baked.length - 1]);
      overs = m.overs2 || String(done);
      maxRuns = 125;
    }
    var key = team + '|' + score + '|' + overs + '|' + points.length + '|' + (points.length ? points[points.length - 1][1] : 0);
    if (key === wormLastKey) return;
    wormLastKey = key;
    wrap.innerHTML = wormSvg(points, team, score, overs, maxRuns);
    var note = document.getElementById('worm-note');
    if (note) note.textContent = 'Runs by over — ' + team + ' innings.';
  }

  function render(m, fetchedAt, names) {
    ensureCss();
    /* The compact match header replaced the hero section on 2026-11-12;
       the '.hero' fallback covers pages whose hero has not been removed
       yet (SA20/BBL off-site pages and any not-yet-rebuilt match page). */
    var hero = document.querySelector('.match-head') ||
      document.querySelector('.hero');
    if (hero) {
      if (!chipEl) {
        /* The status chip ("Match yet to begin"); never another chip. */
        var chips = hero.querySelectorAll('.hero-chip');
        for (var c = 0; c < chips.length; c++) {
          if (/Match yet to begin/i.test(chips[c].textContent || '')) { chipEl = chips[c]; break; }
        }
        if (!chipEl && chips.length === 1) chipEl = chips[0];
      }
      if (chipEl) {
        if (m.status === 'live') {
          chipEl.innerHTML = '<span class="live-dot" aria-hidden="true"></span>LIVE';
          chipEl.classList.add('slp-live-chip');
        } else if (m.status === 'result') {
          chipEl.textContent = 'Result';
          chipEl.classList.add('slp-live-chip');
        }
      }
      /* The live score block in the match header (ids set by the page):
         team scores, toss and current run rate. */
      var setText = function (id, txt) {
        var el = document.getElementById(id);
        if (el) el.textContent = txt;
      };
      if (m.status === 'live' || m.status === 'result') {
        if (m.score2) setText('mh-score-bat', (m.team2 || '') + ' ' + m.score2 + (m.overs2 ? ' (' + m.overs2 + ' ov)' : ''));
        if (m.score1) setText('mh-score-field', (m.team1 || '') + ' ' + m.score1 + (m.overs1 ? ' (' + m.overs1 + ' ov)' : ''));
        if (m.toss) setText('mh-toss', m.toss);
        var crr = crrFromInnings(m);
        if (crr) setText('mh-crr', 'Current RR: ' + crr);
      }
      /* M24 fix2 (2026-11-13): a page with a #mh-live score block already
         shows the live score (the spans above), so the separate
         .slp-live-score line would duplicate it as plain text with no
         card. Skip the line there and put the updated time inside the
         .mh-live block instead. Pages without #mh-live keep the line
         exactly as before. */
      if (document.getElementById('mh-live')) {
        if (scoreLineEl && scoreLineEl.parentNode) scoreLineEl.parentNode.removeChild(scoreLineEl);
        scoreLineEl = null;
        var updEl = document.getElementById('mh-updated');
        if (updEl) { var u2 = fmtUpdated(fetchedAt); updEl.textContent = u2 ? ' · ' + u2 : ''; }
      } else {
        if (!scoreLineEl) {
          scoreLineEl = document.createElement('p');
          scoreLineEl.className = 'slp-live-score';
          /* The intro paragraph is the <p> right after the h1 — not the
             crumbs (the match-head's first <p>), which sits above the h1. */
          var h1 = hero.querySelector('h1');
          var intro = (h1 && h1.nextElementSibling && h1.nextElementSibling.tagName === 'P')
            ? h1.nextElementSibling : null;
          if (intro) intro.parentNode.insertBefore(scoreLineEl, intro.nextSibling);
          else hero.appendChild(scoreLineEl);
        }
        scoreLineEl.innerHTML = scoreLineHtml(m, names, fetchedAt);
      }
    }
    renderWorm(m);
    var sc = document.getElementById('scorecard');
    if (sc) {
      if (!scorecardEl) {
        scorecardEl = sc.querySelector('[data-slp-live-scorecard]');
        if (!scorecardEl) {
          var ph = null;
          var ps = sc.querySelectorAll('p');
          for (var i = 0; i < ps.length; i++) {
            if (/Match yet to begin/i.test(ps[i].textContent || '')) { ph = ps[i]; break; }
          }
          if (ph) {
            scorecardEl = document.createElement('div');
            scorecardEl.setAttribute('data-slp-live-scorecard', 'true');
            ph.parentNode.replaceChild(scorecardEl, ph);
          }
        }
      }
      if (scorecardEl) scorecardEl.innerHTML = tablesHtml(m, fetchedAt);
    }
    /* Live tab: same poll, same render. The baked-result guard above
       (isBaked) already owns finished pages — this only runs while
       the match is live or just finished, and shows the final state
       once before polling stops. */
    var lv = document.getElementById('live');
    if (lv) {
      try {
        if (!liveTabEl) {
          liveTabEl = lv.querySelector('[data-slp-live-tab]');
          if (!liveTabEl) {
            var note = lv.querySelector('.slp-live-note');
            if (note) {
              liveTabEl = document.createElement('div');
              liveTabEl.setAttribute('data-slp-live-tab', 'true');
              note.parentNode.replaceChild(liveTabEl, note);
            }
          }
        }
        if (liveTabEl) liveTabEl.innerHTML = liveTabHtml(m, fetchedAt);
      } catch (e) { /* live tab must never break match-head/scorecard */ }
    }
    /* Commentary tab. */
    var cm = document.getElementById('commentary');
    if (cm) {
      try {
        if (!commentaryEl) {
          commentaryEl = cm.querySelector('[data-slp-live-commentary]');
          if (!commentaryEl) {
            var cnote = cm.querySelector('.slp-live-note');
            if (cnote) {
              commentaryEl = document.createElement('div');
              commentaryEl.setAttribute('data-slp-live-commentary', 'true');
              cnote.parentNode.replaceChild(commentaryEl, cnote);
            }
          }
        }
        /* Merge only: prepend new balls, never replace the baked list
           (the feed's commentary is a rolling window). */
        if (commentaryEl) mergeCommentary(m, commentaryEl);
      } catch (e) { /* commentary must never break the rest */ }
    }
    /* Overs tab. */
    var ov = document.getElementById('overs');
    if (ov) {
      try {
        if (!oversEl) {
          oversEl = ov.querySelector('[data-slp-live-overs]');
          if (!oversEl) {
            var onote = ov.querySelector('.slp-live-note');
            if (onote) {
              oversEl = document.createElement('div');
              oversEl.setAttribute('data-slp-live-overs', 'true');
              onote.parentNode.replaceChild(oversEl, onote);
            }
          }
        }
        if (oversEl) oversEl.innerHTML = oversHtml(m, fetchedAt);
      } catch (e) { /* overs must never break the rest */ }
    }
    /* Live Stats tab. */
    var st = document.getElementById('livestats');
    if (st) {
      try {
        if (!statsEl) {
          statsEl = st.querySelector('[data-slp-live-stats]');
          if (!statsEl) {
            var snote = st.querySelector('.slp-live-note');
            if (snote) {
              statsEl = document.createElement('div');
              statsEl.setAttribute('data-slp-live-stats', 'true');
              snote.parentNode.replaceChild(statsEl, snote);
            }
          }
        }
        if (statsEl) statsEl.innerHTML = statsHtml(m, fetchedAt);
      } catch (e) { /* stats must never break the rest */ }
    }
  }

  function loadMatch(league, id) {
    function find(d) {
      var list = (d && d.matches) || [];
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    }
    if (window.sialtvScores) {
      return window.sialtvScores(league).then(function (d) {
        var m = find(d);
        if (m) return { match: m, fetchedAt: d.fetchedAt || '' };
        throw new Error('match not in feed');
      });
    }
    return fetchJson(FEED_API + encodeURIComponent(league)).then(function (d) {
      var m = find(d);
      if (m) return { match: m, fetchedAt: d.fetchedAt || '' };
      throw new Error('match not in feed');
    }).catch(function () {
      var s = STATIC_FEED[league];
      if (!s) throw new Error('no static feed');
      return fetchJson(s).then(function (d) {
        var m = find(d);
        if (m) return { match: m, fetchedAt: d.fetchedAt || '' };
        throw new Error('match not in static feed');
      });
    });
  }

  function boot() {
    var ident = parseIdentity();
    if (!ident) return;
    if (isBaked()) return; /* finished page: the bake owns it */
    var id = ident.league + '-' + ident.season + '-m' + ident.matchNo;
    var names = pageTeamNames();
    function schedule(delay) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, delay);
    }
    function tick() {
      if (document.hidden) return;
      loadMatch(ident.league, id).then(function (res) {
        var m = res.match;
        if (!m) { schedule(POLL_MS); return; }
        if (m.status === 'upcoming') {
          var delay = POLL_MS;
          if (m.kickoffIso) {
            var kick = Date.parse(m.kickoffIso);
            if (!isNaN(kick) && kick - Date.now() > NEAR_MS) delay = SLOW_MS;
          }
          schedule(delay);
          return;
        }
        try { render(m, res.fetchedAt, names); } catch (e) { /* never break the page */ }
        if (m.status === 'result') return; /* final state shown; bake takes over */
        schedule(POLL_MS);
      }).catch(function () { schedule(POLL_MS); });
    }
    tick();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  }

  /* Test hook: lets a harness call the pure renderers with a fake feed
     match. Harmless in production. */
  window.sialtvLiveTab = {
    liveTabHtml: liveTabHtml,
    tablesHtml: tablesHtml,
    commentaryHtml: commentaryHtml,
    oversHtml: oversHtml,
    statsHtml: statsHtml,
    crrFromInnings: crrFromInnings,
    partnershipFromLive: partnershipFromLive,
    fowFromCommentary: fowFromCommentary,
    extrasFromFeed: extrasFromFeed,
    wormSvg: wormSvg
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
