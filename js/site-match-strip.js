/* Mount the same match strip and feed on every page. */
(function () {
  'use strict';
  var mount = document.querySelector('[data-site-match-strip]');
  if (!mount || mount.dataset.stripMounted) return;
  mount.dataset.stripMounted = 'true';
  mount.setAttribute('data-strip-loading', '');

  function load(src, ready) {
    if (ready && ready()) return Promise.resolve();
    var existing = Array.from(document.scripts).find(function (script) {
      return script.src === new URL(src, location.href).href;
    });
    return new Promise(function (resolve, reject) {
      var script = existing || document.createElement('script');
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', reject, { once: true });
      if (!existing) {
        script.src = src;
        document.body.appendChild(script);
      }
    });
  }

  var options = { credentials: 'same-origin' };
  var calendar = window.sialtvHomeLeaguesReady || fetch('/data/nav-leagues.json?v=2', options)
    .then(function (response) { if (!response.ok) throw new Error('Calendar unavailable'); return response.json(); })
    .then(function (data) {
      return data.leagues.flatMap(function (league) {
        var today = new Intl.DateTimeFormat('sv-SE', { timeZone: league.zone }).format(new Date());
        return today > league.final ? [] : [Object.assign({}, league, {
          key: league.code.toLowerCase(), active: !league.provisional && today >= league.start
        })];
      });
    });

  var shell = fetch('/fragments/strip.html?v=7', options)
    .then(function (response) { if (!response.ok) throw new Error('Match strip unavailable'); return response.text(); });
  var feed = load('/js/live-scores.js', function () { return window.sialtvScores; });
  load('/js/team-logos.js', function () { return window.sialtvTeamLogos; }).catch(function () {});
  load('/js/local-time.js', function () { return window.sialtvLocalTime; }).catch(function () {});

  var snapshotOptions = {};
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) snapshotOptions.signal = AbortSignal.timeout(2500);
  window.sialtvStripSnapshot = fetch('/api/match-strip.php', snapshotOptions)
    .then(function (response) { return response.ok ? response.json() : null; })
    .catch(function () { return null; });

  Promise.all([shell, calendar, feed]).then(function (ready) {
    mount.innerHTML = ready[0];
    var strip = mount.querySelector('.st-strip');
    var view = strip.querySelector('.st-strip-view');
    var pills = strip.querySelector('[data-strip-filter="all"]').parentElement;
    var leagues = ready[1];
    if (!leagues.some(function (league) { return league.key === 'apl'; })) view.querySelector('[data-strip-group="apl"]')?.remove();
    leagues.forEach(function (league) {
      var track = view.querySelector('[data-strip-group="' + league.key + '"]');
      if (!league.feed && !track) return;
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'st-strip-pill';
      pill.dataset.stripFilter = league.key;
      pill.setAttribute('aria-pressed', 'false');
      pill.textContent = league.code + (league.feed ? ' (0)' : '');
      pills.appendChild(pill);
      if (track) return;
      track = document.createElement('div');
      track.className = 'st-strip-track slp-flash';
      track.dataset.stripGroup = league.key;
      track.dataset.league = league.key;
      track.dataset.inSeason = String(league.active);
      track.hidden = true;
      view.insertBefore(track, view.querySelector('[data-strip-prev]'));
      if (!document.hidden) window.sialtvScores(league.key);
    });
    return load('/js/flash-scores.js?v=7');
  }).catch(function () {
    mount.removeAttribute('data-strip-loading');
    mount.innerHTML = '<div class="wrap"><a href="/live-scores/">Live cricket scores</a></div>';
  });
})();
