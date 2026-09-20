<?php

function slds_cdn_canary_rewrite_standalone_url($url)
{
    if (!is_string($url) || $url === '') {
        return $url;
    }

    static $mapping = null;
    if ($mapping === null) {
        $configPath = $_SERVER['DOCUMENT_ROOT'] . '/wp-content/mu-plugins/slds-cdn-canary-map.inc';
        $config = is_file($configPath) ? require $configPath : [];
        $mapping = is_array($config['mapping'] ?? null) ? $config['mapping'] : [];
    }

    $marker = '/wp-content/uploads/';
    $position = strpos($url, $marker);
    if ($position === false) {
        return $url;
    }

    $relativePath = rawurldecode(ltrim(substr($url, $position + strlen($marker)), '/'));
    $objectKey = $mapping[$relativePath] ?? null;
    if (!is_string($objectKey) || $objectKey === '') {
        return $url;
    }

    return 'https://cdn.slamdunk.shop/' . ltrim($objectKey, '/');
}

function slds_cdn_canary_rewrite_standalone_output($html)
{
    if (!is_string($html) || $html === '') {
        return $html;
    }

    return preg_replace_callback(
        '~https?://[^\\s,\"\']+~',
        static function (array $matches): string {
            return slds_cdn_canary_rewrite_standalone_url($matches[0]);
        },
        $html
    );
}

function slds_cdn_canary_start_standalone_output_rewrite(): void
{
    static $started = false;
    if (!$started) {
        ob_start('slds_cdn_canary_rewrite_standalone_output');
        $started = true;
    }
}
