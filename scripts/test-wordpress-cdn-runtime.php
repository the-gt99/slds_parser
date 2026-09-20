<?php
require $argv[1];
$config = json_decode(file_get_contents($argv[2]), true);
$checks = 0;
function check_cdn($actual, $expected, $label) {
    global $checks;
    if ($actual !== $expected) { throw new RuntimeException('Failed: ' . $label); }
    $checks++;
}
foreach ($config['mapping'] as $relative => $key) {
    $url = 'https://slamdunk.shop/wp-content/uploads/' . $relative;
    $expected = 'https://cdn.slamdunk.shop/' . $key;
    check_cdn(slds_media_cdn_url($url), $expected, 'verified URL');
    check_cdn(slds_media_cdn_url($url . '?v=123'), $expected, 'query');
    check_cdn(slds_media_cdn_url(str_replace('slamdunk.shop', 'example.org', $url)), str_replace('slamdunk.shop', 'example.org', $url), 'foreign host');
    $alt = htmlspecialchars(pathinfo(basename($relative), PATHINFO_FILENAME), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    check_cdn(slds_media_cdn_text('<img src="'.$url.'">'), '<img alt="'.$alt.'" src="'.$expected.'">', 'HTML');
    check_cdn(slds_media_cdn_text('<img alt="old" data-src="'.$url.'">'), '<img alt="'.$alt.'" data-src="'.$expected.'">', 'lazy HTML');
    $raw = '<script>const x = \'<img src="'.$url.'">\';</script><!-- <img src="'.$url.'"> -->';
    check_cdn(slds_media_product_image_alts($raw), $raw, 'raw text');
    check_cdn(slds_media_cdn_text(json_encode(['image'=>$url])), json_encode(['image'=>$expected]), 'JSON');
}
$missing = 'https://slamdunk.shop/wp-content/uploads/cdn-test-unmapped.webp';
$largeScript = '<script>' . str_repeat('a', 2500000) . '</script>';
check_cdn(slds_media_product_image_alts($largeScript), $largeScript, 'large catalog payload');
check_cdn(slds_media_filename_alt('https://slamdunk.shop/wp-content/uploads/2020/Test-Name.webp?v=1'), 'Test-Name', 'filename without query and extension');
check_cdn(slds_media_cdn_url($missing), $missing, 'unmapped');
check_cdn(slds_media_cdn_url(null), null, 'null');
echo json_encode(['checks'=>$checks, 'peak_memory'=>memory_get_peak_usage(true)]), PHP_EOL;
