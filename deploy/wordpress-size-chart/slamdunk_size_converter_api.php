<?php

function slamdunk_size_converter_api1( $request ) {
	$brand_id   = absint( $request->get_param( 'brand_id' ) );
	$brand_name = sanitize_text_field( (string) $request->get_param( 'brand' ) );
	$category_id = absint( $request->get_param( 'category_id' ) );
	$from_system = slamdunk_size_normalize_system( (string) $request->get_param( 'from_system' ) );
	$audience    = slamdunk_size_normalize_audience( (string) $request->get_param( 'audience' ) );
	$model_ids = array_values( array_filter( array_map( 'absint', (array) $request->get_param( 'model_ids' ) ) ) );

    if ( 0 === $category_id || '' === $from_system ||  ( 0 === $brand_id && '' === $brand_name )) {
        return new WP_Error(
            'missing_parameters',
            'Необходимы brand_id или brand, category_id и from_system',
            [ 'status' => 400 ]
        );
    }

    if ( ! in_array( $from_system, [ 'EU', 'UK', 'JP', 'RU', 'CM' ], true ) ) {
        return new WP_Error(
            'unsupported_system',
            'Размерная система не поддерживается: ' . $from_system,
            [ 'status' => 400 ]
        );
    }

    $brand_term = 0 !== $brand_id ? get_term( $brand_id, 'pa_brand' ) : get_term_by( 'name', $brand_name, 'pa_brand' );
    if ( ! $brand_term || is_wp_error( $brand_term ) ) {
        return new WP_Error( 'brand_not_found', 'Бренд не найден', [ 'status' => 404 ] );
    }

	$result = slamdunk_size_converter_api2( $category_id, $from_system, $brand_term->term_id, "US", $audience, $model_ids );
	if ( is_wp_error( $result ) ) {
		return $result;
	}
	if ( empty( $result['conversion_table'] ) ) {
		return new WP_Error(
			'size_conversion_not_found',
			'В размерной сетке нет однозначного преобразования ' . $from_system . ' → US',
			[
				'status'    => 422,
				'conflicts' => $result['conflicts'],
			]
		);
	}

	return [
		'brand_id'        => (int) $brand_term->term_id,
		'brand'           => $brand_term->name,
		'category_id'     => $category_id,
		'audience'        => $audience,
		'from_system'     => $from_system,
		'to_system'       => 'US',
		'conversion_table' => $result['conversion_table'],
		'conflicts'        => $result['conflicts'],
		'tables'           => $result['tables'],
	];
}

function slamdunk_size_converter_api2( $category_id, $from_system, $brand_id, $to_system, $audience = '', $model_ids = [] ) {
    $size_tables = slamdunk_get_size_tables_for_brand_and_category( (int) $brand_id, $category_id );
    if ( empty( $size_tables ) ) {
        return new WP_Error(
            'size_table_not_found',
            'Размерная сетка не найдена для указанных бренда и категории',
            [ 'status' => 404 ]
        );
    }
    $model_map = get_term_meta( (int) $brand_id, '_slds_size_chart_model_ids', true );
    if ( ! empty( $model_map ) ) {
        $size_tables = slamdunk_select_model_size_tables( $size_tables, $model_map, $model_ids );
        if ( is_wp_error( $size_tables ) ) {
            return $size_tables;
        }
    }
    return slamdunk_convert_size_tables( $size_tables, $from_system, $to_system, $audience );

}

function slamdunk_select_model_size_tables( array $tables, $model_map, array $model_ids ) {
    if ( ! is_array( $model_map ) ) {
        return new WP_Error( 'invalid_size_model_map', 'Некорректная привязка размерных сеток к моделям', [ 'status' => 422 ] );
    }
    $selected = array_values( array_filter( $tables, static function ( $table ) use ( $model_map, $model_ids ) {
        $ids = $model_map[ $table['key'] ?? '' ] ?? [];
        return is_array( $ids ) && ! empty( array_intersect( array_map( 'intval', $ids ), array_map( 'intval', $model_ids ) ) );
    } ) );
    if ( count( $selected ) !== 1 ) {
        return new WP_Error( 'size_model_table_unresolved', 'Для модели не выбрана единственная подтверждённая размерная сетка', [ 'status' => 422 ] );
    }
    return $selected;
}

