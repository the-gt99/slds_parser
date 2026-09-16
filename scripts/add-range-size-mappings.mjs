import pg from "pg";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const items = JSON.parse(await readFile(process.argv[2], "utf8"));
const apply = process.argv.includes("--apply");
const { PostgresTargetDictionaryRepository } = await import(pathToFileURL(process.cwd() + "/dist/src/infrastructure/db/repositories/postgres-target-dictionary-repository.js").href);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
 await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
 const row = (await client.query("SELECT config->'sizeMappings' mappings FROM targets WHERE id=1" + (apply ? " FOR UPDATE" : ""))).rows[0];
 const mappings = row.mappings;
 const additions = [];
 for (const item of items) {
  if (!Number.isSafeInteger(item.termId) || item.termId <= 0 || item.taxonomy !== "pa_razmer"
    || !["men","women"].includes(item.audience) || !/^\d+-\d+\.5$/.test(item.sourceValue)) throw new Error("Unexpected range mapping");
  const matches = mappings.filter(m => m.sourceValue===item.sourceValue && m.system===item.system && m.audience===item.audience);
  if (matches.length > 1 || matches.some(m=>m.termId!==item.termId || m.taxonomy!==item.taxonomy)) throw new Error("Conflicting mapping");
  if (!matches.length) additions.push({sourceValue:item.sourceValue,system:item.system,audience:item.audience,taxonomy:item.taxonomy,termId:item.termId});
 }
 console.log(JSON.stringify({apply,additions}));
 if (apply && additions.length) {
  await writeFile("/tmp/size-mappings-before-ranges-20260916.json",JSON.stringify(mappings),{flag:"wx",mode:0o600});
  const repository = new PostgresTargetDictionaryRepository({connect:async()=>({query:client.query.bind(client),release(){}})});
  for(const item of items) await repository.upsertValue("1","sizes",{externalId:String(item.termId),name:item.name,slug:item.slug,taxonomy:item.taxonomy,attributeCode:"razmer",metadata:{source:"https://www.birkenstock.com/us/product-info-overlay-sizeName.html"}});
  await client.query("UPDATE targets SET config=jsonb_set(config,'{sizeMappings}',$1::jsonb),updated_at=now() WHERE id=1",[JSON.stringify([...mappings,...additions])]);
  console.log(JSON.stringify({revision:(await client.query("SELECT revision FROM target_export_revisions WHERE target_id=1")).rows[0].revision}));
  await client.query("COMMIT");
 } else await client.query("ROLLBACK");
} catch(e) {await client.query("ROLLBACK");throw e;} finally{client.release();await pool.end();}
