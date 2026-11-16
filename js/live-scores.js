/* SialTV live scores — shared feed + live-scores page panel.
   One shared fetch (window.sialtvScores): the PHP endpoint first, the
   committed static snapshot second, never a broken panel. The browser
   polls every 30 seconds, skips work while the tab is hidden, and
   refreshes at once when the tab becomes visible again. Every fetch
   uses {cache: "no-store"} so a stale Hostinger copy is never trusted.
   The static snapshot only changes when the match-day flow pushes a
   new one, so a poll that finds the same file is cheap and harmless.
   Freshness is always shown from the feed's fetchedAt: a score that is
   ten minutes old is shown as ten minutes old, never as ball-by-ball.
   STRIP UNIFY (2026-11-15): the PHP endpoint only returns the current
   window (live + next upcoming) — a finished match falls out of it
   within hours, so a stale baked strip card could never flip to its
   result (flash-scores.js skips cards the feed does not carry). The
   merge below rides recent results from the static snapshot along with
   the live payload, so the strip, the hero and the live-scores panel
   all see the last 7 days of results on every poll, with no re-bake.
   The PHP endpoint itself is untouched. */
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
     written, never the browser's serialisation. */
  function setText(el, txt) { if (el && el.textContent !== txt) el.textContent = txt; }
  function setHtml(el, html) { if (el && el._html !== html) { el.innerHTML = html; el._html = html; } }
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

  /* "Updated 10 November 2026, 9:35 PM NST (3:50 PM UTC)" — both zones,
     so nobody has to guess which clock the time belongs to. */
  function fmtUpdated(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      var nst = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
      var utc = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
      return 'Updated ' + nst + ' NST (' + utc + ' UTC)';
    } catch (e) { return 'Updated ' + iso; }
  }
  window.sialtvFmtUpdated = fmtUpdated;

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
     treat it as no overs, so the side shows "yet to bat" instead of a
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
     shows "yet to bat", never a bare name or "( ov)". */
  function teamRow(team, abbr, pre, score, opts) {
    opts = opts || {};
    var img = logoImg(team);
    var chip = img || '<span class="ls-code" aria-hidden="true">' + esc(abbr || '') + '</span>';
    var dot = opts.batting ? '<span class="ls-bat" aria-hidden="true"></span>' : '';
    var row = '<div class="rx-res-team' + (opts.loser ? ' is-loser' : '') + '">' + chip + dot +
      '<span class="rx-tname"><b>' + esc(teamName(team)) + '</b></span>';
    if (opts.yetToBat) row += '<span class="rx-tpre">yet to bat</span>';
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
         the other bats shows "yet to bat". */
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
      return html + '</article>';
    }
    /* upcoming */
    var badge = fmtHead(m.date) ? esc(fmtHead(m.date).toUpperCase()) : 'UPCOMING';
    return open + '<div class="rx-res-status upcoming">' + badge + '</div>' +
      '<div class="rx-res-desc">' + descLine(m, league) + '</div>' +
      teamRow(m.team1, m.abbr1, '', '', {}) + teamRow(m.team2, m.abbr2, '', '', {}) +
      '<div class="rx-res-result is-upcoming">Match yet to begin</div>' +
      '<div class="rx-res-links"><a href="' + href + '#summary">Summary</a>' +
      '<a href="' + href + '#scorecard">Scorecard</a>' +
      '<a href="/' + esc(league) + '/">Series</a></div></article>';
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
  var LEAGUE_HEADS = { npl: 'Nepal Premier League 2026', ilt20: 'ILT20 2026-27', apl: 'Afghanistan Premier League 2026-27' };
  function dateGroupHtml(iso, league, cardsHtml) {
    var head = LEAGUE_HEADS[league] || LEAGUE_NAMES[league] || leagueTag(league);
    return '<div class="rx-date-group" id="date-' + esc(iso) + '" data-date="' + esc(iso) + '">' +
      '<div class="rx-date-pill"><span>' + esc(fmtHead(iso)) + '</span></div>' +
      '<div class="rx-res-box" data-league="' + esc(league) + '">' +
      '<h2 class="rx-res-boxhead"><a href="/' + esc(league) + '/">' + esc(head) + ' &rsaquo;</a>' +
      '<a class="rx-seeall" href="/' + esc(league) + '/">See all</a></h2>' +
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
      '</article>';
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

  /* ---- the live-scores page panel ---- */
  function renderPanel(panel, data) {
    var league = panel.getAttribute('data-league') || 'npl';
    var root = document.getElementById('liveScoreRoot');
    var fresh = document.getElementById('liveFreshness');
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
           each time, never re-rendered from the feed. */
        var baked = root && root.querySelector('.rx-res-card[data-match-no="' + p.next.matchNo + '"]');
        if (baked) html += baked.outerHTML;
      } else html += cardHtml(p.next, league);
    }
    if (html && root) setHtml(root, html);
    if (fresh) {
      setText(fresh, (data.fetchedAt ? fmtUpdated(data.fetchedAt) : 'Last checked: 11 November 2026') +
        '. Scores refresh roughly every ten minutes while a match is on — a ten-minute-old score is shown as ten minutes old, never as ball-by-ball.');
    }
    if (results) {
      var done = (data.matches || []).filter(function (m) { return m.status === 'result'; })
        .sort(function (a, b) { return b.matchNo - a.matchNo; });
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
        var sig = done.map(function (m) { return m.matchNo + ':' + (m.score1 || '') + '-' + (m.score2 || ''); }).join('|');
        if (results.getAttribute('data-feed-sig') !== sig) {
          results.setAttribute('data-feed-sig', sig);
          var kept = [];
          var cards = results.querySelectorAll('.rx-res-card');
          for (var i = 0; i < cards.length; i++) {
            var no = parseInt(cards[i].getAttribute('data-match-no') || '0', 10);
            var inFeed = false;
            for (var j = 0; j < done.length; j++) if (done[j].matchNo === no) inFeed = true;
            if (!inFeed) kept.push(cards[i].outerHTML);
          }
          var all = done.map(function (m) { return resultItem(m, league); }).concat(kept);
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
    return p;
  }


  /* Sidebar "Live now — Match N" (live-scores pages): the baked line
     freezes at the bake ("Kathmandu yet to bat") while the match moves
     on. Update it from the same feed as the live centre, on every poll.
     The venue is kept from the baked line (the feed carries none). */
  function refreshSidebarLive(data) {
    /* Every sidebar card is updated from the feed entry for ITS OWN
       match — not just the live/latest one. When Match 24 finishes and
       Match 25 goes live, the Match 24 card must flip to its result
       instead of staying frozen on "yet to bat". */
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
    else if (m.status === 'live' && !m.score1 && m.score2) a = esc(teamName(m.team1)) + ' yet to bat';
    var b = esc(teamName(m.team2)) + ' ' + esc(m.score2 || '');
    if (m.score2 && hasOvers(m.overs2)) b += ' (' + esc(m.overs2) + ' ov)';
    else if (m.status === 'live' && !m.score2 && m.score1) b = esc(teamName(m.team2)) + ' yet to bat';
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
      sialtvScores(league).then(function (data) {
        if (data && data.matches && data.matches.length) { renderPanel(panel, data); refreshSidebarLive(data); }
      }).catch(function () {});
    }
    load();
    setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
