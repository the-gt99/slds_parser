<?php

declare(strict_types=1);

if ($argc !== 4) {
    fwrite(STDERR, "Usage: php build-wordpress-product-media-list.php <wordpress-root> <uploads-root> <output-list>\n");
    exit(2);
}

[$script, $wordpressRoot, $uploadsRoot, $outputList] = $argv;
$wordpressRoot = rtrim($wordpressRoot, '/');
$uploadsRoot = rtrim($uploadsRoot, '/');

define('SHORTINIT', true);
require $wordpressRoot . '/wp-load.php';

global $wpdb;
if (!isset($wpdb) || !($wpdb->dbh instanceof mysqli)) {
    throw new RuntimeException('WordPress database connection is unavailable');
}

$attachmentIds = [];

function streamRows(mysqli $connection, string $sql): Generator
{
    $result = $connection->query($sql, MYSQLI_USE_RESULT);
    if ($result === false) {
        throw new RuntimeException($connection->error);
    }
    try {
        while ($row = $result->fetch_assoc()) {
            yield $row;
        }
    } finally {
        $result->free();
    }
}

function addId(array &$ids, mixed $value): void
{
    $id = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if ($id !== false) {
        $ids[(int) $id] = true;
    }
}

$posts = $wpdb->posts;
$postmeta = $wpdb->postmeta;
$connection = $wpdb->dbh;

foreach (streamRows($connection, "SELECT a.ID FROM {$posts} a JOIN {$posts} p ON p.ID=a.post_parent WHERE a.post_type='attachment' AND p.post_type IN ('product','product_variation')") as $row) {
    addId($attachmentIds, $row['ID']);
}

foreach (streamRows($connection, "SELECT pm.meta_value FROM {$postmeta} pm JOIN {$posts} p ON p.ID=pm.post_id WHERE pm.meta_key='_thumbnail_id' AND p.post_type IN ('product','product_variation')") as $row) {
    addId($attachmentIds, $row['meta_value']);
}

foreach (streamRows($connection, "SELECT pm.meta_value FROM {$postmeta} pm JOIN {$posts} p ON p.ID=pm.post_id WHERE pm.meta_key='_product_image_gallery' AND p.post_type='product'") as $row) {
    foreach (explode(',', (string) $row['meta_value']) as $value) {
        addId($attachmentIds, trim($value));
    }
}

$output = fopen($outputList, 'wb');
if ($output === false) {
    throw new RuntimeException("Cannot open output list: {$outputList}");
}

$extensions = array_fill_keys(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp'], true);
$written = 0;

function writeImagePath($output, string $uploadsRoot, string $relativePath, array $extensions, int &$written): void
{
    $relativePath = ltrim(str_replace('\\', '/', $relativePath), '/');
    if ($relativePath === '' || str_contains($relativePath, "\n") || str_contains($relativePath, "\r") || str_contains($relativePath, '../')) {
        return;
    }
    $extension = strtolower(pathinfo($relativePath, PATHINFO_EXTENSION));
    if (!isset($extensions[$extension])) {
        return;
    }
    $path = $uploadsRoot . '/' . $relativePath;
    if (is_file($path)) {
        fwrite($output, $path . "\n");
        $written++;
    }
}

$ids = array_keys($attachmentIds);
foreach (array_chunk($ids, 1000) as $chunkIndex => $chunk) {
    $idList = implode(',', array_map('intval', $chunk));
    $sql = "SELECT p.ID, af.meta_value attached_file, am.meta_value attachment_metadata
        FROM {$posts} p
        LEFT JOIN {$postmeta} af ON af.post_id=p.ID AND af.meta_key='_wp_attached_file'
        LEFT JOIN {$postmeta} am ON am.post_id=p.ID AND am.meta_key='_wp_attachment_metadata'
        WHERE p.ID IN ({$idList}) AND p.post_type='attachment'";
    foreach (streamRows($connection, $sql) as $row) {
        $attachedFile = (string) ($row['attached_file'] ?? '');
        writeImagePath($output, $uploadsRoot, $attachedFile, $extensions, $written);

        $metadata = @unserialize((string) ($row['attachment_metadata'] ?? ''), ['allowed_classes' => false]);
        if (!is_array($metadata)) {
            continue;
        }
        $metadataFile = (string) ($metadata['file'] ?? $attachedFile);
        $directory = dirname($metadataFile);
        $directory = $directory === '.' ? '' : $directory . '/';
        foreach (($metadata['sizes'] ?? []) as $size) {
            if (is_array($size) && isset($size['file'])) {
                writeImagePath($output, $uploadsRoot, $directory . (string) $size['file'], $extensions, $written);
            }
        }
        if (isset($metadata['original_image'])) {
            writeImagePath($output, $uploadsRoot, $directory . (string) $metadata['original_image'], $extensions, $written);
        }
    }
    if (($chunkIndex + 1) % 100 === 0) {
        fwrite(STDERR, json_encode(['attachments_processed' => min(($chunkIndex + 1) * 1000, count($ids)), 'paths_written' => $written]) . "\n");
    }
}

fclose($output);
fwrite(STDOUT, json_encode(['attachment_ids' => count($ids), 'paths_written' => $written, 'output' => $outputList]) . "\n");

