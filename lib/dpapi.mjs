/**
 * Windows DPAPI 解密。
 *
 * Chromium 在 Windows 上用 DPAPI 保护它自己的主密钥：`Local State` 里的
 * `os_crypt.encrypted_key` 是 base64 文本，去掉前缀 `DPAPI` 后就是一段
 * DPAPI 密文，解出来正好 32 字节 AES-256 密钥。插件宿主是 Bun，没有现成的
 * DPAPI 绑定，所以走一次 PowerShell 的 P/Invoke。
 *
 * 密文通过 stdin 传给 PowerShell 而不是命令行参数，避免 base64 太长被截断。
 */
import { spawn } from 'node:child_process'

const SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DpapiShim {
  [StructLayout(LayoutKind.Sequential)]
  struct DATA_BLOB { public int cbData; public IntPtr pbData; }
  [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, IntPtr ppszDataDescr,
    IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);
  public static byte[] Unprotect(byte[] data) {
    DATA_BLOB inB = new DATA_BLOB();
    DATA_BLOB outB = new DATA_BLOB();
    inB.cbData = data.Length;
    inB.pbData = Marshal.AllocHGlobal(data.Length);
    Marshal.Copy(data, 0, inB.pbData, data.Length);
    try {
      if (!CryptUnprotectData(ref inB, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref outB))
        throw new Exception("CryptUnprotectData failed: " + Marshal.GetLastWin32Error());
      byte[] result = new byte[outB.cbData];
      Marshal.Copy(outB.pbData, result, 0, outB.cbData);
      return result;
    } finally {
      if (inB.pbData != IntPtr.Zero) Marshal.FreeHGlobal(inB.pbData);
      if (outB.pbData != IntPtr.Zero) Marshal.FreeHGlobal(outB.pbData);
    }
  }
}
'@
$b64 = [Console]::In.ReadToEnd().Trim()
$raw = [Convert]::FromBase64String($b64)
$plain = [DpapiShim]::Unprotect($raw)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`

const cache = new Map()

/** 解一段 DPAPI 密文，返回明文 Buffer。同一次进程内同样的密文只解一次。 */
export async function unprotect(blob) {
  if (process.platform !== 'win32') throw new Error('DPAPI 只在 Windows 上可用。')
  const key = Buffer.from(blob).toString('base64')
  const hit = cache.get(key)
  if (hit) return hit
  const out = await run(SCRIPT, key)
  cache.set(key, out)
  return out
}

function run(script, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`DPAPI 调用失败（退出码 ${code}）：${Buffer.concat(stderr).toString('utf8').trim().slice(0, 400)}`))
        return
      }
      const text = Buffer.concat(stdout).toString('utf8').trim()
      if (!text) {
        reject(new Error(`DPAPI 没有返回数据：${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`))
        return
      }
      try { resolve(Buffer.from(text, 'base64')) }
      catch (cause) { reject(new Error(`DPAPI 返回的内容不是 base64：${cause.message}`)) }
    })
    child.stdin.end(stdin)
  })
}
