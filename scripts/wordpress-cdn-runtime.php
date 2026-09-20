<?php
// Shared URL resolver for the standalone storefront and WordPress.
function slds_media_cdn_epoch(): int
{
    static $epoch = null;
    if ($epoch === null) { $epoch = (int) filemtime('/var/www/u0347517/data/media-cdn/products.sqlite3'); }
    return $epoch;
}

function slds_media_cdn_url($url)
{
    if (!is_string($url) || strpos($url, '/wp-content/uploads/') === false) {
        return $url;
    }
    $parts = parse_url($url);
    if (!$parts || (isset($parts['host']) && !in_array(strtolower($parts['host']), ['slamdunk.shop', 'www.slamdunk.shop'], true))) {
        return $url;
    }
    $prefix = '/wp-content/uploads/';
    $path = $parts['path'] ?? '';
    if (strpos($path, $prefix) !== 0) {
        return $url;
    }
    $relative = rawurldecode(substr($path, strlen($prefix)));
    if (strpos($relative, '..') !== false || strpos($relative, "\0") !== false) {
        return $url;
    }
    static $statement = null;
    static $memo = [];
    if (array_key_exists($relative, $memo)) {
        return $memo[$relative] ?? $url;
    }
    if ($statement === null) {
        $database = new SQLite3('/var/www/u0347517/data/media-cdn/products.sqlite3', SQLITE3_OPEN_READONLY);
        $database->exec('PRAGMA cache_size=-2048');
        $statement = $database->prepare('SELECT object_key,size_bytes,mtime FROM images WHERE path=:path');
    }
    $statement->reset();
    $statement->bindValue(':path', $relative, SQLITE3_TEXT);
    $result = $statement->execute();
    $row = $result->fetchArray(SQLITE3_ASSOC);
    $result->finalize();
    $resolved = null;
    if ($row) {
        $local = '/var/www/u0347517/data/www/slamdunk.shop/wp-content/uploads/' . $relative;
        $stat = @stat($local);
        // Files changed since the verified upload must keep their current local URL.
        if ($stat && (int) $stat['size'] === (int) $row['size_bytes'] && (int) $stat['mtime'] === (int) $row['mtime']) {
            $resolved = 'https://cdn.slamdunk.shop/' . $row['object_key'];
        }
    }
    if (count($memo) >= 2048) {
        $memo = [];
    }
    $memo[$relative] = $resolved;
    return $resolved ?? $url;
}

function slds_media_filename_alt($url): string
{
    if (!is_string($url)) { return ''; }
    $parts = parse_url(html_entity_decode($url, ENT_QUOTES, 'UTF-8'));
    if (!$parts || (isset($parts['host']) && !in_array(strtolower($parts['host']), ['slamdunk.shop', 'www.slamdunk.shop'], true))) { return ''; }
    $path = $parts['path'] ?? '';
    if (strpos($path, '/wp-content/uploads/') !== 0) { return ''; }
    $name = rawurldecode(basename($path));
    if (!preg_match('/\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i', $name)) { return ''; }
    return pathinfo($name, PATHINFO_FILENAME);
}

function slds_media_product_image_alts(string $html): string
{
    // Skip comments and raw-text elements so embedded JSON/JavaScript stays intact.
    $pattern = '~<!--[^-]*+(?:-(?!->)[^-]*+)*-->|<(script|style|textarea)\b[^>]*>[^<]*+(?:<(?!/\1\s*>)[^<]*+)*</\1\s*>|<img\b(?:[^>"\']++|"[^"]*"|\'[^\']*\')*>~i';
    return preg_replace_callback($pattern, static function ($match) {
        $tag = $match[0];
        if (!preg_match('~^<img\b~i', $tag)) { return $tag; }
        preg_match_all('~\s([\w:-]+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))~', $tag, $attrs, PREG_SET_ORDER);
        $values = [];
        foreach ($attrs as $attr) {
            $values[strtolower($attr[1])] = html_entity_decode($attr[2] !== '' ? $attr[2] : (($attr[3] ?? '') !== '' ? $attr[3] : ($attr[4] ?? '')), ENT_QUOTES, 'UTF-8');
        }
        $alt = '';
        foreach (['data-src', 'src'] as $key) {
            $url = $values[$key] ?? '';
            $name = slds_media_filename_alt($url);
            if ($name !== '' && strpos(slds_media_cdn_url($url), 'https://cdn.slamdunk.shop/products/') === 0) { $alt = $name; break; }
        }
        if ($alt === '') { return $tag; }
        foreach (array_reverse($attrs) as $attr) {
            if (strtolower($attr[1]) === 'alt') {
                $offset = strpos($tag, $attr[0]);
                $tag = substr_replace($tag, '', $offset, strlen($attr[0]));
            }
        }
        return preg_replace_callback('~^<img\b~i', static function ($start) use ($alt) {
            return $start[0] . ' alt="' . htmlspecialchars($alt, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"';
        }, $tag, 1);
    }, $html);
}

function slds_media_cdn_text($text)
{
    if (!is_string($text) || strpos($text, 'uploads') === false) {
        return $text;
    }
    $text = slds_media_product_image_alts($text);
    // Both HTML URLs and JSON-escaped URLs are rewritten without changing surrounding data.
    $pattern = '~(?:https?:)?//(?:www\.)?slamdunk\.shop/wp-content/uploads/[^\s"\'<>),]+~i';
    $text = preg_replace_callback($pattern, static function ($match) {
        return slds_media_cdn_url($match[0]);
    }, $text);
    $escapedPrefix = preg_quote('https:\/\/slamdunk.shop\/wp-content\/uploads\/', '~');
    return preg_replace_callback('~' . $escapedPrefix . '[^\s"\'<>),]+~i', static function ($match) {
        $url = str_replace('\\/', '/', $match[0]);
        return str_replace('/', '\\/', slds_media_cdn_url($url));
    }, $text);
}

function slds_media_cdn_start(): void
{
    static $started = false;
    if (!$started) {
        ob_start('slds_media_cdn_text');
        $started = true;
    }
}

// Compatibility for the already deployed gallery integration.
function slds_cdn_canary_rewrite_standalone_url($url) { return slds_media_cdn_url($url); }
function slds_cdn_canary_rewrite_standalone_output($text) { return slds_media_cdn_text($text); }
function slds_cdn_canary_start_standalone_output_rewrite(): void { slds_media_cdn_start(); }