function slamdunk_size_normalize_system( $value ) {
	$value = strtoupper( trim( str_replace( [ '.', '_' ], ' ', (string) $value ) ) );
	$value = preg_replace( '/\s+/u', ' ', $value );

	if ( preg_match( '/\b(EU|EUR|EUROPE)\b|ЕВРОП/u', $value ) ) {
		return 'EU';
	}
	if ( preg_match( '/\b(UK|GB)\b/u', $value ) ) {
		return 'UK';
	}
	if ( preg_match( '/\b(JP|JPN|JAPAN)\b|ЯПОН/u', $value ) ) {
		return 'JP';
	}
	if ( preg_match( '/\b(RU|RUS|RUSSIA)\b|РОСС/u', $value ) ) {
		return 'RU';
	}
	if ( preg_match( '/\b(CM|CN)\b|\bСМ\b|ДЛИН/u', $value ) ) {
		return 'CM';
	}
	if ( preg_match( '/\b(US|USA)\b|США/u', $value ) ) {
		return 'US';
	}

	return '';
}

function slamdunk_size_normalize_audience( $value ) {
	$value = strtolower( trim( (string) $value ) );
	return in_array( $value, [ 'men', 'women', 'youth', 'infant', 'unisex' ], true ) ? $value : '';
}

function slamdunk_size_header_audiences( $header ) {
	$header = strtolower( trim( (string) $header ) );
	$audiences = [];
	if ( preg_match( '/women|womens|female|жен/u', $header ) ) {
		$audiences[] = 'women';
	}
	if ( preg_match( '/(^|[^a-z])men(?:s)?([^a-z]|$)|male|муж/u', $header ) ) {
		$audiences[] = 'men';
	}
	if ( preg_match( '/youth|junior|kids?|дет/u', $header ) ) {
		$audiences[] = 'youth';
	}
	if ( preg_match( '/infant|toddler|baby|младен/u', $header ) ) {
		$audiences[] = 'infant';
	}
	if ( preg_match( '/unisex|унисекс/u', $header ) ) {
		$audiences[] = 'unisex';
	}
	return array_values( array_unique( $audiences ) );
}

function slamdunk_size_column_score( $header, $system, $audience ) {
    $header_norm = slamdunk_size_normalize_system( $header );
    //echo "#$header_norm $header $system $audience\n#";
	if ( $header_norm !== $system ) {
		return -1;
	}

	$header_audiences = slamdunk_size_header_audiences( $header );
	if ( empty( $header_audiences ) ) {
		return 20;
	}
	if ( '' !== $audience && in_array( $audience, $header_audiences, true ) ) {
		return 40;
	}
	if ( in_array( 'unisex', $header_audiences, true ) ) {
		return 30;
	}
	if ( in_array( $audience, [ 'youth', 'infant' ], true ) && array_intersect( $header_audiences, [ 'youth', 'infant' ] ) ) {
		return 35;
	}
	return 10;
}

function slamdunk_size_select_column( $headers, $system, $audience ) {
	$best_index = null;
	$best_score = -1;
	foreach ( $headers as $index => $header ) {
		$header_text = is_array( $header ) ? (string) ( $header['c'] ?? '' ) : (string) $header;
		$score = slamdunk_size_column_score( $header_text, $system, $audience );
        //echo "[$header_text $score]";
		if ( $score > $best_score ) {
			$best_index = $index;
			$best_score = $score;
		} elseif ( $score >= 0 && $score === $best_score ) {
			//$best_index = null;
		}
	}
	return $best_index;
}

function slamdunk_size_format_value( $size ) {
	$value = trim( str_replace( ',', '.', (string) $size ) );
	return in_array( $value, [ '', '-' ], true ) ? '' : $value;
}

