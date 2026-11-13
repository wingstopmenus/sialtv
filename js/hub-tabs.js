/* NPL hub Fixtures / Results segmented tabs — standalone binding.
   Lives in its own file (not flash-scores.js) so the tabs keep working
   even when the CDN edge serves a stale flash-scores.js without
   initFxSeg (21:33 PKT browser verdict: clicking Results never opened
   the tab). Idempotent with flash-scores.js initFxSeg: both handlers
   set the same aria-pressed + hidden state, so a double bind is
   harmless. No ?v=, no dependencies. */
(function () {
  'use strict';
  function bind() {
    var btns = document.querySelectorAll('.fx-seg-btn[data-fx]');
    if (!btns.length) return;
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var which = btn.getAttribute('data-fx');
        btns.forEach(function (b) { b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
        var fx = document.getElementById('fxFixtures');
        var res = document.getElementById('fxResults');
        if (fx) fx.hidden = which !== 'fixtures';
        if (res) res.hidden = which !== 'results';
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
