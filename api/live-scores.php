<?php
/**
 * SialTV live scores — ESPN scoreboard proxy + normaliser + cache.
 *
 * GET /api/live-scores.php?league=npl  (npl is the default)
 * Configured leagues: npl (23081), ilt20 (1557442), sa20 (1547229),
 * bbl (8044 — the ESPN league id; Cricinfo series 1545470 maps to it).
 * Every other league answers {"matches": [], "error":
 * "league_not_configured"} — apl and psl have no Cricinfo series page
 * yet (checked 11 Nov 2026), so their series ids are TBC and are never
 * guessed. To add a league: a series id in LEAGUE_SERIES, its event
 * base in LEAGUE_EVENT_BASE, its id prefix in LEAGUE_ID_PREFIX, and a
 * static fallback in STATIC_FALLBACK.
 *
 * Fallback chain: fresh cache (<12s) -> stale cache -> committed
 * data/<league>-live-scores.json -> empty matches. The pages never
 * break when ESPN is down; they show the last good score with its real
 * "Updated ..." time.
 *
 * Data shape matches data/live-scores.json exactly (fetchedAt, source,
 * matches[] with scorecard / commentary / overTimeline / live), so the
 * browser code cannot tell whether a payload came from ESPN or from
 * the committed snapshot.
 *
 * Toss rule: toss text comes ONLY from ESPN notes of type "toss".
 * Kickoff times: the site's own schedule is the authority — ESPN's
 * date can be ~30 minutes off, so the live window is generous (15
 * minutes before the ESPN date until +5 hours).
 *
 * NOT YET VERIFIED LIVE: Hostinger PHP + cron on this plan, and the
 * endpoint itself after deploy. Do not claim it works until a live
 * curl proves it.
 */
declare(strict_types=1);

$isCli = PHP_SAPI === 'cli';
if (!$isCli) {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: public, max-age=8, s-maxage=8, stale-while-revalidate=15');
    header('X-SialTV-Live: v1');
}

const SIALTV_UA = 'SialTVLive/1.0';
const SIALTV_CACHE_SECONDS = 12;
/* Full play-by-play cache: the summary embeds only the last ~18 balls,
   so the match page's Commentary / Overs / worm / FOW can only show
   the last ~3 overs from it. The full PBP (playbyplay endpoint, 25
   items/page, period 1+2) is cached per event+period for 30 s and
   refreshed only when the summary's newest ball sequence advances —
   so a live poll costs 0 extra ESPN requests when nothing new was
   bowled, and one parallel burst (all pages at once) when it has. */
const SIALTV_PBP_CACHE_SECONDS = 30;

const LEAGUE_SERIES = [
    'npl' => 23081, // Nepal Premier League 2026 (website series 1558581)
    'ilt20' => 1557442, // DP World ILT20 2026-27 — scoreboard verified
    'sa20' => 1547229, // SA20 2027 — scoreboard verified
    'bbl' => 8044, // Big Bash League 2026-27 — ESPN league id; Cricinfo
    // series 1545470 maps to 8044 (scoreboard + summary verified)
    // apl, psl: no Cricinfo series page yet — do not guess.
];
const LEAGUE_NAMES = [
    'npl' => 'Nepal Premier League 2026',
    'ilt20' => 'DP World ILT20 2026-27',
    'sa20' => 'SA20 2027',
    'bbl' => 'Big Bash League 2026-27',
];
const STATIC_FALLBACK = [
    'npl' => '/data/live-scores.json',
    'ilt20' => '/data/ilt20-live-scores.json',
    'sa20' => '/data/sa20-live-scores.json',
    'bbl' => '/data/bbl-live-scores.json',
];
/* Per-league event base: M<n> = base + n (M1 verified per league by
   curl: npl 1558602 (M28 = 1558609), ilt20 1557443, sa20 1547230,
   bbl 1545498). */
const LEAGUE_EVENT_BASE = [
    'npl' => 1558581,
    'ilt20' => 1557442,
    'sa20' => 1547229,
    'bbl' => 1545497,
];
/* Match-id prefix per league — must match the committed static files
   exactly, or the merge dedupes by id and shows duplicate matches. */
const LEAGUE_ID_PREFIX = [
    'npl' => 'npl-2026',
    'ilt20' => 'ilt20-2026-27',
    'sa20' => 'sa20-2026-27',
    'bbl' => 'bbl-2026-27',
];

