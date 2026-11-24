/* SialTV live scores — shared feed + live-scores page panel.
   One shared fetch (window.sialtvScores): the PHP endpoint first, the
   committed static snapshot second, never a broken panel. The browser
   polls every 30 seconds, skips work while the tab is hidden, and
   refreshes at once when the tab becomes visible again. Every fetch
   uses {cache: "no-store"} so a stale Hostinger copy is never trusted.
   The static snapshot only changes when the match-day flow pushes a
   new one, so a poll that finds the same file is cheap and harmless.
   STRIP UNIFY (2026-11-15): the PHP endpoint only returns the current
   window (live + next upcoming) — a finished match falls out of it
   within hours, so a stale baked strip card could never flip to its
   result (flash-scores.js skips cards the feed does not carry). The
   merge below rides recent results from the static snapshot along with
   the live payload, so the strip, the hero and the live-scores panel
   all see the last 7 days of results on every poll, with no re-bake.
   The PHP endpoint itself is untouched.
   FULL AUTO-UPDATE (2026-11-16): on the live-scores page the poller
   also re-renders the ONE list in place, Cricinfo-style — the
   series-list cards (NPL + ILT20) — from the live feed the moment a
   result lands, and the sidebar rankings / records / leader lists
   from /data/live-scores-state.json (the bake's authoritative snapshot:
   points, leaders) whenever it changes. No reload, no
   flash, no spinner. Sections the feed cannot supply faithfully
   (points, records) update from the state file,
   never from a guess. The points table is ALSO recomputed in the
   browser from the state's full results list the instant a league
   result lands (build_data.py rules, verified exact against the M28
   table); the state file's points win whenever they differ. There is
   NO freshness clock line any more: it ticked on every poll because it
   was a clock, not data proof, and Cricinfo shows none — the in-place
   updates are the proof. The baked "Last updated: <date>" under the H1 stays.
   DEDUPE (2026-11-16): the page is ONE list — no flash row, no root
   pair, no featured centre, no sidebar latest-result card. The poller
   renders nothing into those (they are gone); it reconciles the list
   and, when it changes a card, asks live-scores-tabs.js to rebuild the
   Schedule + Results views from the list
   (window.sialtvRebuildTabViews). The state file carries no featured
   match any more (write-live-scores-state.py, bake step 4a2). */
