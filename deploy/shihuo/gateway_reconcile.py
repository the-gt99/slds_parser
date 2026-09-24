"""Synchronize a dedicated WireGuard interface from the parser; store no peer data."""
import json, os, subprocess
from urllib.request import Request, urlopen
BASE_URL = os.environ["SHIHUO_PARSER_BASE_URL"].rstrip("/"); TOKEN = os.environ["SHIHUO_GATEWAY_TOKEN"]
INTERFACE = os.environ.get("SHIHUO_WIREGUARD_INTERFACE", "wg0")
def api(path, body=None):
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = Request(BASE_URL + path, data=data, headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}, method="GET" if body is None else "POST")
    with urlopen(request, timeout=10) as response: return json.loads(response.read())
def run(*args): return subprocess.run(args, check=True, capture_output=True, text=True).stdout
desired = {item["publicKey"]: item for item in api("/api/shihuo/gateway/peers").get("items", [])}
existing = {line.split("\t", 1)[0] for line in run("wg", "show", INTERFACE, "dump").strip().splitlines()[1:] if line}
for key in existing - desired.keys(): run("wg", "set", INTERFACE, "peer", key, "remove")
for key, item in desired.items(): run("wg", "set", INTERFACE, "peer", key, "allowed-ips", item["wireguardIp"] + "/32")
for line in run("wg", "show", INTERFACE, "latest-handshakes").strip().splitlines():
    key, seconds = line.split("\t", 1)
    if int(seconds) > 0 and key in desired: api("/api/shihuo/gateway/events", {"wireguardIp": desired[key]["wireguardIp"], "stage": "traffic_not_seen", "handshakeAt": int(seconds)})
