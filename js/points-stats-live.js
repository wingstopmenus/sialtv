/* SialTV live points + stats — the points-table and stats pages
   re-render LIVE from the Cricinfo/ESPN feed, with no HTML bake as the
   update mechanism. The baked HTML is the initial / SEO state; this
   script updates it in place, never a reload, never a visible flash,
   never a scroll jump (Cricinfo behaviour).

   Design (see ../DATA-CONTRACT.md):
   - Points: computed from the endpoint payload's matches (scores,
     overs, status) — the same rules as live-scores.js computePoints
     and the points-table builder. No aggregate needed.
   - Stats: computed from the aggregate file
     data/runtime/<league>-stats-agg.json, fetched ONLY when the
     endpoint's statsVersion hash changes and coverage is complete.
     The compute is a function-for-function port of
     stats_compute.py (aggregate / tables / records).
   - Frozen semantics: the NPL points table and the stats Team stats
     table NEVER move on playoff results (the league table is the
     final M28 table). Player tables are season-wide and DO move.
   - Never invents: a figure the live data does not carry is omitted,
     never guessed. An incomplete aggregate keeps the baked tables.
   - Check-first writes everywhere: a no-change poll writes nothing.

   Load: <script src="/js/points-stats-live.js" defer> on the
   points-table + stats pages (and the hub/schedule/team pages for
   the minis — the script no-ops where its hooks are absent).
   No dependencies. Exposes window.sialtvPointsStats for tests.
*/
(function () {
  'use strict';

  /* ================= league config =================
     ONLY these things are league-specific (the stats_compute.LEAGUES
     rule): team map, win map, league stages, tiebreak sentence.
     Everything else is data-driven. */
  var LEAGUES = {
    npl: {
      teams: {
        BIK: { name: 'Biratnagar Kings', slug: 'biratnagar-kings' },
        CHR: { name: 'Chitwan Rhinos', slug: 'chitwan-rhinos' },
        JAB: { name: 'Janakpur Bolts', slug: 'janakpur-bolts' },
        KAG: { name: 'Kathmandu Gorkhas', slug: 'kathmandu-gorkhas' },
        KAY: { name: 'Karnali Yaks', slug: 'karnali-yaks' },
        LUL: { name: 'Lumbini Lions', slug: 'lumbini-lions' },
        POA: { name: 'Pokhara Avengers', slug: 'pokhara-avengers' },
        SPR: { name: 'Sudur Paschim Royals', slug: 'sudurpaschim-royals' }
      },
      winMap: { Lumbini: 'LUL', Chitwan: 'CHR', Karnali: 'KAY',
        Paschim: 'SPR', Janakpur: 'JAB', Biratnagar: 'BIK',
        Kathmandu: 'KAG', Pokhara: 'POA' },
      /* NPL league matches carry no stage; playoffs carry one. */
      leagueStages: [null],
      ducksDisplay: { 'Mohammad Saifuddin': 'Saifuddin' },
      fullNameOverrides: { 'Mousom Dhakal': 'Shyam Mousom Dhakal' },
      /* The points-page lead carries the NRR tiebreak sentence. */
      tiebreakSentence: true,
      basePath: '/npl/',
      seasonLabel: 'Nepal Premier League 2026/27'
    },
    ilt20: {
      teams: {
        ADKR: { name: 'Abu Dhabi Knight Riders', slug: 'abu-dhabi-knight-riders' },
        DV: { name: 'Desert Vipers', slug: 'desert-vipers' },
        DC: { name: 'Dubai Capitals', slug: 'dubai-capitals' },
        GG: { name: 'Gulf Giants', slug: 'gulf-giants' },
        MIE: { name: 'MI Emirates', slug: 'mi-emirates' },
        SW: { name: 'Sharjah Warriorz', slug: 'sharjah-warriorz' }
      },
      winMap: { 'Knight Riders': 'ADKR', Vipers: 'DV', Capitals: 'DC',
        Giants: 'GG', Emirates: 'MIE', Warriors: 'SW', Warriorz: 'SW' },
      leagueStages: ['League'],
      ducksDisplay: {},
      fullNameOverrides: {},
      tiebreakSentence: true,
      basePath: '/ilt20/',
      seasonLabel: 'ILT20 Season 5'
    },
    apl: {
      teams: {
        AUK: { name: 'Akcel United Kabul', slug: 'akcel-united-kabul' },
        BZW: { name: 'Balkh Zwanan', slug: 'balkh-zwanan' },
        KAW: { name: 'Kandahar Warriors', slug: 'kandahar-warriors' },
        NCO: { name: 'Nangarhar Cosmic', slug: 'nangarhar-cosmic' },
        PTA: { name: 'Paktia', slug: 'paktia' }
      },
      winMap: { Kabul: 'AUK', Balkh: 'BZW', Kandahar: 'KAW',
        Nangarhar: 'NCO', Paktia: 'PTA' },
      leagueStages: ['League'],
      ducksDisplay: {},
      fullNameOverrides: {},
      tiebreakSentence: false,
      basePath: '/apl/',
      seasonLabel: 'APL 2026-27'
    }
  };
  var PLAYOFF_DESCS = ['Qualifier 1', 'Qualifier 2', 'Eliminator', 'Final'];

  /* ================= utils ================= */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /* Python round() is half-even; JS Math.round is half-up. The oracle
     pins the current tables, so the JS must round the Python way or a
     0.001 edge case diverges. */
  function pyRound(x, nd) {
    var p = Math.pow(10, nd), y = x * p, f = Math.floor(y), d = y - f;
    if (d > 0.5) return (f + 1) / p;
    if (d < 0.5) return f / p;
    return (f % 2 === 0 ? f : f + 1) / p;
  }
  function pyFixed(x, nd) {
    var r = pyRound(x, nd);
    var s = String(r);
    if (nd === 0) return s;
    if (s.indexOf('e') !== -1 || s.indexOf('E') !== -1) s = r.toFixed(nd);
    if (s.indexOf('.') === -1) s += '.';
    while (s.split('.')[1].length < nd) s += '0';
    return s;
  }
  function oversToBalls(o) {
    if (o === undefined || o === null || o === '') return 0;
    var parts = String(o).split('.');
    return (parseInt(parts[0], 10) || 0) * 6 + (parseInt(parts[1], 10) || 0);
  }
  function ballsToOvers(b) { return Math.floor(b / 6) + '.' + (b % 6); }
  function oversCricket(b) { return Math.floor(b / 6) + '.' + (b % 6); }
  function parseScore(s) {
    if (!s) return null;
    var parts = String(s).split('/');
    var runs = parseInt(parts[0], 10);
    if (isNaN(runs)) return null;
    return { runs: runs, wk: parts.length > 1 ? (parseInt(parts[1], 10) || 0) : 0 };
  }
  function fmtAve(runs, outs) { return outs === 0 ? '\u2013' : pyFixed(runs / outs, 2); }
  function fmtSr(runs, balls) { return balls ? pyFixed(runs / balls * 100, 2) : '\u2013'; }
  function fmtEcon(runs, balls) { return balls ? pyFixed(runs / (balls / 6), 2) : '\u2013'; }
  function fmtBsr(balls, wkts) {
    /* Page convention: bowling SR rounded to 1dp, displayed to 2dp. */
    return wkts ? pyFixed(pyRound(balls / wkts, 1), 2) : '\u2013';
  }
  function possessive(name) {
    return name + (name.slice(-1) === 's' ? '\u2019' : '\u2019s');
  }
  var MON_S = { '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr',
    '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug', '09': 'Sep',
    '10': 'Oct', '11': 'Nov', '12': 'Dec' };
  var MON_L = { '01': 'January', '02': 'February', '03': 'March',
    '04': 'April', '05': 'May', '06': 'June', '07': 'July',
    '08': 'August', '09': 'September', '10': 'October',
    '11': 'November', '12': 'December' };
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
    'Friday', 'Saturday'];
  function dateLabel(date) { return parseInt(date.slice(8, 10), 10) + ' ' + MON_S[date.slice(5, 7)]; }
  function dateLong(date) {
    var dt = new Date(date + 'T00:00:00Z');
    return WEEKDAYS[dt.getUTCDay()] + ', ' + parseInt(date.slice(8, 10), 10) +
      ' ' + MON_L[date.slice(5, 7)] + ' ' + date.slice(0, 4);
  }
  function ordinal(n) {
    if (n % 100 >= 10 && n % 100 <= 20) return n + 'th';
    var suf = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
    return n + suf;
  }
  function tm(name, code) {
    return '<span class="tm-full">' + esc(name) + '</span>' +
      '<span class="tm-short">' + esc(code) + '</span>';
  }
  function cleanTeam(name) {
    return String(name || '').replace(/\s*\([A-Z]+\)\s*$/, '').trim();
  }
  function teamCodeOf(cfg, name) {
    var n = cleanTeam(name);
    var codes = Object.keys(cfg.teams);
    for (var i = 0; i < codes.length; i++) {
      if (cfg.teams[codes[i]].name === n) return codes[i];
    }
    return null;
  }
  function cmpStr(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  /* ================= catcher (port of stats_compute) ================= */
  function surnameOf(name) {
    var parts = String(name).split(/\s+/);
    if (parts.length >= 2 && parts[parts.length - 2].toLowerCase() === 'van') {
      return parts.slice(-2).join(' ');
    }
    return parts[parts.length - 1];
  }
  function initialsOf(fullName) {
    var parts = String(fullName).split(/\s+/);
    var given = (parts.length >= 2 && parts[parts.length - 2].toLowerCase() === 'van')
      ? parts.slice(0, -2) : parts.slice(0, -1);
    return given.map(function (p) { return p.charAt(0); }).join('');
  }
  function parseCatcher(dism) {
    if (!dism || dism.indexOf('c ') !== 0) return null;
    var rest = dism.slice(2);
    if (rest.indexOf('&amp; b ') === 0 || rest.indexOf('& b ') === 0) {
      return { token: rest.split(' b ')[1].trim(), keeper: false, sub: false, cb: true };
    }
    if (rest.indexOf('sub (') === 0) {
      return { token: rest.slice(5, rest.indexOf(')')).trim(), keeper: false, sub: true, cb: false };
    }
    var keeper = false;
    if (rest.indexOf('&dagger;') === 0) { rest = rest.slice(8); keeper = true; }
    else if (rest.charAt(0) === '\u2020') { rest = rest.slice(1); keeper = true; }
    if (rest.indexOf(' b ') !== -1) {
      return { token: rest.split(' b ')[0].trim(), keeper: keeper, sub: false, cb: false };
    }
    return null;
  }
  function CatcherResolver(fullNames, fullNameOf) {
    this.fullNames = fullNames; this.fullNameOf = fullNameOf || {};
  }
  CatcherResolver.prototype._initials = function (name) {
    return initialsOf(this.fullNameOf[name] || name);
  };
  CatcherResolver.prototype.resolve = function (token, keeper, sub, fieldXi, roster) {
    if (!token) return null;
    var self = this;
    function inSet(s, v) { return s.indexOf(v) !== -1; }
    function union(a, b) {
      var out = a.slice();
      b.forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); });
      return out;
    }
    if (inSet(fieldXi, token)) return token;
    if (inSet(roster, token)) return token;
    if (this.fullNames.indexOf(token) !== -1) return token;
    var pool = union(fieldXi, roster);
    var cand = pool.filter(function (n) {
      return n.slice(-(token.length + 1)) === ' ' + token && token.split(/\s+/).length >= 2;
    });
    if (cand.length === 1) return cand[0];
    var parts = token.split(/\s+/);
    if (parts.length === 2 && parts[0] === parts[0].toUpperCase() && parts[0].length <= 3) {
      var ini = parts[0], sur = parts[1];
      cand = pool.filter(function (n) {
        return surnameOf(n) === sur && self._initials(n) === ini;
      });
      if (cand.length === 1) return cand[0];
      cand = pool.filter(function (n) {
        return surnameOf(n) === sur && self._initials(n).indexOf(ini) === 0;
      });
      if (cand.length === 1) return cand[0];
    }
    cand = fieldXi.filter(function (n) { return surnameOf(n) === token; });
    if (cand.length === 1) return cand[0];
    if (cand.length > 1 && keeper) {
      /* Faithful port of the Python branch: keepers is cand filtered
         to fieldXi — which cand already is — so this never fires when
         cand > 1. Kept so the port stays behaviour-identical. */
      var keepers = cand.filter(function (n) { return inSet(fieldXi, n); });
      if (keepers.length === 1) return keepers[0];
    }
    cand = fieldXi.filter(function (n) { return n.split(/\s+/)[0] === token; });
    if (cand.length === 1) return cand[0];
    if (sub) {
      var sur2 = surnameOf(token);
      cand = roster.filter(function (n) { return surnameOf(n) === sur2; });
      if (cand.length === 1) return cand[0];
    }
    return null;
  };

  /* ================= stats compute (port of stats_compute.py) ================= */
  function avgKey(runs, outs) { return outs === 0 ? Infinity : runs / outs; }
  function cmpDescNum(a, b) { /* -a vs -b, Infinity-safe */
    if (a !== b) return a > b ? -1 : 1;
    return 0;
  }
  function isNotOut(b) {
    /* The Python reads the batting row's not_out BOOLEAN — a 'retired
       hurt' innings is not out (Imran Sheikh M26: 134 runs, 5 outs,
       average 26.80 — not 6 outs / 22.33). The aggregate carries the
       boolean; the fallback matches the same dismissals by text. */
    if (b.not_out !== undefined && b.not_out !== null) return !!b.not_out;
    if (b.notOut !== undefined && b.notOut !== null) return !!b.notOut;
    var d = String(b.dismissal || '').trim().toLowerCase();
    return d === 'not out' || d === 'retired hurt' || d === 'absent hurt' || d === 'absent ill';
  }
  function aggregate(matches, cfg, fullNames) {
    /* fullNames = the league's full player-name set (players.json
       names) for the resolver's rule 3 — "exact full name anywhere in
       the league". It comes from the aggregate file (the seed embeds
       it; the PHP preserves it). When absent, the roster union is the
       fallback — it resolves every name that played, but NOT a
       substitute who never played (Deepak Bohara M17: in players.json,
       in no result XI — rule 3 is the only rule that finds him). */
    var leaguePlayers = [];
    var rosters = {};
    function rosterSet(code) {
      if (!rosters[code]) rosters[code] = [];
      return rosters[code];
    }
    matches.forEach(function (m) {
      if (m.status !== 'result' && m.status !== 'abandoned') return;
      Object.keys(m.xi || {}).forEach(function (code) {
        (m.xi[code] || []).forEach(function (p) {
          var r = rosterSet(code);
          if (r.indexOf(p) === -1) r.push(p);
          if (leaguePlayers.indexOf(p) === -1) leaguePlayers.push(p);
        });
      });
    });
    var resolver = new CatcherResolver(fullNames || leaguePlayers, cfg.fullNameOverrides || {});
    var bat = {}, bowl = {}, catchMap = {}, played = {}, firstBowl = {}, team = {};
    var highScores = [], topInnings = null, teamTotals = [], spells = [];
    var centuries = [], wins = [], unresolved = [];
    var latest = null, leagueLatest = null, abandoned = [];
    var dates = {};
    function batRec(nm) {
      if (!bat[nm]) bat[nm] = { mat: 0, runs: 0, balls: 0, fours: 0, sixes: 0,
        outs: 0, hs: 0, hsNo: false, fifties: 0, hundreds: 0, ducks: 0 };
      return bat[nm];
    }
    function bowlRec(nm) {
      if (!bowl[nm]) bowl[nm] = { mat: 0, balls: 0, runs: 0, wkts: 0, spells: [] };
      return bowl[nm];
    }
    function teamRec(code, name) {
      if (!team[code]) team[code] = { name: name, code: code, m: 0, w: 0, l: 0,
        t: 0, nr: 0, pts: 0, forR: 0, forB: 0, agR: 0, agB: 0 };
      return team[code];
    }
    function nrrBalls(score, balls) {
      var wk = score.indexOf('/') !== -1 ? parseInt(score.split('/')[1], 10) : 0;
      return (wk === 10 && balls < 120) ? 120 : balls;
    }
    var sorted = matches.slice().sort(function (a, b) { return a.matchNo - b.matchNo; });
    sorted.forEach(function (m) {
      var n = m.matchNo;
      if (m.status !== 'result' && m.status !== 'abandoned') return;
      dates[n] = m.date;
      if (m.status === 'result') {
        latest = m;
        if (cfg.leagueStages.indexOf(m.stage === undefined ? null : m.stage) !== -1) leagueLatest = m;
      }
      var t1 = m.team1, t2 = m.team2;
      teamRec(t1.code, t1.name); teamRec(t2.code, t2.name);
      if (m.status === 'abandoned') {
        abandoned.push(m);
        [t1, t2].forEach(function (t) {
          var tt = team[t.code]; tt.m++; tt.nr++; tt.pts++;
        });
        return;
      }
      Object.keys(m.xi || {}).forEach(function (code) {
        (m.xi[code] || []).forEach(function (p) { played[p] = (played[p] || 0) + 1; });
      });
      var winCode = m.winner || null;
      if (!winCode && m.score1 && m.score2) {
        var s1 = parseScore(m.score1), s2 = parseScore(m.score2);
        if (s1 && s2 && s1.runs !== s2.runs) {
          winCode = s1.runs > s2.runs ? t1.code : t2.code;
        }
      }
      var inns = m.innings || [];
      if (inns.length === 2 && winCode) {
        var first = inns[0];
        var fr = parseScore(first.total), sr = parseScore(inns[1].total);
        if (first.code === winCode && fr && sr) {
          wins.push([fr.runs - sr.runs, winCode,
            winCode === t1.code ? t2.code : t1.code, n, m.date]);
        }
      }
      inns.forEach(function (inn) {
        var code = inn.code;
        var opp = (code === t1.code) ? t2 : t1;
        var sc = String(inn.total).split('/');
        var truns = parseInt(sc[0], 10), twk = parseInt(sc[1], 10) || 0;
        var oballs = oversToBalls(inn.overs);
        var rr = oballs ? truns / (oballs / 6) : 0;
        var result = winCode === code ? 'Won' : (winCode ? 'Lost' : 'NR');
        var mlabel = 'vs ' + opp.name + ', Match ' + n + ', ' + dateLabel(m.date);
        var tlabel = 'Match ' + n + ', ' + dateLabel(m.date);
        teamTotals.push([code, truns, twk, inn.overs, rr, result, tlabel, n, opp.code]);
        var tt = team[code];
        tt.m++; tt.forR += truns; tt.forB += nrrBalls(inn.total, oballs);
        var fieldXi = (m.xi && m.xi[opp.code]) ? m.xi[opp.code].slice() : [];
        var fieldRoster = rosterSet(opp.code);
        (inn.batting || []).forEach(function (b) {
          var nm = b.name, r = batRec(nm);
          var notOut = isNotOut(b);
          r.mat++; r.runs += b.runs; r.balls += b.balls;
          r.fours += b.fours; r.sixes += b.sixes;
          if (!notOut) r.outs++;
          if (b.runs > r.hs || (b.runs === r.hs && notOut && !r.hsNo)) {
            r.hs = b.runs; r.hsNo = notOut;
          }
          if (b.runs >= 100) { r.hundreds++; centuries.push([nm, b.runs, n, code, opp.code, m.date]); }
          else if (b.runs >= 50) r.fifties++;
          if (b.runs === 0 && !notOut) r.ducks++;
          if (b.runs >= 50) {
            highScores.push([b.runs, b.balls, b.fours, b.sixes, nm, mlabel, notOut, n, code, opp.code]);
          }
          var cand = [b.runs, b.balls, b.fours, b.sixes, nm, mlabel, notOut, n, code, opp.code];
          if (!topInnings ||
              (-cand[0] < -topInnings[0]) ||
              (-cand[0] === -topInnings[0] && (cand[1] < topInnings[1] ||
                (cand[1] === topInnings[1] && cand[4] < topInnings[4])))) {
            topInnings = cand;
          }
          var pc = parseCatcher(b.dismissal || '');
          if (pc) {
            var full = resolver.resolve(pc.token, pc.keeper, pc.sub, fieldXi, fieldRoster);
            if (full) {
              if (!catchMap[full]) catchMap[full] = { ct: 0 };
              catchMap[full].ct++;
            } else {
              unresolved.push([pc.token, n, opp.code]);
            }
          }
        });
        (inn.bowling || []).forEach(function (b) {
          var nm = b.name, w = bowlRec(nm);
          if (firstBowl[nm] === undefined) firstBowl[nm] = n;
          w.mat++; w.balls += b.balls; w.runs += b.runs; w.wkts += b.wickets;
          var ov = String(b.overs);
          var ovDisp = ov.slice(-2) === '.0' ? ov.slice(0, -2) : ov;
          var blabel = 'vs ' + inn.team + ', Match ' + n + ', ' + dateLabel(m.date);
          w.spells.push([b.wickets, b.runs, ovDisp, b.balls, blabel, nm, n]);
          spells.push([b.wickets, b.runs, ovDisp, b.balls, fmtEcon(b.runs, b.balls),
            blabel, nm, n, opp.code, code]);
        });
      });
      if (inns.length === 2) {
        [[inns[0], inns[1]], [inns[1], inns[0]]].forEach(function (pair) {
          var inn = pair[0], oppInn = pair[1];
          var tt2 = team[inn.code];
          var osc = String(oppInn.total).split('/');
          tt2.agR += parseInt(osc[0], 10);
          var ob = oversToBalls(oppInn.overs);
          var owk = osc.length > 1 ? parseInt(osc[1], 10) : 0;
          tt2.agB += (owk === 10 && ob < 120) ? 120 : ob;
        });
        if (winCode) {
          team[winCode].w++; team[winCode].pts += 2;
          var loser = winCode === t1.code ? t2.code : t1.code;
          team[loser].l++;
        }
      }
    });
    Object.keys(team).forEach(function (code) {
      var tt = team[code];
      tt.nrr = (tt.forB ? tt.forR / (tt.forB / 6) : 0) -
        (tt.agB ? tt.agR / (tt.agB / 6) : 0);
    });
    var resultMatches = sorted.filter(function (m) { return m.status === 'result'; });
    var withCards = resultMatches.filter(function (m) { return (m.innings || []).length > 0; });
    return { bat: bat, bowl: bowl, catch: catchMap, played: played,
      firstBowl: firstBowl, team: team, highScores: highScores,
      topInnings: topInnings, teamTotals: teamTotals, spells: spells,
      centuries: centuries, wins: wins, unresolved: unresolved,
      latest: latest, leagueLatest: leagueLatest, abandoned: abandoned,
      rosters: rosters, dates: dates,
      /* Version counters (the PHP computes the same three from the
         aggregate file; the hash is md5 of the canonical matches
         JSON, computed server-side). */
      through: latest ? latest.matchNo : 0,
      results: resultMatches.length, withCards: withCards.length };
  }

  function tables(agg, cfg, pointsMini) {
    /* cfg is accepted for signature symmetry with the other ports;
       the tables themselves need only the aggregate + pointsMini. */
    var bat = agg.bat, bowl = agg.bowl, catchMap = agg.catch, played = agg.played;
    var out = {};
    var runs = Object.keys(bat).filter(function (n) {
      return bat[n].mat > 0 && bat[n].runs > 0;
    }).map(function (n) { return { n: n, r: bat[n] }; });
    runs.sort(function (a, b) {
      if (b.r.runs !== a.r.runs) return b.r.runs - a.r.runs;
      var c = cmpDescNum(avgKey(a.r.runs, a.r.outs), avgKey(b.r.runs, b.r.outs));
      if (c) return c;
      return cmpStr(a.n, b.n);
    });
    out.runs = runs.map(function (x) {
      var r = x.r;
      return [x.n, String(r.mat), String(r.runs),
        String(r.hs) + (r.hsNo ? '*' : ''), fmtAve(r.runs, r.outs), fmtSr(r.runs, r.balls)];
    });
    var wk = Object.keys(bowl).filter(function (n) { return bowl[n].wkts > 0; })
      .map(function (n) { return { n: n, w: bowl[n] }; });
    function bbi(w) {
      var best = w.spells.slice().sort(function (a, b) {
        if (b[0] !== a[0]) return b[0] - a[0];
        return a[1] - b[1];
      })[0];
      return best[0] + '/' + best[1];
    }
    wk.sort(function (a, b) {
      if (b.w.wkts !== a.w.wkts) return b.w.wkts - a.w.wkts;
      if (a.w.runs !== b.w.runs) return a.w.runs - b.w.runs;
      return cmpStr(a.n, b.n);
    });
    out.wkts = wk.map(function (x) {
      var w = x.w;
      return [x.n, String(w.mat), String(w.wkts), bbi(w),
        fmtAve(w.runs, w.wkts), fmtEcon(w.runs, w.balls), fmtBsr(w.balls, w.wkts)];
    });
    var hs = agg.highScores.slice().sort(function (a, b) {
      if (b[0] !== a[0]) return b[0] - a[0];
      if (a[1] !== b[1]) return a[1] - b[1];
      return cmpStr(a[4], b[4]);
    }).slice(0, 15);
    out.highScores = hs.map(function (x) {
      return [x[4], String(x[0]) + (x[6] ? '*' : ''), String(x[1]), String(x[2]),
        String(x[3]), fmtSr(x[0], x[1]), x[5]];
    });
    var bb = agg.spells.filter(function (s) { return s[0] >= 3; }).sort(function (a, b) {
      if (b[0] !== a[0]) return b[0] - a[0];
      if (a[1] !== b[1]) return a[1] - b[1];
      return a[7] - b[7];
    }).slice(0, 15);
    out.bestBowl = bb.map(function (s) { return [s[6], s[2], String(s[1]), String(s[0]), s[4], s[5]]; });
    var code2name = {};
    Object.keys(agg.team).forEach(function (c) { code2name[c] = agg.team[c].name; });
    var tt = agg.teamTotals.slice().sort(function (a, b) {
      if (b[1] !== a[1]) return b[1] - a[1];
      if (b[2] !== a[2]) return b[2] - a[2];
      return a[7] - b[7];
    });
    out.teamTotals = tt.map(function (x) {
      var ob = String(x[3]);
      return [code2name[x[0]] + ' ' + x[0], x[1] + '/' + x[2],
        ob.slice(-2) === '.0' ? ob.slice(0, -2) : ob,
        pyFixed(x[4], 2), x[5], x[6]];
    });
    var ct = Object.keys(catchMap).filter(function (n) { return catchMap[n].ct > 0; })
      .map(function (n) { return { n: n, c: catchMap[n] }; });
    ct.sort(function (a, b) {
      if (b.c.ct !== a.c.ct) return b.c.ct - a.c.ct;
      return cmpStr(a.n, b.n);
    });
    out.catches = ct.map(function (x) { return [x.n, String(played[x.n] || 0), String(x.c.ct)]; });
    var sr = Object.keys(bat).filter(function (n) { return bat[n].balls >= 20; })
      .map(function (n) { return { n: n, r: bat[n] }; });
    sr.sort(function (a, b) {
      var sa = a.r.runs / a.r.balls, sb = b.r.runs / b.r.balls;
      if (sb !== sa) return sb - sa;
      return cmpStr(a.n, b.n);
    });
    out.sr = sr.map(function (x) {
      return [x.n, String(x.r.mat), String(x.r.runs), String(x.r.balls), fmtSr(x.r.runs, x.r.balls)];
    });
    function sixFour(key) {
      return Object.keys(bat).filter(function (n) { return bat[n][key] > 0; })
        .map(function (n) { return { n: n, r: bat[n] }; })
        .sort(function (a, b) {
          if (b.r[key] !== a.r[key]) return b.r[key] - a.r[key];
          if (b.r.runs !== a.r.runs) return b.r.runs - a.r.runs;
          return cmpStr(a.n, b.n);
        });
    }
    out.sixes = sixFour('sixes').map(function (x) {
      return [x.n, String(x.r.mat), String(x.r.sixes), String(x.r.runs)];
    });
    out.fours = sixFour('fours').map(function (x) {
      return [x.n, String(x.r.mat), String(x.r.fours), String(x.r.runs)];
    });
    var f50 = Object.keys(bat).filter(function (n) {
      return bat[n].fifties + bat[n].hundreds > 0;
    }).map(function (n) { return { n: n, r: bat[n] }; });
    f50.sort(function (a, b) {
      var ta = a.r.fifties + a.r.hundreds, tb = b.r.fifties + b.r.hundreds;
      if (tb !== ta) return tb - ta;
      if (b.r.runs !== a.r.runs) return b.r.runs - a.r.runs;
      return cmpStr(a.n, b.n);
    });
    out.fifties = f50.map(function (x) {
      return [x.n, String(x.r.fifties), String(x.r.hundreds), String(x.r.runs)];
    });
    var f50list = agg.highScores.slice().sort(function (a, b) {
      if (a[1] !== b[1]) return a[1] - b[1];
      if (b[0] !== a[0]) return b[0] - a[0];
      return cmpStr(a[4], b[4]);
    });
    out.fastest50 = f50list.map(function (x) {
      return [x[4], String(x[0]) + (x[6] ? '*' : ''), String(x[1]), String(x[2]), String(x[3]), x[5]];
    });
    var dk = Object.keys(bat).filter(function (n) { return bat[n].ducks > 0; })
      .map(function (n) { return { n: n, r: bat[n] }; });
    dk.sort(function (a, b) {
      if (b.r.ducks !== a.r.ducks) return b.r.ducks - a.r.ducks;
      return cmpStr(a.n, b.n);
    });
    out.ducks = dk.map(function (x) { return [x.n, String(x.r.ducks), String(x.r.mat)]; });
    /* Team stats: the FROZEN final league table (points_mini of the
       latest league match) — never the season aggregates, which
       include playoff matches. */
    if (pointsMini) {
      out.teams = pointsMini.map(function (e) {
        return [e.code, e.name, String(e.played), String(e.won), String(e.lost),
          '0', String(e.noresult), String(e.points), e.nrr_display, e.for, e.against];
      });
    } else {
      var teams = Object.keys(agg.team).map(function (c) { return agg.team[c]; });
      teams.sort(function (a, b) {
        if (b.pts !== a.pts) return b.pts - a.pts;
        if (b.nrr !== a.nrr) return b.nrr - a.nrr;
        return cmpStr(a.name, b.name);
      });
      out.teams = teams.map(function (t) {
        return [t.code, t.name, String(t.m), String(t.w), String(t.l), String(t.t),
          String(t.nr), String(t.pts), (t.nrr < 0 ? '' : '+') + pyFixed(t.nrr, 3),
          t.forR + '/' + oversCricket(t.forB), t.agR + '/' + oversCricket(t.agB)];
      });
    }
    var zeroRun = Object.keys(bat).filter(function (n) {
      return bat[n].mat > 0 && bat[n].runs === 0;
    }).map(function (n) { return [n, bat[n].mat]; }).sort(function (a, b) { return cmpStr(a[0], b[0]); });
    out.zeroRun = zeroRun;
    var zeroWk = Object.keys(bowl).filter(function (n) {
      return bowl[n].mat > 0 && bowl[n].wkts === 0;
    }).map(function (n) { return [n, bowl[n].mat]; })
      .sort(function (a, b) {
        var fa = agg.firstBowl[a[0]] === undefined ? 99 : agg.firstBowl[a[0]];
        var fb = agg.firstBowl[b[0]] === undefined ? 99 : agg.firstBowl[b[0]];
        return fa - fb;
      });
    out.zeroWk = zeroWk;
    out.perfRuns = out.runs.slice(0, 3);
    out.perfWkts = out.wkts.slice(0, 3);
    out.perfSr = out.sr.slice(0, 3);
    var econ = Object.keys(bowl).filter(function (n) { return bowl[n].balls >= 60; })
      .map(function (n) { return { n: n, w: bowl[n] }; });
    econ.sort(function (a, b) {
      var ea = a.w.runs / (a.w.balls / 6), eb = b.w.runs / (b.w.balls / 6);
      if (ea !== eb) return ea - eb;
      return cmpStr(a.n, b.n);
    });
    out.perfEcon = econ.slice(0, 3).map(function (x) {
      return [x.n, String(x.w.mat), fmtAve(x.w.runs, x.w.wkts), fmtEcon(x.w.runs, x.w.balls)];
    });
    out.batRaw = bat; out.bowlRaw = bowl; out.played = played;
    return out;
  }

  function records(agg, tab, cfg) {
    /* cfg is accepted for signature symmetry; the rows carry codes
       and the renderer looks up names. */
    var hs = agg.highScores;
    var bestHs;
    if (hs.length) {
      bestHs = hs.slice().sort(function (a, b) {
        if (b[0] !== a[0]) return b[0] - a[0];
        if (a[1] !== b[1]) return a[1] - b[1];
        return cmpStr(a[4], b[4]);
      })[0];
    } else {
      bestHs = agg.topInnings;
    }
    var bb = agg.spells.filter(function (s) { return s[0] >= 1; }).sort(function (a, b) {
      if (b[0] !== a[0]) return b[0] - a[0];
      if (a[1] !== b[1]) return a[1] - b[1];
      return a[7] - b[7];
    })[0];
    var tt = agg.teamTotals.slice().sort(function (a, b) {
      if (b[1] !== a[1]) return b[1] - a[1];
      if (b[2] !== a[2]) return b[2] - a[2];
      return a[7] - b[7];
    })[0];
    var econSpells = agg.spells.filter(function (s) { return s[3] >= 18; });
    if (!econSpells.length) {
      var maxBalls = 0;
      agg.spells.forEach(function (s) { if (s[3] > maxBalls) maxBalls = s[3]; });
      econSpells = agg.spells.filter(function (s) { return s[3] === maxBalls; });
    }
    var bestEcon = econSpells.slice().sort(function (a, b) {
      var ea = parseFloat(a[4]), eb = parseFloat(b[4]);
      if (ea !== eb) return ea - eb;
      if (b[0] !== a[0]) return b[0] - a[0];
      return a[7] - b[7];
    })[0];
    var rows = [
      ['Highest individual score', bestHs[4],
        bestHs[0] + ' off ' + bestHs[1] + ' balls', bestHs[8], bestHs[9], bestHs[7], null, false],
      ['Best bowling figures', bb[6], bb[0] + '/' + bb[1] + ' (' + bb[2] + ' overs)',
        bb[8], bb[9], bb[7], null, false],
      ['Highest team total', tt[0], tt[1] + '/' + tt[2], tt[0], tt[8], tt[7], null, true],
      ['Most economical spell', bestEcon[6],
        bestEcon[0] + '/' + bestEcon[1] + ' (' + bestEcon[2] + ' overs)',
        bestEcon[8], bestEcon[9], bestEcon[7], null, false]
    ];
    var dates = agg.dates;
    rows = rows.map(function (r) {
      return [r[0], r[1], r[2], r[3], r[4], r[5], dates[r[5]], r[7]];
    });
    var latest = agg.latest;
    var nLatest = latest.matchNo;
    var playedN = Object.keys(agg.dates).length;
    var ab = agg.abandoned;
    var abText = '';
    if (ab.length === 1) abText = 'Match ' + ab[0].matchNo + ' was abandoned for rain';
    else if (ab.length > 1) {
      var nums = ab.slice(0, -1).map(function (m) { return 'Match ' + m.matchNo; }).join(', ');
      abText = nums + ' and Match ' + ab[ab.length - 1].matchNo + ' were abandoned for rain';
    }
    var runTop = tab.runs[0], wktTop = tab.wkts[0];
    var cents = agg.centuries;
    var centText;
    if (cents.length === 0) centText = 'no batter has reached a century yet';
    else if (cents.length === 1) {
      centText = possessive(cents[0][0]) + ' ' + cents[0][1] + ' is the season\u2019s only century';
    } else if (cents.length === 2) {
      centText = possessive(cents[0][0]) + ' ' + cents[0][1] + ' and ' +
        possessive(cents[1][0]) + ' ' + cents[1][1] + ' are the season\u2019s only centuries';
    } else {
      var parts = cents.map(function (c) { return possessive(c[0]) + ' ' + c[1]; });
      centText = parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] +
        ' are the season\u2019s only centuries';
    }
    var intro = 'SialTV lists every figure from the verified scorecards. ' +
      'After Match ' + nLatest + ', ' + playedN + ' matches have been played';
    if (abText) intro += ' \u2014 ' + abText;
    intro += '. ' + runTop[0] + ' leads the runs with ' + runTop[2] + ', ' +
      wktTop[0] + ' leads the wickets with ' + wktTop[2] + ', and ' + centText + '.';
    var ttSorted = agg.teamTotals.slice().sort(function (a, b) {
      if (b[1] !== a[1]) return b[1] - a[1];
      if (b[2] !== a[2]) return b[2] - a[2];
      return a[7] - b[7];
    });
    var second = ttSorted[1], third = ttSorted.length > 2 ? ttSorted[2] : null;
    var note1;
    if (third && second[7] === third[7] && second[0] !== third[0]) {
      note1 = 'The next-highest totals are both from Match ' + second[7] + ': ' +
        possessive(agg.team[second[0]].name) + ' ' + second[1] + ' for ' + second[2] +
        ' and ' + possessive(agg.team[third[0]].name) + ' ' + third[1] + ' for ' + third[2] +
        ', against each other.';
    } else {
      note1 = 'The next-highest total is ' + possessive(agg.team[second[0]].name) +
        ' ' + second[1] + ' for ' + second[2] + ' against ' +
        agg.team[second[8]].name + ' in Match ' + second[7] + '.';
    }
    var wins = agg.wins, note2;
    if (wins.length) {
      var big = wins.slice().sort(function (a, b) {
        if (b[0] !== a[0]) return b[0] - a[0];
        return a[3] - b[3];
      })[0];
      note2 = 'The biggest win of the season is ' + possessive(agg.team[big[1]].name) +
        ' ' + big[0] + '-run win over ' + agg.team[big[2]].name + ' in Match ' + big[3];
      var suffix = [];
      if (big[3] === ttSorted[0][7]) suffix.push('the ' + ttSorted[0][1] + ' total');
      if (cents.length === 1 && big[3] === cents[0][2]) suffix.push('the season\u2019s only century');
      if (suffix.length) note2 += ' \u2014 the same match as ' + suffix.join(' and ');
      note2 += '.';
    } else {
      note2 = 'No win by runs yet this season.';
    }
    return { rows: rows, intro: intro, note: note1 + ' ' + note2 };
  }

  /* ================= points (port of live-scores.js computePoints
     + the points-table builder) ================= */
  function teamNameOf(m, which) {
    /* Payload shape: team1/team2 are names. Aggregate shape: they are
       {name, code} objects. */
    var t = m[which];
    return (typeof t === 'object' && t) ? t.name : t;
  }
  function matchStage(m) {
    if (m.stage !== undefined && m.stage !== null) return m.stage;
    if (PLAYOFF_DESCS.indexOf(m.matchDesc) !== -1) return m.matchDesc;
    return null;
  }
  function isAbandoned(m) {
    return m.status === 'abandoned' || /abandoned/i.test(m.statusText || '');
  }
  function winnerSide(m, cfg) {
    var mm = /^(.+?) won by/.exec(cleanTeam(m.statusText || ''));
    if (mm) {
      var w = mm[1].trim();
      if (w === cleanTeam(teamNameOf(m, 'team1'))) return 0;
      if (w === cleanTeam(teamNameOf(m, 'team2'))) return 1;
    }
    return -1;
  }
  function winnerCode(m, cfg) {
    var s1 = parseScore(m.score1), s2 = parseScore(m.score2);
    var w = winnerSide(m, cfg);
    if (w === 0) return teamCodeOf(cfg, teamNameOf(m, 'team1'));
    if (w === 1) return teamCodeOf(cfg, teamNameOf(m, 'team2'));
    if (s1 && s2 && s1.runs !== s2.runs) {
      return s1.runs > s2.runs ? teamCodeOf(cfg, teamNameOf(m, 'team1')) : teamCodeOf(cfg, teamNameOf(m, 'team2'));
    }
    return null;
  }
  function computePoints(matches, cfg) {
    /* Accepts both the endpoint payload (team1/team2 = names) and the
       aggregate (team1/team2 = {name, code}) — the stats renderer
       recomputes the frozen table from the aggregate, the points
       renderer from the live payload. */
    var t = {};
    Object.keys(cfg.teams).forEach(function (code) {
      t[code] = { code: code, name: cfg.teams[code].name, played: 0, won: 0,
        lost: 0, tied: 0, noresult: 0, points: 0,
        forR: 0, forB: 0, agR: 0, agB: 0 };
    });
    var events = {};
    Object.keys(t).forEach(function (c) { events[c] = []; });
    var latestLeague = null, leagueEnded = true, afterMatch = 0;
    var leagueMatches = [];
    matches.forEach(function (m) {
      /* League match = anything without a playoff stage. (The endpoint
         stage comes from matchDesc: null for "Match N", the playoff
         name otherwise. The leagueStages set is for the aggregate /
         matches.json path, where ILT20 league matches carry
         stage='League' — here a null stage is a league match too.) */
      var st = matchStage(m);
      if (st !== null && PLAYOFF_DESCS.indexOf(st) !== -1) return;
      leagueMatches.push(m);
      if (m.status === 'upcoming') { leagueEnded = false; return; }
      if (m.status !== 'result' && !isAbandoned(m)) return;
      var c1 = teamCodeOf(cfg, teamNameOf(m, 'team1')), c2 = teamCodeOf(cfg, teamNameOf(m, 'team2'));
      if (!c1 || !c2 || !t[c1] || !t[c2]) return;
      if (isAbandoned(m)) {
        t[c1].played++; t[c2].played++;
        t[c1].noresult++; t[c2].noresult++;
        t[c1].points++; t[c2].points++;
        events[c1].push([m.matchNo, 'A']); events[c2].push([m.matchNo, 'A']);
        if (m.matchNo > afterMatch) afterMatch = m.matchNo;
        if (!latestLeague || m.matchNo > latestLeague.matchNo) latestLeague = m;
        return;
      }
      var s1 = parseScore(m.score1), s2 = parseScore(m.score2);
      if (!s1 || !s2) return;
      var quota = (m.quota || 20) * 6;
      var b1 = s1.wk === 10 ? quota : oversToBalls(m.overs1);
      var b2 = s2.wk === 10 ? quota : oversToBalls(m.overs2);
      if (!b1 || !b2) return;
      var a = t[c1], b = t[c2];
      a.played++; b.played++;
      a.forR += s1.runs; a.forB += b1; a.agR += s2.runs; a.agB += b2;
      b.forR += s2.runs; b.forB += b2; b.agR += s1.runs; b.agB += b1;
      if (s1.runs === s2.runs) {
        /* Tie: no winner in the bake's data (winner_of returns None
           and the bake would crash) — the JS awards a shared point
           each, the standard no-result-equivalent treatment, and
           records a 'T' form event. Flagged in the REPORT. */
        a.tied++; b.tied++; a.points++; b.points++;
        events[c1].push([m.matchNo, 'T']); events[c2].push([m.matchNo, 'T']);
      } else if (s1.runs > s2.runs) {
        a.won++; b.lost++; a.points += 2;
        events[c1].push([m.matchNo, 'W']); events[c2].push([m.matchNo, 'L']);
      } else {
        b.won++; a.lost++; b.points += 2;
        events[c2].push([m.matchNo, 'W']); events[c1].push([m.matchNo, 'L']);
      }
      if (m.matchNo > afterMatch) afterMatch = m.matchNo;
      if (!latestLeague || m.matchNo > latestLeague.matchNo) latestLeague = m;
    });
    var rows = Object.keys(t).map(function (code) {
      var x = t[code];
      var nrr = (x.forB ? x.forR / (x.forB / 6) : 0) - (x.agB ? x.agR / (x.agB / 6) : 0);
      nrr = pyRound(nrr, 3);
      return { code: code, name: x.name, played: x.played, won: x.won,
        lost: x.lost, tied: x.tied, noresult: x.noresult, points: x.points,
        nrr: nrr, nrrDisplay: (nrr < 0 ? '' : '+') + pyFixed(nrr, 3),
        forR: x.forR, forB: x.forB, agR: x.agR, agB: x.agB,
        forStr: x.forR + '/' + ballsToOvers(x.forB),
        againstStr: x.agR + '/' + ballsToOvers(x.agB) };
    });
    rows.sort(function (a, b) {
      if (b.points !== a.points) return b.points - a.points;
      if (b.nrr !== a.nrr) return b.nrr - a.nrr;
      if (b.won !== a.won) return b.won - a.won;
      return cmpStr(a.code, b.code);
    });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    return { rows: rows, events: events, latestLeague: latestLeague,
      leagueEnded: leagueEnded, afterMatch: afterMatch,
      leagueMatches: leagueMatches };
  }
  function pointsMiniRows(points) {
    /* The frozen league table in points_mini shape (what tables()
       needs for the Team stats table). */
    return points.rows.map(function (r) {
      return { rank: r.rank, code: r.code, name: r.name, played: r.played,
        won: r.won, lost: r.lost, noresult: r.noresult, points: r.points,
        nrr: r.nrr, nrr_display: r.nrrDisplay, for: r.forStr, against: r.againstStr,
        runs_for: r.forR, balls_for: r.forB, runs_against: r.agR, balls_against: r.agB };
    });
  }
  function resultText(m, cfg) {
    if (isAbandoned(m)) return 'Match ' + m.matchNo + ' abandoned \u2014 no result, points shared';
    var s1 = parseScore(m.score1), s2 = parseScore(m.score2);
    if (!s1 || !s2) return '';
    if (s1.runs === s2.runs) return 'Match tied';
    /* Margin TYPE (runs vs wickets) comes from the live result text:
       the payload scores alone cannot say who batted first, and the
       team-order heuristic (higher scorer = runs winner) is wrong
       whenever the fixture's team2 batted first — e.g. M14, where
       LUL won by 16 runs and the heuristic said 2 wickets. The
       winner and the margin NUMBER come from the scores; only the
       type is read from the text. Falls back to the heuristic when
       the text carries no type. */
    var byWkts = /wkt|wicket/i.test(m.statusText || '');
    var winName, winCode, margin;
    if (s1.runs > s2.runs) {
      winName = cleanTeam(teamNameOf(m, 'team1')); winCode = teamCodeOf(cfg, teamNameOf(m, 'team1'));
      margin = byWkts ? 'won by ' + (10 - s1.wk) + ' wickets' : 'won by ' + (s1.runs - s2.runs) + ' runs';
    } else {
      winName = cleanTeam(teamNameOf(m, 'team2')); winCode = teamCodeOf(cfg, teamNameOf(m, 'team2'));
      margin = byWkts ? 'won by ' + (10 - s2.wk) + ' wickets' : 'won by ' + (s2.runs - s1.runs) + ' runs';
    }
    return tm(winName, winCode) + ' ' + margin;
  }
  function detailRowsHtml(code, points, matchesByNo, cfg) {
    var evs = (points.events[code] || []).slice(-5).reverse();
    return evs.map(function (ev) {
      var m = matchesByNo[ev[0]];
      if (!m) return '';
      var res = ev[1];
      var c1 = teamCodeOf(cfg, teamNameOf(m, 'team1')), c2 = teamCodeOf(cfg, teamNameOf(m, 'team2'));
      var bold = dateLong(m.date) + ', ' + ordinal(m.matchNo) + ' Match, ' +
        tm(cleanTeam(teamNameOf(m, 'team1')), c1) + ' vs ' + tm(cleanTeam(teamNameOf(m, 'team2')), c2);
      return '<li><span class="rx-fc rx-fc-' + res.toLowerCase() + '">' + res + '</span>' +
        '<span class="rx-fd-main"><b>' + bold + '</b>' +
        '<span>' + resultText(m, cfg) + '</span></span>' +
        '<a href="' + cfg.basePath + 'matches/2026/match-' + m.matchNo + '/">View scorecard &rsaquo;</a></li>';
    }).join('');
  }
  function nextCellHtml(code, matches, cfg) {
    var sorted = matches.slice().sort(function (a, b) { return a.matchNo - b.matchNo; });
    for (var i = 0; i < sorted.length; i++) {
      var m = sorted[i];
      if (m.status !== 'upcoming') continue;
      var c1 = teamCodeOf(cfg, teamNameOf(m, 'team1')), c2 = teamCodeOf(cfg, teamNameOf(m, 'team2'));
      if (!c1 || !c2) continue;
      if (code !== c1 && code !== c2) continue;
      var opp = code === c1 ? c2 : c1;
      if (opp === 'TBC') continue;
      return 'vs <a href="' + cfg.basePath + 'teams/' + cfg.teams[opp].slug + '/">' + opp + '</a>';
    }
    return '\u2014';
  }
  var GAP_WORDS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
  function leadHtml(points, cfg) {
    var t = points.rows;
    var n = points.latestLeague ? points.latestLeague.matchNo : 0;
    var gap = t[0].points - t[1].points;
    var gapWord = GAP_WORDS[gap] || (gap + ' points');
    var out = '<p class="lead">' + esc(t[0].name) + ' lead the table on ' + t[0].points +
      ' points after Match ' + n + ', ' + gapWord + ' clear of ' + esc(t[1].name) +
      ' on ' + t[1].points + '. ' + esc(t[2].name) + ' are third on ' + t[2].points +
      ', ' + esc(t[3].name) + ' fourth on ' + t[3].points +
      '. A win is worth 2 points and a no result is worth 1. ' +
      'The top four teams qualify for the playoffs.';
    if (cfg.tiebreakSentence) out += ' Teams level on points are separated by net run rate.';
    if (points.leagueEnded && points.latestLeague) {
      var d = points.latestLeague.date;
      out += ' This is the final league table: the league stage ended on ' +
        parseInt(d.slice(8, 10), 10) + ' ' + MON_L[d.slice(5, 7)] + ' ' + d.slice(0, 4) +
        ', and playoff results do not change the standings.';
    }
    return out + '</p>';
  }

  /* ================= rendering =================
     All writes are check-first (a key comparison — never a blind
     rewrite) and in-place where the page has listeners attached
     (the points-table chevrons + sort read the live <tr>s). Team
     cells (logo + link) and photos are never rebuilt. */
  var writes = { points: 0, stats: 0 };
  function slugMapFromDom(basePath) {
    var map = {};
    var links = (typeof document !== 'undefined')
      ? document.querySelectorAll('a[href*="' + basePath + 'players/"]') : [];
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var slug = href.split('/').filter(function (x) { return x; }).pop();
      var name = (links[i].textContent || '').trim();
      if (slug && name && !map[name]) map[name] = slug;
    }
    return map;
  }
  function playerCellHtml(name, slugMap, basePath, lookupName) {
    var slug = slugMap[lookupName || name];
    if (slug) return '<a href="' + basePath + 'players/' + esc(slug) + '/">' + esc(name) + '</a>';
    return esc(name);
  }
  /* Sidebar leader rows use the tp-name class on the player link. */
  function sidebarNameHtml(name, slugMap, basePath) {
    var slug = slugMap[name];
    if (slug) return '<a class="tp-name" href="' + basePath + 'players/' + esc(slug) + '/">' + esc(name) + '</a>';
    return esc(name);
  }
  function initialsOfName(name) {
    var parts = String(name).split(/\s+/);
    return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
  }
  function matchCellHtml(label, cfg) {
    /* "vs <Opp>, Match N, 7 Nov" -> "vs <tm spans>, Match N, 7 Nov". */
    var m = /^vs (.+), (Match \d+, .+)$/.exec(label || '');
    if (!m) return esc(label || '');
    var code = teamCodeOf(cfg, m[1]);
    if (!code) return esc(label);
    return 'vs ' + tm(cleanTeam(m[1]), code) + ', ' + esc(m[2]);
  }

  /* ---- points full table (#rxPtsTable) ---- */
  function renderPointsTable(points, matchesByNo, matches, cfg) {
    var tbl = document.getElementById('rxPtsTable');
    if (!tbl) return false;
    var tbody = tbl.querySelector('tbody');
    if (!tbody) return false;
    var key = JSON.stringify([points.rows, points.events, points.leagueEnded,
      points.latestLeague ? points.latestLeague.matchNo : 0]);
    if (renderPointsTable._key === key) return false;
    renderPointsTable._key = key;
    var byTeam = {};
    Array.prototype.forEach.call(tbody.querySelectorAll('tr:not(.rx-detail)'), function (tr) {
      var det = tr.nextElementSibling;
      byTeam[tr.getAttribute('data-team')] = {
        row: tr,
        detail: (det && det.classList.contains('rx-detail')) ? det : null
      };
    });
    var elIdx = 0;
    points.rows.forEach(function (r) {
      var pair = byTeam[r.name];
      if (!pair) return;
      var tr = pair.row;
      tr.setAttribute('data-rank', r.rank);
      tr.setAttribute('data-m', r.played);
      tr.setAttribute('data-w', r.won);
      tr.setAttribute('data-l', r.lost);
      tr.setAttribute('data-t', r.tied);
      tr.setAttribute('data-nr', r.noresult);
      tr.setAttribute('data-pts', r.points);
      tr.setAttribute('data-nrr', r.nrrDisplay.replace(/^\+/, ''));
      tr.setAttribute('data-for', r.forR);
      tr.setAttribute('data-against', r.agR);
      var tds = tr.querySelectorAll('td');
      function setCell(i, v) { if (tds[i] && tds[i].textContent !== String(v)) tds[i].textContent = v; }
      setCell(0, r.rank);
      setCell(2, r.played); setCell(3, r.won); setCell(4, r.lost);
      setCell(5, r.tied); setCell(6, r.noresult); setCell(7, r.points);
      setCell(8, r.nrrDisplay.replace(/^\+/, ''));
      setCell(11, r.forStr); setCell(12, r.againstStr);
      var form = tds[9];
      if (form) {
        var chips = (points.events[r.code] || []).slice(-5).map(function (ev) {
          return '<span class="rx-fc rx-fc-' + ev[1].toLowerCase() + '">' + ev[1] + '</span>';
        }).join('');
        var rxForm = form.querySelector('.rx-form');
        if (rxForm && rxForm.innerHTML !== chips) rxForm.innerHTML = chips;
      }
      var next = tds[10];
      if (next) {
        var nc = nextCellHtml(r.code, matches, cfg);
        if (next.innerHTML !== nc) next.innerHTML = nc;
      }
      /* Move the pair only when its element position is wrong: an
         unconditional appendChild would pile the tbody's whitespace
         text nodes at the front on every poll. */
      if (tbody.children[elIdx] !== tr) tbody.insertBefore(tr, tbody.children[elIdx] || null);
      elIdx++;
      if (pair.detail) {
        var items = detailRowsHtml(r.code, points, matchesByNo, cfg);
        var ul = pair.detail.querySelector('ul.rx-fd');
        if (ul && ul.innerHTML !== items) ul.innerHTML = items;
        if (tbody.children[elIdx] !== pair.detail) tbody.insertBefore(pair.detail, tbody.children[elIdx] || null);
        elIdx++;
      }
    });
    var lead = document.querySelector('p.lead');
    if (lead) {
      var lh = leadHtml(points, cfg);
      var tmp = document.createElement('div');
      tmp.innerHTML = lh;
      if (tmp.firstChild && tmp.firstChild.textContent !== lead.textContent) {
        lead.textContent = tmp.firstChild.textContent;
      }
    }
    writes.points++;
    return true;
  }

  /* ---- points minis (table.pts-mini, all pages) ---- */
  function renderMinis(points, cfg) {
    var changed = false;
    var minis = document.querySelectorAll('table.pts-mini');
    for (var mi = 0; mi < minis.length; mi++) {
      var tbody = minis[mi].querySelector('tbody');
      if (!tbody) continue;
      var bySlug = {};
      Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr) {
        var a = tr.querySelector('td a[href*="/teams/"]');
        if (a) {
          var slug = (a.getAttribute('href') || '').split('/').filter(function (x) { return x; }).pop();
          bySlug[slug] = tr;
        }
      });
      points.rows.forEach(function (r, wantIdx) {
        var tr = bySlug[cfg.teams[r.code].slug];
        if (!tr) return;
        var tds = tr.querySelectorAll('td');
        function setCell(i, v) { if (tds[i] && tds[i].textContent !== String(v)) tds[i].textContent = v; }
        /* The mini KEEPS the leading '+' on NRR (unlike the full
           table, which strips it) — the baked mini shows +1.256. */
        setCell(1, r.played); setCell(2, r.won); setCell(3, r.lost);
        setCell(4, r.points); setCell(5, r.nrrDisplay);
        /* Move the row only when its element position is wrong: an
           unconditional appendChild piles the tbody's whitespace text
           nodes at the front (the M30 no-op wrote 9 spaces). */
        var kids = tbody.children;
        if (kids[wantIdx] !== tr) tbody.insertBefore(tr, kids[wantIdx] || null);
      });
      changed = true;
    }
    if (changed) writes.points++;
    return changed;
  }

  /* ---- stats tables ---- */
  var STAT_SECTIONS = [
    { h3: 'Most runs', key: 'runs', top: 10 },
    { h3: 'Most wickets', key: 'wkts', top: 10 },
    { h3: 'High scores', key: 'highScores', top: 10 },
    { h3: 'Best bowling', key: 'bestBowl', top: 10 },
    { h3: 'High team totals', key: 'teamTotals', top: 10 },
    { h3: 'Most catches', key: 'catches', top: 10 },
    { h3: 'Highest strike rates', key: 'sr', top: 10 },
    { h3: 'Most sixes', key: 'sixes', top: 10 },
    { h3: 'Most fours', key: 'fours', top: 10 },
    { h3: '50s and 100s', key: 'fifties', top: 10 },
    { h3: 'Fastest 50', key: 'fastest50', top: 10 },
    { h3: 'Most ducks', key: 'ducks', top: 10 }
  ];
  function sectionTables(h3Text) {
    var out = [];
    var heads = document.querySelectorAll('h3');
    for (var i = 0; i < heads.length; i++) {
      if ((heads[i].textContent || '').trim() !== h3Text) continue;
      var node = heads[i].parentElement;
      while (node) {
        var tables = node.querySelectorAll(':scope table.rx-sortable');
        if (tables.length) {
          for (var t = 0; t < tables.length; t++) out.push(tables[t]);
          return out;
        }
        node = node.parentElement;
        if (node && node.tagName === 'SECTION') break;
      }
    }
    return out;
  }
  function rowCellsHtml(row, key, cfg, slugMap) {
    /* Returns the <td> innerHTML list for one computed row. */
    var base = cfg.basePath;
    function nameCell(name) { return playerCellHtml(name, slugMap, base); }
    switch (key) {
      case 'runs': return [nameCell(row[0]), row[1], row[2], row[3], row[4], row[5]];
      case 'wkts': return [nameCell(row[0]), row[1], row[2], row[3], row[4], row[5], row[6]];
      case 'highScores': return [nameCell(row[0]), row[1], row[2], row[3], row[4], row[5], matchCellHtml(row[6], cfg)];
      case 'bestBowl': return [nameCell(row[0]), row[1], row[2], row[3], row[4], matchCellHtml(row[5], cfg)];
      case 'teamTotals': {
        var code = row[0].split(' ').pop();
        var nm = row[0].slice(0, row[0].length - code.length - 1);
        return [tm(nm, code), row[1], row[2], row[3], row[4], esc(row[5])];
      }
      case 'catches': return [nameCell(row[0]), row[1], row[2]];
      case 'sr': return [nameCell(row[0]), row[1], row[2], row[3], row[4]];
      case 'sixes': case 'fours': return [nameCell(row[0]), row[1], row[2], row[3]];
      case 'fifties': return [nameCell(row[0]), row[1], row[2], row[3]];
      case 'fastest50': return [nameCell(row[0]), row[1], row[2], row[3], row[4], matchCellHtml(row[5], cfg)];
      case 'ducks': {
        /* The ducks table uses a display alias (live page quirk, from
           the bake's DUCKS_DISPLAY): the link still goes to the full
           name's slug, only the visible text is shortened. */
        var alias = (cfg.ducksDisplay || {})[row[0]];
        return [alias ? playerCellHtml(alias, slugMap, base, row[0]) : nameCell(row[0]), row[1], row[2]];
      }
    }
    return [];
  }
  function renderTableRows(table, rows, key, cfg, slugMap) {
    var tbody = table.querySelector('tbody');
    if (!tbody) return false;
    var existing = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
    var changed = false;
    rows.forEach(function (row, i) {
      var cells = rowCellsHtml(row, key, cfg, slugMap);
      var tr = existing[i];
      if (!tr) {
        tr = document.createElement('tr');
        tr.innerHTML = cells.map(function (c) { return '<td>' + c + '</td>'; }).join('');
        tbody.appendChild(tr);
        changed = true;
        return;
      }
      var tds = tr.querySelectorAll('td');
      cells.forEach(function (c, j) {
        if (tds[j] && tds[j].innerHTML !== c) { tds[j].innerHTML = c; changed = true; }
      });
    });
    for (var k = existing.length - 1; k >= rows.length; k--) {
      tbody.removeChild(existing[k]);
      changed = true;
    }
    return changed;
  }
  function renderStatsTables(tab, cfg, slugMap) {
    var changed = false;
    STAT_SECTIONS.forEach(function (sec) {
      var tables = sectionTables(sec.h3);
      if (!tables.length) return;
      var list = tab[sec.key] || [];
      if (renderTableRows(tables[0], list.slice(0, sec.top), sec.key, cfg, slugMap)) changed = true;
      if (tables[1]) {
        /* The baked <details> table holds ONLY rows 11+ (the visible
           table has 1-10) — the full list would duplicate the top 10. */
        if (renderTableRows(tables[1], list.slice(sec.top), sec.key, cfg, slugMap)) changed = true;
        var det = tables[1].closest('details.rx-more');
        if (det) {
          var sum = det.querySelector('summary');
          if (sum) {
            var noun = sum.textContent.replace(/^\s*See all \d+\s*/, '');
            var want = 'See all ' + list.length + ' ' + noun;
            if (sum.textContent !== want) { sum.textContent = want; changed = true; }
          }
        }
      }
    });
    if (changed) writes.stats++;
    return changed;
  }
  function renderTeamStats(tab, cfg, slugMap) {
    var heads = document.querySelectorAll('h2');
    for (var i = 0; i < heads.length; i++) {
      if ((heads[i].textContent || '').trim() !== 'Team stats') continue;
      var sec = heads[i].closest('section') || heads[i].parentElement;
      var table = sec ? sec.querySelector('table.rx-sortable') : null;
      if (!table) return false;
      var rows = (tab.teams || []).map(function (r) {
        var code = r[0];
        /* The baked team cell is a LINK wrapping the tm spans. */
        return ['<a href="' + cfg.basePath + 'teams/' + cfg.teams[code].slug + '/">' +
          tm(r[1], code) + '</a>', r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]];
      });
      var tbody = table.querySelector('tbody');
      if (!tbody) return false;
      var existing = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
      var changed = false;
      rows.forEach(function (cells, ri) {
        var tr = existing[ri];
        if (!tr) {
          tr = document.createElement('tr');
          tr.innerHTML = cells.map(function (c) { return '<td>' + c + '</td>'; }).join('');
          tbody.appendChild(tr); changed = true; return;
        }
        var tds = tr.querySelectorAll('td');
        cells.forEach(function (c, j) {
          if (tds[j] && tds[j].innerHTML !== c) { tds[j].innerHTML = c; changed = true; }
        });
      });
      if (changed) writes.stats++;
      return changed;
    }
    return false;
  }
  function renderRecords(rec, cfg, slugMap) {
    var heads = document.querySelectorAll('h2');
    for (var i = 0; i < heads.length; i++) {
      if ((heads[i].textContent || '').trim() !== 'Season records') continue;
      var sec = heads[i].closest('section') || heads[i].parentElement;
      var table = sec ? sec.querySelector('table') : null;
      if (!table) return false;
      var tbody = table.querySelector('tbody');
      if (!tbody) return false;
      var changed = false;
      var rows = tbody.querySelectorAll('tr');
      rec.rows.forEach(function (r, ri) {
        var tr = rows[ri];
        if (!tr) return;
        var tds = tr.querySelectorAll('td');
        var holder;
        if (r[7]) {
          holder = '<a href="' + cfg.basePath + 'teams/' + cfg.teams[r[3]].slug + '/">' +
            tm(cfg.teams[r[3]].name, r[3]) + '</a> \u2014 ' + esc(r[2]);
        } else {
          holder = playerCellHtml(r[1], slugMap, cfg.basePath) + ' \u2014 ' + esc(r[2]);
        }
        var match = tm(cfg.teams[r[3]].name, r[3]) + ' vs ' +
          tm(cfg.teams[r[4]].name, r[4]) + ', Match ' + r[5] + ', ' + dateLabel(r[6]);
        if (tds[1] && tds[1].innerHTML !== holder) { tds[1].innerHTML = holder; changed = true; }
        if (tds[2] && tds[2].innerHTML !== match) { tds[2].innerHTML = match; changed = true; }
      });
      var note = sec ? sec.querySelector('p.note') : null;
      if (note && note.textContent !== rec.note) { note.textContent = rec.note; changed = true; }
      var intro = null;
      /* The intro is NOT in this section: it is the page's first
         paragraph, inside <section id="top"> right after the H1.
         (Found by the flip harness: renderRecords used to look for
         it here and silently never updated it.) */
      var top = document.getElementById('top');
      var ps = top ? top.querySelectorAll('p') : document.querySelectorAll('p');
      for (var p = 0; p < ps.length; p++) {
        if ((ps[p].textContent || '').indexOf('SialTV lists every figure') === 0) { intro = ps[p]; break; }
      }
      if (intro) {
        /* The baked intro starts with a link: <a href="/">SialTV</a>
           lists every figure… — keep the anchor, replace only the
           text after it. */
        var link = intro.querySelector('a');
        var rest = rec.intro.slice('SialTV'.length);
        if (link) {
          var after = '';
          var node = link.nextSibling;
          while (node) { after += node.textContent || ''; node = node.nextSibling; }
          if (after !== rest) {
            while (link.nextSibling) intro.removeChild(link.nextSibling);
            intro.appendChild(document.createTextNode(rest));
            changed = true;
          }
        } else if (intro.textContent !== rec.intro) {
          intro.textContent = rec.intro; changed = true;
        }
      }
      if (changed) writes.stats++;
      return changed;
    }
    return false;
  }
  function renderPerfCards(tab, agg, cfg, slugMap) {
    var changed = false;
    var cards = document.querySelectorAll('.rx-perf-card');
    var defs = [
      { h3: 'Top Run Scorers', rows: tab.perfRuns, raw: agg.batRaw, kind: 'bat' },
      { h3: 'Top Wicket Takers', rows: tab.perfWkts, raw: agg.bowlRaw, kind: 'bowl' },
      { h3: 'Best Batting Strike Rates', rows: tab.perfSr, raw: agg.batRaw, kind: 'bat' },
      { h3: 'Best Bowling Economy', rows: tab.perfEcon, raw: agg.bowlRaw, kind: 'bowl' }
    ];
    defs.forEach(function (def) {
      var card = null;
      for (var i = 0; i < cards.length; i++) {
        var h = cards[i].querySelector('h3');
        if (h && (h.textContent || '').trim() === def.h3) { card = cards[i]; break; }
      }
      if (!card) return;
      var grid = card.querySelector('.rx-perf-grid') || card;
      var existing = Array.prototype.slice.call(grid.querySelectorAll('.rx-perf-row'));
      var byName = {};
      existing.forEach(function (row) {
        var a = row.querySelector('.rx-perf-who a');
        if (a) byName[(a.textContent || '').trim()] = row;
      });
      def.rows.forEach(function (r, idx) {
        var name = r[0], fig;
        var raw = def.raw[name] || {};
        var mat = raw.mat || 0, ave = '\u2013';
        if (def.kind === 'bat') {
          ave = fmtAve(raw.runs || 0, raw.outs || 0);
          fig = (def.h3 === 'Best Batting Strike Rates') ? r[4] : r[2];
        } else {
          ave = fmtAve(raw.runs || 0, raw.wkts || 0);
          fig = (def.h3 === 'Best Bowling Economy') ? r[3] : r[2];
        }
        /* The aggregate does not track a player's current team, so the
           sub-line's team-code prefix is kept from the baked row when
           the row exists; a brand-new entrant renders without one. */
        var row = byName[name];
        var sub = 'Innings: ' + mat + '\u00A0\u00A0Average: ' + ave;
        if (!row) {
          row = document.createElement('div');
          row.className = 'rx-perf-row';
          row.innerHTML = '<span class="tp-photo tp-initials" aria-hidden="true">' + esc(initialsOfName(name)) + '</span>' +
            '<div class="rx-perf-who">' + playerCellHtml(name, slugMap, cfg.basePath) +
            '<span>' + sub + '</span></div>' +
            '<span class="rx-perf-fig">' + esc(fig) + '</span>';
          grid.appendChild(row);
          changed = true;
        } else {
          var who = row.querySelector('.rx-perf-who');
          var whoA = who ? who.querySelector('a') : null;
          var whoSpan = who ? who.querySelector('span') : null;
          var figEl = row.querySelector('.rx-perf-fig');
          if (whoA) {
            var wantLink = playerCellHtml(name, slugMap, cfg.basePath);
            var tmp = document.createElement('div'); tmp.innerHTML = wantLink;
            var wantA = tmp.firstChild;
            if (wantA.tagName === 'A') {
              if (whoA.getAttribute('href') !== wantA.getAttribute('href')) whoA.setAttribute('href', wantA.getAttribute('href'));
              if (whoA.textContent !== name) whoA.textContent = name;
            } else {
              whoA.outerHTML = wantLink;
            }
          }
          if (whoSpan) {
            var cur = whoSpan.textContent;
            var mm = /^(.* \u00B7 )Innings:.*$/.exec(cur);
            var wantSub = (mm ? mm[1] : '') + sub;
            if (cur !== wantSub) { whoSpan.textContent = wantSub; changed = true; }
          }
          if (figEl && figEl.textContent !== String(fig)) { figEl.textContent = fig; changed = true; }
          if (row.parentElement !== grid) grid.appendChild(row);
        }
        var rows = grid.querySelectorAll('.rx-perf-row');
        if (rows[idx] !== row) {
          grid.insertBefore(row, rows[idx] || null);
          changed = true;
        }
      });
    });
    if (changed) writes.stats++;
    return changed;
  }
  function renderSidebarLeaders(tab, agg, cfg, slugMap) {
    var changed = false;
    var defs = [
      { h3: 'Top Wicket Takers', rows: tab.perfWkts, raw: agg.bowlRaw, kind: 'bowl' },
      { h3: 'Top Run Scorers', rows: tab.perfRuns, raw: agg.batRaw, kind: 'bat' }
    ];
    defs.forEach(function (def) {
      var cards = document.querySelectorAll('.side-card');
      var card = null;
      for (var i = 0; i < cards.length; i++) {
        var h = cards[i].querySelector('h3');
        if (h && (h.textContent || '').trim() === def.h3) { card = cards[i]; break; }
      }
      if (!card) return;
      var ul = card.querySelector('ul.tp-list');
      if (!ul) return;
      var existing = Array.prototype.slice.call(ul.querySelectorAll('li'));
      var byName = {};
      existing.forEach(function (li) {
        var a = li.querySelector('.tp-name');
        if (a) byName[(a.textContent || '').trim()] = li;
      });
      def.rows.forEach(function (r, idx) {
        var name = r[0];
        var raw = def.raw[name] || {};
        var fig = r[2];
        var mat = raw.mat || 0;
        var ave = def.kind === 'bat' ? fmtAve(raw.runs || 0, raw.outs || 0)
          : fmtAve(raw.runs || 0, raw.wkts || 0);
        var li = byName[name];
        if (!li) {
          li = document.createElement('li');
          li.innerHTML = '<span class="tp-photo tp-initials" aria-hidden="true">' + esc(initialsOfName(name)) + '</span>' +
            '<div class="tp-main">' + sidebarNameHtml(name, slugMap, cfg.basePath) +
            '<span class="tp-sub">Innings: ' + mat + ' &middot; Average: ' + ave + '</span></div>' +
            '<strong class="tp-fig">' + esc(fig) + '</strong>';
          /* The baked rows carry a team sub-line first; a new entrant
             has no team in the aggregate, so the single sub-line stands. */
          ul.appendChild(li);
          changed = true;
        } else {
          var main = li.querySelector('.tp-main');
          var a = main ? main.querySelector('.tp-name') : null;
          var subs = main ? main.querySelectorAll('.tp-sub') : [];
          var figEl = li.querySelector('.tp-fig');
          if (a && a.textContent !== name) { a.textContent = name; changed = true; }
          if (subs.length) {
            var last = subs[subs.length - 1];
            var want = 'Innings: ' + mat + ' \u00B7 Average: ' + ave;
            if (last.textContent !== want) { last.textContent = want; changed = true; }
          }
          if (figEl && figEl.textContent !== String(fig)) { figEl.textContent = fig; changed = true; }
        }
        var items = ul.querySelectorAll('li');
        if (items[idx] !== li) { ul.insertBefore(li, items[idx] || null); changed = true; }
      });
      while (ul.querySelectorAll('li').length > 3) {
        ul.removeChild(ul.querySelectorAll('li')[3]);
        changed = true;
      }
    });
    if (changed) writes.stats++;
    return changed;
  }
  function renderZeroLists(tab, cfg) {
    var changed = false;
    var defs = [
      { re: /yet to score a run/, list: tab.zeroRun || [],
        one: 'player yet to score a run', many: 'players yet to score a run' },
      { re: /yet to take a wicket/, list: tab.zeroWk || [],
        one: 'bowler yet to take a wicket', many: 'bowlers yet to take a wicket' }
    ];
    function chipName(li) {
      for (var n = 0; n < li.childNodes.length; n++) {
        if (li.childNodes[n].nodeType === 3) return (li.childNodes[n].textContent || '').trim();
      }
      return '';
    }
    var blocks = document.querySelectorAll('details.rx-zero');
    for (var b = 0; b < blocks.length; b++) {
      var det = blocks[b];
      var sum = det.querySelector('summary');
      if (!sum) continue;
      var def = null;
      for (var d = 0; d < defs.length; d++) {
        if (defs[d].re.test(sum.textContent || '')) { def = defs[d]; break; }
      }
      if (!def) continue;
      var ul = det.querySelector('ul.rx-zero-chips');
      if (!ul) continue;
      var want = {};
      def.list.forEach(function (row) { want[row[0]] = row[1]; });
      /* Remove leavers and update match counts in place. The baked
         chip order is KEPT: the zero-wk order on the baked page is
         not the compute order, so rebuilding the list would reorder
         it on the first poll. New entrants append at the end. */
      Array.prototype.slice.call(ul.querySelectorAll('li')).forEach(function (li) {
        var name = chipName(li);
        if (!Object.prototype.hasOwnProperty.call(want, name)) { ul.removeChild(li); changed = true; return; }
        var span = li.querySelector('span');
        var label = '(' + want[name] + ' match' + (want[name] === 1 ? '' : 'es') + ')';
        if (span && span.textContent !== label) { span.textContent = label; changed = true; }
      });
      var have = {};
      Array.prototype.forEach.call(ul.querySelectorAll('li'), function (li) { have[chipName(li)] = true; });
      def.list.forEach(function (row) {
        if (have[row[0]]) return;
        var li = document.createElement('li');
        li.innerHTML = esc(row[0]) + ' <span>(' + row[1] + ' match' + (row[1] === 1 ? '' : 'es') + ')</span>';
        ul.appendChild(li);
        changed = true;
      });
      var count = def.list.length;
      var wantSum = count + ' ' + (count === 1 ? def.one : def.many);
      if (sum.textContent !== wantSum) { sum.textContent = wantSum; changed = true; }
    }
    if (changed) writes.stats++;
    return changed;
  }
  function renderAllStats(tab, rec, raw, cfg, slugMap) {
    /* raw = tables()'s output, which carries batRaw/bowlRaw/played
       for the perf cards + sidebar leaders. */
    var c = false;
    if (renderStatsTables(tab, cfg, slugMap)) c = true;
    if (renderTeamStats(tab, cfg, slugMap)) c = true;
    if (renderRecords(rec, cfg, slugMap)) c = true;
    if (renderPerfCards(tab, raw, cfg, slugMap)) c = true;
    if (renderSidebarLeaders(tab, raw, cfg, slugMap)) c = true;
    if (renderZeroLists(tab, cfg)) c = true;
    return c;
  }

  /* ================= polling ================= */
  var POLL_LIVE_MS = 30000, POLL_IDLE_MS = 120000;
  var SETTLE_CAP = 10;
  var state = {
    league: null, cfg: null, slugMap: {},
    matchesByNo: {}, prevStatus: {},
    pendingFlip: false, settlePolls: 0,
    lastHash: null, timer: null, stopped: false
  };
  function apiUrl() {
    return '/api/live-scores.php?league=' + state.league;
  }
  function aggUrl(hash) {
    return '/data/runtime/' + state.league + '-stats-agg.json' +
      (hash ? '?v=' + hash : '');
  }
  function anyLive(matches) {
    for (var i = 0; i < matches.length; i++) {
      if (matches[i].status === 'live') return true;
    }
    return false;
  }
  function computeAndRender(matches) {
    var points = computePoints(matches, state.cfg);
    var byNo = {};
    matches.forEach(function (m) { byNo[m.matchNo] = m; });
    state.matchesByNo = byNo;
    renderPointsTable(points, byNo, matches, state.cfg);
    renderMinis(points, state.cfg);
    return points;
  }
  function renderFromAggregate(agg) {
    /* The aggregate FILE stores matches[] + fullNames; the computed
       tables come from aggregate() over those matches. */
    var computed = aggregate(agg.matches, state.cfg, agg.fullNames);
    var tab = tables(computed, state.cfg, pointsMiniRows(computePoints(agg.matches, state.cfg)));
    var rec = records(computed, tab, state.cfg);
    renderAllStats(tab, rec, tab, state.cfg, state.slugMap);
    return { tab: tab, rec: rec };
  }
  function pollOnce() {
    if (state.stopped || document.hidden) return Promise.resolve(false);
    return fetch(apiUrl(), { cache: 'no-cache', headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('api ' + r.status); return r.json(); })
      .then(function (payload) {
        var matches = payload.matches || [];
        var flip = false;
        matches.forEach(function (m) {
          var prev = state.prevStatus[m.matchNo];
          if (prev === 'live' && (m.status === 'result' || isAbandoned(m))) flip = true;
          state.prevStatus[m.matchNo] = m.status;
        });
        if (flip) { state.pendingFlip = true; state.settlePolls = 0; }
        computeAndRender(matches);
        var sv = payload.statsVersion;
        if (sv && sv.hash && sv.hash !== state.lastHash) {
          state.lastHash = sv.hash;
          if (state.pendingFlip || sv.results > 0) {
            return fetch(aggUrl(sv.hash), { cache: 'no-cache', headers: { 'Accept': 'application/json' } })
              .then(function (r) { if (!r.ok) throw new Error('agg ' + r.status); return r.json(); })
              .then(function (agg) {
                if (agg.version && agg.version.withCards === agg.version.results) {
                  renderFromAggregate(agg);
                  if (state.pendingFlip) {
                    state.pendingFlip = false;
                    state.settlePolls = 0;
                  }
                }
                return anyLive(matches);
              })
              .catch(function (e) { if (window.console) console.warn('[sialtv] aggregate fetch failed', e); return anyLive(matches); });
          }
        }
        if (state.pendingFlip) {
          state.settlePolls++;
          if (state.settlePolls >= SETTLE_CAP) {
            state.pendingFlip = false;
            state.settlePolls = 0;
          }
        }
        return anyLive(matches);
      })
      .catch(function (e) {
        if (window.console) console.warn('[sialtv] poll failed', e);
        return false;
      });
  }
  function schedule(ms) {
    if (state.stopped) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      pollOnce().then(function (live) {
        schedule(live || state.pendingFlip ? POLL_LIVE_MS : POLL_IDLE_MS);
      });
    }, ms);
  }
  function boot() {
    var path = location.pathname.replace(/^\/+|\/+$/g, '');
    var first = path.split('/')[0];
    if (!LEAGUES[first]) return;
    state.league = first;
    state.cfg = LEAGUES[first];
    state.slugMap = slugMapFromDom(state.cfg.basePath);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !state.stopped) {
        clearTimeout(state.timer);
        pollOnce().then(function (live) {
          schedule(live || state.pendingFlip ? POLL_LIVE_MS : POLL_IDLE_MS);
        });
      }
    });
    schedule(0);
  }
  if (typeof document !== 'undefined' && document.readyState !== 'loading') boot();
  else if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', boot);

  var api = {
    LEAGUES: LEAGUES, PLAYOFF_DESCS: PLAYOFF_DESCS,
    aggregate: aggregate, tables: tables, records: records,
    computePoints: computePoints, pointsMiniRows: pointsMiniRows,
    leadHtml: leadHtml, resultText: resultText, detailRowsHtml: detailRowsHtml,
    nextCellHtml: nextCellHtml, parseScore: parseScore, oversToBalls: oversToBalls,
    ballsToOvers: ballsToOvers, pyRound: pyRound, pyFixed: pyFixed,
    fmtAve: fmtAve, fmtSr: fmtSr, fmtEcon: fmtEcon, fmtBsr: fmtBsr,
    dateLabel: dateLabel, dateLong: dateLong, ordinal: ordinal, tm: tm,
    cleanTeam: cleanTeam, teamCodeOf: teamCodeOf, playerCellHtml: playerCellHtml,
    _state: state, _pollOnce: pollOnce, _computeAndRender: computeAndRender,
    _renderFromAggregate: renderFromAggregate, _boot: boot
  };
  if (typeof window !== 'undefined') window.sialtvPointsStats = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