(function () {
  'use strict';
  var POLL_MS = 30 * 1000;
  var CACHE_MS = 10 * 1000;
  var FEED_API = '/api/live-scores.php?league=';
  var STATIC_FEED = { npl: '/data/live-scores.json', ilt20: '/data/ilt20-live-scores.json', sa20: '/data/sa20-live-scores.json', bbl: '/data/bbl-live-scores.json' };
  var cache = {};

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function sialtvScores(league) {
    league = league || 'npl';
    var now = Date.now();
    var c = cache[league];
    if (c && c.data && now - c.at < CACHE_MS) return Promise.resolve(c.data);
    if (c && c.promise && now - c.at < CACHE_MS) return c.promise;
    var p = fetchJson(FEED_API + encodeURIComponent(league)).then(function (d) {
      if (d && d.matches && d.matches.length) {
        return mergeRecentResults(d, league).then(function (merged) {
          cache[league] = { at: Date.now(), data: merged };
          return merged;
        });
      }
      throw new Error('empty live feed');
    }).catch(function () {
      var s = STATIC_FEED[league];
      if (!s) return { fetchedAt: '', source: 'none', matches: [] };
      return fetchJson(s).then(function (d) {
        /* Stamp the league on the static fallback: the strip's
           cross-league guard (flash-scores.js refreshCarousel) trusts
           data.league, and the static files carry none — without this
           an ILT20 poll overwrites NPL cards in the "All Matches"
           track by match number when the API is down. */
        if (d) d.league = league;
        cache[league] = { at: Date.now(), data: d };
        return d;
      }).catch(function () {
        return { fetchedAt: '', source: 'none', matches: [] };
      });
    });
    cache[league] = { at: now, promise: p };
    return p;
  }
  window.sialtvScores = sialtvScores;

  /* Recent results from the static snapshot, merged into the live
     payload. The PHP endpoint deliberately carries no results
     ("Results come from ESPN only"), and ESPN's scoreboard only shows
     the current window, so without this a baked card for a finished
     match could never flip to its result on poll. Only results dated
     within RECENT_RESULT_DAYS ride along, and only when the live
     payload does not already carry that match — the live payload
     always wins. A failed static fetch leaves the live payload
     untouched. Leagues with no static snapshot (APL) are unaffected. */
  var RECENT_RESULT_DAYS = 7;
  function mergeRecentResults(data, league) {
    var s = STATIC_FEED[league];
    if (!s || !data || !data.matches) return Promise.resolve(data);
    return fetchJson(s).then(function (st) {
      var have = {};
      data.matches.forEach(function (m) { have[m.matchNo] = true; });
      var cut = Date.now() - RECENT_RESULT_DAYS * 24 * 60 * 60 * 1000;
      (st.matches || []).forEach(function (m) {
        if (m.status !== 'result' || have[m.matchNo]) return;
        var when = m.date ? Date.parse(m.date + 'T00:00:00Z')
                          : Date.parse(m.kickoffIso || '');
        if (isNaN(when) || when < cut) return;
        data.matches.push(m);
      });
      return data;
    }).catch(function () { return data; });
  }
  window.sialtvMergeRecentResults = mergeRecentResults;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  window.sialtvEsc = esc;

  /* Write-only-on-change (same helpers as match-live.js / flash-scores.js):
     assigning textContent / innerHTML rebuilds the node even when the
     string is identical, and that rebuild is the visible flash on
     every poll. The _html cache compares against the string actually
     written, never the browser's serialisation. The counter proves the
     no-change case: with unchanged data a poll writes nothing. */
  var writes = { text: 0, html: 0 };
  window.sialtvWriteCount = function () { return { text: writes.text, html: writes.html }; };
  function setText(el, txt) { if (el && el.textContent !== txt) { el.textContent = txt; writes.text++; } }
  function setHtml(el, html) { if (el && el._html !== html) { el.innerHTML = html; el._html = html; writes.html++; } }
  /* Has the first ball been bowled? The endpoint flags a match "live"
     ~15 min before kickoff, so status alone cannot prove play has
     started — only a score, a ball or an innings row can. Same rule
     as match-live.js. */
  function hasStarted(m) {
    if (!m) return false;
    if (m.score1 || m.score2) return true;
    if ((m.commentary || []).length) return true;
    var inns = (m.scorecard && m.scorecard.innings) || [];
    for (var i = 0; i < inns.length; i++) {
      if (((inns[i].batting || []).length) || ((inns[i].bowling || []).length)) return true;
    }
    return false;
  }
  function isLiveNow(m) { return !!m && m.status === 'live' && hasStarted(m); }
  /* Toss window: the match is live and the toss is done, but no ball
     has been bowled yet. Cricinfo/ESPN label it live from the toss —
     so do we. The phantom window (live, no toss, no score) is NOT
     this: it stays upcoming. isLiveShown = "shown as live". */
  function hasToss(m) { return !!m && !!(m.toss && String(m.toss).trim()); }
  function isLiveToss(m) { return !!m && m.status === 'live' && !hasStarted(m) && hasToss(m); }
  function isLiveShown(m) { return isLiveNow(m) || isLiveToss(m); }

  function pick(matches) {
    var live = null, latest = null, next = null;
    (matches || []).forEach(function (m) {
      /* A pre-start live match with NO toss is not live yet — no ball
         bowled, no toss — so it counts as the next match, not the
         live one. This also fixes hero-score.js / live-card.js (both
         use window.sialtvPick): pre-start no longer shows "Live now"
         there. WITH a toss the match IS live. */
      if (m.status === 'live' && isLiveShown(m)) live = m;
      if (m.status === 'result' && (!latest || m.matchNo > latest.matchNo)) latest = m;
      var kickoff = Date.parse(m.kickoffIso || '');
      var canBeNext = Number.isNaN(kickoff) || kickoff > Date.now() || m.status === 'live';
      if (canBeNext && (m.status === 'upcoming' || (m.status === 'live' && !isLiveShown(m))) &&
          (!next || m.matchNo < next.matchNo)) next = m;
    });
    return { live: live, latest: latest, next: next };
  }
  window.sialtvPick = pick;

  /* "5:00 PM" from a kickoff ISO — the upcoming cards' day badge.
     Visitor-local: Intl without timeZone renders in the visitor's zone. */
  function fmtTimeLocal(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
    } catch (e) { return ''; }
  }

  /* Match pages exist for npl, ilt20, sa20 and bbl only; apl and psl
     fall back to the results list until their match pages exist. */
  var MATCH_SEASON = { npl: '2026', ilt20: '2026-27', sa20: '2026-27', bbl: '2026-27' };
  function matchUrl(league, matchNo) {
    var season = MATCH_SEASON[league];
    return season ? '/' + league + '/matches/' + season + '/match-' + matchNo + '/' : '/' + league + '/results/';
  }

  /* Team names from the feed carry a league tag ("Kathmandu Gorkhas
     (NPL)") and spell the Royals "Sudurpaschim"; the site displays plain
     names, "Sudur Paschim Royals" with a space. */
  function teamName(s) {
    return String(s == null ? '' : s).replace(/\s*\((NPL|ILT20|APL|SA20|BBL|PSL)\)/g, '').replace(/Sudurpaschim/g, 'Sudur Paschim');
  }
  /* Overs of "0" (or "0.0") with no score yet is not a real innings —
     treat it as no overs, so the side shows "Yet to Bat" instead of a
     blank score followed by "(0 ov)". */
  function hasOvers(o) { return !!o && o !== '0' && o !== '0.0'; }

  /* One team row, shared by the live card and the result card: logo (or
     the code chip when the logo map has no entry), optional batting dot,
     name, overs, score right-aligned. A side that has not batted yet
     shows "Yet to Bat", never a bare name or "( ov)". */
  function teamRow(team, abbr, pre, score, opts) {
    opts = opts || {};
    var img = logoImg(team);
    var chip = img || '<span class="ls-code" aria-hidden="true">' + esc(abbr || '') + '</span>';
    var dot = opts.batting ? '<span class="ls-bat" aria-hidden="true"></span>' : '';
    var row = '<div class="rx-res-team' + (opts.loser ? ' is-loser' : '') + '">' + chip + dot +
      '<span class="rx-tname"><b>' + esc(teamName(team)) + '</b></span>';
    if (opts.yetToBat) row += '<span class="rx-tpre">Yet to Bat</span>';
    else if (pre) row += '<span class="rx-tpre">' + pre + '</span>';
    if (score) row += '<span class="rx-tscore">' + esc(score) + '</span>';
    return row + '</div>';
  }

  /* League tag for feed rows, Cricinfo-style: "Biratnagar Kings (NPL)". */
  var LEAGUE_TAG = { npl: 'NPL', ilt20: 'ILT20', apl: 'APL', sa20: 'SA20', bbl: 'BBL', psl: 'PSL' };
  function leagueTag(league) { return LEAGUE_TAG[league] || String(league || '').toUpperCase(); }

  /* ---- list-card helpers (shared with the baked cards) ---- */
  function ordinal(n) {
    n = parseInt(n, 10) || 0;
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function fmtDateLong(iso) {
    if (!iso) return '';
    try {
      /* Date-only string: parse as local midnight (no Z, no timeZone)
         so the calendar date itself never shifts in the visitor's zone. */
      return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso + 'T00:00:00'));
    } catch (e) { return iso; }
  }
  function venueShort(v) {
    v = String(v || '');
    if (/Kirtipur/i.test(v)) return 'Kirtipur';
    if (/Abu Dhabi/i.test(v)) return 'Abu Dhabi';
    if (/Dubai/i.test(v)) return 'Dubai';
    if (/Sharjah/i.test(v)) return 'Sharjah';
    return v;
  }
  /* Team logo from the map (keys use feed spelling, e.g. "Sudurpaschim
     Royals"); the map's <img> already carries an alt, so it is
     REPLACED in place with the display name (the same overwrite
     live-scores-tabs.js enhanceLogos() does) — never a second alt, and
     the width/height stay, so a card the poller rebuilds compares
     equal to the enhanced baked one. Falls back to the 3-letter code
     chip used by the baked cards. */
  function logoImg(team) {
    var key = teamName(team);
    if (window.sialtvTeamLogos && window.sialtvTeamLogos[key]) {
      return window.sialtvTeamLogos[key].replace(/ alt="[^"]*"/, ' alt="' + esc(key) + ' logo"');
    }
    return '';
  }
  /* Which side won, from the result line "X won by ...": 0 = team1,
     1 = team2, -1 = unknown. */
  function winnerSide(m) {
    var mm = /^(.+?) won by/.exec(teamName(m.statusText || ''));
    if (!mm) return -1;
    var w = mm[1].trim();
    if (w === teamName(m.team1)) return 0;
    if (w === teamName(m.team2)) return 1;
    return -1;
  }
  var LEAGUE_NAMES = { npl: 'Nepal Premier League', ilt20: 'ILT20', apl: 'Afghanistan Premier League' };

  /* ================= FULL AUTO-UPDATE (2026-11-16) =================
     The poller above keeps the strip and the hero fresh. Everything
     else on the live-scores page used to change only on a bake — the
     series-list cards and the sidebar rankings / records / leader
     lists. The sections below close that gap, Cricinfo-style: they
     re-render in place from fresh data, with no reload, no flash, no
     spinner. Two sources, each used for what it is good at:
     - the LIVE FEED (30s poll) — the instant trigger. A result landing
       in the feed flips the list cards at once, and the points table
       recomputes from the state's full results list (below).
     - the STATE FILE (/data/live-scores-state.json, 120s TTL) — the
       bake's authoritative snapshot: points, leaders. The bake writes
       it as step 4a2, right after re-baking the
       page (step 4c), so a push carries both. Sections the feed cannot
       supply faithfully (points, records) update
       from the state file, never from a guess. The state file's points
       WIN whenever they differ from the browser recompute — the
       recompute is only the instant bridge until the next state file lands.
     Every write goes through setText / setHtml, so a poll that finds
     unchanged data writes nothing (window.sialtvWriteCount proves it).
     A missing state file degrades cleanly: the feed-driven sections
     still update, the state-driven ones keep the baked content. */

  /* ---- the state file ---- */
  var STATE_URL = '/data/live-scores-state.json';
  var STATE_TTL_MS = 120 * 1000;
  var stateCache = null;
  function fetchState(force) {
    var now = Date.now();
    if (!force && stateCache && stateCache.data && now - stateCache.at < STATE_TTL_MS) return Promise.resolve(stateCache.data);
    return fetchJson(STATE_URL).then(function (d) {
      if (d && d.points && d.results) { stateCache = { at: Date.now(), data: d }; return d; }
      throw new Error('bad state file');
    }).catch(function () { return stateCache && stateCache.data ? stateCache.data : null; });
  }
  window.sialtvFetchState = fetchState;

  /* ---- points, recomputed in the browser (build_data.py rules) ----
     Per result match: an all-out innings counts its full quota of balls
     (20 overs, or 5 for the M8 rain game — quota rides in the state
     file); an abandoned match is +1 point each, no runs or balls; the
     winner takes 2 points. NRR = runs_for / overs_for - runs_against /
     overs_against, rounded to 3 decimals. Sort: -points, -NRR, -won,
     code. Playoff matches add no league points. Verified against the
     Python oracle: the M28 table reproduces EXACTLY (all 8 rows).
     Rounding note: JS Math.round is half-up, Python round() is
     half-even — a 0.001 edge case would differ, and the state file's
     points win whenever they do, so the recompute can never leave a
     wrong table on screen past the next state file. */
  var TEAM_NAMES = { BIK: 'Biratnagar Kings', CHR: 'Chitwan Rhinos', JAB: 'Janakpur Bolts', KAG: 'Kathmandu Gorkhas', KAY: 'Karnali Yaks', LUL: 'Lumbini Lions', POA: 'Pokhara Avengers', SPR: 'Sudur Paschim Royals' };
  function oversToBalls(o) {
    if (o === undefined || o === null || o === '') return 0;
    var parts = String(o).split('.');
    return (parseInt(parts[0], 10) || 0) * 6 + (parseInt(parts[1], 10) || 0);
  }
  function parseScore(s) {
    if (!s) return null;
    var parts = String(s).split('/');
    var runs = parseInt(parts[0], 10);
    if (isNaN(runs)) return null;
    return { runs: runs, wk: parts.length > 1 ? (parseInt(parts[1], 10) || 0) : 0 };
  }
  function round3(x) { return Math.round(x * 1000) / 1000; }
  function nrrDisplay(nrr) { return (nrr < 0 ? '' : '+') + nrr.toFixed(3); }
  function computePoints(results) {
    var t = {};
    Object.keys(TEAM_NAMES).forEach(function (code) {
      t[code] = { code: code, name: TEAM_NAMES[code], played: 0, won: 0, lost: 0, points: 0, rf: 0, bf: 0, ra: 0, ba: 0 };
    });
    var after = 0;
    (results || []).forEach(function (r) {
      if (!r || !t[r.team1] || !t[r.team2]) return;
      if (r.stage) return;
      if (r.status === 'abandoned') {
        t[r.team1].played++; t[r.team2].played++;
        t[r.team1].points++; t[r.team2].points++;
        return;
      }
      if (r.status !== 'result') return;
      var s1 = parseScore(r.score1), s2 = parseScore(r.score2);
      if (!s1 || !s2) return;
      var q = (r.quota || 20) * 6;
      var b1 = s1.wk === 10 ? q : oversToBalls(r.overs1);
      var b2 = s2.wk === 10 ? q : oversToBalls(r.overs2);
      if (!b1 || !b2) return;
      var a = t[r.team1], b = t[r.team2];
      a.played++; b.played++;
      a.rf += s1.runs; a.bf += b1; a.ra += s2.runs; a.ba += b2;
      b.rf += s2.runs; b.bf += b2; b.ra += s1.runs; b.ba += b1;
      if (r.winner === r.team1) { a.won++; b.lost++; a.points += 2; }
      else if (r.winner === r.team2) { b.won++; a.lost++; b.points += 2; }
      if (r.matchNo > after) after = r.matchNo;
    });
    var rows = Object.keys(t).map(function (code) {
      var x = t[code];
      var nrr = x.played ? round3(x.rf / (x.bf / 6) - x.ra / (x.ba / 6)) : 0;
      return { code: code, name: x.name, played: x.played, won: x.won, lost: x.lost, points: x.points, nrr: nrr, nrr_display: nrrDisplay(nrr) };
    });
    rows.sort(function (a, b) { return (b.points - a.points) || (b.nrr - a.nrr) || (b.won - a.won) || (a.code < b.code ? -1 : 1); });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    return { rows: rows, after_match: after };
  }
  window.sialtvComputePoints = computePoints;
  /* The points to show: the state's, unless the feed carries a NEWER
     league result the state file has not caught up with yet — then the
     recompute bridges the gap. A playoff result (Q1 and on) folds to
     nothing, so the table correctly does not move for it. */
  function pointsToRender(state, feedMatches) {
    if (!state || !state.results) return null;
    var merged = state.results.slice();
    (feedMatches || []).forEach(function (fm) {
      var row = { matchNo: fm.matchNo, date: fm.date, stage: null, status: fm.status,
        team1: fm.team1, team2: fm.team2, score1: fm.score1 || '', score2: fm.score2 || '',
        overs1: fm.overs1 || '', overs2: fm.overs2 || '', quota: 20, winner: null };
      var w = winnerSide(fm);
      row.winner = w === 0 ? fm.team1 : (w === 1 ? fm.team2 : null);
      var k;
      for (k = 0; k < state.results.length; k++) {
        if (state.results[k].matchNo === fm.matchNo) {
          row.stage = state.results[k].stage;
          row.quota = state.results[k].quota || 20;
          row.date = state.results[k].date;
          break;
        }
      }
      var found = false;
      for (k = 0; k < merged.length; k++) {
        if (merged[k].matchNo === fm.matchNo) { merged[k] = row; found = true; break; }
      }
      if (!found) merged.push(row);
    });
    var recomputed = computePoints(merged);
    if (!recomputed || !recomputed.rows.length) return null;
    if (recomputed.after_match > state.through_match) return recomputed;
    return { rows: state.points, after_match: state.through_match };
  }

  /* ---- sidebar: rankings + records (hub tp-list rows) ----
     SIDEBAR REDESIGN (2026-11-16, user order): the top three cards were
     plain lists with link + description spans. Quick Links is now a
     clean link list — no descriptions, so renderQuickNpl is GONE (the
     state file no longer carries `next` either). Records index +
     Rankings are tp-list rows, re-rendered the same way as the leader
     cards below: a tmp <ul> is serialised and compared to the baked
     <ul>'s outerHTML, so entity serialisation (&middot; / &amp;) can
     never cause a false rewrite — a no-change poll writes nothing.
     The cards are found by their data-side hooks (the headings are
     plain <h3> now, no heading links), and sidebarCardByLink is gone
     with them. parseRecordsLine mirrors the builder's
     parse_records_line exactly (same split, same suffix strip, same
     &amp; unescape + esc round-trip) so the baked rows and the
     poller's re-render are byte-identical. A records line whose format
     changed returns null and the baked rows are left alone — never a
     guess. */
  function sidebarCard(side) {
    return document.querySelector('.side-card[data-side="' + side + '"]');
  }
  function parseRecordsLine(line) {
    var parts = String(line || '').split(' &middot; ');
    if (parts.length !== 3) return null;
    var labels = ['Most runs', 'Most wickets', 'Best bowling'];
    var rows = [];
    for (var i = 0; i < 3; i++) {
      var part = parts[i].replace(/\.$/, '').replace(/ (runs|wickets)$/, '');
      part = part.replace(/&amp;/g, '&');
      var cut = part.lastIndexOf(' ');
      if (cut < 1) return null;
      rows.push({label: labels[i], name: part.slice(0, cut), fig: part.slice(cut + 1)});
    }
    return rows;
  }
  function recordsRowsHtml(rows) {
    return rows.map(function (r) {
      return '<li><div class="tp-main"><span class="tp-name">' + esc(r.name) + '</span>' +
        '<span class="tp-sub">' + r.label + '</span></div>' +
        '<strong class="tp-fig">' + esc(r.fig) + '</strong></li>';
    }).join('');
  }
  function rankingsRowsHtml(rows) {
    return rows.slice(0, 4).map(function (r) {
      return '<li><span class="tp-rank">' + r.rank + '</span>' +
        '<div class="tp-main"><span class="tp-name">' + esc(r.name) + '</span></div>' +
        '<strong class="tp-fig">' + r.points + '</strong>' +
        '<span class="rk-unit">pts</span></li>';
    }).join('');
  }
  function renderTpList(ul, rowsHtml) {
    if (!ul) return;
    var tmp = document.createElement('ul');
    tmp.className = 'tp-list';
    tmp.innerHTML = rowsHtml;
    if (tmp.outerHTML !== ul.outerHTML) { ul.innerHTML = tmp.innerHTML; writes.html++; }
  }
  function renderRankings(pts) {
    if (!pts || !pts.rows || !pts.rows.length) return;
    var card = sidebarCard('rankings');
    if (!card) return;
    renderTpList(card.querySelector('ul.tp-list'), rankingsRowsHtml(pts.rows));
  }
  function renderRecords(state) {
    if (!state || !state.leaders || !state.leaders.records_line) return;
    var card = sidebarCard('records');
    if (!card) return;
    var rows = parseRecordsLine(state.leaders.records_line);
    if (!rows) return; /* generator format changed: leave the baked rows alone */
    renderTpList(card.querySelector('ul.tp-list'), recordsRowsHtml(rows));
  }

  /* ---- sidebar: top-3 runs / wickets (hub tp-list cards) ----
     The state file carries the same rows the builder baked from, so a
     re-render is byte-identical to the baked list. The comparison is
     outerHTML-to-outerHTML on a parsed node: the browser serialises
     "&middot;" as the literal "·", so a string comparison would fail
     on every card, every poll and rewrite the lists every 30 seconds —
     the same bug the dedupe fixed for the list. A state file without
     the lists (pre-2026-11-16) leaves the baked cards alone. */
  function leadersListHtml(rows) {
    return rows.map(function (r) {
      return '<li>' + (r.avatar || '') + '<div class="tp-main">' +
        '<a class="tp-name" href="/npl/players/' + esc(r.slug) + '/">' + esc(r.name) + '</a>' +
        '<span class="tp-sub">' + esc(r.sub1) + '</span>' +
        '<span class="tp-sub">Innings: ' + esc(r.mat) + ' &middot; Average: ' + esc(r.ave) + '</span></div>' +
        '<strong class="tp-fig">' + esc(r.fig) + '</strong></li>';
    }).join('');
  }
  function renderLeadersList(ul, rows) {
    if (!ul || !rows || rows.length !== 3) return false;
    var tmp = document.createElement('ul');
    tmp.className = 'tp-list';
    tmp.innerHTML = leadersListHtml(rows);
    if (tmp.outerHTML === ul.outerHTML) return false;
    ul.innerHTML = tmp.innerHTML;
    writes.html++;
    return true;
  }
  function renderLeaders(state) {
    if (!state || !state.leaders) return;
    var runs = document.querySelector('.side-card[data-side="top-runs"] ul.tp-list');
    var wkts = document.querySelector('.side-card[data-side="top-wickets"] ul.tp-list');
    if (runs) renderLeadersList(runs, state.leaders.top_runs);
    if (wkts) renderLeadersList(wkts, state.leaders.top_wickets);
  }

  /* ---- series-list cards (the Live tab's per-league boxes) ----
     Mirrors cards.py's result_card / upcoming_card in the baked <div>
     shape (data-format / data-gender / data-teams / overlay), with the
     live branch taken from the feed. The logo helper appends the alt
     AFTER class/src — exactly what live-scores-tabs.js enhanceLogos()
     produces — so a card the tabs script already enhanced compares
     equal and is not rewritten. */
  var TEAM_SLUGS = { 'Biratnagar Kings': 'biratnagar-kings', 'Chitwan Rhinos': 'chitwan-rhinos', 'Janakpur Bolts': 'janakpur-bolts', 'Kathmandu Gorkhas': 'kathmandu-gorkhas', 'Karnali Yaks': 'karnali-yaks', 'Lumbini Lions': 'lumbini-lions', 'Pokhara Avengers': 'pokhara-avengers', 'Sudur Paschim Royals': 'sudurpaschim-royals' };
  var PLAYOFF_STAGE = { 29: 'Qualifier 1', 30: 'Eliminator', 31: 'Qualifier 2', 32: 'Final' };
  function teamSlug(name) {
    var n = teamName(name);
    return TEAM_SLUGS[n] || n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function logoImgBaked(team) {
    var key = teamName(team);
    if (window.sialtvTeamLogos && window.sialtvTeamLogos[key]) {
      /* The map's <img> already carries an alt — replace it in place
         with the display name (same overwrite enhanceLogos() does), so
         the poller's img is byte-identical to the enhanced baked one
         (class, src, alt, width, height). The map's SPR alt spells it
         "Sudurpaschim"; the display name is "Sudur Paschim". */
      return window.sialtvTeamLogos[key].replace(/ alt="[^"]*"/, ' alt="' + esc(key) + ' logo"');
    }
    return '';
  }
  function teamLogoOrChip(team, abbr) {
    var img = logoImgBaked(team);
    if (img) return img;
    return '<span class="ls-code" aria-hidden="true">' + esc(abbr || '') + '</span>';
  }
  function stageLabelFor(matchNo, league, state) {
    if (league !== 'npl') return null;
    if (state && state.results) {
      for (var i = 0; i < state.results.length; i++) {
        if (state.results[i].matchNo === matchNo && state.results[i].stage) return state.results[i].stage;
      }
    }
    return PLAYOFF_STAGE[matchNo] || null;
  }
  /* Cricinfo chase format, mirroring cards.py's _chaser_tpre: the full
     standard quota drops the "/20" ("(20 ov, T:225)"); a partial chase
     — or a full reduced quota (M8: "(5/5 ov, T:106)") — keeps it. */
  function chaserTpre(ov, target, quota) {
    quota = quota || 20;
    ov = String(ov);
    if (ov === String(quota) && quota === 20) return '(20 ov, T:' + target + ')';
    return '(' + ov + '/' + quota + ' ov, T:' + target + ')';
  }
  function listDescLine(m, league, state) {
    var label = stageLabelFor(m.matchNo, league, state) || (ordinal(m.matchNo) + ' Match');
    var seriesName = LEAGUE_NAMES[league] || leagueTag(league);
    return label + ', ' + esc(venueShort(m.venue)) + ', ' + esc(fmtDateLong(m.date)) +
      ' &middot; <a href="/' + esc(league) + '/">' + esc(seriesName) + '</a>';
  }
  /* Which side chased, and the target — the chase tpre always sits on
     the CHASER's row (cards.py result_card). The winner is NOT always
     the chaser: M28's winner POA batted first and defended, so the
     LOSER (KAG) carries "(19.5/20 ov, T:225)". Sources, in order:
     (1) the feed's scorecard innings — innings[0] batted first, so
     the winner chased iff it is innings[1]'s side, and the target is
     innings[0]'s total + 1 (the API keeps the scorecards, and the
     static snapshot carries them); (2) the state file's results rows,
     which the bake writes from matches.json's innings order
     (win_chased / target); (3) last resort, the old heuristic
     (team2 won ⇒ team2 chased) — wrong when the fixture's team2
     batted first, so it only ever fires on a malformed feed. */
  function chaseInfo(m, league, state) {
    var inns = (m.scorecard && m.scorecard.innings) || [];
    var w = winnerSide(m);
    if (inns.length >= 2 && w >= 0) {
      var winTeam = w === 0 ? m.team1 : m.team2;
      var first = inns[0] || {};
      var second = inns[1] || {};
      var firstRuns = NaN;
      if (first.total) firstRuns = parseInt(String(first.total).split('/')[0], 10);
      if (isNaN(firstRuns)) {
        var ft = teamName(first.team || '');
        if (ft === teamName(m.team1)) firstRuns = parseInt(String(m.score1 || '').split('/')[0], 10);
        else if (ft === teamName(m.team2)) firstRuns = parseInt(String(m.score2 || '').split('/')[0], 10);
      }
      if (!isNaN(firstRuns)) {
        return { winChased: teamName(winTeam) === teamName(second.team || ''), target: firstRuns + 1 };
      }
    }
    if (state && state.results) {
      for (var i = 0; i < state.results.length; i++) {
        var r = state.results[i];
        if (r.matchNo === m.matchNo && r.win_chased !== undefined && r.win_chased !== null) {
          return { winChased: !!r.win_chased, target: r.target };
        }
      }
    }
    return { winChased: w === 1, target: null };
  }
  function listResultCardHtml(m, league, state) {
    var w = winnerSide(m);
    if (w < 0) return '';
    var win = w === 0 ? { team: m.team1, abbr: m.abbr1, score: m.score1, overs: m.overs1 } : { team: m.team2, abbr: m.abbr2, score: m.score2, overs: m.overs2 };
    var lose = w === 0 ? { team: m.team2, abbr: m.abbr2, score: m.score2, overs: m.overs2 } : { team: m.team1, abbr: m.abbr1, score: m.score1, overs: m.overs1 };
    var label = stageLabelFor(m.matchNo, league, state) || (ordinal(m.matchNo) + ' Match');
    var url = matchUrl(league, m.matchNo);
    var ci = chaseInfo(m, league, state);
    var winChased = ci.winChased;
    /* The first innings' overs set the quota (cards.py): the side that
       batted first is the loser when the winner chased, else the winner. */
    var firstOvers = winChased ? lose.overs : win.overs;
    var maxov = (firstOvers === '5' || firstOvers === '5.0') ? 5 : 20;
    var winTpre, loseTpre;
    if (winChased) {
      var tgt = ci.target !== null && ci.target !== undefined ? ci.target : (parseInt(String(lose.score).split('/')[0], 10) + 1);
      winTpre = chaserTpre(win.overs, tgt, maxov);
      loseTpre = '(' + lose.overs + ' ov)';
    } else {
      winTpre = '(' + win.overs + ' ov)';
      var tgt2 = ci.target !== null && ci.target !== undefined ? ci.target : (parseInt(String(win.score).split('/')[0], 10) + 1);
      loseTpre = chaserTpre(lose.overs, tgt2, maxov);
    }
    return '<div class="rx-res-card" data-format="t20" data-gender="men" data-teams="' + esc(teamSlug(m.team1) + ' ' + teamSlug(m.team2)) +
      '" data-league="' + esc(league) + '" data-match-no="' + m.matchNo + '" data-date="' + esc(m.date || '') + '">' +
      '<div class="rx-res-status">RESULT</div>' +
      '<div class="rx-res-desc">' + listDescLine(m, league, state) + '</div>' +
      '<div class="rx-res-team">' + teamLogoOrChip(win.team, win.abbr) +
      '<span class="rx-tname"><b>' + esc(teamName(win.team)) + '</b></span>' +
      '<span class="rx-tpre">' + winTpre + '</span>' +
      '<span class="rx-tscore">' + esc(win.score) + '</span></div>' +
      '<div class="rx-res-team is-loser">' + teamLogoOrChip(lose.team, lose.abbr) +
      '<span class="rx-tname"><b>' + esc(teamName(lose.team)) + '</b></span>' +
      '<span class="rx-tpre">' + loseTpre + '</span>' +
      '<span class="rx-tscore">' + esc(lose.score) + '</span></div>' +
      '<div class="rx-res-result">' + esc(teamName(m.statusText || '')) + '</div>' +
      '<div class="rx-res-links"><a href="' + url + '#summary">Summary</a>' +
      '<a href="' + url + '#scorecard">Scorecard</a>' +
      '<a href="/' + esc(league) + '/">Series</a></div>' +
      '<a class="rx-card-link" href="' + url + '" aria-label="' + esc(label) + ': ' + esc(teamName(win.team)) + ' vs ' + esc(teamName(lose.team)) + '"></a></div>';
  }
  function listUpcomingCardHtml(m, league, state) {
    var label = stageLabelFor(m.matchNo, league, state) || (ordinal(m.matchNo) + ' Match');
    var url = matchUrl(league, m.matchNo);
    var wd = '';
    try { wd = new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(new Date((m.date || '') + 'T00:00:00')).toUpperCase(); } catch (e) { wd = 'UPCOMING'; }
    var badge = (wd || 'UPCOMING') + ' &middot; ' + esc(fmtTimeLocal(m.kickoffIso) || '');
    return '<div class="rx-res-card" data-format="t20" data-gender="men" data-teams="' + esc(teamSlug(m.team1) + ' ' + teamSlug(m.team2)) +
      '" data-league="' + esc(league) + '" data-match-no="' + m.matchNo + '">' +
      '<div class="rx-res-status upcoming">' + badge + '</div>' +
      '<div class="rx-res-desc">' + listDescLine(m, league, state) + '</div>' +
      '<div class="rx-res-team">' + teamLogoOrChip(m.team1, m.abbr1) +
      '<span class="rx-tname"><b>' + esc(teamName(m.team1)) + '</b></span></div>' +
      '<div class="rx-res-team">' + teamLogoOrChip(m.team2, m.abbr2) +
      '<span class="rx-tname"><b>' + esc(teamName(m.team2)) + '</b></span></div>' +
      '<div class="rx-res-result is-upcoming">Match yet to begin</div>' +
      '<div class="rx-res-links"><a href="' + url + '#summary">Summary</a>' +
      '<a href="' + url + '#scorecard">Scorecard</a>' +
      '<a href="/' + esc(league) + '/">Series</a></div>' +
      '<a class="rx-card-link" href="' + url + '" aria-label="' + esc(label) + ': ' + esc(teamName(m.team1)) + ' vs ' + esc(teamName(m.team2)) + '"></a></div>';
  }
  function listLiveCardHtml(m, league, state) {
    var label = stageLabelFor(m.matchNo, league, state) || (ordinal(m.matchNo) + ' Match');
    var url = matchUrl(league, m.matchNo);
    var bat = m.score2 ? 2 : (m.score1 ? 1 : 0);
    var runs1 = parseInt(String(m.score1 || '').split('/')[0], 10) || 0;
    var maxov = (m.overs1 === '5' || m.overs1 === '5.0') ? '5' : '20';
    var pre1 = hasOvers(m.overs1) ? '(' + esc(m.overs1) + ' ov)' : '';
    var pre2 = hasOvers(m.overs2) ? chaserTpre(m.overs2, runs1 + 1, parseInt(maxov, 10)) : '';
    return '<div class="rx-res-card is-live" data-format="t20" data-gender="men" data-teams="' + esc(teamSlug(m.team1) + ' ' + teamSlug(m.team2)) +
      '" data-league="' + esc(league) + '" data-match-no="' + m.matchNo + '" data-date="' + esc(m.date || '') + '">' +
      '<div class="rx-res-status is-live">LIVE</div>' +
      '<div class="rx-res-desc">' + listDescLine(m, league, state) + '</div>' +
      teamRow(m.team1, m.abbr1, pre1, m.score1, { batting: bat === 1, yetToBat: bat === 2 && !m.score1 }) +
      teamRow(m.team2, m.abbr2, pre2, m.score2, { batting: bat === 2, yetToBat: bat === 1 && !m.score2 }) +
      (m.statusText ? '<div class="rx-res-result">' + esc(teamName(m.statusText)) + '</div>' : '') +
      '<div class="rx-res-links"><a href="' + url + '#summary">Summary</a>' +
      '<a href="' + url + '#scorecard">Scorecard</a>' +
      '<a href="/' + esc(league) + '/">Series</a></div>' +
      '<a class="rx-card-link" href="' + url + '" aria-label="' + esc(label) + ': ' + esc(teamName(m.team1)) + ' vs ' + esc(teamName(m.team2)) + '"></a></div>';
  }
  function listCardHtml(m, league, state) {
    if (m.status === 'result') return listResultCardHtml(m, league, state);
    if (m.status === 'live') return listLiveCardHtml(m, league, state);
    /* Abandoned (M7): the feed carries no innings to render from, and
       the baked abandoned card is the authority — the poller never
       rewrites it (returning '' skips the card in reconcileList). */
    if (m.status === 'abandoned') return '';
    return listUpcomingCardHtml(m, league, state);
  }
  /* A card's status, from its status pill: LIVE (is-live), upcoming,
     or result (plain). */
  function cardStatus(card) {
    var st = card.querySelector('.rx-res-status');
    if (!st) return 'result';
    if (st.classList.contains('is-live')) return 'live';
    if (st.classList.contains('upcoming')) return 'upcoming';
    return 'result';
  }
  /* Canonical list order (the baked order): live first, then upcoming,
     then results newest first. Re-appends only when the order actually
     differs, so a no-change poll never touches the DOM. */
  function reorderBox(box) {
    var cards = Array.prototype.slice.call(box.querySelectorAll('.rx-res-card'));
    var rank = { live: 0, upcoming: 1, result: 2 };
    var sorted = cards.slice().sort(function (a, b) {
      var sa = cardStatus(a), sb = cardStatus(b);
      if (rank[sa] !== rank[sb]) return rank[sa] - rank[sb];
      var na = parseInt(a.getAttribute('data-match-no') || '0', 10);
      var nb = parseInt(b.getAttribute('data-match-no') || '0', 10);
      return (sa === 'result') ? (nb - na) : (na - nb);
    });
    var same = cards.length === sorted.length && cards.every(function (c, i) { return c === sorted[i]; });
    if (same) return false;
    sorted.forEach(function (c) { box.appendChild(c); });
    return true;
  }
  /* Reconcile one league's Live-tab box with the feed: update each card
     the feed carries (in place, only when the markup differs), insert a
     result the list lacks (at the front of the results), and re-order
     the box when a card's status changed (a live card that finished
     moves to the results; an upcoming card that went live moves to the
     front). Cards the feed does not carry are left exactly as baked.
     The TBA guard: a "TBA vs TBA" feed entry never overwrites the baked
     card. Two presentation bits are the baked card's, not the poller's,
     and are carried over before comparing: the fixture order in
     data-teams (the feed's team order differs — M28's feed lists KAG
     first, the fixture POA first) and the upcoming status pill (the
     league badge format is the league builder's — ILT20 bakes
     "SAT, 21 NOV · EVENING", the poller's generic badge would say
     "SATURDAY · 6:30 PM"). The comparison is outerHTML-to-outerHTML
     on a parsed node, never string-to-outerHTML: the browser serialises
     "&middot;" as the literal "·", so a string comparison would fail
     on every card, every poll, and rewrite the whole list every 30
     seconds. Returns true when anything changed (so the caller knows
     to rebuild the Schedule + Results views). */
  function reconcileList(league, feedMatches, state, schedule) {
    var box = schedule || document.querySelector('#tab-live .rx-res-box[data-league="' + league + '"] .rx-res-grid');
    if (!box) return false;
    var changed = false;
    var byNo = {};
    (feedMatches || []).forEach(function (m) { byNo[m.matchNo] = m; });
    var cards = box.querySelectorAll('.rx-res-card');
    for (var i = 0; i < cards.length; i++) {
      var no = parseInt(cards[i].getAttribute('data-match-no') || '0', 10);
      var m = byNo[no];
      if (!m || (schedule && m.status === 'upcoming')) continue;
      if (m.status === 'upcoming' && (teamName(m.team1) === 'TBA' || teamName(m.team2) === 'TBA')) continue;
      var fresh = listCardHtml(m, league, state);
      if (!fresh) continue;
      var tmp = document.createElement('div');
      tmp.innerHTML = fresh;
      var node = tmp.firstChild;
      if (!node) continue;
      node.setAttribute('data-teams', cards[i].getAttribute('data-teams') || node.getAttribute('data-teams'));
      var oldSt = cards[i].querySelector('.rx-res-status');
      var newSt = node.querySelector('.rx-res-status');
      if (oldSt && newSt && oldSt.classList.contains('upcoming') && newSt.classList.contains('upcoming')) {
        newSt.innerHTML = oldSt.innerHTML;
      }
      if (node.outerHTML !== cards[i].outerHTML) { cards[i].outerHTML = node.outerHTML; changed = true; }
    }
    if (schedule) return changed;
    var have = {};
    box.querySelectorAll('.rx-res-card').forEach(function (c) { have[parseInt(c.getAttribute('data-match-no') || '0', 10)] = true; });
    var missing = (feedMatches || []).filter(function (mm) { return mm.status === 'result' && !have[mm.matchNo]; })
      .sort(function (a, b) { return b.matchNo - a.matchNo; });
    missing.forEach(function (mm) {
      var html = listCardHtml(mm, league, state);
      if (!html) return;
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var node = tmp.firstChild;
      if (!node) return;
      /* The front of the results = before the first existing result
         card (newest first); if the box has no result yet, the end. */
      var anchor = null;
      var all = box.querySelectorAll('.rx-res-card');
      for (var k = 0; k < all.length; k++) {
        if (cardStatus(all[k]) === 'result') { anchor = all[k]; break; }
      }
      if (anchor) box.insertBefore(node, anchor);
      else box.appendChild(node);
      changed = true;
    });
    if (reorderBox(box)) changed = true;
    return changed;
  }

  /* ---- the live-scores page panel ---- */
  function renderPanel(data, ilt20Data, state) {
    var pts = state ? pointsToRender(state, data.matches || []) : null;
    if (pts) renderRankings(pts);
    renderRecords(state);
    renderLeaders(state);
    var changed = false;
    changed = reconcileList('npl', data.matches || [], state) || changed;
    if (ilt20Data) changed = reconcileList('ilt20', ilt20Data.matches || [], state) || changed;
    if (changed && window.sialtvRebuildTabViews) window.sialtvRebuildTabViews();
    return pick((data && data.matches) || []);
  }

  function boot() {
    var results = document.querySelector('[data-league-results]');
    var schedule = document.querySelector('[data-league-schedule]');
    if (results || schedule) {
      var league = results ? results.dataset.leagueResults : schedule.dataset.leagueSchedule;
      function updateLeaguePage() {
        if (document.hidden) return;
        sialtvScores(league).then(function (data) {
          if (schedule) {
            reconcileList(league, data.matches, null, schedule);
            return;
          }
          var rows = data.matches.filter(function (m) {
            return m.status === 'result' && Number.isSafeInteger(m.matchNo) && m.matchNo > 0;
          }).sort(function (a, b) { return b.matchNo - a.matchNo; }).map(function (m) {
            var scores = [1, 2].map(function (side) {
              return [teamName(m['team' + side]), m['score' + side]].filter(Boolean).join(' ');
            }).join(' · ');
            return '<tr><td><a href="' + matchUrl(league, m.matchNo) + '">Match ' + m.matchNo +
              '</a></td><td>' + esc(scores) + '</td><td>' + esc(m.statusText) + '</td></tr>';
          });
          if (rows.length) setHtml(results, rows.join(''));
        });
      }
      updateLeaguePage();
      setInterval(updateLeaguePage, POLL_MS);
      document.addEventListener('visibilitychange', updateLeaguePage);
    }
    var panel = document.getElementById('tab-live');
    if (!panel) return;
    function load() {
      if (document.hidden) return;
      /* The NPL feed drives the list; the ILT20 feed drives its list
         box; the state file drives rankings, records and the Quick
         Links note. Each fetch fails soft, so one dead source never
         blocks the other two. */
      var nplP = sialtvScores('npl').catch(function () { return null; });
      var iltP = sialtvScores('ilt20').catch(function () { return null; });
      var stP = fetchState(false);
      Promise.all([nplP, iltP, stP]).then(function (all) {
        var data = all[0], ilt = all[1], state = all[2];
        if (data && data.matches && data.matches.length) { renderPanel(data, ilt, state); }
      }).catch(function () {});
    }
    load();
    setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
