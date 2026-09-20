<?php
require '/var/www/u0347517/data/www/slamdunk.shop/wp-load.php';
require_once '/var/www/u0347517/data/www/slamdunk.shop/wp-content/themes/slds/inc/slamdunk_size_converter_api.php';
$manifest = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
$apply = in_array('--apply', $argv, true);
$plans = [];
foreach ($manifest['brands'] as $brand) {
    $id = (int)$brand['id'];
    $term = get_term($id, 'pa_brand');
    if (!$term || is_wp_error($term) || $term->name !== $brand['name']) throw new RuntimeException('Brand identity changed');
    $existing = [];
    foreach (get_term_meta($id) as $key => $values) {
        if (strpos($key, 'таблица_размеров') !== false || strpos($key, '_slds_size_chart_') === 0) $existing[$key] = $values;
    }
    if ($existing) throw new RuntimeException('Existing size data for '.$id.'; refusing overwrite');
    $meta = ['таблица_размеров'=>(string)count($brand['sections']), '_таблица_размеров'=>'field_68bb91414dccc'];
    $models = []; $sources = [];
    foreach ($brand['sections'] as $sectionIndex => $section) {
        $category = get_term((int)$section['categoryId'], 'product_cat');
        if (!$category || is_wp_error($category)) throw new RuntimeException('Missing category');
        $prefix = 'таблица_размеров_'.$sectionIndex;
        $meta[$prefix.'_section_title'] = $section['title'];
        $meta['_'.$prefix.'_section_title'] = 'field_68bc310e50f81';
        $meta[$prefix.'_clothing_type'] = (string)count($section['tables']);
        $meta['_'.$prefix.'_clothing_type'] = 'field_68bb91a44dcce';
        foreach ($section['tables'] as $tableIndex => $table) {
            $key = $prefix.'_clothing_type_'.$tableIndex;
            foreach ($table['modelIds'] as $modelId) {
                $model = get_term((int)$modelId, 'pa_model');
                if (!$model || is_wp_error($model)) throw new RuntimeException('Missing model');
            }
            $headers = array_map(static fn($c)=>['c'=>$c], $table['headers']);
            $body = [];
            foreach ($table['rows'] as $row) {
                if (count($row)!==count($headers)) throw new RuntimeException('Invalid row length');
                $body[] = array_map(static fn($c)=>['c'=>(string)$c], $row);
            }
            $meta[$key.'_clothing_type_title'] = $table['title'];
            $meta['_'.$key.'_clothing_type_title'] = 'field_68bb91d14dccf';
            $meta[$key.'_категория'] = [(string)$section['categoryId']];
            $meta['_'.$key.'_категория'] = 'field_68bb91e44dcd0';
            $meta[$key.'_table'] = ['acftf'=>['v'=>'1.3.24'],'p'=>['o'=>['uh'=>1],'ca'=>''],'c'=>array_fill(0,count($headers),['p'=>'']),'h'=>$headers,'b'=>$body];
            $meta['_'.$key.'_table'] = 'field_68bb923f4dcd1';
            $models[$key.'_table'] = array_map('intval',$table['modelIds']);
            $sources[$key.'_table'] = ['checkedOn'=>$manifest['date'],'urls'=>$table['sources']];
            $audience = $section['title']==='Мужчинам' ? 'men' : 'women';
            foreach (['EU','UK'] as $system) {
                $converted = slamdunk_convert_size_tables([['header'=>$headers,'body'=>$body]],$system,'US',$audience);
                echo json_encode(['brand'=>$id,'table'=>$table['title'],'system'=>$system,'conversion'=>$converted['conversion_table'],'conflicts'=>$converted['conflicts']],JSON_UNESCAPED_UNICODE)."\n";
            }
        }
    }
    $meta['_slds_size_chart_model_ids'] = $models;
    $meta['_slds_size_chart_sources'] = $sources;
    $plans[] = ['id'=>$id,'before'=>$existing,'meta'=>$meta];
}
if (!$apply) { echo "Preview only\n"; exit; }
$backup = '/tmp/official-size-charts-before-20260916.json';
if (file_exists($backup)) throw new RuntimeException('Backup already exists');
file_put_contents($backup,json_encode($plans,JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT|JSON_THROW_ON_ERROR));
chmod($backup,0600);
foreach ($plans as $plan) {
    foreach ($plan['meta'] as $key=>$value) {
        if (!add_term_meta($plan['id'],$key,$value,true)) throw new RuntimeException('Failed to add '.$key);
        if (get_term_meta($plan['id'],$key,true)!==$value) throw new RuntimeException('Readback mismatch '.$key);
    }
    echo json_encode(['appliedBrand'=>$plan['id'],'keys'=>count($plan['meta'])])."\n";
}
