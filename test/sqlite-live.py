"""用真实 Chromium Cookies 库校验插件自带的 SQLite 读取器。

拿本机任意一个 WebView2/Chromium 的 Cookies 库做双向对账：
Python sqlite3 读一遍，插件的 readCookies 读一遍，比行数与关键字段。
"""
import glob
import json
import os
import sqlite3
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

candidates = glob.glob(os.path.expandvars(
    r"C:\Users\Administrator\AppData\Local\*\EBWebView\*\Network\Cookies"
))
found = None
rows = []
for path in candidates:
    try:
        con = sqlite3.connect("file:" + path.replace(os.sep, "/") + "?mode=ro", uri=True)
        current = con.execute(
            "select host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly from cookies"
        ).fetchall()
        con.close()
    except Exception:
        continue
    if current:
        found, rows = path, current
        break

if not found:
    print("NO_SAMPLE")
    sys.exit(0)

print("样本:", found)
print("sqlite3 行数:", len(rows))

script = """
import { readCookies } from './lib/sqlite.mjs'
const { rows } = await readCookies(process.env.COOKIE_DB)
console.log(JSON.stringify(rows.map(r => [r.host, r.name, r.value, r.encrypted.length, r.path, r.expires, r.secure, r.httpOnly])))
"""

result = subprocess.run(
    ["node", "--input-type=module", "-e", script],
    cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    env={**os.environ, "COOKIE_DB": found},
)
if result.returncode != 0:
    print("插件解析器失败:", (result.stderr or "")[:600])
    sys.exit(1)

parsed = json.loads(result.stdout)
print("插件解析器行数:", len(parsed))

expected = [[r[0], r[1], r[2], len(r[3] or b""), r[4], r[5], bool(r[6]), bool(r[7])] for r in rows]
print("行数一致:", len(parsed) == len(expected))
mismatch = [(a, b) for a, b in zip(parsed, expected) if a != b]
print("字段一致:", not mismatch)
if mismatch:
    print("首个不一致:", json.dumps(mismatch[0], ensure_ascii=False)[:500])
