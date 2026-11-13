/* SialTV flash strip — a row of match cards (live, latest result,
   next fixture) driven by the one shared feed. On the live-scores page
   it fills #sialtvFlash; on the homepage and the NPL hub it refreshes
   the baked carousel cards that carry a data-match-no. Baked cards are
   left alone when the feed has nothing newer for them — except the two
   cases the carousel could never show: an upcoming card has no score
   spans, so the first live score creates them, and the filter pills
   carry baked counts, so a flip re-counts them.
   v6 (2026-11-12, homepage clean rebuild): also updates the homepage's
   Match Coverage panels (data-mc-panel — kicker status word + live
   stand line) and hides live/result rows from the sidebar "Coming up";
   computes CRR from the score when the feed leaves crr empty.
   v7 (2026-11-13): carousel Match strip (.st-strip) — league pills,
   right-arrow scroll and kickoff countdowns on upcoming cards.
   v8 (2026-11-13): "All Matches" tab first (merged across leagues),
   previous arrow, 3-day post-final league expiry, compact cards. */
(function () {
  'use strict';
  var POLL_MS = 30 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function chip(name) {
    var img = window.sialtvTeamLogos && window.sialtvTeamLogos[String(name || '').trim()];
    if (img) return img;
    var bits = String(name || '').trim().split(/\s+/);
    var ini = bits.map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
    return '<span class="sc-chip">' + esc(ini) + '</span>';
  }

  /* Match pages exist for npl, ilt20, sa20 and bbl only; apl and psl
     fall back to the results list until their match pages exist. */
  var MATCH_SEASON = { npl: '2026', ilt20: '2026-27', sa20: '2026-27', bbl: '2026-27' };
  function matchUrl(league, matchNo) {
    var season = MATCH_SEASON[league];
    return season ? '/' + league + '/matches/' + season + '/match-' + matchNo + '/' : '/' + league + '/results/';
  }

  function scoreText(score, overs) {
    if (!score) return '';
    return score + (overs ? ' (' + overs + ' ov)' : '');
  }

  /* Run rate from the score when the feed leaves crr empty (it usually
     does — the normaliser does not carry it). Overs are cricket
     notation: "15.2" is 15 overs + 2 balls. */
  function crrOf(m) {
    var live = m.live || null;
    if (live && live.crr) return live.crr;
    /* The batting side is the one with an open innings: the side with
       a score while the other has none (first innings — M24: team1
       fielded, team2 batting), else the side whose innings is still
       open. An innings ends at 10 wickets or when its overs run out,
       so with both scores present the batting side is the one with
       fewer overs — the 10-wicket-only check missed the chase after
       a completed 20-over innings (M24: SPR 125/6 in 20 ov, KAG
       chasing 12/2 in 1.3 ov — CRR 8.00, not SPR's 6.25). */
    function wkts(s) { var x = /^(\d+)\/(\d+)/.exec(String(s || '')); return x ? parseInt(x[2], 10) : -1; }
    function balls(o) { var p = String(o || '').split('.'); return (parseInt(p[0] || '0', 10) * 6) + (parseInt(p[1] || '0', 10) || 0); }
    var s = '', o = '';
    if (m.score2 && !m.score1) { s = m.score2; o = m.overs2; }
    else if (m.score1 && !m.score2) { s = m.score1; o = m.overs1; }
    else if (m.score1 && m.score2) {
      if (wkts(m.score2) >= 10) { s = m.score1; o = m.overs1; }
      else if (wkts(m.score1) >= 10) { s = m.score2; o = m.overs2; }
      else if (balls(m.overs1) > balls(m.overs2)) { s = m.score2; o = m.overs2; }
      else { s = m.score1; o = m.overs1; }
    }
    if (!s || !o) return '';
    var runs = parseInt(String(s).split('/')[0], 10);
    var parts = String(o).split('.');
    var ov = parseInt(parts[0] || '0', 10) + (parseInt(parts[1] || '0', 10) / 6);
    if (!runs || !ov) return '';
    return (runs / ov).toFixed(2);
  }

  function shortName(name) {
    return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  /* The feed's statusText carries the league suffix on every team
     ("Biratnagar Kings (NPL) need 27 runs...") — the card shows the
     plain name. */
  function cleanStatus(s) {
    return String(s || '').replace(/\s*\([A-Z0-9]+\)/g, '');
  }

  /* Live details for the short line under the scores: batters at the
     crease and the run rate, Cricinfo-strip style. */
  function liveDetails(m) {
    var live = m.live || null;
    if (!live) return '';
    var bits = [];
    var bats = (live.batters || []).map(function (b) {
      return b.name + ' ' + b.runs + (b.striker ? '*' : '');
    }).join(', ');
    if (bats) bits.push(bats);
    var crr = crrOf(m);
    if (crr) bits.push('CRR ' + crr);
    return bits.join(' · ');
  }

  function liveLine(m) {
    var parts = [];
    var st = cleanStatus(m.statusText);
    if (st && st !== 'Live' && st !== 'Upcoming') parts.push(st);
    var d = liveDetails(m);
    if (d) parts.push(d);
    return parts.length ? parts.join(' · ') : 'Live now';
  }

  /* The loser row is dimmed. The winner comes from the result line
     ("<team> won by ..."), never from comparing runs — a D/L winner
     can have fewer runs than the first innings. No winner named
     (tie / no result) means no loser row. */
  function setLoser(card, m) {
    var rows = card.querySelectorAll('.sc-row');
    if (!rows.length) return;
    if (m.status !== 'result') {
      if (m.status === 'live') rows.forEach(function (r) { r.classList.remove('loser'); });
      return;
    }
    var w = -1;
    var st = cleanStatus(m.statusText);
    if (st.indexOf(shortName(m.team1) + ' won') === 0) w = 0;
    else if (st.indexOf(shortName(m.team2) + ' won') === 0) w = 1;
    rows.forEach(function (row, i) { row.classList.toggle('loser', w >= 0 && i !== w); });
  }

  /* The filter pills carry baked counts ("Results (5)"). Re-count from
     the cards' data-kind after a flip, so a finished match moves the
     counts with it. */
  function recountPills(carousel) {
    var pills = document.querySelectorAll('.pill[data-filter]');
    if (!pills.length) return;
    var n = { all: 0, upcoming: 0, result: 0 };
    carousel.querySelectorAll('.score-card[data-match-no]').forEach(function (c) {
      n.all++;
      if (c.getAttribute('data-kind') === 'result') n.result++;
      else n.upcoming++;
    });
    pills.forEach(function (p) {
      var f = p.getAttribute('data-filter');
      if (n[f] == null) return;
      p.textContent = p.textContent.replace(/\(\d+\)\s*$/, '(' + n[f] + ')');
    });
  }

  /* Venue city shown on a card built from scratch (the strip starts
     empty). Baked cards carry their own venue line. */
  var VENUE = { npl: 'Kirtipur', ilt20: 'Dubai', apl: 'UAE', sa20: 'South Africa', bbl: 'Australia' };

  function cardHtml(m, league) {
    var kind = m.status === 'live' ? 'live' : (m.status === 'result' ? 'result' : 'upcoming');
    var label = m.status === 'live' ? 'Live' : (m.status === 'result' ? 'Result' : 'Upcoming');
    var html = '<a class="score-card" data-kind="' + kind + '" data-match-no="' + m.matchNo + '" data-league="' + esc(league) + '" href="' + matchUrl(league, m.matchNo) + '">';
    html += '<div class="sc-top"><p class="sc-label' + (kind === 'upcoming' ? ' upcoming' : kind === 'live' ? ' live' : '') + '">' + label + '</p>';
    html += '<p class="sc-match">Match ' + m.matchNo + ' &middot; ' + esc(league.toUpperCase()) + ' &middot; ' + esc(VENUE[league] || 'Kirtipur') + '</p></div>';
    html += '<p class="sc-row"><span class="sc-team">' + chip(m.team1) + esc(m.team1) + '</span><span class="sc-score">' + esc(m.score1 || '') + (m.overs1 ? ' (' + esc(m.overs1) + ' ov)' : '') + '</span></p>';
    html += '<p class="sc-row"><span class="sc-team">' + chip(m.team2) + esc(m.team2) + '</span><span class="sc-score">' + esc(m.score2 || '') + (m.overs2 ? ' (' + esc(m.overs2) + ' ov)' : '') + '</span></p>';
    html += '<p class="sc-result' + (kind === 'upcoming' ? ' upcoming' : '') + '">' + esc(m.status === 'live' ? liveLine(m) : (m.statusText || '')) + '</p></a>';
    return html;
  }

  function refreshFlash(root, data, league) {
    /* Baked cards stay: update the ones the feed knows about in place
       (same updater as the carousel) and never drop the older baked
       cards the feed does not carry. Only build from scratch when the
       strip starts empty. */
    if (root.querySelectorAll('.score-card[data-match-no]').length) {
      refreshCarousel(root, data);
      return;
    }
    var p = window.sialtvPick((data && data.matches) || []);
    var cards = [];
    if (p.live) cards.push(p.live);
    if (p.latest && (!p.live || p.latest.matchNo !== p.live.matchNo)) cards.push(p.latest);
    if (p.next) cards.push(p.next);
    if (cards.length) root.innerHTML = cards.map(function (m) { return cardHtml(m, league); }).join('');
  }


  /* Layout fix 6 (2026-11-13): keep the strip ordered LIVE -> UPCOMING ->
     RESULTS after a feed update. A status flip (upcoming -> live, or live ->
     result) changes a card's label; without a re-sort the flipped card would
     stay in the wrong section. Stable sort: within a kind the baked order
     (upcoming soonest-first, results newest-first) is preserved. Only moves
     nodes when the order actually changed; scrollLeft resets to 0 only then. */
  function kindRank(card) {
    var lab = card.querySelector('.sc-label');
    var t = (lab ? (lab.textContent || '') : '').trim().toLowerCase();
    if (lab && (lab.classList.contains('live') || t.indexOf('live') === 0)) return 0;
    if (lab && (lab.classList.contains('upcoming') || t.indexOf('upcoming') === 0)) return 1;
    if (card.getAttribute('data-kind') === 'live') return 0;
    if (card.getAttribute('data-kind') === 'upcoming') return 1;
    return 2;
  }
  /* NPL evening matches start 5:00 PM NST (CAN revision, 20 Oct 2026) —
     the baked strip cards (and ESPN) still carry the old 4:30 PM NST,
     and the feed carries no kickoff time for upcoming matches, so the
     strip corrects the baked line + countdown on load. The baked HTML
     itself is the times batch's to fix. */
  function fixEveningTime(card) {
    var result = card.querySelector('.sc-result');
    if (!result || result.textContent.indexOf('4:30 PM NST') === -1) return;
    result.textContent = result.textContent.replace('4:30 PM NST', '5:00 PM NST');
    var cd = card.querySelector('.sc-countdown[data-kickoff]');
    if (cd) {
      var k = cd.getAttribute('data-kickoff') || '';
      if (k.indexOf('T10:45:00Z') !== -1) cd.setAttribute('data-kickoff', k.replace('T10:45:00Z', 'T11:15:00Z'));
    }
  }

  function reorderStripTracks(container) {
    var strip = container && container.closest ? container.closest('.st-strip') : null;
    var tracks = [];
    if (strip) {
      tracks = Array.prototype.slice.call(strip.querySelectorAll('.st-strip-track'));
    } else if (container && container.classList && container.classList.contains('st-strip-track')) {
      tracks = [container];
    }
    var moved = [];
    tracks.forEach(function (track) {
      var cards = Array.prototype.slice.call(track.querySelectorAll('.score-card'));
      if (cards.length < 2) return;
      var ranked = cards.map(function (c, i) { return { c: c, r: kindRank(c), i: i }; });
      var sorted = ranked.slice().sort(function (a, b) {
        return (a.r - b.r) || (a.i - b.i);
      });
      var changed = sorted.some(function (s, k) { return s.c !== cards[k]; });
      if (!changed) return;
      sorted.forEach(function (s) { track.appendChild(s.c); });
      moved.push(track);
    });
    /* Reset the TRACK's scroll (the track is the scrollable element, not the
       .st-strip-view wrapper) so the new first card (the live match) is
       visible. Instant, not smooth, so the snap does not land mid-card. */
    moved.forEach(function (track) {
      if (track.scrollTo) track.scrollTo({ left: 0, behavior: 'instant' });
      else track.scrollLeft = 0;
    });
    return moved.length > 0;
  }


  /* Hero match (2026-11-13): the homepage hero panel (#heroMatch) shows the
     LIVE match if one is live, else the NEXT upcoming match — NEVER a result.
     It reads the NPL feed (full team names + live scores) and takes the
     venue/time + kickoff from that match's strip card. Runs on every feed
     poll, so the hero switches automatically when a match starts/finishes
     (no cron, no hand update). If the feed has no live/upcoming match the
     baked panel is left alone. */
  function heroShortName(name) {
    return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  }
  function heroEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  /* Homepage hero + NPL spotlight auto-update (2026-11-13): the endpoint
     only carries matches ESPN's scoreboard still lists (currently M24+M25
     results) — it has NO upcoming fixtures, so refreshHero used to leave
     the baked panel alone and the hero went stale. The next matches now
     come from data/npl-schedule.json (verified fixtures); the endpoint
     supplies the live/result state. The hero is a slider on two-match
     days: both of today's matches show, and when one finishes the other
     takes over automatically. Never a result in the hero. */
  var nplSchedulePromise = null;
  function loadNplSchedule() {
    if (nplSchedulePromise) return nplSchedulePromise;
    nplSchedulePromise = fetch('/data/npl-schedule.json', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('schedule ' + r.status); return r.json(); })
      .then(function (j) { return (j && j.fixtures) || []; })
      .catch(function (e) { if (window.console && console.warn) console.warn('[flash-scores] npl schedule failed:', e); return null; });
    return nplSchedulePromise;
  }
  /* NST calendar date (UTC+5:45) for an instant — fixtures are in NST. */
  function nstDateStr(d) {
    return new Date(d.getTime() + (5 * 60 + 45) * 60000).toISOString().slice(0, 10);
  }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MONTHS_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DAYS_S = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  /* NST parts for an ISO kickoff: weekday, day, month, "5:00 PM". */
  function nstParts(iso) {
    var d = new Date(Date.parse(iso) + (5 * 60 + 45) * 60000);
    var hh = d.getUTCHours(), mm = d.getUTCMinutes();
    var h12 = hh % 12; if (h12 === 0) h12 = 12;
    return { mo: d.getUTCMonth(), day: d.getUTCDate(), wd: d.getUTCDay(), time: h12 + ':' + (mm < 10 ? '0' : '') + mm + ' ' + (hh >= 12 ? 'PM' : 'AM') };
  }
  function fmtDateLong(isoDate) {
    var p = String(isoDate || '').split('-');
    return (+p[2]) + ' ' + MONTHS[+p[1] - 1];
  }
  function fmtVenueLine(f) {
    var p = nstParts(f.kickoff);
    return DAYS_S[p.wd] + ' ' + p.day + ' ' + MONTHS_S[p.mo] + ', ' + p.time + ' NST · ' + (f.venue || 'Kirtipur');
  }
  function shortTeam(name) {
    var n = heroShortName(name).split(' ');
    return n[n.length - 1];
  }
  /* Merged NPL state: live/latest result from the endpoint, upcoming
     from the schedule (the endpoint never carries future fixtures). */
  function nplState(data, fixtures, now) {
    var matches = (data && data.matches) || [];
    var live = null, latestResult = null;
    matches.forEach(function (m) {
      if (m.status === 'live' && !live) live = m;
      if (m.status === 'result' && (!latestResult || (m.matchNo || 0) > (latestResult.matchNo || 0))) latestResult = m;
    });
    var t = (now || new Date()).getTime();
    var today = nstDateStr(now || new Date());
    /* A fixture the endpoint already reports as live/result is not
       upcoming any more — even if its kickoff is still in the future
       on the clock (early finish, clock skew). Without this, a finished
       match would keep showing as "Next match" from the schedule. */
    var done = {};
    matches.forEach(function (m) { if (m.status === 'live' || m.status === 'result') done[m.matchNo] = true; });
    var upcoming = (fixtures || []).filter(function (f) {
      return f.kickoff && Date.parse(f.kickoff) > t && !done[f.matchNo];
    }).sort(function (a, b) { return Date.parse(a.kickoff) - Date.parse(b.kickoff); });
    return { live: live, latestResult: latestResult, todayUpcoming: upcoming.filter(function (f) { return f.date === today; }), next: upcoming[0] || null };
  }
  function heroSlideInner(o) {
    var html = '<span class="st-panel__kicker">' + o.kicker + '</span>';
    html += '<strong>' + heroEsc(o.strong) + '</strong>';
    html += '<p>' + heroEsc(o.sub) + '</p>';
    html += '<div class="st-panel__scores">' + o.scores + '</div>';
    if (o.kickoff) html += '<p class="st-panel__countdown" data-kickoff="' + heroEsc(o.kickoff) + '">Match starts in \u2026</p>';
    html += '<span class="st-panel__link">' + heroEsc(o.cta) + ' <span aria-hidden="true">\u2192</span></span>';
    return html;
  }
  function liveSlide(m) {
    var t1 = heroShortName(m.team1), t2 = heroShortName(m.team2);
    var parts = [];
    if (m.score1) parts.push(m.score1 + (m.overs1 ? ' (' + m.overs1 + ' ov)' : ''));
    if (m.score2) parts.push(m.score2 + (m.overs2 ? ' (' + m.overs2 + ' ov)' : ''));
    return {
      key: 'live-' + m.matchNo,
      href: '/npl/matches/2026/match-' + m.matchNo + '/',
      kicker: '<span class="live-dot" aria-hidden="true"></span>Live now',
      strong: t1 + ' vs ' + t2,
      sub: parts.join(' \u00b7 ') || (m.statusText || ''),
      scores: '<span><small>' + heroEsc(t1) + '</small><b>' + heroEsc(m.score1 || 'Yet to bat') + '</b></span>' +
        '<span><small>' + heroEsc(t2) + '</small><b>' + heroEsc(m.score2 || 'Yet to bat') + '</b></span>',
      kickoff: '',
      cta: 'Live scorecard'
    };
  }
  function nextSlide(fx) {
    if (!fx.team1) {
      return {
        key: 'next-' + fx.matchNo,
        href: fx.href || '/npl/',
        kicker: 'Next match',
        strong: fx.label || fx.desc || ('Match ' + fx.matchNo),
        sub: fmtVenueLine(fx),
        scores: '<span><small>Teams to be decided</small><b>' + heroEsc(fx.note || '') + '</b></span>',
        kickoff: fx.kickoff,
        cta: 'Open the NPL hub'
      };
    }
    return {
      key: 'next-' + fx.matchNo,
      href: fx.href,
      kicker: 'Next match',
      strong: fx.team1 + ' vs ' + fx.team2,
      sub: fmtVenueLine(fx),
      scores: '<span><small>' + heroEsc(fx.team1) + '</small><b>' + heroEsc(fx.abbr1 || '') + '</b></span>' +
        '<span><small>' + heroEsc(fx.team2) + '</small><b>' + heroEsc(fx.abbr2 || '') + '</b></span>',
      kickoff: fx.kickoff,
      cta: 'Match preview'
    };
  }
  /* Shown only once the schedule is exhausted (after the 21 Nov final) —
     a neutral pointer, never a result and never a frozen live score. */
  var SEASON_DONE = {
    key: 'season-complete',
    href: '/npl/',
    kicker: 'NPL Season 3',
    strong: 'Season complete',
    sub: 'The league stage and playoffs are over. See the full results and the final table on the NPL hub.',
    scores: '<span><small>Season 3</small><b>26 Oct – 21 Nov 2026</b></span>',
    kickoff: '',
    cta: 'Open the NPL hub'
  };
  var heroSlider = { keys: [], index: 0, timer: null, lastHtml: '' };
  function heroSlidesFor(st) {
    var slides = [];
    if (st.live) slides.push(liveSlide(st.live));
    st.todayUpcoming.forEach(function (fx) {
      if (st.live && fx.matchNo === st.live.matchNo) return;
      slides.push(nextSlide(fx));
    });
    if (!slides.length && st.next) slides.push(nextSlide(st.next));
    return slides;
  }
  function applyHeroSlide() {
    var track = document.getElementById('heroTrack');
    if (!track) return;
    track.style.transform = heroSlider.index ? 'translateX(-' + (heroSlider.index * 100) + '%)' : '';
  }
  function heroGo(i) {
    var n = heroSlider.keys.length;
    if (n < 2) return;
    heroSlider.index = (i + n) % n;
    applyHeroSlide();
    startHeroAuto();
  }
  function startHeroAuto() {
    stopHeroAuto();
    if (heroSlider.keys.length < 2) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    heroSlider.timer = setInterval(function () { heroGo(heroSlider.index + 1); }, 6000);
  }
  function stopHeroAuto() {
    if (heroSlider.timer) { clearInterval(heroSlider.timer); heroSlider.timer = null; }
  }
  function initHeroSlider() {
    var slider = document.getElementById('heroSlider');
    if (!slider || slider.getAttribute('data-hero-init')) return;
    slider.setAttribute('data-hero-init', '1');
    var prev = slider.querySelector('[data-hero-prev]');
    var next = slider.querySelector('[data-hero-next]');
    if (prev) prev.addEventListener('click', function () { heroGo(heroSlider.index - 1); });
    if (next) next.addEventListener('click', function () { heroGo(heroSlider.index + 1); });
    slider.addEventListener('mouseenter', stopHeroAuto);
    slider.addEventListener('mouseleave', startHeroAuto);
    slider.addEventListener('focusin', stopHeroAuto);
    slider.addEventListener('focusout', startHeroAuto);
    var sx = null;
    slider.addEventListener('touchstart', function (e) { sx = e.changedTouches[0].clientX; stopHeroAuto(); }, { passive: true });
    slider.addEventListener('touchend', function (e) {
      if (sx === null) return;
      var dx = e.changedTouches[0].clientX - sx;
      sx = null;
      if (dx < -40) heroGo(heroSlider.index + 1);
      else if (dx > 40) heroGo(heroSlider.index - 1);
      else startHeroAuto();
    }, { passive: true });
  }
  function renderHero(slides) {
    var track = document.getElementById('heroTrack');
    var slider = document.getElementById('heroSlider');
    if (!track || !slider) return;
    var keys = slides.map(function (s) { return s.key; });
    var html = slides.map(function (s) {
      return '<a class="st-panel st-panel--featured st-hero-slide" href="' + heroEsc(s.href) + '">' + heroSlideInner(s) + '</a>';
    }).join('');
    if (html !== heroSlider.lastHtml) {
      var cur = heroSlider.keys[heroSlider.index];
      track.innerHTML = html;
      heroSlider.keys = keys;
      heroSlider.lastHtml = html;
      var ni = keys.indexOf(cur);
      heroSlider.index = ni >= 0 ? ni : 0;
      applyHeroSlide();
    }
    var nav = slider.querySelector('.st-hero-nav');
    if (nav) nav.hidden = keys.length < 2;
    if (keys.length > 1) startHeroAuto(); else stopHeroAuto();
    stripCountdowns();
  }
  function refreshHero(data, fixtures) {
    var track = document.getElementById('heroTrack');
    if (!track || !data || !data.matches) return;
    initHeroSlider();
    var st = nplState(data, fixtures, new Date());
    var slides = heroSlidesFor(st);
    if (!slides.length) {
      /* Season over (schedule loaded, final's kickoff passed) — show the
         neutral card. Schedule not loaded yet — leave the baked panel. */
      if (fixtures && fixtures.length) {
        var lastKick = 0;
        fixtures.forEach(function (f) { var t = Date.parse(f.kickoff || ''); if (t > lastKick) lastKick = t; });
        if (lastKick && Date.now() > lastKick) slides = [SEASON_DONE];
      }
      if (!slides.length) return;
    }
    renderHero(slides);
  }
  /* NPL spotlight auto-update (2026-11-13): the baked feature (M22, 12 Nov)
     never moved because the cron is paused. This rewrites the feature card
     + first list item from the same merged state as the hero, on every
     poll. It runs ONLY while the spotlight is still NPL — once
     home-leagues.js swaps it to ILT20/APL (19 Nov / 21 Dec) the feature
     href no longer starts with /npl/ and this returns without touching it.
     Baked HTML stays as the no-JS/SEO fallback. */
  /* "Chitwan Rhinos (NPL) won by 4 wickets" -> "Chitwan Rhinos beat
     Janakpur Bolts by 4 wickets" (the baked feature format). Falls back
     to the status text with league tags stripped. */
  function resultHeadline(r) {
    var st = (r.statusText || '').replace(/\s*\([^)]*\)/g, '').trim();
    var mm = st.match(/^(.*?) won by (.+)$/);
    if (mm) {
      var w = mm[1].trim();
      var t1 = heroShortName(r.team1), t2 = heroShortName(r.team2);
      return w + ' beat ' + (w === t1 ? t2 : t1) + ' by ' + mm[2];
    }
    return st;
  }
  function resultLine(r) {
    return shortTeam(r.team1) + ' ' + (r.score1 || '') + (r.overs1 ? ' (' + r.overs1 + ' ov)' : '') + ', ' +
      shortTeam(r.team2) + ' ' + (r.score2 || '') + (r.overs2 ? ' (' + r.overs2 + ' ov)' : '') +
      ', at Kirtipur on ' + fmtDateLong(r.date) + '.';
  }
  function prevResultOf(latest, data) {
    var prev = null;
    ((data && data.matches) || []).forEach(function (m) {
      if (m.status === 'result' && m.matchNo < latest.matchNo && (!prev || m.matchNo > prev.matchNo)) prev = m;
    });
    return prev;
  }
  function setSpotText(el, text) {
    if (!el) return;
    var node = el.firstChild;
    if (node && node.nodeType === 3) node.nodeValue = text + ' ';
    else el.textContent = text;
  }
  function setSpotFeature(feat, f) {
    feat.setAttribute('href', f.href);
    var k = feat.querySelector('.st-panel__kicker');
    if (k) k.textContent = f.kicker;
    var h = feat.querySelector('h3');
    if (h) h.textContent = f.h;
    var p = feat.querySelector('p');
    if (p) p.textContent = f.p;
    setSpotText(feat.querySelector('.st-action'), f.cta);
  }
  function setSpotItem(spot, m) {
    var item = spot.querySelector('.st-spot__item');
    if (!item || !m) return;
    item.setAttribute('href', '/npl/matches/2026/match-' + m.matchNo + '/');
    var b = item.querySelector('b');
    if (b) b.textContent = 'Match ' + m.matchNo + ' — ' + shortTeam(m.team1) + ' vs ' + shortTeam(m.team2);
    var d = b && b.nextElementSibling;
    if (d) d.textContent = heroShortName(m.team1) + ' vs ' + heroShortName(m.team2) + ' at Kirtipur. Open the match page for the full scorecard and result.';
  }
  function refreshSpotlight(data, fixtures) {
    var spot = document.getElementById('home-spotlight');
    if (!spot) return;
    var feat = spot.querySelector('.st-spot__feature');
    if (!feat) return;
    var href = feat.getAttribute('href') || '';
    if (href.indexOf('/npl/') !== 0) return;
    var st = nplState(data, fixtures, new Date());
    var f = null, prev = null;
    if (st.live) {
      var m = st.live;
      var t1 = heroShortName(m.team1), t2 = heroShortName(m.team2);
      var parts = [];
      parts.push(shortTeam(m.team1) + ' ' + (m.score1 ? m.score1 + (m.overs1 ? ' (' + m.overs1 + ' ov)' : '') : 'yet to bat'));
      parts.push(shortTeam(m.team2) + ' ' + (m.score2 ? m.score2 + (m.overs2 ? ' (' + m.overs2 + ' ov)' : '') : 'yet to bat'));
      f = { href: '/npl/matches/2026/match-' + m.matchNo + '/', kicker: 'Live now · Match ' + m.matchNo,
        h: t1 + ' vs ' + t2, p: parts.join(' · ') + ' — live at Kirtipur.', cta: 'Live scorecard' };
      prev = st.latestResult;
    } else if (st.latestResult) {
      var r = st.latestResult;
      f = { href: '/npl/matches/2026/match-' + r.matchNo + '/', kicker: 'Featured result · Match ' + r.matchNo,
        h: resultHeadline(r), p: resultLine(r) + ' Open the scorecard for the full result.', cta: 'Scorecard and result' };
      prev = prevResultOf(r, data);
    } else if (st.next) {
      var nx = st.next;
      var p2 = nstParts(nx.kickoff);
      f = { href: nx.href, kicker: 'Next match · Match ' + nx.matchNo,
        h: nx.team1 ? nx.team1 + ' vs ' + nx.team2 : (nx.label || nx.desc),
        p: 'At Kirtipur on ' + DAYS[p2.wd] + ', ' + p2.day + ' ' + MONTHS[p2.mo] + ', ' + p2.time + ' NST. Open the match page for the preview.',
        cta: 'Match preview' };
      prev = st.latestResult;
    }
    if (!f) return;
    setSpotFeature(feat, f);
    if (prev) setSpotItem(spot, prev);
  }

  function refreshCarousel(carousel, data) {
    var byNo = {};
    (data.matches || []).forEach(function (m) { byNo[m.matchNo] = m; });
    var cards = Array.prototype.slice.call(carousel.querySelectorAll('.score-card[data-match-no]'));
    /* The "All Matches" track duplicates this league's cards — update
       the copies too, matched by league + match number. */
    var league = carousel.getAttribute('data-league');
    if (league) {
      document.querySelectorAll('[data-strip-group="all"] .score-card[data-league="' + league + '"][data-match-no]').forEach(function (c) { cards.push(c); });
    }
    cards.forEach(function (card) {
      var m = byNo[parseInt(card.getAttribute('data-match-no'), 10)];
      if (!m) return;
      var label = card.querySelector('.sc-label');
      var result = card.querySelector('.sc-result');
      var rows = card.querySelectorAll('.sc-row');
      if (label) {
        label.textContent = m.status === 'live' ? 'Live' : (m.status === 'result' ? 'Result' : 'Upcoming');
        label.classList.toggle('upcoming', m.status === 'upcoming');
        label.classList.toggle('live', m.status === 'live');
      }
      /* Upcoming cards are baked without .sc-score spans, so a live
         score would have nowhere to go — create the span the first
         time the feed carries a score for that side. A side the feed
         has no score for keeps its baked row untouched. */
      rows.forEach(function (row, i) {
        var side = rowSide(row, m, i);
        var s = scoreText(side === 0 ? m.score1 : m.score2, side === 0 ? m.overs1 : m.overs2);
        if (!s) return;
        var span = row.querySelector('.sc-score');
        if (!span) {
          span = document.createElement('span');
          span.className = 'sc-score';
          row.appendChild(span);
        }
        span.textContent = s;
      });
      if (result) {
        /* Upcoming: the baked line carries the date, time and venue —
           the feed's statusText for an upcoming match is either the
           same line or a bare "Upcoming", so it stays put — except
           the NPL evening time (fixEveningTime below). */
        if (m.status === 'live') result.textContent = liveLine(m);
        else if (m.status === 'result') result.textContent = cleanStatus(m.statusText) || result.textContent;
        else if (m.status === 'upcoming') fixEveningTime(card);
        result.classList.toggle('upcoming', m.status === 'upcoming');
      }
      setLoser(card, m);
      /* Live matches join the "Live & upcoming" filter bucket — the
         pills only know all / upcoming / result, and a data-kind of
         "live" would hide a live card under every filter. */
      card.setAttribute('data-kind', m.status === 'result' ? 'result' : 'upcoming');
    });
    recountPills(carousel);
    reorderStripTracks(carousel);
    /* The countdown text reads data-kickoff — fixEveningTime may have
       just moved it, so re-render the countdowns now, not at the next
       60-second tick. */
    stripCountdowns();
  }


  /* Fixture lists (hub #fxFixtures / #fxResults): a live row is a baked
     snapshot — it freezes the moment the page was baked while the strip,
     Match Coverage and ticker all move on. Update every row whose match
     the feed carries as live or result, in place, from the same poll
     that drives the strip. An upcoming row gains its score spans and
     LIVE badge the first time the feed carries a score for it. */
  /* Which feed side does this row belong to? Baked rows carry the
     3-letter code (JAB/CHR); JS-built rows carry the full name. Match
     either, so a feed whose team order differs from the baked order
     (M25: feed CHR/JAB, baked JAB/CHR) still lands the score on the
     right team instead of swapping the two scores. Falls back to the
     row's index when nothing matches. */
  function rowSide(row, m, fallback) {
    var t = (row.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) {
      if (m.abbr1 && t.indexOf(m.abbr1) !== -1) return 0;
      if (m.abbr2 && t.indexOf(m.abbr2) !== -1) return 1;
      if (shortName(m.team1) && t.indexOf(shortName(m.team1)) !== -1) return 0;
      if (shortName(m.team2) && t.indexOf(shortName(m.team2)) !== -1) return 1;
    }
    return fallback;
  }
  function battingSide(m) {
    /* Same open-innings rule as crrOf: a score while the other side has
       none, else the side with fewer overs (10 wickets ends an innings). */
    function wkts(s) { var x = /^(\d+)\/(\d+)/.exec(String(s || '')); return x ? parseInt(x[2], 10) : -1; }
    function balls(o) { var p = String(o || '').split('.'); return (parseInt(p[0] || '0', 10) * 6) + (parseInt(p[1] || '0', 10) || 0); }
    if (m.score2 && !m.score1) return { team: shortName(m.team2), score: m.score2, overs: m.overs2 };
    if (m.score1 && !m.score2) return { team: shortName(m.team1), score: m.score1, overs: m.overs1 };
    if (m.score1 && m.score2) {
      if (wkts(m.score2) >= 10) return { team: shortName(m.team1), score: m.score1, overs: m.overs1 };
      if (wkts(m.score1) >= 10) return { team: shortName(m.team2), score: m.score2, overs: m.overs2 };
      if (balls(m.overs1) > balls(m.overs2)) return { team: shortName(m.team2), score: m.score2, overs: m.overs2 };
      return { team: shortName(m.team1), score: m.score1, overs: m.overs1 };
    }
    return null;
  }
  function fixtureStatus(m) {
    if (m.status === 'result') return cleanStatus(m.statusText) || '';
    /* Chase: "Kathmandu Gorkhas need 92 off 79 balls." — the baked
       fixture style, parsed from the feed's "need 92 runs from 79 balls". */
    var need = /(.+?)\s+need\s+(\d+)\s+runs?\s+from\s+(\d+)\s+balls?/i.exec(cleanStatus(m.statusText || ''));
    if (need) return need[1] + ' need ' + need[2] + ' off ' + need[3] + ' balls.';
    /* First innings (or any other live state): batting side + score. */
    var bat = battingSide(m);
    if (bat) return bat.team + ' ' + bat.score + (bat.overs ? ' (' + bat.overs + ' ov)' : '');
    return cleanStatus(m.statusText) || 'Live now';
  }
  function refreshFixtures(data, league) {
    /* League scoping: match numbers repeat across leagues (NPL M1 and
       ILT20 M1 are both "match-1/"), so a row is only touched by its
       own league's feed. Rows without data-league are the NPL hub's
       (they predate the attribute) — NPL feed only. */
    var lists = document.querySelectorAll('#fxFixtures, #fxResults');
    if (!lists.length || !data || !data.matches) return;
    var byNo = {};
    data.matches.forEach(function (m) { byNo[m.matchNo] = m; });
    lists.forEach(function (list) {
      list.querySelectorAll('li a[href*="/match-"]').forEach(function (a) {
        var li0 = a.closest('li');
        var rowLeague = li0 ? li0.getAttribute('data-league') : null;
        if (rowLeague ? rowLeague !== league : league !== 'npl') return;
        var mm = (a.getAttribute('href') || '').match(/match-(\d+)\//);
        if (!mm) return;
        var m = byNo[parseInt(mm[1], 10)];
        if (!m || (m.status !== 'live' && m.status !== 'result')) return;
        var li = a.closest('li');
        var teams = a.querySelectorAll('.fx-team');
        teams.forEach(function (span, i) {
          var side = rowSide(span, m, i);
          var sc = side === 0 ? m.score1 : m.score2;
          var ov = side === 0 ? m.overs1 : m.overs2;
          if (!sc) {
            var b0 = span.querySelector('b');
            if (b0) {
              /* Live, other side batting: this side has not batted yet. */
              var other = side === 0 ? m.score2 : m.score1;
              b0.textContent = (m.status === 'live' && other) ? 'Yet to bat' : '';
            }
            return;
          }
          /* Results rows show the score only (no "(20 ov) " prefix) — the
             baked Results format. Live rows keep the over: it is the
             current over. */
          var txt = (m.status === 'result' || !ov) ? sc : '(' + ov + ' ov) ' + sc;
          var b = span.querySelector('b');
          if (!b) {
            b = document.createElement('b');
            span.appendChild(document.createTextNode(' '));
            span.appendChild(b);
          }
          b.textContent = txt;
        });
        var st = a.querySelector('.fx-status');
        if (st) {
          var target = st.querySelector('strong') || st;
          target.textContent = fixtureStatus(m);
        }
        if (m.status === 'result') {
          /* A finished match belongs in Results, not Fixtures: move the
             row to #fxResults (prepended, so newest results stay first)
             and drop the LIVE badge. Idempotent: once moved, the row's
             parent is #fxResults and this block is a no-op. */
          var liveBadge = a.querySelector('.fx-live-badge');
          if (liveBadge) liveBadge.remove();
          if (li) li.classList.remove('fx-live-item');
          var resList = document.getElementById('fxResults');
          if (resList && li && li.parentNode !== resList) {
            resList.insertBefore(li, resList.firstChild);
          }
        } else if (m.status === 'live' && li && !li.classList.contains('fx-live-item')) {
          li.classList.add('fx-live-item');
          if (!a.querySelector('.fx-live-badge')) {
            var badge = document.createElement('span');
            badge.className = 'fx-live-badge';
            badge.innerHTML = '<span class="live-dot" aria-hidden="true"></span>LIVE';
            a.insertBefore(badge, a.firstChild);
            a.insertBefore(document.createTextNode(' '), badge.nextSibling);
          }
        }
      });
    });
  }

  /* Match Coverage panels (homepage): a panel carries
     data-mc-panel="m22" and shows the match's status word in its kicker
     ("Upcoming"/"Live now"/"Result") plus a live line in its stand.
     Live and result panels are updated from the feed; upcoming panels
     are left exactly as baked. */
  function refreshMcPanels(data) {
    if (!data || !data.matches) return;
    var panels = document.querySelectorAll('.mc-panel[data-mc-panel]');
    if (!panels.length) return;
    var byNo = {};
    data.matches.forEach(function (m) { byNo[m.matchNo] = m; });
    panels.forEach(function (panel) {
      var raw = panel.getAttribute('data-mc-panel') || '';
      var no = parseInt(raw.replace(/[^0-9]/g, ''), 10);
      var m = byNo[no];
      if (!m) return;
      if (m.status !== 'live' && m.status !== 'result') return;
      var kicker = panel.querySelector('.lead-kicker');
      if (kicker) {
        var datePart = kicker.textContent.split('·').pop().trim();
        var label = m.status === 'live' ? 'Live now' : 'Result';
        var dot = m.status === 'live'
          ? '<span class="live-dot" aria-hidden="true"></span>' : '';
        kicker.innerHTML = dot + esc(label) + ' &middot; ' + esc(datePart);
      }
      var stand = panel.querySelector('.lead-stand');
      if (stand) {
        if (m.status === 'live') {
          stand.textContent = shortName(m.team2) + ' ' + (scoreText(m.score2, m.overs2) || 'yet to bat')
            + ' · ' + shortName(m.team1) + ' ' + (scoreText(m.score1, m.overs1) || 'yet to bat')
            + ' — ' + liveLine(m);
        } else if (m.status === 'result') {
          stand.textContent = cleanStatus(m.statusText) || '';
        }
      }
    });
  }

  /* Sidebar "Coming up" (homepage): a match that is live or finished
     is no longer coming up, so its row is hidden. The item's link
     carries the league and match number
     (/<league>/matches/<season>/match-<no>/). Items for other leagues
     or without a link are left alone. */
  function refreshComingUp(data) {
    if (!data || !data.matches) return;
    var cards = document.querySelectorAll('.side-card');
    var byNo = {};
    data.matches.forEach(function (m) { byNo[m.matchNo] = m; });
    cards.forEach(function (card) {
      var h = card.querySelector('h3');
      if (!h || h.textContent.trim() !== 'Coming up') return;
      card.querySelectorAll('li').forEach(function (li) {
        var a = li.querySelector('a');
        if (!a) return;
        var mm = (a.getAttribute('href') || '').match(/match-(\d+)\//);
        if (!mm) return;
        var m = byNo[parseInt(mm[1], 10)];
        if (m && (m.status === 'live' || m.status === 'result')) {
          li.style.display = 'none';
        }
      });
    });
  }


  /* Carousel Match strip (.st-strip): league filter pills, the
     right-arrow scroll, and a kickoff countdown on upcoming cards
     ("Match starts in X hrs Y mins"). A card whose feed status flips
     away from upcoming hides its countdown line. */
  function stripCountdowns() {
    document.querySelectorAll('[data-kickoff]').forEach(function (el) {
      var card = el.closest('.score-card');
      if (card && card.getAttribute('data-kind') !== 'upcoming') { el.hidden = true; return; }
      var t = Date.parse(el.getAttribute('data-kickoff'));
      if (!t) { el.hidden = true; return; }
      var diff = t - Date.now();
      if (diff <= 0) { el.hidden = true; return; }
      el.hidden = false;
      var mins = Math.floor(diff / 60000);
      var d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
      var when = d > 0 ? d + (d === 1 ? ' day ' : ' days ') + h + ' hrs'
        : (h > 0 ? h + ' hrs ' + m + ' mins' : m + ' mins');
      el.textContent = 'Match starts in ' + when;
    });
  }

  /* League end dates (finals, verified): NPL Sat 21 Nov 2026, ILT20
     Sun 20 Dec 2026, APL Wed 20 Jan 2027. A league leaves the strip
     3 days after its final — its tab, its track and its cards in the
     "All Matches" track all disappear. Checked against the current
     date on every page load, so nothing is hardcoded to hide a league
     "now": while a league is still running it keeps showing. */
  var LEAGUE_END = { npl: '2026-11-21', ilt20: '2026-12-20', apl: '2027-01-20' };
  var LEAGUE_EXPIRY_DAYS = 3;
  function leagueExpired(lg) {
    var end = LEAGUE_END[lg];
    if (!end) return false;
    var hideFrom = Date.parse(end + 'T00:00:00Z') + LEAGUE_EXPIRY_DAYS * 86400000;
    return Date.now() >= hideFrom;
  }


  /* One card step = distance between two adjacent cards (card width +
     gap). Scrolling by exactly one card lands on a clean 3 whole cards;
     the old 80%-of-track scroll (2.4 cards) landed mid-card. */
  function cardStep(track) {
    var cards = track.querySelectorAll('.score-card');
    if (cards.length > 1) {
      var step = cards[1].offsetLeft - cards[0].offsetLeft;
      if (step > 0) return step;
    }
    var card = track.querySelector('.score-card');
    if (card) return card.offsetWidth + 14;
    return track.clientWidth / 3;
  }

  function visibleTrack(strip) {
    return strip.querySelector('.st-strip-track:not([hidden])');
  }

  /* "<" shows once the track is scrolled right, ">" hides at the end;
     both hide when the APL note (no track) is showing. */
  function updateArrows(strip) {
    var prev = strip.querySelector('[data-strip-prev]');
    var next = strip.querySelector('[data-strip-next]');
    var track = visibleTrack(strip);
    if (!track) {
      if (prev) prev.style.display = 'none';
      if (next) next.style.display = 'none';
      return;
    }
    var max = track.scrollWidth - track.clientWidth;
    if (prev) prev.style.display = track.scrollLeft > 0 ? '' : 'none';
    if (next) next.style.display = track.scrollLeft < max - 1 ? '' : 'none';
  }

  function initStrip() {
    document.querySelectorAll('.st-strip').forEach(function (strip) {
      var pills = strip.querySelectorAll('[data-strip-filter]');
      var prev = strip.querySelector('[data-strip-prev]');
      var next = strip.querySelector('[data-strip-next]');
      /* 3-day expiry: hide the finished league's pill + track + its
         cards in the "All Matches" track, and re-count "All Matches". */
      var expired = {};
      var allExpired = true;
      pills.forEach(function (pill) {
        var lg = pill.getAttribute('data-strip-filter');
        if (lg === 'all') return;
        if (leagueExpired(lg)) {
          expired[lg] = true;
          pill.style.display = 'none';
        } else {
          allExpired = false;
        }
      });
      if (allExpired) { strip.style.display = 'none'; return; }
      strip.querySelectorAll('[data-strip-group]').forEach(function (g) {
        var lg = g.getAttribute('data-strip-group');
        if (lg !== 'all' && expired[lg]) g.remove();
      });
      strip.querySelectorAll('[data-strip-group="all"] .score-card[data-league]').forEach(function (c) {
        if (expired[c.getAttribute('data-league')]) c.remove();
      });
      var allPill = strip.querySelector('[data-strip-filter="all"]');
      if (allPill) {
        var total = 0;
        pills.forEach(function (p) {
          var lg = p.getAttribute('data-strip-filter');
          if (lg === 'all' || expired[lg]) return;
          var m = (p.textContent || '').match(/\((\d+)\)/);
          if (m) total += parseInt(m[1], 10);
        });
        allPill.textContent = allPill.textContent.replace(/\(\d+\)\s*$/, '(' + total + ')');
      }
      /* If the baked-active pill belonged to an expired league, fall
         back to "All Matches". */
      var active = strip.querySelector('[data-strip-filter][aria-pressed="true"]');
      if (active && expired[active.getAttribute('data-strip-filter')]) {
        active.setAttribute('aria-pressed', 'false');
        if (allPill) allPill.setAttribute('aria-pressed', 'true');
        strip.querySelectorAll('[data-strip-group]').forEach(function (g) {
          g.hidden = g.getAttribute('data-strip-group') !== 'all';
        });
      }
      pills.forEach(function (pill) {
        pill.addEventListener('click', function () {
          var lg = pill.getAttribute('data-strip-filter');
          pills.forEach(function (p) { p.setAttribute('aria-pressed', p === pill ? 'true' : 'false'); });
          strip.querySelectorAll('[data-strip-group]').forEach(function (g) {
            g.hidden = g.getAttribute('data-strip-group') !== lg;
          });
          updateArrows(strip);
          stripCountdowns();
        });
      });
      if (prev) prev.addEventListener('click', function () {
        var track = visibleTrack(strip);
        if (track) track.scrollBy({ left: -cardStep(track), behavior: 'smooth' });
      });
      if (next) next.addEventListener('click', function () {
        var track = visibleTrack(strip);
        if (track) track.scrollBy({ left: cardStep(track), behavior: 'smooth' });
      });
      strip.querySelectorAll('.st-strip-track').forEach(function (track) {
        track.addEventListener('scroll', function () { updateArrows(strip); }, { passive: true });
      });
      updateArrows(strip);
    });
    /* Baked evening times: correct a stale "4:30 PM NST" on load,
       whether or not the feed carries the match — the feed-gated pass
       in refreshCarousel skips a card the feed does not know. Idempotent:
       after the first fix the text no longer matches. */
    document.querySelectorAll('.st-strip .score-card').forEach(function (c) { fixEveningTime(c); });
    stripCountdowns();
    setInterval(stripCountdowns, 60000);
    window.addEventListener('resize', function () {
      document.querySelectorAll('.st-strip').forEach(updateArrows);
    });
  }


  /* Fixtures / Results segmented tabs (hub #fxFixtures / #fxResults):
     the buttons shipped with no click handler at all, so Results never
     showed. Toggle aria-pressed + the lists' hidden state. */
  function initFxSeg() {
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

  /* Feed fetch with a short retry: one transient failure (slow ESPN
     upstream, edge hiccup) used to swallow the whole 30s poll silently
     — strip + fixture rows stayed on their baked snapshot while
     Match Coverage / ticker (separate files, separate polls) moved on.
     NOTE: window.sialtvScores never rejects — on failure it resolves
     with the static fallback, which is EMPTY when that file is missing
     or has no matches. So an empty result is retried too, not just a
     rejection. Retry delay is 12s: sialtvScores caches its promise for
     10s, so a faster retry would just get the same cached empty data. */
  function loadLeague(lg, onData) {
    var tries = 0;
    function attempt() {
      window.sialtvScores(lg).then(function (data) {
        if (!data || !data.matches || !data.matches.length) {
          tries++;
          if (window.console && console.warn) console.warn('[flash-scores] feed ' + lg + ' empty (try ' + tries + ')');
          if (tries < 3) setTimeout(attempt, 12000);
          return;
        }
        onData(data);
      }).catch(function (err) {
        tries++;
        if (window.console && console.warn) console.warn('[flash-scores] feed ' + lg + ' failed (try ' + tries + '):', err);
        if (tries < 3) setTimeout(attempt, 12000);
      });
    }
    attempt();
  }

  function boot() {
    initStrip();
    initFxSeg();
    if (!window.sialtvScores) return;
    var flash = document.getElementById('sialtvFlash');
    var carousel = document.getElementById('scoreCarousel');
    var loaders = [];
    /* Site-wide live-scores page: one .slp-flash per league, each
       polled on its own league feed. #sialtvFlash is excluded — the
       single-league path below already handles it (the NPL
       live-scores page carries both the id and the class). */
    document.querySelectorAll('.slp-flash[data-league]:not(#sialtvFlash)').forEach(function (group) {
      var lg = group.getAttribute('data-league');
      loaders.push(function () {
        if (document.hidden) return;
        /* Each updater isolated: a throw in one must not kill the others. */
        loadLeague(lg, function (data) {
          try { refreshFlash(group, data, lg); } catch (e) { if (window.console && console.warn) console.warn('[flash-scores] refreshFlash failed:', e); }
          try { refreshFixtures(data, lg); } catch (e) { if (window.console && console.warn) console.warn('[flash-scores] refreshFixtures failed:', e); }
          if (lg === 'npl') {
            /* Schedule first, then hero + spotlight from the merged state.
               The schedule fetch is cached, so every 30s poll reuses it. */
            loadNplSchedule().then(function (fixtures) {
              try { refreshHero(data, fixtures); } catch (e) { if (window.console && console.warn) console.warn('[flash-scores] refreshHero failed:', e); }
              try { refreshSpotlight(data, fixtures); } catch (e) { if (window.console && console.warn) console.warn('[flash-scores] refreshSpotlight failed:', e); }
            });
          }
        });
      });
    });
    if (flash || carousel) {
      var league = (flash && flash.getAttribute('data-league')) ||
        (carousel && carousel.getAttribute('data-flash')) || 'npl';
      loaders.push(function () {
        if (document.hidden) return;
        window.sialtvScores(league).then(function (data) {
          if (!data || !data.matches || !data.matches.length) return;
          if (flash) refreshFlash(flash, data, league);
          if (carousel) refreshCarousel(carousel, data);
          refreshMcPanels(data);
          refreshComingUp(data);
        }).catch(function () {});
      });
    }
    if (!loaders.length) return;
    function loadAll() { loaders.forEach(function (fn) { fn(); }); }
    loadAll();
    setInterval(loadAll, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) loadAll(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

