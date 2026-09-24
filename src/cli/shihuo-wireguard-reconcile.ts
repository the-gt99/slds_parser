import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPostgresPool, PostgresShihuoDeviceRepository } from "../infrastructure/db/index.js";

const exec = promisify(execFile); const iface = process.env.SHIHUO_WIREGUARD_INTERFACE?.trim() || "wg0";
const wg = process.env.SHIHUO_WG_COMMAND?.trim() || "wg"; const pool = createPostgresPool();
try {
  const repository = new PostgresShihuoDeviceRepository(pool); const devices = await repository.list();
  const active = new Map(devices.filter((d) => d.status !== "paused" && d.status !== "revoked").map((d) => [d.wireguardPublicKey, d]));
  const dump = (await exec(wg, ["show", iface, "dump"])).stdout.trim().split(/\r?\n/u).slice(1);
  const existing = new Set(dump.flatMap((line) => { const key = line.split("\t")[0]; return key ? [key] : []; }));
  for (const key of existing) if (!active.has(key)) await exec(wg, ["set", iface, "peer", key, "remove"]);
  for (const device of active.values()) await exec(wg, ["set", iface, "peer", device.wireguardPublicKey, "allowed-ips", `${device.wireguardIp}/32`]);
  const handshakes = (await exec(wg, ["show", iface, "latest-handshakes"])).stdout.trim().split(/\r?\n/u);
  for (const line of handshakes) {
    const [key, raw] = line.split("\t"); const seconds = Number(raw);
    if (typeof key === "string" && key !== "" && Number.isFinite(seconds)) await repository.updateHandshake(key, seconds > 0 ? new Date(seconds * 1_000).toISOString() : null);
  }
} finally { await pool.end(); }
