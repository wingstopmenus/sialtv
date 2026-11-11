#!/usr/bin/env php
<?php
/**
 * SialTV live-score refresher (CLI only — cron job).
 * Re-fetches ESPN through api/live-scores.php and writes
 * data/runtime/<league>-live-scores.json atomically (tmp + rename),
 * so the endpoint never has to hit ESPN per visitor request.
 * Safe every 20-30s during match windows:
 *   php scripts/sialtv-live-refresh.php npl
 * League defaults to npl; other leagues answer "not configured"
 * until their ESPN series id is known (see api/live-scores.php).
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only\n");
    exit(1);
}

$league = strtolower(trim((string) ($argv[1] ?? 'npl')));
if ($league === '' || !preg_match('/^[a-z0-9]+$/', $league)) {
    $league = 'npl';
}
$root = dirname(__DIR__);
$runtime = $root . '/data/runtime';
@mkdir($runtime, 0755, true);

putenv('SIALTV_LIVE_REFRESH=1');
$_SERVER['SIALTV_LIVE_REFRESH'] = '1';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_GET['league'] = $league;

ob_start();
try {
    include $root . '/api/live-scores.php';
} catch (Throwable $e) {
    ob_end_clean();
    fwrite(STDERR, 'refresh failed: ' . $e->getMessage() . "\n");
    exit(2);
}
$json = ob_get_clean();
if (!is_string($json) || $json === '' || strpos($json, '"matches"') === false) {
    fwrite(STDERR, "bad payload\n");
    exit(3);
}

$dest = $runtime . '/' . $league . '-live-scores.json';
$tmp = $dest . '.tmp';
file_put_contents($tmp, $json, LOCK_EX);
rename($tmp, $dest);
@file_put_contents(sys_get_temp_dir() . '/sialtv-live-' . $league . '-v1.json', $json, LOCK_EX);

fwrite(STDOUT, 'wrote ' . strlen($json) . ' bytes to runtime/' . $league . '-live-scores.json' . "\n");
exit(0);
