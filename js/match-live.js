/* SialTV match-live.js (FRESH, 2026-11-14) — Cricinfo-style match pages.
 *
 * One script, two jobs:
 *  (1) Tabs + squad toggles on EVERY match page (no network needed).
 *  (2) Live flip while the match is on: polls /api/live-scores.php,
 *      falls back to the committed static snapshot, and updates the
 *      header, the default tab, the title/H1 and the live panels.
 *
 * Endpoint contract (verified on the live site):
 *   GET /api/live-scores.php?league=<slug>
 *   -> {"matches":[{"id":"npl-2026-m26","espnEventId":1558607,
 *       "matchNo":26,"status":"upcoming|live|result","statusText":"...",
 *       "score1":null,"score2":null,"overs1":null,"overs2":null,
 *       "scorecard":{"innings":[]},"commentary":[],"overTimeline":[],
 *       "overTimelinePrev":[],"playingXI":null,
 *       "live":null}], "fetchedAt":"..."}
 *   Commentary entries carry `period` (1|2) + `otherBatsman`; over
 *   timeline entries carry `team` + `period`; innings entries carry
 *   `period`. The commentary is the FULL play-by-play from over 1
 *   (both innings), not the summary's last-~18-ball window.
 *   Static fallback: /data/<league>-live-scores.json (npl: /data/live-scores.json).
 *
 * Golden rule: a baked result page never polls. The template marks it
 * with data-ci-state="result" on <body>; this script trusts that and
 * does no fetch at all. The Summary tab is never rewritten — it is
 * baked content. Nothing is invented: a figure the feed does not carry
 * is omitted, never guessed.
 *
 * Polling: 30s while live or near kickoff; 5 min while upcoming and
 * kickoff is more than 15 min away; nothing outside the match window
 * (kickoff more than 2h away and not live -> slow poll only; a
 * finished match stops polling after showing the final state once).
 * Hidden tabs skip work and re-tick on visibilitychange. A failed
 * fetch changes nothing on the page.
 *
 * Playing XI source (round 2, 2026-11-18; M30 table removed
 * 2026-11-18 ~18:35 PKT — see VERIFIED_XI comment): the feed's
 * playingXI is ESPN's summary roster, which is NOT always the toss
 * XI (a stale/predicted roster can carry wrong names, and the baked
 * page carries squads only, never an XI). The XI is resolved
 * verified-first (a verified table in this file, per match, until
 * the bake/template carries it in the baked DOM), then the
 * PBP-validated feed XI, else nothing — a wrong XI is never shown.
 * The Scorecard "Yet to bat" line is recomputed from the same
 * resolved XI when it is verified. See resolveXi / VERIFIED_XI.
 */
