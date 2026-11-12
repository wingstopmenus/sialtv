/* SialTV match-page live updater — the match page itself goes live.
   Loads AFTER js/live-scores.js and reuses its shared fetcher
   (window.sialtvScores): the PHP endpoint first, the committed static
   snapshot second. No parallel fetcher, no second poll loop.

   What it does, and only while the match is actually on:
   - match-head status chip: "Match yet to begin" -> LIVE (red dot) -> Result
   - a live score line under the match-head intro (scores + chase/result line)
   - the Scorecard tab: the "Match yet to begin" note becomes live
     batting/bowling tables from the feed, in the same markup as the
     baked scorecard (Batter/Dismissal/R/B/4s/6s/SR, Bowler/O/M/R/W/Econ).

   GOLDEN RULE: a baked result is never touched. If the page already
   shows a result (match-head "X beat Y by Z runs", or a baked scorecard with
   "Fall of wickets"), this module does nothing at all — no fetch, no
   poll. The match-day bake owns the finished page. Likewise the
   Summary tab is never touched: it is generated at bake time by
   tools/generate-match-summary.py, and on a live page it does not
   exist yet. When the feed says the match is over, the module shows
   the final state once and stops polling; the bake replaces the page.

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

  /* A baked result page: match-head result line, or a baked scorecard with
     fall of wickets. Either one means the bake owns this page.
     (The '.hero h1' fallback covers pages whose hero has not been removed
     yet - SA20/BBL off-site pages and any not-yet-rebuilt match page.) */
  function isBaked() {
    var h1 = document.querySelector('.match-head h1') ||
      document.querySelector('.hero h1');
    if (h1 && /beat|won by|tied|no result|abandoned/i.test(h1.textContent || '')) return true;
    var sc = document.getElementById('scorecard');
    if (sc && /Fall of wickets/i.test(sc.textContent || '')) return true;
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
      '.slp-ball-w{background:#c92a1e;border-color:#c92a1e;color:#fff}'
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
      return '<tr><td>' + esc(b.name) + '</td>' +
        '<td>' + esc(b.overs == null ? '' : b.overs) + '</td>' +
        '<td>' + esc(b.maidens == null ? '' : b.maidens) + '</td>' +
        '<td>' + esc(b.runs) + '</td><td>' + esc(b.wickets) + '</td>' +
        '<td>' + esc(b.econ == null ? '' : b.econ) + '</td></tr>';
    }).join('');
  }

  /* Live tab: CRR and partnership are ARITHMETIC on feed data the
     endpoint already carries — the feed's live.crr / live.partnership
     fields are empty strings, so they are computed here and never
     invented. CRR = current innings runs * 6 / balls bowled.
     Partnership = the two batters at the crease, runs + balls each
     (their combined runs with the bat; extras during the stand are
     not in the feed, so the figure is the pair's batting runs). */
  function ballsFromOvers(ov) {
    var m = /^(\d+)(?:\.(\d))?$/.exec(String(ov || '').trim());
    if (!m) return 0;
    return parseInt(m[1], 10) * 6 + parseInt(m[2] || '0', 10);
  }

  function crrFromInnings(m) {
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
    if (!g) return '';
    var runs = 0;
    var tm = /^(\d+)\//.exec(String(g.total || ''));
    if (tm) runs = parseInt(tm[1], 10);
    var balls = ballsFromOvers(g.overs);
    if (!balls || !runs) return '';
    return (runs * 6 / balls).toFixed(2);
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

  /* Live tab body, in the baked scorecard's own markup (.t-nums,
     .table-scroll, h3). What the feed does NOT carry is omitted, not
     faked: no career columns (Mat/Runs/HS/Ave, Mat/Wkts/BBI/Ave), no
     "This bowler" / "Last 10 ov" / "This spell" / 0s-4s-6s columns,
     no wagon wheel or pitch maps (no data), no commentary feed. */
  function liveTabHtml(m, fetchedAt) {
    var live = m.live || {};
    var bats = live.batters || [];
    var bowls = live.bowlers || [];
    var overs = live.recentOvers || [];
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
    if (crr) meta.push('CRR ' + esc(crr));
    if (live.lastOver) meta.push('Last over: ' + esc(live.lastOver));
    if (meta.length) html += '<p>' + meta.join(' &middot; ') + '</p>';
    if (bats.length) {
      html += '<h3>Current batters</h3><div class="table-scroll"><table class="t-nums"><thead><tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody>';
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
      html += '<h3>Current bowlers</h3><div class="table-scroll"><table class="t-nums"><thead><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr></thead><tbody>';
      html += bowls.map(function (b) {
        return '<tr><td>' + esc(b.name) + (b.current ? ' *' : '') + '</td><td>' + esc(b.overs == null ? '' : b.overs) + '</td><td>' + esc(b.maidens == null ? '' : b.maidens) + '</td><td>' + esc(b.runs) + '</td><td>' + esc(b.wickets) + '</td><td>' + esc(b.econ == null ? '' : b.econ) + '</td></tr>';
      }).join('');
      html += '</tbody></table></div><p class="note">* At the crease / bowling now.</p>';
    }
    if (live.lastWicket) {
      var lw = live.lastWicket;
      html += '<p><b>Last wicket:</b> ' + esc(lw.name) + ' ' + esc(lw.runs) + ' (' + esc(lw.balls) + ') — ' + esc(lw.dismissal || '') + (lw.over ? ', over ' + esc(lw.over) : '') + '</p>';
    }
    if (overs.length) {
      html += '<h3>Recent overs</h3>';
      overs.forEach(function (o) {
        var toks = (o.tokens || []).map(function (t) {
          var w = String(t) === 'W';
          return '<span class="slp-ball' + (w ? ' slp-ball-w' : '') + '">' + esc(w ? 'W' : (String(t) === '0' ? '•' : t)) + '</span>';
        }).join('');
        html += '<p><b>' + esc(o.label || '') + ':</b> ' + toks + ' <span>&middot; ' + esc(String(o.runs)) + '/' + esc(String(o.wickets)) + (o.bowler ? ' &middot; ' + esc(o.bowler) : '') + '</span></p>';
      });
    }
    var upd = fmtUpdated(fetchedAt);
    html += '<p class="note">Live score' + (upd ? ' — ' + upd : '') + '. The full scorecard appears here after the match.</p>';
    return html;
  }

  /* Live innings tables in the baked scorecard's own markup. The feed
     carries no wides/no-balls or extras, so those columns are omitted
     rather than invented — the bake adds the full table afterwards. */
  function tablesHtml(m, fetchedAt) {
    var inns = (m.scorecard && m.scorecard.innings) || [];
    if (!inns.length) return '<p>Match in progress — the scorecard will appear here shortly.</p>';
    var html = '';
    inns.forEach(function (g) {
      html += '<h3>' + esc(g.team) + ' — ' + esc(g.total || '') + (g.overs ? ' (' + esc(g.overs) + ' ov)' : '') + '</h3>';
      if (g.batting && g.batting.length) {
        html += '<div class="table-scroll"><table class="t-nums"><thead><tr><th>Batter</th><th>Dismissal</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody>';
        html += batRows(g.batting);
        html += '</tbody></table></div>';
        html += '<p><b>Total:</b> ' + esc(g.total || '') + (g.overs ? ' (' + esc(g.overs) + ' overs)' : '') + '</p>';
      }
      if (g.bowling && g.bowling.length) {
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
    var sc = document.getElementById('scorecard');
    if (sc) {
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
          var note = lv.querySelector('.slp-live-note');
          if (note) {
            liveTabEl = document.createElement('div');
            liveTabEl.setAttribute('data-slp-live-tab', 'true');
            note.parentNode.replaceChild(liveTabEl, note);
          }
        }
        if (liveTabEl) liveTabEl.innerHTML = liveTabHtml(m, fetchedAt);
      } catch (e) { /* live tab must never break match-head/scorecard */ }
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

  /* Test hook: lets a harness call the pure Live-tab renderer with a
     fake feed match. Harmless in production. */
  window.sialtvLiveTab = {
    liveTabHtml: liveTabHtml,
    crrFromInnings: crrFromInnings,
    partnershipFromLive: partnershipFromLive
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
