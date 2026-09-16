<?php
if(isset($_GET['migrate_rs'])){
    echo "<p>migrate_rs</p>\n";
    //$old_data = get_post_meta(377452, 'brands', true);
    $old_data = get_field('brands',377452);
    foreach ($old_data as  $n => $brand_data) {
        $brand_name = $brand_data['brand_title'];
        $m = $n+1;
        if($m == 27) $brand_name = "HOKA";
        $data = $brand_data['sections'];
        $brand_term = get_term_by('name', $brand_name, 'pa_brand');
        $brand_id = "-";
        $res = "-";
        if ($brand_term) {
            $brand_id = $brand_term->term_id;
            //$res = update_term_meta($brand_id, 'таблица_размеров', $data);
            //$res = update_field('таблица_размеров', $data, 'pa_brand_' . $brand_id);
            foreach ($data as $i=>$section) {
                foreach ($section['clothing_type'] as $j=>$clothing_type) {
                    // Преобразуем данные таблицы в формат ACF
                    //$table_data = prepare_table_data_for_acf($clothing_type['table']);
                    $title = $clothing_type['clothing_type_title'];
                    $key = "brands_{$n}_sections_{$i}_clothing_type_{$j}_table";
                    $table_data = get_post_meta(377452, $key, true);
                    if ($table_data) {
                        //$data[$i]["clothing_type"][$j]['table'] = $table_data;
                        $key = "таблица_размеров_{$i}_clothing_type_{$j}_table";
                        //update_term_meta($brand_id, $key, $table_data);
                    }
                    else{
                        echo "<p>ERROR: $brand_name </p>";
                    }
                }

                //var_dump($data);
            }
        }

        echo "<p>{$m} $brand_name | $brand_id | $res</p>\n";
    }
}

$categories = $size_chart_categories = array_unique($size_chart_categories);
$brands_ids = array_values(array_unique(array_filter(array_map('intval', $brands_ids), static fn($brand_id) => $brand_id > 0)));
$tables = [];
if (!$brands_ids) {
    return;
}
$size_chart_brand_names = [];
foreach (($brand_terms ?? []) as $brand_term) {
    $size_chart_brand_names[(int) $brand_term['term_id']] = (string) $brand_term['name'];
}
// Используем основной бренд только при явно сохранённом выборе.
$size_chart_primary_brand = (int) ($product_meta['_slds_size_chart_brand_id'] ?? 0);
if (in_array($size_chart_primary_brand, $brands_ids, true)) {
    $brands_ids = [$size_chart_primary_brand];
}

$categories_query = "
        SELECT *
        FROM wp_termmeta
        WHERE term_id IN (" . implode(',', $brands_ids) . ")
        AND meta_key REGEXP '^таблица_размеров_[0-9]{1,3}_clothing_type_[0-9]{1,3}_категория$'
    ";
$categories_data = custom_query($categories_query);

$matching_indexes = [];
foreach ($categories_data as $meta) {
    $category_ids = unserialize($meta['meta_value']);
    if ($category_ids && array_intersect($categories, $category_ids)) {
        preg_match('/таблица_размеров_([0-9]{1,3})_clothing_type_([0-9]{1,3})_категория/', $meta['meta_key'], $matches);
        if (!empty($matches)) {
            $matching_indexes[] = [
                'table_index' => $matches[1],
                'clothing_type_index' => $matches[2],
                'term_id' => $meta['term_id']
            ];
        }
    }
}

$tables = [];
foreach ($matching_indexes as $index) {

    //$test_table = get_field('таблица_размеров',"term_{$index['term_id']}");
    $table_query = "
            SELECT meta_value
            FROM wp_termmeta
            WHERE term_id = {$index['term_id']}
            AND meta_key = 'таблица_размеров_{$index['table_index']}_clothing_type_{$index['clothing_type_index']}_table'
        ";
    $table_data = custom_query($table_query);
    if (!empty($table_data)) {
        $table = convert_table_from_bd_to_wp_format(unserialize($table_data[0]['meta_value']));
        $section_key = "таблица_размеров_{$index['table_index']}_section_title";
        $title_key = "таблица_размеров_{$index['table_index']}_clothing_type_{$index['clothing_type_index']}_clothing_type_title";
        $labels = custom_query("SELECT meta_key, meta_value FROM wp_termmeta WHERE term_id = {$index['term_id']} AND meta_key IN ('{$section_key}', '{$title_key}')");
        $label_parts = [$size_chart_brand_names[(int) $index['term_id']] ?? 'Бренд'];
        $label_values = array_column($labels, 'meta_value', 'meta_key');
        foreach ([$section_key, $title_key] as $label_key) {
            if (!empty($label_values[$label_key])) $label_parts[] = (string) $label_values[$label_key];
        }
        $table['label'] = implode(' · ', array_unique($label_parts));
        $tables[] = $table;
    }
}

function convert_table_from_bd_to_wp_format($raw_table) {
    // Инициализируем результирующий массив
    $formatted_table = [
        "use_header" => true, // Указываем, что заголовки используются
        "header" => [],
        "caption" => false, // Указываем, что подписи к таблице нет
        "body" => []
    ];

    // Проверяем, есть ли заголовки в исходных данных
    if (!empty($raw_table['h']) && is_array($raw_table['h'])) {
        foreach ($raw_table['h'] as $header) {
            // Добавляем заголовки в нужном формате
            $formatted_table['header'][] = [
                "c" => $header['c'] ?? ''
            ];
        }
    }

    // Проверяем, есть ли тело таблицы в исходных данных
    if (!empty($raw_table['b']) && is_array($raw_table['b'])) {
        foreach ($raw_table['b'] as $row) {
            $formatted_row = [];
            foreach ($row as $cell) {
                // Добавляем ячейки строки в нужном формате
                $formatted_row[] = [
                    "c" => $cell['c'] ?? ''
                ];
            }
            // Добавляем строку в тело таблицы
            $formatted_table['body'][] = $formatted_row;
        }
    }

    return $formatted_table;
}
