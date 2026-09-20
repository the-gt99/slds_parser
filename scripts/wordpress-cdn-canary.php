<?php
/**
 * Plugin Name: SLDS CDN canary
 * Description: Rewrites only pre-verified canary product image paths to the CDN.
 */

defined('ABSPATH') || exit;

function slds_cdn_canary_config(): array
{
    static $config = null;

    if ($config === null) {
        $path = __DIR__ . '/slds-cdn-canary-map.inc';
        $loaded = is_file($path) ? require $path : [];
        $config = is_array($loaded) ? $loaded : [];
    }

    return $config;
}

function slds_cdn_canary_rewrite_url($url)
{
    if (!is_string($url) || $url === '') {
        return $url;
    }

    $path = wp_parse_url($url, PHP_URL_PATH);
    $marker = '/wp-content/uploads/';
    if (!is_string($path) || ($position = strpos($path, $marker)) === false) {
        return $url;
    }

    $relativePath = rawurldecode(ltrim(substr($path, $position + strlen($marker)), '/'));
    $mapping = slds_cdn_canary_config()['mapping'] ?? [];
    $objectKey = is_array($mapping) ? ($mapping[$relativePath] ?? null) : null;
    if (!is_string($objectKey) || $objectKey === '') {
        return $url;
    }

    return 'https://cdn.slamdunk.shop/' . ltrim($objectKey, '/');
}

function slds_cdn_canary_rewrite_urls_in_text($value)
{
    if (!is_string($value) || $value === '') {
        return $value;
    }

    return preg_replace_callback(
        '~https?://[^\\s,\"\']+~',
        static fn(array $matches): string => slds_cdn_canary_rewrite_url($matches[0]),
        $value
    );
}

add_filter('wp_get_attachment_url', 'slds_cdn_canary_rewrite_url', 100);

add_filter('wp_headers', static function (array $headers): array {
    $headers['X-SLDS-CDN-Canary'] = 'product-3782916';
    return $headers;
});

add_action('template_redirect', static function (): void {
    ob_start('slds_cdn_canary_rewrite_urls_in_text');
}, 0);

add_filter('wp_get_attachment_image_src', static function ($image) {
    if (is_array($image) && isset($image[0])) {
        $image[0] = slds_cdn_canary_rewrite_url($image[0]);
    }

    return $image;
}, 100);

add_filter('wp_get_attachment_image_attributes', static function ($attributes) {
    if (!is_array($attributes)) {
        return $attributes;
    }

    foreach ($attributes as $name => $value) {
        if (is_string($value)) {
            $attributes[$name] = slds_cdn_canary_rewrite_urls_in_text($value);
        }
    }

    return $attributes;
}, 100);

add_filter('wp_calculate_image_srcset', static function ($sources) {
    if (!is_array($sources)) {
        return $sources;
    }

    foreach ($sources as $width => $source) {
        if (isset($source['url'])) {
            $sources[$width]['url'] = slds_cdn_canary_rewrite_url($source['url']);
        }
    }

    return $sources;
}, 100);