(function () {
  'use strict';

  var POLL_FAST = 30 * 1000;
  var POLL_SLOW = 5 * 60 * 1000;
  var NEAR_KICKOFF = 15 * 60 * 1000;
  var WINDOW_BEFORE = 2 * 60 * 60 * 1000;

  var STATIC_SNAPSHOT = {
    npl: '/data/live-scores.json',
    ilt20: '/data/ilt20-live-scores.json',
    sa20: '/data/sa20-live-scores.json',
    apl: '/data/apl-live-scores.json'
  };
  var TEAM_CODE = {
    'Biratnagar Kings': 'BIK', 'Lumbini Lions': 'LUL',
    'Kathmandu Gorkhas': 'KAG', 'Sudur Paschim Royals': 'SPR',
    'Janakpur Bolts': 'JAB', 'Chitwan Rhinos': 'CHR',
    'Karnali Yaks': 'KAY', 'Pokhara Avengers': 'POA',
    'Abu Dhabi Knight Riders': 'ADKR', 'Desert Vipers': 'DV',
    'Dubai Capitals': 'DC', 'Gulf Giants': 'GG',
    'MI Emirates': 'MIE', 'Sharjah Warriorz': 'SW'
  };
  var TEAM_SHORT = {
    'Biratnagar Kings': 'Kings', 'Lumbini Lions': 'Lions',
    'Kathmandu Gorkhas': 'Gorkhas', 'Sudur Paschim Royals': 'Royals',
    'Janakpur Bolts': 'Bolts', 'Chitwan Rhinos': 'Rhinos',
    'Karnali Yaks': 'Yaks', 'Pokhara Avengers': 'Avengers',
    'Abu Dhabi Knight Riders': 'Knight Riders', 'Desert Vipers': 'Vipers',
    'Dubai Capitals': 'Capitals', 'Gulf Giants': 'Giants',
    'MI Emirates': 'MI Emirates', 'Sharjah Warriorz': 'Warriorz'
  };

  /* Tab sets per state. Panel ids are ci-panel-<key>; tab links carry
     data-ci-panel="<key>". Live set (Cricinfo NPL Eliminator, checked
     2026-11-18 on the live page): Live | Scorecard | Commentary |
     Match Flow | Live Stats | Playing XI | Table. The 'overs' panel is
     the Match Flow tab and the 'stats' panel is the Live Stats tab in
     live state (same panels, relabelled — see LABELS_BY_STATE); the
     result state keeps the Cricinfo result labels Stats / Overs. News
     and Photos tabs are omitted: only one news article has a real page
     and no match photos exist — they are added when their data exists.
     Playing XI was dropped from the live set by 04f3fa7e (2026-11-17)
     while build.py kept it — the template and the JS now agree again.
     Per-match tab sets (Tests later) live in build.py FORMAT_TAB_SETS;
     the JS mirrors the T20 set here. */
  var TABS_BY_STATE = {
    upcoming: ['summary', 'scorecard', 'playingxi', 'stats', 'table'],
    live: ['live', 'scorecard', 'commentary', 'overs', 'stats', 'playingxi', 'table'],
    result: ['summary', 'scorecard', 'commentary', 'stats', 'overs', 'table'],
    abandoned: ['summary', 'scorecard', 'playingxi', 'stats', 'table']
  };
  /* Tab labels per state. Only the keys whose label changes by state
     are listed; anything unlisted keeps its baked label. The template
     (build.py TAB_SETS) carries the same labels for future builds. */
  var LABELS_BY_STATE = {
    upcoming: { overs: 'Overs', stats: 'Stats' },
    live: { overs: 'Match Flow', stats: 'Live Stats' },
    result: { overs: 'Overs', stats: 'Stats' },
    abandoned: { overs: 'Overs', stats: 'Stats' }
  };
  var DEFAULT_TAB = { upcoming: 'summary', live: 'live', result: 'summary', abandoned: 'summary' };

  var timer = null;
  var seenStatus = '';
  var pickedByUser = false;
  var commOldest = false;
  var commPage = 1;
  var commPeriod = 0;
  var commDone = false;
  var commLoading = false;
  var commObs = null;
  var lastFeedSig = '';
  var lastWormSvg = '';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  /* Write-only-on-change: assigning innerHTML/textContent rebuilds the
     node even when the string is identical, and that rebuild is the
     visible flash on every poll. The _html cache compares against the
     string actually written, never the browser's serialisation. */
  function setText(el, txt) { if (el && el.textContent !== txt) el.textContent = txt; }
  function setHtml(el, html) { if (el && el._html !== html) { el.innerHTML = html; el._html = html; } }
  /* classList.add/remove and setAttribute fire a mutation record even
     when the value does not change, and the same holds for .hidden and
     for assigning an identical textContent — so every write in a poll
     path must check first, or an identical poll still churns the DOM. */
  function setHidden(el, want) { if (el && !!el.hidden !== !!want) el.hidden = want; }

  function identity() {
    var body = document.body;
    var league = body.getAttribute('data-ci-league') || '';
    var season = body.getAttribute('data-ci-season') || '';
    var no = parseInt(body.getAttribute('data-ci-match') || '0', 10);
    var id = body.getAttribute('data-ci-id') || '';
    var state = body.getAttribute('data-ci-state') || 'upcoming';
    var kickoff = body.getAttribute('data-ci-kickoff') || '';
    if (league && no) {
      if (!id) id = league + '-' + season + '-m' + no;
      return { league: league, season: season, matchNo: no, id: id, state: state, kickoff: kickoff };
    }
    var m = /^\/([a-z0-9]+)\/matches\/([^/]+)\/match-(\d+)\//.exec(location.pathname || '');
    if (!m) return null;
    return { league: m[1], season: m[2], matchNo: parseInt(m[3], 10), id: m[1] + '-' + m[2] + '-m' + m[3], state: state, kickoff: kickoff };
  }

  /* ---------- tabs (no network) ---------- */

  function openTab(key, opts) {
    var tabs = $all('[data-ci-tabs] [data-ci-panel]');
    var found = false;
    tabs.forEach(function (tab) { if (tab.getAttribute('data-ci-panel') === key) found = true; });
    if (!found) return false;
    tabs.forEach(function (tab) {
      var k = tab.getAttribute('data-ci-panel');
      var panel = document.getElementById('ci-panel-' + k);
      var active = (k === key);
      tab.setAttribute('aria-current', active ? 'true' : 'false');
      /* aria-selected is the tab's accessible state; the live tab was
         active visually only (no aria-selected in the DOM). */
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      if (panel) panel.hidden = !active;
    });
    if (!opts || !opts.silent) {
      var panel = document.getElementById('ci-panel-' + key);
      if (panel && opts && opts.scroll) panel.scrollIntoView();
    }
    return true;
  }

  function applyTabSet(state) {
    var set = TABS_BY_STATE[state] || TABS_BY_STATE.upcoming;
    var nav = document.querySelector('[data-ci-tabs]');
    var current = null;
    $all('[data-ci-tabs] [data-ci-panel]').forEach(function (tab) {
      var k = tab.getAttribute('data-ci-panel');
      var show = set.indexOf(k) !== -1;
      tab.parentNode.hidden = !show;
      if (tab.getAttribute('aria-current') === 'true') current = k;
    });
    /* Reorder the tabs into the state's set order: hiding alone leaves
       the baked DOM order (Summary first, Live 5th) — the shuffled tab
       row the user reported. Appending in set order moves the visible
       tabs to the front in the right sequence. */
    if (nav) {
      set.forEach(function (k) {
        var tab = nav.querySelector('[data-ci-panel="' + k + '"]');
        if (tab && tab.parentNode) nav.appendChild(tab.parentNode);
      });
    }
    /* Per-state labels (Match Flow / Live Stats in live state, Overs /
       Stats elsewhere). Check-first: a no-op write still churns the DOM. */
    var labels = LABELS_BY_STATE[state] || {};
    Object.keys(labels).forEach(function (k) {
      var tab = nav ? nav.querySelector('[data-ci-panel="' + k + '"]') : null;
      if (tab) setText(tab, labels[k]);
    });
    if (!current || set.indexOf(current) === -1) {
      openTab(DEFAULT_TAB[state] || 'summary', { silent: true });
    }
  }

  function wireTabs() {
    var nav = $('[data-ci-tabs]');
    if (!nav) return;
    $all('[data-ci-panel]', nav).forEach(function (tab) {
      tab.addEventListener('click', function (ev) {
        ev.preventDefault();
        pickedByUser = true;
        openTab(tab.getAttribute('data-ci-panel'));
      });
    });
    /* In-page links that point at a tab panel switch the tab instead of
       jumping to a hidden section. */
    document.addEventListener('click', function (ev) {
      var a = ev.target.closest ? ev.target.closest('a[href^="#ci-panel-"]') : null;
      if (!a || a.hasAttribute('data-ci-panel') || a.hasAttribute('data-ci-goto')) return;
      var key = a.getAttribute('href').slice('#ci-panel-'.length);
      var tab = $('[data-ci-tabs] [data-ci-panel="' + key + '"]');
      if (!tab || tab.parentNode.hidden) return;
      ev.preventDefault();
      pickedByUser = true;
      openTab(key, { scroll: true });
    });
  }

  /* Scorecard sub-tab pills (Innings | Flow | Info) are plain anchors;
     keep their pressed state in sync with the click. */
  function wireSubtabs() {
    $all('[data-ci-subtab]').forEach(function (pill) {
      pill.addEventListener('click', function () {
        $all('[data-ci-subtab]').forEach(function (p) {
          p.setAttribute('aria-current', p === pill ? 'true' : 'false');
        });
      });
    });
  }

  /* ---------- squad toggles (no network) ---------- */

  function wireSquads() {
    $all('[data-ci-squad-toggle]').forEach(function (wrap) {
      var buttons = $all('button', wrap);
      buttons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var show = btn.getAttribute('data-ci-squad');
          var section = wrap.closest('section') || document;
          buttons.forEach(function (b) { b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
          $all('[data-ci-squad-list]', section).forEach(function (list) {
            list.hidden = list.getAttribute('data-ci-squad-list') !== show;
          });
        });
      });
    });
  }

  /* ---------- stats chips (All / Head To Head / Players to watch) ---------- */

  function wireStatsChips() {
    $all('[data-ci-stats-chips]').forEach(function (wrap) {
      var buttons = $all('[data-ci-stats]', wrap);
      var panel = wrap.closest('section') || document;
      buttons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var show = btn.getAttribute('data-ci-stats');
          buttons.forEach(function (b) { b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
          $all('[data-ci-stats-block]', panel).forEach(function (block) {
            block.hidden = show !== 'all' && block.getAttribute('data-ci-stats-block') !== show;
          });
        });
      });
    });
  }

  /* ---------- bowling victim chevrons (baked scorecard) ---------- */

  function wireVictims() {
    $all('.ci-wvict').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var list = btn.parentNode.querySelector('.ci-wvict-list');
        if (!list) return;
        var open = list.hidden;
        list.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.textContent = open ? '▴' : '▾';
      });
    });
  }

  /* ---------- recent-performance full-form chevron ---------- */

  function wireRecent() {
    $all('[data-ci-recent]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.ci-recent');
        var full = row ? row.querySelector('.ci-wl-full') : null;
        if (!full) return;
        var open = full.hidden;
        full.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });
  }

  /* ---------- commentary filters (baked + live panels; delegated, so the
     live panel's filter row — created on the first live render — works) ---------- */

  function wireCommentaryFilters() {
    document.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-ci-comm-order]') : null;
      if (!btn) return;
      var panel = btn.closest('section') || document;
      var newest = btn.getAttribute('aria-pressed') === 'true';
      commOldest = newest;
      btn.setAttribute('aria-pressed', newest ? 'false' : 'true');
      btn.textContent = newest ? 'Oldest first' : 'Newest first';
      $all('.ci-comm-group', panel).forEach(function (g) {
        var list = g.querySelector('.ci-comm');
        if (list) {
          var items = $all('li', list);
          items.reverse().forEach(function (li) { list.appendChild(li); });
        }
      });
      var gs = $all('.ci-comm-group', panel);
      gs.reverse().forEach(function (g) {
        if (g.parentNode) g.parentNode.appendChild(g);
      });
    });
    document.addEventListener('change', function (ev) {
      var sel = ev.target.closest ? ev.target.closest('[data-ci-comm-inn]') : null;
      if (!sel) return;
      var panel = sel.closest('section') || document;
      var want = sel.value;
      $all('.ci-comm-group', panel).forEach(function (g) {
        g.hidden = want !== '0' && g.getAttribute('data-ci-inn') !== want;
      });
    });
  }

  /* ---------- share button (Web Share, else copy link) ---------- */

  function wireShare() {
    $all('[data-ci-share]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var url = location.href;
        var done = function () {
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = 'Share'; }, 2000);
        };
        if (navigator.share) {
          navigator.share({ title: document.title, url: url }).catch(function () { /* dismissed */ });
          return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, function () { /* clipboard denied */ });
        }
      });
    });
  }

  /* ---------- countdown (upcoming only) ---------- */

  function kickoffMs(ident) {
    if (!ident.kickoff) return NaN;
    return Date.parse(ident.kickoff);
  }

  /* One countdown format for the header clock and the pre-start Live
     panel, so the first paint and the 60 s tick never disagree. */
  function countdownStr(kick) {
    var diff = kick - Date.now();
    if (diff <= 0) return 'Starting soon';
    var mins = Math.floor(diff / 60000);
    var hours = Math.floor(mins / 60);
    var days = Math.floor(hours / 24);
    /* Visitor-local clock: Intl without timeZone renders in the
       visitor's own zone; the duration part above is untouched.
       hour12:true: the old branch relied on en-GB's default, which is
       24-hour ("at 19:30") — the site convention is 12-hour ("7:30 PM",
       en-GB renders a lowercase pm, so it is uppercased). */
    if (days >= 1) return 'Starts in ' + days + (days === 1 ? ' day' : ' days') + ' — ' + new Date(kick).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\b(am|pm)$/i, function (m) { return m.toUpperCase(); });
    if (hours >= 1) return 'Starts in ' + hours + 'h ' + (mins % 60) + 'm';
    if (mins >= 1) return 'Starts in ' + mins + ' minutes';
    return 'Starting soon';
  }

  function renderCountdown(ident) {
    var box = $('[data-ci-countdown]');
    if (!box) return;
    var kick = kickoffMs(ident);
    if (isNaN(kick)) { setHidden(box, true); return; }
    var diff = kick - Date.now();
    /* The pre-start Live panel carries its own countdown line — keep it
       in step with the header clock on the same 60 s tick. */
    var pre = $('[data-ci-prestart-countdown]');
    if (diff <= 0) {
      setHidden(box, true);
      if (pre) setText(pre, 'Starting soon');
      return;
    }
    setHidden(box, false);
    var text = $('[data-ci-countdown-text]', box);
    var str = countdownStr(kick);
    if (text) setText(text, str);
    if (pre) setText(pre, str);
  }

  /* ---------- feed ---------- */

  function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function loadMatch(ident) {
    function pick(data) {
      var list = (data && data.matches) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === ident.id) return { match: list[i], fetchedAt: data.fetchedAt || '' };
      }
      throw new Error('match not in feed');
    }
    return getJson('/api/live-scores.php?league=' + encodeURIComponent(ident.league))
      .then(pick)
      .catch(function () {
        var snap = STATIC_SNAPSHOT[ident.league];
        if (!snap) throw new Error('no static snapshot for ' + ident.league);
        return getJson(snap).then(pick);
      });
  }

  /* ---------- feed -> numbers (derived only, never invented) ---------- */

  function ballsOf(overs) {
    var parts = String(overs || '0').split('.');
    return (parseInt(parts[0] || '0', 10) * 6) + (parseInt(parts[1] || '0', 10) || 0);
  }

  function scoreRuns(score) {
    var m = /^(\d+)\/(\d+)/.exec(String(score || ''));
    return m ? { runs: parseInt(m[1], 10), wkts: parseInt(m[2], 10) } : null;
  }

  /* Which side is batting now: the side with a score while the other has
     none; else the side whose innings is not yet closed (fewer overs,
     fewer than 10 wickets). */
  function battingNow(m) {
    if (m.score2 && !m.score1) return { team: m.team2, score: m.score2, overs: m.overs2 };
    if (m.score1 && !m.score2) return { team: m.team1, score: m.score1, overs: m.overs1 };
    if (m.score1 && m.score2) {
      var w1 = scoreRuns(m.score1), w2 = scoreRuns(m.score2);
      if (w2 && w2.wkts >= 10) return { team: m.team1, score: m.score1, overs: m.overs1 };
      if (w1 && w1.wkts >= 10) return { team: m.team2, score: m.score2, overs: m.overs2 };
      return ballsOf(m.overs1) > ballsOf(m.overs2)
        ? { team: m.team2, score: m.score2, overs: m.overs2 }
        : { team: m.team1, score: m.score1, overs: m.overs1 };
    }
    return null;
  }

  function runRate(m) {
    if (m.live && m.live.crr) return String(m.live.crr);
    var bat = battingNow(m);
    if (!bat) return '';
    /* The official top-level score/overs (m.score2/m.overs2) are the
       freshest count — the PBP lags them by a ball, which made the
       header CRR (6.89, 27 balls) disagree with the strip (6.64, 28
       balls) at 31/2. Use the official count for the batting-now side. */
    var team = cleanName(bat.team || '');
    var offScore = null, offOvers = null;
    if (team && cleanName(m.team2 || '') === team && m.score2 && m.overs2) { offScore = m.score2; offOvers = m.overs2; }
    else if (team && cleanName(m.team1 || '') === team && m.score1 && m.overs1) { offScore = m.score1; offOvers = m.overs1; }
    if (offScore && offOvers) {
      var orr = scoreRuns(offScore), obb = ballsOf(offOvers);
      if (orr && obb) return (orr.runs * 6 / obb).toFixed(2);
    }
    var runs = scoreRuns(bat.score);
    var balls = ballsOf(bat.overs);
    if (!runs || !balls) return '';
    return (runs.runs * 6 / balls).toFixed(2);
  }

  /* Has the first ball been bowled? The endpoint flags a match "live"
     ~15 min before kickoff, so status alone cannot prove play has
     started — only a score, a ball or an innings row can. */
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

  /* Toss window: the endpoint flags the match live and the toss is
     done, but no ball has been bowled yet. Cricinfo/ESPN label the
     match live from the toss — so do we. The phantom window (live,
     no toss, no score) is NOT this: it stays upcoming. */
  function hasToss(m) {
    return !!m && !!(m.toss && String(m.toss).trim());
  }
  function isLiveToss(m) {
    return !!m && m.status === 'live' && !hasStarted(m) && hasToss(m);
  }

  function inningsInProgress(m) {
    var inns = mergedInnings(m);
    for (var i = 0; i < inns.length; i++) {
      var bat = inns[i].batting || [];
      for (var j = 0; j < bat.length; j++) if (bat[j].crease) return inns[i];
    }
    return inns.length ? inns[inns.length - 1] : null;
  }

  /* One section per innings: the endpoint emits one entry per
     (period, side) in roster order, so a live match has four entries —
     the batting side's entry and the bowling side's entry per period.
     Merge by period into one section (batting side's batting + yet +
     total/overs, bowling side's bowling), ordered chronologically
     (period 1, then period 2) — the same order the baked result pages
     show. Entries without a period (old snapshots) fall back to the raw
     list sorted batting-first. Totals/overs come from the batting
     side's entry: totals are synced per team name, so a bowling-side
     entry can carry the other period's score. */
  function mergedInnings(m) {
    var inns = (m.scorecard && m.scorecard.innings) || [];
    if (!inns.length) return [];
    /* Merge one entry into a section: batting + yet + total/overs from
       the entry that batted, bowling from the entry that bowled. */
    function mergeInto(tgt, g) {
      if ((g.batting || []).length || (g.yet || []).length) {
        tgt.team = g.team;
        tgt.batting = g.batting || [];
        tgt.yet = g.yet || [];
        tgt.total = g.total || tgt.total;
        tgt.overs = g.overs || tgt.overs;
      }
      if ((g.bowling || []).length) {
        tgt.bowling = g.bowling || [];
        if (!tgt.team) tgt.team = g.team;
      }
    }
    var hasPeriod = inns.some(function (g) { return g.period != null; });
    if (!hasPeriod) {
      /* Old window payload (no period): merge by team so one side never
         renders as two blocks (the duplicate-batting-block defect).
         Batting-first order, as before. */
      var byTeam = {};
      var tOrder = [];
      inns.forEach(function (g) {
        var key = g.team || '';
        if (!byTeam[key]) {
          byTeam[key] = { team: '', period: 0, batting: [], bowling: [], yet: [], total: '', overs: '' };
          tOrder.push(key);
        }
        mergeInto(byTeam[key], g);
      });
      return tOrder.map(function (k) { return byTeam[k]; }).sort(function (a, b) {
        return ((b.batting || []).length - (a.batting || []).length);
      });
    }
    var byPeriod = {};
    var order = [];
    inns.forEach(function (g) {
      var p = g.period || 1;
      if (!byPeriod[p]) {
        byPeriod[p] = { team: '', period: p, batting: [], bowling: [], yet: [], total: '', overs: '' };
        order.push(p);
      }
      mergeInto(byPeriod[p], g);
    });
    order.sort(function (a, b) { return a - b; });
    return order.map(function (p) { return byPeriod[p]; });
  }

  /* Which innings is in progress: the one with a batsman at the crease;
     else the latest period with batting; else the old score heuristic
     (score2 exists => innings 2). The old rule was wrong in the 2nd
     innings: once both scores exist it always said 2, so the commentary
     walk-back started from the completed 1st-innings total. */
  function currentPeriod(m) {
    var inns = mergedInnings(m);
    for (var i = 0; i < inns.length; i++) {
      var bat = inns[i].batting || [];
      for (var j = 0; j < bat.length; j++) if (bat[j].crease) return inns[i].period || 1;
    }
    var latest = 0;
    inns.forEach(function (g) {
      if ((g.batting || []).length && (g.period || 0) > latest) latest = g.period || 0;
    });
    if (latest) return latest;
    return m.score2 ? 2 : 1;
  }

  /* The current innings' team / score / overs, from the merged innings
     (the period with a batsman at the crease; else the latest period
     with batting). Falls back to the old score heuristic. */
  function periodScore(m) {
    var inns = mergedInnings(m);
    for (var i = 0; i < inns.length; i++) {
      var bat = inns[i].batting || [];
      for (var j = 0; j < bat.length; j++) {
        if (bat[j].crease) {
          return { team: inns[i].team, score: scoreRuns(inns[i].total), overs: inns[i].overs };
        }
      }
    }
    var latest = null;
    inns.forEach(function (g) { if ((g.batting || []).length) latest = g; });
    if (latest) return { team: latest.team, score: scoreRuns(latest.total), overs: latest.overs };
    if (m.score2) return { team: m.team2, score: scoreRuns(m.score2), overs: m.overs2 };
    return { team: m.team1, score: scoreRuns(m.score1), overs: m.overs1 };
  }

  /* Fall of wickets, walked from the ball-by-ball in order — the
     CURRENT innings only. The payload now carries the full PBP (both
     innings), so walking all of it would add the 1st-innings falls to
     the 2nd-innings total. Entries without a period (old payloads)
     default to the current innings. */
  function fallOfWickets(m) {
    var period = currentPeriod(m);
    var balls = (m.commentary || []).filter(function (b) {
      return (b.period || period) === period;
    }).slice().reverse();
    var out = [], runs = 0, wkts = 0;
    balls.forEach(function (b) {
      runs += parseInt(b.runs || '0', 10);
      if (String(b.dismissal || '').trim()) {
        wkts++;
        out.push({ score: runs + '/' + wkts, name: b.batsman || '', over: b.over || '' });
      }
    });
    /* Top-up for a lagging PBP (round 3): the walk only sees the balls
       the feed has delivered. When the latest dismissal ball has not
       arrived yet (the endpoint's PBP cache is ~30s), the walk drops
       the newest wicket even though the scorecard batting rows (from
       the summary, which updates faster) already show that batter
       dismissed. In that case — and ONLY when exactly one wicket is
       missing — append the missing latest fall from the feed's
       lastWicket, guarded so nothing is invented: its fow must parse
       as runs/wkts, be exactly the next wicket, be monotonic, and its
       name must be the one dismissed batter missing from the walk.
       lastWicket's runs/balls/fow are NOT trusted anywhere else: the
       fresh M30 feed carries runs "0", balls "" and fow "0" for a
       batter who scored 2 off 6 (5/1) — placeholders. */
    var lw = (m.live || {}).lastWicket;
    if (lw && lw.name && lw.fow && lw.over) {
      var fp = String(lw.fow).split('/');
      var dismissed = [];
      mergedInnings(m).forEach(function (g) {
        if ((g.period || 1) !== period) return;
        (g.batting || []).forEach(function (b) {
          if (String(b.dismissal || '').trim() && String(b.dismissal).toLowerCase() !== 'not out') dismissed.push(b);
        });
      });
      var missing = dismissed.filter(function (b) {
        return out.every(function (w) { return cleanName(w.name) !== cleanName(b.name); });
      });
      if (missing.length === 1 && cleanName(missing[0].name) === cleanName(lw.name) &&
          fp.length === 2 && /^\d+$/.test(fp[0]) && /^\d+$/.test(fp[1]) &&
          parseInt(fp[1], 10) === out.length + 1 &&
          (!out.length || parseInt(fp[0], 10) >= parseInt(String(out[out.length - 1].score).split('/')[0], 10))) {
        out.push({ score: lw.fow, name: lw.name, over: lw.over });
      }
    }
    return out;
  }

  function chipFor(token) {
    var t = String(token);
    if (t === 'W') return '<span class="ci-ball is-w">W</span>';
    if (t === '6') return '<span class="ci-ball is-6">6</span>';
    if (t === '4') return '<span class="ci-ball is-4">4</span>';
    if (t === '0' || t === '•') return '<span class="ci-ball">&bull;</span>';
    if (/w$|nb$/.test(t)) return '<span class="ci-ball is-wide">' + esc(t) + '</span>';
    return '<span class="ci-ball">' + esc(t) + '</span>';
  }

  function ballToken(b) {
    var dism = String(b.dismissal || '').trim();
    if (dism) return 'W';
    var short = String(b.short || '').toLowerCase();
    var runs = parseInt(b.runs || '0', 10);
    if (short.indexOf('wide') !== -1) return (runs || 1) + 'w';
    if (short.indexOf('no ball') !== -1) return (runs || 1) + 'nb';
    return String(b.runs == null ? '0' : b.runs);
  }

  /* "Over 36" -> 36; "36.4" -> 36. Never parseInt on the raw label:
     parseInt("Over 36") is NaN — that was the old renderWorm bug. */
  function overNum(label) {
    var m = /(\d+)/.exec(String(label || ''));
    return m ? parseInt(m[1], 10) : NaN;
  }

  function isLegalBall(b) {
    var s = String(b.short || b.text || '').toLowerCase();
    return s.indexOf('wide') === -1 && s.indexOf('no ball') === -1;
  }

  function isLegalToken(t) { return !/w$|nb$/.test(String(t)); }

  /* Dismissal detail box (image-124): the scorecard's dismissal string
     for the batsman when it resolves (exact name, else a unique surname —
     the same rule the baked pages use), else the feed's dismissal text. */
  function wicketBox(m, b) {
    var dism = String(b.dismissal || '').trim();
    if (!dism) return '';
    var name = String(b.batsman || '').trim();
    var g = inningsInProgress(m);
    if (g && name) {
      var bat = g.batting || [], found = null, i;
      for (i = 0; i < bat.length; i++) {
        if (bat[i].name === name) { found = bat[i]; break; }
      }
      if (!found) {
        var sur = name.split(' ').slice(-1)[0];
        var cands = bat.filter(function (x) {
          return x.name.split(' ').slice(-1)[0] === sur;
        });
        if (cands.length === 1) found = cands[0];
      }
      if (found) {
        var d = String(found.dismissal || '').trim();
        if (d && d.toLowerCase() !== 'not out') {
          return '<span class="ci-wicket-box">' + esc(found.name) + ' ' + esc(d) + '</span>';
        }
      }
    }
    return '<span class="ci-wicket-box">' + esc((name ? name + ' ' : '') + dism) + '</span>';
  }

  /* ---------- renderers (endpoint data -> .ci- markup) ---------- */

  function headerHtml(m) {
    var status = $('[data-ci-status]');
    if (status) {
      var dot = $('[data-ci-dot]', status);
      if (m.status === 'live') {
        if (!status.classList.contains('is-live')) status.classList.add('is-live');
        status.childNodes.forEach(function (n) { if (n.nodeType === 3 && n.textContent !== ' LIVE') n.textContent = ' LIVE'; });
        setHidden(dot, false);
      } else if (m.status === 'result') {
        if (status.classList.contains('is-live')) status.classList.remove('is-live');
        status.childNodes.forEach(function (n) { if (n.nodeType === 3 && n.textContent !== ' RESULT') n.textContent = ' RESULT'; });
        setHidden(dot, true);
      }
    }
    /* Chase overs cell, Cricinfo form "(16.4/20 ov, T:106)": the quota is
       20 (NPL is a 20-over league; a rain-shortened live game shows the
       full quota until the bake, whose baked page reads the real quota
       from target_note). The target is the other side's total + 1, shown
       only for the side currently batting in the chase. */
    function chaseOvers(team, overs) {
      if (!overs) return '';
      var txt = '(' + esc(overs) + '/20 ov';
      if (m.score1 && m.score2) {
        var bat = battingNow(m);
        if (bat && cleanName(bat.team) === cleanName(team)) {
          var otherScore = cleanName(m.team1) === cleanName(team) ? m.score2 : m.score1;
          var other = scoreRuns(otherScore);
          if (other) txt += ', T:' + (other.runs + 1);
        }
      }
      return txt + ')';
    }
    function setScore(sel, team, score, overs) {
      /* Match the row by TEAM (data-ci-team), not by position: a baked
         result page orders the rows loser-first, while the feed's team1
         / team2 are fixture order. Old pages without data-ci-team fall
         back to the positional selector, so the shared JS keeps working
         on them until they are rebuilt. */
      var code = TEAM_CODE[cleanName(team)] || cleanName(team);
      var row = document.querySelector('.ci-team[data-ci-team="' + code + '"]');
      var el = row ? row.querySelector('.ci-team-score') : $(sel);
      if (!el) return;
      if (!score) { setHtml(el, '<span class="ci-yet">' + esc(team || '') + ' yet to bat</span>'); return; }
      /* Baked result pages carry data-ci-quota / data-ci-target /
         data-ci-win on the score cell (Cricinfo chase form + winner
         bold). Keep them across polls; live pages have no attrs and
         use the derived chase form. */
      var q = el.getAttribute('data-ci-quota');
      var t = el.getAttribute('data-ci-target');
      var w = el.getAttribute('data-ci-win');
      var ovTxt = '';
      if (overs) {
        if (q || t) ovTxt = '(' + esc(overs) + (q ? '/' + esc(q) : '') + ' ov' + (t ? ', T:' + esc(t) : '') + ')';
        else ovTxt = chaseOvers(team, overs);
      }
      var scoreHtml = (w === '0') ? esc(score) : '<b>' + esc(score) + '</b>';
      setHtml(el, scoreHtml + ' <span>' + ovTxt + '</span>');
    }
    if (m.status === 'live' || m.status === 'result') {
      setScore('[data-ci-score1]', m.team1, m.score1, m.overs1);
      setScore('[data-ci-score2]', m.team2, m.score2, m.overs2);
    }
    /* Result: order the rows loser-first, winner bold (Cricinfo). A
       baked result page is built that way; a live page flipping to
       result is fixture order, so reorder it once. Check-first: the
       swap runs only when the loser is not already first, and the
       classes are set idempotently. */
    if (m.status === 'result') {
      var win = /^(.+?)\s+won by/i.exec(cleanName(m.statusText || ''));
      if (win) {
        var wname = win[1].trim();
        var teams = document.querySelector('.ci-teams');
        if (teams) {
          var trows = $all('.ci-team', teams);
          if (trows.length === 2) {
            var loserRow = null, winnerRow = null;
            trows.forEach(function (r) {
              var nm = r.querySelector('.ci-team-name');
              var txt = nm ? nm.textContent.trim() : '';
              if (txt === wname) winnerRow = r; else loserRow = r;
            });
            if (loserRow && winnerRow && trows[0] !== loserRow) {
              teams.insertBefore(loserRow, winnerRow);
            }
            if (loserRow) {
              var ln = loserRow.querySelector('.ci-team-name');
              var ls = loserRow.querySelector('.ci-team-score');
              if (ln) ln.classList.add('is-loser');
              if (ls) ls.classList.add('is-loser');
            }
            if (winnerRow) {
              var wn = winnerRow.querySelector('.ci-team-name');
              var ws = winnerRow.querySelector('.ci-team-score');
              if (wn) wn.classList.remove('is-loser');
              if (ws) ws.classList.remove('is-loser');
            }
          }
        }
      }
    }
    var result = $('[data-ci-result]');
    /* The feed's result line carries the league suffix
       ("Lumbini Lions (NPL) won by 6 wickets") — the baked line has
       none. Strip the league code, keep any other parenthetical.
       Then the Cricinfo result-line form: short team name +
       "(with N balls remaining)". */
    if (result && m.statusText) setText(result, resultLineText(m.statusText));
    var toss = $('[data-ci-toss]');
    if (toss && m.toss) setText(toss, m.toss);
    var rr = $('[data-ci-rr]');
    if (rr) {
      /* A result has no current run rate: the feed still carries the
         last live.crr (and battingNow still finds a batting side), so
         writing it here leaves a stale "Current RR" on the result
         page. Clear it instead. */
      if (m.status === 'result') setText(rr, '');
      else {
        var crr = runRate(m);
        if (crr) setText(rr, 'Current RR: ' + crr);
      }
    }
    /* The countdown stays visible until the first ball is bowled: the
       endpoint flags the match live ~15 min before kickoff, and hiding
       it then would leave the pre-start page with no clock at all.
       renderCountdown manages it from the kickoff time. */
    var cd = $('[data-ci-countdown]');
    if (cd && hasStarted(m)) setHidden(cd, true);
  }

  /* Per-ball derivations for the live tables (Cricinfo columns). The
     feed carries no career stats — the T20 CAREER blocks are omitted,
     never invented (see REPORT.md). THIS BOWLER / LAST 10 OV / 0S /
     4S / 6S / THIS SPELL are all computed from the ball-by-ball
     commentary + the over timeline, so they are exact. */
  function currentBowlerName(m) {
    var bw = (m.live && m.live.bowlers) || [];
    for (var i = 0; i < bw.length; i++) if (bw.current) return bw.name;
    var tl = m.overTimeline || (m.live && m.live.recentOvers) || [];
    return tl.length ? (tl[0].bowler || '') : '';
  }
  function batterVsBowler(m, batter, bowler) {
    if (!batter || !bowler) return 0;
    var period = currentPeriod(m), total = 0;
    (m.commentary || []).forEach(function (b) {
      if ((b.period || period) !== period) return;
      if (String(b.batsman || '') === batter && String(b.bowler || '') === bowler) {
        total += parseInt(b.runs || '0', 10);
      }
    });
    return total;
  }
  function batterLast10Ov(m, batter) {
    if (!batter) return 0;
    var period = currentPeriod(m);
    var cur = 0;
    (m.commentary || []).forEach(function (b) {
      if ((b.period || period) !== period) return;
      var ov = overNum(b.over) + 1;
      if (!isNaN(ov) && ov > cur) cur = ov;
    });
    var tl = m.overTimeline || (m.live && m.live.recentOvers) || [];
    tl.forEach(function (o) { var ov = overNum(o.label); if (!isNaN(ov) && ov > cur) cur = ov; });
    if (!cur) return 0;
    var from = Math.max(1, cur - 9), total = 0;
    (m.commentary || []).forEach(function (b) {
      if ((b.period || period) !== period) return;
      var ov = overNum(b.over) + 1;
      if (isNaN(ov) || ov < from || ov > cur) return;
      if (String(b.batsman || '') === batter) total += parseInt(b.runs || '0', 10);
    });
    return total;
  }
  /* A bowler's most recent consecutive-over spell (ov-maidens-runs-wkts),
     from the timeline, newest first. Runs exclude byes/leg-byes (same
     rule as thisSpell). Returns null when the bowler has no over in the
     timeline. */
  function bowlerSpell(m, name) {
    if (!name) return null;
    var tl = (m.overTimeline || (m.live && m.live.recentOvers) || []).slice();
    var start = -1;
    for (var i = 0; i < tl.length; i++) { if ((tl[i].bowler || '') === name) { start = i; break; } }
    if (start < 0) return null;
    var runs = 0, wkts = 0, maidens = 0, legal = 0;
    for (var j = start; j < tl.length; j++) {
      if ((tl[j].bowler || '') !== name) break;
      runs += (tl[j].runs || 0) - byeRunsInOver(m, overNum(tl[j].label));
      wkts += tl[j].wickets || 0;
      var lg = 0;
      (tl[j].tokens || []).forEach(function (t) { if (isLegalToken(t)) lg++; });
      legal += lg;
      if ((tl[j].runs || 0) === 0 && lg === 6) maidens++;
    }
    if (!legal && !runs && !wkts) return null;
    return (Math.floor(legal / 6) + '.' + (legal % 6)) + '-' + maidens + '-' + runs + '-' + wkts;
  }
  function bowlerBoundaries(m, name) {
    if (!name) return null;
    var period = currentPeriod(m), dots = 0, fours = 0, sixes = 0, found = false;
    (m.commentary || []).forEach(function (b) {
      if ((b.period || period) !== period) return;
      if (String(b.bowler || '') !== name) return;
      found = true;
      var s = String(b.short || '');
      if (/FOUR/i.test(s)) fours++;
      else if (/SIX/i.test(s)) sixes++;
      else if (parseInt(b.runs || '0', 10) === 0) dots++;
    });
    return found ? { dots: dots, fours: fours, sixes: sixes } : null;
  }

  function battersTable(batters, m) {
    if (!batters || !batters.length) return '';
    var curBowler = m ? currentBowlerName(m) : '';
    var rows = batters.map(function (b) {
      var extra = '';
      if (m) {
        extra = '<td class="ci-num">' + esc(batterVsBowler(m, b.name, curBowler)) + '</td>' +
          '<td class="ci-num">' + esc(batterLast10Ov(m, b.name)) + '</td>';
      }
      return '<tr><td class="ci-name">' + esc(b.name) + (b.striker ? ' *' : '') + '</td>' +
        '<td class="ci-num">' + esc(b.runs) + '</td><td class="ci-num">' + esc(b.balls) + '</td>' +
        '<td class="ci-num">' + esc(b.fours == null ? '' : b.fours) + '</td>' +
        '<td class="ci-num">' + esc(b.sixes == null ? '' : b.sixes) + '</td>' +
        '<td class="ci-num">' + esc(b.sr == null ? '' : b.sr) + '</td>' + extra + '</tr>';
    }).join('');
    var headExtra = m ? '<th class="ci-num">THIS BOWLER</th><th class="ci-num">LAST 10 OV</th>' : '';
    return '<p class="ci-subhead">Batters</p><div class="ci-scroll"><table class="ci-table">' +
      '<thead><tr><th class="ci-name">Batter</th><th class="ci-num">R</th><th class="ci-num">B</th>' +
      '<th class="ci-num">4s</th><th class="ci-num">6s</th><th class="ci-num">SR</th>' + headExtra + '</tr></thead><tbody>' +
      rows + '</tbody></table></div>';
  }

  function bowlersTable(bowlers, m) {
    if (!bowlers || !bowlers.length) return '';
    var rows = bowlers.map(function (b) {
      var extra = '';
      if (m) {
        var bb = bowlerBoundaries(m, b.name);
        var sp = bowlerSpell(m, b.name);
        extra = '<td class="ci-num">' + (bb ? esc(bb.dots) : '') + '</td>' +
          '<td class="ci-num">' + (bb ? esc(bb.fours) : '') + '</td>' +
          '<td class="ci-num">' + (bb ? esc(bb.sixes) : '') + '</td>' +
          '<td class="ci-num">' + (sp == null ? '' : esc(sp)) + '</td>';
      }
      return '<tr><td class="ci-name">' + esc(b.name) + (b.current ? ' *' : '') + '</td>' +
        '<td class="ci-num">' + esc(b.overs == null ? '' : b.overs) + '</td>' +
        '<td class="ci-num">' + esc(b.maidens == null ? '' : b.maidens) + '</td>' +
        '<td class="ci-num">' + esc(b.runs) + '</td><td class="ci-num">' + esc(b.wickets) + '</td>' +
        '<td class="ci-num">' + esc(b.econ == null ? '' : b.econ) + '</td>' + extra + '</tr>';
    }).join('');
    var headExtra = m ? '<th class="ci-num">0S</th><th class="ci-num">4S</th><th class="ci-num">6S</th><th class="ci-num">THIS SPELL</th>' : '';
    return '<p class="ci-subhead">Bowlers</p><div class="ci-scroll"><table class="ci-table">' +
      '<thead><tr><th class="ci-name">Bowler</th><th class="ci-num">O</th><th class="ci-num">M</th>' +
      '<th class="ci-num">R</th><th class="ci-num">W</th><th class="ci-num">Econ</th>' + headExtra + '</tr></thead><tbody>' +
      rows + '</tbody></table></div>';
  }

  function stripHtml(overs) {
    /* Ball strip with over labels (image-122): the last two overs' tokens,
       each headed by its over label ("Over 36" — already 1-indexed). */
    var parts = [];
    (overs || []).slice(0, 2).forEach(function (o) {
      var toks = (o.tokens || []).map(chipFor).join('');
      if (!toks) return;
      parts.push('<span class="ci-strip-over">' + esc(o.label || '') + '</span>' + toks);
    });
    if (!parts.length) return '';
    return '<div class="ci-strip">' + parts.join(' ') +
      ' <a href="#ci-panel-commentary" data-ci-goto="commentary">See all &rsaquo;</a></div>';
  }

  /* Ball-by-ball, grouped by over, with a Cricinfo-style over summary bar
     per over (image-124). The feed window is newest-first and covers only
     the last ~18 balls, so cumulative scores are walked BACK from the
     current total: the end-state of the newest over is the current total,
     and each older over's end-state subtracts the balls after it. That is
     exact for every group in the window. The over's own runs/wickets are
     shown only when the group is complete (its first ball is X.1 — the
     over started inside the window) or it is the over in progress; a cut
     oldest group shows its cumulative score and CRR only, never partial
     over figures as if they were the whole over.
     Over numbers: the API 'over' field is the 0-indexed actual label
     ("36.4" = 37th over), so the display over is label+1; the PHP
     overTimeline label "Over N" is already 1-indexed.
     Returns [{key, html}] — key is "period-overNo" for merge dedup. */
  function commentaryGroups(m, limitBalls, noCum) {
    var period = currentPeriod(m);
    var ps = periodScore(m);
    /* The payload now carries the full PBP (both innings): group the
       current innings only. Entries without a period (old payloads)
       default to the current innings, so old snapshots still render. */
    var balls = (m.commentary || []).filter(function (b) {
      return (b.period || period) === period;
    }).slice(0, limitBalls || undefined);
    if (!balls.length) return [];
    var chrono = balls.slice().reverse();
    var groups = {}, order = [];
    chrono.forEach(function (b) {
      var ov = overNum(b.over) + 1;
      if (isNaN(ov)) ov = 0;
      var k = period + '-' + ov;
      if (!groups[k]) { groups[k] = { overNo: ov, balls: [] }; order.push(k); }
      groups[k].balls.push(b);
    });
    /* Walk back from the current total (newest group first). */
    var cumRuns = ps.score ? ps.score.runs : 0;
    var cumWkts = ps.score ? ps.score.wkts : 0;
    var cumLegal = ballsOf(ps.overs);
    var haveTotal = !!ps.score;
    var live = m.live || {};
    var batters = live.batters || [];
    var bowlers = live.bowlers || [];
    var out = [];
    for (var gi = order.length - 1; gi >= 0; gi--) {
      var key = order[gi];
      var grp = groups[key].balls;
      var overNo = groups[key].overNo;
      var runs = 0, wkts = 0, legal = 0;
      grp.forEach(function (b) {
        runs += parseInt(b.runs || '0', 10);
        if (String(b.dismissal || '').trim()) wkts++;
        if (isLegalBall(b)) legal++;
      });
      var firstBall = String((grp[0] || {}).over || '');
      var startedInWindow = /\.1$/.test(firstBall);
      var isLatest = gi === order.length - 1;
      var bar = '';
      if (overNo > 0 && haveTotal && !noCum) {
        var crr = cumLegal > 0 ? (cumRuns * 6 / cumLegal) : null;
        var crrTxt = crr == null ? '' : ', CRR: ' + crr.toFixed(2);
        var left;
        if (isLatest || startedInWindow) {
          left = '<b>OVER ' + overNo + '</b> — ' + runs + ' run' + (runs === 1 ? '' : 's') +
            (wkts ? ', ' + wkts + ' wicket' + (wkts === 1 ? '' : 's') : '') +
            ' — ' + esc(ps.team || '') + ' ' + cumRuns + '/' + cumWkts + crrTxt;
        } else {
          /* Cut oldest group: cumulative + CRR are exact, the over's own
             runs are partial — show no runs clause. */
          left = '<b>OVER ' + overNo + '</b> — ' + esc(ps.team || '') + ' ' +
            cumRuns + '/' + cumWkts + crrTxt;
        }
        var right = [];
        if (isLatest && batters.length) {
          var ordered = batters.slice().sort(function (a, b) {
            return (b.striker ? 1 : 0) - (a.striker ? 1 : 0);
          });
          ordered.forEach(function (bt) {
            right.push(esc(bt.name) + ' ' + (bt.runs || 0) + ' (' + (bt.balls || 0) + ')');
          });
          var cur = null;
          bowlers.forEach(function (bw) { if (bw.current) cur = bw; });
          if (cur) {
            right.push(esc(cur.name) + ' ' + (cur.overs == null ? '' : cur.overs) + '-' +
              (cur.maidens == null ? '' : cur.maidens) + '-' + (cur.runs || 0) + '-' + (cur.wickets || 0));
          } else if (grp[0].bowler) {
            right.push(esc(grp[0].bowler));
          }
        } else {
          /* Older overs: batters at the crease by name only, from the
             balls' batsman field (last two distinct, most recent first;
             a batter dismissed off the last ball is out, not at the
             crease). Bowler by name only. */
          var seen = {}, pair = [];
          for (var bi = grp.length - 1; bi >= 0; bi--) {
            var nm = String(grp[bi].batsman || '').trim();
            if (!nm || seen[nm]) continue;
            if (bi === grp.length - 1 && String(grp[bi].dismissal || '').trim()) continue;
            seen[nm] = true;
            pair.push(nm);
            if (pair.length === 2) break;
          }
          pair.forEach(function (nm) { right.push(esc(nm)); });
          if (grp[0].bowler) right.push(esc(grp[0].bowler));
        }
        bar = '<div class="ci-overbar"><span>' + left + '</span>' +
          (right.length ? '<span class="ci-overbar-sub">' + right.join(' · ') + '</span>' : '') + '</div>';
      } else if (noCum && overNo > 0 && (isLatest || startedInWindow) && legal === 6) {
        /* Appended older pages (infinite scroll): no cumulative exists for
           them — show the over's own figures only, and only for a complete
           over. */
        bar = '<div class="ci-overbar"><span><b>OVER ' + overNo + '</b> — ' + runs +
          ' run' + (runs === 1 ? '' : 's') +
          (wkts ? ', ' + wkts + ' wicket' + (wkts === 1 ? '' : 's') : '') +
          (grp[0].bowler ? ' · ' + esc(grp[0].bowler) : '') + '</span></div>';
      }
      var items = (commOldest ? grp.slice() : grp.slice().reverse()).map(function (b) {
        return '<li data-ci-ball="' + esc((b.over || '') + '|' + (b.short || b.text || '')) + '">' +
          '<span class="ci-over">' + esc(b.over || '') + '</span>' + chipFor(ballToken(b)) +
          '<span class="ci-comm-text"><span class="ci-comm-head">' + esc(b.short || b.text || '') + '</span>' +
          wicketBox(m, b) + '</span></li>';
      }).join('');
      out.push({
        key: key,
        html: '<div class="ci-comm-group" data-ci-inn="' + period + '" data-ci-over="' + key + '">' +
          bar + '<ul class="ci-comm">' + items + '</ul></div>'
      });
      cumRuns -= runs; cumWkts -= wkts; cumLegal -= legal;
    }
    /* Display order: newest first (Cricinfo default), oldest first after
       the user toggles. `out` was built newest-first. */
    return commOldest ? out.reverse() : out;
  }

  function commentaryGroupsHtml(m, limitBalls, noCum) {
    return commentaryGroups(m, limitBalls, noCum).map(function (g) { return g.html; }).join('');
  }

  /* Over-by-over table (image-125): cumulative score + CRR per over, walked
     back from the current total over the full timeline (or the last 3
     overs when the endpoint only sent the window).
     Maiden = 0 runs off 6 legal balls (a 0-run partial over is not one). */
  function overDetailRows(m) {
    var tl = (m.overTimeline || (m.live && m.live.recentOvers) || []).slice();
    if (!tl.length) return '';
    var ps = periodScore(m);
    var code = TEAM_CODE[cleanName(ps.team)] || cleanName(ps.team);
    var cumRuns = ps.score ? ps.score.runs : 0;
    var cumWkts = ps.score ? ps.score.wkts : 0;
    var cumLegal = ballsOf(ps.overs);
    var out = [];
    tl.forEach(function (o) {
      var n = overNum(o.label);
      var toks = (o.tokens || []).slice();
      var filled = false;
      /* An over the timeline knows about but has no balls for yet (the
         over just started): build its balls from the commentary, so
         the tab never shows a bare "Over N" heading with nothing
         under it. If the commentary has no balls for it either, skip
         the row — but still subtract its runs from the cumulative, so
         the older overs' end-scores stay right. */
      if (!toks.length) {
        if (!isNaN(n)) {
          var period = currentPeriod(m);
          (m.commentary || []).forEach(function (b) {
            if ((b.period || period) !== period) return;
            if (overNum(b.over) + 1 === n) toks.push(ballToken(b));
          });
        }
        if (!toks.length) { cumRuns -= (o.runs || 0); cumWkts -= (o.wickets || 0); return; }
        filled = true;
      }
      var runs = o.runs || 0, wk = o.wickets || 0, legal = 0;
      if (filled) {
        runs = 0; wk = 0;
        toks.forEach(function (t) {
          if (t === 'W') wk++;
          else { var v = parseInt(t, 10); if (!isNaN(v)) runs += v; }
        });
      }
      toks.forEach(function (t) { if (isLegalToken(t)) legal++; });
      var crr = cumLegal > 0 ? (cumRuns * 6 / cumLegal) : null;
      var maiden = (runs === 0 && legal === 6) ? ' is-maiden' : '';
      var head = '<b>Over ' + (isNaN(n) ? esc(o.label || '') : n) + '</b>';
      if (code) head += ' · ' + esc(code);
      if (o.bowler) head += ' · ' + esc(o.bowler);
      head += ' — ' + runs + ' run' + (runs === 1 ? '' : 's');
      if (wk) head += ', ' + wk + ' wicket' + (wk === 1 ? '' : 's');
      if (ps.score) {
        head += ' | ' + cumRuns + '/' + cumWkts;
        if (crr != null) head += ' · CRR ' + crr.toFixed(2);
      }
      out.push('<div class="ci-over' + maiden + '"><p class="ci-overhead">' + head + '</p>' +
        '<p class="ci-ballrow">' + toks.map(chipFor).join('') + '</p></div>');
      cumRuns -= runs; cumWkts -= wk; cumLegal -= legal;
    });
    return out.join('');
  }

  /* Bye / leg-bye runs in one over (display over number, 1-indexed),
     from the commentary. A wide is NOT a bye (it counts against the
     bowler); a no-ball's bat runs are not bye runs either. */
  function byeRunsInOver(m, overNo) {
    var total = 0;
    (m.commentary || []).forEach(function (b) {
      if (overNum(b.over) + 1 !== overNo) return;
      var s = String(b.short || b.text || '');
      if (/bye/i.test(s)) total += parseInt(b.runs || '0', 10);
    });
    return total;
  }

  /* This spell: the current bowler's trailing consecutive overs in the
     timeline (image-122). With a window-only timeline, when the run
     reaches its oldest over AND more overs have been bowled than the
     timeline covers, the spell is truncated — say so. */
  function thisSpell(m) {
    var live = m.live || {};
    var tl = m.overTimeline || live.recentOvers || [];
    if (!tl.length) return '';
    var bowlers = live.bowlers || [], cur = null;
    bowlers.forEach(function (bw) { if (bw.current) cur = bw; });
    var name = cur ? cur.name : (tl[0].bowler || '');
    if (!name) return '';
    var runs = 0, wkts = 0, maidens = 0, legal = 0, n = 0;
    var tlLegal = 0;
    tl.forEach(function (o) {
      (o.tokens || []).forEach(function (t) { if (isLegalToken(t)) tlLegal++; });
    });
    for (var j = 0; j < tl.length; j++) {
      if ((tl[j].bowler || '') !== name) break;
      n++;
      /* The timeline over total includes byes/leg-byes, which do NOT
         count against the bowler — the bowler table (0/6) excluded
         them while the spell line (0/7) included the bye at 4.3.
         Subtract the bye runs for this over, from the commentary. */
      runs += (tl[j].runs || 0) - byeRunsInOver(m, overNum(tl[j].label));
      wkts += tl[j].wickets || 0;
      var lg = 0;
      (tl[j].tokens || []).forEach(function (t) { if (isLegalToken(t)) lg++; });
      legal += lg;
      if ((tl[j].runs || 0) === 0 && lg === 6) maidens++;
    }
    if (!n) return '';
    var ps = periodScore(m);
    var truncated = (n === tl.length) && (ballsOf(ps.overs) > tlLegal);
    var ov = Math.floor(legal / 6) + '.' + (legal % 6);
    var s = 'This spell: ' + name + ' ' + ov + '-' + maidens + '-' + runs + '-' + wkts;
    if (truncated) s += ' (last 3 overs)';
    return s;
  }

  /* Group-based merge for the Commentary tab: the feed is a rolling
     window, so replace the groups it covers (same data-ci-over key) and
     prepend/append genuinely new groups. Groups the window no longer
     covers stay put — the panel keeps older overs the window dropped.
     Baked commentary has no [data-ci-comm-groups] container and is
     complete, so it is never touched. */
  function mergeCommentary(slot, m) {
    if (!slot) return;
    var container = slot.querySelector('[data-ci-comm-groups]');
    if (!container) return;
    var groups = commentaryGroups(m);
    var existing = {};
    $all('.ci-comm-group', container).forEach(function (g) {
      existing[g.getAttribute('data-ci-over')] = g;
    });
    var frag = document.createDocumentFragment();
    var added = 0;
    groups.forEach(function (grp) {
      var old = existing[grp.key];
      if (old) { old.outerHTML = grp.html; return; }
      var tmp = document.createElement('div');
      tmp.innerHTML = grp.html;
      if (tmp.firstChild) { frag.appendChild(tmp.firstChild); added++; }
    });
    if (added) {
      if (commOldest) container.appendChild(frag);
      else container.insertBefore(frag, container.firstChild);
    }
  }

  /* Paginated fetch for infinite scroll: the endpoint reads `page` +
     `period` — today it ignores them (summary only). The call is still
     issued with the params so it starts working the day the endpoint
     supports them, and the dedup below makes it safe meanwhile (same
     window -> 0 new groups -> advance/stop). */
  function loadMatchPage(ident, page, period) {
    return getJson('/api/live-scores.php?league=' + encodeURIComponent(ident.league) +
      '&page=' + page + '&period=' + period).then(function (data) {
        var list = (data && data.matches) || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === ident.id) return { match: list[i], fetchedAt: data.fetchedAt || '' };
        }
        throw new Error('match not in feed');
      });
  }

  /* Infinite scroll (image-124: "neechy scroll pe auto next load"): when
     the sentinel scrolls into view, fetch the next older PBP page and
     append its groups (deduped by data-ci-over). Pages run period 2 then
     period 1; a page that adds nothing is exhausted — move on, and stop
     after period 1. With the current endpoint every fetch returns the
     same window, so this stops after two empty fetches. No-op while the
     user views oldest-first (older content is above, not below). */
  function setupCommScroll(ident, m) {
    if (commDone || commObs) return;
    var sentinel = document.querySelector('[data-ci-comm-sentinel]');
    if (!sentinel || !('IntersectionObserver' in window)) return;
    /* The payload now carries the full PBP: when the first render
       already covers from over 1 of the current innings (group key
       "<period>-1" present), there is nothing older to load — no
       infinite-scroll loader at all. */
    var period = currentPeriod(m);
    var container = document.querySelector('[data-ci-comm-groups]');
    if (container) {
      var covered = false;
      $all('.ci-comm-group', container).forEach(function (g) {
        if (g.getAttribute('data-ci-over') === period + '-1') covered = true;
      });
      if (covered) { commDone = true; return; }
    }
    if (!commPeriod) { commPeriod = currentPeriod(m); commPage = 2; }
    commObs = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting || commLoading || commDone || commOldest) return;
      commLoading = true;
      loadMatchPage(ident, commPage, commPeriod).then(function (res) {
        var container = document.querySelector('[data-ci-comm-groups]');
        var added = 0;
        if (container) {
          var existing = {};
          $all('.ci-comm-group', container).forEach(function (g) {
            existing[g.getAttribute('data-ci-over')] = g;
          });
          var frag = document.createDocumentFragment();
          /* Older pages carry no trustworthy cumulative (the walk-back
             needs the current total), so their overbars show the over's
             own figures only. */
          commentaryGroups(res.match, undefined, true).forEach(function (grp) {
            if (existing[grp.key]) return;
            var tmp = document.createElement('div');
            tmp.innerHTML = grp.html;
            if (tmp.firstChild) { frag.appendChild(tmp.firstChild); added++; }
          });
          if (added) container.appendChild(frag);
        }
        if (!added) {
          if (commPeriod === 2) { commPeriod = 1; commPage = 1; }
          else {
            commDone = true;
            if (commObs) commObs.disconnect();
          }
        } else { commPage++; }
        commLoading = false;
      }).catch(function () { commLoading = false; });
    }, { rootMargin: '400px' });
    commObs.observe(sentinel);
  }

  /* Last 5 overs (Cricinfo run-rate line): runs / wickets / run rate
     from the over timeline's last 5 entries. */
  function lastFiveOv(m) {
    var tl = (m.overTimeline || (m.live && m.live.recentOvers) || []).slice();
    if (!tl.length) return null;
    tl.sort(function (a, b) { return overNum(a.label) - overNum(b.label); });
    var last = tl.slice(-5), runs = 0, wkts = 0, legal = 0;
    last.forEach(function (o) {
      runs += o.runs || 0; wkts += o.wickets || 0;
      (o.tokens || []).forEach(function (t) { if (isLegalToken(t)) legal++; });
    });
    if (!legal) return null;
    return { runs: runs, wkts: wkts, rr: (runs * 6 / legal).toFixed(2) };
  }
  /* Chase line (2nd innings): "Need N runs in M balls • Required RR: X".
     Target = the other side's total + 1, from the official top-level
     scores. Returns '' when not chasing. */
  function chaseLine(m) {
    if (!m.score1 || !m.score2) return '';
    var bat = battingNow(m);
    if (!bat) return '';
    var team = cleanName(bat.team || '');
    var batScore, batOvers, otherScore;
    if (team && cleanName(m.team2 || '') === team) { batScore = m.score2; batOvers = m.overs2; otherScore = m.score1; }
    else if (team && cleanName(m.team1 || '') === team) { batScore = m.score1; batOvers = m.overs1; otherScore = m.score2; }
    else return '';
    var target = scoreRuns(otherScore), cur = scoreRuns(batScore);
    if (!target || !cur) return '';
    var need = (target.runs + 1) - cur.runs;
    var ballsLeft = 120 - ballsOf(batOvers);
    if (need <= 0 || ballsLeft <= 0) return '';
    return 'Need ' + need + ' run' + (need === 1 ? '' : 's') + ' in ' + ballsLeft + ' ball' +
      (ballsLeft === 1 ? '' : 's') + ' • Required RR: ' + (need * 6 / ballsLeft).toFixed(2);
  }
  /* Extras from the ball-by-ball commentary (current period): wides,
     no-balls, byes, leg-byes. A no-ball contributes only its 1-run
     penalty (not the bat runs off it); a wide/bye/leg-bye contributes
     its runs. Returns null when the period has no balls. */
  function extrasFromPbp(m, period) {
    period = period || currentPeriod(m);
    var balls = (m.commentary || []).filter(function (b) { return (b.period || period) === period; });
    if (!balls.length) return null;
    var w = 0, nb = 0, b = 0, lb = 0;
    balls.forEach(function (x) {
      var s = String(x.short || x.text || '').toLowerCase();
      var r = parseInt(x.runs || '0', 10);
      if (s.indexOf('wide') !== -1) w += r || 1;
      else if (s.indexOf('no ball') !== -1 || s.indexOf('no-ball') !== -1) nb += 1;
      else if (s.indexOf('leg bye') !== -1 || s.indexOf('leg-bye') !== -1) lb += r;
      else if (s.indexOf('bye') !== -1) b += r;
    });
    var total = w + nb + b + lb;
    var parts = [];
    if (b) parts.push('b ' + b);
    if (lb) parts.push('lb ' + lb);
    if (w) parts.push('w ' + w);
    if (nb) parts.push('nb ' + nb);
    return { w: w, nb: nb, b: b, lb: lb, total: total, text: parts.length ? '(' + parts.join(', ') + ')' : '' };
  }
  /* Match Details for the Live tab (Cricinfo's Live tab carries it).
     Built from the baked Summary block (#ci-sum-info) so the rows match
     the page's own details exactly, then augmented with the live rows
     the baked block cannot have: Toss (from the feed), Series Result
     (– while live) and Points (0/0 while live — the match is not
     decided). Umpires / Match Referee are NOT in the feed and NOT on
     the baked upcoming page, so those rows are omitted live — the bake
     adds them from the ESPN summary when the result bakes. Order =
     the baked block's order (Ground, Toss, Series, Season, Match
     Number, Series Result, Match Days, Points). */
  function liveDetailsHtml(m) {
    var src = document.getElementById('ci-sum-info');
    var rows = [];
    if (src) {
      var dl = src.querySelector('dl.ci-details');
      if (dl) {
        $all('.ci-details-row', dl).forEach(function (r) {
          rows.push({ dt: r.querySelector('dt') ? r.querySelector('dt').textContent : '',
                      dd: r.querySelector('dd') ? r.querySelector('dd').innerHTML : '' });
        });
      }
    }
    if (!rows.length) {
      /* Fallback (old baked page without the block): the rows the page
         itself carries, omitting anything with no data. */
      rows.push({ dt: 'Series', dd: esc(m.series_name || 'Nepal Premier League') });
      rows.push({ dt: 'Season', dd: '2026/27' });
      if (m.matchNo) rows.push({ dt: 'Match Number', dd: 'Match ' + m.matchNo });
    }
    var has = function (dt) { return rows.some(function (r) { return r.dt === dt; }); };
    var insertAfter = function (dt, row) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].dt === dt) { rows.splice(i + 1, 0, row); return; }
      }
      rows.push(row);
    };
    if (m.toss && !has('Toss')) insertAfter('Ground', { dt: 'Toss', dd: esc(m.toss) });
    if (!has('Series Result')) insertAfter('Match Number', { dt: 'Series Result', dd: '–' });
    if (!has('Points') && m.team1 && m.team2) {
      rows.push({ dt: 'Points', dd: esc(cleanName(m.team1)) + ' 0, ' + esc(cleanName(m.team2)) + ' 0' });
    }
    if (!rows.length) return '';
    return '<div id="ci-live-info"><h2>Match Details</h2><dl class="ci-details">' +
      rows.map(function (r) {
        return '<div class="ci-details-row"><dt>' + esc(r.dt) + '</dt><dd>' + r.dd + '</dd></div>';
      }).join('') + '</dl></div>';
  }

  function livePanelHtml(m, ident) {
    var live = m.live || {};
    var batters = live.batters || [];
    var bowlers = live.bowlers || [];
    var overs = (live.recentOvers && live.recentOvers.length) ? live.recentOvers : (m.overTimeline || []);
    if (!batters.length && !bowlers.length && !overs.length && m.status === 'upcoming') {
      return '<p class="ci-yet">Match yet to begin. Live updates appear here once the match starts.</p>';
    }
    if (m.status === 'live' && !hasStarted(m)) {
      /* Pre-start live window (toss done, no ball bowled — the
         phantom window never reaches here, tick() holds it in
         Preview). Show the toss, a countdown and the first-ball
         line — never an empty Match Centre. The feed carries no XI,
         so link to the Playing XI tab (baked) instead of inventing
         one. */
      var kick = (ident && ident.kickoff) ? Date.parse(ident.kickoff) : NaN;
      var cdTxt = isNaN(kick) ? 'Starting soon' : countdownStr(kick);
      var pre = '';
      if (m.toss) pre += '<p><strong>' + esc(m.toss) + '</strong></p>';
      pre += '<p class="ci-meta"><span data-ci-prestart-countdown>' + esc(cdTxt) + '</span> · Live coverage begins at the first ball.</p>';
      pre += '<p><a class="ci-btn-outline" href="#ci-panel-playingxi" data-ci-goto="playingxi">See Playing XI ›</a></p>';
      return pre;
    }
    var html = '';
    var bat = battingNow(m);
    if (bat) html += '<p><strong>' + esc(bat.team) + ' ' + esc(bat.score) + '</strong>' +
      (bat.overs ? ' (' + esc(bat.overs) + ' ov)' : '') + '</p>';
    var crr = runRate(m);
    var rrParts = [];
    if (crr) rrParts.push('Current RR: ' + crr);
    var l5 = lastFiveOv(m);
    if (l5) rrParts.push('Last 5 ov: ' + l5.runs + '/' + l5.wkts + ' (' + l5.rr + ')');
    var ch = chaseLine(m);
    if (ch) rrParts.push(ch);
    if (rrParts.length) html += '<p class="ci-meta">' + esc(rrParts.join(' • ')) + '</p>';
    html += battersTable(batters, m) + bowlersTable(bowlers, m);
    var spell = thisSpell(m);
    if (spell) html += '<p class="ci-meta">' + esc(spell) + '</p>';
    if (batters.length >= 2) {
      var r0 = parseInt(batters[0].runs || '0', 10) + parseInt(batters[1].runs || '0', 10);
      var b0 = parseInt(batters[0].balls || '0', 10) + parseInt(batters[1].balls || '0', 10);
      html += '<p class="ci-meta">Partnership: ' + r0 + ' runs (' + b0 + ' balls)</p>';
    }
    /* Fall of wickets: the FULL list, walked from the PBP (same 0.1
       gate as the scorecard — the walk is complete only when the
       current innings' balls start at "0.1"). The old code showed only
       the latest fall, so the first wicket was missing. Falls back to
       the latest fall only when the walk is not valid. */
    var fowBalls = (m.commentary || []).filter(function (b) {
      return (b.period || currentPeriod(m)) === currentPeriod(m);
    });
    var fowOldest = fowBalls.length ? fowBalls[fowBalls.length - 1] : null;
    var fowFull = !!fowOldest && String(fowOldest.over || '') === '0.1';
    var fowList = fowFull ? fallOfWickets(m) : [];
    /* Last Bat: from the feed's lastWicket when present; otherwise
       from the most recent fall in the full FoW list. The endpoint
       stops carrying lastWicket once the match is past the early
       overs, so without this the line vanishes mid-match. The
       batter's runs/balls/dismissal come from the innings batting
       rows — never invented. */
    /* Last Bat: the most recent fall in the CURRENT innings' batting
       rows (the last row with a dismissal — dismissed batters appear
       in batting order, so the last one is the newest wicket). The
       rows come from the summary and carry the true runs/balls, so
       this never prints the feed lastWicket's placeholder figures:
       the fresh M30 feed carries runs "0", balls "" and fow "0" for
       Sahil Patel (2 off 6, 5/1). lastWicket is only a fallback for
       its name + dismissal string, never for figures. */
    var lastBat = null;
    mergedInnings(m).forEach(function (g) {
      if ((g.period || 1) !== currentPeriod(m)) return;
      (g.batting || []).forEach(function (b) {
        if (String(b.dismissal || '').trim() && String(b.dismissal).toLowerCase() !== 'not out') lastBat = b;
      });
    });
    if (lastBat) {
      html += '<p class="ci-meta">Last Bat: ' + esc(lastBat.name) +
        ' ' + esc(lastBat.runs || '0') + ' (' + esc(lastBat.balls || '0') + 'b)' +
        (lastBat.dismissal ? ' — ' + esc(lastBat.dismissal) : '') + '</p>';
    } else if (live.lastWicket && live.lastWicket.name) {
      var lw0 = live.lastWicket;
      html += '<p class="ci-meta">Last Bat: ' + esc(lw0.name) +
        (lw0.dismissal ? ' — ' + esc(lw0.dismissal) : '') + '</p>';
    }
    if (fowList.length) {
      html += '<p class="ci-meta">Fall of wickets: ' + fowList.map(function (w) {
        var p = String(w.score || '').split('/');
        if (p.length !== 2) return esc(w.score);
        return esc(p[1] + '-' + p[0]) + ' (' + esc(w.name) + ', ' + esc(w.over) + ' ov)';
      }).join(', ') + '</p>';
    } else {
      /* One-line latest fall only when the walk is unavailable (window
         payload) AND the feed's fow is a real runs/wkts score. A
         placeholder "0" (the fresh M30 feed's Sahil Patel value) is
         never printed — no FoW line is better than a bogus one. */
      var lw = live.lastWicket;
      if (lw && lw.name && /^\d+\/\d+$/.test(String(lw.fow || ''))) {
        html += '<p class="ci-meta">Fall of wickets: ' + esc(lw.fow) +
          ' (' + esc(lw.name) + (lw.over ? ', ' + esc(lw.over) + ' ov' : '') + ')</p>';
      }
    }
    html += stripHtml((m.overTimeline && m.overTimeline.length) ? m.overTimeline : overs);
    html += '<h2>Match Centre</h2>' + commentaryGroupsHtml(m, 12);
    html += '<a class="ci-btn-outline" href="#ci-panel-commentary" data-ci-goto="commentary">Read Full Commentary</a>';
    /* Worm (Cricinfo Live tab, item 8): the slot is filled by
       renderWorm, which fills EVERY [data-ci-worm] slot — the Live
       tab's and the Live Stats tab's. */
    html += '<h2>Worm</h2><div class="ci-worm-slot" data-ci-worm></div>';
    /* Match Details (Cricinfo Live tab, item 9). */
    html += liveDetailsHtml(m);
    return html;
  }

  function scorecardHtml(m) {
    var inns = mergedInnings(m);
    if (!inns.length) {
      if (m.status === 'live' && !hasStarted(m)) {
        return '<p class="ci-yet">Match yet to begin. The scorecard appears here once the first ball is bowled.</p>';
      }
      return '<p class="ci-yet">Match in progress — the scorecard will appear here shortly.</p>';
    }
    /* Yet to bat from the RESOLVED XI when it is verified: the
       endpoint's `yet` is roster-derived, so for a match whose feed XI
       is wrong the yet list carries the wrong names too. When the
       resolved XI is verified, yet = the XI minus everyone who
       batted (scorecard batting + the ball-by-ball for this period).
       Otherwise the feed's yet is left untouched. Only the batting
       side's section is overridden — the bowling side has no yet line.
       (M30 note: the feed XI turned out to be the true XI, so no
       verified override applies there and the feed's yet stands.) */
    var rxYet = resolveXi(m);
    if (rxYet && rxYet.source === 'verified') {
      inns.forEach(function (g) {
        if (!(g.batting || []).length) return;
        var side = null;
        (rxYet.xi || []).forEach(function (s) {
          if (cleanName(s.team || '') === cleanName(g.team || '')) side = s;
        });
        if (!side) return;
        var batted = {};
        (g.batting || []).forEach(function (b) { batted[cleanName(b.name || '')] = true; });
        Object.keys(playedNames(m, g.period || 1).bat).forEach(function (n) { batted[n] = true; });
        g.yet = (side.players || []).map(function (p) { return p.name; })
          .filter(function (n) { return !batted[cleanName(n)]; });
      });
    }
    /* The payload carries the full PBP from over 1, so the fall-of-
       wickets walk is complete for the innings in progress — show the
       full list under it, never under the completed innings. The walk
       is valid only when the current innings' balls start at "0.1";
       with an old window-only payload it falls back to the last wicket
       only (the live.lastWicket line below). */
    var period = currentPeriod(m);
    var balls = (m.commentary || []).filter(function (b) {
      return (b.period || period) === period;
    });
    var oldest = balls.length ? balls[balls.length - 1] : null;
    var fullFow = !!oldest && String(oldest.over || '') === '0.1';
    var fow = fullFow ? fallOfWickets(m) : [];
    var fowEntry = null;
    inns.forEach(function (h) {
      (h.batting || []).forEach(function (b) { if (b.crease) fowEntry = h; });
    });
    if (!fowEntry) {
      var psTeam = periodScore(m).team;
      inns.forEach(function (h) {
        if (h.team === psTeam && (h.batting || []).length) fowEntry = h;
      });
    }
    return inns.map(function (g) {
      var bat = g.batting || [], bowl = g.bowling || [];
      if (!bat.length && !bowl.length) return '';
      var head = '<p class="ci-innings-head">' + esc(g.team || '') +
        (g.total ? ' <span>(' + esc(g.total) + (g.overs ? ', ' + esc(g.overs) + ' ov' : '') + ')</span>' : '') + '</p>';
      var body = '';
      if (bat.length) {
        body += '<p class="ci-subhead">Batting</p><div class="ci-scroll"><table class="ci-table">' +
          '<thead><tr><th class="ci-name">Batter</th><th>Dismissal</th><th class="ci-num">R</th>' +
          '<th class="ci-num">B</th><th class="ci-num">4s</th><th class="ci-num">6s</th><th class="ci-num">SR</th></tr></thead><tbody>' +
          bat.map(function (b) {
            var out = String(b.dismissal || '').toLowerCase() === 'not out';
            return '<tr><td class="ci-name">' + esc(b.name) + (b.crease ? ' *' : '') + '</td>' +
              '<td class="ci-dismissal">' + esc(b.dismissal || '') + '</td>' +
              '<td class="ci-num"><b>' + esc(b.runs) + (out ? '*' : '') + '</b></td>' +
              '<td class="ci-num">' + esc(b.balls == null ? '' : b.balls) + '</td>' +
              '<td class="ci-num">' + esc(b.fours == null ? '' : b.fours) + '</td>' +
              '<td class="ci-num">' + esc(b.sixes == null ? '' : b.sixes) + '</td>' +
              '<td class="ci-num">' + esc(b.sr == null ? '' : b.sr) + '</td></tr>';
          }).join('');
        /* Extras: computed from the ball-by-ball commentary (wides,
           no-balls, byes, leg-byes) for THIS innings' period — the
           live innings carry no extras breakdown in the feed, so the
           old code showed NO row at all (and a stale baked "Extras 0"
           was the complaint). The computed value is exact: at 34/2
           it is (b 1, w 1) 2. Same markup as the baked result pages. */
        var ex = extrasFromPbp(m, g.period);
        if (ex && g.total) {
          body += '<tr><td>Extras</td><td>' + esc(ex.text) + '</td>' +
            '<td class="ci-num"><b>' + ex.total + '</b></td>' +
            '<td></td><td></td><td></td><td></td></tr>';
        }
        if (g.total) {
          var tot = scoreRuns(g.total);
          var rr = '';
          if (tot && g.overs && ballsOf(g.overs) > 0) {
            rr = (tot.runs * 6 / ballsOf(g.overs)).toFixed(2);
          }
          var totCell = '';
          if (g.overs) totCell += esc(g.overs) + ' Ov';
          if (rr) totCell += ' (RR: ' + rr + ', ' + (tot ? tot.wkts : 0) + ' wkts)';
          body += '<tr class="ci-total"><td>Total</td><td>' + totCell + '</td>' +
            '<td class="ci-num"><b>' + (tot ? tot.runs : '') + '</b></td>' +
            '<td></td><td></td><td></td><td></td></tr>';
        }
        body += '</tbody></table></div>';
        if (g === fowEntry) {
          if (fow.length) {
            body += '<p class="ci-fow"><b>Fall of wickets:</b> ' + fow.map(function (w) {
              var p = String(w.score || '').split('/');
              if (p.length !== 2) return esc(w.score);
              return esc(p[1] + '-' + p[0]) + ' (' + esc(w.name) + ', ' + esc(w.over) + ' ov)';
            }).join(', ') + '</p>';
          } else {
            var lw = (m.live || {}).lastWicket;
            /* Guard (round 3): the feed's lastWicket.fow is a placeholder
               "0" in the fresh M30 feed — only a real runs/wkts score prints. */
            if (lw && lw.name && /^\d+\/\d+$/.test(String(lw.fow || ''))) {
              body += '<p class="ci-fow"><b>Fall of wickets:</b> ' + esc(lw.fow) +
                ' (' + esc(lw.name) + (lw.over ? ', ' + esc(lw.over) + ' ov' : '') + ')</p>';
            }
          }
        }
        if (g.yet && g.yet.length) body += '<p class="ci-dnb"><b>Yet to bat:</b> ' + g.yet.map(esc).join(', ') + '.</p>';
        /* Fielding XI, one line (image-123): the RESOLVED XI (verified
           first) when present; else the other side's batting +
           yet-to-bat names — but ONLY when they total 11. A partial
           list (e.g. only the two not-out batters from a window
           payload) is never called a PLAYING XI. The raw feed XI is
           never used here: only the resolved XI (verified first,
           else PBP-validated feed) is trusted. */
        var other = null;
        inns.forEach(function (h) {
          if (h !== g && h.team !== g.team && (h.batting || []).length) other = h;
        });
        if (other) {
          var xiNames = null;
          var rxField = resolveXi(m);
          var xiFeed = rxField ? (rxField.xi || []).filter(function (s) {
            return cleanName(s.team || '') === cleanName(other.team || '');
          })[0] : null;
          if (xiFeed && (xiFeed.players || []).length === 11) {
            xiNames = xiFeed.players.map(function (p) { return p.name; });
          } else {
            var cand = (other.batting || []).map(function (b) { return b.name; })
              .concat(other.yet || []);
            if (cand.length === 11) xiNames = cand;
          }
          if (xiNames) {
            body += '<p class="ci-fieldxi"><b>' + esc(other.team || '') + ' PLAYING XI</b> — ' +
              xiNames.map(esc).join(', ') + '</p>';
          }
        }
      }
      if (bowl.length) {
        body += '<p class="ci-subhead">Bowling</p><div class="ci-scroll"><table class="ci-table">' +
          '<thead><tr><th class="ci-name">Bowler</th><th class="ci-num">O</th><th class="ci-num">M</th>' +
          '<th class="ci-num">R</th><th class="ci-num">W</th><th class="ci-num">Econ</th>' +
          '<th class="ci-num">WD</th><th class="ci-num">NB</th></tr></thead><tbody>' +
          bowl.map(function (b) {
            return '<tr><td class="ci-name">' + esc(b.name) + '</td>' +
              '<td class="ci-num">' + esc(b.overs == null ? '' : b.overs) + '</td>' +
              '<td class="ci-num">' + esc(b.maidens == null ? '' : b.maidens) + '</td>' +
              '<td class="ci-num">' + esc(b.runs) + '</td><td class="ci-num">' + esc(b.wickets) + '</td>' +
              '<td class="ci-num">' + esc(b.econ == null ? '' : b.econ) + '</td>' +
              '<td class="ci-num">' + esc(b.wides == null ? '' : b.wides) + '</td>' +
              '<td class="ci-num">' + esc(b.noballs == null ? '' : b.noballs) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
      return head + body;
    }).join('') + playingXiHtml(m);
  }

  function commentaryHtml(m) {
    var balls = m.commentary || [];
    if (!balls.length) return '<p class="ci-yet">No ball-by-ball commentary yet. It appears here once the match starts.</p>';
    var pressed = commOldest ? 'false' : 'true';
    var label = commOldest ? 'Oldest first' : 'Newest first';
    return '<h2>Commentary</h2>' +
      '<p class="ci-filter-row"><button type="button" data-ci-comm-order aria-pressed="' + pressed + '">' + label + '</button></p>' +
      '<div data-ci-comm-groups>' + commentaryGroupsHtml(m) + '</div>' +
      '<div data-ci-comm-sentinel></div>';
  }

  function oversHtml(m) {
    var rows = overDetailRows(m);
    if (!rows) return '<p class="ci-yet">No overs yet. The over-by-over summary appears here once the match starts.</p>';
    var html = '<h2>Overs</h2><div class="ci-overs-grid">' + rows + '</div>';
    /* The full timeline starts at over 1; a window-only payload shows
       the most recent overs only — say so only then. */
    var tl = m.overTimeline || (m.live && m.live.recentOvers) || [];
    var first = tl.length ? overNum(tl[tl.length - 1].label) : 0;
    if (tl.length && first !== 1) html += '<p class="ci-note">Showing the most recent overs.</p>';
    return html;
  }

  /* Playing XI — SOURCE OF TRUTH. The endpoint's playingXI is ESPN's
     summary roster, and the roster is NOT always the toss XI — so the
     XI is resolved in this order, and a wrong XI is NEVER shown:
       (1) VERIFIED_XI below — a verified XI for the match, once the
           XI is announced (toss done, or the first ball bowled).
           Before the toss it is NOT used: the baked "never
           confirmed" note stays.
       (2) The feed XI — but ONLY if it does not contradict the
           ball-by-ball: a batter who faced a ball, or a bowler who
           bowled, must be in the XI for their side.
       (3) Nothing — the note/squads stay, never wrong names.
     The verified table is a stopgap until the bake/template carries
     the XI in the baked DOM (matches.json has no XI field — only
     squads). REMOVE an entry when that match's result bake lands.
     CORRECTION 2026-11-18 ~18:35 PKT: the M30 table that stood here
     was REMOVED — live verification proved it wrong, not the feed.
     Its six "verified" Chitwan names (Tripathi, Saif Zaib, Vesawkar,
     Khatri, Rautela, Ziaur Rahman) appear NOWHERE in the match data,
     while the feed XI is confirmed by the endpoint scorecard itself
     (Bibek Yadav 8 (3), Kushal Malla 0* not out; yet: Salahuddin,
     Usama Mir, Ranjit Kumar, Kamal Airee, Rijan Dhakal) and by live
     bowling (Kamal Airee over 1, Rijan Dhakal over 2). The "Tripathi
     scored 4" claim traces to Bibek Yadav's 4 in M20 (9 Nov) — the
     wrong match. M30 therefore falls through to the validated feed
     XI, which passes the ball-by-ball check. Never reinstate the
     removed table. */
  var VERIFIED_XI = {
  };

  function verifiedXi(m) {
    var key = m.id || '';
    if (key && VERIFIED_XI[key]) return VERIFIED_XI[key];
    var ev = m.espnEventId != null ? String(m.espnEventId) : '';
    if (ev && VERIFIED_XI[ev]) return VERIFIED_XI[ev];
    return null;
  }

  /* Names who demonstrably played in one period, from the
     ball-by-ball: batters (striker + non-striker) and bowlers. */
  function playedNames(m, period) {
    var bat = {}, bowl = {};
    (m.commentary || []).forEach(function (b) {
      if ((b.period || 1) !== period) return;
      if (b.batsman) bat[cleanName(b.batsman)] = true;
      if (b.otherBatsman) bat[cleanName(b.otherBatsman)] = true;
      if (b.bowler) bowl[cleanName(b.bowler)] = true;
    });
    return { bat: bat, bowl: bowl };
  }

  /* The feed XI, validated against the ball-by-ball. The feed XI is
     ESPN's roster; a roster that omits a batter who faced a ball, or
     a bowler who bowled, is proven stale and is rejected outright.
     Returns the feed XI, or null. (It cannot catch every wrong
     roster — a yet-to-bat name is unverifiable from live data — which
     is why a verified table can be added above for a match when one
     is truly needed.) */
  function feedXiValidated(m) {
    var xi = m.playingXI || null;
    if (!xi || xi.length < 2) return null;
    var ok = true;
    xi.forEach(function (s) {
      if (((s.players || []).length) !== 11) ok = false;
    });
    if (!ok) return null;
    /* Period -> the side that batted / bowled, from the scorecard
       innings (the entry carrying batting+yet batted; the entry
       carrying bowling bowled). */
    var batTeam = {}, bowlTeam = {};
    (m.scorecard && m.scorecard.innings || []).forEach(function (g) {
      var p = g.period || 1;
      if ((g.batting || []).length || (g.yet || []).length) batTeam[p] = cleanName(g.team || '');
      if ((g.bowling || []).length) bowlTeam[p] = cleanName(g.team || '');
    });
    var byTeam = {};
    xi.forEach(function (s) {
      var names = {};
      (s.players || []).forEach(function (p) { names[cleanName(p.name || '')] = true; });
      byTeam[cleanName(s.team || '')] = names;
    });
    var periods = {};
    (m.commentary || []).forEach(function (b) { periods[b.period || 1] = true; });
    Object.keys(periods).forEach(function (pk) {
      var p = parseInt(pk, 10);
      var played = playedNames(m, p);
      var bt = byTeam[batTeam[p]], wt = byTeam[bowlTeam[p]];
      if (bt) Object.keys(played.bat).forEach(function (n) { if (!bt[n]) ok = false; });
      if (wt) Object.keys(played.bowl).forEach(function (n) { if (!wt[n]) ok = false; });
    });
    return ok ? xi : null;
  }

  /* Resolve the XI for a match: verified first (once announced),
     then the PBP-validated feed XI, else null (never a wrong XI).
     Returns {xi, source} or null. */
  function resolveXi(m) {
    var announced = !!m.toss || hasStarted(m);
    if (announced) {
      var v = verifiedXi(m);
      if (v) return { xi: v, source: 'verified' };
    }
    var f = feedXiValidated(m);
    if (f) return { xi: f, source: 'feed' };
    return null;
  }

  /* Playing XI (Cricinfo's Playing XI tab): ONE side-by-side numbered
     table — No. | Team A | Team B, rows 1–11, (c) captain + (wk)
     keeper markers, NO role column. From the RESOLVED XI (see
     resolveXi above) — never the raw feed XI. Returns '' when no XI
     is resolved. */
  function playingXiTableHtml(xi) {
    if (!xi || xi.length < 2) return '';
    var a = xi[0] || {}, b = xi[1] || {};
    var pa = a.players || [], pb = b.players || [];
    var n = Math.max(pa.length, pb.length);
    if (!n) return '';
    var cell = function (p) {
      if (!p) return '';
      return esc(p.name) + (p.captain ? ' (c)' : '') + (p.wk ? ' (wk)' : '');
    };
    var rows = '';
    for (var i = 0; i < n; i++) {
      rows += '<tr><td class="ci-num">' + (i + 1) + '</td><td>' + cell(pa[i]) + '</td><td>' + cell(pb[i]) + '</td></tr>';
    }
    return '<h2>Playing XI</h2><div class="ci-scroll"><table class="ci-table ci-xi-table">' +
      '<thead><tr><th class="ci-num">No.</th><th>' + esc(cleanName(a.team || '')) + '</th><th>' + esc(cleanName(b.team || '')) + '</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function playingXiHtml(m) {
    var r = resolveXi(m);
    if (!r) return '';
    return playingXiTableHtml(r.xi);
  }

  /* Playing XI panel: the baked panel carries the squads + the "never
     confirmed" note. Once the XI is announced (toss), replace that
     note <p> with the XI table and HIDE the baked squad sections —
     the tab shows ONLY the XI (Cricinfo-style); the squads stay in
     the DOM and come back if the XI ever disappears. The table comes
     from the RESOLVED XI (playingXiHtml -> resolveXi): the raw feed
     XI is never used here — only the resolved XI (verified first,
     else PBP-validated feed) is trusted.
     Before the toss resolveXi returns null and the note stays.
     Robust note match ('never confirmed' OR 'not announced' OR
     'announced at the toss') so a wording change cannot silently
     leave the "no playing XI" note up. Idempotent: the note is gone
     after the first fill, so later polls refresh the table in place. */
  function fillPlayingXiPanel(m) {
    var panel = document.getElementById('ci-panel-playingxi');
    if (!panel) return;
    var table = playingXiHtml(m);
    if (!table) return;
    var note = null;
    $all('p', panel).forEach(function (p) {
      if (!note && (p.textContent.indexOf('never confirmed') !== -1 ||
                    p.textContent.indexOf('not announced') !== -1 ||
                    p.textContent.indexOf('announced at the toss') !== -1)) note = p;
    });
    if (note) note.outerHTML = table;
    else {
      var old = panel.querySelector('.ci-xi-table');
      if (old) old.outerHTML = table;
      else panel.insertAdjacentHTML('afterbegin', table);
    }
    $all('.ci-squad-sec', panel).forEach(function (s) { setHidden(s, true); });
  }

  /* Partnerships from the full current-period PBP (Cricinfo Stats tab):
     walk the balls chronologically, split at each wicket. The pair is
     the two batters at the crease for the stand (batsman + otherBatsman
     on each ball; the batting order fills a missing partner — ESPN
     omits otherBatsman on some wicket balls). Runs are the stand's
     runs, extras included (ESPN convention). Biggest first, top 8 —
     the same markup as the baked Stats tab. */
  function livePartnershipsHtml(m) {
    var period = currentPeriod(m);
    var balls = (m.commentary || []).filter(function (b) {
      return (b.period || period) === period;
    }).slice().reverse();
    if (!balls.length) return '';
    var g = inningsInProgress(m);
    var order = ((g && g.batting) || []).map(function (b) { return b.name; });
    var outSet = {};
    var pairs = [];
    var cur = null;
    var wkts = 0;
    balls.forEach(function (b) {
      var a = String(b.batsman || '').trim();
      var o = String(b.otherBatsman || '').trim();
      if (!cur) {
        cur = { a: a, b: o, runs: 0 };
        if (!cur.b) {
          for (var i = 0; i < order.length; i++) {
            if (order[i] !== cur.a && !outSet[order[i]]) { cur.b = order[i]; break; }
          }
        }
      } else {
        if (a && a !== cur.a && !cur.b) cur.b = a;
        if (o && o !== cur.a && !cur.b) cur.b = o;
      }
      cur.runs += parseInt(b.runs || '0', 10);
      if (String(b.dismissal || '').trim()) {
        wkts++;
        var dismissed = a;
        var survivor = o || ((dismissed === cur.a) ? cur.b : cur.a);
        outSet[dismissed] = true;
        pairs.push({ pair: survivor + (dismissed ? ' + ' + dismissed : ''), runs: cur.runs, wk: wkts });
        cur = { a: survivor, b: '', runs: 0 };
      }
    });
    if (cur && cur.a) pairs.push({ pair: cur.a + (cur.b ? ' + ' + cur.b : ''), runs: cur.runs, wk: null });
    pairs = pairs.filter(function (p) { return p.pair && p.pair.indexOf(' + ') !== -1; });
    pairs.sort(function (a, b) { return b.runs - a.runs; });
    var top = pairs.slice(0, 8);
    if (!top.length) return '';
    var mx = 0;
    top.forEach(function (p) { if (p.runs > mx) mx = p.runs; });
    if (!mx) mx = 1;
    var html = '<h2>Partnerships</h2>';
    top.forEach(function (p) {
      var wktxt = p.wk ? ' — ' + p.wk + ' wicket' : ' — unbroken';
      var pct = Math.round(p.runs / mx * 100);
      html += '<div class="ci-partner"><div class="ci-partner-row"><span>' + esc(p.pair) +
        '</span><span><b>' + p.runs + '</b>' + esc(wktxt) + '</span></div>' +
        '<div class="ci-partner-bar"><i style="width:' + pct + '%"></i></div></div>';
    });
    return html;
  }

  /* Manhattan (Cricinfo Stats tab): runs scored in each over, per
     innings, from the over timelines. Wicket overs are red. The same
     markup as the baked Stats tab. */
  function liveManhattanHtml(m) {
    var tls = [];
    if ((m.overTimelinePrev || []).length) tls.push(m.overTimelinePrev);
    if ((m.overTimeline || []).length) tls.push(m.overTimeline);
    if (!tls.length) return '';
    var html = '<h2>Manhattan</h2>';
    tls.forEach(function (tl) {
      var bars = tl.slice().sort(function (a, b) { return overNum(a.label) - overNum(b.label); });
      if (!bars.length) return;
      var mx = 1;
      bars.forEach(function (o) { if ((o.runs || 0) > mx) mx = o.runs || 0; });
      var team = bars[0].team || '';
      html += '<p class="ci-subhead">' + esc(team) + '</p><div class="ci-manhattan">' +
        bars.map(function (o) {
          var h = Math.max(2, Math.round((o.runs || 0) / mx * 100));
          return '<i style="height:' + h + '%"' + ((o.wickets || 0) ? ' class="is-w"' : '') +
            ' title="Over ' + overNum(o.label) + ': ' + (o.runs || 0) + ' runs"></i>';
        }).join('') + '</div>';
    });
    return html;
  }

  /* Run Rate Graph (Cricinfo Stats tab): cumulative run rate after each
     over, per innings, from the over timelines. Same SVG shape as the
     baked Stats tab (320x170, blue = 1st innings, grey = 2nd). */
  function liveRunRateGraphHtml(m) {
    var tls = [];
    if ((m.overTimelinePrev || []).length) tls.push(m.overTimelinePrev);
    if ((m.overTimeline || []).length) tls.push(m.overTimeline);
    if (!tls.length) return '';
    var series = [];
    tls.forEach(function (tl, idx) {
      var bars = tl.slice().sort(function (a, b) { return overNum(a.label) - overNum(b.label); });
      var cumRuns = 0, cumBalls = 0;
      var pts = [[0, 0]];
      bars.forEach(function (o) {
        cumRuns += (o.runs || 0);
        (o.tokens || []).forEach(function (t) { if (isLegalToken(t)) cumBalls++; });
        pts.push([overNum(o.label), cumBalls ? cumRuns * 6 / cumBalls : 0]);
      });
      if (pts.length >= 2) series.push({ inn: idx + 1, pts: pts, team: bars[0].team || '' });
    });
    if (!series.length) return '';
    var maxRr = 1, maxOv = 1;
    series.forEach(function (s) {
      s.pts.forEach(function (p) {
        if (p[1] > maxRr) maxRr = p[1];
        if (p[0] > maxOv) maxOv = p[0];
      });
    });
    var W = 320, H = 170, PL = 28, PB = 22;
    var xy = function (ov, rr) {
      return [PL + (ov / Math.max(maxOv, 1)) * (W - PL - 8),
        (H - PB) - (rr / (maxRr * 1.1)) * (H - PB - 14)];
    };
    var colors = { 1: '#0b5ed7', 2: '#5f6368' };
    var svg = ['<svg viewBox="0 0 320 170" role="img" aria-label="Run rate graph">'];
    [0, Math.round(maxRr * 10) / 10].forEach(function (gv) {
      var y = xy(0, gv)[1];
      svg.push('<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - 8) + '" y2="' + y.toFixed(1) +
        '" stroke="#eeeeee"/><text x="4" y="' + (y + 3).toFixed(1) + '" font-size="10" fill="#8a8f98">' + gv + '</text>');
    });
    svg.push('<text x="' + PL + '" y="' + (H - 6) + '" font-size="10" fill="#8a8f98">0</text>' +
      '<text x="' + (W - 16) + '" y="' + (H - 6) + '" font-size="10" fill="#8a8f98">' + maxOv + ' ov</text>');
    series.forEach(function (s) {
      var d = s.pts.map(function (p) {
        var p2 = xy(p[0], p[1]);
        return p2[0].toFixed(1) + ',' + p2[1].toFixed(1);
      }).join(' ');
      svg.push('<polyline points="' + d + '" fill="none" stroke="' + colors[s.inn] + '" stroke-width="2"/>');
    });
    svg.push('</svg>');
    var legend = '<p class="ci-worm-legend">' + series.map(function (s) {
      return '<i' + (s.inn === 2 ? ' style="background:#5f6368"' : '') + '></i>' + esc(s.team);
    }).join(' &nbsp; ') + '</p>';
    return '<h2>Run Rate Graph</h2>' + svg.join('') + legend;
  }

  function liveStatsHtml(m) {
    var live = m.live || {};
    var g = inningsInProgress(m);
    var bat = (g && g.batting) || [];
    var bowl = (g && g.bowling) || [];
    if (m.status === 'upcoming' || (!bat.length && !bowl.length)) {
      return '<p class="ci-yet">Live stats appear here once the match starts.</p>';
    }
    /* Full tables from the in-progress innings (dismissed players
       included) — the live block carries only the crease pair + the
       current/other bowler. Crease flags map to the table's * marks;
       the current bowler is name-matched against the live block. */
    var batters = bat.map(function (b) {
      return { name: b.name, runs: b.runs, balls: b.balls, fours: b.fours, sixes: b.sixes, sr: b.sr,
        striker: b.crease === 'striker' };
    });
    var curBowler = null;
    (live.bowlers || []).forEach(function (bw) { if (bw.current) curBowler = bw.name; });
    var bowlers = bowl.map(function (b) {
      return { name: b.name, overs: b.overs, maidens: b.maidens, runs: b.runs, wickets: b.wickets,
        econ: b.econ, current: b.name === curBowler };
    });
    /* Cricinfo Stats order: Partnerships, Manhattan, Run Rate Graph,
       Worm, then the full tables + Scoring Breakdown + info rows. */
    var html = '<h2>Live Stats</h2>';
    html += livePartnershipsHtml(m);
    html += liveManhattanHtml(m);
    html += liveRunRateGraphHtml(m);
    html += '<div class="ci-worm-slot" data-ci-worm></div>';
    html += battersTable(batters, m) + bowlersTable(bowlers, m);
    /* Scoring breakdown (image-122): Sixes / Fours / Runs in Boundaries
       from the in-progress innings' batting sums — only when the feed
       carries fours/sixes (the static snapshot's reduced innings do not).
       Power Play / Middle Overs / Dot-ball % are not shown live (not in
       the defect list), so they are omitted, never guessed. */
    var hasFigs = bat.length > 0 && bat.every(function (x) { return x.fours != null && x.sixes != null; });
    if (hasFigs) {
      var fours = 0, sixes = 0;
      bat.forEach(function (x) {
        fours += parseInt(x.fours || '0', 10);
        sixes += parseInt(x.sixes || '0', 10);
      });
      html += '<p class="ci-subhead">Scoring Breakdown</p>' +
        '<p class="ci-breakdown-team"><b>' + esc(g.team || '') + '</b></p>' +
        '<table class="ci-breakdown"><thead><tr><th>Stat</th><th class="ci-num">Value</th></tr></thead><tbody>' +
        '<tr><td>Sixes</td><td>' + sixes + '</td></tr>' +
        '<tr><td>Fours</td><td>' + fours + '</td></tr>' +
        '<tr><td>Runs in Boundaries</td><td>' + (4 * fours + 6 * sixes) + '</td></tr>' +
        '</tbody></table>';
    }
    var rows = [];
    var crr = runRate(m);
    if (crr) rows.push(['Current run rate', crr]);
    var all = (m.commentary || []).slice().reverse();
    if (all.length) {
      var last5 = all.slice(-5).map(function (b) { var t = ballToken(b); return t === '0' ? '•' : t; });
      rows.push(['Last 5 balls', last5.join(' ')]);
    }
    var balls = g ? ballsOf(g.overs) : 0;
    if (crr && balls > 0 && balls < 120) {
      rows.push(['Projected score', String(Math.round(parseFloat(crr) * 20)) + ' (at the current run rate, 20 overs)']);
    }
    if (rows.length) {
      html += '<div class="ci-scroll"><table class="ci-table"><tbody>' +
        rows.map(function (r) {
          return '<tr><td class="ci-name">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    return html;
  }

  /* Worm: re-draw from the over timeline + the current total. The timeline
     is the full over-by-over list when the endpoint sent it; with an old
     window-only payload it holds only the last 3 overs, so the line starts
     at its oldest over — never from (0,0), which would fabricate the early
     trajectory — except when the timeline starts at over 1 (the feed covers
     from the start).
     Fills EVERY [data-ci-worm] slot (rail + Live Stats tab). The baked
     result worm has no data-ci-worm attribute, so it is never touched.
     Stroke stays #0b5ed7 (the match content area is the Cricinfo-blue
     exception by design). */
  function renderWorm(m) {
    var wraps = $all('[data-ci-worm]');
    if (!wraps.length) return;
    var ps = periodScore(m);
    if (!ps.team || !ps.score) return;
    var tl = (m.overTimeline || (m.live && m.live.recentOvers) || []).slice();
    tl = tl.filter(function (o) { return !isNaN(overNum(o.label)); });
    tl.sort(function (a, b) { return overNum(a.label) - overNum(b.label); });
    if (!tl.length) return;
    var later = 0, cum = {}, i;
    for (i = tl.length - 1; i >= 0; i--) {
      cum[overNum(tl[i].label)] = ps.score.runs - later;
      later += (tl[i].runs || 0);
    }
    var points = [];
    if (overNum(tl[0].label) === 1) points.push([0, 0]);
    tl.forEach(function (o) { points.push([overNum(o.label), cum[overNum(o.label)]]); });
    if (points.length < 2) return;
    var maxRuns = Math.max(125, Math.ceil(ps.score.runs / 25) * 25);
    var X = function (o) { return 40 + o * 25; };
    var Y = function (r) { return 150 - r * (130 / maxRuns); };
    var f = function (n) { return (Math.round(n * 100) / 100).toString(); };
    var svg = '<svg viewBox="0 0 560 180" width="100%" role="img" aria-label="Worm chart: ' + esc(ps.team) + ' runs by over">';
    for (var o = 0; o <= 20; o += 5) {
      svg += '<line x1="' + f(X(o)) + '" y1="20" x2="' + f(X(o)) + '" y2="150" stroke="#e8e8e8"/>' +
        '<text x="' + f(X(o)) + '" y="168" font-size="11" text-anchor="middle" fill="#666">' + o + '</text>';
    }
    for (var r = 0; r <= maxRuns; r += 25) {
      svg += '<line x1="40" y1="' + f(Y(r)) + '" x2="540" y2="' + f(Y(r)) + '" stroke="#f0f0f0"/>' +
        '<text x="34" y="' + f(Y(r) + 4) + '" font-size="11" text-anchor="end" fill="#666">' + r + '</text>';
    }
    svg += '<polyline points="' + points.map(function (p) { return f(X(p[0])) + ',' + f(Y(p[1])); }).join(' ') +
      '" fill="none" stroke="#0b5ed7" stroke-width="2.5"/>';
    points.forEach(function (p) {
      svg += '<circle cx="' + f(X(p[0])) + '" cy="' + f(Y(p[1])) + '" r="4" fill="#0b5ed7"/>';
    });
    svg += '<text x="40" y="14" font-size="12" font-weight="700" fill="#111">' +
      esc(ps.team) + ' — ' + esc(ps.score.runs + '/' + ps.score.wkts) + ' (' + esc(ps.overs || '') + ' ov)</text></svg>';
    if (svg === lastWormSvg) return;
    lastWormSvg = svg;
    wraps.forEach(function (wrap) { wrap.innerHTML = svg; });
  }

  /* ---------- title / H1 on state change ---------- */

  function ordinal(n) {
    n = parseInt(n, 10) || 0;
    if (n % 100 >= 11 && n % 100 <= 13) return n + 'th';
    var s = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10];
    return n + (s || 'th');
  }

  function dateLong(iso) {
    var p = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!p) return '';
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    return months[parseInt(p[2], 10) - 1] + ' ' + parseInt(p[3], 10) + ', ' + p[1];
  }

  function cleanName(name) { return String(name || '').replace(/\s*\([^)]*\)/g, '').trim(); }
  /* Strip only the league code the feed appends to team names
     ("Lumbini Lions (NPL)") — any other parenthetical stays. */
  function stripLeague(text) { return String(text || '').replace(/ \((NPL|ILT20|APL)\)/g, ''); }

  /* Cricinfo result line: short team name + "(with N balls remaining)".
     (The JS TEAM_SHORT map gives mascot names — 'Lions' — which are
     WRONG here; this map matches build.py's Python TEAM_SHORT.) */
  var RESULT_SHORT = {
    'Biratnagar Kings': 'Biratnagar', 'Lumbini Lions': 'Lumbini',
    'Kathmandu Gorkhas': 'Kathmandu', 'Sudur Paschim Royals': 'Sudur Paschim',
    'Janakpur Bolts': 'Janakpur', 'Chitwan Rhinos': 'Chitwan',
    'Karnali Yaks': 'Karnali', 'Pokhara Avengers': 'Pokhara'
  };
  function resultLineText(text) {
    var t = stripLeague(text);
    t = t.replace(/^(.+?)\s+won by/i, function (m0, who) {
      return (RESULT_SHORT[who.trim()] || who.trim()) + ' won by';
    });
    t = t.replace(/\((\d+) (balls? remaining)\)/, '(with $1 $2)');
    return t;
  }

  function applyTitle(m, ident) {
    var no = m.matchNo || ident.matchNo;
    if (m.status === 'live' && (hasStarted(m) || m.toss)) {
      /* LIVE H1 — same format the builder bakes for a live page
         (build.py live_h1): fixture order, scores as they stand, one
         state word. Before this the H1 kept the baked "Preview" text
         for the whole match: the live title fix (f292bf2c) updated
         document.title only. A side yet to bat shows no score.
         Gated on started-or-toss: in the phantom pre-start window
         (the endpoint flags the match live ~15 min before kickoff,
         no toss yet) the baked "Preview" H1 stays; once the toss is
         done the H1 flips to Live even before the first ball. The
         document title below still stays put until a batting score
         exists. */
      var h1 = $('[data-ci-h1]');
      if (h1) {
        var n1 = cleanName(m.team1), n2 = cleanName(m.team2);
        var left = n1 + (m.score1 ? ' ' + m.score1 : '');
        var right = n2 + (m.score2 ? ' ' + m.score2 : '');
        var h1Text = left + ' vs ' + right + ' — Match ' + (no || '') + ' Live';
        if (h1.textContent !== h1Text) h1.textContent = h1Text;
      }
      var bat = battingNow(m);
      if (!bat || !bat.score) return;
      var code = TEAM_CODE[cleanName(bat.team)] || cleanName(bat.team);
      var other = cleanName(bat.team) === cleanName(m.team1) ? m.team2 : m.team1;
      var otherCode = TEAM_CODE[cleanName(other)] || cleanName(other);
      var title = code + ' ' + bat.score;
      if (bat.overs) title += ' (' + bat.overs + ' ov';
      var live = m.live || {};
      var inner = [];
      (live.batters || []).slice(0, 2).forEach(function (b) {
        if (b && b.name) inner.push(b.name + ' ' + (b.runs || 0) + '*');
      });
      var bowl = (live.bowlers || [])[0];
      if (bowl && bowl.name) inner.push(bowl.name + ' ' + (bowl.wickets || 0) + '/' + (bowl.runs || 0));
      if (inner.length) title += ', ' + inner.join(', ');
      title += ', ' + code + ' vs ' + otherCode + ' live score';
      if (no) title += ', ' + ordinal(no) + ' Match';
      if (ident.league === 'npl') title += ', Tribhuvan University International Cricket Ground, Kirtipur';
      else if (ident.league === 'ilt20' && m.venue) title += ', ' + m.venue;
      var d = dateLong(m.date);
      if (d) title += ', ' + d;
      if (bat.overs) title += ')';
      if (document.title !== title) document.title = title;
    } else if (m.status === 'result') {
      var s1 = TEAM_SHORT[cleanName(m.team1)] || cleanName(m.team1);
      var s2 = TEAM_SHORT[cleanName(m.team2)] || cleanName(m.team2);
      var rTitle = s1 + ' vs ' + s2 + ' ' + ident.league.toUpperCase() + ' Match ' + no + ' — Scorecard & Result';
      if (no && document.title !== rTitle) document.title = rTitle;
      var h1 = $('[data-ci-h1]');
      var win = /^(.+?)\s+won by/i.exec(cleanName(m.statusText || ''));
      if (h1 && win && m.score1 && m.score2) {
        var wname = win[1].trim();
        var t1 = cleanName(m.team1), t2 = cleanName(m.team2);
        var wscore, lname, lscore;
        if (wname === t1) { wscore = m.score1; lname = t2; lscore = m.score2; }
        else if (wname === t2) { wscore = m.score2; lname = t1; lscore = m.score1; }
        if (wscore) {
          /* Loser first, winner second — the same order as the header
             team rows (Cricinfo). The document title stays
             winner-first (locked). */
          var h1Text = lname + ' ' + lscore + ' vs ' + wname + ' ' + wscore + ' — Match ' + (no || '') + ' Result';
          if (h1.textContent !== h1Text) h1.textContent = h1Text;
        }
      }
    }
  }

  /* ---------- one poll render ---------- */

  /* Strip sync (defect 1): the match strip polls the same endpoint on
     its own 30s cadence (flash-scores.js), so it can sit a poll behind
     the header — the user saw 24/2 in the strip while the header showed
     30/2. After every render, update this match's strip card(s) from
     the SAME payload the header just used, so the two can never
     disagree by more than one poll. Mirrors flash-scores.js update
     logic (same score text, same label rule); both write check-first,
     so they never fight. Guarded: the strip fragment loads async and
     may not be there yet. */
  function syncStrip(m, ident) {
    if (!m || !ident || !ident.matchNo) return;
    var cards = $all('.st-strip .score-card[data-match-no="' + ident.matchNo + '"]');
    if (!cards.length) return;
    var shown = m.status === 'live' && (hasStarted(m) || isLiveToss(m));
    cards.forEach(function (card) {
      var label = card.querySelector('.sc-label');
      if (label) {
        var wantLive = m.status === 'live' && shown;
        var wantUpcoming = m.status === 'upcoming' || (m.status === 'live' && !shown);
        setText(label, m.status === 'result' ? 'Result' : (wantLive ? 'Live' : 'Upcoming'));
        if (label.classList.contains('live') !== wantLive) label.classList.toggle('live', wantLive);
        if (label.classList.contains('upcoming') !== wantUpcoming) label.classList.toggle('upcoming', wantUpcoming);
      }
      var rows = card.querySelectorAll('.sc-row');
      rows.forEach(function (row) {
        var txt = row.textContent || '';
        var isTeam2 = (m.abbr2 && txt.indexOf(m.abbr2) !== -1) ||
          (m.team2 && txt.indexOf(cleanName(m.team2)) !== -1);
        var s = isTeam2
          ? ((m.score2 || '') + (m.overs2 ? ' (' + m.overs2 + ' ov)' : ''))
          : ((m.score1 || '') + (m.overs1 ? ' (' + m.overs1 + ' ov)' : ''));
        if (!s) return;
        var span = row.querySelector('.sc-score');
        if (!span) { span = document.createElement('span'); span.className = 'sc-score'; row.appendChild(span); }
        setText(span, s);
      });
    });
  }

  function render(m, fetchedAt, ident) {
    headerHtml(m);
    function fill(id, html) {
      var panel = document.getElementById('ci-panel-' + id);
      if (!panel) return;
      var slot = $('[data-ci-live-slot]', panel);
      if (!slot) {
        /* Panels without a baked live-slot (scorecard, overs, live
           stats): build one around the baked content, so a live fill
           never destroys the baked subtabs or the baked squads note —
           the first fill swaps the slot's content, not the panel. */
        slot = document.createElement('div');
        slot.setAttribute('data-ci-live-slot', '');
        var subs = panel.querySelector('[data-ci-subtabs]');
        var nodes = [];
        Array.prototype.slice.call(panel.childNodes).forEach(function (n) {
          if (n !== subs) nodes.push(n);
        });
        nodes.forEach(function (n) { slot.appendChild(n); });
        if (subs && subs.nextSibling) panel.insertBefore(slot, subs.nextSibling);
        else panel.appendChild(slot);
      }
      if (slot._html === html) return;
      slot.innerHTML = html;
      slot._html = html;
    }
    /* One bad panel must not kill the rest (the M29 "no playing XI"
       bug: a throw in an earlier fill aborted render before the XI
       fill ran). Each fill is guarded; the XI fill runs early, right
       after the Live tab, so it is never blocked by a later failure. */
    function safeFill(id, html) { try { fill(id, html); } catch (e) { /* keep the other panels */ } }
    try { fill('live', livePanelHtml(m, ident)); } catch (e) { /* rebuilt on the next poll */ }
    /* Playing XI first (after Live): the resolved XI is the user's
       explicit demand, and it must not depend on the scorecard/stats
       fills succeeding. */
    var xiPanel = document.getElementById('ci-panel-playingxi');
    if (xiPanel && !xiPanel.innerHTML.trim()) {
      xiPanel.innerHTML = '<p class="ci-yet">Playing XIs are announced at the toss.</p>';
    }
    try { fillPlayingXiPanel(m); } catch (e) { /* rebuilt on the next poll */ }
    /* Pre-start: leave the baked scorecard (squads / honest note) in
       place — the live scorecard has nothing to show yet, and filling
       it would destroy the baked content. */
    if (m.status !== 'live' || hasStarted(m)) safeFill('scorecard', scorecardHtml(m));
    /* Commentary: the feed is a rolling window, so the panel is built
       once (heading + filter + groups + sentinel) and then merged group
       by group. A baked commentary panel has no container and is
       complete — it is never touched. */
    try {
      var commPanel = document.getElementById('ci-panel-commentary');
      if (commPanel) {
        if (commPanel.querySelector('[data-ci-comm-groups]')) {
          mergeCommentary(commPanel, m);
        } else if (!commPanel.querySelector('.ci-comm-group')) {
          var commHtml = commentaryHtml(m);
          if (commPanel._html !== commHtml) {
            commPanel.innerHTML = commHtml;
            commPanel._html = commHtml;
            if (ident) setupCommScroll(ident, m);
          }
        }
      }
    } catch (e) { /* commentary is rebuilt on the next poll */ }
    safeFill('overs', oversHtml(m));
    /* Live Stats merged into the Stats tab (Cricinfo re-sequence):
       fill it only while live — on the result flip the baked page is
       rebuilt by the bake, and a fill here would overwrite the live
       stats with the "not started" line. */
    if (m.status === 'live') safeFill('stats', liveStatsHtml(m));
    /* The worm goes last: the Stats fill above (re)creates its slot —
       and the Live tab's slot is in the live fill above. */
    try { renderWorm(m); } catch (e) { /* redrawn on the next poll */ }
    /* Strip sync: this match's strip card from the same payload. */
    try { syncStrip(m, ident); } catch (e) { /* the strip's own poll covers it */ }
  }

  /* ---------- first-paint gate (live-flash fix) ---------- */

  /* Remove the gate the inline template script added (match header /
     tabs / main hidden until the first poll resolves). A no-op when
     the gate was never added. */
  function ungate() {
    var h = document.documentElement;
    if (h.classList.contains('ci-gate')) h.classList.remove('ci-gate');
  }

  /* Is a flip to live possible right now? Only an upcoming page inside
     [kickoff - 30 min, kickoff + 6 h] can flip — the template script
     adds the gate on exactly this condition. */
  function inLiveWindow(ident) {
    if (!ident || ident.state !== 'upcoming') return false;
    var k = kickoffMs(ident);
    if (isNaN(k)) return false;
    var now = Date.now();
    return now >= k - 30 * 60 * 1000 && now <= k + 6 * 60 * 60 * 1000;
  }

  /* ---------- boot / poll loop ---------- */

  /* Overs comparison table: over-number buttons expand the ball chips.
     Delegated on document, so it survives the live fills that replace
     the panel content. */
  function wireOvers() {
    document.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-ci-ov]') : null;
      if (!btn) return;
      var row = document.querySelector('[data-ci-ov-detail="' + btn.getAttribute('data-ci-ov') + '"]');
      if (!row) return;
      var open = row.hidden;
      row.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function boot() {
    var ident = identity();
    if (!ident) return;
    wireTabs();
    wireSquads();
    wireOvers();
    wireSubtabs();
    wireStatsChips();
    wireVictims();
    wireRecent();
    wireCommentaryFilters();
    wireShare();
    document.addEventListener('click', function (ev) {
      var a = ev.target.closest ? ev.target.closest('a[data-ci-goto]') : null;
      if (!a) return;
      ev.preventDefault();
      pickedByUser = true;
      openTab(a.getAttribute('data-ci-goto'), { scroll: true });
      /* A goto link may also name an anchor inside the panel (e.g. the
         Scorecard's "View Scorecard" link targets #ci-sc-inn1): scroll
         to it once the tab is open. */
      var href = a.getAttribute('href') || '';
      if (href.charAt(0) === '#' && href.indexOf('#ci-panel-') !== 0) {
        var target = document.getElementById(href.slice(1));
        if (target) setTimeout(function () { target.scrollIntoView(); }, 0);
      }
    });

    /* Baked result: no fetch, no poll, ever. */
    if (ident.state === 'result' || ident.state === 'abandoned') {
      applyTabSet(ident.state);
      openTab(DEFAULT_TAB[ident.state] || 'summary', { silent: true });
      ungate();
      return;
    }
    applyTabSet(ident.state);
    openTab(DEFAULT_TAB[ident.state] || 'summary', { silent: true });
    renderCountdown(ident);
    /* No flip possible (outside the live window): paint the baked
       state at once. Inside the window the gate stays until the first
       poll resolves. */
    if (!inLiveWindow(ident)) ungate();
    /* 8 s fallback: a slow/dead feed — or a hidden tab that never
       polls — must never leave the gate on. */
    setTimeout(ungate, 8000);

    function schedule(delay) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, delay);
    }

    function tick() {
      if (document.hidden) return;
      renderCountdown(ident);
      loadMatch(ident).then(function (res) {
        var m = res.match;
        if (!m) { schedule(POLL_FAST); return; }
        if (m.status === 'upcoming' || (m.status === 'live' && !hasStarted(m) && !m.toss)) {
          /* Pre-start live window WITHOUT a toss (phantom-live): the
             endpoint flags the match live ~15 min before kickoff, but
             no ball has been bowled and no toss has happened. Keep
             the baked Preview state — no H1 flip, no tab switch, no
             panel fill — and update only the toss line in place. The
             Playing XI panel is the one exception: once the feed
             carries the XI (from the toss), its note is replaced.
             WITH a toss the match is genuinely live (toss window) —
             it falls through below: render + H1 flip + live tabs. */
          var tossEl = $('[data-ci-toss]');
          if (tossEl && m.toss) setText(tossEl, m.toss);
          try { fillPlayingXiPanel(m); } catch (e) { /* XI fill must never break the page */ }
          /* Pre-start: the baked Preview is the correct state — reveal it. */
          ungate();
          var delay = POLL_FAST;
          var kick = kickoffMs(ident);
          if (!isNaN(kick) && kick - Date.now() > NEAR_KICKOFF) delay = POLL_SLOW;
          schedule(delay);
          return;
        }
        /* Same feed as last poll: render nothing. Every panel fill
           rewrites innerHTML, so re-rendering identical data is the
           visible refresh the user sees every 30 s. The countdown
           above already ticked; the status block below still runs. */
        var sig = JSON.stringify(m);
        if (sig !== lastFeedSig) {
          lastFeedSig = sig;
          try { render(m, res.fetchedAt, ident); } catch (e) { /* live render must never break the page */ }
          /* Title tracks the score, not just the state: the feed
             changed, so recompute the score-led title. applyTitle
             writes only when the string actually changed. */
          try { applyTitle(m, ident); } catch (e) { /* title must never break the page */ }
        }
        if (m.status !== seenStatus) {
          applyTabSet(m.status);
          if (!pickedByUser) openTab(DEFAULT_TAB[m.status] || 'live', { silent: true });
        }
        seenStatus = m.status;
        /* First poll resolved: the live state is rendered and the tabs
           are in live order — reveal the page. */
        ungate();
        if (m.status === 'result') return; /* final state shown once; the bake takes over */
        schedule(POLL_FAST);
      }).catch(function () { ungate(); schedule(POLL_FAST); });
    }

    tick();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    /* Countdown ticks once a minute while the match is still upcoming. */
    setInterval(function () {
      if (seenStatus === '' || seenStatus === 'upcoming') renderCountdown(ident);
    }, 60000);
  }

  /* Test hook: pure renderers for a harness, with a fake feed match. */
  window.sialtvMatchLive = {
    TABS_BY_STATE: TABS_BY_STATE,
    LABELS_BY_STATE: LABELS_BY_STATE,
    openTab: openTab,
    applyTabSet: applyTabSet,
    applyTitle: applyTitle,
    runRate: runRate,
    battingNow: battingNow,
    hasStarted: hasStarted,
    isLiveToss: isLiveToss,
    mergedInnings: mergedInnings,
    currentPeriod: currentPeriod,
    periodScore: periodScore,
    fallOfWickets: fallOfWickets,
    overNum: overNum,
    commentaryGroups: commentaryGroups,
    commentaryGroupsHtml: commentaryGroupsHtml,
    overDetailRows: overDetailRows,
    thisSpell: thisSpell,
    byeRunsInOver: byeRunsInOver,
    lastFiveOv: lastFiveOv,
    chaseLine: chaseLine,
    extrasFromPbp: extrasFromPbp,
    liveDetailsHtml: liveDetailsHtml,
    batterVsBowler: batterVsBowler,
    batterLast10Ov: batterLast10Ov,
    bowlerSpell: bowlerSpell,
    bowlerBoundaries: bowlerBoundaries,
    battersTable: battersTable,
    bowlersTable: bowlersTable,
    renderWorm: renderWorm,
    syncStrip: syncStrip,
    mergeCommentary: mergeCommentary,
    setupCommScroll: setupCommScroll,
    livePanelHtml: livePanelHtml,
    scorecardHtml: scorecardHtml,
    commentaryHtml: commentaryHtml,
    oversHtml: oversHtml,
    liveStatsHtml: liveStatsHtml,
    livePartnershipsHtml: livePartnershipsHtml,
    liveManhattanHtml: liveManhattanHtml,
    liveRunRateGraphHtml: liveRunRateGraphHtml,
    playingXiHtml: playingXiHtml,
    resolveXi: resolveXi,
    fillPlayingXiPanel: fillPlayingXiPanel,
    ungate: ungate,
    inLiveWindow: inLiveWindow
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

/* Back-to-top floating button (2026-11-15) — match-page route.
   Match pages built WITHOUT the masthead fragment loader (NPL match-27
   and match-28; the fragment reaches 469/471 sitemap pages, these two do
   not) get the button here instead: this file already loads on every
   match page (defer). Guard first: pages WITH #mastheadMount get the
   button from the fragment + /js/search.js, so this creates nothing there
   (no duplicates, no timing race with the async fragment fetch). Same
   markup, id, class and behaviour as the fragment route; styling is the
   shared .st-to-top rule in /style.css, which every page links. */
(function () {
  'use strict';

  if (document.getElementById('mastheadMount')) return;
  if (document.getElementById('st-to-top')) return;

  var btn = document.createElement('button');
  btn.id = 'st-to-top';
  btn.className = 'st-to-top';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Back to top');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  document.body.appendChild(btn);

  var SHOW_AFTER = 400;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ticking = false;

  function update() {
    ticking = false;
    var y = window.scrollY || window.pageYOffset || 0;
    btn.classList.toggle('is-visible', y > SHOW_AFTER);
  }

  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  btn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  });
  update();
})();
