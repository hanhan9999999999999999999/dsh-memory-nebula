/**
 * 记忆星图的 HTTP 接口 + 静态页面。
 *
 * 全部挂在同一个源上（DSH 的 webServer），所以 iframe 里可以直接 fetch，
 * 不用处理跨域、也不用另起端口。
 */
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildShareHtml, parseShareHide, parseShareHops, parseShareScope } from './share.js'
import { buildDiagnostics, formatDiagnostics } from './diagnostics.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = join(HERE, '..', 'web')
const PKG = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8'))
  } catch {
    return {}
  }
})()

/** 插件版本（/ping 里给页面与 smoke 看版本漂移）。 */
const VERSION = String(PKG.version || '0.0.0')
/** 这一次进程是什么时候把模块读进来的 —— 排查「跑的是旧代码」比 mtime 更直接。 */
const STARTED_AT = Date.now()

/**
 * 代码指纹：lib 下所有宿主模块（不含 web）的 mtime 最大值。
 *
 * 以前只硬编码了 8 个文件，于是改 bridge.js / ledger.js / path.js 时指纹不变，
 * 页面会误判「宿主和独立引擎一样新」，继续用缺接口的旧进程。现在递归扫全量。
 */
const BUILD = (() => {
  let max = 0
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name !== 'web' && ent.name !== 'node_modules' && ent.name !== 'ingest') walk(p)
        continue
      }
      if (!/\.m?js$/.test(ent.name)) continue
      try {
        max = Math.max(max, statSync(p).mtimeMs)
      } catch {}
    }
  }
  walk(join(HERE, '..'))
  return Math.round(max)
})()

/** 这个版本提供的接口清单：旧宿主缺哪些，页面一眼能说清。 */
export const CAPABILITIES = Object.freeze([
  'ping', 'graph', 'node', 'recall', 'path', 'overview', 'mutes', 'link', 'unlink',
  'mute', 'unmute', 'bridge', 'sources', 'ingest', 'ledger', 'export', 'refresh',
  // 0.5.0：内存里的示例星系（?demo=1）与可带走的单文件快照（/share）
  'demo', 'share',
  // 1.0.0：给支持用的一键诊断（只报告版本/环境/图规模，不读正文、不带路径）
  'diagnostics',
])

const PREFIX = '/api/memory-nebula'

/**
 * 本机来源判定。写接口只接受「没有 Origin 的本机客户端（curl / 脚本）」或
 * 「loopback 页面」。一个公网网页即使能向 127.0.0.1 发 POST，也会被挡在这里，
 * 否则随便一个页面就能 mute 掉你的关联、往星图里灌垃圾。
 */
export function isLoopbackOrigin(origin) {
  if (!origin) return true
  try {
    const u = new URL(String(origin))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]'
  } catch {
    return false
  }
}

function allowWrite(req) {
  if (!isLoopbackOrigin(req.headers.origin)) return false
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
  return true
}

/** 跨端口调用（宿主页面 ↔ 独立引擎）需要 CORS；只对本机页面开放。 */
export function corsHeaders(req) {
  const origin = req.headers.origin
  if (!origin || !isLoopbackOrigin(origin)) return {}
  return { 'access-control-allow-origin': origin, vary: 'Origin' }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

/** 只允许这几个文件，避免路径穿越。 */
const STATIC = new Set(['index.html', 'style.css', 'app.js', 'api.js', 'render.js', 'space3d.js', 'i18n.js'])

function sendJson(res, status, payload, headers = {}) {
  let body
  try {
    body = Buffer.from(JSON.stringify(payload), 'utf8')
  } catch (err) {
    body = Buffer.from(JSON.stringify({ error: '序列化失败：' + (err?.message || err) }), 'utf8')
    status = 500
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(body)
}

/** 页面自身只加载同源脚本、只连本机接口；导出图走 data:/blob:。 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' http://127.0.0.1:*",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' http://127.0.0.1:*",
  "font-src 'self' data:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function sendFile(res, name) {
  const file = join(WEB_DIR, name)
  let body
  try {
    body = readFileSync(file)
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' })
    res.end('not found: ' + name)
    return
  }
  const ext = name.slice(name.lastIndexOf('.'))
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
  if (ext === '.html') {
    headers['content-security-policy'] = CSP
    headers['x-frame-options'] = 'SAMEORIGIN'
  }
  res.writeHead(200, headers)
  res.end(body)
}

/**
 * 读 JSON 请求体。返回 `{ok:true,value}` / `{ok:false,error}`，
 * 让路由能把「太大」和「不是 JSON」分别回 413 / 400，而不是一律当成空对象。
 */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    let settled = false
    const chunks = []
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish({ ok: false, error: 'too_large' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        finish({ ok: true, value: text ? JSON.parse(text) : {} })
      } catch {
        finish({ ok: false, error: 'bad_json' })
      }
    })
    req.on('error', () => finish({ ok: false, error: 'bad_body' }))
  })
}

