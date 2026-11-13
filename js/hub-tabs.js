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

/* Secnav league switcher: click toggles, Escape closes, click-outside
   closes. The dropdown is CSS-opened on :hover / :focus-within, so an
   explicit close also sets .secnav-closed (suppresses the CSS open) and
   blurs the button; mouseleave clears .secnav-closed so hover works
   again. Shared by all three hubs (same markup, same file). */
(function () {
  'use strict';
  function bind() {
    var wrap = document.querySelector('.secnav-title-wrap');
    var btn = document.querySelector('.secnav-switch');
    if (!wrap || !btn) return;
    btn.setAttribute('aria-expanded', 'false');
    function close() {
      wrap.classList.remove('secnav-open');
      wrap.classList.add('secnav-closed');
      btn.setAttribute('aria-expanded', 'false');
      if (wrap.contains(document.activeElement)) document.activeElement.blur();
    }
    function open() {
      wrap.classList.add('secnav-open');
      wrap.classList.remove('secnav-closed');
      btn.setAttribute('aria-expanded', 'true');
    }
    btn.addEventListener('click', function () {
      if (wrap.classList.contains('secnav-open')) close();
      else open();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (wrap.classList.contains('secnav-open') || wrap.contains(document.activeElement)) close();
    });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target) && wrap.classList.contains('secnav-open')) close();
    });
    wrap.addEventListener('mouseleave', function () { wrap.classList.remove('secnav-closed'); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
