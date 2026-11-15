/**
 * 1.9.0：/graph 分页的 HTTP 契约。
 *
 * 盯三件事：
 * - 分页参数必须是干净整数，拼错要 400（静默按整库返回在 5 万条时是 44MB）；
 * - 客户端带回来的 sig 与当前图不符时给 409，让它从头来，别按旧排名拼页；
 * - 整图和某一页的 ETag 不能相同，否则 304 会把「第 2 页」当成「整图」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Nebula } from '../lib/host/nebula.js'
import { registerRoutes, PREFIX } from '../lib/host/http.js'

let ctx = null
async function boot() {
  if (ctx) return ctx
  const nebula = new Nebula({ demo: true, log: () => {} })
  await nebula.refresh()
  let handler = null
  registerRoutes({ register({ handler: h }) { handler = h } }, nebula, () => {}, { mode: 'standalone' })
  ctx = { nebula, handler }
  return ctx
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
    get body() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
  }
}

async function call(path, headers = {}) {
  const { handler } = await boot()
  const req = { url: PREFIX + path, method: 'GET', headers: { host: '127.0.0.1:7891', origin: 'http://127.0.0.1:7891', ...headers } }
  const res = makeRes()
  await handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {}
  return { ...res, json }
}

test('分页参数：拼错一律 400，并说清楚要什么', async () => {
  const cases = [
    ['?limit=abc', 'limit'],
    ['?limit=1.5', 'limit'],
    ['?limit=60000', '50000'],
    ['?offset=-1', 'offset'],
    ['?offset=2.5', 'offset'],
  ]
  for (const [qs, needle] of cases) {
    const res = await call('/graph' + qs)
    assert.equal(res.status, 400, qs + ' 应当 400，实际 ' + res.status)
    assert.ok(String(res.json?.error || '').includes(needle), qs + ' 的报错要提到 ' + needle)
  }
})

test('分页参数：limit=0 与不传等价（交给服务端决定）', async () => {
  const a = await call('/graph')
  const b = await call('/graph?limit=0')
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal(a.json.nodes.length, b.json.nodes.length)
})

test('分页：只回一页，page 字段能对上', async () => {
  const { nebula } = await boot()
  const total = nebula.graph.nodes.length
  const res = await call('/graph?limit=7&offset=0')
  assert.equal(res.status, 200)
  assert.equal(res.json.nodes.length, Math.min(7, total))
  assert.deepEqual(
    { total: res.json.page.total, offset: res.json.page.offset, limit: res.json.page.limit },
    { total, offset: 0, limit: Math.min(7, total) }
  )
  assert.equal(res.json.page.next, total > 7 ? 7 : null)
})

test('分页：第二页的边不会指向没加载的节点', async () => {
  const { nebula } = await boot()
  const total = nebula.graph.nodes.length
  if (total < 4) return
  const res = await call('/graph?limit=4&offset=4')
  assert.equal(res.status, 200)
  const ids = new Set(res.json.nodes.map((n) => n.id))
  for (const e of res.json.edges) {
    if (typeof e.s === 'number') {
      assert.ok(res.json.nodes[e.s] && res.json.nodes[e.d])
    } else {
      assert.ok(ids.has(e.a) || ids.has(e.b), '跨页边至少一端已加载')
    }
  }
})

test('分页：sig 与当前图不符 → 409，并回最新 sig', async () => {
  const { nebula } = await boot()
  const res = await call('/graph?limit=5&sig=stale-signature')
  assert.equal(res.status, 409)
  assert.ok(String(res.json?.error || '').includes('重新加载'))
  assert.equal(res.json.sig, nebula.signature)
})

test('分页：sig 正确时正常返回', async () => {
  const { nebula } = await boot()
  const res = await call('/graph?limit=5&sig=' + encodeURIComponent(nebula.signature))
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.json.nodes))
})

test('分页：整图与某一页的 ETag 不同', async () => {
  const full = await call('/graph')
  const page = await call('/graph?limit=5')
  assert.equal(full.status, 200)
  assert.notEqual(full.headers.etag, page.headers.etag)
  // 拿整图的 ETag 去问某一页，不能拿到 304
  const again = await call('/graph?limit=5', { 'if-none-match': full.headers.etag })
  assert.equal(again.status, 200)
})

test('分页：同页重复请求能 304', async () => {
  const first = await call('/graph?limit=5')
  const second = await call('/graph?limit=5', { 'if-none-match': first.headers.etag })
  assert.equal(second.status, 304)
})