const BODY_ERROR = {
  too_large: '请求体超过 256 KB',
  bad_json: '请求体不是合法 JSON',
  bad_body: '请求体读取失败',
}

/** 读 JSON 体；失败时已经把响应写回去了，返回 null。 */
async function jsonBody(req, res) {
  const r = await readBody(req)
  if (!r.ok) {
    sendJson(res, r.error === 'too_large' ? 413 : 400, { error: BODY_ERROR[r.error] || '请求体无效' })
    return null
  }
  return r.value && typeof r.value === 'object' ? r.value : {}
}

/**
 * 示例星系：一个只存在于内存里的 Nebula，内容来自 lib/host/demo.js。
 * 惰性创建、整进程共用一份——第一次请求时构建一次（几十毫秒），之后一直是热的。
 * 它不读盘、不写盘、不监听文件变化，所以随便谁点「看示例」都不会碰到真实记忆库。
 */
let demoPromise = null
function demoInstance() {
  if (!demoPromise) {
    demoPromise = import('./nebula.js')
      .then(async ({ Nebula }) => {
        const demo = new Nebula({ demo: true, log: () => {} })
        await demo.refresh()
        return demo
      })
      .catch((err) => {
        demoPromise = null // 构建失败别把坏结果缓存一辈子，下次请求重试
        throw err
      })
  }
  return demoPromise
}

/**
 * 注册所有路由。
 * @param {{register:(def:any)=>any}} webServer ctx.webServer
 * @param {import('./nebula.js').Nebula} nebula
 * @param {(line:string)=>void} [log]
 * @param {{mode?:'host'|'standalone'}} [info]
 */
