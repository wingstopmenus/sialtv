/* SialTV flash strip — a row of match cards (live, latest result,
   next fixture) driven by the one shared feed. On the live-scores page
   it fills #sialtvFlash; on the homepage and the NPL hub it refreshes
   the baked carousel cards that carry a data-match-no. Baked cards are
   left alone when the feed has nothing newer for them — except the two
   cases the carousel could never show: an upcoming card has no score
   spans, so the first live score creates them, and the filter pills
   carry baked counts, so a flip re-counts them. */
(function () {
  'use strict';
  var POLL_MS = 30 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function chip(name) {
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
    if (live.crr) bits.push('CRR ' + live.crr);
    return bits.join(' · ');
  }

  function liveLine(m) {
    var parts = [];
    var st = m.statusText || '';
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
    var st = m.statusText || '';
    if (st.indexOf(m.team1 + ' won') === 0) w = 0;
    else if (st.indexOf(m.team2 + ' won') === 0) w = 1;
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
    var html = '<a class="score-card" data-kind="' + kind + '" data-match-no="' + m.matchNo + '" href="' + matchUrl(league, m.matchNo) + '">';
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
    var cards = carousel.querySelectorAll('.score-card[data-match-no]');
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
        else if (m.status === 'result') result.textContent = m.statusText || result.textContent;
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

  function boot() {
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
      var league = (flash && flash.getAttribute('data-league')) || 'npl';
      loaders.push(function () {
        if (document.hidden) return;
        window.sialtvScores(league).then(function (data) {
          if (!data || !data.matches || !data.matches.length) return;
          if (flash) refreshFlash(flash, data, league);
          if (carousel) refreshCarousel(carousel, data);
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
