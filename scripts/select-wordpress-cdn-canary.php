<?php

declare(strict_types=1);

if ($argc < 2 || $argc > 3) {
    fwrite(STDERR, "Usage: php select-wordpress-cdn-canary.php <wordpress-root> [offset]\n");
    exit(2);
}

$wordpressRoot = rtrim($argv[1], '/');
$offset = isset($argv[2]) ? max(0, (int) $argv[2]) : 0;
define('SHORTINIT', true);
require $wordpressRoot . '/wp-load.php';

global $wpdb;
if (!isset($wpdb)) {
    throw new RuntimeException('WordPress database connection is unavailable');
}

$products = $wpdb->get_results(
    "SELECT ID, post_name FROM {$wpdb->posts}
     WHERE post_type='product' AND post_status='publish'
     ORDER BY ID DESC LIMIT 200 OFFSET {$offset}",
    ARRAY_A
);

$result = [];
foreach ($products as $product) {
    $productId = (int) $product['ID'];
    $rows = $wpdb->get_results(
        $wpdb->prepare(
            "SELECT meta_key, meta_value FROM {$wpdb->postmeta}
             WHERE post_id=%d AND meta_key IN ('_thumbnail_id','_product_image_gallery')",
            $productId
        ),
        ARRAY_A
    );
    $attachmentIds = [];
    foreach ($rows as $row) {
        $values = $row['meta_key'] === '_product_image_gallery'
            ? explode(',', (string) $row['meta_value'])
            : [(string) $row['meta_value']];
        foreach ($values as $value) {
            $attachmentId = filter_var(trim($value), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
            if ($attachmentId !== false) {
                $attachmentIds[(int) $attachmentId] = true;
            }
        }
    }
    if ($attachmentIds === []) {
        continue;
    }

    $attachments = [];
    foreach (array_keys($attachmentIds) as $attachmentId) {
        $metaRows = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT meta_key, meta_value FROM {$wpdb->postmeta}
                 WHERE post_id=%d AND meta_key IN ('_wp_attached_file','_wp_attachment_metadata')",
                $attachmentId
            ),
            OBJECT_K
        );
        $attachedFile = (string) ($metaRows['_wp_attached_file']->meta_value ?? '');
        if ($attachedFile === '') {
            continue;
        }
        $paths = [$attachedFile];
        $metadata = @unserialize((string) ($metaRows['_wp_attachment_metadata']->meta_value ?? ''), ['allowed_classes' => false]);
        if (is_array($metadata)) {
            $metadataFile = (string) ($metadata['file'] ?? $attachedFile);
            $directory = dirname($metadataFile);
            $directory = $directory === '.' ? '' : $directory . '/';
            foreach (($metadata['sizes'] ?? []) as $size) {
                if (is_array($size) && isset($size['file'])) {
                    $paths[] = $directory . (string) $size['file'];
                }
            }
            if (isset($metadata['original_image'])) {
                $paths[] = $directory . (string) $metadata['original_image'];
            }
        }
        $attachments[] = ['id' => $attachmentId, 'paths' => array_values(array_unique($paths))];
    }
    if ($attachments !== []) {
        $result[] = [
            'product_id' => $productId,
            'slug' => (string) $product['post_name'],
            'attachments' => $attachments,
        ];
    }
}

echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
