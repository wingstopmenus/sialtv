<?php
declare(strict_types=1);

// Serve existing score snapshots without contacting the upstream feed.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=10');
$data = dirname(__DIR__) . '/data/';
$files = [
    'npl' => 'live-scores.json',
    'ilt20' => 'ilt20-live-scores.json',
    'bbl' => 'bbl-live-scores.json',
    'sa20' => 'sa20-live-scores.json',
];
$fields = array_flip([
    'matchNo', 'status', 'statusText', 'team1', 'team2', 'score1', 'score2',
    'overs1', 'overs2', 'venue', 'kickoffIso', 'date', 'toss',
]);
$snapshots = [];
foreach ($files as $league => $file) {
    $matches = [];
    foreach ([$data . $file, $data . 'runtime/' . $league . '-live-scores.json'] as $path) {
        $raw = is_readable($path) ? file_get_contents($path) : false;
        $snapshot = $raw === false ? null : json_decode($raw, true);
        foreach ($snapshot['matches'] ?? [] as $match) {
            $number = (int) ($match['matchNo'] ?? 0);
            if ($number < 1 || (($matches[$number]['status'] ?? '') === 'result' && ($match['status'] ?? '') !== 'result')) {
                continue;
            }
            $matches[$number] = array_intersect_key($match, $fields) + ($matches[$number] ?? []);
        }
    }
    $snapshots[$league] = ['league' => $league, 'matches' => array_values($matches)];
}
echo json_encode($snapshots, JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_UNICODE);
