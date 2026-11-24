/* Mount the same match strip and feed on every page. */
(function () {
  'use strict';
  var mount = document.querySelector('[data-site-match-strip]');
  if (!mount) return;

  function load(src, ready) {
    if (ready && ready()) return Promise.resolve();
    var existing = Array.from(document.scripts).find(function (script) {
      return script.src === new URL(src, location.href).href;
    });
    return new Promise(function (resolve) {
      var script = existing || document.createElement('script');
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', resolve, { once: true });
      if (!existing) {
        script.src = src;
        document.body.appendChild(script);
      }
    });
  }

  fetch('/fragments/strip.html', { credentials: 'same-origin' })
    .then(function (response) {
      if (!response.ok) throw new Error('Match strip unavailable');
      return response.text();
    })
    .then(function (html) {
      return Promise.resolve(window.sialtvHomeLeaguesReady).then(function (leagues) {
        mount.innerHTML = html;
        if (!Array.isArray(leagues)) return;
        var strip = mount.querySelector('.st-strip');
        var view = strip.querySelector('.st-strip-view');
        var pills = strip.querySelector('.st-strip-pills');
        var keys = leagues.map(function (league) { return league.key; });
        strip.querySelectorAll('[data-strip-group], [data-strip-filter], .score-card[data-league]').forEach(function (node) {
          var key = node.dataset.stripGroup || node.dataset.stripFilter || node.dataset.league;
          if (key !== 'all' && !keys.includes(key)) node.remove();
        });
        leagues.forEach(function (league) {
          if (!league.feed || strip.querySelector('[data-strip-group="' + league.key + '"]')) return;
          var pill = document.createElement('button');
          pill.type = 'button';
          pill.className = 'st-strip-pill';
          pill.dataset.stripFilter = league.key;
          pill.setAttribute('aria-pressed', 'false');
          pill.textContent = league.code + ' (0)';
          pills.appendChild(pill);
          var track = document.createElement('div');
          track.className = 'st-strip-track slp-flash';
          track.dataset.stripGroup = league.key;
          track.dataset.league = league.key;
          track.hidden = true;
          view.appendChild(track);
        });
      });
    })
    .catch(function () {
      mount.innerHTML = '<div class="wrap"><a href="/live-scores/">Live cricket scores</a></div>';
    })
    .then(function () {
      return Promise.all([
        load('/js/team-logos.js', function () { return window.sialtvTeamLogos; }),
        load('/js/live-scores.js', function () { return window.sialtvScores; }),
        load('/js/local-time.js', function () { return window.sialtvLocalTime; })
      ]);
    })
    .then(function () {
      if (window.sialtvLocalTime) window.sialtvLocalTime();
      return load(window.sialtvHomeLeagues ? '/js/flash-scores.js?v=3' : '/js/flash-scores.js?v=2');
    });
})();
