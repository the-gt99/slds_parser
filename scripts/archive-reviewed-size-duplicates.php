<?php
require '/var/www/u0347517/data/www/slamdunk.shop/wp-load.php';
require_once get_template_directory().'/inc/catalog/admin/product-update/index.php';
global $wpdb;
$plan=json_decode(file_get_contents('/tmp/size-identical-duplicates-plan-20260917.json'),true,512,JSON_THROW_ON_ERROR);
function duplicate_state($id){
 $v=wc_get_product($id);if(!$v)throw new RuntimeException('Variation missing');
 $a=$v->get_attributes();if(!$a){$raw=get_post_meta($id,'attribute_pa_razmer',true);if($raw!=='')$a=['pa_razmer'=>$raw];}ksort($a);
 return ['id'=>$id,'attributes'=>$a,'price'=>$v->get_regular_price(),'sale'=>$v->get_sale_price(),'quantity'=>$v->get_stock_quantity(),'manage'=>$v->get_manage_stock(),'stock'=>$v->get_stock_status(),'sku'=>$v->get_sku(),'status'=>$v->get_status(),'sourceKey'=>get_post_meta($id,'_slds_source_variant_key',true)];
}
foreach($plan as $r){
 $id=(int)$r['productId'];$lock='slds-variation-patch:'.$id;
 if((int)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)',$lock))!==1){echo json_encode(['productId'=>$id,'status'=>'busy'])."\n";continue;}
 try{
  foreach($r['duplicates'] as $group)foreach($group as $expected){$actual=duplicate_state($expected['id']);if(wp_json_encode($actual)!==wp_json_encode($expected))throw new RuntimeException('Variation changed after review');}
  $ids=implode(',',array_map('intval',$r['archive']));
  $orderCount=(int)$wpdb->get_var("SELECT count(*) FROM {$wpdb->prefix}woocommerce_order_itemmeta WHERE meta_key='_variation_id' AND meta_value IN ($ids)");
  if($orderCount)throw new RuntimeException('Duplicate is referenced by an order');
  $backup=['plan'=>$r,'parent'=>get_post($id,ARRAY_A),'parentMeta'=>get_post_meta($id),'variations'=>[],'indexes'=>[]];
  foreach($r['archive'] as $vid)$backup['variations'][$vid]=['post'=>get_post($vid,ARRAY_A),'meta'=>get_post_meta($vid)];
  foreach(['filter_variations','filter_variations_prices'] as $table)$backup['indexes'][$table]=$wpdb->get_results("SELECT * FROM $table WHERE variation_id IN ($ids)",ARRAY_A);
  $lookup=$wpdb->prefix.'wc_product_attributes_lookup';$backup['indexes'][$lookup]=$wpdb->get_results("SELECT * FROM $lookup WHERE product_or_parent_id=$id AND product_id IN ($ids)",ARRAY_A);
  $file='/tmp/size-duplicates-before-20260917-'.$id.'.json';$f=fopen($file,'x');if(!$f)throw new RuntimeException('Backup exists');chmod($file,0600);fwrite($f,wp_json_encode($backup,JSON_UNESCAPED_UNICODE));fclose($f);
  $wpdb->query('START TRANSACTION');
  try{
   $n=$wpdb->query("UPDATE {$wpdb->posts} SET post_status='draft' WHERE post_parent=$id AND post_type='product_variation' AND post_status='publish' AND ID IN ($ids)");
   if($n!==count($r['archive']))throw new RuntimeException('Unexpected number of variations');
   foreach(['filter_variations','filter_variations_prices'] as $table)if($wpdb->query("DELETE FROM $table WHERE variation_id IN ($ids)")===false)throw new RuntimeException('Index deletion failed');
   if($wpdb->query("DELETE FROM $lookup WHERE product_or_parent_id=$id AND product_id IN ($ids)")===false)throw new RuntimeException('Woo index deletion failed');
   $wpdb->query('COMMIT');
  }catch(Throwable $e){$wpdb->query('ROLLBACK');throw $e;}
  foreach($r['archive'] as $vid)clean_post_cache($vid);
  delete_transient('wc_product_children_'.$id);delete_transient('wc_var_prices_'.$id);WC_Cache_Helper::invalidate_cache_group('product_'.$id);clean_post_cache($id);
  slds_catalog_sync_products_summary([$id]);
  if(wp_json_encode(get_post($id,ARRAY_A))!==wp_json_encode($backup['parent'])||wp_json_encode(get_post_meta($id))!==wp_json_encode($backup['parentMeta']))throw new RuntimeException('Parent changed');
  echo json_encode(['productId'=>$id,'sourceProductId'=>$r['sourceProductId'],'status'=>'archived','count'=>count($r['archive']),'ids'=>$r['archive']])."\n";
 }catch(Throwable $e){echo json_encode(['productId'=>$id,'status'=>'blocked','reason'=>$e->getMessage()])."\n";}
 finally{$wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$lock));}
}
