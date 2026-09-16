<?php
declare(strict_types=1);
// Preview by default. Apply only the exact reviewed before/after values.
require getcwd() . '/wp-load.php';
global $wpdb;
$apply = in_array('--apply', $argv, true);
$manifest = $argv[1] ?? '';
$changes = json_decode(file_get_contents($manifest), true, 512, JSON_THROW_ON_ERROR);
$wpdb->query($apply ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY');
$prepared = [];
try {
 foreach ($changes as $change) {
  $term = get_term($change['termId'], 'pa_brand');
  if (!$term || is_wp_error($term) || $term->name !== $change['brand']) throw new RuntimeException('Brand changed');
  foreach ($change['guards'] ?? [] as $key => $expected) {
   if (get_term_meta($change['termId'], $key, true) !== $expected) throw new RuntimeException('Section changed');
  }
  $rows = $wpdb->get_results($wpdb->prepare(
   "SELECT meta_id,meta_value FROM {$wpdb->termmeta} WHERE term_id=%d AND meta_key=%s" . ($apply ? " FOR UPDATE" : ""),
   $change['termId'], $change['key']), ARRAY_A);
  if (count($rows) !== 1) throw new RuntimeException('Expected one metadata row');
  $current = maybe_unserialize($rows[0]['meta_value']);
  if ($current === $change['after']) continue;
  if ($current !== $change['before']) throw new RuntimeException('Metadata changed: ' . $change['brand']);
  $prepared[] = ['change'=>$change,'metaId'=>$rows[0]['meta_id'],'rawBefore'=>$rows[0]['meta_value']];
 }
 echo json_encode(['apply'=>$apply,'changes'=>array_map(static fn($p)=>[
  'brand'=>$p['change']['brand'],'key'=>$p['change']['key'],
  'source'=>$p['change']['source'],'filled'=>$p['change']['filled']??null
 ],$prepared)],JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT), "\n";
 if ($apply && $prepared) {
  $backup = '/tmp/size-grid-repairs-backup-' . gmdate('Ymd-His') . '.json';
  $handle = fopen($backup, 'x');
  if (!$handle) throw new RuntimeException('Backup creation failed');
  if (fwrite($handle, json_encode($prepared, JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)) === false) throw new RuntimeException('Backup write failed');
  fclose($handle);
  chmod($backup,0600);
  foreach ($prepared as $p) {
   if ($wpdb->update($wpdb->termmeta,['meta_value'=>maybe_serialize($p['change']['after'])],['meta_id'=>$p['metaId'],'meta_value'=>$p['rawBefore']]) !== 1) throw new RuntimeException('Update failed');
   $actual=maybe_unserialize($wpdb->get_var($wpdb->prepare("SELECT meta_value FROM {$wpdb->termmeta} WHERE meta_id=%d",$p['metaId'])));
   if ($actual !== $p['change']['after']) throw new RuntimeException('Readback failed');
  }
  if ($wpdb->query('COMMIT') === false) throw new RuntimeException('Commit failed');
  foreach($prepared as $p) wp_cache_delete($p['change']['termId'],'term_meta');
  echo json_encode(['backup'=>$backup,'applied'=>count($prepared)],JSON_UNESCAPED_UNICODE), "\n";
 } else $wpdb->query('ROLLBACK');
} catch (Throwable $e) { $wpdb->query('ROLLBACK'); throw $e; }

