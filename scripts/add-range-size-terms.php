<?php
declare(strict_types=1);
require getcwd() . '/wp-load.php';
global $wpdb;
$apply = in_array('--apply', $argv, true);
$items = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
$wpdb->query($apply ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY');
$result = [];
try {
 foreach ($items as $item) {
  if ($item['taxonomy'] !== 'pa_razmer' || !in_array($item['audience'],['men','women'],true)
    || !preg_match('/^\\d+-\\d+\\.5$/D',$item['sourceValue'])) throw new RuntimeException('Unexpected size');
  $term=get_term_by('slug',$item['slug'],$item['taxonomy']);
  if ($term && $term->name !== $item['name']) throw new RuntimeException('Existing slug has a different name');
  $id=$term ? $term->term_id : null;
  if (!$term && $apply) {
   $created=wp_insert_term($item['name'],$item['taxonomy'],['slug'=>$item['slug']]);
   if (is_wp_error($created)) throw new RuntimeException($created->get_error_message());
   $id=$created['term_id'];
  }
  $result[]=$item+['termId'=>$id,'created'=>!$term && $apply];
 }
 if ($apply) {
  $backup='/tmp/range-size-terms-'.gmdate('Ymd-His').'.json';
  if(file_put_contents($backup,json_encode($result,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),LOCK_EX)===false) throw new RuntimeException('Audit write failed');
  if($wpdb->query('COMMIT')===false) throw new RuntimeException('Commit failed');
 } else $wpdb->query('ROLLBACK');
 echo json_encode(['apply'=>$apply,'items'=>$result],JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
} catch(Throwable $e) {$wpdb->query('ROLLBACK');throw $e;}
