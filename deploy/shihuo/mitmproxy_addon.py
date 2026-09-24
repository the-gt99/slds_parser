"""Forward an allowlisted Shihuo guest profile to the parser without local storage."""
import json, logging, os, time
import re
from urllib.request import Request, urlopen
from mitmproxy import http, tls

SEARCH_PATH = "/v3/sh-api/daga/search/goods/v1"
CERT_CHECK_PATH = "/slds-shihuo-ca-check"
CERT_CHECK_HOST = "sh-gateway.shihuo.cn"
PROFILE_FIELDS = ("platform", "app-v", "sk", "luid", "osv", "user-agent")
AUTH_HEADERS = ("authorization", "sh-token", "sh-id", "cookie", "x-wechat-token", "wechat-token")
BASE_URL = os.environ["SHIHUO_PARSER_BASE_URL"].rstrip("/")
TOKEN = os.environ["SHIHUO_GATEWAY_TOKEN"]
LOG = logging.getLogger("shihuo-capture")

def contains_challenge(value, challenge):
    expected = re.sub(r"[^0-9a-z]+", "", challenge.casefold())
    if isinstance(value, dict): return any(contains_challenge(item, challenge) for item in value.values())
    if isinstance(value, list): return any(contains_challenge(item, challenge) for item in value)
    if not isinstance(value, (str, int, float)): return False
    actual = re.sub(r"[^0-9a-z]+", "", str(value).casefold())
    return bool(expected) and expected in actual

class ShihuoGuestCapture:
    def __init__(self): self.peers, self.loaded_at = {}, 0
    def api(self, path, body=None):
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request = Request(BASE_URL + path, data=data, headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}, method="GET" if body is None else "POST")
        with urlopen(request, timeout=10) as response: return json.loads(response.read())
    def refresh(self):
        if time.monotonic() - self.loaded_at < 10: return
        self.peers = {item["wireguardIp"]: item for item in self.api("/api/shihuo/gateway/peers").get("items", [])}; self.loaded_at = time.monotonic()
    def event(self, ip, stage, **values):
        try: self.api("/api/shihuo/gateway/events", {"wireguardIp": ip, "stage": stage, **values})
        except Exception as error: LOG.error("Parser event failed for peer_ip=%s type=%s", ip, type(error).__name__)
    def peer(self, flow):
        address = flow.client_conn.peername
        if not address: return None, None
        ip = str(address[0])
        try: self.refresh()
        except Exception as error: LOG.error("Peer refresh failed type=%s", type(error).__name__); return ip, None
        return ip, self.peers.get(ip)
    def tls_failed_client(self, data: tls.TlsData):
        address = data.context.client.peername
        if address and getattr(data.context.client, "sni", None) == CERT_CHECK_HOST:
            self.event(str(address[0]), "certificate_not_trusted")
    def request(self, flow: http.HTTPFlow):
        path = flow.request.path.split("?", 1)[0]
        if flow.request.host == CERT_CHECK_HOST and path == CERT_CHECK_PATH:
            ip, peer = self.peer(flow)
            if not ip or not peer: return
            self.event(ip, "certificate_trusted")
            flow.response = http.Response.make(204, b"", {"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"})
            return
        if path != SEARCH_PATH or flow.request.method != "POST": return
        ip, peer = self.peer(flow)
        if not ip or not peer: return
        try: payload = json.loads(flow.request.get_text(strict=True))
        except (ValueError, UnicodeError): self.event(ip, "profile_incomplete", message="Некорректный JSON поискового запроса"); return
        query = {key: flow.request.query.get_all(key) for key in flow.request.query.keys()}
        if not contains_challenge({"body": payload, "query": query}, peer["challenge"]): self.event(ip, "challenge_not_found"); return
        headers = {key.lower(): value.strip() for key, value in flow.request.headers.items()}
        if any(headers.get(key) for key in AUTH_HEADERS): self.event(ip, "authorized_request_rejected"); return
        profile = {key: headers.get(key, "") for key in PROFILE_FIELDS}; missing = [key for key, value in profile.items() if not value]
        if missing: self.event(ip, "profile_incomplete", message="Отсутствуют поля: " + ", ".join(missing)); return
        self.event(ip, "ready", profile=profile); LOG.info("Forwarded guest profile for device_id=%s", peer["id"])

addons = [ShihuoGuestCapture()]
