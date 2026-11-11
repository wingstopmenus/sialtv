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

  function scoreLine(m) {
    if (!m) return '';
    if (m.status === 'upcoming') return esc(m.team1) + ' vs ' + esc(m.team2);
    var a = esc(m.team1) + ' ' + esc(m.score1 || '');
    if (m.overs1) a += ' <span>(' + esc(m.overs1) + ' ov)</span>';
    var b = esc(m.team2) + ' ' + esc(m.score2 || '');
    if (m.overs2) b += ' <span>(' + esc(m.overs2) + ' ov)</span>';
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
    html += '<p>' + esc(m.statusText || '') + (m.venue ? ' at ' + esc(m.venue) : '') + '.</p>';
    if (m.status === 'result') html += performersLine(m);
    if (m.toss) html += '<p class="note">' + esc(m.toss) + '</p>';
    html += '</div>';
    return html;
  }

  function resultItem(m, league) {
    return '<li><a href="' + matchUrl(league, m.matchNo) + '"><b>Match ' + m.matchNo + ': ' + esc(m.team1) + ' ' + esc(m.score1 || '') + ' vs ' + esc(m.team2) + ' ' + esc(m.score2 || '') + '</b><span>' + esc(m.statusText || '') + ' &middot; ' + esc(fmtDate(m.date)) + '</span></a></li>';
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
        if (data && data.matches && data.matches.length) renderPanel(panel, data);
      }).catch(function () {});
    }
    load();
    setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
