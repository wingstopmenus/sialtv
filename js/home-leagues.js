/* SialTV home leagues: hide a league the day after its final, and move the
   spotlight to the next league. Static site, so this runs on page load.
   The strip's own LEAGUE_END rule (flash-scores.js, final + 3 days) is
   separate and untouched. */
(function () {
  'use strict';

  /* Final day per league (verified). A card hides and the spotlight moves
     once the day after the final begins (local date). */
  var LEAGUE_END = { npl: '2026-11-21', ilt20: '2026-12-20', apl: '2027-01-20' };
  var ORDER = ['npl', 'ilt20', 'apl'];

  var ICONS = {
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
  };

  /* Spotlight content for the leagues that follow NPL. NPL stays baked in
     the HTML; only the next leagues live here. Facts verified from the hubs. */
  var SPOT = {
    ilt20: {
      title: 'International League T20',
      intro: 'Season 5 runs from 21 November to 20 December 2026 across Dubai, Sharjah and Abu Dhabi, with six teams playing 34 matches. The opener is Desert Vipers against MI Emirates in Dubai.',
      feature: { kicker: 'Season opener · Match 1', href: '/ilt20/matches/2026-27/match-1/', h: 'Desert Vipers vs MI Emirates', p: 'The defending champions open Season 5 against MI Emirates in Dubai on Saturday, 21 November. Open the match page for the fixture.', cta: 'Match page' },
      listTitle: 'Also on the ILT20 hub',
      items: [
        { href: '/ilt20/schedule/', icon: 'calendar', b: 'Full ILT20 schedule', s: 'All 34 fixtures from 21 November to 20 December, including the playoffs from 16 December.' },
        { href: '/ilt20/points-table/', icon: 'table', b: 'ILT20 points table', s: 'Current standings for all six teams, with net run rate, as published on the points-table page.' },
        { href: '/ilt20/teams/', icon: 'users', b: 'ILT20 teams', s: 'All six squads, captains and coaches for Season 5.' }
      ]
    },
    apl: {
      title: 'Afghanistan Premier League',
      intro: 'The 2026-27 season starts on Sunday, 27 December 2026 in the UAE, with five teams playing 24 matches. The final is on Wednesday, 20 January 2027.',
      feature: { kicker: 'Season starts · 27 December', href: '/apl/', h: 'Afghanistan Premier League 2026-27 starts on 27 December', p: 'First ball on Sunday, 27 December 2026 at 5:30 PM AFT (5:00 PM Dubai time) in the UAE. Five teams, 24 matches, final on 20 January 2027.', cta: 'Open the hub' },
      listTitle: 'Also on the APL hub',
      items: [
        { href: '/apl/schedule/', icon: 'calendar', b: 'APL schedule', s: 'Fixtures have not been published by the ACB yet — first ball Sunday, 27 December 2026, 5:30 PM AFT, in the UAE.' },
        { href: '/apl/teams/', icon: 'users', b: 'APL teams', s: 'All five squads, captains and coaches for 2026-27.' },
        { href: '/apl/points-table/', icon: 'table', b: 'APL points table', s: 'Current standings for all five teams, with net run rate, as published on the points-table page.' }
      ]
    }
  };

  function parseDate(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function startOfToday() {
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }
  function isEnded(lg) {
    var end = parseDate(LEAGUE_END[lg]);
    var hide = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    return startOfToday() >= hide;
  }
  function activeLeague() {
    for (var i = 0; i < ORDER.length; i++) {
      if (!isEnded(ORDER[i])) return ORDER[i];
    }
    return null;
  }
  function renderSpot(lg) {
    var d = SPOT[lg];
    var out = '';
    for (var i = 0; i < d.items.length; i++) {
      var it = d.items[i];
      out += '<a class="st-spot__item" href="' + it.href + '">' +
        '<span class="st-spot__ico" aria-hidden="true">' + ICONS[it.icon] + '</span>' +
        '<span><b>' + it.b + '</b><span>' + it.s + '</span></span>' +
        '<span class="st-spot__go" aria-hidden="true">→</span></a>';
    }
    return '<div class="st-shell">' +
      '<header class="st-block__head st-block__head--left">' +
      '<h2 id="st-' + lg + '-title">' + d.title + '</h2><p>' + d.intro + '</p></header>' +
      '<div class="st-spot">' +
      '<a class="st-spot__feature" href="' + d.feature.href + '">' +
      '<span class="st-panel__kicker">' + d.feature.kicker + '</span>' +
      '<h3>' + d.feature.h + '</h3><p>' + d.feature.p + '</p>' +
      '<span class="st-action">' + d.feature.cta + ' <span aria-hidden="true">→</span></span></a>' +
      '<div class="st-spot__list"><h3>' + d.listTitle + '</h3>' + out + '</div>' +
      '</div></div>';
  }
  function run() {
    var cards = document.querySelectorAll('.st-league[data-league]');
    var visible = 0;
    for (var i = 0; i < cards.length; i++) {
      if (isEnded(cards[i].getAttribute('data-league'))) {
        cards[i].classList.add('is-ended');
      } else {
        visible++;
      }
    }
    if (!visible) {
      var leagues = document.getElementById('leagues');
      if (leagues) leagues.classList.add('is-ended');
    }
    var spot = document.getElementById('home-spotlight');
    if (!spot) return;
    var active = activeLeague();
    if (!active) {
      spot.classList.add('is-ended');
      return;
    }
    if (active === 'npl') return;
    spot.setAttribute('aria-labelledby', 'st-' + active + '-title');
    spot.innerHTML = renderSpot(active);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
