#!/usr/bin/env node
// 独立星云服务：宿主进程里跑的还是旧代码时，页面可以打这个端口拿到最新引擎。
// 启动：node lib/standalone.mjs --port 7890 [--root <额外扫描目录>] [--log <日志文件>]
//
// 只监听 127.0.0.1；跨端口调用（DSH 页面 → 这里）按 loopback Origin 放行，
// 公网页面既读不到数据（不发 CORS），也写不进来（http.js 的 allowWrite 会 403）。
import http from 'node:http'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Nebula } from './host/nebula.js'
import { registerRoutes, corsHeaders, isLoopbackOrigin, VERSION, BUILD } from './host/http.js'
import { buildDiagnostics, formatDiagnostics } from './host/diagnostics.js'
import { buildShareHtml, parseShareHide, parseShareHops, parseShareScope } from './host/share.js'

const PREFIX = '/api/memory-nebula'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const value = process.argv[i + 1]
  if (!value || value.startsWith('--')) {
    console.error(`--${name} 后面需要一个值`)
    process.exit(2)
  }
  return value
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`记忆星图独立引擎 v${VERSION}

用法：memory-nebula [选项]
  --port <n>    监听端口，默认 7890（只绑 127.0.0.1）
  --root <dir>  额外扫描根目录，逗号分隔多个；默认当前目录
  --log <file>  把启动与重建日志追加到这个文件（后台运行时用）
  --diagnose    只跑一次建图，打印可贴给支持的诊断（不含正文），然后退出
  --json       配合 --diagnose：输出机器可读 JSON
  --lang <zh|en> 配合 --diagnose：诊断说明语言，默认 zh
  --export <file> 只跑一次建图，写出 md / json 报告，然后退出
  --format <fmt>  配合 --export：md（默认）或 json；按扩展名推断
  --share <file> 只跑一次建图，写出单文件 HTML 快照，然后退出
  --scope <s>   配合 --share：all / ws:<工作区> / project:<项目> / focus:<节点 id>
  --hops <n>    配合 --share 的 focus：扩散跳数 1-5，默认 2
  --hide <rule> 配合 --share：隐藏规则，可逗号分隔，如 ws:日记,level:lesson
  --demo        用内置 64 条示例记忆（只读，不碰真实库）
  --token <s>   可选本机口令（至少 12 字符）；也可用 NEBULA_TOKEN
  -h, --help    显示这段帮助
  -v, --version 显示版本

打开 http://127.0.0.1:<port>/app 查看星云。`)
  process.exit(0)
}
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(VERSION)
  process.exit(0)
}

const port = Number(arg('port', '7890'))
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`端口无效：${arg('port', '7890')}（应为 1-65535）`)
  process.exit(2)
}

// roots 是「额外扫描根目录」，可以逗号分隔多个；默认当前目录。
const roots = String(arg('root', process.cwd()))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// 可选本机口令：只对 standalone 生效；宿主内使用 DSH 的 connection 围栏。
const token = String(arg('token', '') || process.env.NEBULA_TOKEN || '')
if (token && token.length < 12) {
  console.error('--token 至少 12 个字符：短口令挡不住本机暴力尝试')
  process.exit(2)
}

