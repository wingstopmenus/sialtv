/* Homepage features follow the season calendar shared with the navigation. */
(function () {
  'use strict';
  var cards = document.querySelector('[data-home-league-cards]');
  var coverage = document.querySelector('[data-home-coverage]');
  var next = document.querySelector('.st-panel--next');
  if (!cards || !coverage || !next) return;

  var calendar = [];
  var previous = '';
  var leagueHues = { ILT20: '#0e7490', BBL: '#a34116', APL: '#9b640e', SA20: '#276351' };
  var dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  function today(zone, now) {
    var parts = new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now);
    function part(name) { return parts.find(function (p) { return p.type === name; }).value; }
    return part('year') + '-' + part('month') + '-' + part('day');
  }

  function seasons(now) {
    return calendar.reduce(function (list, league) {
      var local = today(league.zone, now);
      if (local > league.final) return list;
      return list.concat(Object.assign({}, league, { active: !league.provisional && local >= league.start, key: league.code.toLowerCase() }));
    }, []).sort(function (a, b) {
      return Number(b.active) - Number(a.active) || a.start.localeCompare(b.start);
    });
  }

  function escape(text) { return String(text).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  }); }
  function dates(league) {
    var start = dateFormat.format(new Date(league.start));
    return league.provisional ? 'Planned start ' + start : start + ' – ' + dateFormat.format(new Date(league.final));
  }
  function seasonLabel(league) {
    if (league.provisional) return 'Fixtures pending';
    return league.active ? 'In season' : 'Upcoming';
  }

  function card(league) {
    return '<a class="st-league" href="' + escape(league.href) + '" style="--st-hue:' + (leagueHues[league.code] || '#276351') + '">' +
      '<div class="st-league__head"><h3>' + escape(league.name) + '</h3>' +
      '<p>' + escape(league.season + ' · ' + league.region) + '</p></div>' +
      '<p>' + escape(dates(league)) + '</p><span class="st-league__badge">' + seasonLabel(league) + '</span></a>';
  }

  function matchCoverage(league) {
    var link = escape(league.href);
    var links = [['schedule/', 'Fixtures'], ['points-table/', 'Points table'], ['teams/', 'Teams']];
    return '<div class="st-spot" data-home-coverage-league="' + escape(league.key) + '">' +
      '<a class="st-spot__feature" href="' + link + '">' +
      '<span class="st-panel__kicker">' + seasonLabel(league) + '</span><h3>' + escape(league.name) + '</h3>' +
      '<p>' + escape(dates(league) + (league.provisional ? ' · Full fixture list pending' : ' · ' + league.region)) + '</p>' +
      '<span class="st-action">Series hub <span aria-hidden="true">→</span></span></a>' +
      '<div class="st-spot__list"><h3>' + escape(league.code) + ' series links</h3>' +
      '<a class="st-spot__item" data-spot-next hidden href="' + link + 'schedule/"><span><b></b><span></span></span></a>' +
      links.map(function (item) { return '<a class="st-spot__item" href="' + link + item[0] +
        '"><span><b>' + item[1] + '</b></span><span class="st-spot__go" aria-hidden="true">→</span></a>'; }).join('') +
      '</div></div>';
  }

  function render() {
    var active = seasons(new Date());
    var key = active.map(function (league) { return league.code + ':' + league.active; }).join('|');
    if (key === previous) return active;
    previous = key;
    cards.innerHTML = active.length ? active.map(card).join('') : '<p><a href="/series/">Browse cricket series</a></p>';
    var featured = active.filter(function (league) { return league.active; });
    if (!featured.length && active.length) featured = [active[0]];
    coverage.innerHTML = featured.length ? featured.map(matchCoverage).join('') :
      '<p><a href="/live-scores/">See all live scores and fixtures</a></p>';
    var upcoming = active.find(function (league) { return !league.active; }) || active[0];
    next.hidden = !upcoming;
    if (upcoming) {
      next.href = upcoming.href;
      next.querySelector('span').textContent = upcoming.active ? seasonLabel(upcoming) : 'Next series';
      next.querySelector('strong').textContent = upcoming.name;
      next.querySelector('em').textContent = dates(upcoming);
    }
    return active;
  }

  window.sialtvHomeLeagues = render;
  window.sialtvHomeLeaguesReady = fetch('/data/nav-leagues.json?v=2', { cache: 'no-cache' })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (data) {
      calendar = (data && Array.isArray(data.leagues) ? data.leagues : []).filter(function (league) {
        return league.start && league.final && league.zone && /^\/[a-z0-9]+\/$/.test(league.href);
      });
      return render();
    }).catch(function () { return []; });
})();
