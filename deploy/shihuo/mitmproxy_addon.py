"""Capture only the allowlisted guest fields needed by the Shihuo signer."""
import base64, hashlib, json, logging, os
from datetime import datetime, timezone
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import psycopg
from mitmproxy import http, tls

HOSTS = {"sh-gateway.shihuo.cn"}
SEARCH_PATH = "/v3/sh-api/daga/search/goods/v1"
PROFILE_FIELDS = ("platform", "app-v", "sk", "luid", "osv", "user-agent")
AUTH_HEADERS = ("authorization", "sh-token", "sh-id", "cookie", "x-wechat-token", "wechat-token")
LOG = logging.getLogger("shihuo-capture")

def decode_key(value):
    value = value.strip()
    key = bytes.fromhex(value) if len(value) == 64 and all(c in "0123456789abcdefABCDEF" for c in value) else base64.b64decode(value)
    if len(key) != 32: raise RuntimeError("encryption key must contain 32 bytes")
    return key

def encrypt(value):
    iv = os.urandom(12); encrypted = AESGCM(decode_key(os.environ["PARSER_PROXY_ENCRYPTION_KEY"])).encrypt(iv, value.encode(), None)
    ciphertext, tag = encrypted[:-16], encrypted[-16:]
    enc = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
    return ":".join(("v1", enc(iv), enc(tag), enc(ciphertext)))

def peer_ip(flow):
    address = flow.client_conn.peername
    return str(address[0]) if address else None

def update(ip, sql, params=()):
    if not ip: return
    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        with connection.cursor() as cursor: cursor.execute(sql, (*params, ip))

class ShihuoGuestCapture:
    def tls_failed_client(self, data: tls.TlsData):
        address = data.context.client.peername
        ip = str(address[0]) if address else None
        update(ip, "UPDATE shihuo_guest_devices SET diagnostic_stage=CASE WHEN status='onboarding' THEN 'certificate_not_trusted' ELSE diagnostic_stage END, diagnostic_message=NULL, updated_at=NOW() WHERE wireguard_ip=%s::inet")

    def request(self, flow: http.HTTPFlow):
        ip = peer_ip(flow)
        if flow.request.pretty_host not in HOSTS: return
        update(ip, "UPDATE shihuo_guest_devices SET last_traffic_at=NOW(), diagnostic_stage=CASE WHEN status='onboarding' THEN 'challenge_not_found' ELSE diagnostic_stage END, updated_at=NOW() WHERE wireguard_ip=%s::inet")
        if flow.request.path.split("?", 1)[0] != SEARCH_PATH or flow.request.method != "POST": return
        try: payload = json.loads(flow.request.get_text(strict=True))
        except (ValueError, UnicodeError):
            update(ip, "UPDATE shihuo_guest_devices SET diagnostic_stage='error', diagnostic_message='Некорректный JSON поискового запроса', updated_at=NOW() WHERE wireguard_ip=%s::inet")
            return
        with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
            row = connection.execute("SELECT id, challenge FROM shihuo_guest_devices WHERE wireguard_ip=%s::inet AND status='onboarding'", (ip,)).fetchone()
            if not row: return
            device_id, challenge = row
            values = {str(payload.get("keywords", "")), str(payload.get("user_input", ""))}
            if challenge not in values: return
            headers = {key.lower(): value.strip() for key, value in flow.request.headers.items()}
            if any(headers.get(key) for key in AUTH_HEADERS):
                connection.execute("UPDATE shihuo_guest_devices SET diagnostic_stage='authorized_request_rejected', diagnostic_message=NULL, last_request_at=NOW(), updated_at=NOW() WHERE id=%s", (device_id,))
                LOG.warning("Rejected authorized Shihuo request for device_id=%s", device_id); return
            profile = {key: headers.get(key, "") for key in PROFILE_FIELDS}
            missing = [key for key, value in profile.items() if not value]
            if missing:
                connection.execute("UPDATE shihuo_guest_devices SET diagnostic_stage='profile_incomplete', diagnostic_message=%s, last_request_at=NOW(), updated_at=NOW() WHERE id=%s", ("Отсутствуют поля: " + ", ".join(missing), device_id)); return
            connection.execute("""UPDATE shihuo_guest_devices SET guest_profile_ciphertext=%s, status='ready', diagnostic_stage='ready',
                diagnostic_message=NULL, last_request_at=NOW(), updated_at=NOW() WHERE id=%s""", (encrypt(json.dumps(profile, separators=(",", ":"), ensure_ascii=False)), device_id))
            LOG.info("Captured guest Shihuo profile for device_id=%s", device_id)

addons = [ShihuoGuestCapture()]