function slamdunk_convert_size_tables( $size_tables, $from_system, $to_system, $audience ) {
	$conversion_table = [];
	$conflicts = [];
	$tables = [];

	foreach ( $size_tables as $table_index => $table ) {
		$headers = $table['header'] ?? [];
		$body = $table['body'] ?? [];
		$from_index = slamdunk_size_select_column( $headers, $from_system, $audience );
		$us_index = slamdunk_size_select_column( $headers, $to_system, $audience );
		$tables[] = [
			'index'      => $table_index,
			'headers'    => array_map(
				static fn( $header ) => trim( (string) ( is_array( $header ) ? ( $header['c'] ?? '' ) : $header ) ),
				$headers
			),
			'from_index' => $from_index,
			'us_index'   => $us_index,
		];
		if ( null === $from_index || null === $us_index || $from_index === $us_index ) {
			continue;
		}

		foreach ( $body as $row ) {
			$from_cell = $row[ $from_index ] ?? null;
			$us_cell = $row[ $us_index ] ?? null;
			$from_size = slamdunk_size_format_value( is_array( $from_cell ) ? ( $from_cell['c'] ?? '' ) : $from_cell );
			$us_size = slamdunk_size_format_value( is_array( $us_cell ) ? ( $us_cell['c'] ?? '' ) : $us_cell );
			if ( '' === $from_size || '' === $us_size ) {
				continue;
			}
			if ( isset( $conversion_table[ $from_size ] ) && $conversion_table[ $from_size ] !== $us_size ) {
				$conflicts[ $from_size ] = array_values( array_unique( [ $conversion_table[ $from_size ], $us_size ] ) );
				unset( $conversion_table[ $from_size ] );
				continue;
			}
			if ( ! isset( $conflicts[ $from_size ] ) ) {
				$conversion_table[ $from_size ] = $us_size;
			}
		}
	}

	ksort( $conversion_table, SORT_NATURAL );
	ksort( $conflicts, SORT_NATURAL );
	return [
		'conversion_table' => $conversion_table,
		'conflicts'        => $conflicts,
		'tables'           => $tables,
	];
}

function slamdunk_get_size_tables_for_brand_and_category( $brand_id, $category_id ) {
	global $wpdb;
	$table_keys = $wpdb->get_col(
		$wpdb->prepare(
			"SELECT meta_key FROM {$wpdb->termmeta} WHERE term_id = %d AND meta_key LIKE %s",
			$brand_id,
			'таблица_размеров_%_table'
		)
	);
	$matching_tables = [];

	foreach ( $table_keys as $key ) {
		if ( ! preg_match( '/таблица_размеров_(\d+)_clothing_type_(\d+)_table/', $key, $matches ) ) {
			continue;
		}
		$category_key = "таблица_размеров_{$matches[1]}_clothing_type_{$matches[2]}_категория";
		$category_meta = get_term_meta( $brand_id, $category_key, true );
		if ( $category_meta ) {
			$category_ids = array_map( 'intval', (array) maybe_unserialize( $category_meta ) );
			if ( ! in_array( (int) $category_id, $category_ids, true ) ) {
				continue;
			}
		}
		$table_data = maybe_unserialize( get_term_meta( $brand_id, $key, true ) );
		if ( is_array( $table_data ) ) {
			$matching_tables[] = array_merge( slamdunk_format_size_table( $table_data ), [ 'key' => $key ] );
		}
	}
    if(empty($matching_tables)){
        $category = get_term( $category_id );
        if($category){
            $parent = $category->parent;
            if($parent){
                return slamdunk_get_size_tables_for_brand_and_category( $brand_id, $parent );
            }
        }
    }
	return $matching_tables;
}

function slamdunk_format_size_table( $raw_table ) {
	$headers = $raw_table['h'] ?? $raw_table['header'] ?? [];
	$body = $raw_table['b'] ?? $raw_table['body'] ?? [];
	return [
		'header' => array_map(
			static fn( $header ) => [ 'c' => is_array( $header ) ? (string) ( $header['c'] ?? '' ) : (string) $header ],
			is_array( $headers ) ? $headers : []
		),
		'body'   => array_map(
			static fn( $row ) => array_map(
				static fn( $cell ) => [ 'c' => is_array( $cell ) ? (string) ( $cell['c'] ?? '' ) : (string) $cell ],
				is_array( $row ) ? $row : []
			),
			is_array( $body ) ? $body : []
		),
	];
}
