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
 *       "live":null}], "fetchedAt":"..."}
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
    'Karnali Yaks': 'KAY', 'Pokhara Avengers': 'POA'
  };
  var TEAM_SHORT = {
    'Biratnagar Kings': 'Kings', 'Lumbini Lions': 'Lions',
    'Kathmandu Gorkhas': 'Gorkhas', 'Sudur Paschim Royals': 'Royals',
    'Janakpur Bolts': 'Bolts', 'Chitwan Rhinos': 'Rhinos',
    'Karnali Yaks': 'Yaks', 'Pokhara Avengers': 'Avengers'
  };

  /* Tab sets per state. Panel ids are ci-panel-<key>; tab links carry
     data-ci-panel="<key>". */
  var TABS_BY_STATE = {
    upcoming: ['summary', 'scorecard', 'stats', 'squads', 'playingxi', 'table'],
    live: ['live', 'scorecard', 'commentary', 'livestats', 'overs', 'playingxi', 'table'],
    result: ['summary', 'scorecard', 'commentary', 'stats', 'overs', 'table'],
    abandoned: ['summary', 'scorecard', 'stats', 'squads', 'playingxi', 'table']
  };
  var DEFAULT_TAB = { upcoming: 'summary', live: 'live', result: 'scorecard', abandoned: 'summary' };

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
    var current = null;
    $all('[data-ci-tabs] [data-ci-panel]').forEach(function (tab) {
      var k = tab.getAttribute('data-ci-panel');
      var show = set.indexOf(k) !== -1;
      tab.parentNode.hidden = !show;
      if (tab.getAttribute('aria-current') === 'true') current = k;
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
    if (days >= 1) return 'Starts in ' + days + (days === 1 ? ' day' : ' days') + ' — ' + new Date(kick).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
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

  function inningsInProgress(m) {
    var inns = (m.scorecard && m.scorecard.innings) || [];
    for (var i = 0; i < inns.length; i++) {
      var bat = inns[i].batting || [];
      for (var j = 0; j < bat.length; j++) if (bat[j].crease) return inns[i];
    }
    return inns.length ? inns[inns.length - 1] : null;
  }

  /* Fall of wickets, walked from the ball-by-ball in order. */
  function fallOfWickets(m) {
    var balls = (m.commentary || []).slice().reverse();
    var out = [], runs = 0, wkts = 0;
    balls.forEach(function (b) {
      runs += parseInt(b.runs || '0', 10);
      if (String(b.dismissal || '').trim()) {
        wkts++;
        out.push({ score: runs + '/' + wkts, name: b.batsman || '', over: b.over || '' });
      }
    });
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

  /* Which innings the feed window belongs to: innings 2 once team 2 has
     a score, else innings 1. */
  function currentPeriod(m) { return m.score2 ? 2 : 1; }

  /* The current innings' team / score / overs, by period. Walk-back
     totals must come from the innings the window belongs to, not from the
     battingNow heuristic (which is meaningless once a match is decided). */
  function periodScore(m) {
    if (currentPeriod(m) === 2) {
      return { team: m.team2, score: scoreRuns(m.score2), overs: m.overs2 };
    }
    return { team: m.team1, score: scoreRuns(m.score1), overs: m.overs1 };
  }

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
    function setScore(sel, team, score, overs) {
      var el = $(sel);
      if (!el) return;
      if (!score) { setHtml(el, '<span class="ci-yet">' + esc(team || '') + ' yet to bat</span>'); return; }
      setHtml(el, '<b>' + esc(score) + '</b> <span>' + (overs ? '(' + esc(overs) + ' ov)' : '') + '</span>');
    }
    if (m.status === 'live' || m.status === 'result') {
      setScore('[data-ci-score1]', m.team1, m.score1, m.overs1);
      setScore('[data-ci-score2]', m.team2, m.score2, m.overs2);
    }
    var result = $('[data-ci-result]');
    if (result && m.statusText) setText(result, m.statusText);
    var toss = $('[data-ci-toss]');
    if (toss && m.toss) setText(toss, m.toss);
    var rr = $('[data-ci-rr]');
    var crr = runRate(m);
    if (rr && crr) setText(rr, 'Current RR: ' + crr);
    /* The countdown stays visible until the first ball is bowled: the
       endpoint flags the match live ~15 min before kickoff, and hiding
       it then would leave the pre-start page with no clock at all.
       renderCountdown manages it from the kickoff time. */
    var cd = $('[data-ci-countdown]');
    if (cd && hasStarted(m)) setHidden(cd, true);
  }

  function battersTable(batters) {
    if (!batters || !batters.length) return '';
    var rows = batters.map(function (b) {
      return '<tr><td class="ci-name">' + esc(b.name) + (b.striker ? ' *' : '') + '</td>' +
        '<td class="ci-num">' + esc(b.runs) + '</td><td class="ci-num">' + esc(b.balls) + '</td>' +
        '<td class="ci-num">' + esc(b.fours == null ? '' : b.fours) + '</td>' +
        '<td class="ci-num">' + esc(b.sixes == null ? '' : b.sixes) + '</td>' +
        '<td class="ci-num">' + esc(b.sr == null ? '' : b.sr) + '</td></tr>';
    }).join('');
    return '<p class="ci-subhead">Batters</p><div class="ci-scroll"><table class="ci-table">' +
      '<thead><tr><th class="ci-name">Batter</th><th class="ci-num">R</th><th class="ci-num">B</th>' +
      '<th class="ci-num">4s</th><th class="ci-num">6s</th><th class="ci-num">SR</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';
  }

  function bowlersTable(bowlers) {
    if (!bowlers || !bowlers.length) return '';
    var rows = bowlers.map(function (b) {
      return '<tr><td class="ci-name">' + esc(b.name) + (b.current ? ' *' : '') + '</td>' +
        '<td class="ci-num">' + esc(b.overs == null ? '' : b.overs) + '</td>' +
        '<td class="ci-num">' + esc(b.maidens == null ? '' : b.maidens) + '</td>' +
        '<td class="ci-num">' + esc(b.runs) + '</td><td class="ci-num">' + esc(b.wickets) + '</td>' +
        '<td class="ci-num">' + esc(b.econ == null ? '' : b.econ) + '</td></tr>';
    }).join('');
    return '<p class="ci-subhead">Bowlers</p><div class="ci-scroll"><table class="ci-table">' +
      '<thead><tr><th class="ci-name">Bowler</th><th class="ci-num">O</th><th class="ci-num">M</th>' +
      '<th class="ci-num">R</th><th class="ci-num">W</th><th class="ci-num">Econ</th></tr></thead><tbody>' +
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
    var balls = (m.commentary || []).slice(0, limitBalls || undefined);
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
     back from the current total over the last 3 overs in the timeline.
     Maiden = 0 runs off 6 legal balls (a 0-run partial over is not one). */
  function overDetailRows(m) {
    var tl = ((m.live && m.live.recentOvers) || m.overTimeline || []).slice();
    if (!tl.length) return '';
    var ps = periodScore(m);
    var code = TEAM_CODE[cleanName(ps.team)] || cleanName(ps.team);
    var cumRuns = ps.score ? ps.score.runs : 0;
    var cumWkts = ps.score ? ps.score.wkts : 0;
    var cumLegal = ballsOf(ps.overs);
    var out = [];
    tl.forEach(function (o) {
      var n = overNum(o.label);
      var runs = o.runs || 0, wk = o.wickets || 0, legal = 0;
      (o.tokens || []).forEach(function (t) { if (isLegalToken(t)) legal++; });
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
        '<p class="ci-ballrow">' + (o.tokens || []).map(chipFor).join('') + '</p></div>');
      cumRuns -= runs; cumWkts -= wk; cumLegal -= legal;
    });
    return out.join('');
  }

  /* This spell: the current bowler's trailing consecutive overs in the
     timeline (image-122). The timeline holds only the last 3 overs, so
     when the run reaches its oldest over AND more overs have been bowled
     than the timeline covers, the spell is truncated — say so. */
  function thisSpell(m) {
    var live = m.live || {};
    var tl = live.recentOvers || m.overTimeline || [];
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
      runs += tl[j].runs || 0;
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

  function livePanelHtml(m, ident) {
    var live = m.live || {};
    var batters = live.batters || [];
    var bowlers = live.bowlers || [];
    var overs = live.recentOvers || m.overTimeline || [];
    if (!batters.length && !bowlers.length && !overs.length && m.status === 'upcoming') {
      return '<p class="ci-yet">Match yet to begin. Live updates appear here once the match starts.</p>';
    }
    if (m.status === 'live' && !hasStarted(m)) {
      /* Pre-start live window: the endpoint flags the match live ~15
         min before kickoff, but no ball has been bowled. Show the toss,
         a countdown and the first-ball line — never an empty Match
         Centre. The feed carries no XI, so link to the Playing XI tab
         (baked) instead of inventing one. */
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
    if (crr) html += '<p class="ci-meta">Current RR: ' + esc(crr) + '</p>';
    html += battersTable(batters) + bowlersTable(bowlers);
    var spell = thisSpell(m);
    if (spell) html += '<p class="ci-meta">' + esc(spell) + '</p>';
    if (batters.length >= 2) {
      var r0 = parseInt(batters[0].runs || '0', 10) + parseInt(batters[1].runs || '0', 10);
      var b0 = parseInt(batters[0].balls || '0', 10) + parseInt(batters[1].balls || '0', 10);
      html += '<p class="ci-meta">Partnership: ' + r0 + ' runs (' + b0 + ' balls)</p>';
    }
    /* Last Bat + latest fall of wicket, from the feed's lastWicket. The
       old window-relative FOW walk printed wrong scores here, and the
       full fall list is not in the feed — only the latest fall is shown. */
    var lw = live.lastWicket;
    if (lw && (lw.name || lw.fow)) {
      if (lw.name) {
        html += '<p class="ci-meta">Last Bat: ' + esc(lw.name) +
          (lw.runs !== '' && lw.runs != null ? ' ' + esc(lw.runs) : '') +
          (lw.balls !== '' && lw.balls != null ? ' (' + esc(lw.balls) + ')' : '') +
          (lw.dismissal ? ' — ' + esc(lw.dismissal) : '') + '</p>';
      }
      if (lw.fow) {
        html += '<p class="ci-meta">Fall of wickets: ' + esc(lw.fow) +
          (lw.name ? ' (' + esc(lw.name) + (lw.over ? ', ' + esc(lw.over) + ' ov' : '') + ')' : '') + '</p>';
      }
    }
    html += stripHtml(overs);
    html += '<h2>Match Centre</h2>' + commentaryGroupsHtml(m, 12);
    html += '<a class="ci-btn-outline" href="#ci-panel-commentary" data-ci-goto="commentary">Read Full Commentary</a>';
    return html;
  }

  function scorecardHtml(m) {
    var inns = (m.scorecard && m.scorecard.innings) || [];
    if (!inns.length) {
      if (m.status === 'live' && !hasStarted(m)) {
        return '<p class="ci-yet">Match yet to begin. The scorecard appears here once the first ball is bowled.</p>';
      }
      return '<p class="ci-yet">Match in progress — the scorecard will appear here shortly.</p>';
    }
    /* The feed window covers only the current innings. A full fall-of-
       wickets walk from it is valid only when the window starts at the
       innings' first ball ("0.1"); otherwise show the last wicket only.
       The walk is shown on the innings in progress only — never under
       the completed innings (its balls are not in the window). */
    var balls = m.commentary || [];
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
        /* Extras: the live innings carry no extras breakdown, so no
           Extras row — a bare total with no breakdown would mislead. */
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
            if (lw && lw.fow) {
              body += '<p class="ci-fow"><b>Fall of wickets:</b> ' + esc(lw.fow) +
                (lw.name ? ' (' + esc(lw.name) + (lw.over ? ', ' + esc(lw.over) + ' ov' : '') + ')' : '') + '</p>';
            }
          }
        }
        if (g.yet && g.yet.length) body += '<p class="ci-dnb"><b>Yet to bat:</b> ' + g.yet.map(esc).join(', ') + '.</p>';
        /* Fielding XI, one line (image-123): the other side's batting +
           yet-to-bat names. Omitted when the other side has not batted
           (its XI is not in the feed). Bowling-only blocks get no line. */
        var other = null;
        inns.forEach(function (h) {
          if (h !== g && h.team !== g.team && (h.batting || []).length) other = h;
        });
        if (other) {
          var xi = (other.batting || []).map(function (b) { return b.name; })
            .concat(other.yet || []);
          if (xi.length) {
            body += '<p class="ci-fieldxi"><b>' + esc(other.team || '') + ' PLAYING XI</b> — ' +
              xi.map(esc).join(', ') + '</p>';
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
    }).join('');
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
    return '<h2>Overs</h2><div class="ci-overs-grid">' + rows + '</div>' +
      '<p class="ci-note">Showing the most recent overs.</p>';
  }

  function liveStatsHtml(m) {
    var live = m.live || {};
    var batters = live.batters || [];
    if (m.status === 'upcoming' || !batters.length) {
      return '<p class="ci-yet">Live stats appear here once the match starts.</p>';
    }
    var html = '<h2>Live Stats</h2><div class="ci-worm-slot" data-ci-worm></div>';
    html += battersTable(batters) + bowlersTable(live.bowlers || []);
    /* Scoring breakdown (image-122): Sixes / Fours / Runs in Boundaries
       from the in-progress innings' batting sums — only when the feed
       carries fours/sixes (the static snapshot's reduced innings do not).
       Power Play / Middle Overs / Dot-ball % are NOT computable live
       (the timeline holds 3 overs), so they are omitted, never guessed. */
    var g = inningsInProgress(m);
    var bat = (g && g.batting) || [];
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
    if (batters.length >= 2) {
      var r0 = parseInt(batters[0].runs || '0', 10) + parseInt(batters[1].runs || '0', 10);
      var b0 = parseInt(batters[0].balls || '0', 10) + parseInt(batters[1].balls || '0', 10);
      rows.push(['Partnership', r0 + ' runs (' + b0 + ' balls)']);
    }
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
     holds only the last 3 overs, so the line starts at its oldest over —
     never from (0,0), which would fabricate the early trajectory — except
     when the timeline starts at over 1 (the feed covers from the start).
     Fills EVERY [data-ci-worm] slot (rail + Live Stats tab). The baked
     result worm has no data-ci-worm attribute, so it is never touched.
     Stroke stays #0b5ed7 (the match content area is the Cricinfo-blue
     exception by design). */
  function renderWorm(m) {
    var wraps = $all('[data-ci-worm]');
    if (!wraps.length) return;
    var ps = periodScore(m);
    if (!ps.team || !ps.score) return;
    var tl = ((m.live && m.live.recentOvers) || m.overTimeline || []).slice();
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

  function applyTitle(m, ident) {
    var no = m.matchNo || ident.matchNo;
    if (m.status === 'live') {
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
      var d = dateLong(m.date);
      if (d) title += ', ' + d;
      if (bat.overs) title += ')';
      if (document.title !== title) document.title = title;
    } else if (m.status === 'result') {
      var s1 = TEAM_SHORT[cleanName(m.team1)] || cleanName(m.team1);
      var s2 = TEAM_SHORT[cleanName(m.team2)] || cleanName(m.team2);
      var rTitle = s1 + ' vs ' + s2 + ' NPL Match ' + no + ' — Scorecard & Result';
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
          var h1Text = wname + ' ' + wscore + ' vs ' + lname + ' ' + lscore + ' — Match ' + (no || '') + ' Result';
          if (h1.textContent !== h1Text) h1.textContent = h1Text;
        }
      }
    }
  }

  /* ---------- one poll render ---------- */

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
    fill('live', livePanelHtml(m, ident));
    /* Pre-start: leave the baked scorecard (squads / honest note) in
       place — the live scorecard has nothing to show yet, and filling
       it would destroy the baked content. */
    if (m.status !== 'live' || hasStarted(m)) fill('scorecard', scorecardHtml(m));
    /* Commentary: the feed is a rolling window, so the panel is built
       once (heading + filter + groups + sentinel) and then merged group
       by group. A baked commentary panel has no container and is
       complete — it is never touched. */
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
    fill('overs', oversHtml(m));
    fill('livestats', liveStatsHtml(m));
    /* Playing XI: the feed carries no XI. Only fill a panel that is
       empty (the baked upcoming/abandoned panels already carry the
       squads + honest note, and are left alone). */
    var xiPanel = document.getElementById('ci-panel-playingxi');
    if (xiPanel && !xiPanel.innerHTML.trim()) {
      xiPanel.innerHTML = '<p class="ci-yet">Playing XIs are announced at the toss.</p>';
    }
    /* The worm goes last: the Live Stats fill above (re)creates its slot. */
    renderWorm(m);
  }

  /* ---------- boot / poll loop ---------- */

  function boot() {
    var ident = identity();
    if (!ident) return;
    wireTabs();
    wireSquads();
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
         Summary's "Match details" link targets #ci-sc-info): scroll to
         it once the tab is open. */
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
      return;
    }
    applyTabSet(ident.state);
    openTab(DEFAULT_TAB[ident.state] || 'summary', { silent: true });
    renderCountdown(ident);

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
        if (m.status === 'upcoming') {
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
        }
        if (m.status !== seenStatus) {
          applyTabSet(m.status);
          if (!pickedByUser) openTab(DEFAULT_TAB[m.status] || 'live', { silent: true });
          try { applyTitle(m, ident); } catch (e) { /* title must never break the page */ }
        }
        seenStatus = m.status;
        if (m.status === 'result') return; /* final state shown once; the bake takes over */
        schedule(POLL_FAST);
      }).catch(function () { schedule(POLL_FAST); });
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
    openTab: openTab,
    applyTabSet: applyTabSet,
    runRate: runRate,
    battingNow: battingNow,
    hasStarted: hasStarted,
    fallOfWickets: fallOfWickets,
    overNum: overNum,
    commentaryGroups: commentaryGroups,
    commentaryGroupsHtml: commentaryGroupsHtml,
    overDetailRows: overDetailRows,
    thisSpell: thisSpell,
    mergeCommentary: mergeCommentary,
    setupCommScroll: setupCommScroll,
    livePanelHtml: livePanelHtml,
    scorecardHtml: scorecardHtml,
    commentaryHtml: commentaryHtml,
    oversHtml: oversHtml,
    liveStatsHtml: liveStatsHtml
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
