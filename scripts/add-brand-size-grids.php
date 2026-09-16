<?php
declare(strict_types=1);
require getcwd() . '/wp-load.php';
global $wpdb;
$apply=in_array('--apply',$argv,true);
$brands=json_decode(file_get_contents($argv[1]),true,512,JSON_THROW_ON_ERROR);
$wpdb->query($apply?'START TRANSACTION':'START TRANSACTION READ ONLY');
$prepared=[];
try {
 foreach($brands as $brand) {
  $term=get_term($brand['termId'],'pa_brand');
  if(!$term||is_wp_error($term)||$term->name!==$brand['brand']) throw new RuntimeException('Brand mismatch');
  if($apply) $wpdb->get_var($wpdb->prepare("SELECT term_id FROM {$wpdb->terms} WHERE term_id=%d FOR UPDATE",$brand['termId']));
  $rows=$wpdb->get_results($wpdb->prepare("SELECT meta_key,meta_value FROM {$wpdb->termmeta} WHERE term_id=%d",$brand['termId']),ARRAY_A);
  $current=[];
  foreach($rows as $row) if(str_contains($row['meta_key'],'таблица_размеров')) {
   if(array_key_exists($row['meta_key'],$current)) throw new RuntimeException('Duplicate metadata');
   $current[$row['meta_key']]=maybe_unserialize($row['meta_value']);
  }
  $expected=$brand['metadata'];ksort($current);ksort($expected);
  if($current===$expected) continue;
  if($current) throw new RuntimeException('Brand already has size metadata: '.$brand['brand']);
  $prepared[]=$brand;
 }
 echo json_encode(['apply'=>$apply,'brands'=>array_map(static fn($b)=>['brand'=>$b['brand'],'metadataRows'=>count($b['metadata']),'sources'=>$b['sources']],$prepared)],JSON_UNESCAPED_UNICODE),"\n";
 if($apply&&$prepared) {
  $backup='/tmp/new-brand-size-grids-'.gmdate('Ymd-His').'.json';
  if(file_put_contents($backup,json_encode(['before'=>[],'inserted'=>$prepared],JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),LOCK_EX)===false) throw new RuntimeException('Audit failed');
  foreach($prepared as $brand) foreach($brand['metadata'] as $key=>$value) {
   if($wpdb->insert($wpdb->termmeta,['term_id'=>$brand['termId'],'meta_key'=>$key,'meta_value'=>maybe_serialize($value)])!==1) throw new RuntimeException('Insert failed');
  }
  if($wpdb->query('COMMIT')===false) throw new RuntimeException('Commit failed');
  foreach($prepared as $brand) wp_cache_delete($brand['termId'],'term_meta');
  echo json_encode(['audit'=>$backup,'applied'=>count($prepared)]),"\n";
 } else $wpdb->query('ROLLBACK');
} catch(Throwable $e){$wpdb->query('ROLLBACK');throw $e;}