export function registerRoutes(webServer, nebula, log = () => {}, info = {}) {
  const mode = info.mode === 'standalone' ? 'standalone' : 'host'
  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const route = url.pathname.slice(PREFIX.length) || '/'
    const method = (req.method || 'GET').toUpperCase()
    try {
      // 写接口只接受本机页面 / 本机脚本：挡掉「任意网页向 127.0.0.1 发 POST」的 CSRF。
      if (method !== 'GET' && method !== 'HEAD' && !allowWrite(req)) {
        return sendJson(res, 403, { error: '跨站写入被拒绝：写接口只接受本机页面或本机脚本' })
      }
      // ---------- 静态页面 ----------
      if (method === 'GET' && (route === '/' || route === '/app' || route === '/index.html')) {
        return sendFile(res, 'index.html')
      }
      if (method === 'GET' && route.startsWith('/') && STATIC.has(route.slice(1))) {
        return sendFile(res, route.slice(1))
      }

      // ---------- 数据 ----------
      // ?demo=1 切到内置示例星系：只读、不写盘、不碰真实记忆库。
      const demoReq = url.searchParams.get('demo') === '1'
      if (demoReq && method !== 'GET' && method !== 'HEAD') {
        return sendJson(res, 403, { error: '示例模式是只读的：不会被改动，也不会写进你的记忆库' })
      }
      const src = demoReq ? await demoInstance() : nebula

      if (method === 'GET' && route === '/diagnostics') {
        if (!src.graph || src.graph.nodes.length === 0) await src.refresh()
        const report = buildDiagnostics({
          version: VERSION,
          build: BUILD,
          startedAt: STARTED_AT,
          mode,
          demo: demoReq,
          nebula: src,
          capabilities: CAPABILITIES,
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            uptimeSec: process.uptime(),
            rssMb: process.memoryUsage().rss / 1024 / 1024,
          },
        })
        const body = Buffer.from(formatDiagnostics(report), 'utf8')
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(body.length),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        })
        return res.end(body)
      }

      if (method === 'GET' && route === '/ping') {
        if (!src.graph || src.graph.nodes.length === 0) await src.refresh()
        return sendJson(res, 200, {
          ok: true,
          version: VERSION,
          build: BUILD,
          startedAt: STARTED_AT,
          mode,
          capabilities: CAPABILITIES,
          sig: src.signature || '',
          builtAt: src.graph?.builtAt || 0,
          stats: src.graph?.stats || {},
          buildMs: src.lastBuildMs || 0,
          error: src.lastError || '',
          demo: demoReq,
        })
      }

      if (method === 'GET' && route === '/graph') {
        if (url.searchParams.get('refresh') === '1' || !src.graph || src.graph.nodes.length === 0) {
          await src.refresh({ force: url.searchParams.get('refresh') === '1' })
        }
        const graph = src.publicGraph()
        // sig 变了图才变；配合 If-None-Match 能让轮询与多标签页省掉整包重传。
        const etag = '"' + (src.signature || '0') + '-' + BUILD + '"'
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag, 'cache-control': 'no-store' })
          return res.end()
        }
        return sendJson(res, 200, { ...graph, version: VERSION, build: BUILD, sig: src.signature || '', demo: demoReq }, { etag })
      }

      if (method === 'GET' && route === '/node') {
        const id = url.searchParams.get('id') || ''
        const detail = src.detail(id)
        if (!detail) return sendJson(res, 404, { error: '没有这条记忆：' + id })
        const node = { ...detail }
        delete node.neighbors
        return sendJson(res, 200, {
          node,
          neighbors: (detail.neighbors || []).map((n) => ({ ...n, w: n.weight })),
          degree: (detail.neighbors || []).length,
          cluster: detail.cluster,
        })
      }

      if (method === 'GET' && route === '/recall') {
        const q = url.searchParams.get('q') || ''
        const seed = url.searchParams.get('seed') || ''
        const ids = url.searchParams.get('ids') || ''
        const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 12))
        const hops = Math.max(0, Math.min(3, Number(url.searchParams.get('hops')) || 2))
        const seedIds = [seed, ids].filter(Boolean).join(',').split(',').filter(Boolean)
        if (!q && seedIds.length === 0) return sendJson(res, 200, { query: '', hits: [], seeds: [] })
        const result = src.recall(q, { limit, hops, seedIds })
        return sendJson(res, 200, result)
      }

      if (method === 'GET' && route === '/path') {
        const a = url.searchParams.get('a') || ''
        const b = url.searchParams.get('b') || ''
        const hops = Math.max(1, Math.min(8, Number(url.searchParams.get('hops')) || 6))
        if (!a || !b) return sendJson(res, 400, { error: '需要 a / b' })
        return sendJson(res, 200, await src.path(a, b, { maxHops: hops }))
      }

      if (method === 'GET' && route === '/overview') {
        return sendJson(res, 200, src.overview())
      }

      if (method === 'GET' && route === '/mutes') {
        return sendJson(res, 200, { mutes: src.mutes() })
      }

      if (method === 'POST' && route === '/link') {
        const body = await jsonBody(req, res)
        if (!body) return
        if (!body.a || !body.b) return sendJson(res, 400, { error: '需要 a / b' })
        const out = src.link(body.a, body.b, body.note || '')
        await src.refresh({ force: true })
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (method === 'POST' && route === '/unlink') {
        const body = await jsonBody(req, res)
        if (!body) return
        if (!body.a || !body.b) return sendJson(res, 400, { error: '需要 a / b' })
        const ok = src.unlink(body.a, body.b)
        await src.refresh({ force: true })
        return sendJson(res, 200, { ok })
      }

      if (method === 'POST' && route === '/mute') {
        const body = await jsonBody(req, res)
        if (!body) return
        if (!body.a || !body.b) return sendJson(res, 400, { error: '需要 a / b' })
        const out = src.mute(body.a, body.b, body.note || '')
        await src.refresh({ force: true })
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (method === 'POST' && route === '/unmute') {
        const body = await jsonBody(req, res)
        if (!body) return
        if (!body.a || !body.b) return sendJson(res, 400, { error: '需要 a / b' })
        const ok = src.unmute(body.a, body.b)
        await src.refresh({ force: true })
        return sendJson(res, 200, { ok })
      }

      // ---------- 跨插件协同：补充包 / 来源体检 / 外部推送 ----------
      if (method === 'GET' && route === '/bridge') {
        const ids = (url.searchParams.get('ids') || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
        const query = (url.searchParams.get('query') || '').trim()
        if (ids.length === 0 && !query) return sendJson(res, 400, { error: '需要 ids 或 query' })
        const num = (k, d) => {
          const v = Number(url.searchParams.get(k))
          return Number.isFinite(v) && v > 0 ? v : d
        }
        const out = src.bridge({
          ids,
          query,
          sessionId: url.searchParams.get('session') || '',
          ws: url.searchParams.get('ws') || '',
          mark: url.searchParams.get('mark') === '1',
          budget: {
            maxItems: num('limit', 6),
            maxChars: num('chars', 1600),
            minWeight: num('min_weight', 0.45),
            hops: num('hops', 1),
          },
        })
        return sendJson(res, 200, out)
      }

      if (method === 'GET' && route === '/sources') {
        return sendJson(res, 200, src.sourcesReport())
      }

      if (method === 'POST' && route === '/ingest') {
        const body = await jsonBody(req, res)
        if (!body) return
        const provider = String(body.provider || '').trim()
        const items = Array.isArray(body.items) ? body.items : []
        if (!provider) return sendJson(res, 400, { error: '需要 provider' })
        if (items.length === 0) return sendJson(res, 400, { error: '需要 items' })
        if (items.length > 5000) return sendJson(res, 413, { error: '单次最多 5000 条' })
        const out = await src.ingest(provider, items)
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (method === 'GET' && route === '/ledger') {
        const session = url.searchParams.get('session') || ''
        return sendJson(res, 200, src.ledger
          ? src.ledger(session)
          : { stats: null })
      }

      if (method === 'GET' && route === '/export') {
        const format = (url.searchParams.get('format') || 'md').toLowerCase()
        const scope = (url.searchParams.get('scope') || 'all').toLowerCase()
        return sendJson(res, 200, src.exportReport({ format, scope }))
      }

      if (method === 'GET' && route === '/share') {
        // 单文件快照：一张图 + 记忆全文，内联成一个 HTML，用户主动下载到本地。
        // 不经过任何远端服务；下载完就是一份可以双击打开的只读星图。
        // ?scope=ws:<工作区> | project:<项目> | focus:<节点 id>&hops=N 只把这一片写进文件，
        // 范围外的记忆不会出现在快照的数据里——隐私不能靠前端隐藏。
        const scope = parseShareScope(url.searchParams.get('scope'))
        const hops = parseShareHops(url.searchParams.get('hops'))
        // hide 可以重复传，也可以逗号分隔；白名单校验在 parseShareHide 里，拼错直接 400。
        const hide = parseShareHide(url.searchParams.getAll('hide'))
        const { html, bytes, scope: used } = await buildShareHtml(
          src,
          { version: VERSION, build: BUILD },
          { scope, hops, hide },
        )
        // 用本地时间，和快照页面上「生成于 …」显示的一致（toISOString 是 UTC，会差 8 小时）
        const now = new Date()
        const pad = (n) => String(n).padStart(2, '0')
        const stamp = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()), pad(now.getHours()), pad(now.getMinutes())].join('-')
        const suffix = used && used.kind !== 'all' ? '-' + used.kind : ''
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(bytes),
          'content-disposition': 'attachment; filename="memory-nebula-snapshot' + suffix + '-' + stamp + '.html"',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        })
        return res.end(html)
      }

      if (method === 'POST' && route === '/refresh') {
        await src.refresh({ force: true })
        const graph = src.publicGraph()
        return sendJson(res, 200, { ...graph, version: VERSION, build: BUILD, sig: src.signature || '' })
      }

      return sendJson(res, 404, { error: '未知接口 ' + route })
    } catch (err) {
      // 引擎抛的错误带 status（比如「找不到这两条记忆」= 404）就照用，
      // 其余才是真·服务器错误。以前一律 500，前端只能显示「加载失败」。
      const status = Number(err?.status) || 500
      if (status >= 500) log(`接口 ${route} 出错：${err?.stack || err}`)
      return sendJson(res, status, { error: String(err?.message || err) })
    }
  }

  webServer.register({ kind: 'prefix', path: PREFIX, handler })
  return PREFIX
}

export { PREFIX, BUILD, VERSION, STARTED_AT }
