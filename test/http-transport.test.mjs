/**
 * 1.8.0：传输层的契约测试。
 *
 * 这些用例盯的是「大响应到底省没省」和「协商别把客户端打坏」：
 * - Accept-Encoding 的 q 值、`*`、q=0 都要按 RFC 处理，不能有头就压；
 * - 压缩后的 content-length 必须是压缩后的长度（否则浏览器截断）；
 * - ETag 要在压缩变体之间仍然可用（304 不能因为换了编码就失效）；
 * - 静态资源要能 304，HEAD 要给出头但不给 body；
 * - /export 拼错不能静默导全库；超限请求要回 413 而不是拆连接。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Nebula } from '../lib/host/nebula.js'
import { registerRoutes, PREFIX } from '../lib/host/http.js'
import { pickEncoding, isCompressibleType, mergeVary, MIN_COMPRESS_BYTES } from '../lib/host/compress.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', 'lib', 'web')

let handler = null
async function boot() {
  if (handler) return handler
  const nebula = new Nebula({ demo: true, log: () => {} })
  await nebula.refresh()
  registerRoutes({ register({ handler: h }) { handler = h } }, nebula, () => {}, { mode: 'standalone' })
  return handler
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers) {
      this.status = status
      Object.assign(this.headers, headers || {})
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
    getHeader(k) {
      return this.headers[k]
    },
    end(body) {
      if (body != null) this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    },
    get raw() {
      return Buffer.concat(this.chunks)
    },
    get body() {
      return this.raw.toString('utf8')
    },
  }
}

async function call(h, path, { method = 'GET', headers = {}, body = null, preHeaders = null } = {}) {
  const req = {
    url: PREFIX + path,
    method,
    headers: { host: '127.0.0.1:7891', origin: 'http://127.0.0.1:7891', ...headers },
  }
  if (body != null) {
    const stream = Readable.from([Buffer.from(String(body))])
    req.on = stream.on.bind(stream)
    req.pause = stream.pause.bind(stream)
    req.destroy = stream.destroy.bind(stream)
  }
  const res = makeRes()
  if (preHeaders) for (const [k, v] of Object.entries(preHeaders)) res.setHeader(k, v)
  await h(req, res)
  return res
}

function decode(res) {
  const enc = res.headers['content-encoding']
  if (!enc) return res.raw
  if (enc === 'gzip') return gunzipSync(res.raw)
  if (enc === 'br') return brotliDecompressSync(res.raw)
  if (enc === 'deflate') return inflateSync(res.raw)
  throw new Error('未知编码 ' + enc)
}

test('compress: pickEncoding 按 RFC 9110 协商', () => {
  assert.equal(pickEncoding(undefined), null)
  assert.equal(pickEncoding(''), null)
  assert.equal(pickEncoding('identity'), null)
  assert.equal(pickEncoding('gzip'), 'gzip')
  assert.equal(pickEncoding('br, gzip'), 'br')
  assert.equal(pickEncoding('gzip, br'), 'br', '顺序不影响偏好：br 体积更小')
  assert.equal(pickEncoding('gzip;q=0.9, br;q=0.4'), 'gzip', 'q 值优先')
  assert.equal(pickEncoding('*'), 'br', '通配符接受任意，仍按偏好选')
  assert.equal(pickEncoding('gzip;q=0, *'), 'br', 'q=0 是明确拒绝')
  assert.equal(pickEncoding('gzip;q=0, br;q=0, deflate;q=0'), null)
  assert.equal(pickEncoding('deflate'), 'deflate')
  assert.equal(pickEncoding('GZIP'), 'gzip', '大小写不敏感')
})

test('compress: 只压文本类，len 阈值是 1024', () => {
  assert.equal(MIN_COMPRESS_BYTES, 1024)
  for (const t of ['application/json; charset=utf-8', 'text/html', 'text/plain; charset=utf-8', 'text/javascript', 'application/javascript', 'image/svg+xml', 'application/xml']) {
    assert.equal(isCompressibleType(t), true, t)
  }
  for (const t of ['image/png', 'application/octet-stream', '', 'video/mp4', 'application/zip']) {
    assert.equal(isCompressibleType(t), false, t)
  }
})

test('compress: Vary 合并不重复、不覆盖别人', () => {
  assert.equal(mergeVary(undefined), 'accept-encoding')
  assert.equal(mergeVary('Origin'), 'Origin, accept-encoding')
  assert.equal(mergeVary('origin, accept-encoding'), 'origin, accept-encoding')
  assert.equal(mergeVary('Origin, Origin'), 'Origin, accept-encoding')
})

test('http 1.8: /graph 按 gzip / br 压缩，解压后与原响应一致', async () => {
  const h = await boot()
  const plain = await call(h, '/graph?demo=1')
  assert.equal(plain.status, 200)
  assert.equal(plain.headers['content-encoding'], undefined, '没发 Accept-Encoding 就不该压')
  assert.equal(plain.headers.vary, undefined)

  const gz = await call(h, '/graph?demo=1', { headers: { 'accept-encoding': 'gzip, deflate' } })
  assert.equal(gz.status, 200)
  assert.equal(gz.headers['content-encoding'], 'gzip')
  assert.equal(gz.headers.vary, 'accept-encoding')
  assert.equal(Number(gz.headers['content-length']), gz.raw.length, 'content-length 必须是压缩后的长度')
  assert.ok(gz.raw.length < plain.raw.length / 2, `gzip 体积没降下来：${gz.raw.length} vs ${plain.raw.length}`)
  assert.deepEqual(JSON.parse(decode(gz).toString('utf8')), JSON.parse(plain.body))

  const br = await call(h, '/graph?demo=1', { headers: { 'accept-encoding': 'br, gzip' } })
  assert.equal(br.headers['content-encoding'], 'br')
  assert.ok(br.raw.length <= gz.raw.length, 'br 不该比 gzip 大')
  assert.deepEqual(JSON.parse(decode(br).toString('utf8')), JSON.parse(plain.body))
})

test('http 1.8: 协商失败时退回 identity，而不是报错', async () => {
  const h = await boot()
  const res = await call(h, '/graph?demo=1', { headers: { 'accept-encoding': 'gzip;q=0, br;q=0, deflate;q=0' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-encoding'], undefined)
  assert.equal(JSON.parse(res.body).nodes.length, 64)
})

test('http 1.8: 压缩不影响 ETag / 304', async () => {
  const h = await boot()
  const first = await call(h, '/graph?demo=1', { headers: { 'accept-encoding': 'br' } })
  assert.match(first.headers.etag, /^W\//, '压缩后统一用弱 ETag')
  const again = await call(h, '/graph?demo=1', {
    headers: { 'accept-encoding': 'gzip', 'if-none-match': first.headers.etag },
  })
  assert.equal(again.status, 304, '换了编码也不能让缓存失效')
  assert.equal(again.raw.length, 0, '304 不能带 body')
  assert.equal(again.headers.vary, 'accept-encoding')
})

test('http 1.8: 静态资源带 ETag / 304 / 压缩，内容与磁盘一致', async () => {
  const h = await boot()
  const res = await call(h, '/app.js', { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-cache', '要能协商缓存，不能 no-store')
  assert.ok(res.headers.etag)
  assert.equal(res.headers['content-encoding'], 'gzip')
  const disk = readFileSync(join(WEB, 'app.js'))
  assert.equal(decode(res).length, disk.length)
  assert.ok(decode(res).equals(disk), '压缩不能改字节')

  const cached = await call(h, '/app.js', {
    headers: { 'accept-encoding': 'gzip', 'if-none-match': res.headers.etag },
  })
  assert.equal(cached.status, 304)
  assert.equal(cached.raw.length, 0)
  assert.equal(cached.headers.etag, res.headers.etag)
})

test('http 1.8: HEAD 走 GET 路由，只回头不给 body', async () => {
  const h = await boot()
  const page = await call(h, '/app', { method: 'HEAD' })
  assert.equal(page.status, 200, 'HEAD /app 之前是 404')
  assert.match(String(page.headers['content-type']), /text\/html/)
  assert.ok(Number(page.headers['content-length']) > 0)
  assert.equal(page.raw.length, 0)

  const graph = await call(h, '/graph?demo=1', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } })
  assert.equal(graph.status, 200)
  assert.equal(graph.headers['content-encoding'], 'gzip')
  assert.equal(graph.raw.length, 0)

  const asset = await call(h, '/style.css', { method: 'HEAD' })
  assert.equal(asset.status, 200)
  assert.equal(asset.raw.length, 0)
})

test('http 1.8: /export 拼错 format / scope 返回 400，不静默导全库', async () => {
  const h = await boot()
  const badFormat = await call(h, '/export?demo=1&format=exe')
  assert.equal(badFormat.status, 400, badFormat.body)
  assert.match(JSON.parse(badFormat.body).error, /format 只支持 md 或 json/)

  const badScope = await call(h, '/export?demo=1&scope=zzz:nope')
  assert.equal(badScope.status, 400, '未知范围类型不能当成 all')
  assert.match(JSON.parse(badScope.body).error, /未知的范围类型/)

  const bareScope = await call(h, '/export?demo=1&scope=xingang')
  assert.equal(bareScope.status, 400, '没有 kind: 的范围不能当成 all')
  assert.match(JSON.parse(bareScope.body).error, /范围要写成/)

  const emptyValue = await call(h, '/export?demo=1&scope=ws:')
  assert.equal(emptyValue.status, 400)
  assert.match(JSON.parse(emptyValue.body).error, /缺少取值/)

  // 合法的仍然要能用
  const ok = await call(h, '/export?demo=1&format=json&scope=ws:xingang')
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body).scope.kind, 'ws')
})

test('http 1.8: 压缩不覆盖 CORS 预置的 Vary: Origin', async () => {
  const h = await boot()
  // standalone 先 res.setHeader('vary','Origin')，sendBody 的 writeHead 会盖掉同名头；
  // 真机上表现为「带 Origin 的 fetch 读不到 Vary: Origin」，这里把合并逻辑钉住。
  const graph = await call(h, '/graph?demo=1', {
    headers: { 'accept-encoding': 'br' },
    preHeaders: { vary: 'Origin' },
  })
  assert.equal(graph.status, 200)
  const graphVary = String(graph.headers.vary).toLowerCase()
  assert.match(graphVary, /origin/)
  assert.match(graphVary, /accept-encoding/)

  // 小响应不压缩，但预置的 Vary 也不能被吞掉
  const ping = await call(h, '/ping', {
    headers: { 'accept-encoding': 'br' },
    preHeaders: { vary: 'Origin' },
  })
  assert.equal(ping.status, 200)
  assert.match(String(ping.headers.vary).toLowerCase(), /origin/)
})

test('http 1.8: 超限请求体回 413，不再把连接拆掉', async () => {
  const h = await boot()
  const big = 'x'.repeat(300 * 1024)
  const res = await call(h, '/link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ a: big, b: 'y' }),
  })
  assert.equal(res.status, 413, 'fetch 应该拿到 413，而不是 ECONNRESET')
  assert.equal(res.headers.connection, 'close')
  assert.match(JSON.parse(res.body).error, /256 KB/)
})
