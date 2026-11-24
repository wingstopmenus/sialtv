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
    .then(function (html) { mount.innerHTML = html; })
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
      return load('/js/flash-scores.js?v=2');
    });
})();
