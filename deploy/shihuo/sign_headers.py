"""Generate fresh Shihuo request headers using the extracted native signer."""
import contextlib, json, logging, os, sys, time
from pathlib import Path

from chomper import Chomper
from chomper.const import ARCH_ARM64, OS_ANDROID

ROOT = Path(os.environ["SHIHUO_SIGNER_ASSET_DIR"])

class Signer:
    def __init__(self):
        logging.disable(logging.CRITICAL)
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            self.emulator = Chomper(arch=ARCH_ARM64, os_type=OS_ANDROID, rootfs_path=str(ROOT / "rootfs"))
            self.emulator.load_module(str(ROOT / "libsh_security.so"))
            sysinfo_reference = (ROOT / "android-sysinfo.bin").read_bytes()
            def sysinfo(_uc, _address, _size, _context):
                self.emulator.write_bytes(self.emulator.get_arg(0), sysinfo_reference); return 0
            self.emulator.add_interceptor("sysinfo", sysinfo)
            self.table = self.emulator.create_buffer(0x1000)
            self.env = self.emulator.create_buffer(8)
            self.emulator.write_pointer(self.env, self.table)
            self.strings = {}
            def make_string(text):
                obj = self.emulator.create_buffer(8); self.strings[obj] = self.emulator.create_string(text); return obj
            self.make_string = make_string
            def new_utf8(_uc, _address, _size, _context): return make_string(self.emulator.read_string(self.emulator.get_arg(1)))
            def new_utf16(_uc, _address, _size, _context): return make_string(self.emulator.read_bytes(self.emulator.get_arg(1), self.emulator.get_arg(2) * 2).decode("utf-16-le"))
            def get_utf8(_uc, _address, _size, _context): return self.strings[self.emulator.get_arg(1)]
            def utf8_length(_uc, _address, _size, _context): return len(self.emulator.read_string(self.strings[self.emulator.get_arg(1)]).encode())
            def zero(_uc, _address, _size, _context): return 0
            for index, callback in {6: zero, 15: zero, 17: zero, 23: zero, 163: new_utf16, 167: new_utf8, 168: utf8_length, 169: get_utf8, 170: zero}.items():
                pointer = self.emulator.create_buffer(8); self.emulator.add_interceptor(pointer, callback); self.emulator.write_pointer(self.table + index * 8, pointer)

    def sign(self, profile):
        required = ("platform", "app-v", "sk", "luid", "osv", "user-agent")
        headers = {key: profile[key] for key in required}
        headers.update({"content-type": "application/json", "timestamp": str(int(time.time() * 1000)), "sh-token": "", "sh-id": ""})
        serialized = "{" + ",".join(key + "=" + headers[key] for key in ("timestamp", "app-v", "sh-token", "sh-id", "platform")) + "}"
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            value = self.emulator.call_symbol("Java_com_shihuo_shsecsdk_Enviroment_nativeParam", self.env, 0x12340000, 0x23450000, self.make_string(serialized))
            result = json.loads(self.emulator.read_string(self.strings[value]))
        for key in ("sh-sign", "sh-ba", "sh-jt"):
            if not isinstance(result.get(key), str) or not result[key]: raise RuntimeError("Native signer returned incomplete data")
        headers.update(result)
        return headers

def serve(signer):
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            response = {"id": request_id, "ok": True, "headers": signer.sign(request["profile"])}
        except Exception as error:
            response = {"id": request_id, "ok": False, "error": str(error)[:200]}
        sys.stdout.write(json.dumps(response, ensure_ascii=True) + "\n")
        sys.stdout.flush()

def main():
    logging.disable(logging.CRITICAL)
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        signer = Signer()
    if "--server" in sys.argv:
        serve(signer)
    else:
        json.dump(signer.sign(json.load(sys.stdin)), sys.stdout, ensure_ascii=True)

if __name__ == "__main__": main()
