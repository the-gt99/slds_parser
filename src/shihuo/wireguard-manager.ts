import { spawn } from "node:child_process";

export interface WireGuardManager {
  generateKeyPair(): Promise<{ readonly privateKey: string; readonly publicKey: string }>;
  reconcile(): Promise<void>;
}

function run(command: string, args: readonly string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const output: Buffer[] = []; const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(Buffer.concat(output).toString("utf8").trim())
      : reject(new Error(`${command} exited with ${String(code)}: ${Buffer.concat(errors).toString("utf8").trim()}`)));
    child.stdin.end(stdin);
  });
}

export class SystemWireGuardManager implements WireGuardManager {
  constructor(private readonly wgCommand = "wg", private readonly reconcileService = "slds-shihuo-wireguard-reconcile.service") {}
  async generateKeyPair() {
    const privateKey = await run(this.wgCommand, ["genkey"]);
    const publicKey = await run(this.wgCommand, ["pubkey"], `${privateKey}\n`);
    if (!privateKey || !publicKey) throw new Error("WireGuard returned an empty key");
    return { privateKey, publicKey };
  }
  async reconcile(): Promise<void> { await run("systemctl", ["start", this.reconcileService]); }
}
