<?php
/** Plugin Name: SLDS product CDN */
defined('ABSPATH') || exit;
require_once __DIR__ . '/slds-media-cdn/runtime.php';
// Keep the original base URL while WordPress calculates intermediate image paths.
// Publish CDN URLs only after those paths are complete.
add_filter('wp_get_attachment_image_src', static function ($image) {
    if (is_array($image) && isset($image[0])) { $image[0] = slds_media_cdn_url($image[0]); }
    return $image;
}, 100);
add_filter('wp_get_attachment_image_attributes', static function ($attrs, $attachment) {
    $file = get_post_meta($attachment->ID, '_wp_attached_file', true);
    if (is_string($file) && $file !== '') {
        $local = 'https://slamdunk.shop/wp-content/uploads/' . ltrim($file, '/');
        if (strpos(slds_media_cdn_url($local), 'https://cdn.slamdunk.shop/products/') === 0) {
            $attrs['alt'] = slds_media_filename_alt($local);
        }
    }
    foreach ($attrs as $key => $value) { if (is_string($value)) { $attrs[$key] = slds_media_cdn_text($value); } }
    return $attrs;
}, 100, 2);
add_filter('wp_calculate_image_srcset', static function ($sources) {
    if (is_array($sources)) {
        foreach ($sources as &$source) { $source['url'] = slds_media_cdn_url($source['url']); }
        unset($source);
    }
    return $sources;
}, 100);
add_action('template_redirect', 'slds_media_cdn_start', 0);
// WordPress otherwise appends the old thumbnail filename to the hashed CDN directory.
add_filter('wp_prepare_attachment_for_js', static function ($response, $attachment) {
    if (!is_array($response) || ($response['type'] ?? '') !== 'image') { return $response; }
    $response['url'] = slds_media_cdn_url($response['url'] ?? '');
    foreach (($response['sizes'] ?? []) as $name => $size) {
        $image = wp_get_attachment_image_src($attachment->ID, $name);
        if (is_array($image) && isset($image[0])) {
            $response['sizes'][$name]['url'] = $image[0];
        }
    }
    $file = get_post_meta($attachment->ID, '_wp_attached_file', true);
    if (is_string($file) && $file !== '') {
        $local = 'https://slamdunk.shop/wp-content/uploads/' . ltrim($file, '/');
        if (strpos(slds_media_cdn_url($local), 'https://cdn.slamdunk.shop/products/') === 0) {
            $response['alt'] = slds_media_filename_alt($local);
        }
    }
    return $response;
}, 100, 2);
