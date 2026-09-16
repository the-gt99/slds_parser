<?php
declare(strict_types=1);
$folder=$argv[1];
$mode=$argv[2]??'multiple';
$brands_ids=[10,20];
$brand_terms=[['term_id'=>10,'name'=>'Brand <A>'],['term_id'=>20,'name'=>'Brand B']];
$product_meta=$mode==='primary'?['_slds_size_chart_brand_id'=>20]:[];
$size_chart_categories=[25680];
if($mode==='empty')$brands_ids=[];
function custom_query($sql) {
 if(str_contains($sql,'REGEXP')) {
  $ids=str_contains($sql,'IN (20)')?[20]:[10,20];
  return array_map(fn($id)=>['term_id'=>$id,'meta_key'=>'таблица_размеров_0_clothing_type_0_категория','meta_value'=>serialize([25680])],$ids);
 }
 if(str_contains($sql,'SELECT meta_key'))return [
  ['meta_key'=>'таблица_размеров_0_section_title','meta_value'=>'Мужчинам'],
  ['meta_key'=>'таблица_размеров_0_clothing_type_0_clothing_type_title','meta_value'=>'Обувь']
 ];
 return [['meta_value'=>serialize(['h'=>[['c'=>'EU'],['c'=>'US']],'b'=>[[['c'=>'40'],['c'=>'7']]]])]];
}
require $folder.'/prepare_razmer_setki.php';
if(count($tables)!==($mode==='primary'?1:($mode==='empty'?0:2)))throw new RuntimeException('Wrong table selection');
if($mode==='primary'&&!str_starts_with($tables[0]['label'],'Brand B'))throw new RuntimeException('Wrong primary brand');
chdir($folder);
ob_start();include 'razmer_setki.php';$html=ob_get_clean();
if($mode==='multiple'&&(!str_contains($html,'Brand &lt;A&gt;')||substr_count($html,'hidden style="display:none"')!==2))throw new RuntimeException('Unsafe label or initially visible charts');
if($mode==='primary'&&str_contains($html,'data-size-chart-choice'))throw new RuntimeException('Single chart should not require selection');
if(preg_match('/<select\b[^>]*>.*?<script\b/s',$html) && strpos($html,'<script')<strpos($html,'</select>'))throw new RuntimeException('Script inside select');
if($mode==='multiple'&&!str_contains($html,'select class="size-chart-choice"'))throw new RuntimeException('Theme requires select class');
echo "OK ".$mode."\n";
