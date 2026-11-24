#!/usr/bin/env php
<?php
/**
 * SialTV live-score refresher (CLI only — cron job).
 * Runs the same fetch and cache writer as the HTTP endpoint.
 * Writes the runtime snapshot atomically on successful refresh.
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
if (!preg_match('/^[a-z0-9]+$/', $league)) {
    fwrite(STDERR, "Invalid league\n");
    exit(1);
}

$_GET['league'] = $league;
require dirname(__DIR__) . '/api/live-scores.php';
