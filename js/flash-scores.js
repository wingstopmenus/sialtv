/* SialTV flash strip — a row of match cards (live, latest result,
   next fixture) driven by the one shared feed. On the live-scores page
   it fills #sialtvFlash; on the homepage and the NPL hub it refreshes
   the baked carousel cards that carry a data-match-no. Baked cards are
   left alone when the feed has nothing newer for them — except the two
   cases the carousel could never show: an upcoming card has no score
   spans, so the first live score creates them, and the filter pills
   carry baked counts, so a flip re-counts them.
   v6 (2026-11-12, homepage clean rebuild): also updates the homepage's
   Match Coverage panels (data-mc-panel — kicker status word + live
   stand line) and hides live/result rows from the sidebar "Coming up";
   computes CRR from the score when the feed leaves crr empty.
   v7 (2026-11-13): carousel Match strip (.st-strip) — league pills,
   right-arrow scroll and kickoff countdowns on upcoming cards.
   v8 (2026-11-13): "All Matches" tab first (merged across leagues),
   previous arrow, 3-day post-final league expiry, compact cards. */
(function () {
  'use strict';
  var POLL_MS = 30 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function chip(name) {
    var img = window.sialtvTeamLogos && window.sialtvTeamLogos[String(name || '').trim()];
    if (img) return img;
    var bits = String(name || '').trim().split(/\s+/);
    var ini = bits.map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
    return '<span class="sc-chip">' + esc(ini) + '</span>';
  }

  /* Match pages exist for npl, ilt20, sa20 and bbl only; apl and psl
     fall back to the results list until their match pages exist. */
  var MATCH_SEASON = { npl: '2026', ilt20: '2026-27', sa20: '2026-27', bbl: '2026-27' };
  function matchUrl(league, matchNo) {
    var season = MATCH_SEASON[league];
    return season ? '/' + league + '/matches/' + season + '/match-' + matchNo + '/' : '/' + league + '/results/';
  }

  function scoreText(score, overs) {
    if (!score) return '';
    return score + (overs ? ' (' + overs + ' ov)' : '');
  }

  /* Run rate from the score when the feed leaves crr empty (it usually
     does — the normaliser does not carry it). Overs are cricket
     notation: "15.2" is 15 overs + 2 balls. */
  function crrOf(m) {
    var live = m.live || null;
    if (live && live.crr) return live.crr;
    var runs = parseInt(String(m.score1 || '0').split('/')[0], 10);
    var ov = String(m.overs1 || '');
    var parts = ov.split('.');
    var o = parseInt(parts[0] || '0', 10) + (parseInt(parts[1] || '0', 10) / 6);
    if (!runs || !o) return '';
    return (runs / o).toFixed(2);
  }

  function shortName(name) {
    return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  /* The feed's statusText carries the league suffix on every team
     ("Biratnagar Kings (NPL) need 27 runs...") — the card shows the
     plain name. */
  function cleanStatus(s) {
    return String(s || '').replace(/\s*\([A-Z0-9]+\)/g, '');
  }

  /* Live details for the short line under the scores: batters at the
     crease and the run rate, Cricinfo-strip style. */
  function liveDetails(m) {
    var live = m.live || null;
    if (!live) return '';
    var bits = [];
    var bats = (live.batters || []).map(function (b) {
      return b.name + ' ' + b.runs + (b.striker ? '*' : '');
    }).join(', ');
    if (bats) bits.push(bats);
    var crr = crrOf(m);
    if (crr) bits.push('CRR ' + crr);
    return bits.join(' · ');
  }

  function liveLine(m) {
    var parts = [];
    var st = cleanStatus(m.statusText);
    if (st && st !== 'Live' && st !== 'Upcoming') parts.push(st);
    var d = liveDetails(m);
    if (d) parts.push(d);
    return parts.length ? parts.join(' · ') : 'Live now';
  }

  /* The loser row is dimmed. The winner comes from the result line
     ("<team> won by ..."), never from comparing runs — a D/L winner
     can have fewer runs than the first innings. No winner named
     (tie / no result) means no loser row. */
  function setLoser(card, m) {
    var rows = card.querySelectorAll('.sc-row');
    if (!rows.length) return;
    if (m.status !== 'result') {
      if (m.status === 'live') rows.forEach(function (r) { r.classList.remove('loser'); });
      return;
    }
    var w = -1;
    var st = cleanStatus(m.statusText);
    if (st.indexOf(shortName(m.team1) + ' won') === 0) w = 0;
    else if (st.indexOf(shortName(m.team2) + ' won') === 0) w = 1;
    rows.forEach(function (row, i) { row.classList.toggle('loser', w >= 0 && i !== w); });
  }

  /* The filter pills carry baked counts ("Results (5)"). Re-count from
     the cards' data-kind after a flip, so a finished match moves the
     counts with it. */
  function recountPills(carousel) {
    var pills = document.querySelectorAll('.pill[data-filter]');
    if (!pills.length) return;
    var n = { all: 0, upcoming: 0, result: 0 };
    carousel.querySelectorAll('.score-card[data-match-no]').forEach(function (c) {
      n.all++;
      if (c.getAttribute('data-kind') === 'result') n.result++;
      else n.upcoming++;
    });
    pills.forEach(function (p) {
      var f = p.getAttribute('data-filter');
      if (n[f] == null) return;
      p.textContent = p.textContent.replace(/\(\d+\)\s*$/, '(' + n[f] + ')');
    });
  }

  /* Venue city shown on a card built from scratch (the strip starts
     empty). Baked cards carry their own venue line. */
  var VENUE = { npl: 'Kirtipur', ilt20: 'Dubai', apl: 'UAE', sa20: 'South Africa', bbl: 'Australia' };

  function cardHtml(m, league) {
    var kind = m.status === 'live' ? 'live' : (m.status === 'result' ? 'result' : 'upcoming');
    var label = m.status === 'live' ? 'Live now' : (m.status === 'result' ? 'Result' : 'Upcoming');
    var html = '<a class="score-card" data-kind="' + kind + '" data-match-no="' + m.matchNo + '" data-league="' + esc(league) + '" href="' + matchUrl(league, m.matchNo) + '">';
    html += '<p class="sc-label' + (kind === 'upcoming' ? ' upcoming' : '') + '">' + label + '</p>';
    html += '<p class="sc-match">Match ' + m.matchNo + ' &middot; ' + esc(VENUE[league] || 'Kirtipur') + '</p>';
    html += '<p class="sc-row"><span class="sc-team">' + chip(m.team1) + esc(m.team1) + '</span><span class="sc-score">' + esc(m.score1 || '') + (m.overs1 ? ' (' + esc(m.overs1) + ' ov)' : '') + '</span></p>';
    html += '<p class="sc-row"><span class="sc-team">' + chip(m.team2) + esc(m.team2) + '</span><span class="sc-score">' + esc(m.score2 || '') + (m.overs2 ? ' (' + esc(m.overs2) + ' ov)' : '') + '</span></p>';
    html += '<p class="sc-result' + (kind === 'upcoming' ? ' upcoming' : '') + '">' + esc(m.status === 'live' ? liveLine(m) : (m.statusText || '')) + '</p></a>';
    return html;
  }

  function refreshFlash(root, data, league) {
    /* Baked cards stay: update the ones the feed knows about in place
       (same updater as the carousel) and never drop the older baked
       cards the feed does not carry. Only build from scratch when the
       strip starts empty. */
    if (root.querySelectorAll('.score-card[data-match-no]').length) {
      refreshCarousel(root, data);
      return;
    }
    var p = window.sialtvPick((data && data.matches) || []);
    var cards = [];
    if (p.live) cards.push(p.live);
    if (p.latest && (!p.live || p.latest.matchNo !== p.live.matchNo)) cards.push(p.latest);
    if (p.next) cards.push(p.next);
    if (cards.length) root.innerHTML = cards.map(function (m) { return cardHtml(m, league); }).join('');
  }

  function refreshCarousel(carousel, data) {
    var byNo = {};
    (data.matches || []).forEach(function (m) { byNo[m.matchNo] = m; });
    var cards = Array.prototype.slice.call(carousel.querySelectorAll('.score-card[data-match-no]'));
    /* The "All Matches" track duplicates this league's cards — update
       the copies too, matched by league + match number. */
    var league = carousel.getAttribute('data-league');
    if (league) {
      document.querySelectorAll('[data-strip-group="all"] .score-card[data-league="' + league + '"][data-match-no]').forEach(function (c) { cards.push(c); });
    }
    cards.forEach(function (card) {
      var m = byNo[parseInt(card.getAttribute('data-match-no'), 10)];
      if (!m) return;
      var label = card.querySelector('.sc-label');
      var result = card.querySelector('.sc-result');
      var rows = card.querySelectorAll('.sc-row');
      if (label) {
        label.textContent = m.status === 'live' ? 'Live now' : (m.status === 'result' ? 'Result' : 'Upcoming');
        label.classList.toggle('upcoming', m.status === 'upcoming');
      }
      /* Upcoming cards are baked without .sc-score spans, so a live
         score would have nowhere to go — create the span the first
         time the feed carries a score for that side. A side the feed
         has no score for keeps its baked row untouched. */
      rows.forEach(function (row, i) {
        var s = scoreText(i === 0 ? m.score1 : m.score2, i === 0 ? m.overs1 : m.overs2);
        if (!s) return;
        var span = row.querySelector('.sc-score');
        if (!span) {
          span = document.createElement('span');
          span.className = 'sc-score';
          row.appendChild(span);
        }
        span.textContent = s;
      });
      if (result) {
        /* Upcoming: the baked line carries the date, time and venue —
           the feed's statusText for an upcoming match is either the
           same line or a bare "Upcoming", so it stays put. */
        if (m.status === 'live') result.textContent = liveLine(m);
        else if (m.status === 'result') result.textContent = cleanStatus(m.statusText) || result.textContent;
        result.classList.toggle('upcoming', m.status === 'upcoming');
      }
      setLoser(card, m);
      /* Live matches join the "Live & upcoming" filter bucket — the
         pills only know all / upcoming / result, and a data-kind of
         "live" would hide a live card under every filter. */
      card.setAttribute('data-kind', m.status === 'result' ? 'result' : 'upcoming');
    });
    recountPills(carousel);
  }

  /* Match Coverage panels (homepage): a panel carries
     data-mc-panel="m22" and shows the match's status word in its kicker
     ("Upcoming"/"Live now"/"Result") plus a live line in its stand.
     Live and result panels are updated from the feed; upcoming panels
     are left exactly as baked. */
  function refreshMcPanels(data) {
    if (!data || !data.matches) return;
    var panels = document.querySelectorAll('.mc-panel[data-mc-panel]');
    if (!panels.length) return;
    var byNo = {};
    data.matches.forEach(function (m) { byNo[m.matchNo] = m; });
    panels.forEach(function (panel) {
      var raw = panel.getAttribute('data-mc-panel') || '';
      var no = parseInt(raw.replace(/[^0-9]/g, ''), 10);
      var m = byNo[no];
      if (!m) return;
      if (m.status !== 'live' && m.status !== 'result') return;
      var kicker = panel.querySelector('.lead-kicker');
      if (kicker) {
        var datePart = kicker.textContent.split('·').pop().trim();
        var label = m.status === 'live' ? 'Live now' : 'Result';
        var dot = m.status === 'live'
          ? '<span class="live-dot" aria-hidden="true"></span>' : '';
        kicker.innerHTML = dot + esc(label) + ' &middot; ' + esc(datePart);
      }
      var stand = panel.querySelector('.lead-stand');
      if (stand) {
        if (m.status === 'live') {
          stand.textContent = shortName(m.team2) + ' ' + scoreText(m.score2, m.overs2)
            + ' · ' + shortName(m.team1) + ' ' + scoreText(m.score1, m.overs1)
            + ' — ' + liveLine(m);
        } else if (m.status === 'result') {
          stand.textContent = cleanStatus(m.statusText) || '';
        }
      }
    });
  }

  /* Sidebar "Coming up" (homepage): a match that is live or finished
     is no longer coming up, so its row is hidden. The item's link
     carries the league and match number
     (/<league>/matches/<season>/match-<no>/). Items for other leagues
     or without a link are left alone. */
  function refreshComingUp(data) {
    if (!data || !data.matches) return;
    var cards = document.querySelectorAll('.side-card');
    var byNo = {};
    data.matches.forEach(function (m) { byNo[m.matchNo] = m; });
    cards.forEach(function (card) {
      var h = card.querySelector('h3');
      if (!h || h.textContent.trim() !== 'Coming up') return;
      card.querySelectorAll('li').forEach(function (li) {
        var a = li.querySelector('a');
        if (!a) return;
        var mm = (a.getAttribute('href') || '').match(/match-(\d+)\//);
        if (!mm) return;
        var m = byNo[parseInt(mm[1], 10)];
        if (m && (m.status === 'live' || m.status === 'result')) {
          li.style.display = 'none';
        }
      });
    });
  }


  /* Carousel Match strip (.st-strip): league filter pills, the
     right-arrow scroll, and a kickoff countdown on upcoming cards
     ("Match starts in X hrs Y mins"). A card whose feed status flips
     away from upcoming hides its countdown line. */
  function stripCountdowns() {
    document.querySelectorAll('.st-strip [data-kickoff]').forEach(function (el) {
      var card = el.closest('.score-card');
      if (card && card.getAttribute('data-kind') !== 'upcoming') { el.hidden = true; return; }
      var t = Date.parse(el.getAttribute('data-kickoff'));
      if (!t) { el.hidden = true; return; }
      var diff = t - Date.now();
      if (diff <= 0) { el.hidden = true; return; }
      el.hidden = false;
      var mins = Math.floor(diff / 60000);
      var d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
      var when = d > 0 ? d + (d === 1 ? ' day ' : ' days ') + h + ' hrs'
        : (h > 0 ? h + ' hrs ' + m + ' mins' : m + ' mins');
      el.textContent = 'Match starts in ' + when;
    });
  }

  /* League end dates (finals, verified): NPL Sat 21 Nov 2026, ILT20
     Sun 20 Dec 2026, APL Wed 20 Jan 2027. A league leaves the strip
     3 days after its final — its tab, its track and its cards in the
     "All Matches" track all disappear. Checked against the current
     date on every page load, so nothing is hardcoded to hide a league
     "now": while a league is still running it keeps showing. */
  var LEAGUE_END = { npl: '2026-11-21', ilt20: '2026-12-20', apl: '2027-01-20' };
  var LEAGUE_EXPIRY_DAYS = 3;
  function leagueExpired(lg) {
    var end = LEAGUE_END[lg];
    if (!end) return false;
    var hideFrom = Date.parse(end + 'T00:00:00Z') + LEAGUE_EXPIRY_DAYS * 86400000;
    return Date.now() >= hideFrom;
  }

  function visibleTrack(strip) {
    return strip.querySelector('.st-strip-track:not([hidden])');
  }

  /* "<" shows once the track is scrolled right, ">" hides at the end;
     both hide when the APL note (no track) is showing. */
  function updateArrows(strip) {
    var prev = strip.querySelector('[data-strip-prev]');
    var next = strip.querySelector('[data-strip-next]');
    var track = visibleTrack(strip);
    if (!track) {
      if (prev) prev.style.display = 'none';
      if (next) next.style.display = 'none';
      return;
    }
    var max = track.scrollWidth - track.clientWidth;
    if (prev) prev.style.display = track.scrollLeft > 0 ? '' : 'none';
    if (next) next.style.display = track.scrollLeft < max - 1 ? '' : 'none';
  }

  function initStrip() {
    document.querySelectorAll('.st-strip').forEach(function (strip) {
      var pills = strip.querySelectorAll('[data-strip-filter]');
      var prev = strip.querySelector('[data-strip-prev]');
      var next = strip.querySelector('[data-strip-next]');
      /* 3-day expiry: hide the finished league's pill + track + its
         cards in the "All Matches" track, and re-count "All Matches". */
      var expired = {};
      var allExpired = true;
      pills.forEach(function (pill) {
        var lg = pill.getAttribute('data-strip-filter');
        if (lg === 'all') return;
        if (leagueExpired(lg)) {
          expired[lg] = true;
          pill.style.display = 'none';
        } else {
          allExpired = false;
        }
      });
      if (allExpired) { strip.style.display = 'none'; return; }
      strip.querySelectorAll('[data-strip-group]').forEach(function (g) {
        var lg = g.getAttribute('data-strip-group');
        if (lg !== 'all' && expired[lg]) g.remove();
      });
      strip.querySelectorAll('[data-strip-group="all"] .score-card[data-league]').forEach(function (c) {
        if (expired[c.getAttribute('data-league')]) c.remove();
      });
      var allPill = strip.querySelector('[data-strip-filter="all"]');
      if (allPill) {
        var total = 0;
        pills.forEach(function (p) {
          var lg = p.getAttribute('data-strip-filter');
          if (lg === 'all' || expired[lg]) return;
          var m = (p.textContent || '').match(/\((\d+)\)/);
          if (m) total += parseInt(m[1], 10);
        });
        allPill.textContent = allPill.textContent.replace(/\(\d+\)\s*$/, '(' + total + ')');
      }
      /* If the baked-active pill belonged to an expired league, fall
         back to "All Matches". */
      var active = strip.querySelector('[data-strip-filter][aria-pressed="true"]');
      if (active && expired[active.getAttribute('data-strip-filter')]) {
        active.setAttribute('aria-pressed', 'false');
        if (allPill) allPill.setAttribute('aria-pressed', 'true');
        strip.querySelectorAll('[data-strip-group]').forEach(function (g) {
          g.hidden = g.getAttribute('data-strip-group') !== 'all';
        });
      }
      pills.forEach(function (pill) {
        pill.addEventListener('click', function () {
          var lg = pill.getAttribute('data-strip-filter');
          pills.forEach(function (p) { p.setAttribute('aria-pressed', p === pill ? 'true' : 'false'); });
          strip.querySelectorAll('[data-strip-group]').forEach(function (g) {
            g.hidden = g.getAttribute('data-strip-group') !== lg;
          });
          updateArrows(strip);
          stripCountdowns();
        });
      });
      if (prev) prev.addEventListener('click', function () {
        var track = visibleTrack(strip);
        if (track) track.scrollBy({ left: -track.clientWidth * 0.8, behavior: 'smooth' });
      });
      if (next) next.addEventListener('click', function () {
        var track = visibleTrack(strip);
        if (track) track.scrollBy({ left: track.clientWidth * 0.8, behavior: 'smooth' });
      });
      strip.querySelectorAll('.st-strip-track').forEach(function (track) {
        track.addEventListener('scroll', function () { updateArrows(strip); }, { passive: true });
      });
      updateArrows(strip);
    });
    stripCountdowns();
    setInterval(stripCountdowns, 60000);
    window.addEventListener('resize', function () {
      document.querySelectorAll('.st-strip').forEach(updateArrows);
    });
  }

  function boot() {
    initStrip();
    if (!window.sialtvScores) return;
    var flash = document.getElementById('sialtvFlash');
    var carousel = document.getElementById('scoreCarousel');
    var loaders = [];
    /* Site-wide live-scores page: one .slp-flash per league, each
       polled on its own league feed. #sialtvFlash is excluded — the
       single-league path below already handles it (the NPL
       live-scores page carries both the id and the class). */
    document.querySelectorAll('.slp-flash[data-league]:not(#sialtvFlash)').forEach(function (group) {
      var lg = group.getAttribute('data-league');
      loaders.push(function () {
        if (document.hidden) return;
        window.sialtvScores(lg).then(function (data) {
          if (!data || !data.matches || !data.matches.length) return;
          refreshFlash(group, data, lg);
        }).catch(function () {});
      });
    });
    if (flash || carousel) {
      var league = (flash && flash.getAttribute('data-league')) ||
        (carousel && carousel.getAttribute('data-flash')) || 'npl';
      loaders.push(function () {
        if (document.hidden) return;
        window.sialtvScores(league).then(function (data) {
          if (!data || !data.matches || !data.matches.length) return;
          if (flash) refreshFlash(flash, data, league);
          if (carousel) refreshCarousel(carousel, data);
          refreshMcPanels(data);
          refreshComingUp(data);
        }).catch(function () {});
      });
    }
    if (!loaders.length) return;
    function loadAll() { loaders.forEach(function (fn) { fn(); }); }
    loadAll();
    setInterval(loadAll, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) loadAll(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
