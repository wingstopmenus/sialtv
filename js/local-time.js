/* sialtvLocalTime — visitor-local match times.
   Builders bake the official time as text and put the machine time in
   data-local-time (ISO 8601 with offset). This module rewrites the
   visible text to the visitor's own local time (Intl without timeZone —
   the device zone). JS off, attribute missing, or an unparsable ISO:
   the baked official text stays, never blank. No dependencies.
   Defensive fallback: a strip card with no [data-local-time] span is
   localised from its sibling .sc-countdown[data-kickoff] instead. */
(function () {
  'use strict';
  var FULL = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true };
  var TIME = { hour: 'numeric', minute: '2-digit', hour12: true };
  var DAY = { weekday: 'short' };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localDateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  /* en-GB renders a lowercase am/pm in this ICU ("7:30 pm"); the site
     convention (and the PLAN) is uppercase "7:30 PM". */
  function upper(s) { return s.replace(/\b(am|pm)$/i, function (m) { return m.toUpperCase(); }); }

  function formatOne(el) {
    if (el.getAttribute('data-local-done')) return; /* idempotent */
    var iso = el.getAttribute('data-local-time');
    if (!iso) return;
    var ms = Date.parse(iso);
    if (isNaN(ms)) return;
    var baked = el.textContent;
    if (!baked || !baked.trim()) return;
    var d = new Date(ms);
    var text;
    try {
      if (el.getAttribute('data-local-format') === 'time') {
        var t = upper(new Intl.DateTimeFormat('en-GB', TIME).format(d));
        /* Official date = the date written in the ISO itself. If the
           visitor-local date differs (rollover), prefix the weekday. */
        text = (localDateStr(d) === String(iso).slice(0, 10)) ? t
          : upper(new Intl.DateTimeFormat('en-GB', DAY).format(d)) + ', ' + t;
      } else {
        text = upper(new Intl.DateTimeFormat('en-GB', FULL).format(d));
      }
    } catch (e) { return; } /* leave the baked text on any Intl failure */
    if (!el.getAttribute('title')) el.setAttribute('title', 'Official time: ' + baked.trim());
    el.textContent = text;
    el.setAttribute('data-local-done', '1');
  }

  function run() {
    var els = document.querySelectorAll('[data-local-time]');
    for (var i = 0; i < els.length; i++) formatOne(els[i]);
    fallbackStrip();
  }

  /* Defensive fallback for strip cards whose builder did not emit a
     [data-local-time] span: the sibling .sc-countdown[data-kickoff] in
     the same card carries the same ISO. Only the date+time portion
     (before " · venue") is rewritten; the venue suffix stays. */
  function fallbackStrip() {
    var cds = document.querySelectorAll('.score-card [data-kickoff]');
    for (var i = 0; i < cds.length; i++) {
      var card = cds[i].closest('.score-card');
      if (!card) continue;
      var res = card.querySelector('.sc-result');
      if (!res || res.querySelector('[data-local-time]') || res.getAttribute('data-local-done')) continue;
      var iso = cds[i].getAttribute('data-kickoff');
      if (!iso) continue;
      var ms = Date.parse(iso);
      if (isNaN(ms)) continue;
      var baked = res.textContent;
      if (!baked || !baked.trim()) continue;
      var text;
      try { text = upper(new Intl.DateTimeFormat('en-GB', FULL).format(new Date(ms))); }
      catch (e) { continue; }
      if (!res.getAttribute('title')) res.setAttribute('title', 'Official time: ' + baked.trim());
      var cut = baked.indexOf(' · ');
      res.textContent = (cut === -1) ? text : text + baked.slice(cut);
      res.setAttribute('data-local-done', '1');
    }
  }

  window.sialtvLocalTime = run; /* pollers re-run after re-rendering */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
