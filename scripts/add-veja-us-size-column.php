<?php
require '/var/www/u0347517/data/www/slamdunk.shop/wp-load.php';
$brand = 7403;
$key = 'таблица_размеров_0_clothing_type_0_table';
$table = get_term_meta($brand, $key, true);
$headers = array_column($table['h'] ?? [], 'c');
if ($headers !== ['EU', 'CM', 'UK', 'RU']) throw new RuntimeException('Changed VEJA table');
$map = ['39'=>'6','40'=>'7','41'=>'8','42'=>'9','43'=>'10','44'=>'11','45'=>'11.5','46'=>'12'];
$next = $table;
$next['h'][] = ['c'=>'US Men'];
$next['c'][] = ['p'=>''];
foreach ($next['b'] as &$row) {
    $eu = trim((string)$row[0]['c']);
    $row[] = ['c'=>$map[$eu] ?? ''];
}
unset($row);
echo json_encode(['brand'=>$brand,'source'=>'https://www.veja-store.com.br/en/sizeguide','headers'=>$next['h'],'rows'=>$next['b']], JSON_UNESCAPED_UNICODE)."\n";
if (in_array('--apply', $argv, true)) {
    $backup = '/tmp/veja-size-table-before-20260916.json';
    if(file_exists($backup)) throw new RuntimeException('Backup already exists');
    file_put_contents($backup,json_encode($table,JSON_UNESCAPED_UNICODE));
    chmod($backup,0600);
    update_term_meta($brand,$key,$next);
    if(get_term_meta($brand,$key,true)!==$next) throw new RuntimeException('Verification failed');
    echo "Applied and verified\n";
}
