<?php
class WP_Error { public function __construct(public $code, public $message, public $data=[]) {} }
function is_wp_error($v) { return $v instanceof WP_Error; }
function check($v,$message) { if(!$v) throw new RuntimeException($message); }
require $argv[1];
$tables=[['key'=>'icon','header'=>[['c'=>'EU'],['c'=>'US Men']],'body'=>[[['c'=>'35/38'],['c'=>'3.5–6']]]],['key'=>'moon247','header'=>[['c'=>'EU'],['c'=>'US Men']],'body'=>[[['c'=>'35'],['c'=>'3.5']]]]];
$map=['icon'=>[1],'moon247'=>[2]];
$selected=slamdunk_select_model_size_tables($tables,$map,[1]);
check(count($selected)===1&&$selected[0]['key']==='icon','Icon selection');
$r=slamdunk_convert_size_tables($selected,'EU','US','men');
check(!isset($r['conversion_table']['35'])&&$r['conversion_table']['35/38']==='3.5–6','No range expansion or foreign model');
check(is_wp_error(slamdunk_select_model_size_tables($tables,$map,[])),'Missing model must block');
check(is_wp_error(slamdunk_select_model_size_tables($tables,$map,[3])),'Unknown model must block');
check(is_wp_error(slamdunk_select_model_size_tables($tables,$map,[1,2])),'Ambiguous models must block');
function slds_target_import_queue_is_paused(){ return $GLOBALS['paused']??false; }
function slds_target_import_queue_table(){return 'queue';}
$source=file_get_contents($argv[2]);
$start=strpos($source,'function slds_target_import_queue_has_ready_items(');
$end=strpos($source,'function slds_target_import_queue_process_batch(',$start);
eval(substr($source,$start,$end-$start));
class FakeDb {public $answers=[]; public $queries=[]; function get_var($sql){$this->queries[]=$sql;return array_shift($this->answers);} }
$wpdb=new FakeDb();
$wpdb->answers=[null,1];
check(slds_target_import_queue_has_ready_items('core'),'Expired claims must wake idle worker');
check(str_contains($wpdb->queries[1],"status = 'processing'")&&str_contains($wpdb->queries[1],'15 MINUTE')&&str_contains($wpdb->queries[1],"source NOT IN"),'Lease and lane predicate');
$wpdb->answers=[null,null];
check(!slds_target_import_queue_has_ready_items('core'),'No eligible work');
$wpdb->answers=[1];
check(slds_target_import_queue_has_ready_items('core'),'Pending work');
$paused=true;
check(!slds_target_import_queue_has_ready_items('core'),'Pause respected');
echo "Model selection and queue recovery tests passed\n";
