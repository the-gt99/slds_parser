import pg from "pg";
import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const root = process.cwd() + "/dist/src/";
const moduleAt = (path) => import(pathToFileURL(root + path).href);
const { loadWordPressTargetConfig } = await moduleAt("config/index.js");
const { PostgresClassificationAdminRepository } = await moduleAt("infrastructure/db/repositories/postgres-classification-admin-repository.js");
const { PostgresClassificationRepository } = await moduleAt("infrastructure/db/repositories/postgres-classification-repository.js");
const { PostgresTargetDictionaryRepository } = await moduleAt("infrastructure/db/repositories/postgres-target-dictionary-repository.js");
const { TargetDictionaryProviderRegistry } = await moduleAt("integrations/index.js");
const { WordPressDictionaryProvider } = await moduleAt("integrations/wordpress/wordpress-dictionary-provider.js");
const { ClassifierAdminService } = await moduleAt("services/classifier-admin-service.js");
const { TargetDictionaryService } = await moduleAt("services/target-dictionary-service.js");
const items = JSON.parse(await readFile(process.argv[2], "utf8"));
const apply = process.argv.includes("--apply");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
 const target = (await pool.query("SELECT enabled FROM targets WHERE id=1")).rows[0];
 if (apply && target.enabled) throw new Error("Disable target exports before applying decisions");
 const providers = new TargetDictionaryProviderRegistry();
 providers.register(new WordPressDictionaryProvider(loadWordPressTargetConfig(process.env)));
 const dictionaries = new PostgresTargetDictionaryRepository(pool);
 const admin = new PostgresClassificationAdminRepository(pool);
 const classifier = new ClassifierAdminService(admin, new PostgresClassificationRepository(pool), dictionaries, providers, "model-repair-20260916");
 const service = new TargetDictionaryService(dictionaries, providers, classifier);
 const prepared = [];
 for (const item of items) {
  const found = (await pool.query("SELECT c.source_id,c.scope,c.normalized_source_value,c.context_key,c.context,i.data->>'title' title FROM source_product_classification_links l JOIN classification_candidates c ON c.id=l.candidate_id JOIN reference_types t ON t.id=c.reference_type_id JOIN internal_products i ON i.source_product_id=l.source_product_id WHERE l.source_product_id=$1 AND l.active=true AND t.code='model'", [item.sourceProductId])).rows;
  if (found.length!==1 || found[0].title!==item.sourceTitle || found[0].context.brand!==item.brand || found[0].context.family!==item.family) throw new Error("Changed evidence for "+item.sourceProductId);
  if (!item.name || item.name.length>200) throw new Error("Invalid model name");
  const c=found[0];
  const key={sourceId:c.source_id,typeCode:"model",scope:c.scope,normalizedSourceValue:c.normalized_source_value,contextKey:c.context_key};
  const matches=(await pool.query("SELECT id,external_id,name FROM target_dictionary_values WHERE target_id=1 AND entity_type='models' AND active=true AND lower(name)=lower($1)",[item.name])).rows;
  if(matches.length>1)throw new Error("Ambiguous term: "+item.name);
  if(item.existingTermId && (matches.length!==1 || matches[0].external_id!==item.existingTermId))throw new Error("Changed target term");
  prepared.push({item,key});
 }
 console.log(JSON.stringify({apply,products:prepared.length,uniqueNames:new Set(items.map(x=>x.name)).size}));
 if(!apply)process.exitCode=0;
 else for(const {item,key} of prepared) {
  if((await pool.query("SELECT enabled FROM targets WHERE id=1")).rows[0].enabled)throw new Error("Target exports were enabled during repair");
  const matches=(await pool.query("SELECT id,external_id FROM target_dictionary_values WHERE target_id=1 AND entity_type='models' AND active=true AND lower(name)=lower($1)",[item.name])).rows;
  const reason="Проверил модель по названию GOAT, бренду и семейству; исключил расцветку. Пакет 16.09.2026.";
  let result;
  if(matches.length===1)result=await classifier.saveDecision({...key,action:"confirm",targetLink:{targetId:"1",targetScope:"product.model",dictionaryValueId:matches[0].id},reason});
  else if(matches.length===0)result=await service.createTermAndDecide({...key,targetId:"1",targetScope:"product.model",entityType:"models",name:item.name,relatedTerm:{relationCode:"landing",entityType:"tags",mode:"none"},reason},"model-repair-20260916");
  else throw new Error("Ambiguous term during apply");
  await appendFile("/tmp/model-decisions-applied-20260916.jsonl",JSON.stringify({sourceProductId:item.sourceProductId,name:item.name,result})+"\n",{mode:0o600});
  console.log(JSON.stringify({sourceProductId:item.sourceProductId,name:item.name,status:"applied"}));
 }
} finally {await pool.end();}
