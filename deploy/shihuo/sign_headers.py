"""Generate fresh Shihuo request headers using the extracted native signer."""
import contextlib, json, logging, os, sys, time
from pathlib import Path

from chomper import Chomper
from chomper.const import ARCH_ARM64, OS_ANDROID

ROOT = Path(os.environ["SHIHUO_SIGNER_ASSET_DIR"])

def main():
    profile = json.load(sys.stdin)
    required = ("platform", "app-v", "sk", "luid", "osv", "user-agent")
    headers = {key: profile[key] for key in required}
    headers.update({"content-type": "application/json", "timestamp": str(int(time.time() * 1000)), "sh-token": "", "sh-id": ""})
    logging.disable(logging.CRITICAL)
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        emulator = Chomper(arch=ARCH_ARM64, os_type=OS_ANDROID, rootfs_path=str(ROOT / "rootfs"))
        emulator.load_module(str(ROOT / "libsh_security.so"))
        sysinfo_reference = (ROOT / "android-sysinfo.bin").read_bytes()
        def sysinfo(_uc, _address, _size, _context):
            emulator.write_bytes(emulator.get_arg(0), sysinfo_reference); return 0
        emulator.add_interceptor("sysinfo", sysinfo)
        table = emulator.create_buffer(0x1000); env = emulator.create_buffer(8); emulator.write_pointer(env, table); strings = {}
        def make_string(text):
            obj = emulator.create_buffer(8); strings[obj] = emulator.create_string(text); return obj
        def new_utf8(_uc, _address, _size, _context): return make_string(emulator.read_string(emulator.get_arg(1)))
        def new_utf16(_uc, _address, _size, _context): return make_string(emulator.read_bytes(emulator.get_arg(1), emulator.get_arg(2) * 2).decode("utf-16-le"))
        def get_utf8(_uc, _address, _size, _context): return strings[emulator.get_arg(1)]
        def utf8_length(_uc, _address, _size, _context): return len(emulator.read_string(strings[emulator.get_arg(1)]).encode())
        def zero(_uc, _address, _size, _context): return 0
        for index, callback in {6: zero, 15: zero, 17: zero, 23: zero, 163: new_utf16, 167: new_utf8, 168: utf8_length, 169: get_utf8, 170: zero}.items():
            pointer = emulator.create_buffer(8); emulator.add_interceptor(pointer, callback); emulator.write_pointer(table + index * 8, pointer)
        serialized = "{" + ",".join(key + "=" + headers[key] for key in ("timestamp", "app-v", "sh-token", "sh-id", "platform")) + "}"
        value = emulator.call_symbol("Java_com_shihuo_shsecsdk_Enviroment_nativeParam", env, 0x12340000, 0x23450000, make_string(serialized))
        result = json.loads(emulator.read_string(strings[value]))
    for key in ("sh-sign", "sh-ba", "sh-jt"):
        if not isinstance(result.get(key), str) or not result[key]: raise RuntimeError("Native signer returned incomplete data")
    headers.update(result); json.dump(headers, sys.stdout, ensure_ascii=True)

if __name__ == "__main__": main()
