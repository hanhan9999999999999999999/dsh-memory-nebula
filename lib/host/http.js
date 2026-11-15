/**
 * 记忆星图的 HTTP 接口 + 静态页面。
 *
 * 全部挂在同一个源上（DSH 的 webServer），所以 iframe 里可以直接 fetch，
 * 不用处理跨域、也不用另起端口。
 */
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildShareHtml, parseShareHide, parseShareHops, parseShareLimit, parseShareScope } from './share.js'
import { buildDiagnostics, formatDiagnostics } from './diagnostics.js'
import { compressBuffer, isCompressibleType, mergeVary, pickEncoding, MIN_COMPRESS_BYTES } from './compress.js'

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
  // 1.11.32：建图期间的进度（只报阶段，不阻塞）。
  'progress',
  'demo', 'share',
  // 1.0.0：给支持用的一键诊断（只报告版本/环境/图规模，不读正文、不带路径）
  'diagnostics',
])

const PREFIX = '/api/memory-nebula'

/**
 * ETag 里只能出现可见 ASCII（RFC 7232 的 opaque-tag，Node 还会更严格：
 * 非 ASCII 直接抛 ERR_INVALID_CHAR）。签名里可能有中文（来源标题、工作区目录名），
 * 所以非 ASCII 一律哈希成十六进制——语义仍是「同一个签名 → 同一个标签」。
 */
function etagSafe(text) {
  const raw = String(text || '0').replace(/["\\]/g, '')
  if (/^[\x20-\x7e]*$/.test(raw) && raw.length > 0) return raw
  return createHash('sha1').update(String(text || '0')).digest('hex').slice(0, 20)
}

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

/**
 * Host 只接受回环名。挡 DNS rebinding：恶意域名解析到 127.0.0.1 后，
 * 浏览器发出的 GET 不带 Origin，但 Host 仍是 evil.example，这里能拦住。
 */
export function isLoopbackHost(host) {
  const raw = String(host || '').trim().toLowerCase()
  if (!raw) return false
  let name = raw
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return false
    name = raw.slice(0, end + 1)
  } else {
    const colon = raw.indexOf(':')
    if (colon >= 0) name = raw.slice(0, colon)
  }
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]'
}


function allowWrite(req) {
  if (!isLoopbackOrigin(req.headers.origin)) return false
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
  return true
}

