<?php
declare(strict_types=1);
// Run from the WordPress root. Default: preview only.
// Source: https://www.nordstrom.com/sizeguides/1475_sizeguide.pdf
require getcwd() . '/wp-load.php';
global $wpdb;
$apply = in_array('--apply', $argv, true);
$termId = 4284;
$key = 'таблица_размеров_0_clothing_type_0_table';
$categoryKey = 'таблица_размеров_0_clothing_type_0_категория';
$sourceRows = [
 ['6','39','5'], ['6.5','39.5','5.5'], ['7','40','6'], ['7.5','40.5','6.5'],
 ['8','41','7'], ['8.5','41.5','7.5'], ['9','42','8'], ['9.5','42.5','8.5'],
 ['10','43','9'], ['10.5','43.5','9.5'], ['11','44','10'], ['11.5','44.5','10.5'],
 ['12','45','11'], ['12.5','45.5','11.5'], ['13','46','12'],
];
$wpdb->query($apply ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY');
try {
 $term = get_term($termId, 'pa_brand');
 if (!$term || is_wp_error($term) || $term->name !== 'Prada') throw new RuntimeException('Brand identity changed');
 $categories = array_map('intval', (array)get_term_meta($termId, $categoryKey, true));
 if ($categories !== [25680]) throw new RuntimeException('Expected the reviewed men footwear category');
 $rows = $wpdb->get_results($wpdb->prepare("SELECT meta_id,meta_value FROM {$wpdb->termmeta} WHERE term_id=%d AND meta_key=%s" . ($apply ? ' FOR UPDATE' : ''), $termId, $key), ARRAY_A);
 if (count($rows) !== 1) throw new RuntimeException('Expected exactly one size table');
 $before = maybe_unserialize($rows[0]['meta_value']);
 $headers = array_column($before['h'], 'c');
 $already = $headers === ['US','EU','CM','RU','UK'];
 if (!$already && $headers !== ['US','EU','CM','RU']) throw new RuntimeException('Size table headers changed');
 $after = $before;
 $lookup = [];
 foreach ($sourceRows as [$us,$eu,$uk]) $lookup[$us . ':' . $eu] = $uk;
 $matched = 0;
 $diff = [];
 foreach ($after['b'] as &$row) {
   $uk = $lookup[$row[0]['c'] . ':' . $row[1]['c']] ?? '';
   if ($uk !== '') { $matched++; $diff[] = ['US'=>$row[0]['c'], 'EU'=>$row[1]['c'], 'UK'=>$uk]; }
   if ($already && ($row[4]['c'] ?? '') !== $uk) throw new RuntimeException('Existing UK column differs');
   if (!$already) $row[] = ['c'=>$uk];
 }
 unset($row);
 if ($matched !== count($sourceRows)) throw new RuntimeException('The reviewed EU/US rows no longer match');
 if (!$already) { $after['h'][] = ['c'=>'UK']; $after['c'][] = ['p'=>'']; }
 echo json_encode(['apply'=>$apply,'alreadyApplied'=>$already,'termId'=>$termId,'key'=>$key,'addedRows'=>$diff,'unmappedRows'=>count($after['b'])-$matched], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), "\n";
 if ($apply && !$already) {
   $backup = '/tmp/prada-size-table-before-20260916.json';
   $file = fopen($backup, 'x');
   if (!$file) throw new RuntimeException('Backup path already exists or cannot be created');
   fwrite($file, json_encode(['termId'=>$termId,'key'=>$key,'before'=>$before], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
   fclose($file);
   if (!update_term_meta($termId, $key, $after)) throw new RuntimeException('Size table update failed');
 }
 $wpdb->query($apply ? 'COMMIT' : 'ROLLBACK');
 wp_cache_delete($termId, 'term_meta');
} catch (Throwable $e) {
 $wpdb->query('ROLLBACK');
 wp_cache_delete($termId, 'term_meta');
 fwrite(STDERR, $e->getMessage() . "\n"); exit(1);
}