const logFile = arg('log', '')
let logBroken = false
if (logFile) {
  try {
    mkdirSync(dirname(logFile), { recursive: true })
  } catch {
    // 建不了目录就让下面第一次写入时报出来
  }
}
const log = (m) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`
  if (!logFile) {
    console.log(line)
    return
  }
  try {
    appendFileSync(logFile, line + '\n')
  } catch (err) {
    // 写不了日志也不能让引擎停摆；但至少说一次，别让人以为它没启动。
    if (!logBroken) {
      logBroken = true
      console.error(`日志写不进去：${logFile}（${err?.message || err}），改为输出到控制台`)
    }
    console.log(line)
  }
}
process.on('uncaughtException', (err) => {
  log(`崩溃：${err?.stack || err}`)
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  log(`未处理的 Promise 拒绝：${err?.stack || err}`)
})


// 报告导出：不启动端口，建一次图后写 md/json；与 /export 走同一个 exportReport。
if (process.argv.includes('--export')) {
  const out = arg('export', '')
  if (!out) {
    console.error('--export 需要输出文件，例如 --export nebula.json')
    process.exit(2)
  }
  const demo = process.argv.includes('--demo')
  const probe = new Nebula({ roots, demo, log: () => {} })
  const ok = await probe.refresh()
  if (!ok && !demo) {
    console.error('建图失败，报告没有写出；先跑 --diagnose 看原因')
    probe.stopWatching?.()
    process.exit(1)
  }
  const inferred = out.toLowerCase().endsWith('.json') ? 'json' : 'md'
  const format = (arg('format', '') || inferred).toLowerCase()
  if (format !== 'md' && format !== 'json') {
    console.error('--format 只支持 md 或 json')
    probe.stopWatching?.()
    process.exit(2)
  }
  const scope = arg('scope', 'all')
  const hops = Number(arg('hops', '2')) || 2
  const report = probe.exportReport({ format, scope, hops })
  if (report?.error) {
    console.error(`报告没有写出：${report.error}`)
    probe.stopWatching?.()
    process.exit(2)
  }
  const text = format === 'json' ? JSON.stringify(report, null, 2) : report.text
  writeFileSync(out, text)
  console.log(`已写出 ${out}：${report.stats.nodes} 节点 / ${report.stats.edges} 连接 / ${Buffer.byteLength(text)} 字节${scope !== 'all' ? `（${scope}）` : ''}${demo ? '（示例库）' : ''}`)
  probe.stopWatching?.()
  process.exit(0)
}

// 单文件快照：不启动端口，建一次图后写出自包含 HTML，适合 CI / 定时归档。
if (process.argv.includes('--share')) {
  const out = arg('share', '')
  const demo = process.argv.includes('--demo')
  const probe = new Nebula({ roots, demo, log: () => {} })
  const ok = await probe.refresh()
  if (!ok && !demo) {
    console.error('建图失败，快照没有写出；先跑 --diagnose 看原因')
    probe.stopWatching?.()
    process.exit(1)
  }
  try {
    const scope = parseShareScope(arg('scope', 'all'))
    const hops = parseShareHops(arg('hops', '2'))
    const hide = parseShareHide(arg('hide', ''))
    const result = await buildShareHtml(probe, { version: VERSION, build: BUILD }, { scope, hops, hide })
    writeFileSync(out, result.html)
    console.log(`已写出 ${out}：${result.nodes} 节点 / ${result.edges} 连接 / ${result.bytes} 字节${demo ? '（示例库）' : ''}`)
    probe.stopWatching?.()
    process.exit(0)
  } catch (err) {
    console.error(`快照没有写出：${err?.message || err}`)
    probe.stopWatching?.()
    process.exit(err?.status === 400 ? 2 : 1)
  }
}

// 一键诊断：建一次图，打印版本/环境/来源/规模/最近错误，不启动端口、不读正文。
if (process.argv.includes('--diagnose')) {
  const probe = new Nebula({ roots, log: () => {} })
  const ok = await probe.refresh()
  const report = buildDiagnostics({
    version: VERSION,
    build: BUILD,
    startedAt: Date.now(),
    mode: 'standalone-cli',
    nebula: probe,
    capabilities: ['graph', 'node', 'recall', 'path', 'overview', 'share', 'diagnostics'],
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSec: process.uptime(),
      rssMb: process.memoryUsage().rss / 1024 / 1024,
    },
  })
  console.log(
    process.argv.includes('--json')
      ? JSON.stringify(report)
      : formatDiagnostics(report, { lang: arg('lang', 'zh') === 'en' ? 'en' : 'zh' }),
  )
  probe.stopWatching?.()
  process.exit(ok ? 0 : 1)
}

// 先确认端口能用，再花两秒建图：端口冲突时不该先扫一遍全盘再报错。
await new Promise((resolve, reject) => {
  const probe = http.createServer()
  probe.once('error', reject)
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
}).catch((err) => {
  if (err && err.code === 'EADDRINUSE') log(`端口 ${port} 已被占用：换 --port，或先关掉上一个独立引擎`)
  else log(`启动失败：${err?.message || err}`)
  process.exit(1)
})

const nebula = new Nebula({ roots, log })
await nebula.refresh()
nebula.startWatching(30000)
log(`engine v${VERSION} build ${BUILD} ready: ${nebula.graph?.nodes?.length ?? 0} nodes`)

let prefixHandler = null
registerRoutes({ register: (def) => { prefixHandler = def.handler } }, nebula, log, { mode: 'standalone', token })

const server = http.createServer((req, res) => {
  // DSH 页面（另一个端口）会直接打这里；只对本机来源发 CORS，别的站点连读都读不到。
  for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v)
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  res.setHeader('access-control-max-age', '600')

  if (req.method === 'OPTIONS') {
    if (req.headers.origin && !isLoopbackOrigin(req.headers.origin)) {
      res.writeHead(403).end()
      return
    }
    res.writeHead(204).end()
    return
  }

  const parsed = new URL(req.url || '/', 'http://x')
  const path = parsed.pathname
  if (path === '/' || path === '/app') {
    req.url = `${PREFIX}/index.html`
  } else if (!path.startsWith(PREFIX)) {
    // 允许 /style.css 这类相对引用，同时把 query 原样带过去
    req.url = `${PREFIX}${path}${parsed.search}`
  }
  if (!prefixHandler) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('route not ready')
    return
  }
  prefixHandler(req, res)
})

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') log(`端口 ${port} 已被占用：换 --port，或先关掉上一个独立引擎`)
  else log(`启动失败：${err?.message || err}`)
  nebula.stopWatching?.()
  process.exitCode = 1
})

server.listen(port, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${port}/app`
  log(`standalone on ${token ? `${base}?token=${encodeURIComponent(token)}` : base}`)
})

const bye = () => {
  try { nebula.stopWatching?.() } catch {}
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref?.()
}
process.on('SIGTERM', bye)
process.on('SIGINT', bye)