$league = strtolower(trim((string) ($_GET['league'] ?? 'npl')));
if ($league === '' || !preg_match('/^[a-z0-9]+$/', $league)) {
    $league = 'npl';
}
$seriesId = LEAGUE_SERIES[$league] ?? null;
if ($seriesId === null) {
    echo json_encode([
        'fetchedAt' => gmdate('c'),
        'source' => 'espn',
        'league' => $league,
        'matches' => [],
        'error' => 'league_not_configured',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$tmpDir = sys_get_temp_dir();
$cachePath = $tmpDir . '/sialtv-live-' . $league . '-v1.json';
// Per-uid lock: a root cron cannot open www-data's /tmp lock file
// (fs.protected_regular) — that silently stopped every CLI refresh on
// the NPL site from 27 Oct until the lock path gained the uid.
$lockPath = $tmpDir . '/sialtv-live-' . $league . '-' . (function_exists('posix_geteuid') ? posix_geteuid() : getmyuid()) . '.lock';
$runtimeLive = dirname(__DIR__) . '/data/runtime/' . $league . '-live-scores.json';
$cliRefresh = $isCli || getenv('SIALTV_LIVE_REFRESH') === '1' || !empty($_SERVER['SIALTV_LIVE_REFRESH']);

function sialtv_live_body(string $path): ?string
{
    if (!is_file($path)) {
        return null;
    }
    $body = @file_get_contents($path);
    if (!is_string($body) || $body === '' || strpos($body, '"matches"') === false) {
        return null;
    }
    return $body;
}

function sialtv_freshest(string $runtimeLive, string $cachePath): array
{
    $best = null;
    $bestAge = 99999;
    foreach ([$runtimeLive, $cachePath] as $path) {
        if (!is_file($path)) {
            continue;
        }
        $age = time() - (int) filemtime($path);
        if ($age < $bestAge) {
            $bestAge = $age;
            $best = $path;
        }
    }
    return [$best, $bestAge];
}

function sialtv_store(string $json, string $cachePath, string $runtimeLive): void
{
    @file_put_contents($cachePath, $json, LOCK_EX);
    @mkdir(dirname($runtimeLive), 0755, true);
    @file_put_contents($runtimeLive, $json, LOCK_EX);
}

[$freshPath, $freshAge] = sialtv_freshest($runtimeLive, $cachePath);
$freshBody = $freshPath ? sialtv_live_body($freshPath) : null;

if (!$cliRefresh && $freshBody !== null && $freshAge < SIALTV_CACHE_SECONDS) {
    if (!$isCli) {
        header('X-SialTV-Live-Cache: ' . basename($freshPath) . ';age=' . $freshAge);
    }
    echo $freshBody;
    exit;
}

$lock = @fopen($lockPath, 'c');
$gotLock = $lock && flock($lock, LOCK_EX | LOCK_NB);
if (!$gotLock) {
    if ($freshBody !== null) {
        if (!$isCli) {
            header('X-SialTV-Live-Cache: ' . basename((string) $freshPath) . ';age=' . $freshAge);
        }
        echo $freshBody;
        exit;
    }
    echo '{"fetchedAt":"","source":"espn","matches":[]}';
    exit;
}

$cached = $freshBody;
try {
    $payload = sialtv_build_payload($seriesId, $league, true);
    if ($cached !== null) {
        $payload = sialtv_keep_scorecards($payload, $cached);
    }
    $payload = sialtv_merge_static_schedule($payload, $league);
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (!is_string($json)) {
        throw new RuntimeException('encode');
    }
    sialtv_store($json, $cachePath, $runtimeLive);
    if (!$isCli) {
        header('X-SialTV-Live-Cache: refreshed');
    }
    echo $json;
} catch (Throwable $e) {
    if ($freshBody !== null) {
        if (!$isCli) {
            header('X-SialTV-Live-Cache: stale');
        }
        echo $freshBody;
    } else {
        $fallback = dirname(__DIR__) . (STATIC_FALLBACK[$league] ?? '');
        if ($fallback !== dirname(__DIR__) && is_file($fallback)) {
            readfile($fallback);
        } else {
            echo '{"fetchedAt":"","source":"espn","matches":[]}';
        }
    }
}
if ($lock) {
    flock($lock, LOCK_UN);
}
exit;

/* ---------------- ESPN fetch ---------------- */

function sialtv_espn_get(string $url, int $timeout): ?array
{
    if (!function_exists('curl_init')) {
        $ctx = stream_context_create(['http' => ['timeout' => $timeout, 'header' => "Accept: application/json\r\nUser-Agent: " . SIALTV_UA . "\r\n"]]);
        $raw = @file_get_contents($url, false, $ctx);
        $data = is_string($raw) ? json_decode($raw, true) : null;
        return is_array($data) ? $data : null;
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_NOSIGNAL => true,
        CURLOPT_HTTPHEADER => ['Accept: application/json', 'User-Agent: ' . SIALTV_UA],
    ]);
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if (!is_string($raw) || $code < 200 || $code >= 300) {
        return null;
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

/* Parallel ESPN fetch (curl_multi). Falls back to sequential
   sialtv_espn_get when curl is unavailable. Returns [url => ?array]. */
function sialtv_espn_get_multi(array $urls, int $timeout): array
{
    $out = [];
    if (!function_exists('curl_multi_init')) {
        foreach ($urls as $url) {
            $out[$url] = sialtv_espn_get($url, $timeout);
        }
        return $out;
    }
    $mh = curl_multi_init();
    $handles = [];
    foreach ($urls as $url) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_NOSIGNAL => true,
            CURLOPT_HTTPHEADER => ['Accept: application/json', 'User-Agent: ' . SIALTV_UA],
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[$url] = $ch;
    }
    $running = 0;
    do {
        $mrc = curl_multi_exec($mh, $running);
        if ($running > 0) {
            curl_multi_select($mh, 0.5);
        }
    } while ($running > 0 && $mrc === CURLM_OK);
    foreach ($handles as $url => $ch) {
        $raw = curl_multi_getcontent($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $data = (is_string($raw) && $code >= 200 && $code < 300) ? json_decode($raw, true) : null;
        $out[$url] = is_array($data) ? $data : null;
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    return $out;
}

/* One ball from the ESPN play-by-play / summary commentary shape into
   the endpoint's commentary shape (the shape the match-page JS reads).
   'period' is the innings number (1|2); 'seq' is the ESPN sequence,
   kept for cache merging and stripped from the payload. 'team' is the
   ball's batting team as reported by ESPN (empty in the summary
   window — the over timeline takes the team from the innings). */
function sialtv_map_commentary_ball(array $cb, int $period): array
{
    $ctext = trim((string) ($cb['text'] ?? ''));
    if ($ctext === '') {
        $ctext = (string) ($cb['shortText'] ?? '');
    }
    return [
        'over' => (string) ($cb['over']['actual'] ?? ''),
        'short' => (string) ($cb['shortText'] ?? ''),
        'text' => $ctext,
        'runs' => (int) ($cb['scoreValue'] ?? 0),
        'dismissal' => (string) ($cb['dismissal']['text'] ?? ''),
        'bowler' => (string) ($cb['bowler']['athlete']['displayName'] ?? ''),
        'batsman' => (string) ($cb['batsman']['athlete']['displayName'] ?? ''),
        'otherBatsman' => (string) ($cb['otherBatsman']['athlete']['displayName'] ?? ''),
        'period' => $period,
        'seq' => (int) ($cb['sequence'] ?? 0),
        'team' => sialtv_canon_team((string) ($cb['team']['displayName'] ?? '')),
    ];
}

/* Full play-by-play for one period, cache-aware. Returns [entries
   (chronological, normalised), maxSeq, count]. $latestSeq is the
   newest ball sequence the summary window already shows for this
   period — when the cache is fresh (<30 s) and its maxSeq covers it,
   no ESPN request is made at all. Otherwise all pages are fetched in
   one parallel burst (page 1 first for the page count, the rest via
   curl_multi) and merged by sequence. Any failure returns the stale
   cache, or an empty list — never an exception, so the payload build
   falls back to the summary window. */
function sialtv_pbp_period_items(int $seriesId, int $eventId, int $period, int $latestSeq): array
{
    $cachePath = sys_get_temp_dir() . '/sialtv-pbp-' . $eventId . '-p' . $period . '.json';
    $cached = null;
    if (is_file($cachePath)) {
        $d = json_decode((string) @file_get_contents($cachePath), true);
        if (is_array($d) && is_array($d['entries'] ?? null)) {
            $cached = $d;
        }
    }
    $fresh = is_array($cached) && (time() - (int) ($cached['fetchedAt'] ?? 0)) < SIALTV_PBP_CACHE_SECONDS;
    if ($fresh && (int) ($cached['maxSeq'] ?? 0) >= $latestSeq) {
        return [$cached['entries'], (int) $cached['maxSeq'], (int) ($cached['count'] ?? 0)];
    }
    $base = 'https://site.api.espn.com/apis/site/v2/sports/cricket/' . $seriesId . '/playbyplay?event=' . $eventId . '&period=' . $period;
    $first = sialtv_espn_get($base . '&page=1', 4);
    if (!is_array($first) || !is_array($first['commentary'] ?? null)) {
        return is_array($cached)
            ? [$cached['entries'], (int) $cached['maxSeq'], (int) ($cached['count'] ?? 0)]
            : [[], 0, 0];
    }
    $c = $first['commentary'];
    $count = (int) ($c['count'] ?? 0);
    $pageCount = (int) ($c['pageCount'] ?? 1);
    $items = is_array($c['items'] ?? null) ? $c['items'] : [];
    if ($pageCount > 1) {
        $urls = [];
        for ($p = 2; $p <= $pageCount; $p++) {
            $urls[] = $base . '&page=' . $p;
        }
        foreach (sialtv_espn_get_multi($urls, 4) as $data) {
            if (is_array($data) && is_array($data['commentary']['items'] ?? null)) {
                $items = array_merge($items, $data['commentary']['items']);
            }
        }
    }
    $seen = [];
    $entries = [];
    foreach ($items as $it) {
        if (!is_array($it)) {
            continue;
        }
        $seq = (int) ($it['sequence'] ?? 0);
        if ($seq <= 0 || isset($seen[$seq])) {
            continue;
        }
        $seen[$seq] = true;
        /* Real balls only: a non-ball item (breaks, reviews) has no
           numeric over.actual and would corrupt the over grouping. */
        if (!is_numeric($it['over']['actual'] ?? null)) {
            continue;
        }
        $entries[] = sialtv_map_commentary_ball($it, $period);
    }
    usort($entries, static fn($a, $b) => $a['seq'] <=> $b['seq']);
    $maxSeq = $entries ? max(array_column($entries, 'seq')) : 0;
    @file_put_contents($cachePath, json_encode(
        ['fetchedAt' => time(), 'maxSeq' => $maxSeq, 'count' => $count, 'entries' => $entries],
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    ), LOCK_EX);
    return [$entries, $maxSeq, $count];
}

/* Over-by-over timeline from normalised balls (one period, newest
   first): label, runs, wickets, ball tokens, bowler, batting team,
   period. The token rule matches the old window builder exactly (W
   for a wicket, otherwise the runs; a wide is "Nw", a no-ball "Nnb"). */
function sialtv_over_timeline(array $balls, string $team, int $period): array
{
    $byOver = [];
    $order = [];
    foreach ($balls as $b) {
        if (!is_array($b)) {
            continue;
        }
        $actual = (string) ($b['over'] ?? '');
        if (!preg_match('/^(\d+)\.(\d)$/', $actual, $m)) {
            continue;
        }
        $overNo = ((int) $m[1]) + 1;
        if (!isset($byOver[$overNo])) {
            $byOver[$overNo] = ['label' => 'Over ' . $overNo, 'runs' => 0, 'wickets' => 0, 'tokens' => [], 'bowler' => (string) ($b['bowler'] ?? ''), 'team' => $team, 'period' => $period];
            $order[] = $overNo;
        }
        $ballRuns = (int) ($b['runs'] ?? 0);
        $ballShort = strtolower((string) ($b['short'] ?? ''));
        if (trim((string) ($b['dismissal'] ?? '')) !== '') {
            $byOver[$overNo]['tokens'][] = 'W';
            $byOver[$overNo]['wickets']++;
        } elseif (strpos($ballShort, 'wide') !== false) {
            $byOver[$overNo]['tokens'][] = $ballRuns . 'w';
        } elseif (strpos($ballShort, 'no ball') !== false) {
            $byOver[$overNo]['tokens'][] = $ballRuns . 'nb';
        } else {
            $byOver[$overNo]['tokens'][] = (string) $ballRuns;
        }
        $byOver[$overNo]['runs'] += $ballRuns;
    }
    rsort($order);
    $out = [];
    foreach ($order as $n) {
        $out[] = $byOver[$n];
    }
    return $out;
}

/* Internal ball (from sialtv_map_commentary_ball) to the payload
   shape: the ESPN sequence is an internal key only, and 'period' is
   omitted when unknown (the JS defaults a missing period to the
   current innings, so old / window entries still render). */
function sialtv_commentary_out(array $e): array
{
    $out = [
        'over' => $e['over'],
        'short' => $e['short'],
        'text' => $e['text'],
        'runs' => $e['runs'],
        'dismissal' => $e['dismissal'],
        'bowler' => $e['bowler'],
        'batsman' => $e['batsman'],
        'otherBatsman' => $e['otherBatsman'],
    ];
    if ((int) ($e['period'] ?? 0) > 0) {
        $out['period'] = (int) $e['period'];
    }
    return $out;
}

/* Full PBP for a live match: [commentary (newest first, all periods),
   overTimeline (current period, full), overTimelinePrev (previous
   period, full)]. Returns null when the PBP is unavailable or stale —
   the caller then keeps the summary window. $headerComp is the
   summary's competition (for the per-period newest sequences);
   $innings are the mapped innings (for the batting team per period). */
function sialtv_full_pbp(int $seriesId, int $eventId, $headerComp, array $innings): ?array
{
    if (!is_array($headerComp) || !is_array($headerComp['commentaries'] ?? null)) {
        return null;
    }
    $latestSeq = [1 => 0, 2 => 0];
    foreach ($headerComp['commentaries'] as $cb) {
        if (!is_array($cb)) {
            continue;
        }
        $p = (int) ($cb['innings']['number'] ?? $cb['period'] ?? 0);
        $s = (int) ($cb['sequence'] ?? 0);
        if ($p >= 1 && $p <= 2 && $s > $latestSeq[$p]) {
            $latestSeq[$p] = $s;
        }
    }
    if ($latestSeq[1] <= 0 && $latestSeq[2] <= 0) {
        return null;
    }
    $byPeriod = [];
    foreach ([1, 2] as $per) {
        [$entries, , ] = sialtv_pbp_period_items($seriesId, $eventId, $per, $latestSeq[$per]);
        $byPeriod[$per] = $entries;
    }
    $have = array_merge($byPeriod[1], $byPeriod[2]);
    if (!$have) {
        return null;
    }
    /* The full list must at least cover the window's newest ball;
       otherwise the PBP fetch is stale/partial — keep the window. */
    if (max(array_column($have, 'seq')) < max($latestSeq)) {
        return null;
    }
    $teamFor = [];
    foreach ($innings as $inn) {
        if (!is_array($inn)) {
            continue;
        }
        $per = (int) ($inn['period'] ?? 0);
        if ($per < 1 || $per > 2) {
            continue;
        }
        if (!empty($inn['batting']) || !empty($inn['yet'])) {
            $teamFor[$per] = (string) ($inn['team'] ?? '');
        }
    }
    $curPeriod = ($latestSeq[2] > $latestSeq[1]) ? 2 : 1;
    $prevPeriod = $curPeriod === 2 ? 1 : 0;
    $all = array_merge($byPeriod[1], $byPeriod[2]);
    usort($all, static fn($a, $b) => $b['seq'] <=> $a['seq']);
    $commentary = [];
    foreach ($all as $e) {
        $commentary[] = sialtv_commentary_out($e);
    }
    $tl = static function (array $entries, int $per) use ($teamFor): array {
        if (!$entries) {
            return [];
        }
        return sialtv_over_timeline(array_reverse($entries), $teamFor[$per] ?? '', $per);
    };
    return [$commentary, $tl($byPeriod[$curPeriod], $curPeriod), $prevPeriod ? $tl($byPeriod[$prevPeriod], $prevPeriod) : []];
}

/* Playing XI from the ESPN summary rosters: the roster IS the XI (11
   players, in batting order) once the match is live. Returns null
   unless both rosters carry exactly 11 — never invent an XI. */
function sialtv_map_playing_xi(?array $summary): ?array
{
    $rosters = is_array($summary['rosters'] ?? null) ? $summary['rosters'] : [];
    if (count($rosters) !== 2) {
        return null;
    }
    $out = [];
    foreach ($rosters as $side) {
        if (!is_array($side)) {
            return null;
        }
        $roster = is_array($side['roster'] ?? null) ? $side['roster'] : [];
        if (count($roster) !== 11) {
            return null;
        }
        $players = [];
        foreach ($roster as $p) {
            if (!is_array($p)) {
                return null;
            }
            $name = (string) ($p['athlete']['displayName'] ?? $p['athlete']['fullName'] ?? '');
            if ($name === '') {
                return null;
            }
            $players[] = [
                'name' => $name,
                'captain' => !empty($p['captain']),
                'wk' => (($p['position']['abbreviation'] ?? '') === 'WK'),
            ];
        }
        $out[] = [
            'team' => sialtv_canon_team((string) ($side['team']['displayName'] ?? '')),
            'players' => $players,
        ];
    }
    return $out;
}

/* If a fresh ESPN payload has lost batting data, keep the previous
   cached scorecard / commentary / over timeline instead of showing an
   empty card. */
function sialtv_keep_scorecards(array $payload, string $cachedJson): array
{
    $old = json_decode($cachedJson, true);
    if (!is_array($old) || !is_array($old['matches'] ?? null)) {
        return $payload;
    }
    $byId = [];
    foreach ($old['matches'] as $m) {
        if (is_array($m) && isset($m['id'])) {
            $byId[(string) $m['id']] = $m;
        }
    }
    foreach ($payload['matches'] as $i => $m) {
        $prev = $byId[(string) ($m['id'] ?? '')] ?? null;
        if (!is_array($prev)) {
            continue;
        }
        $newBat = 0;
        foreach (($m['scorecard']['innings'] ?? []) as $inn) {
            $newBat += count($inn['batting'] ?? []);
        }
        $oldBat = 0;
        foreach (($prev['scorecard']['innings'] ?? []) as $inn) {
            $oldBat += count($inn['batting'] ?? []);
        }
        if ($newBat === 0 && $oldBat > 0) {
            $payload['matches'][$i]['scorecard'] = $prev['scorecard'];
            $payload['matches'][$i]['commentary'] = $prev['commentary'] ?? [];
            $payload['matches'][$i]['overTimeline'] = $prev['overTimeline'] ?? [];
            $payload['matches'][$i]['overTimelinePrev'] = $prev['overTimelinePrev'] ?? [];
            if (!empty($prev['live'])) {
                $payload['matches'][$i]['live'] = $prev['live'];
            }
            continue;
        }
        /* Never shrink a FINISHED innings' batting list: a not-out
           0-ball batter flips to 'yet' once his live role changes —
           M29, 17 Nov 2026: Hemant Dhami was 0* at the crease at the
           end of innings 1, then started bowling in innings 2, and
           the fresh payload dropped him from the batting list. A
           finished innings is one whose period is behind the current
           period; its batting + yet are restored from the cache. */
        $newPeriods = [];
        foreach (($m['scorecard']['innings'] ?? []) as $inn) {
            $newPeriods[] = (int) ($inn['period'] ?? 0);
        }
        $curPeriod = $newPeriods ? max($newPeriods) : 0;
        $oldInns = [];
        foreach (($prev['scorecard']['innings'] ?? []) as $o) {
            if (is_array($o)) {
                $oldInns[(string) ($o['team'] ?? '') . '|' . (int) ($o['period'] ?? 0)] = $o;
            }
        }
        foreach (($m['scorecard']['innings'] ?? []) as $j => $inn) {
            if (!is_array($inn)) {
                continue;
            }
            $key = (string) ($inn['team'] ?? '') . '|' . (int) ($inn['period'] ?? 0);
            $old = $oldInns[$key] ?? null;
            if (!is_array($old)) {
                continue;
            }
            if ((int) ($inn['period'] ?? 0) < $curPeriod
                && count($inn['batting'] ?? []) < count($old['batting'] ?? [])) {
                $payload['matches'][$i]['scorecard']['innings'][$j]['batting'] = $old['batting'];
                $payload['matches'][$i]['scorecard']['innings'][$j]['yet'] = $old['yet'] ?? [];
            }
        }
    }
    return $payload;
}

/* A scheduled match must never vanish from the panel just because
   ESPN's scoreboard stopped listing it. ESPN drops a 'pre' event once
   its scheduled time passes without it going live (12 Nov 2026: M22
   delayed, still unplayed, scoreboard returned only M23 — the panel
   showed M23 as next). Merge unplayed matches from the committed
   static file back in, in match order. Results come from ESPN only. */
function sialtv_merge_static_schedule(array $payload, string $league): array
{
    $path = dirname(__DIR__) . (STATIC_FALLBACK[$league] ?? '');
    if ($path === dirname(__DIR__) || !is_file($path)) {
        return $payload;
    }
    $static = json_decode((string) @file_get_contents($path), true);
    if (!is_array($static['matches'] ?? null)) {
        return $payload;
    }
    $have = [];
    foreach ($payload['matches'] as $m) {
        if (is_array($m) && isset($m['id'])) {
            $have[(string) $m['id']] = true;
        }
    }
    $extra = [];
    foreach ($static['matches'] as $m) {
        if (!is_array($m) || empty($m['id']) || !empty($have[(string) $m['id']])) {
            continue;
        }
        $st = strtolower((string) ($m['status'] ?? ''));
        if ($st !== 'upcoming' && $st !== 'live') {
            continue;
        }
        $extra[] = $m;
    }
    if ($extra === []) {
        return $payload;
    }
    $merged = array_merge($payload['matches'], $extra);
    usort($merged, static function ($a, $b) {
        return ((int) ($a['matchNo'] ?? 0)) <=> ((int) ($b['matchNo'] ?? 0));
    });
    $payload['matches'] = array_values($merged);
    return $payload;
}

function sialtv_build_payload(int $seriesId, string $league, bool $withSummary = true): array
{
    $sb = sialtv_espn_get('https://site.api.espn.com/apis/site/v2/sports/cricket/' . $seriesId . '/scoreboard', 2);
    if (!is_array($sb) || !is_array($sb['events'] ?? null)) {
        throw new RuntimeException('empty scoreboard');
    }
    $haveCard = [];
    if (is_file(sys_get_temp_dir() . '/sialtv-live-' . $league . '-v1.json')) {
        $old = json_decode((string) @file_get_contents(sys_get_temp_dir() . '/sialtv-live-' . $league . '-v1.json'), true);
        foreach ((is_array($old['matches'] ?? null) ? $old['matches'] : []) as $m) {
            if (is_array($m) && !empty($m['scorecard']['innings'])) {
                $haveCard[(string) ($m['id'] ?? '')] = true;
            }
        }
    }
    $matches = [];
    $liveLeft = 2;
    $postLeft = 1;
    $now = time();
    foreach ($sb['events'] as $event) {
        if (!is_array($event)) {
            continue;
        }
        $comp = $event['competitions'][0] ?? null;
        if (!is_array($comp)) {
            continue;
        }
        $id = (int) ($event['id'] ?? 0);
        $state = strtolower((string) ($comp['status']['type']['state'] ?? 'pre'));
        $inWindow = sialtv_in_live_window($event, $now);
        if ($state === 'pre' && !$inWindow) {
            // Not started and not about to start: scoreboard row only.
            $matches[] = sialtv_normalise_event($event, $comp, null, $league);
            continue;
        }
        $summary = null;
        $fetch = false;
        if ($withSummary && $id > 0 && $state === 'in' && $liveLeft > 0) {
            $fetch = true;
            $liveLeft--;
        } elseif ($withSummary && $id > 0 && $state === 'pre' && $inWindow && $liveLeft > 0) {
            /* In-window pre-start (toss done, no ball bowled): the
               summary carries the rosters — the playing XI — which the
               match page shows from the toss. One slot of the live
               budget; the match goes 'in' at the first ball anyway. */
            $fetch = true;
            $liveLeft--;
        } elseif ($withSummary && $id > 0 && $state === 'post' && $postLeft > 0 && empty($haveCard[(string) $id])) {
            $fetch = true;
            $postLeft--;
        }
        if ($fetch) {
            $summary = sialtv_espn_get('https://site.api.espn.com/apis/site/v2/sports/cricket/' . $seriesId . '/summary?event=' . $id, 4);
        }
        $matches[] = sialtv_normalise_event($event, $comp, is_array($summary) ? $summary : null, $league);
    }
    return [
        'fetchedAt' => gmdate('c'),
        'source' => 'espn',
        'league' => $league,
        'matches' => $matches,
    ];
}

/* A match counts as live from 15 minutes before its ESPN date until
   that date + 5 hours. ESPN state "pre" inside the window is treated
   as "in" — the site's own schedule page, not ESPN's date, is the
   authority for the real start time. */
function sialtv_in_live_window(array $event, ?int $now = null): bool
{
    $now = $now ?? time();
    $date = (string) ($event['date'] ?? '');
    if ($date === '') {
        return false;
    }
    $kick = strtotime($date);
    if ($kick === false) {
        return false;
    }
    return $now >= $kick - 900 && $now <= $kick + 5 * 3600;
}

function sialtv_balls_bowled(string $overs): int
{
    if (!preg_match('/^(\d+)(?:\.(\d))?/', trim($overs), $m)) {
        return 0;
    }
    return ((int) $m[1]) * 6 + (isset($m[2]) ? (int) $m[2] : 0);
}

function sialtv_chase_text(string $name1, string $score1, string $overs1, string $name2, string $score2, string $overs2): string
{
    if (!preg_match('/^(\d+)\/(\d+)/', $score1, $a) || !preg_match('/^(\d+)\/(\d+)/', $score2, $b)) {
        return '';
    }
    $b1 = sialtv_balls_bowled($overs1);
    $b2 = sialtv_balls_bowled($overs2);
    $done1 = (int) $a[2] >= 10 || $b1 >= 120;
    $done2 = (int) $b[2] >= 10 || $b2 >= 120;
    if ($done1 && !$done2) {
        $target = (int) $a[1] + 1;
        $need = $target - (int) $b[1];
        $left = max(0, 120 - $b2);
        $line = $name2 . ' need ' . $need . ($need === 1 ? ' run' : ' runs');
        if ($need > 0 && $left > 0 && $left < 120) {
            $line .= ' from ' + $left . ($left === 1 ? ' ball' : ' balls');
        }
        return $need > 0 ? $line : '';
    }
    if ($done2 && !$done1) {
        $target = (int) $b[1] + 1;
        $need = $target - (int) $a[1];
        $left = max(0, 120 - $b1);
        $line = $name1 . ' need ' . $need . ($need === 1 ? ' run' : ' runs');
        if ($need > 0 && $left > 0 && $left < 120) {
            $line .= ' from ' . $left . ($left === 1 ? ' ball' : ' balls');
        }
        return $need > 0 ? $line : '';
    }
    return '';
}

function sialtv_decided_text(string $name1, string $score1, string $overs1, string $name2, string $score2, string $overs2): string
{
    if (!preg_match('/^(\d+)\/(\d+)/', $score1, $a) || !preg_match('/^(\d+)\/(\d+)/', $score2, $b)) {
        return '';
    }
    $b1 = sialtv_balls_bowled($overs1);
    $b2 = sialtv_balls_bowled($overs2);
    $done1 = (int) $a[2] >= 10 || $b1 >= 120;
    $done2 = (int) $b[2] >= 10 || $b2 >= 120;
    if (($done1 xor $done2)) {
        $setRuns = $done1 ? (int) $a[1] : (int) $b[1];
        $chRuns = $done1 ? (int) $b[1] : (int) $a[1];
        $chWkts = $done1 ? (int) $b[2] : (int) $a[2];
        $chName = $done1 ? $name2 : $name1;
        if ($chRuns > $setRuns && $chWkts < 10 && $chName !== '') {
            $left = 10 - $chWkts;
            return $chName . ' won by ' . $left . ($left === 1 ? ' wicket' : ' wickets');
        }
        return '';
    }
    if (!$done1 || !$done2) {
        return '';
    }
    $secondIs1 = (int) $a[2] >= 10 && $b1 < 120;
    if (!$secondIs1 && !((int) $b[2] >= 10 && $b2 < 120)) {
        $secondIs1 = $b1 <= $b2;
    }
    if ($secondIs1) {
        $defend = (int) $b[1];
        $chaseRuns = (int) $a[1];
        $chaseName = $name1;
    } else {
        $defend = (int) $a[1];
        $chaseRuns = (int) $b[1];
        $chaseName = $name2;
    }
    if ($chaseRuns > $defend) {
        return '';
    }
    $margin = $defend - $chaseRuns;
    return $chaseName === $name1 ? $name2 . ' won by ' . $margin . ($margin === 1 ? ' run' : ' runs') : $name1 . ' won by ' . $margin . ($margin === 1 ? ' run' : ' runs');
}

function sialtv_canon_team(string $name): string
{
    $name = trim((string) preg_replace('/\s+/', ' ', $name));
    $key = strtolower($name);
    $map = [
        'kathmandu gurkhas' => 'Kathmandu Gorkhas',
        'sudur paschim royals' => 'Sudurpaschim Royals',
    ];
    return $map[$key] ?? $name;
}

function sialtv_pick_linescore($lines): array
{
    if (!is_array($lines)) {
        return [];
    }
    $played = [];
    foreach ($lines as $ls) {
        if (!is_array($ls)) {
            continue;
        }
        if (!empty($ls['isBatting']) && !empty($ls['isCurrent'])) {
            return $ls;
        }
        if ((int) ($ls['runs'] ?? 0) > 0 || (int) ($ls['wickets'] ?? 0) > 0) {
            $played = $ls;
        }
    }
    return $played;
}

function sialtv_team_line(array $c, array $hcomps): array
{
    $rawName = (string) ($c['team']['displayName'] ?? $c['team']['name'] ?? '');
    $name = sialtv_canon_team($rawName);
    $abbr = (string) ($c['team']['abbreviation'] ?? '');
    $id = (string) ($c['id'] ?? $c['team']['id'] ?? '');
    $lines = is_array($c['linescores'] ?? null) ? $c['linescores'] : [];
    if ($id !== '' && isset($hcomps[$id]['linescores']) && is_array($hcomps[$id]['linescores'])) {
        $lines = $hcomps[$id]['linescores'];
    }
    $ls = sialtv_pick_linescore($lines);
    $runs = $ls['runs'] ?? null;
    $wkts = $ls['wickets'] ?? null;
    $ov = isset($ls['overs']) ? (string) $ls['overs'] : '';
    $scoreStr = (string) ($c['score'] ?? '');
    if (preg_match('/(\d+)\/(\d+)/', $scoreStr, $m) && (int) $m[1] > (int) $runs) {
        $runs = (int) $m[1];
        $wkts = (int) $m[2];
        if (preg_match('/\((\d+(?:\.\d+)?)/', $scoreStr, $om)) {
            $ov = $om[1];
        }
    }
    $batting = !empty($ls['isBatting']) && !empty($ls['isCurrent']);
    $played = $batting || (is_numeric($runs) && ((int) $runs > 0 || (int) $wkts > 0));
    if (!$played) {
        return [$name, $abbr, '', ''];
    }
    return [$name, $abbr, ((int) $runs) . '/' . ((int) $wkts), $ov];
}

function sialtv_player_stats(array $player, int $period = 0): array
{
    $nums = [];
    $out = '';
    $order = null;
    $bowlOrder = null;
    $blocks = $player['linescores'] ?? [];
    if (!is_array($blocks)) {
        $blocks = [];
    }
    foreach ($blocks as $block) {
        if (!is_array($block)) {
            continue;
        }
        if ($period > 0 && (int) ($block['period'] ?? 1) !== $period) {
            continue;
        }
        $inners = $block['linescores'] ?? [$block];
        if (!is_array($inners)) {
            continue;
        }
        foreach ($inners as $inner) {
            if (!is_array($inner)) {
                continue;
            }
            $st = $inner['statistics'] ?? $block['statistics'] ?? null;
            if (!is_array($st)) {
                continue;
            }
            foreach (($st['categories'] ?? []) as $cat) {
                if (!is_array($cat)) {
                    continue;
                }
                foreach (($cat['stats'] ?? []) as $stat) {
                    if (!is_array($stat) || !isset($stat['name'])) {
                        continue;
                    }
                    $nums[(string) $stat['name']] = (string) ($stat['displayValue'] ?? $stat['value'] ?? '');
                }
            }
            $bat = $st['batting'] ?? null;
            if (is_array($bat)) {
                if (isset($bat['order']) && $bat['order'] !== '' && $bat['order'] !== null) {
                    $order = (int) $bat['order'];
                }
                $short = trim((string) ($bat['outDetails']['shortText'] ?? ''));
                if ($short !== '') {
                    $out = $short;
                }
            }
            $bowl = $st['bowling'] ?? null;
            if (is_array($bowl) && isset($bowl['order']) && $bowl['order'] !== '') {
                $bowlOrder = (int) $bowl['order'];
            }
        }
    }
    return ['nums' => $nums, 'out' => $out, 'order' => $order, 'bowlOrder' => $bowlOrder];
}

function sialtv_economy(string $overs, float $runs): string
{
    if (!preg_match('/^(\d+)(?:\.(\d))?/', $overs, $m)) {
        return '';
    }
    $balls = ((int) $m[1]) * 6 + (int) ($m[2] ?? 0);
    if ($balls <= 0) {
        return '';
    }
    $eco = $runs * 6 / $balls;
    return rtrim(rtrim(number_format($eco, 2, '.', ''), '0'), '.');
}

/* Scorecard innings from the ESPN summary rosters: batting and bowling
   rows per innings (period), in batting/bowling order. */
function sialtv_map_innings(array $summary, string $name1, string $name2): array
{
    $rosters = is_array($summary['rosters'] ?? null) ? $summary['rosters'] : [];
    $periodList = [1];
    foreach ($rosters as $side) {
        if (!is_array($side)) {
            continue;
        }
        foreach (($side['roster'] ?? []) as $player) {
            if (!is_array($player)) {
                continue;
            }
            foreach (($player['linescores'] ?? []) as $block) {
                if (is_array($block)) {
                    $periodList[(int) ($block['period'] ?? 1)] = (int) ($block['period'] ?? 1);
                }
            }
        }
    }
    $periodList = array_values(array_unique($periodList));
    sort($periodList);
    /* The crease roles (striker / non-striker) are LIVE roles — they
       describe the current period only. Applied to every period they
       leak the current batters into a finished innings' batting list
       (M29, 17 Nov 2026: Aasif Sheikh + Dickwella, at the crease in
       innings 2, appeared as 0* batters in Lumbini's innings-1 entry,
       which had never batted). */
    $currentPeriod = $periodList ? max($periodList) : 1;
    $out = [];
    foreach ($periodList as $period) {
        $sides = [];
        foreach ($rosters as $side) {
            if (!is_array($side)) {
                continue;
            }
            $team = sialtv_canon_team((string) ($side['team']['displayName'] ?? ''));
            $batting = [];
            $bowling = [];
            $yet = [];
            foreach (($side['roster'] ?? []) as $player) {
                if (!is_array($player)) {
                    continue;
                }
                $pname = (string) ($player['athlete']['displayName'] ?? $player['athlete']['fullName'] ?? '');
                if ($pname === '') {
                    continue;
                }
                $role = strtolower(trim((string) ($player['activeName'] ?? '')));
                $atCrease = $period === $currentPeriod && ($role === 'striker' || $role === 'non-striker');
                $stats = sialtv_player_stats($player, (int) $period);
                $nums = $stats['nums'];
                $hasBat = array_key_exists('ballsFaced', $nums) || array_key_exists('runs', $nums);
                $hasBowl = array_key_exists('conceded', $nums) || (array_key_exists('overs', $nums) && array_key_exists('wickets', $nums));
                if ($hasBat) {
                    $balls = (int) ($nums['ballsFaced'] ?? 0);
                    $runs = (int) ($nums['runs'] ?? 0);
                    $order = $stats['order'];
                    if ($order === null && (int) ($nums['battingPosition'] ?? 0) > 0) {
                        $order = (int) $nums['battingPosition'];
                    }
                    $outText = trim((string) $stats['out']);
                    $batted = $balls > 0 || $runs > 0 || ($outText !== '' && strtolower($outText) !== 'not out') || $atCrease;
                    if ($batted) {
                        if ($outText === '' || strtolower($outText) === 'not out') {
                            $outText = 'not out';
                        }
                        $sr = $nums['strikeRate'] ?? '';
                        $batting[] = [
                            'order' => $order ?? 99,
                            'name' => $pname,
                            'dismissal' => html_entity_decode($outText, ENT_QUOTES | ENT_HTML5, 'UTF-8'),
                            'runs' => (string) $runs,
                            'balls' => (string) $balls,
                            'fours' => (string) ($nums['fours'] ?? '0'),
                            'sixes' => (string) ($nums['sixes'] ?? '0'),
                            'sr' => is_numeric($sr) ? number_format((float) $sr, 2, '.', '') : (string) $sr,
                            'crease' => $atCrease ? $role : '',
                        ];
                    } else {
                        $yet[] = $pname;
                    }
                } elseif ($atCrease) {
                    $batting[] = [
                        'order' => 99,
                        'name' => $pname,
                        'dismissal' => 'not out',
                        'runs' => '0',
                        'balls' => '0',
                        'fours' => '0',
                        'sixes' => '0',
                        'sr' => '0.00',
                        'crease' => $role,
                    ];
                }
                if ($hasBowl) {
                    $overs = (string) ($nums['overs'] ?? '0');
                    $balls = (int) ($nums['balls'] ?? 0);
                    $wkts = (int) ($nums['wickets'] ?? 0);
                    if ($balls > 0 || $wkts > 0 || (float) $overs > 0) {
                        $bowling[] = [
                            'order' => $stats['bowlOrder'] ?? 99,
                            'name' => $pname,
                            'overs' => $overs,
                            'maidens' => (string) ($nums['maidens'] ?? '0'),
                            'runs' => (string) ($nums['conceded'] ?? '0'),
                            'wickets' => (string) $wkts,
                            'wides' => (string) ($nums['wides'] ?? '0'),
                            'noballs' => (string) ($nums['noballs'] ?? '0'),
                            'econ' => sialtv_economy($overs, (float) ($nums['conceded'] ?? 0)),
                        ];
                    }
                }
            }
            if (!$batting && !$bowling) {
                continue;
            }
            usort($batting, static fn($a, $b) => $a['order'] <=> $b['order']);
            usort($bowling, static fn($a, $b) => $a['order'] <=> $b['order']);
            foreach ($batting as &$row) {
                unset($row['order']);
            }
            unset($row);
            foreach ($bowling as &$row) {
                unset($row['order']);
            }
            unset($row);
            $sides[] = ['team' => $team, 'period' => $period, 'batting' => $batting, 'bowling' => $bowling, 'yet' => $yet];
        }
        foreach ($sides as $side) {
            $out[] = $side;
        }
    }
    return $out;
}

function sialtv_sync_totals(array $innings, string $name1, string $score1, string $overs1, string $name2, string $score2, string $overs2): array
{
    $sync = [$name1 => [$score1, $overs1], $name2 => [$score2, $overs2]];
    foreach ($innings as $i => $inn) {
        $pair = $sync[$inn['team'] ?? ''] ?? null;
        if (!is_array($pair) || !preg_match('/^(\d+)\/(\d+)/', (string) $pair[0], $sm)) {
            continue;
        }
        /* The header score is authoritative — it includes extras
           (wides/no-balls), which the batting sum misses. */
        $innings[$i]['total'] = (string) $pair[0];
        if ($pair[1] !== '') {
            $innings[$i]['overs'] = $pair[1];
        }
    }
    return $innings;
}

/* Live block: batters at the crease, current bowler, run rate,
   partnership, last wicket, recent overs — from the summary's latest
   commentary ball plus the innings tables. */
function sialtv_map_live($headerComp, array $innings, array $summary = null): ?array
{
    if (!is_array($headerComp)) {
        return null;
    }
    $raw = is_array($headerComp['commentaries'] ?? null) ? $headerComp['commentaries'] : [];
    $balls = [];
    foreach ($raw as $ball) {
        if (is_array($ball)) {
            $balls[] = $ball;
        }
    }
    usort($balls, static fn($a, $b) => ((int) ($b['sequence'] ?? 0)) <=> ((int) ($a['sequence'] ?? 0)));
    $last = $balls[0] ?? null;

    $batInn = null;
    foreach ($innings as $inn) {
        if (!empty($inn['batting'])) {
            $batInn = $inn;
        }
    }
    $batters = [];
    if (is_array($batInn)) {
        foreach ($batInn['batting'] as $b) {
            $role = strtolower((string) ($b['crease'] ?? ''));
            if ($role === 'striker' || $role === 'non-striker') {
                $batters[] = [
                    'name' => (string) $b['name'],
                    'runs' => (string) $b['runs'],
                    'balls' => (string) $b['balls'],
                    'fours' => (string) ($b['fours'] ?? '0'),
                    'sixes' => (string) ($b['sixes'] ?? '0'),
                    'sr' => (string) ($b['sr'] ?? ''),
                    'striker' => $role === 'striker',
                ];
            }
        }
        if (!$batters) {
            foreach ($batInn['batting'] as $b) {
                if (strtolower((string) ($b['dismissal'] ?? '')) === 'not out') {
                    $batters[] = [
                        'name' => (string) $b['name'],
                        'runs' => (string) $b['runs'],
                        'balls' => (string) $b['balls'],
                        'fours' => (string) ($b['fours'] ?? '0'),
                        'sixes' => (string) ($b['sixes'] ?? '0'),
                        'sr' => (string) ($b['sr'] ?? ''),
                        'striker' => false,
                    ];
                }
            }
            if ($batters) {
                $batters[0]['striker'] = true;
            }
        }
    }
    $bowlers = [];
    if (is_array($last)) {
        foreach (['bowler', 'otherBowler'] as $key) {
            $bow = $last[$key] ?? null;
            if (!is_array($bow)) {
                continue;
            }
            $bname = (string) ($bow['athlete']['displayName'] ?? '');
            if ($bname === '') {
                continue;
            }
            $nums = [];
            foreach (($bow['linescores'] ?? []) as $ls) {
                foreach (($ls['statistics']['categories'] ?? []) as $cat) {
                    foreach (($cat['stats'] ?? []) as $stat) {
                        if (isset($stat['name'])) {
                            $nums[(string) $stat['name']] = (string) ($stat['displayValue'] ?? $stat['value'] ?? '');
                        }
                    }
                }
            }
            /* The commentary bowler also carries the figures directly
               (overs/maidens/conceded/wickets) — the linescores above
               are empty for live balls, so fill from those fields. */
            foreach (['overs', 'maidens', 'conceded', 'wickets'] as $k) {
                if (($nums[$k] ?? '') === '' && isset($bow[$k])) {
                    $nums[$k] = (string) $bow[$k];
                }
            }
            $bowlers[] = [
                'name' => $bname,
                'overs' => (string) ($nums['overs'] ?? ''),
                'maidens' => (string) ($nums['maidens'] ?? '0'),
                'runs' => (string) ($nums['conceded'] ?? '0'),
                'wickets' => (string) ($nums['wickets'] ?? '0'),
                'econ' => sialtv_economy((string) ($nums['overs'] ?? '0'), (float) ($nums['conceded'] ?? 0)),
                'current' => $key === 'bowler',
            ];
        }
    }
    $recentOvers = [];
    $seen = [];
    foreach ($balls as $ball) {
        $overNo = (int) ($ball['over']['number'] ?? 0);
        if ($overNo <= 0 || isset($seen[$overNo])) {
            continue;
        }
        $seen[$overNo] = true;
        $tokens = [];
        $runs = 0;
        $wkts = 0;
        foreach ($balls as $b2) {
            if ((int) ($b2['over']['number'] ?? 0) !== $overNo) {
                continue;
            }
            /* One token per ball: W for a wicket, otherwise the runs
               off that ball. Never prose — the feed's ball text can be
               a whole sentence. The runs live in 'scoreValue' (the
               feed has no 'runs' on a ball); a wide is "1w", a
               no-ball is "1nb". */
            $ballRuns = (int) ($b2['scoreValue'] ?? $b2['runs'] ?? 0);
            $ballShort = strtolower((string) ($b2['shortText'] ?? ''));
            if (!empty($b2['dismissal']['dismissal'])) {
                $tokens[] = 'W';
                $wkts++;
            } elseif (strpos($ballShort, 'wide') !== false) {
                $tokens[] = $ballRuns . 'w';
            } elseif (strpos($ballShort, 'no ball') !== false) {
                $tokens[] = $ballRuns . 'nb';
            } else {
                $tokens[] = (string) $ballRuns;
            }
            $runs += $ballRuns;
        }
        $recentOvers[] = [
            'label' => 'Over ' . $overNo,
            'runs' => $runs,
            'wickets' => $wkts,
            'tokens' => array_reverse($tokens),
            'bowler' => (string) ($ball['bowler']['athlete']['displayName'] ?? ''),
        ];
        if (count($recentOvers) >= 3) {
            break;
        }
    }
    $crr = '';
    $lastOver = '';
    if ($recentOvers) {
        $lastOver = (string) $recentOvers[0]['runs'] . '/' . (string) $recentOvers[0]['wickets'];
    }
    $out = [
        'batters' => $batters,
        'bowlers' => $bowlers,
        'crr' => $crr,
        'partnership' => '',
        'lastOver' => $lastOver,
        'lastFive' => '',
        'projected' => '',
        'lastWicket' => null,
        'recentOvers' => $recentOvers,
    ];
    /* The last wicket is the most recent ball with a dismissal — not
       necessarily the latest ball (the latest ball is usually a dot). */
    if (is_array($last)) {
        foreach ($balls as $wb) {
            if (!is_array($wb) || empty($wb['dismissal']['dismissal'])) {
                continue;
            }
            $d = $wb['dismissal'];
            $out['lastWicket'] = [
                'name' => (string) ($wb['batsman']['athlete']['displayName'] ?? ''),
                'runs' => (string) ($wb['batsman']['runs'] ?? ''),
                'balls' => (string) ($wb['batsman']['ballsFaced'] ?? ''),
                'dismissal' => (string) ($d['text'] ?? $d['dismissal'] ?? ''),
                'fow' => (string) ($wb['homeScore'] ?? ''),
                'over' => (string) ($wb['over']['actual'] ?? $wb['over']['number'] ?? ''),
            ];
            break;
        }
    }
    return $out;
}

function sialtv_normalise_event(array $event, array $comp, ?array $summary, string $league): array
{
    $state = strtolower((string) ($comp['status']['type']['state'] ?? 'pre'));
    $status = $state === 'in' ? 'live' : ($state === 'post' ? 'result' : 'upcoming');
    if ($status === 'upcoming' && sialtv_in_live_window($event)) {
        $status = 'live';
    }
    $competitors = [];
    foreach (($comp['competitors'] ?? []) as $c) {
        if (!is_array($c)) {
            continue;
        }
        $side = ($c['homeAway'] ?? '') === 'home' ? 0 : 1;
        $competitors[$side] = $c;
    }
    ksort($competitors);
    $competitors = array_values($competitors);
    $t1 = $competitors[0] ?? [];
    $t2 = $competitors[1] ?? [];

    $headerComp = null;
    if (is_array($summary)) {
        $headerComp = $summary['header']['competitions'][0] ?? null;
    }
    $hcomps = [];
    if (is_array($headerComp)) {
        foreach (($headerComp['competitors'] ?? []) as $c) {
            if (is_array($c)) {
                $hcomps[(string) ($c['id'] ?? $c['team']['id'] ?? '')] = $c;
            }
        }
    }
    [$name1, $abbr1, $score1, $overs1] = sialtv_team_line($t1, $hcomps);
    [$name2, $abbr2, $score2, $overs2] = sialtv_team_line($t2, $hcomps);

    $summaryRaw = trim((string) ($comp['status']['summary'] ?? ''));
    $detail = trim((string) ($comp['status']['type']['detail'] ?? ''));
    $toss = '';
    foreach (($comp['notes'] ?? []) as $note) {
        if (is_array($note) && strtolower((string) ($note['type'] ?? '')) === 'toss') {
            $toss = trim((string) ($note['text'] ?? ''));
        }
    }
    if ($toss === '' && preg_match('/\btoss\b/i', $summaryRaw)) {
        $toss = $summaryRaw;
    }
    if ($status === 'result' && $detail !== '' && strtolower($detail) !== 'final') {
        $statusText = $detail;
    } elseif ($status === 'result') {
        $statusText = ($summaryRaw !== '' && !preg_match('/\btoss\b/i', $summaryRaw)) ? $summaryRaw : 'Result';
    } elseif ($status === 'live') {
        $statusText = 'Live';
    } else {
        $statusText = 'Upcoming';
    }
    $chase = sialtv_chase_text($name1, $score1, $overs1, $name2, $score2, $overs2);
    if ($status === 'live' && $chase !== '') {
        $statusText = $chase;
    }
    $decided = sialtv_decided_text($name1, $score1, $overs1, $name2, $score2, $overs2);
    if ($decided === '' && $status !== 'result' && preg_match('/\b(won by|match tied|no result|abandoned)\b/i', $summaryRaw) && !preg_match('/\btoss\b/i', $summaryRaw)) {
        $decided = $summaryRaw;
    }
    if ($decided !== '') {
        $status = 'result';
        $statusText = $decided;
    }

    $desc = trim((string) ($comp['shortDescription'] ?? $comp['description'] ?? ''));
    $matchNo = 0;
    if (preg_match('/Match\s+(\d+)/i', $desc, $mm)) {
        $matchNo = (int) $mm[1];
    }
    $eventId = (int) ($event['id'] ?? 0);
    $eventBase = LEAGUE_EVENT_BASE[$league] ?? 0;
    if ($matchNo === 0 && $eventBase > 0 && $eventId > $eventBase) {
        $matchNo = $eventId - $eventBase;
    }
    if ($desc === '' || stripos($desc, ' vs ') !== false) {
        $desc = $matchNo > 0 ? 'Match ' . $matchNo : 'Match';
    }

    $innings = [];
    $commentary = [];
    $overs = [];
    $oversPrev = [];
    $live = null;
    $xi = null;
    if (is_array($summary)) {
        $innings = sialtv_map_innings($summary, $name1, $name2);
        $innings = sialtv_sync_totals($innings, $name1, $score1, $overs1, $name2, $score2, $overs2);
        $live = sialtv_map_live($headerComp, $innings, $summary);
        $overs = $live['recentOvers'] ?? [];
        $xi = sialtv_map_playing_xi($summary);
        /* Ball-by-ball commentary from the feed (most recent first),
           for the match page's Commentary tab. */
        if (is_array($headerComp) && is_array($headerComp['commentaries'] ?? null)) {
            $cballs = [];
            foreach ($headerComp['commentaries'] as $cb) {
                if (is_array($cb)) {
                    $cballs[] = $cb;
                }
            }
            usort($cballs, static fn($a, $b) => ((int) ($b['sequence'] ?? 0)) <=> ((int) ($a['sequence'] ?? 0)));
            foreach ($cballs as $cb) {
                $per = (int) ($cb['innings']['number'] ?? $cb['period'] ?? 0);
                $commentary[] = sialtv_commentary_out(sialtv_map_commentary_ball($cb, $per));
            }
        }
        /* Full play-by-play (defect 2): the window above is only the
           last ~18 balls. When the PBP cache has the full innings,
           the commentary + over timelines come from it instead —
           newest first, all overs from over 1. Any failure keeps the
           window above (never break the payload). */
        $full = sialtv_full_pbp($seriesId, $eventId, $headerComp, $innings);
        if ($full !== null) {
            [$commentary, $overs, $oversPrev] = $full;
        }
        if (is_array($headerComp)) {
            $hs = trim((string) ($headerComp['status']['summary'] ?? ''));
            if ($toss === '' && preg_match('/\btoss\b/i', $hs)) {
                $toss = $hs;
            }
        }
    }

    return [
        'id' => (LEAGUE_ID_PREFIX[$league] ?? $league) . '-m' . ($matchNo > 0 ? $matchNo : $eventId),
        'espnEventId' => $eventId,
        'matchNo' => $matchNo,
        'matchDesc' => $desc,
        'series_name' => LEAGUE_NAMES[$league] ?? $league,
        'team1' => $name1,
        'team2' => $name2,
        'abbr1' => $abbr1,
        'abbr2' => $abbr2,
        'status' => $status,
        'statusText' => $statusText,
        'toss' => $toss !== '' ? $toss : null,
        'score1' => $score1 !== '' ? $score1 : null,
        'score2' => $score2 !== '' ? $score2 : null,
        'overs1' => $overs1 !== '' ? $overs1 : null,
        'overs2' => $overs2 !== '' ? $overs2 : null,
        'venue' => null,
        'date' => substr((string) ($event['date'] ?? ''), 0, 10),
        'scorecard' => ['innings' => $innings],
        'commentary' => $commentary,
        'overTimeline' => $overs,
        'overTimelinePrev' => $oversPrev,
        'playingXI' => $xi,
        'live' => $live,
    ];
}
