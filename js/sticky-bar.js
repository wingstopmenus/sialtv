/* SialTV sticky bar — one line fixed to the bottom of the page.
   Toss text only when the feed actually carries it, the live score
   while a match is on, the latest result and the next match otherwise.
   Nothing is invented: with no feed data the bar stays hidden. The
   visitor can close it; the choice lasts for the session. */
(function () {
  'use strict';
  var POLL_MS = 30 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function ensureBar() {
    var bar = document.getElementById('sialtv-sticky-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'sialtv-sticky-bar';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:90;background:#0f1014;color:#fff;border-top:3px solid #c92a1e;padding:10px 16px;text-align:center;font-size:14px;line-height:1.4;box-shadow:0 -4px 18px rgba(0,0,0,.3)';
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close live score bar');
    close.textContent = '×';
    close.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;color:#fff;font-size:20px;cursor:pointer;padding:4px 8px';
    close.addEventListener('click', function () {
      try { sessionStorage.setItem('sialtv-sticky-closed', '1'); } catch (e) {}
      bar.hidden = true;
    });
    bar.appendChild(close);
    var span = document.createElement('span');
    span.id = 'sialtv-sticky-text';
    bar.insertBefore(span, close);
    document.body.appendChild(bar);
    return bar;
  }

  function textFor(data, league) {
    var p = window.sialtvPick((data && data.matches) || []);
    var link = ' · <a href="/' + league + '/live-scores/" style="color:#fff;font-weight:700">Live scores</a>';
    if (p.live) {
      var m = p.live;
      var line = 'LIVE: ' + m.team1 + ' ' + (m.score1 || '') + ' (' + (m.overs1 || '') + ' ov)';
      if (m.score2) line += ' vs ' + m.team2 + ' ' + m.score2 + ' (' + (m.overs2 || '') + ' ov)';
      if (m.live && m.live.crr) line += ' · CRR ' + m.live.crr;
      if (m.toss) line += ' · ' + m.toss;
      return line + link;
    }
    if (p.latest) {
      var out = 'Latest: ' + p.latest.statusText;
      if (p.next) out += ' · Next: ' + p.next.team1 + ' vs ' + p.next.team2 + ', Match ' + p.next.matchNo;
      return out + link;
    }
    if (p.next) return 'Next: ' + p.next.team1 + ' vs ' + p.next.team2 + ' · Match ' + p.next.matchNo + link;
    return '';
  }

  function boot() {
    if (!window.sialtvScores) return;
    try { if (sessionStorage.getItem('sialtv-sticky-closed') === '1') return; } catch (e) {}
    var league = document.body.getAttribute('data-sticky-league') || 'npl';
    function load() {
      if (document.hidden) return;
      window.sialtvScores(league).then(function (data) {
        if (!data || !data.matches || !data.matches.length) return;
        var text = textFor(data, league);
        if (!text) return;
        var bar = ensureBar();
        var span = document.getElementById('sialtv-sticky-text');
        if (span) {
          /* Text and link are built as separate DOM nodes — the feed
             text never goes through innerHTML. */
          span.textContent = '';
          var t = text.split(' · <a href=')[0];
          span.appendChild(document.createTextNode(t + ' · '));
          var a = document.createElement('a');
          a.href = '/' + league + '/live-scores/';
          a.textContent = 'Live scores';
          a.style.color = '#fff';
          a.style.fontWeight = '700';
          span.appendChild(a);
        }
        bar.hidden = false;
      }).catch(function () {});
    }
    load();
    setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