/** 可选的本机口令：常量时间比较，不把 token 写进日志。 */
function sameSecret(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

function cookieToken(req) {
  const cookie = String(req.headers.cookie || '')
  for (const part of cookie.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() !== 'nb_token') continue
    try {
      return decodeURIComponent(part.slice(at + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}

function hasToken(req, url, token) {
  const auth = String(req.headers.authorization || '')
  if (auth.startsWith('Bearer ') && sameSecret(auth.slice(7).trim(), token)) return true
  if (sameSecret(cookieToken(req), token)) return true
  return sameSecret(url.searchParams.get('token') || '', token)
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
const STATIC = new Set(['index.html', 'style.css', 'app.js', 'api.js', 'render.js', 'space3d.js', 'i18n.js', 'nav.js'])

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** 口令门的登录页：不加载任何脚本，只提交一个表单。 */
function sendUnlockPage(res, message = '', status = 401) {
  const body = Buffer.from(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>记忆星图 · 需要口令</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b12;color:#dbe7f3;
  font:15px/1.6 "Segoe UI",system-ui,sans-serif}
.card{width:min(92vw,380px);padding:28px 26px;border:1px solid #213040;border-radius:16px;
  background:linear-gradient(160deg,#0b1420,#08101a);box-shadow:0 20px 60px #0008}
h1{margin:0 0 6px;font-size:18px;letter-spacing:.02em}
p{margin:0 0 18px;color:#8fa6bd;font-size:13px}
input{width:100%;padding:11px 12px;border:1px solid #2b3d50;border-radius:10px;background:#07101a;
  color:#e8f2fb;font:inherit;outline:none}
input:focus{border-color:#3fa7a0;box-shadow:0 0 0 3px #3fa7a033}
button{width:100%;margin-top:12px;padding:11px 12px;border:0;border-radius:10px;background:#3fa7a0;
  color:#04110f;font:600 14px/1 inherit;cursor:pointer}
button:hover{background:#4dbdb5}
.err{margin:0 0 12px;color:#ff9a9a;font-size:12.5px}
.foot{margin-top:16px;color:#647b92;font-size:11.5px}
</style></head>
<body><main class="card">
<h1>需要本机口令</h1>
<p>这个独立引擎用 <code>--token</code> 启动。输入启动时设置的口令，浏览器会记住它。</p>
${message ? `<p class="err">${esc(message)}</p>` : ''}
<form method="post" action="${PREFIX}/unlock">
  <input name="token" type="password" autocomplete="current-password" autofocus required
    aria-label="本机口令" placeholder="本机口令" />
  <button type="submit">打开星图</button>
</form>
<p class="foot">口令只保存在本机 HttpOnly cookie 里；也可以继续用终端打印的带 token 地址。</p>
</main></body></html>`, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  })
  res.end(body)
}

/** 读 urlencoded 表单（口令页只收这一种）。 */
function readForm(req, limit = 8 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    let settled = false
    const chunks = []
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        // 同 readBody：停读而不是拆连接，400 页才有机会显示出来。
        req.pause?.()
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        finish(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

/**
 * 统一出口：协商压缩、带 content-length、HEAD 不出 body。
 *
 * 为什么这里要接 req：压缩取决于 Accept-Encoding，HEAD 取决于方法，
 * 而这两个信息只有请求里有。之前 sendJson 只有 res，所以 1.7.0 的大响应
 * 一直是整包未压缩下发（真实库 2000+ 条时 /graph 约 1MB）。
 */
async function sendBody(req, res, status, body, headers = {}) {
  // 头值里有非 ASCII（中文标题、签名）→ Node 会抛 ERR_INVALID_CHAR，
  // 那时头已经写出去一半，响应就再也发不完了。宁可不发这个头。
  for (const key of Object.keys(headers)) {
    const value = headers[key]
    if (value === undefined || value === null) {
      delete headers[key]
      continue
    }
    if (!/^[\x20-\x7e]*$/.test(String(value))) delete headers[key]
  }
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  const type = headers['content-type']
  const encoding = status === 304 ? null : pickEncoding(req.headers['accept-encoding'])
  const compressible =
    Boolean(encoding) && buffer.length >= MIN_COMPRESS_BYTES && isCompressibleType(type) && !headers['content-encoding']
  let payload = buffer
  const extra = {}
  if (compressible) {
    payload = await compressBuffer(buffer, encoding)
    extra['content-encoding'] = encoding
  }
  // CORS 在 standalone 里用 res.setHeader('vary','Origin') 先挂了一层；writeHead 里同名的
  // vary 会把它盖掉，所以这里要连同「已经挂在 res 上的」一起合并，不能只看 headers 参数。
  const priorVary = typeof res.getHeader === 'function' ? res.getHeader('vary') : ''
  let vary = String(priorVary || '').trim()
  if (headers.vary) vary = mergeVary(vary, headers.vary)
  if (encoding) vary = mergeVary(vary, 'accept-encoding')
  if (vary) extra.vary = vary
  // 半截请求：响应发完再断，别让 413 还没写出去就把 socket 拆了。
  if (headers.connection === 'close' && typeof res.once === 'function') {
    res.once('finish', () => {
      try {
        req.destroy?.()
      } catch {
        /* 已经断了就算了 */
      }
    })
  }
  res.writeHead(status, {
    ...headers,
    ...extra,
    'content-length': String(payload.length),
  })
  if ((req.method || 'GET').toUpperCase() === 'HEAD' || status === 204) return res.end()
  return res.end(payload)
}

async function sendJson(req, res, status, payload, headers = {}) {
  let body
  try {
    body = Buffer.from(JSON.stringify(payload), 'utf8')
  } catch (err) {
    body = Buffer.from(JSON.stringify({ error: '序列化失败：' + (err?.message || err) }), 'utf8')
    status = 500
  }
  return sendBody(req, res, status, body, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
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

/**
 * 静态资源缓存。1.8.0 起：
 * - 带 ETag（mtime+size），刷新走 304，不再每次重下 300KB 前端；
 * - 按 Accept-Encoding 压缩，压缩结果按 name:mtime:encoding 缓存，重启才失效；
 * - 支持 HEAD（探活与 CDN 预检会用到）。
 * 缓存键带 mtime，所以改了文件立刻生效，不会拿到旧字节。
 */
const STATIC_CACHE = new Map()

async function sendFile(req, res, name) {
  const file = join(WEB_DIR, name)
  const ext = name.slice(name.lastIndexOf('.'))
  const type = MIME[ext] || 'application/octet-stream'
  let stat
  let raw
  try {
    stat = statSync(file)
    raw = readFileSync(file)
  } catch {
    return sendBody(req, res, 404, 'not found: ' + name, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
  }
  const etag = '"' + Math.round(stat.mtimeMs).toString(36) + '-' + stat.size.toString(36) + '"'
  const headers = {
    'content-type': type,
    'cache-control': 'no-cache',
    etag,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
  if (ext === '.html') {
    headers['content-security-policy'] = CSP
    headers['x-frame-options'] = 'SAMEORIGIN'
  }
  const inm = String(req.headers['if-none-match'] || '')
  if (inm && inm.split(',').some((tag) => tag.trim() === etag || tag.trim() === 'W/' + etag)) {
    return sendBody(req, res, 304, '', { ...headers, vary: 'accept-encoding' })
  }
  const encoding = pickEncoding(req.headers['accept-encoding'])
  if (encoding && raw.length >= MIN_COMPRESS_BYTES && isCompressibleType(type)) {
    const key = name + ':' + Math.round(stat.mtimeMs) + ':' + encoding
    let zipped = STATIC_CACHE.get(key)
    if (!zipped) {
      zipped = await compressBuffer(raw, encoding)
      // 文件不多，直接清掉同名旧版本即可，别让 Map 无限长
      for (const k of STATIC_CACHE.keys()) if (k.startsWith(name + ':')) STATIC_CACHE.delete(k)
      STATIC_CACHE.set(key, zipped)
    }
    headers['content-encoding'] = encoding
    headers.vary = 'accept-encoding'
    return sendBody(req, res, 200, zipped, headers)
  }
  return sendBody(req, res, 200, raw, headers)
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
        // 只停读、不断连接：先让 413 写得出去。以前这里直接 req.destroy()，
        // 客户端看到的是 ECONNRESET / fetch failed，而不是「请求体太大」。
        req.pause?.()
        finish({ ok: false, error: 'too_large' })
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
    const tooLarge = r.error === 'too_large'
    await sendJson(
      req,
      res,
      tooLarge ? 413 : 400,
      { error: BODY_ERROR[r.error] || '请求体无效' },
      // 请求体还没读完就回错误，告诉客户端这条连接到此为止；
      // sendBody 会在响应 finish 之后再断开，不会把 413 自己吞掉。
      tooLarge ? { connection: 'close' } : {},
    )
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
 * 解析 /graph 的分页参数。
 *
 * 约定：limit=0 / 不带参数 = 交给服务端决定（大图默认第一页 20000）。
 * 只要是数字就一定得是干净的正整数——「abc」「1.5」「-3」都报 400，
 * 免得前端拼错参数时静默拿到整库（5 万条时那是 44MB）。
 * @param {URLSearchParams} sp
 * @returns {{limit:number, offset:number, error?:string}}
 */
function readPageArgs(sp) {
  const bad = (error) => ({ limit: 0, offset: 0, error })
  let limit = 0
  let offset = 0
  const rawLimit = sp.get('limit')
  if (rawLimit != null && rawLimit !== '') {
    if (!/^\d+$/.test(rawLimit)) return bad('limit 需要 0–50000 的整数')
    limit = Number(rawLimit)
    if (limit > 50000) return bad('limit 不能超过 50000，请分页加载')
  }
  const rawOffset = sp.get('offset')
  if (rawOffset != null && rawOffset !== '') {
    if (!/^\d+$/.test(rawOffset)) return bad('offset 需要非负整数')
    offset = Number(rawOffset)
  }
  return { limit, offset }
}

/**
 * 注册所有路由。
 * @param {{register:(def:any)=>any}} webServer ctx.webServer
 * @param {import('./nebula.js').Nebula} nebula
 * @param {(line:string)=>void} [log]
 * @param {{mode?:'host'|'standalone', connection?:{requestRejection:(req:any)=>number|undefined}}} [info]
 */
export function registerRoutes(webServer, nebula, log = () => {}, info = {}) {
  const mode = info.mode === 'standalone' ? 'standalone' : 'host'
  const connection = info.connection && typeof info.connection.requestRejection === 'function' ? info.connection : null
  const token = typeof info.token === 'string' ? info.token : ''
  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const route = url.pathname.slice(PREFIX.length) || '/'
    // HEAD 按 GET 处理：同一套路由、同样的头与 content-length，只是不出 body。
    // 探活脚本、CDN 预检、`curl -I` 都走这条路，之前 HEAD /app 会掉进 404。
    const method = (req.method || 'GET').toUpperCase() === 'HEAD' ? 'GET' : (req.method || 'GET').toUpperCase()
    try {
      // DNS rebinding：GET 不带 Origin，但 Host 会带着攻击者的域名。
      if (!isLoopbackHost(req.headers.host)) {
        return sendJson(req, res, 403, { error: '只接受来自本机的请求：请通过 127.0.0.1 或 localhost 打开' })
      }
      // 口令登录：表单只能从本机页面提交；正确时种 cookie，再 302 回页面。
      // 有些浏览器对 401 页上的表单会发 `Origin: null`，所以这里不套用写接口的
      // Origin 规则——口令本身就是凭据，猜不中就没有副作用。
      if (token && method === 'POST' && route === '/unlock') {
        const form = await readForm(req)
        if (!form) return sendUnlockPage(res, '表单读取失败，再试一次', 400)
        if (!sameSecret(form.get('token') || '', token)) {
          return sendUnlockPage(res, '口令不对，再试一次')
        }
        res.setHeader(
          'set-cookie',
          `nb_token=${encodeURIComponent(token)}; Path=${PREFIX}; HttpOnly; SameSite=Strict`,
        )
        res.writeHead(302, { location: PREFIX + '/app', 'cache-control': 'no-store' })
        return res.end()
      }
      // 可选的本机口令：standalone 可以用 --token 打开；宿主模式默认不启用。
      if (token) {
        const fromQuery = sameSecret(url.searchParams.get('token') || '', token)
        if (fromQuery) {
          res.setHeader(
            'set-cookie',
            `nb_token=${encodeURIComponent(token)}; Path=${PREFIX}; HttpOnly; SameSite=Strict`,
          )
        }
        if (!fromQuery && !hasToken(req, url, token)) {
          // 浏览器直接打开页面时给一个输口令的入口；接口仍然回 JSON 401。
          if (method === 'GET' && (route === '/' || route === '/app' || route === '/index.html')) {
            return sendUnlockPage(res)
          }
          return sendJson(req, res, 401, {
            error: '需要本机口令：用启动时打印的带 token 的地址打开一次，或发送 Authorization: Bearer <token>',
          })
        }
      }
      // 宿主内再走一遍 DSH 的 Host/Origin + 已认证 Peer 围栏；独立引擎没有这个服务。
      if (connection) {
        const rejection = connection.requestRejection(req)
        if (rejection) {
          return sendJson(req, res, rejection, {
            error:
              rejection === 401
                ? '这个视图需要从 DSH 里打开：当前请求没有通过宿主认证'
                : '宿主拒绝了这次请求：Host / Origin 不在可信范围',
          })
        }
      }
      // 写接口只接受本机页面 / 本机脚本：挡掉「任意网页向 127.0.0.1 发 POST」的 CSRF。
      if (method !== 'GET' && method !== 'HEAD' && !allowWrite(req)) {
        return sendJson(req, res, 403, { error: '跨站写入被拒绝：写接口只接受本机页面或本机脚本' })
      }
      // ---------- 静态页面 ----------
      if (method === 'GET' && (route === '/' || route === '/app' || route === '/index.html')) {
        return sendFile(req, res, 'index.html')
      }
      if (method === 'GET' && route.startsWith('/') && STATIC.has(route.slice(1))) {
        return sendFile(req, res, route.slice(1))
      }

      // ---------- 数据 ----------
      // ?demo=1 切到内置示例星系：只读、不写盘、不碰真实记忆库。
      const demoReq = url.searchParams.get('demo') === '1'
      if (demoReq && method !== 'GET' && method !== 'HEAD') {
        return sendJson(req, res, 403, { error: '示例模式是只读的：不会被改动，也不会写进你的记忆库' })
      }
      const src = demoReq ? await demoInstance() : nebula

      if (method === 'GET' && route === '/diagnostics') {
        if (!src.graph || src.graph.nodes.length === 0) await src.refresh()
        const report = buildDiagnostics({
          version: VERSION,
          build: BUILD,
          startedAt: STARTED_AT,
          mode,
          demo: demoReq || Boolean(src.demo),
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
        const wantsJson = url.searchParams.get('format') === 'json'
        const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'zh'
        const body = Buffer.from(
          wantsJson ? JSON.stringify(report) : formatDiagnostics(report, { lang }),
          'utf8',
        )
        return sendBody(req, res, 200, body, {
          'content-type': wantsJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        })
      }

      if (method === 'GET' && route === '/progress') {
        // 建图期间也要能问，所以这条路由**不等待**建图：
        // 冷启动那几秒 /ping 和 /graph 都卡着，界面靠这里说清走到哪一步。
        return sendJson(req, res, 200, {
          ok: true,
          building: Boolean(src.building),
          progress: src.buildProgress || null,
          nodes: src.graph ? src.graph.nodes.length : 0,
          stale: Boolean(src.staleGraph),
          scale: src.scale || null,
          at: Date.now(),
        })
      }

      if (method === 'GET' && route === '/ping') {
        if (!src.graph || src.graph.nodes.length === 0) await src.refresh()
        return sendJson(req, res, 200, {
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
          scale: src.scale || null,
          error: src.lastError || '',
          demo: demoReq || Boolean(src.demo),
        })
      }

      if (method === 'GET' && route === '/graph') {
        // 1.9.0 分页：limit/offset 必须是明确的整数，拼错要报错而不是静默全量。
        const pageArgs = readPageArgs(url.searchParams)
        if (pageArgs.error) return sendJson(req, res, 400, { error: pageArgs.error })
        const { limit, offset } = pageArgs
        // 客户端带 sig 回来 = 「我接着上一页继续加载」；图在这期间重建过就必须从头来，
        // 否则按排名切片会串页（第 2 页拿到的是新图里排名相同的另一批节点）。
        const wantSig = String(url.searchParams.get('sig') || '')
        // 1.11.24：refresh=1 的语义是「看看有没有新东西」，不是「不管怎样都重建」。
        // 以前这里同样传 force:true，于是每打开一次页面（reload(false) 走这条路）
        // 都要白跑一遍全量建图。真要强制重建用 ?force=1。
        const wantRefresh = url.searchParams.get('refresh') === '1'
        const forceRebuild = url.searchParams.get('force') === '1'
        // 1.11.30：手上已经有一张图时，refresh=1 不再等建完——
        // 五万条库上那要五秒多，先给旧图（带着 refreshing 标记），新图建好页面自己来换。
        // 只有「还没图」和「显式 force」两条路继续等：前者没东西可给，后者是主人点了重建。
        if (forceRebuild || !src.graph || src.graph.nodes.length === 0) {
          await src.refresh({ force: forceRebuild })
        } else if (wantRefresh || src.staleGraph) {
          // staleGraph：手上这张是重启时从过期缓存恢复的旧图，页面已经把它画出来了，
          // 现在就该在后台把新的建起来 —— 不能等轮询或其他请求来才发现。
          src.refreshInBackground({})
        }
        if (wantSig && src.signature && wantSig !== src.signature) {
          return sendJson(req, res, 409, {
            error: '图已更新，请从第一页重新加载',
            sig: src.signature,
          })
        }
        const graph = src.publicGraph({ limit, offset })
        // sig 变了图才变；配合 If-None-Match 能让轮询与多标签页省掉整包重传。
        // 1.8.0 起响应可能被压缩，同一个 sig 会有「未压缩 / br / gzip」几种表示，
        // 所以改成弱 ETag：语义仍是「内容没变」，具体变体由 Vary 区分。
        // 1.9.0 把分页参数也编进 ETag：整图和某一页不是同一个表示，不能互相 304。
        const pageTag = limit || offset ? '-p' + offset + '-' + limit : ''
        const etag = 'W/"' + etagSafe(src.signature) + '-' + BUILD + pageTag + '"'
        const inm = String(req.headers['if-none-match'] || '')
        if (inm && inm.split(',').some((tag) => tag.trim() === etag)) {
          return sendBody(req, res, 304, '', { etag, 'cache-control': 'no-cache', vary: 'accept-encoding' })
        }
        return sendJson(req, res, 200, { ...graph, version: VERSION, build: BUILD, sig: src.signature || '', refreshing: Boolean(src.building), stale: Boolean(src.staleGraph), demo: demoReq || Boolean(src.demo) }, { etag, 'cache-control': 'no-cache' })
      }

      if (method === 'GET' && route === '/node') {
        const id = url.searchParams.get('id') || ''
        const detail = src.detail(id)
        if (!detail) return sendJson(req, res, 404, { error: '没有这条记忆：' + id })
        const node = { ...detail }
        delete node.neighbors
        return sendJson(req, res, 200, {
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
        if (!q && seedIds.length === 0) return sendJson(req, res, 200, { query: '', hits: [], seeds: [] })
        // 第一次查 5 万条的库时，词频表要 1.3 秒；异步版按 6ms 一片灌，不按住事件循环。
        const result = await src.recallAsync(q, { limit, hops, seedIds })
        return sendJson(req, res, 200, result)
      }

      if (method === 'GET' && route === '/path') {
        const a = url.searchParams.get('a') || ''
        const b = url.searchParams.get('b') || ''
        const hops = Math.max(1, Math.min(8, Number(url.searchParams.get('hops')) || 6))
        if (!a || !b) return sendJson(req, res, 400, { error: '需要 a / b' })
        return sendJson(req, res, 200, await src.path(a, b, { maxHops: hops }))
      }

      if (method === 'GET' && route === '/overview') {
        return sendJson(req, res, 200, await src.overviewAsync())
      }

      if (method === 'GET' && route === '/mutes') {
        return sendJson(req, res, 200, { mutes: src.mutes() })
      }

      if (method === 'POST' && route === '/link') {
        const body = await jsonBody(req, res)
        if (!body) return
        if (!body.a || !body.b) return sendJson(req, res, 400, { error: '需要 a / b' })
        // 策展一条关联就地生效（冻结 now 下与全量重建逐边相同：正好 +1 条），不再重建整张图
        const out = src.link(body.a, body.b, body.note || '')
        return sendJson(req, res, 200, { ok: true, ...out })
      }

      if (method === 'POST' && route === '/unlink') {
        const body = await jsonBody(req, res)
        if (!body) return
        if (!body.a || !body.b) return sendJson(req, res, 400, { error: '需要 a / b' })
        const ok = src.unlink(body.a, body.b)
        return sendJson(req, res, 200, { ok })
      }

      if (method === 'POST' && route === '/mute') {
        const body = await jsonBody(req, res)
        if (!body) return
        if (!body.a || !body.b) return sendJson(req, res, 400, { error: '需要 a / b' })
        // 屏蔽就地删掉这一条（剪枝腾出的空位不补；下次重建时自然补位）
        const out = src.mute(body.a, body.b, body.note || '')
        return sendJson(req, res, 200, { ok: true, ...out })
      }

      if (method === 'POST' && route === '/unmute') {
        const body = await jsonBody(req, res)
        if (!body) return
        if (!body.a || !body.b) return sendJson(req, res, 400, { error: '需要 a / b' })
        const ok = src.unmute(body.a, body.b)
        // 撤销屏蔽：当初删掉的那条边能原样放回就地放回（毫秒级）；放不回去才重算一遍。
        if (ok && src.takeRebuildFlag()) await src.refresh({ force: true })
        return sendJson(req, res, 200, { ok })
      }

      // ---------- 跨插件协同：补充包 / 来源体检 / 外部推送 ----------
      if (method === 'GET' && route === '/bridge') {
        const ids = (url.searchParams.get('ids') || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
        const query = (url.searchParams.get('query') || '').trim()
        if (ids.length === 0 && !query) return sendJson(req, res, 400, { error: '需要 ids 或 query' })
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
        return sendJson(req, res, 200, out)
      }

      if (method === 'GET' && route === '/sources') {
        return sendJson(req, res, 200, src.sourcesReport())
      }

      if (method === 'POST' && route === '/ingest') {
        const body = await jsonBody(req, res)
        if (!body) return
        const provider = String(body.provider || '').trim()
        const items = Array.isArray(body.items) ? body.items : []
        if (!provider) return sendJson(req, res, 400, { error: '需要 provider' })
        if (items.length === 0) return sendJson(req, res, 400, { error: '需要 items' })
        if (items.length > 5000) return sendJson(req, res, 413, { error: '单次最多 5000 条' })
        const out = await src.ingest(provider, items)
        return sendJson(req, res, 200, { ok: true, ...out })
      }

      if (method === 'GET' && route === '/ledger') {
        const session = url.searchParams.get('session') || ''
        return sendJson(req, res, 200, src.ledger
          ? src.ledger(session)
          : { stats: null })
      }

      if (method === 'GET' && route === '/export') {
        const format = (url.searchParams.get('format') || 'md').toLowerCase()
        // 不要 toLowerCase 整个 scope：工作区/项目名可能是大小写敏感的中英文混合。
        const scope = (url.searchParams.get('scope') || 'all').trim()
        const hops = Number(url.searchParams.get('hops')) || 2
        const report = src.exportReport({ format, scope, hops })
        if (report && report.error) return sendJson(req, res, 400, report)
        return sendJson(req, res, 200, report)
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
        // 分片上限：5 万条整库快照约 40MB，默认只写前 2 万条（按重要度），并在页面上写明已裁剪
        const limit = parseShareLimit(url.searchParams.get('limit'))
        const { html, scope: used } = await buildShareHtml(
          src,
          { version: VERSION, build: BUILD },
          { scope, hops, hide, limit },
        )
        // 用本地时间，和快照页面上「生成于 …」显示的一致（toISOString 是 UTC，会差 8 小时）
        const now = new Date()
        const pad = (n) => String(n).padStart(2, '0')
        const stamp = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()), pad(now.getHours()), pad(now.getMinutes())].join('-')
        const suffix = used && used.kind !== 'all' ? '-' + used.kind : ''
        return sendBody(req, res, 200, Buffer.from(html, 'utf8'), {
          'content-type': 'text/html; charset=utf-8',
          'content-disposition': 'attachment; filename="memory-nebula-snapshot' + suffix + '-' + stamp + '.html"',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        })
      }

      if (method === 'POST' && route === '/refresh') {
        // 1.11.24：默认先比指纹，没变就直接把现有图还回去。
        // 以前这里一律 force:true，用户按一次「重建星图」就要白付 5 秒 CPU，
        // 而磁盘上一个字节都没动。真要强制重建就带 ?force=1。
        const force = url.searchParams.get('force') === '1'
        const rebuilt = await src.refresh({ force })
        const last = src.lastRefresh || {}
        const graph = src.publicGraph()
        return sendJson(req, res, 200, {
          ...graph,
          version: VERSION,
          build: BUILD,
          sig: src.signature || '',
          rebuilt,
          // 三态照实说：重建 / 没变 / 等别人建完。界面不该把后两种混成一句话。
          unchanged: Boolean(last.rebuilt) === false && last.why === 'unchanged',
          why: last.why || '',
          refreshMs: Number(last.ms) || 0,
        })
      }

      return sendJson(req, res, 404, { error: '未知接口 ' + route })
    } catch (err) {
      // 引擎抛的错误带 status（比如「找不到这两条记忆」= 404）就照用，
      // 其余才是真·服务器错误。以前一律 500，前端只能显示「加载失败」。
      const status = Number(err?.status) || 500
      if (status >= 500) log(`接口 ${route} 出错：${err?.stack || err}`)
      return sendJson(req, res, status, { error: String(err?.message || err) })
    }
  }

  webServer.register({ kind: 'prefix', path: PREFIX, handler })
  return PREFIX
}

export { PREFIX, BUILD, VERSION, STARTED_AT }
