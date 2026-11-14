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
    upcoming: ['summary', 'stats', 'squads', 'table'],
    live: ['live', 'scorecard', 'commentary', 'livestats', 'overs', 'playingxi', 'table'],
    result: ['summary', 'scorecard', 'commentary', 'stats', 'overs', 'table'],
    abandoned: ['summary', 'stats', 'squads', 'table']
  };
  var DEFAULT_TAB = { upcoming: 'summary', live: 'live', result: 'scorecard', abandoned: 'summary' };

  var timer = null;
  var seenStatus = '';
  var pickedByUser = false;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

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
      if (!a || a.hasAttribute('data-ci-panel')) return;
      var key = a.getAttribute('href').slice('#ci-panel-'.length);
      var tab = $('[data-ci-tabs] [data-ci-panel="' + key + '"]');
      if (!tab || tab.parentNode.hidden) return;
      ev.preventDefault();
      pickedByUser = true;
      openTab(key, { scroll: true });
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

  /* ---------- countdown (upcoming only) ---------- */

  function kickoffMs(ident) {
    if (!ident.kickoff) return NaN;
    return Date.parse(ident.kickoff);
  }

  function renderCountdown(ident) {
    var box = $('[data-ci-countdown]');
    if (!box) return;
    var kick = kickoffMs(ident);
    if (isNaN(kick)) { box.hidden = true; return; }
    var diff = kick - Date.now();
    if (diff <= 0) { box.hidden = true; return; }
    box.hidden = false;
    var text = $('[data-ci-countdown-text]', box);
    if (!text) return;
    var mins = Math.floor(diff / 60000);
    var hours = Math.floor(mins / 60);
    var days = Math.floor(hours / 24);
    if (days >= 1) text.textContent = 'Starts in ' + days + (days === 1 ? ' day' : ' days') + ' — ' + new Date(kick).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
    else if (hours >= 1) text.textContent = 'Starts in ' + hours + 'h ' + (mins % 60) + 'm';
    else if (mins >= 1) text.textContent = 'Starts in ' + mins + ' minutes';
    else text.textContent = 'Starting soon';
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

  /* ---------- renderers (endpoint data -> .ci- markup) ---------- */

  function headerHtml(m) {
    var status = $('[data-ci-status]');
    if (status) {
      var dot = $('[data-ci-dot]', status);
      if (m.status === 'live') {
        status.classList.add('is-live');
        status.childNodes.forEach(function (n) { if (n.nodeType === 3) n.textContent = ' LIVE'; });
        if (dot) dot.hidden = false;
      } else if (m.status === 'result') {
        status.classList.remove('is-live');
        status.childNodes.forEach(function (n) { if (n.nodeType === 3) n.textContent = ' RESULT'; });
        if (dot) dot.hidden = true;
      }
    }
    function setScore(sel, team, score, overs) {
      var el = $(sel);
      if (!el) return;
      if (!score) { el.innerHTML = '<span class="ci-yet">' + esc(team || '') + ' yet to bat</span>'; return; }
      el.innerHTML = '<b>' + esc(score) + '</b> <span>' + (overs ? '(' + esc(overs) + ' ov)' : '') + '</span>';
    }
    if (m.status === 'live' || m.status === 'result') {
      setScore('[data-ci-score1]', m.team1, m.score1, m.overs1);
      setScore('[data-ci-score2]', m.team2, m.score2, m.overs2);
    }
    var result = $('[data-ci-result]');
    if (result && m.statusText) result.textContent = m.statusText;
    var toss = $('[data-ci-toss]');
    if (toss && m.toss) toss.textContent = m.toss;
    var rr = $('[data-ci-rr]');
    var crr = runRate(m);
    if (rr && crr) rr.textContent = 'Current RR: ' + crr;
    var cd = $('[data-ci-countdown]');
    if (cd) cd.hidden = true;
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
    var tokens = [];
    (overs || []).slice(0, 2).forEach(function (o) {
      (o.tokens || []).forEach(function (t) { tokens.push(t); });
    });
    if (!tokens.length) return '';
    return '<div class="ci-strip">' + tokens.map(chipFor).join('') +
      ' <a href="#ci-panel-commentary" data-ci-goto="commentary">See all &rsaquo;</a></div>';
  }

  function centreRows(m, limit) {
    var balls = (m.commentary || []).slice(0, limit || 12);
    if (!balls.length) return '';
    return '<ul class="ci-comm">' + balls.map(function (b) {
      var dism = String(b.dismissal || '').trim();
      var line = '<li><span class="ci-over">' + esc(b.over || '') + '</span>' + chipFor(ballToken(b)) +
        '<span class="ci-comm-text"><span class="ci-comm-head">' + esc(b.short || b.text || '') + '</span>' +
        (dism ? '<span class="ci-wicket-box">' + esc(dism) + '</span>' : '') + '</span></li>';
      return line;
    }).join('') + '</ul>';
  }

  function overBars(m) {
    var overs = (m.live && m.live.recentOvers) || m.overTimeline || [];
    if (!overs.length) return '';
    return overs.map(function (o) {
      var toks = (o.tokens || []).map(chipFor).join('');
      return '<div class="ci-overbar"><span><b>Over ' + esc(o.label || '') + '</b> — ' +
        esc(String(o.runs)) + ' runs, ' + esc(String(o.wickets)) + ' wicket' +
        (o.bowler ? ' &middot; ' + esc(o.bowler) : '') + '</span><span>' + toks + '</span></div>';
    }).join('');
  }

  function livePanelHtml(m) {
    var live = m.live || {};
    var batters = live.batters || [];
    var bowlers = live.bowlers || [];
    var overs = live.recentOvers || m.overTimeline || [];
    if (!batters.length && !bowlers.length && !overs.length && m.status === 'upcoming') {
      return '<p class="ci-yet">Match yet to begin. Live updates appear here once the match starts.</p>';
    }
    var html = '';
    var bat = battingNow(m);
    if (bat) html += '<p><strong>' + esc(bat.team) + ' ' + esc(bat.score) + '</strong>' +
      (bat.overs ? ' (' + esc(bat.overs) + ' ov)' : '') + '</p>';
    var crr = runRate(m);
    if (crr) html += '<p class="ci-meta">Current RR: ' + esc(crr) + '</p>';
    html += battersTable(batters) + bowlersTable(bowlers);
    var fow = fallOfWickets(m);
    if (batters.length >= 2) {
      var r0 = parseInt(batters[0].runs || '0', 10) + parseInt(batters[1].runs || '0', 10);
      var b0 = parseInt(batters[0].balls || '0', 10) + parseInt(batters[1].balls || '0', 10);
      html += '<p class="ci-meta">Partnership: ' + r0 + ' runs (' + b0 + ' balls) &middot; ' +
        (fow.length ? 'FOW: ' + esc(fow[fow.length - 1].score) : 'No wicket yet') + '</p>';
    }
    html += stripHtml(overs);
    html += '<h2>Match Centre</h2>' + centreRows(m, 12);
    html += '<a class="ci-btn-outline" href="#ci-panel-commentary" data-ci-goto="commentary">Read Full Commentary</a>';
    return html;
  }

  function scorecardHtml(m) {
    var inns = (m.scorecard && m.scorecard.innings) || [];
    if (!inns.length) return '<p class="ci-yet">Match in progress — the scorecard will appear here shortly.</p>';
    var fow = fallOfWickets(m);
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
              '<td class="ci-num">' + esc(b.runs) + (out ? '*' : '') + '</td>' +
              '<td class="ci-num">' + esc(b.balls == null ? '' : b.balls) + '</td>' +
              '<td class="ci-num">' + esc(b.fours == null ? '' : b.fours) + '</td>' +
              '<td class="ci-num">' + esc(b.sixes == null ? '' : b.sixes) + '</td>' +
              '<td class="ci-num">' + esc(b.sr == null ? '' : b.sr) + '</td></tr>';
          }).join('') +
          '<tr class="ci-total"><td class="ci-name">Total</td><td></td>' +
          '<td class="ci-num" colspan="5">' + esc(g.total || '') + '</td></tr>' +
          '</tbody></table></div>';
        if (fow.length) {
          body += '<p class="ci-fow"><b>Fall of wickets:</b> ' + fow.map(function (w) {
            return esc(w.score) + ' (' + esc(w.name) + ', ' + esc(w.over) + ' ov)';
          }).join(', ') + '</p>';
        }
        if (g.yet && g.yet.length) body += '<p class="ci-dnb">Did not bat: ' + g.yet.map(esc).join(', ') + '.</p>';
      }
      if (bowl.length) {
        body += '<p class="ci-subhead">Bowling</p><div class="ci-scroll"><table class="ci-table">' +
          '<thead><tr><th class="ci-name">Bowler</th><th class="ci-num">O</th><th class="ci-num">M</th>' +
          '<th class="ci-num">R</th><th class="ci-num">W</th><th class="ci-num">Econ</th>' +
          '<th class="ci-num">WD</th><th class="ci-num">NB</th></tr></thead><tbody>' +
          bowl.map(function (b) {
            return '<tr><td class="ci-name">' + esc(b.name) + (b.current ? ' *' : '') + '</td>' +
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
    return '<h2>Commentary</h2>' + overBars(m) + centreRows(m, balls.length);
  }

  function oversHtml(m) {
    var overs = (m.live && m.live.recentOvers) || m.overTimeline || [];
    if (!overs.length) return '<p class="ci-yet">No overs yet. The over-by-over summary appears here once the match starts.</p>';
    return '<h2>Overs</h2>' + overBars(m);
  }

  function liveStatsHtml(m) {
    var live = m.live || {};
    var batters = live.batters || [];
    if (m.status === 'upcoming' || !batters.length) {
      return '<p class="ci-yet">Live stats appear here once the match starts.</p>';
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
    var g = inningsInProgress(m);
    var balls = g ? ballsOf(g.overs) : 0;
    if (crr && balls > 0 && balls < 120) {
      rows.push(['Projected score', String(Math.round(parseFloat(crr) * 20)) + ' (at the current run rate, 20 overs)']);
    }
    if (!rows.length) return '<p class="ci-yet">Live stats appear here once the match starts.</p>';
    return '<h2>Live Stats</h2><div class="ci-scroll"><table class="ci-table"><tbody>' +
      rows.map(function (r) {
        return '<tr><td class="ci-name">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* Worm: re-draw from the over timeline only when the baked rail worm
     exists ([data-ci-worm] with a baked first-innings series). Chase
     overs come from overTimeline + the current total. */
  function renderWorm(m) {
    var wrap = $('[data-ci-worm]');
    if (!wrap) return;
    var bat = battingNow(m);
    if (!bat) return;
    var total = scoreRuns(bat.score);
    if (!total) return;
    var tl = (m.overTimeline || []).slice().sort(function (a, b) {
      return (parseInt(a.label, 10) || 0) - (parseInt(b.label, 10) || 0);
    });
    var points = [[0, 0]], later = 0;
    for (var i = tl.length - 1; i >= 0; i--) {
      var n = parseInt(tl[i].label, 10);
      if (isNaN(n)) continue;
      points.unshift([n, total.runs - later]);
      later += (tl[i].runs || 0);
    }
    if (points.length < 2) points.push([Math.floor(parseFloat(bat.overs) || 0), total.runs]);
    var maxRuns = Math.max(125, Math.ceil(total.runs / 25) * 25);
    var X = function (o) { return 40 + o * 25; };
    var Y = function (r) { return 150 - r * (130 / maxRuns); };
    var f = function (n) { return (Math.round(n * 100) / 100).toString(); };
    var svg = '<svg viewBox="0 0 560 180" width="100%" role="img" aria-label="Worm chart: ' + esc(bat.team) + ' runs by over">';
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
      esc(bat.team) + ' — ' + esc(bat.score) + ' (' + esc(bat.overs || '') + ' ov)</text></svg>';
    wrap.innerHTML = svg;
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
      document.title = title;
    } else if (m.status === 'result') {
      var s1 = TEAM_SHORT[cleanName(m.team1)] || cleanName(m.team1);
      var s2 = TEAM_SHORT[cleanName(m.team2)] || cleanName(m.team2);
      if (no) document.title = s1 + ' vs ' + s2 + ' NPL Match ' + no + ' — Scorecard & Result';
      var h1 = $('[data-ci-h1]');
      var win = /^(.+?)\s+won by/i.exec(cleanName(m.statusText || ''));
      if (h1 && win && m.score1 && m.score2) {
        var wname = win[1].trim();
        var t1 = cleanName(m.team1), t2 = cleanName(m.team2);
        var wscore, lname, lscore;
        if (wname === t1) { wscore = m.score1; lname = t2; lscore = m.score2; }
        else if (wname === t2) { wscore = m.score2; lname = t1; lscore = m.score1; }
        if (wscore) {
          h1.textContent = wname + ' ' + wscore + ' vs ' + lname + ' ' + lscore + ' — Match ' + (no || '') + ' Result';
        }
      }
    }
  }

  /* ---------- one poll render ---------- */

  function render(m, fetchedAt) {
    headerHtml(m);
    renderWorm(m);
    function fill(id, html) {
      var panel = document.getElementById('ci-panel-' + id);
      if (!panel) return;
      var slot = $('[data-ci-live-slot]', panel) || panel;
      slot.innerHTML = html;
    }
    fill('live', livePanelHtml(m));
    fill('scorecard', scorecardHtml(m));
    /* Commentary merges: the feed is a rolling window, so prepend only
       balls the page does not already show (keyed by over + text). */
    var commPanel = document.getElementById('ci-panel-commentary');
    if (commPanel) {
      var slot = $('[data-ci-live-slot]', commPanel);
      if (slot) {
        if (!slot.getAttribute('data-ci-comm-seeded')) {
          slot.innerHTML = commentaryHtml(m);
          slot.setAttribute('data-ci-comm-seeded', '1');
        } else {
          var seen = {};
          $all('[data-ci-ball]', slot).forEach(function (li) { seen[li.getAttribute('data-ci-ball')] = true; });
          var fresh = (m.commentary || []).filter(function (b) {
            return !seen[(b.over || '') + '|' + (b.short || b.text || '')];
          });
          if (fresh.length) {
            var list = slot.querySelector('.ci-comm');
            fresh.forEach(function (b) {
              var li = document.createElement('li');
              li.setAttribute('data-ci-ball', (b.over || '') + '|' + (b.short || b.text || ''));
              var dism = String(b.dismissal || '').trim();
              li.innerHTML = '<span class="ci-over">' + esc(b.over || '') + '</span>' + chipFor(ballToken(b)) +
                '<span class="ci-comm-text"><span class="ci-comm-head">' + esc(b.short || b.text || '') + '</span>' +
                (dism ? '<span class="ci-wicket-box">' + esc(dism) + '</span>' : '') + '</span>';
              if (list) list.insertBefore(li, list.firstChild);
            });
          }
        }
      }
    }
    fill('overs', oversHtml(m));
    fill('livestats', liveStatsHtml(m));
  }

  /* ---------- boot / poll loop ---------- */

  function boot() {
    var ident = identity();
    if (!ident) return;
    wireTabs();
    wireSquads();
    document.addEventListener('click', function (ev) {
      var a = ev.target.closest ? ev.target.closest('a[data-ci-goto]') : null;
      if (!a) return;
      ev.preventDefault();
      pickedByUser = true;
      openTab(a.getAttribute('data-ci-goto'), { scroll: true });
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
        try { render(m, res.fetchedAt); } catch (e) { /* live render must never break the page */ }
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
    fallOfWickets: fallOfWickets,
    livePanelHtml: livePanelHtml,
    scorecardHtml: scorecardHtml,
    commentaryHtml: commentaryHtml,
    oversHtml: oversHtml,
    liveStatsHtml: liveStatsHtml
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
