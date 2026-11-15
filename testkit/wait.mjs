// 测试用的小工具：等条件成立，而不是「睡够某个毫秒数」。
// CI 机器比本机慢、而且 node --test 会把多个测试文件并发跑，固定 sleep 迟早会在别人机器上红一次。
import { createServer } from 'node:net'

export async function waitFor(label, check, { timeoutMs = 20000, intervalMs = 20 } = {}) {
  const started = Date.now()
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await check()) return true
    if (Date.now() - started > timeoutMs) {
      throw new Error('等不到「' + label + '」：' + timeoutMs + 'ms 内条件一直不成立（机器慢或那段代码真的没跑起来）')
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// 让系统给一个空闲端口：固定端口在 CI 上是抽奖（谁先占着谁红）。
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// sidecar.ps1 有个「端口按完整一段比对」的测例，需要一对「前缀关系」的端口：
// 6341 与 63411（短的那个是长的那个的开头）。这里按同样的形状随机取，避免撞到别人。
export async function freePortPair() {
  for (let i = 0; i < 40; i += 1) {
    const base = 2000 + Math.floor(Math.random() * 6000) // 2000–7999
    const long = Number(String(base) + '1')
    if (long > 65535) continue
    // eslint-disable-next-line no-await-in-loop
    if ((await portFree(base)) && (await portFree(long))) return { short: base, long }
  }
  throw new Error('找不到一对空闲的前缀端口')
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}
