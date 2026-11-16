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
   also re-renders every section in place, Cricinfo-style — the
   series-list cards (NPL + ILT20), the flash row, the sidebar latest
   result / rankings / records, the featured centre — from the live
   feed the moment a result lands, and from /data/live-scores-state.json
   (the bake's authoritative snapshot: points, leaders, featured
   detail) whenever it changes. No reload, no flash, no spinner.
   Sections the feed cannot supply faithfully (points, records, the
   centre's prose + full tables) update from the state file, never from
   a guess. The points table is ALSO recomputed in the browser from the
   state's full results list the instant a league result lands
   (build_data.py rules, verified exact against the M28 table); the
   state file's points win whenever they differ. There is NO freshness
   clock line any more: it ticked on every poll because it was a clock,
   not data proof, and Cricinfo shows none — the in-place updates are
   the proof. The baked "Last updated: <date>" under the H1 stays. */
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

  function pick(matches) {
    var live = null, latest = null, next = null;
    (matches || []).forEach(function (m) {
      /* A pre-start live match is not live yet — no ball bowled — so
         it counts as the next match, not the live one. This also fixes
         hero-score.js / live-card.js (both use window.sialtvPick):
         pre-start no longer shows "Live now" there. */
      if (m.status === 'live' && isLiveNow(m)) live = m;
      if (m.status === 'result' && (!latest || m.matchNo > latest.matchNo)) latest = m;
      if ((m.status === 'upcoming' || (m.status === 'live' && !isLiveNow(m))) && (!next || m.matchNo < next.matchNo)) next = m;
    });
    return { live: live, latest: latest, next: next };
  }
  window.sialtvPick = pick;

  /* "Tue 17 Nov 2026" — the sidebar "Next:" line and the Quick Links
     note. Built from the same Intl call as fmtDateLong; the comma is
     stripped so it matches the baked label exactly. */
  function fmtDateLabel(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso + 'T00:00:00Z')).replace(',', '');
    } catch (e) { return iso; }
  }
  /* "5:00 PM" from a kickoff ISO — the sidebar "Next:" line. */
  function fmtTimeNst(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kathmandu', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
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

  /* ---- top cards (#liveScoreRoot): Cricinfo-style .rx-res-card, the same
     shape as the baked list cards — the old .today prose block is gone.
     A result reuses resultItem (identical to the baked result cards); a
     live match gets the LIVE badge, the batting side's red dot and the
     situation line; an upcoming match gets its start-day badge. */
  function descLine(m, league) {
    var seriesName = LEAGUE_NAMES[league] || leagueTag(league);
    return ordinal(m.matchNo) + ' Match, ' + esc(venueShort(m.venue)) + ', ' + esc(fmtDateLong(m.date)) +
      ' &middot; <a href="/' + esc(league) + '/">' + esc(seriesName) + '</a>';
  }
  /* One team row, shared by the live card and resultItem: logo (or the
     code chip when the logo map has no entry), optional batting dot,
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

  function cardHtml(m, league) {
    if (!m) return '';
    if (m.status === 'result') return resultItem(m, league);
    var href = matchUrl(league, m.matchNo);
    var open = '<article class="rx-res-card' + (m.status === 'live' ? ' is-live' : '') +
      '" data-match-no="' + m.matchNo + '" data-date="' + esc(m.date || '') +
      '" data-league="' + esc(league) + '">';
    if (m.status === 'live') {
      /* Batting side: the side with a second-innings score is batting;
         otherwise the side with a score is. A side with no score while
         the other bats shows "Yet to Bat". */
      var bat = m.score2 ? 2 : (m.score1 ? 1 : 0);
      var runs1 = parseInt(String(m.score1 || '').split('/')[0], 10) || 0;
      var maxov = (m.overs1 === '5' || m.overs1 === '5.0') ? '5' : '20';
      var pre1 = hasOvers(m.overs1) ? '(' + esc(m.overs1) + ' ov)' : '';
      var pre2 = hasOvers(m.overs2) ? '(' + esc(m.overs2) + '/' + maxov + ' ov, T:' + (runs1 + 1) + ')' : '';
      var html = open + '<div class="rx-res-status is-live">LIVE</div>' +
        '<div class="rx-res-desc">' + descLine(m, league) + '</div>' +
        teamRow(m.team1, m.abbr1, pre1, m.score1, { batting: bat === 1, yetToBat: bat === 2 && !m.score1 }) +
        teamRow(m.team2, m.abbr2, pre2, m.score2, { batting: bat === 2, yetToBat: bat === 1 && !m.score2 });
      if (m.statusText) html += '<div class="rx-res-result">' + esc(teamName(m.statusText)) + '</div>';
      html += '<div class="rx-res-links"><a href="' + href + '">Live Score</a>' +
        '<a href="' + href + '#scorecard">Scorecard</a>' +
        '<a href="/' + esc(league) + '/">Series</a></div>';
      if (m.toss) html += '<p class="note">' + esc(m.toss) + '</p>';
      /* Whole-card link (follow-up 2026-11-16): stretched link, like the
         baked cards — the card itself is a real anchor. */
      return html + '<a class="rx-card-link" href="' + href + '" aria-label="' +
        esc(ordinal(m.matchNo)) + ' Match: ' + esc(teamName(m.team1)) + ' vs ' +
        esc(teamName(m.team2)) + '"></a></article>';
    }
    /* upcoming */
    var badge = fmtHead(m.date) ? esc(fmtHead(m.date).toUpperCase()) : 'UPCOMING';
    return open + '<div class="rx-res-status upcoming">' + badge + '</div>' +
      '<div class="rx-res-desc">' + descLine(m, league) + '</div>' +
      teamRow(m.team1, m.abbr1, '', '', {}) + teamRow(m.team2, m.abbr2, '', '', {}) +
      '<div class="rx-res-result is-upcoming">Match yet to begin</div>' +
      '<div class="rx-res-links"><a href="' + href + '#summary">Summary</a>' +
      '<a href="' + href + '#scorecard">Scorecard</a>' +
      '<a href="/' + esc(league) + '/">Series</a></div>' +
      '<a class="rx-card-link" href="' + href + '" aria-label="' +
      esc(ordinal(m.matchNo)) + ' Match: ' + esc(teamName(m.team1)) + ' vs ' +
      esc(teamName(m.team2)) + '"></a></article>';
  }

  /* League tag for feed rows, Cricinfo-style: "Biratnagar Kings (NPL)". */
  var LEAGUE_TAG = { npl: 'NPL', ilt20: 'ILT20', apl: 'APL', sa20: 'SA20', bbl: 'BBL', psl: 'PSL' };
  function leagueTag(league) { return LEAGUE_TAG[league] || String(league || '').toUpperCase(); }

  /* ---- results cards (.rx-res-card, shared with the results page) ---- */
  function ordinal(n) {
    n = parseInt(n, 10) || 0;
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function fmtDateLong(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso + 'T00:00:00Z'));
    } catch (e) { return iso; }
  }
  /* Date pill, identical to the baked pills: "Fri, 13 Nov" (Intl's
     en-GB short form has no comma, so the comma is added here). */
  function fmtHead(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso + 'T00:00:00Z');
      var wd = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', weekday: 'short' }).format(d);
      var dm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'short' }).format(d);
      return wd + ', ' + dm;
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
     Royals"); the img carries no alt, so one is added here. Falls back to
     the 3-letter code chip used by the baked cards. */
  function logoImg(team) {
    var key = teamName(team);
    if (window.sialtvTeamLogos && window.sialtvTeamLogos[key]) {
      return window.sialtvTeamLogos[key].replace('<img ', '<img alt="' + esc(key) + ' logo" ');
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
  /* Results-tab date group (follow-up 2026-11-16): the H2 is the DATE,
     not the repeated series name — the series name already lives in each
     card's desc line. Mirrors cards.py date_group(). */
  function dateGroupHtml(iso, league, cardsHtml) {
    return '<div class="rx-date-group" id="date-' + esc(iso) + '" data-date="' + esc(iso) + '">' +
      '<div class="rx-date-pill"><span>' + esc(fmtHead(iso)) + '</span></div>' +
      '<div class="rx-res-box" data-league="' + esc(league) + '">' +
      '<h2 class="rx-res-boxhead">' + esc(fmtDateLong(iso)) + '</h2>' +
      '<div class="rx-res-grid">' + cardsHtml + '</div></div></div>';
  }

  /* One result card, identical in structure to the baked cards on the
     live-scores and results pages: status pill, match-info line, two team
     rows (winner first), result line, links. The target goes on the
     chaser's row and is always first-innings runs + 1. */
  function resultItem(m, league) {
    var href = matchUrl(league, m.matchNo);
    var desc = descLine(m, league);
    /* Batting order comes from scorecard.innings — the feed's team1 /
       team2 order is NOT batting order (M22: team1 is the chaser BIK;
       M24: team1 is the chaser KAG). Fall back to team1 first. */
    var inn = (m.scorecard && m.scorecard.innings) || [];
    var firstIdx = 0;
    if (inn.length && teamName(inn[0].team) === teamName(m.team2)) firstIdx = 1;
    var firstTeam = firstIdx === 0 ? m.team1 : m.team2;
    var firstAbbr = firstIdx === 0 ? m.abbr1 : m.abbr2;
    var firstScore = firstIdx === 0 ? m.score1 : m.score2;
    var firstOvers = firstIdx === 0 ? m.overs1 : m.overs2;
    var chTeam = firstIdx === 0 ? m.team2 : m.team1;
    var chAbbr = firstIdx === 0 ? m.abbr2 : m.abbr1;
    var chScore = firstIdx === 0 ? m.score2 : m.score1;
    var chOvers = firstIdx === 0 ? m.overs2 : m.overs1;
    var firstRuns = parseInt(String(firstScore || '').split('/')[0], 10) || 0;
    var maxov = (firstOvers === '5' || firstOvers === '5.0') ? '5' : '20';
    var preFirst = '(' + esc(firstOvers || '') + ' ov)';
    var preCh = '(' + esc(chOvers || '') + '/' + maxov + ' ov, T:' + (firstRuns + 1) + ')';
    var w = winnerSide(m);
    var winnerIsFirst = (w === 0 && firstIdx === 0) || (w === 1 && firstIdx === 1);
    var rowFirst = teamRow(firstTeam, firstAbbr, preFirst, firstScore, { loser: w !== -1 && !winnerIsFirst });
    var rowCh = teamRow(chTeam, chAbbr, preCh, chScore, { loser: w !== -1 && winnerIsFirst });
    var rows = (w === -1 || winnerIsFirst) ? rowFirst + rowCh : rowCh + rowFirst;
    return '<article class="rx-res-card" data-match-no="' + m.matchNo + '" data-date="' + esc(m.date || '') +
      '" data-league="' + esc(league) + '">' +
      '<div class="rx-res-status">RESULT</div>' +
      '<div class="rx-res-desc">' + desc + '</div>' + rows +
      '<div class="rx-res-result">' + esc(teamName(m.statusText || '')) + '</div>' +
      '<div class="rx-res-links"><a href="' + href + '#summary">Summary</a>' +
      '<a href="' + href + '#scorecard">Scorecard</a><a href="/' + esc(league) + '/">Series</a></div>' +
      '<a class="rx-card-link" href="' + href + '" aria-label="' +
      esc(ordinal(m.matchNo)) + ' Match: ' + esc(teamName(m.team1)) + ' vs ' +
      esc(teamName(m.team2)) + '"></a></article>';
  }

  /* ---- tabs (Summary / Scorecard / Overs) ---- */
  function wireTabs(panel) {
    var btns = panel.querySelectorAll('[data-slp-tab]');
    if (!btns.length) return;
    function show(name) {
      btns.forEach(function (b) {
        b.setAttribute('aria-selected', b.getAttribute('data-slp-tab') === name ? 'true' : 'false');
      });
      panel.querySelectorAll('[data-slp-panel]').forEach(function (p) {
        p.hidden = p.getAttribute('data-slp-panel') !== name;
      });
    }
    btns.forEach(function (b) {
      b.addEventListener('click', function () { show(b.getAttribute('data-slp-tab')); });
    });
    show('summary');
  }

  /* ================= FULL AUTO-UPDATE (2026-11-16) =================
     The poller above keeps the live card and the Results tab fresh.
     Everything else on the page used to change only on a bake — the
     series-list cards, the flash row, the sidebar latest result /
     rankings / records, the featured centre. The sections below close
     that gap, Cricinfo-style: they re-render in place from fresh data,
     with no reload, no flash, no spinner. Two sources, each used for
     what it is good at:
     - the LIVE FEED (30s poll) — the instant trigger. A result landing
       in the feed flips the list cards, the flash row, the sidebar
       latest result and the Results tab at once, and the points table
       recomputes from the state's full results list (below).
     - the STATE FILE (/data/live-scores-state.json, 120s TTL) — the
       bake's authoritative snapshot: points, rankings, leaders,
       featured detail (summary prose + full tables). The bake writes
       it as step 4a2, right after re-baking the page (step 4c), so a
       push carries both. Sections the feed cannot supply faithfully
       (points, records, the centre's prose + tables) update from the
       state file, never from a guess. The state file's points WIN
       whenever they differ from the browser recompute — the recompute
       is only the instant bridge until the next state file lands.
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
      if (d && d.points && d.results && d.featured) { stateCache = { at: Date.now(), data: d }; return d; }
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
  /* Centre points-table rows, byte-identical in shape to build.py's
     match_centre(): plain <td>s, negatives as &minus;. */
  function pointsRowsHtml(rows) {
    return rows.map(function (r) {
      var nrr = String(r.nrr_display || '').replace(/^-/, '&minus;');
      return '<tr><td>' + r.rank + '</td><td>' + esc(r.name) + '</td><td>' + r.played + '</td><td>' + r.points + '</td><td>' + nrr + '</td></tr>';
    }).join('');
  }

  /* ---- sidebar: rankings, records, Quick Links, latest result ---- */
  function sidebarCardByLink(hrefPart) {
    var links = document.querySelectorAll('.side-card h3 a');
    for (var i = 0; i < links.length; i++) {
      if ((links[i].getAttribute('href') || '').indexOf(hrefPart) !== -1) return links[i].closest('.side-card');
    }
    return null;
  }
  function renderRankings(pts) {
    if (!pts || !pts.rows || !pts.rows.length) return;
    var card = sidebarCardByLink('/npl/points-table/');
    if (!card) return;
    var leader = pts.rows[0];
    var line = card.querySelector('p');
    if (line) setText(line, leader.name + ' lead the NPL on ' + leader.points + ' points after Match ' + pts.after_match + '.');
    var ul = card.querySelector('ul');
    if (ul) setHtml(ul, pts.rows.slice(0, 4).map(function (r) {
      return '<li><span>' + r.rank + '. ' + esc(r.name) + ' &mdash; ' + r.points + ' pts</span></li>';
    }).join(''));
  }
  function renderRecords(state) {
    if (!state || !state.leaders || !state.leaders.records_line) return;
    var card = sidebarCardByLink('/npl/stats/');
    if (!card) return;
    var span = card.querySelector('li a[href="/npl/stats/"] + span');
    /* setHtml, not setText: the line carries &middot; / &amp; entities,
       exactly as the baked page renders them. The values are identical
       to the baked line; the order follows the stats system's canonical
       order (the generator is the authority — G7), so the first state
       file reorders the tied bowlers once, then never again. */
    if (span) setHtml(span, state.leaders.records_line);
  }
  function renderQuickNpl(state) {
    if (!state || !state.next || !state.next.date || !state.next.stage_short) return;
    var li = document.querySelector('.side-card a[href="/npl/"]');
    if (!li) return;
    var span = li.parentNode.querySelector('span');
    if (span) setText(span, 'Next match ' + fmtHead(state.next.date).replace(',', '') + ', ' + state.next.stage_short + '.');
  }
  function renderLatest(feedMatches, state) {
    var p = pick(feedMatches || []);
    var latest = p.latest;
    if (!latest) return;
    /* The latest-result card is the ONLY sidebar card whose heading
       links to a match page — find it by that link, not by its heading
       text: refreshSidebarLive rewrites the heading to "Result —
       Match N" on the first poll, so "Latest result" no longer matches. */
    var card = null;
    var links = document.querySelectorAll('.side-card h3 a[href*="/match-"]');
    if (links.length) card = links[0].closest('.side-card');
    if (!card) return;
    var current = card.querySelector('h3 a');
    var currentNo = current ? parseInt((current.getAttribute('href') || '').match(/match-(\d+)\//) ? (current.getAttribute('href').match(/match-(\d+)\//))[1] : '0', 10) : 0;
    if (currentNo === latest.matchNo) return; /* refreshSidebarLive owns the line while the match stays latest */
    var url = matchUrl('npl', latest.matchNo);
    var status = teamName(latest.statusText || '');
    var next = p.next;
    var nextLine = '';
    if (next) {
      nextLine = '\n        <p class="note">Next: ' + esc(teamName(next.team1)) + ' vs ' + esc(teamName(next.team2)) +
        ', Match ' + next.matchNo + ', ' + fmtDateLabel(next.date) + ', ' + fmtTimeNst(next.kickoffIso) + ' NST.</p>';
    } else if (state && state.next) {
      nextLine = '\n        <p class="note">Next: ' + esc(state.next.teams) +
        ', Match ' + state.next.match_no + ', ' + esc(state.next.date_label) + ', ' + esc(state.next.time_nst) + ' NST.</p>';
    }
    /* The post-poll form, exactly as refreshSidebarLive leaves it: the
       heading is "Result — Match N" and the scores line IS the result
       text (that is the live behaviour today, not the baked form). */
    setHtml(card, '\n        <h3><a href="' + esc(url) + '">Result &mdash; Match ' + latest.matchNo + '</a></h3>\n' +
      '        <p>' + esc(status) + '</p>\n' +
      '        <p class="note"><a href="' + esc(url) + '">' + esc(status) + ' &rsaquo;</a></p>' + nextLine + '\n      ');
  }

  /* ---- flash row: the latest 3 NPL results ---- */
  function flashCardHtml(m) {
    var w = winnerSide(m);
    if (w < 0) return '';
    var win = w === 0 ? { team: m.team1, score: m.score1, overs: m.overs1 } : { team: m.team2, score: m.score2, overs: m.overs2 };
    var lose = w === 0 ? { team: m.team2, score: m.score2, overs: m.overs2 } : { team: m.team1, score: m.score1, overs: m.overs1 };
    var wl = logoImgBaked(win.team), ll = logoImgBaked(lose.team);
    if (!wl || !ll) return ''; /* a logoless flash card is worse than the baked one */
    return '<a class="score-card" data-kind="result" data-match-no="' + m.matchNo + '" href="' + esc(matchUrl('npl', m.matchNo)) + '">\n' +
      '        <p class="sc-label">Result</p>\n' +
      '        <p class="sc-match">Match ' + m.matchNo + ' &middot; NPL &middot; Kirtipur</p>\n' +
      '        <p class="sc-row loser"><span class="sc-team">' + ll + esc(teamName(lose.team)) + '</span><span class="sc-score">' + esc(lose.score) + ' (' + esc(lose.overs) + ' ov)</span></p>\n' +
      '        <p class="sc-row"><span class="sc-team">' + wl + esc(teamName(win.team)) + '</span><span class="sc-score">' + esc(win.score) + ' (' + esc(win.overs) + ' ov)</span></p>\n' +
      '        <p class="sc-result">' + esc(teamName(m.statusText || '')) + '</p>\n' +
      '        </a>';
  }
  function renderFlash(feedMatches) {
    var flash = document.getElementById('sialtvFlash');
    if (!flash) return;
    var done = (feedMatches || []).filter(function (m) { return m.status === 'result'; })
      .sort(function (a, b) { return b.matchNo - a.matchNo; }).slice(0, 3);
    if (done.length < 3) return;
    var cards = done.map(function (m) { return flashCardHtml(m); });
    if (cards.indexOf('') !== -1) return;
    setHtml(flash, cards.join('\n        '));
  }

  /* ---- featured centre (from the state file) ----
     Mirrors build.py's match_centre() exactly: the same H3s, the same
     table shapes, the same notes. The fields come from the bake's own
     state file — the same trusted source as the baked page — so they
     are rendered unescaped, exactly as the builder does. */
  function batTableHtml(rows, kind) {
    var head = kind === 'bat'
      ? '<thead><tr><th>Batter</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th class="num">SR</th></tr></thead>'
      : '<thead><tr><th>Bowler</th><th class="num">O</th><th class="num">M</th><th class="num">R</th><th class="num">W</th><th class="num">Econ</th></tr></thead>';
    var body = rows.map(function (r) {
      return '<tr>' + r.map(function (c, i) {
        return i ? '<td class="num">' + c + '</td>' : '<td>' + c + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<div class="table-scroll slp-tables"><table>\n          ' + head + '\n          <tbody>' + body + '</tbody>\n        </table></div>';
  }
  function summaryPanelHtml(f, pts) {
    return '\n        <h3>Match ' + f.match_no + ' &mdash; innings summary</h3>\n' +
      '        <p>' + f.summary + '</p>\n' +
      '        <h3>Points after Match ' + f.match_no + '</h3>\n' +
      '        <div class="table-scroll"><table class="t-pts">\n' +
      '          <thead><tr><th>#</th><th>Team</th><th>P</th><th>Pts</th><th>NRR</th></tr></thead>\n' +
      '          <tbody>\n            ' + pointsRowsHtml(pts.rows) + '\n          </tbody>\n' +
      '        </table></div>\n' +
      '        <p class="note">A win is worth 2 points; the top four qualify for the playoffs. The full table is on the <a href="/npl/points-table/">NPL Points Table</a> page.</p>\n      ';
  }
  function scorecardPanelHtml(f) {
    return '\n        <h3>' + f.team1 + ' &mdash; ' + f.score1 + ' (' + f.overs1 + ' ov)</h3>\n' +
      '        ' + batTableHtml(f.batting1, 'bat') + '\n' +
      '        ' + batTableHtml(f.bowling1, 'bowl') + '\n' +
      '        <h3>' + f.team2 + ' &mdash; ' + f.score2 + ' (' + f.overs2 + ' ov)</h3>\n' +
      '        ' + batTableHtml(f.batting2, 'bat') + '\n' +
      '        ' + batTableHtml(f.bowling2, 'bowl') + '\n' +
      '        <p class="note">These are the verified headline figures from Match ' + f.match_no + ' &mdash; top scorers and wicket-takers from the match feed.</p>\n      ';
  }
  /* The centre's summary is always the latest finished match (the state
     file's featured); the scorecard and overs panels follow the LIVE
     match while one is on — the existing code above owns them then —
     and fall back to the featured match when no match is live. */
  function renderCentre(state, pts, liveMatch) {
    var f = state && state.featured;
    if (!f || !pts) return;
    var h2 = document.querySelector('#slpCentre h2');
    if (h2) setText(h2, 'Featured match \u2014 Match ' + f.match_no);
    var summary = document.querySelector('#slpCentre [data-slp-panel="summary"]');
    if (summary) setHtml(summary, summaryPanelHtml(f, pts));
    var scorecard = document.getElementById('slp-scorecard');
    if (scorecard && !liveMatch) setHtml(scorecard, scorecardPanelHtml(f));
    var overs = document.getElementById('slp-overs');
    if (overs && !liveMatch) {
      var p = overs.querySelector('p');
      if (p) setText(p, 'Over-by-over balls are not published for Match ' + f.match_no + ' on this page.');
    }
    var full = document.querySelector('#slpCentre > p.note > a');
    if (full && full.getAttribute('href') !== '/npl/matches/2026/match-' + f.match_no + '/')
      full.setAttribute('href', '/npl/matches/2026/match-' + f.match_no + '/');
  }

  /* ---- series-list cards (the Live tab's per-league boxes) ----
     Mirrors cards.py's result_card / upcoming_card in the baked <div>
     shape (data-format / data-gender / data-teams / overlay), with the
     live branch taken from cardHtml. The logo helper appends the alt
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
      return window.sialtvTeamLogos[key].replace(/>$/, ' alt="' + esc(key) + ' logo">');
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
  function chaserTpre(ov, target) {
    return ov !== '20' ? '(' + ov + '/20 ov, T:' + target + ')' : '(20 ov, T:' + target + ')';
  }
  function listDescLine(m, league, state) {
    var label = stageLabelFor(m.matchNo, league, state) || (ordinal(m.matchNo) + ' Match');
    var seriesName = LEAGUE_NAMES[league] || leagueTag(league);
    return label + ', ' + esc(venueShort(m.venue)) + ', ' + esc(fmtDateLong(m.date)) +
      ' &middot; <a href="/' + esc(league) + '/">' + esc(seriesName) + '</a>';
  }
  function listResultCardHtml(m, league, state) {
    var w = winnerSide(m);
    if (w < 0) return '';
    var win = w === 0 ? { team: m.team1, abbr: m.abbr1, score: m.score1, overs: m.overs1 } : { team: m.team2, abbr: m.abbr2, score: m.score2, overs: m.overs2 };
    var lose = w === 0 ? { team: m.team2, abbr: m.abbr2, score: m.score2, overs: m.overs2 } : { team: m.team1, abbr: m.abbr1, score: m.score1, overs: m.overs1 };
    var label = stageLabelFor(m.matchNo, league, state) || (ordinal(m.matchNo) + ' Match');
    var url = matchUrl(league, m.matchNo);
    var winChased = w === 1;
    var firstOvers = winChased ? lose.overs : win.overs;
    var maxov = (firstOvers === '5' || firstOvers === '5.0') ? '5' : '20';
    var winTpre, loseTpre;
    if (winChased) {
      winTpre = '(' + win.overs + '/' + maxov + ' ov, T:' + (parseInt(String(lose.score).split('/')[0], 10) + 1) + ')';
      loseTpre = '(' + lose.overs + ' ov)';
    } else {
      winTpre = '(' + win.overs + ' ov)';
      loseTpre = '(' + lose.overs + '/' + maxov + ' ov, T:' + (parseInt(String(win.score).split('/')[0], 10) + 1) + ')';
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
    try { wd = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', weekday: 'long' }).format(new Date((m.date || '') + 'T00:00:00Z')).toUpperCase(); } catch (e) { wd = 'UPCOMING'; }
    var badge = (wd || 'UPCOMING') + ' &middot; ' + esc(fmtTimeNst(m.kickoffIso) || '');
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
    var pre2 = hasOvers(m.overs2) ? '(' + esc(m.overs2) + '/' + maxov + ' ov, T:' + (runs1 + 1) + ')' : '';
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
    return listUpcomingCardHtml(m, league, state);
  }
  /* Reconcile one league's Live-tab box with the feed: update each card
     the feed carries (in place, only when the markup differs), and
     insert a result the list lacks — after the last result card, before
     the first upcoming card. Cards the feed does not carry are left
     exactly as baked. The TBA guard from renderPanel applies here too:
     a "TBA vs TBA" feed entry never overwrites the baked card. */
  function reconcileList(league, feedMatches, state) {
    var box = document.querySelector('.rx-res-box[data-league="' + league + '"] .rx-res-grid');
    if (!box) return;
    var byNo = {};
    (feedMatches || []).forEach(function (m) { byNo[m.matchNo] = m; });
    var cards = box.querySelectorAll('.rx-res-card');
    for (var i = 0; i < cards.length; i++) {
      var no = parseInt(cards[i].getAttribute('data-match-no') || '0', 10);
      var m = byNo[no];
      if (!m) continue;
      if (m.status === 'upcoming' && (teamName(m.team1) === 'TBA' || teamName(m.team2) === 'TBA')) continue;
      var fresh = listCardHtml(m, league, state);
      if (fresh && cards[i].outerHTML !== fresh) cards[i].outerHTML = fresh;
    }
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
      var anchor = null;
      var all = box.querySelectorAll('.rx-res-card');
      for (var k = 0; k < all.length; k++) {
        if (!all[k].getAttribute('data-date')) { anchor = all[k]; break; }
      }
      if (anchor) box.insertBefore(node, anchor);
      else box.appendChild(node);
    });
  }

  /* The TBA guard's baked-card cache (see renderPanel): the baked card
     is re-read once, then reused, so enhanceLogos() mutating it in
     place never rewrites the root. */
  var tbaCache = {};

  /* ---- the live-scores page panel ---- */
  function renderPanel(panel, data, ilt20Data, state) {
    var league = panel.getAttribute('data-league') || 'npl';
    var root = document.getElementById('liveScoreRoot');
    var results = document.getElementById('liveResults');
    var scorecard = document.getElementById('slp-scorecard');
    var overs = document.getElementById('slp-overs');
    var p = pick((data && data.matches) || []);
    var html = '';
    if (p.live) html += cardHtml(p.live, league);
    else if (p.latest) html += cardHtml(p.latest, league);
    if (p.next) {
      var nt1 = teamName(p.next.team1), nt2 = teamName(p.next.team2);
      if (nt1 === 'TBA' || nt2 === 'TBA') {
        /* ESPN still lists a qualifier as "TBA vs TBA" after the teams
           are decided — keep the baked next-match card (real teams from
           matches.json) instead of overwriting it with TBA. The baked
           card survives later polls too: it is re-read from the root
           each time, never re-rendered from the feed. The string is
           cached on first use: live-scores-tabs.js enhanceLogos()
           rewrites the baked card's chip into a logo img in place, so
           re-reading outerHTML on a later poll would change the string
           and rewrite the root for no visible reason. */
        var tkey = p.next.matchNo;
        if (!tbaCache[tkey]) {
          var baked = root && root.querySelector('.rx-res-card[data-match-no="' + tkey + '"]');
          if (baked) tbaCache[tkey] = baked.outerHTML;
        }
        if (tbaCache[tkey]) html += tbaCache[tkey];
      } else html += cardHtml(p.next, league);
    }
    if (html && root) setHtml(root, html);
    if (results) {
      var done = (data.matches || []).filter(function (m) { return m.status === 'result'; })
        .map(function (m) { return { m: m, league: league }; });
      if (ilt20Data) done = done.concat((ilt20Data.matches || []).filter(function (m) { return m.status === 'result'; })
        .map(function (m) { return { m: m, league: 'ilt20' }; }));
      done.sort(function (a, b) { return b.m.matchNo - a.m.matchNo; });
      if (done.length) {
        /* Merge, never shrink: the feed only carries the matches it
           knows about, while the baked list goes further back. Feed
           rows first (fresh), baked rows the feed lacks stay after. */
        /* Merge, never shrink: the feed only carries the matches it
           knows about, while the baked list goes further back. Feed
           cards first (fresh), baked cards the feed lacks stay after,
           regrouped by date so the Results tab keeps its date groups.
           The signature skips the rebuild when the feed result set is
           unchanged, so a poll cycle never re-renders identical cards. */
        var sig = done.map(function (d) { return d.league + d.m.matchNo + ':' + (d.m.score1 || '') + '-' + (d.m.score2 || ''); }).join('|');
        if (results.getAttribute('data-feed-sig') !== sig) {
          results.setAttribute('data-feed-sig', sig);
          var kept = [];
          var cards = results.querySelectorAll('.rx-res-card');
          for (var i = 0; i < cards.length; i++) {
            var no = parseInt(cards[i].getAttribute('data-match-no') || '0', 10);
            var lg = cards[i].getAttribute('data-league') || league;
            var inFeed = false;
            for (var j = 0; j < done.length; j++) if (done[j].m.matchNo === no && done[j].league === lg) inFeed = true;
            if (!inFeed) kept.push(cards[i].outerHTML);
          }
          var all = done.map(function (d) { return resultItem(d.m, d.league); }).concat(kept);
          var groups = {};
          var order = [];
          all.forEach(function (html) {
            var dm = /data-date="([^"]+)"/.exec(html);
            var lm = /data-league="([^"]+)"/.exec(html);
            var key = (dm ? dm[1] : '') + '|' + (lm ? lm[1] : league);
            if (!groups[key]) { groups[key] = []; order.push(key); }
            groups[key].push(html);
          });
          var out = '';
          order.forEach(function (key) {
            var parts = key.split('|');
            out += dateGroupHtml(parts[0], parts[1], groups[key].join(''));
          });
          results.innerHTML = out;
        }
      }
    }
    var featured = p.live || p.latest;
    /* Scorecard and overs come from the feed only while a match is
       live. For a finished match the baked scorecard is authoritative
       (the post-match run writes it, with figures the feed's partial
       scorecard does not carry) — never overwrite it with less. */
    if (p.live && featured && scorecard && window.sialtvLiveTables) {
      var tables = window.sialtvLiveTables(featured);
      if (tables) setHtml(scorecard, tables);
    }
    if (p.live && featured && overs) {
      var tl = featured.overTimeline || [];
      if (tl.length && window.sialtvLiveTables && window.sialtvLiveOvers) {
        setHtml(overs, window.sialtvLiveOvers(featured));
      } else if (!tl.length) {
        setHtml(overs, '<p>Over-by-over balls are not published for Match ' + featured.matchNo + ' on this page.</p>');
      }
    }
    /* ---- full auto-update: every other section, in place ---- */
    renderFlash(data.matches || []);
    renderLatest(data.matches || [], state);
    renderQuickNpl(state);
    renderRecords(state);
    var pts = state ? pointsToRender(state, data.matches || []) : null;
    if (pts) renderRankings(pts);
    if (state && pts) renderCentre(state, pts, p.live);
    reconcileList('npl', data.matches || [], state);
    if (ilt20Data) reconcileList('ilt20', ilt20Data.matches || [], state);
    return p;
  }


  /* Sidebar "Live now — Match N" (live-scores pages): the baked line
     freezes at the bake ("Kathmandu Yet to Bat") while the match moves
     on. Update it from the same feed as the live centre, on every poll.
     The venue is kept from the baked line (the feed carries none). */
  function refreshSidebarLive(data) {
    /* Every sidebar card is updated from the feed entry for ITS OWN
       match — not just the live/latest one. When Match 24 finishes and
       Match 25 goes live, the Match 24 card must flip to its result
       instead of staying frozen on "Yet to Bat". */
    var byNo = {};
    (data.matches || []).forEach(function (m) { byNo[m.matchNo] = m; });
    var links = document.querySelectorAll('.side-card h3 a[href*="/match-"]');
    for (var i = 0; i < links.length; i++) {
      var mm = (links[i].getAttribute('href') || '').match(/match-(\d+)\//);
      if (!mm) continue;
      var m = byNo[parseInt(mm[1], 10)];
      if (!m || (m.status !== 'live' && m.status !== 'result')) continue;
      var card = links[i].closest('.side-card');
      if (!card) continue;
      var line = card.querySelector('p:not(.note)');
      if (m.status === 'live') {
        setText(links[i], 'Live now — Match ' + m.matchNo);
        if (line) setHtml(line, sidebarLiveLine(m, line));
      } else if (m.status === 'result') {
        setText(links[i], 'Result — Match ' + m.matchNo);
        if (line) setText(line, teamName(m.statusText || ''));
      }
    }
  }
  function sidebarLiveLine(m, line) {
    var a = esc(teamName(m.team1)) + ' ' + esc(m.score1 || '');
    if (m.score1 && hasOvers(m.overs1)) a += ' (' + esc(m.overs1) + ' ov)';
    else if (m.status === 'live' && !m.score1 && m.score2) a = esc(teamName(m.team1)) + ' Yet to Bat';
    var b = esc(teamName(m.team2)) + ' ' + esc(m.score2 || '');
    if (m.score2 && hasOvers(m.overs2)) b += ' (' + esc(m.overs2) + ' ov)';
    else if (m.status === 'live' && !m.score2 && m.score1) b = esc(teamName(m.team2)) + ' Yet to Bat';
    var venue = '';
    if (line) {
      var parts = (line.textContent || '').split('·');
      if (parts.length > 1) venue = ' &middot; ' + esc(parts[parts.length - 1].trim());
    }
    return '<b>' + esc(teamName(m.team1)) + ' vs ' + esc(teamName(m.team2)) + '</b><br>' + a + ' &middot; ' + b + venue;
  }

  function boot() {
    var panel = document.getElementById('livePanel');
    if (!panel) return;
    wireTabs(panel);
    /* The featured match centre moved below the series list (redesign
       2026-11-16) — its Summary/Scorecard/Overs tabs live in #slpCentre
       now, not inside #livePanel. */
    var centre = document.getElementById('slpCentre');
    if (centre) wireTabs(centre);
    /* Pre-season leagues have no feed yet: the baked panel is the whole
       truth, and the tabs are the only live behaviour. No fetch, no
       invented scores. */
    if (panel.getAttribute('data-mode') === 'preseason') return;
    var league = panel.getAttribute('data-league') || 'npl';
    function load() {
      if (document.hidden) return;
      /* The NPL feed drives the panel; the ILT20 feed drives its list
         box and Results-tab groups; the state file drives points,
         rankings, records and the centre. Each fetch fails soft, so
         one dead source never blocks the other two. */
      var nplP = sialtvScores(league).catch(function () { return null; });
      var iltP = sialtvScores('ilt20').catch(function () { return null; });
      var stP = fetchState(false);
      Promise.all([nplP, iltP, stP]).then(function (all) {
        var data = all[0], ilt = all[1], state = all[2];
        if (data && data.matches && data.matches.length) { renderPanel(panel, data, ilt, state); refreshSidebarLive(data); }
      }).catch(function () {});
    }
    load();
    setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
