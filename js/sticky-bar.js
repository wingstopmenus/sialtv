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

  /* The feed carries team names with a league suffix ("Biratnagar
     Kings (NPL)") — the bar shows the plain name. CRR is computed
     from the score when the feed leaves crr empty (it usually does). */
  function shortName(name) {
    return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  }
  function cleanStatus(s) {
    return String(s || '').replace(/\s*\([A-Z0-9]+\)/g, '');
  }
  function crrOf(m) {
    var live = m.live || null;
    if (live && live.crr) return live.crr;
    /* The batting side is the one with an open innings: the side with
       a score while the other has none (first innings — M24: team1
       fielded, team2 batting), else the side batting second while the
       first innings is complete. score1 alone is wrong when team1
       fields: it returns '' and the CRR goes missing. */
    var s = '', o = '';
    if (m.score2 && !m.score1) { s = m.score2; o = m.overs2; }
    else if (m.score1 && !m.score2) { s = m.score1; o = m.overs1; }
    else if (m.score1 && m.score2) {
      var w2 = /^(\d+)\/(\d+)/.exec(String(m.score2));
      if (w2 && parseInt(w2[2], 10) >= 10) { s = m.score1; o = m.overs1; }
      else { s = m.score2; o = m.overs2; }
    }
    if (!s || !o) return '';
    var runs = parseInt(String(s).split('/')[0], 10);
    var parts = String(o).split('.');
    var ov = parseInt(parts[0] || '0', 10) + (parseInt(parts[1] || '0', 10) / 6);
    if (!runs || !ov) return '';
    return (runs / ov).toFixed(2);
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

  /* A side with no score yet (won the toss and fielded) reads
     "yet to bat" — never a dangling "( ov)" with nothing in it. */
  function sideLine(name, score, overs) {
    var s = shortName(name);
    if (!score) return s + ' yet to bat';
    return s + ' ' + score + (overs ? ' (' + overs + ' ov)' : '');
  }

  /* showNext: pages with data-show-next="0" on <body> (NPL hub + live-scores)
     hide the Next line; everywhere else the bar is unchanged. Same guard
     pattern as live-strip.js. */
  function textFor(data, league, showNext) {
    var p = window.sialtvPick((data && data.matches) || []);
    var link = ' · <a href="/' + league + '/live-scores/" style="color:#fff;font-weight:700">Live scores</a>';
    if (p.live) {
      var m = p.live;
      var line = 'LIVE: ' + sideLine(m.team1, m.score1, m.overs1);
      if (m.score2) line += ' vs ' + sideLine(m.team2, m.score2, m.overs2);
      var crr = crrOf(m);
      if (crr) line += ' · CRR ' + crr;
      if (m.toss) line += ' · ' + m.toss;
      return line + link;
    }
    if (p.latest) {
      var out = 'Latest: ' + cleanStatus(p.latest.statusText);
      if (p.next && showNext) out += ' · Next: ' + shortName(p.next.team1) + ' vs ' + shortName(p.next.team2) + ', Match ' + p.next.matchNo;
      return out + link;
    }
    if (p.next) {
      if (!showNext) return '';
      return 'Next: ' + shortName(p.next.team1) + ' vs ' + shortName(p.next.team2) + ' · Match ' + p.next.matchNo + link;
    }
    return '';
  }

  function boot() {
    if (!window.sialtvScores) return;
    try { if (sessionStorage.getItem('sialtv-sticky-closed') === '1') return; } catch (e) {}
    var league = document.body.getAttribute('data-sticky-league') || 'npl';
    var showNext = document.body.getAttribute('data-show-next') !== '0';
    function load() {
      if (document.hidden) return;
      window.sialtvScores(league).then(function (data) {
        if (!data || !data.matches || !data.matches.length) return;
        var text = textFor(data, league, showNext);
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

