import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PostgresShihuoDeviceRepository } from "../../src/infrastructure/db/index.js";
import { ShihuoGuestDeviceService, ShihuoSecretCrypto } from "../../src/shihuo/index.js";
import { createHttpServer } from "../../src/http/index.js";

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const schema = `shihuo_registration_${randomUUID().replaceAll("-", "")}`;

integration("public Shihuo registration with PostgreSQL", () => {
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
  const repository = new PostgresShihuoDeviceRepository(pool, pool);
  let serial = 0;
  const input = () => {
    const n = ++serial;
    return { name: `Phone ${n}`, publicKey: `public-${n}`, tokenHash: `token-${n}`, expiresAt: new Date(Date.now()+86400000).toISOString(),
      challenge: `SKU-${n}`, privateKeyCiphertext: "private", subnet: "10.77.0.0/24", firstHost: 10, lastHost: 254 };
  };
  const registration = (ip = randomUUID(), request = randomUUID()) => ({ requestHash: request, ipHash: ip, tokenCiphertext: "token" });
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of ["086_shihuo_guest_devices.sql", "088_shihuo_onboarding_steps.sql", "089_shihuo_profile_verification.sql", "106_shihuo_public_registration.sql"]) {
      await pool.query(await readFile(`src/infrastructure/db/migrations/${name}`, "utf8"));
    }
  });
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

  it("creates only one peer for concurrent retries with the same browser key", async () => {
    const r = registration();
    const results = await Promise.all([repository.createPublic(input(),r), repository.createPublic(input(),r)]);
    expect(results[0].device.id).toBe(results[1].device.id);
    expect(results.filter(x=>x.created)).toHaveLength(1);
  });

  it("enforces a shared three-per-day IP limit under concurrent requests", async () => {
    const ip = randomUUID();
    const results = await Promise.allSettled(Array.from({length:5},()=>repository.createPublic(input(),registration(ip))));
    expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(3);
    expect(results.filter(x=>x.status==="rejected")).toHaveLength(2);
    const rows = await pool.query("SELECT count(*)::int AS count FROM shihuo_public_registrations WHERE ip_hash=$1",[ip]);
    expect(rows.rows[0].count).toBe(3);
  });

  it("allows only one acceptance for concurrent copies of a profile and keeps the fingerprint after deletion", async () => {
    const a=(await repository.createPublic(input(),registration())).device;
    const b=(await repository.createPublic(input(),registration())).device;
    await repository.recordGatewayEvent({wireguardIp:a.wireguardIp!,stage:"profile_captured",profileCiphertext:"same"});
    await repository.recordGatewayEvent({wireguardIp:b.wireguardIp!,stage:"profile_captured",profileCiphertext:"same"});
    const hash=randomUUID();
    const outcomes=await Promise.all([a,b].map(d=>repository.recordVerification(d.id,true,undefined,{fingerprint:hash,ciphertext:"same"})));
    expect(outcomes.filter(d=>d.status==="ready")).toHaveLength(1);
    expect(outcomes.filter(d=>d.diagnosticStage==="duplicate_profile")).toHaveLength(1);
    expect(outcomes.find(d=>d.diagnosticStage==="duplicate_profile")!.wireguardIp).toBeNull();
    await repository.delete(outcomes.find(d=>d.status==="ready")!.id);
    const c=(await repository.createPublic(input(),registration())).device;
    await repository.recordGatewayEvent({wireguardIp:c.wireguardIp!,stage:"profile_captured",profileCiphertext:"same"});
    expect((await repository.recordVerification(c.id,true,undefined,{fingerprint:hash,ciphertext:"same"})).diagnosticStage).toBe("duplicate_profile");
  });

  it("releases addresses on completion and expires unfinished public registrations", async () => {
    const r=registration();const a=(await repository.createPublic(input(),r)).device;
    await pool.query("UPDATE shihuo_public_registrations SET expires_at=NOW()-INTERVAL '1 minute' WHERE request_hash=$1",[r.requestHash]);
    await expect(repository.findPublic(r.requestHash)).rejects.toMatchObject({code:"SHIHUO_PUBLIC_LINK_EXPIRED"});
    const b=(await repository.createPublic(input(),registration())).device;
    expect((await repository.getById(a.id))!.wireguardIp).toBeNull();
    await pool.query("UPDATE shihuo_guest_devices SET status='ready' WHERE id=$1",[b.id]);
    expect((await repository.acknowledgeCompletion(b.id)).wireguardIp).toBeNull();
  });

  it("does not demote an accepted profile after a concurrent failed verification", async () => {
    const d=(await repository.createPublic(input(),registration())).device;
    await repository.recordGatewayEvent({wireguardIp:d.wireguardIp!,stage:"profile_captured",profileCiphertext:"verified"});
    const profile={fingerprint:randomUUID(),ciphertext:"verified"};
    await repository.recordVerification(d.id,true,undefined,profile);
    expect((await repository.recordVerification(d.id,false,"Temporary failure",profile)).status).toBe("ready");
  });

  it("rejects a verification for a profile that changed during the external request", async () => {
    const d=(await repository.createPublic(input(),registration())).device;
    await repository.recordGatewayEvent({wireguardIp:d.wireguardIp!,stage:"profile_captured",profileCiphertext:"new"});
    await expect(repository.recordVerification(d.id,true,undefined,{fingerprint:randomUUID(),ciphertext:"old"})).rejects.toMatchObject({code:"SHIHUO_PROFILE_CHANGED"});
    expect((await repository.getById(d.id))!.status).toBe("onboarding");
  });

  it("runs the public HTTP flow and compares all six fields, allowing a shared luid", async () => {
    const crypto=new ShihuoSecretCrypto(Buffer.alloc(32,7).toString("base64"));
    const config={ onboardingBaseUrl:"https://parser.example",subnet:"10.77.0.0/24",onboardingTtlHours:24 } as never;
    const repo = Object.create(repository) as PostgresShihuoDeviceRepository;
    repo.randomProductSku=async()=>`HTTP-SKU-${++serial}`;
    const service=new ShihuoGuestDeviceService(repo,crypto,{generateKeyPair:async()=>({publicKey:`http-${++serial}`,privateKey:"private"}),reconcile:async()=>{}},config,{verify:async()=>({httpStatus:200,goodsCount:1})});
    const server=createHttpServer({database:pool,auth:{token:"a".repeat(40),username:"admin",password:"password",sessionSecret:"b".repeat(40)},shihuo:service,classifier:{} as never,targetDictionaries:{} as never,productAdmin:{} as never});
    try {
      const profile={platform:"ios","app-v":"1",sk:"sk",luid:"shared",osv:"18","user-agent":"ua"};
      const outcomes=[];
      for(const [i,p] of [profile,profile,{...profile,sk:"other"}].entries()){
        const res=await server.inject({method:"POST",url:"/api/shihuo/join",payload:{requestKey:String(i+1).repeat(64)},headers:{"x-real-ip":`203.0.113.${i+1}`},remoteAddress:"127.0.0.1"});
        expect(res.statusCode).toBe(200);
        const token=new URL(res.json().onboardingUrl).pathname.split("/").at(-1)!;
        const d=(await repository.list()).find(d=>d.name.startsWith("Гость")&&d.onboardingTokenHash===createHash("sha256").update(token).digest("hex"))!;
        await service.gatewayEvent({wireguardIp:d.wireguardIp,stage:"profile_captured",profile:p});
        const verified=await server.inject({method:"POST",url:`/api/shihuo/onboarding/${token}/verify`});
        outcomes.push(verified.json());
      }
      expect(outcomes.map(x=>x.verified)).toEqual([true,false,true]);
      expect(outcomes[1].duplicate).toBe(true);
    } finally {await server.close();}
  });
});
