/* SialTV live scores — shared feed + live-scores page panel.
   One shared fetch (window.sialtvScores): the PHP endpoint first, the
   committed static snapshot second, never a broken panel. The browser
   polls every 30 seconds, skips work while the tab is hidden, and
   refreshes at once when the tab becomes visible again. Every fetch
   uses {cache: "no-store"} so a stale Hostinger copy is never trusted.
   The static snapshot only changes when the match-day flow pushes a
   new one, so a poll that finds the same file is cheap and harmless.
   Freshness is always shown from the feed's fetchedAt: a score that is
   ten minutes old is shown as ten minutes old, never as ball-by-ball. */
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
        cache[league] = { at: Date.now(), data: d };
        return d;
      }
      throw new Error('empty live feed');
    }).catch(function () {
      var s = STATIC_FEED[league];
      if (!s) return { fetchedAt: '', source: 'none', matches: [] };
      return fetchJson(s).then(function (d) {
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

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  window.sialtvEsc = esc;

  function pick(matches) {
    var live = null, latest = null, next = null;
    (matches || []).forEach(function (m) {
      if (m.status === 'live') live = m;
      if (m.status === 'result' && (!latest || m.matchNo > latest.matchNo)) latest = m;
      if (m.status === 'upcoming' && (!next || m.matchNo < next.matchNo)) next = m;
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

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso + 'T00:00:00Z'));
    } catch (e) { return iso; }
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
     treat it as no overs, so the side shows "yet to bat" instead of a
     blank score followed by "(0 ov)". */
  function hasOvers(o) { return !!o && o !== '0' && o !== '0.0'; }

  function scoreLine(m) {
    if (!m) return '';
    if (m.status === 'upcoming') return esc(teamName(m.team1)) + ' vs ' + esc(teamName(m.team2));
    /* A team that has not batted yet shows "yet to bat", never a bare
       name and never "( ov)" — same as the strip and the hero. */
    var a = esc(teamName(m.team1)) + ' ' + esc(m.score1 || '');
    if (hasOvers(m.overs1)) a += ' <span>(' + esc(m.overs1) + ' ov)</span>';
    else if (m.status === 'live' && !m.score1 && m.score2) a = esc(teamName(m.team1)) + ' yet to bat';
    var b = esc(teamName(m.team2)) + ' ' + esc(m.score2 || '');
    if (hasOvers(m.overs2)) b += ' <span>(' + esc(m.overs2) + ' ov)</span>';
    else if (m.status === 'live' && !m.score2 && m.score1) b = esc(teamName(m.team2)) + ' yet to bat';
    return a + '<br>' + b;
  }

  function performersLine(m) {
    /* Headline figures from the feed scorecard, so a JS re-render keeps
       the same detail as the baked card (top scorer, best bowling). */
    if (!m.scorecard || !m.scorecard.innings) return '';
    var bits = [];
    m.scorecard.innings.forEach(function (inn) {
      var top = null, best = null;
      (inn.batting || []).forEach(function (b) {
        if (!top || (parseInt(b.runs, 10) || 0) > (parseInt(top.runs, 10) || 0)) top = b;
      });
      (inn.bowling || []).forEach(function (b) {
        if (!best || (parseInt(b.wickets, 10) || 0) > (parseInt(best.wickets, 10) || 0)) best = b;
      });
      if (top) bits.push(esc(top.name) + ' ' + esc(top.runs) + (top.balls ? ' (' + esc(top.balls) + ')' : ''));
      if (best) bits.push(esc(best.name) + ' ' + esc(best.wickets) + '/' + esc(best.runs));
    });
    return bits.length ? '<p class="note">' + bits.join(' &middot; ') + '.</p>' : '';
  }

  function cardHtml(m, label, league) {
    var html = '<div class="today">';
    html += '<p class="today-label">' + esc(label) + ' &middot; Match ' + m.matchNo + ' &middot; ' + esc(fmtDate(m.date)) + '</p>';
    html += '<strong><a href="' + matchUrl(league, m.matchNo) + '">' + scoreLine(m) + '</a></strong>';
    html += '<p>' + esc(teamName(m.statusText || '')) + (m.venue ? ' at ' + esc(m.venue) : '') + '.</p>';
    if (m.status === 'result') html += performersLine(m);
    if (m.toss) html += '<p class="note">' + esc(m.toss) + '</p>';
    html += '</div>';
    return html;
  }

  /* League tag for feed rows, Cricinfo-style: "Biratnagar Kings (NPL)". */
  var LEAGUE_TAG = { npl: 'NPL', ilt20: 'ILT20', apl: 'APL', sa20: 'SA20', bbl: 'BBL', psl: 'PSL' };
  function leagueTag(league) { return LEAGUE_TAG[league] || String(league || '').toUpperCase(); }

  function resultItem(m, league) {
    var tag = leagueTag(league);
    function side(team, score, overs) {
      var s = esc(teamName(team)) + ' (' + tag + ') ' + esc(score || '');
      if (hasOvers(overs)) s += ' (' + esc(overs) + ' ov)';
      return s;
    }
    return '<li class="ls-row"><a href="' + matchUrl(league, m.matchNo) + '">' +
      '<span class="ls-row-teams">' + side(m.team1, m.score1, m.overs1) + ' vs ' + side(m.team2, m.score2, m.overs2) + '</span>' +
      '<span class="ls-row-meta">Match ' + m.matchNo + ' &middot; ' + esc(tag) + ' &middot; ' + esc(fmtDate(m.date)) + (m.venue ? ' &middot; ' + esc(m.venue) : '') + '</span>' +
      '<span class="ls-row-status">' + esc(teamName(m.statusText || '')) + '</span>' +
      '</a></li>';
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
    if (p.live) html += cardHtml(p.live, 'Live now', league);
    else if (p.latest) html += cardHtml(p.latest, 'Latest result', league);
    if (p.next) html += cardHtml(p.next, 'Next match', league);
    if (html && root) root.innerHTML = html;
    if (fresh) {
      fresh.textContent = (data.fetchedAt ? fmtUpdated(data.fetchedAt) : 'Last checked: 11 November 2026') +
        '. Scores refresh roughly every ten minutes while a match is on — a ten-minute-old score is shown as ten minutes old, never as ball-by-ball.';
    }
    if (results) {
      var done = (data.matches || []).filter(function (m) { return m.status === 'result'; })
        .sort(function (a, b) { return b.matchNo - a.matchNo; });
      if (done.length) {
        /* Merge, never shrink: the feed only carries the matches it
           knows about, while the baked list goes further back. Feed
           rows first (fresh), baked rows the feed lacks stay after. */
        var kept = [];
        var items = results.querySelectorAll('li');
        for (var i = 0; i < items.length; i++) {
          var mm = /Match\s+(\d+)/.exec(items[i].textContent || '');
          var no = mm ? parseInt(mm[1], 10) : 0;
          var inFeed = false;
          for (var j = 0; j < done.length; j++) if (done[j].matchNo === no) inFeed = true;
          if (!inFeed) kept.push(items[i].outerHTML);
        }
        results.innerHTML = done.map(function (m) { return resultItem(m, league); }).join('') + kept.join('');
      }
    }
    var featured = p.live || p.latest;
    /* Scorecard and overs come from the feed only while a match is
       live. For a finished match the baked scorecard is authoritative
       (the post-match run writes it, with figures the feed's partial
       scorecard does not carry) — never overwrite it with less. */
    if (p.live && featured && scorecard && window.sialtvLiveTables) {
      var tables = window.sialtvLiveTables(featured);
      if (tables) scorecard.innerHTML = tables;
    }
    if (p.live && featured && overs) {
      var tl = featured.overTimeline || [];
      if (tl.length && window.sialtvLiveTables && window.sialtvLiveOvers) {
        overs.innerHTML = window.sialtvLiveOvers(featured);
      } else if (!tl.length) {
        overs.innerHTML = '<p>Over-by-over balls are not published for Match ' + featured.matchNo + ' on this page.</p>';
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
        links[i].textContent = 'Live now — Match ' + m.matchNo;
        if (line) line.innerHTML = sidebarLiveLine(m, line);
      } else if (m.status === 'result') {
        links[i].textContent = 'Result — Match ' + m.matchNo;
        if (line) line.textContent = teamName(m.statusText || '');
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
