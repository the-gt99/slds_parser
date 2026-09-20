<?php
// Enumerate images belonging to public non-product content and public taxonomy metadata.
define('SHORTINIT', true);
require '/var/www/u0347517/data/www/slamdunk.shop/wp-load.php';
$root = '/var/www/u0347517/data/www/slamdunk.shop/wp-content/uploads/';
$found = [];
$ids = [];
function media_path($relative, $category) {
    global $root, $found;
    $relative = rawurldecode(ltrim($relative, '/'));
    if (strpos($relative, '..') !== false || preg_match('/[\r\n\x00]/', $relative)) { return; }
    if (!preg_match('/\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i', $relative)) { return; }
    if (is_file($root.$relative) && !isset($found[$root.$relative])) { $found[$root.$relative] = $category; }
}
function media_text($text, $category) {
    $text = html_entity_decode(str_replace('\\/', '/', (string)$text), ENT_QUOTES, 'UTF-8');
    preg_match_all('~/wp-content/uploads/([^\s"\'<>?\#)]+)~', $text, $matches);
    foreach ($matches[1] as $relative) { media_path($relative, $category); }
}
foreach ($wpdb->get_results("SELECT tm.meta_key,tm.meta_value,tt.taxonomy FROM {$wpdb->termmeta} tm JOIN {$wpdb->term_taxonomy} tt ON tt.term_id=tm.term_id", ARRAY_A) as $row) {
    $category = $row['taxonomy']==='pa_brand' ? 'brands' : 'categories';
    media_text($row['meta_value'], $category);
    if (preg_match('/thumbnail|image|logo/', $row['meta_key']) && ctype_digit((string)$row['meta_value'])) {
        $ids[(int)$row['meta_value']] = $category;
    }
}
foreach ($wpdb->get_results("SELECT ID,post_type,post_content FROM {$wpdb->posts} WHERE post_status='publish' AND post_type NOT IN ('product','product_variation','attachment','revision')", ARRAY_A) as $row) {
    $category = stripos($row['post_type'], 'banner')!==false ? 'banners':'content';
    media_text($row['post_content'], $category);
    foreach ($wpdb->get_results($wpdb->prepare("SELECT meta_key,meta_value FROM {$wpdb->postmeta} WHERE post_id=%d",$row['ID']), ARRAY_A) as $meta) {
        media_text($meta['meta_value'], $category);
        if ($meta['meta_key']==='_thumbnail_id') { $ids[(int)$meta['meta_value']]=$category; }
    }
}
foreach ($wpdb->get_results("SELECT a.ID FROM {$wpdb->posts} a JOIN {$wpdb->posts} p ON p.ID=a.post_parent WHERE a.post_type='attachment' AND p.post_status='publish' AND p.post_type IN ('page','post')",ARRAY_A) as $row) { $ids[(int)$row['ID']]='content'; }
foreach ($wpdb->get_results("SELECT option_value FROM {$wpdb->options} WHERE option_name LIKE 'theme_mods_%' OR option_name LIKE 'widget_%' OR option_name LIKE '%banner%' OR option_name='site_icon'",ARRAY_A) as $row) {
    media_text($row['option_value'],'banners');
}
foreach ($ids as $id=>$category) {
    $meta = $wpdb->get_results($wpdb->prepare("SELECT meta_key,meta_value FROM {$wpdb->postmeta} WHERE post_id=%d AND meta_key IN ('_wp_attached_file','_wp_attachment_metadata')",$id),OBJECT_K);
    $relative = (string)($meta['_wp_attached_file']->meta_value ?? '');
    media_path($relative,$category);
    $data = @unserialize((string)($meta['_wp_attachment_metadata']->meta_value ?? ''),['allowed_classes'=>false]);
    if (is_array($data)) {
        $dir = dirname($data['file']??$relative);
        $dir = $dir==='.'?'':$dir.'/';
        foreach (($data['sizes']??[]) as $size) { if(isset($size['file'])) { media_path($dir.$size['file'],$category); } }
        if(isset($data['original_image'])) { media_path($dir.$data['original_image'],$category); }
    }
}
// Literal uploads URLs in public theme templates and previously captured storefront HTML.
foreach (['/var/www/u0347517/data/www/slamdunk.shop/wp-content/themes/slds','/var/www/u0347517/data/media-migration/cdn-smoke-20260911'] as $folder) {
    $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($folder, FilesystemIterator::SKIP_DOTS));
    foreach ($files as $file) {
        if ($file->isFile() && in_array(strtolower($file->getExtension()),['php','css','html','js'],true)) {
            media_text(file_get_contents($file->getPathname()), 'content');
        }
    }
}
file_put_contents($argv[1],json_encode($found,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES));
echo json_encode(['public_paths'=>count($found),'categories'=>array_count_values($found)]),PHP_EOL;
