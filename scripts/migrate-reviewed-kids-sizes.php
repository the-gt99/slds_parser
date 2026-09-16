<?php
// Исправляет только подтверждённые обозначения детских размеров, сохраняя ID вариаций.
require '/var/www/u0347517/data/www/slamdunk.shop/wp-load.php';
require_once '/var/www/u0347517/data/www/slamdunk.shop/wp-content/themes/slds/inc/catalog/admin/product-update/index.php';
$mode=$argv[1]??'preview';
$manifest=json_decode(file_get_contents($argv[2]),true,512,JSON_THROW_ON_ERROR);
$out=$argv[3];
if(file_exists($out))throw new RuntimeException('Output already exists');
$stream=fopen($out,'x');chmod($out,0600);
function inspect_kids($row) {
 $id=(int)$row['productId'];$p=wc_get_product($id);
 if(!$p||!$p->is_type('variable'))throw new RuntimeException('Not a variable product');
 $external=(string)get_post_meta($id,'_slds_source_external_id',true);
 if($external==='')$external=(string)get_post_meta($id,'goat_id',true);
 if($external!==(string)$row['externalId'])throw new RuntimeException('Source identity mismatch');
 $source=(string)get_post_meta($id,'_slds_source_code',true);
 if($source!==''&&$source!=='goat')throw new RuntimeException('Different source');
 if(strcasecmp(trim($p->get_sku()),trim((string)$row['sku']))!==0)throw new RuntimeException('SKU mismatch');
 $maps=[];foreach($row['mappings'] as $m){
  $from=get_term((int)$m['from'],'pa_razmer');$to=get_term((int)$m['to'],'pa_razmer');
  if(!$from||!$to||is_wp_error($from)||is_wp_error($to))throw new RuntimeException('Missing term');
  if(!preg_match('/Y$/u',$from->name)||!preg_match('/K$/u',$to->name))throw new RuntimeException('Wrong audience labels');
  $maps[$from->slug]=['to'=>$to->slug,'fromId'=>$from->term_id,'toId'=>$to->term_id];
 }
 $changes=[];$seen=[];$saved=[];$vars=[];
 foreach($p->get_children() as $vid){
  $v=wc_get_product($vid);if(!$v)throw new RuntimeException('Missing variation');
  $attrs=$v->get_attributes();$raw=get_post_meta($vid,'attribute_pa_razmer',true);
  if(!isset($attrs['pa_razmer'])&&$raw!=='')$attrs['pa_razmer']=$raw;
  $old=$attrs['pa_razmer']??'';
  if($old==='')throw new RuntimeException('Missing size attribute');
  if(isset($seen[$old]))throw new RuntimeException('Duplicate current size');
  $seen[$old]=$vid;$saved[$vid]=['data'=>$v->get_data(),'sizeMeta'=>$raw];$vars[$vid]=$v;
  if(isset($maps[$old])){$after=$attrs;$after['pa_razmer']=$maps[$old]['to'];$changes[]=['id'=>$vid,'before'=>$attrs,'after'=>$after,'from'=>$old,'to'=>$maps[$old]['to']];}
 }
 foreach($changes as $c)if(isset($seen[$c['to']]))throw new RuntimeException('Destination size already exists');
 $attrs=$p->get_attributes();$size=$attrs['pa_razmer']??null;
 if(!$size||!$size->is_taxonomy()||!$size->get_variation())throw new RuntimeException('Missing parent size attribute');
 $options=array_map('intval',$size->get_options());$newOptions=$options;
 foreach($changes as $c){$m=$maps[$c['from']];$newOptions=array_map(fn($id)=>$id===$m['fromId']?$m['toId']:$id,$newOptions);$newOptions[]=$m['toId'];}
 foreach($maps as $m)if(isset($seen[$m['to']]))$newOptions=array_map(fn($id)=>$id===$m['fromId']?$m['toId']:$id,$newOptions);
 $newOptions=array_values(array_unique($newOptions));
 $defaults=$p->get_default_attributes();$newDefaults=$defaults;
 if(isset($defaults['pa_razmer'],$maps[$defaults['pa_razmer']]))$newDefaults['pa_razmer']=$maps[$defaults['pa_razmer']]['to'];
 $snapshot=['product'=>$p->get_data(),'variations'=>$saved];
 return ['product'=>$p,'vars'=>$vars,'changes'=>$changes,'options'=>$newOptions,'defaults'=>$newDefaults,'snapshot'=>$snapshot,'hash'=>hash('sha256',wp_json_encode($snapshot))];
}
$counts=[];$stop=false;
if(function_exists('pcntl_async_signals')){pcntl_async_signals(true);pcntl_signal(SIGTERM,function()use(&$stop){$stop=true;});}
if($mode==='apply')wp_defer_term_counting(true);
foreach($manifest as $row){
 if($stop)break;
 $lock=null;
 try{
  if($mode==='apply'){global $wpdb;$lock='slds-variation-patch:'.$row['productId'];if((int)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)',$lock))!==1){$lock=null;throw new RuntimeException('Product is busy');}}
  $x=inspect_kids($row);
  if($mode==='preview'){$result=['productId'=>$row['productId'],'sourceProductId'=>$row['sourceProductId'],'status'=>count($x['changes'])?'ready':'unchanged','hash'=>$x['hash'],'changes'=>$x['changes'],'parentOptions'=>$x['options'],'defaults'=>$x['defaults']];}
  elseif($mode==='apply'){
   if(!isset($row['reviewHash'])||!hash_equals($row['reviewHash'],$x['hash']))throw new RuntimeException('Product changed after review');
   if(!$x['changes'])throw new RuntimeException('Nothing to migrate');
   $backup='/tmp/kids-size-backup-20260917-'.$row['productId'].'.json';
   $b=fopen($backup,'x');if(!$b)throw new RuntimeException('Backup already exists');chmod($backup,0600);fwrite($b,wp_json_encode(['manifest'=>$row,'before'=>$x['snapshot'],'changes'=>$x['changes']],JSON_UNESCAPED_UNICODE));fclose($b);
   global $wpdb;/* WooCommerce callbacks can commit internally; restore explicit fields on failure. */
   try {
    foreach($x['changes'] as $c){if(array_keys($c['before'])!==['pa_razmer']||array_keys($c['after'])!==['pa_razmer'])throw new RuntimeException('Additional variation attributes');
     update_post_meta($c['id'],'attribute_pa_razmer',$c['to']);clean_post_cache($c['id']);
     // WooCommerce read synchronizes the title and attribute summary from the saved size.
     $v=new WC_Product_Variation($c['id']);
     $from=get_term_by('slug',$c['from'],'pa_razmer');$to=get_term_by('slug',$c['to'],'pa_razmer');
     $lookup=$wpdb->prefix.'wc_product_attributes_lookup';$wpdb->update($lookup,['term_id'=>(int)$to->term_id],['product_or_parent_id'=>$row['productId'],'product_id'=>$c['id'],'taxonomy'=>'pa_razmer','term_id'=>(int)$from->term_id],['%d'],['%d','%d','%s','%d']);if($wpdb->last_error)throw new RuntimeException('WooCommerce size index update failed');}
    $p=$x['product'];$termResult=wp_set_object_terms($row['productId'],$x['options'],'pa_razmer',false);if(is_wp_error($termResult))throw new RuntimeException($termResult->get_error_message());if($p->get_default_attributes()!==$x['defaults'])update_post_meta($row['productId'],'_default_attributes',$x['defaults']);clean_post_cache($row['productId']);
    foreach($x['changes'] as $c){
     clean_post_cache($c['id']);$v=new WC_Product_Variation($c['id']);$before=$x['snapshot']['variations'][$c['id']]['data'];$after=$v->get_data();
     foreach(['regular_price','sale_price','price','stock_quantity','stock_status','manage_stock','sku','parent_id','status'] as $field)if($before[$field]!==$after[$field])throw new RuntimeException('Unexpected change: '.$field);
     if(get_post_meta($c['id'],'attribute_pa_razmer',true)!==$c['to'])throw new RuntimeException('Size not saved');
    }
    $indexIds=array_column($x['changes'],'id');slds_filter_fill_variation_attribute_single_by_ids('razmer',$indexIds);if($wpdb->last_error)throw new RuntimeException('Size index update failed');
    $afterParent=(new WC_Product_Variable($row['productId']))->get_data();$beforeParent=$x['snapshot']['product'];foreach(['attributes','default_attributes','date_modified'] as $field){unset($afterParent[$field],$beforeParent[$field]);}if(wp_json_encode($beforeParent)!==wp_json_encode($afterParent))throw new RuntimeException('Unexpected parent change');

   }catch(Throwable $e){foreach($x['changes'] as $c){update_post_meta($c['id'],'attribute_pa_razmer',$c['from']);clean_post_cache($c['id']);$v=new WC_Product_Variation($c['id']);$from=get_term_by('slug',$c['from'],'pa_razmer');$to=get_term_by('slug',$c['to'],'pa_razmer');$wpdb->update($wpdb->prefix.'wc_product_attributes_lookup',['term_id'=>(int)$from->term_id],['product_or_parent_id'=>$row['productId'],'product_id'=>$c['id'],'taxonomy'=>'pa_razmer','term_id'=>(int)$to->term_id],['%d'],['%d','%d','%s','%d']);}wp_set_object_terms($row['productId'],array_map('intval',$x['product']->get_attributes()['pa_razmer']->get_options()),'pa_razmer',false);update_post_meta($row['productId'],'_default_attributes',$x['product']->get_default_attributes());clean_post_cache($row['productId']);slds_filter_fill_variation_attribute_single_by_ids('razmer',array_column($x['changes'],'id'));throw $e;}
   delete_transient('wc_var_prices_'.$row['productId']);delete_transient('wc_product_children_'.$row['productId']);if(class_exists('WC_Cache_Helper'))WC_Cache_Helper::invalidate_cache_group('product_'.$row['productId']);clean_post_cache($row['productId']);
   $result=['productId'=>$row['productId'],'sourceProductId'=>$row['sourceProductId'],'itemId'=>$row['itemId'],'status'=>'applied','variations'=>count($x['changes']),'changes'=>$x['changes'],'backup'=>$backup];
  }else throw new RuntimeException('Unknown mode');
 }catch(Throwable $e){$result=['productId'=>$row['productId'],'sourceProductId'=>$row['sourceProductId'],'status'=>'blocked','reason'=>$e->getMessage()];}finally{if($lock!==null)$wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$lock));}
 fwrite($stream,json_encode($result,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)."\n");fflush($stream);
 $counts[$result['status']]=($counts[$result['status']]??0)+1;
 unset($x);if(array_sum($counts)%25===0&&function_exists('wp_cache_flush_runtime'))wp_cache_flush_runtime();
}
if($mode==='apply')wp_defer_term_counting(false);
fclose($stream);echo json_encode($counts).PHP_EOL;
