import test from 'node:test'
import assert from 'node:assert/strict'
import { Nebula } from '../lib/host/nebula.js'
import { registerRoutes, CAPABILITIES, PREFIX, isLoopbackOrigin, corsHeaders } from '../lib/host/http.js'

let handler = null
async function boot() {
  if (handler) return handler
  const nebula = new Nebula({ demo: true, log: () => {} })
  await nebula.refresh()
  const fake = { register({ handler: h }) { handler = h } }
  registerRoutes(fake, nebula, () => {}, { mode: 'standalone' })
  return handler
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      Object.assign(this.headers, headers || {})
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(body) {
      if (body != null) this.body += Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
    },
  }
}

async function call(h, path, { method = 'GET', headers = {} } = {}) {
  const req = {
    url: PREFIX + path,
    method,
    headers: { host: '127.0.0.1:7891', origin: 'http://127.0.0.1:7891', ...headers },
  }
  const res = makeRes()
  await h(req, res)
  return res
}

test('http: 能力清单里有 demo 与 share', () => {
  assert.ok(CAPABILITIES.includes('demo'))
  assert.ok(CAPABILITIES.includes('share'))
  assert.ok(CAPABILITIES.includes('diagnostics'))
})

test('http: /graph?demo=1 返回示例图与 demo 标记', async () => {
  const h = await boot()
  const res = await call(h, '/graph?demo=1')
  assert.equal(res.status, 200, res.body)
  const g = JSON.parse(res.body)
  assert.equal(g.demo, true)
  assert.equal(g.nodes.length, 64)
  assert.ok(g.edges.length >= 60)
  assert.ok(res.headers.etag)
  // ETag 命中 → 304 且没有正文
  const again = await call(h, '/graph?demo=1', { headers: { 'if-none-match': res.headers.etag } })
  assert.equal(again.status, 304)
  assert.equal(again.body, '')
})

test('http: 示例模式下 /node /recall /path 都能用', async () => {
  const h = await boot()
  const node = JSON.parse((await call(h, '/node?demo=1&id=xg-weekly')).body)
  assert.equal(node.node.id, 'xg-weekly')
  assert.ok(node.degree >= 10)
  const recall = JSON.parse((await call(h, '/recall?demo=1&q=' + encodeURIComponent('星港'))).body)
  assert.ok(recall.hits.length >= 8)
  const path = JSON.parse((await call(h, '/path?demo=1&a=vc-quote&b=dy-touched')).body)
  assert.equal(path.found, true)
  assert.equal(path.hops, 1)
})

test('http: 示例模式是只读的', async () => {
  const h = await boot()
  const res = await call(h, '/link?demo=1', { method: 'POST' })
  assert.equal(res.status, 403)
  assert.match(JSON.parse(res.body).error, /示例模式是只读的/)
})

test('http: 跨站写入仍然被挡（CSRF）', async () => {
  const h = await boot()
  const res = await call(h, '/link', { method: 'POST', headers: { origin: 'http://evil.example' } })
  assert.equal(res.status, 403)
  assert.match(JSON.parse(res.body).error, /跨站写入/)
})

test('http: /share 返回可下载的单文件 HTML', async () => {
  const h = await boot()
  const res = await call(h, '/share?demo=1')
  assert.equal(res.status, 200, res.body)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.headers['content-disposition'], /attachment; filename="memory-nebula-snapshot-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.html"/)
  assert.ok(res.body.length > 200000)
  assert.ok(res.body.includes('window.__NEBULA_SNAPSHOT__'))
  assert.ok(!/<script[^>]+src=/i.test(res.body))
})

test('http: /share?scope=ws 只打包一个工作区', async () => {
  const h = await boot()
  const res = await call(h, '/share?demo=1&scope=ws:xingang')
  assert.equal(res.status, 200, res.body)
  assert.match(res.headers['content-disposition'], /memory-nebula-snapshot-ws-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.html/)
  assert.ok(res.body.includes('"scope":{"kind":"ws"'))
  assert.ok(res.body.includes('星港产品'))
  assert.ok(!res.body.includes('dy-locker'), '范围外节点不能写进文件')
})

test('http: /share?scope=focus&hops 与非法 scope', async () => {
  const h = await boot()
  const ok = await call(h, '/share?demo=1&scope=focus:vc-quote&hops=1')
  assert.equal(ok.status, 200)
  assert.ok(ok.body.includes('"kind":"focus"'))
  const bad = await call(h, '/share?demo=1&scope=nope')
  assert.equal(bad.status, 400)
  assert.match(JSON.parse(bad.body).error, /scope/)
  const missing = await call(h, '/share?demo=1&scope=focus:not-a-node')
  assert.equal(missing.status, 404)
})

test('http: 未知接口是 404，不会被当成 500', async () => {
  const h = await boot()
  const res = await call(h, '/nope')
  assert.equal(res.status, 404)
  assert.match(JSON.parse(res.body).error, /未知接口/)
})

test('http: 只有 loopback Origin 算本机', () => {
  for (const o of ['http://127.0.0.1:7890', 'http://localhost:7891', 'http://[::1]:3000']) {
    assert.equal(isLoopbackOrigin(o), true, o)
  }
  for (const o of ['https://evil.example', 'file:///c:/x.html', 'javascript:alert(1)', 'null']) {
    assert.equal(isLoopbackOrigin(o), false, o)
  }
  // 没有 Origin 的是本机脚本（curl / 自动化），允许
  assert.equal(isLoopbackOrigin(undefined), true)
  assert.equal(isLoopbackOrigin(''), true, '空串等同没有 Origin')
})

test('http: CORS 只回显 loopback，并带 Vary', () => {
  const loop = corsHeaders({ headers: { origin: 'http://127.0.0.1:7890' } })
  assert.equal(loop['access-control-allow-origin'], 'http://127.0.0.1:7890')
  assert.equal(loop.vary, 'Origin')
  assert.deepEqual(corsHeaders({ headers: { origin: 'https://evil.example' } }), {})
  assert.deepEqual(corsHeaders({ headers: {} }), {})
})

test('http: Sec-Fetch-Site: cross-site 的本机 Origin 也拒绝写入', async () => {
  const h = await boot()
  const res = await call(h, '/link', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(res.status, 403)
  assert.match(JSON.parse(res.body).error, /跨站写入/)
})

test('http: /share?hide 只留下可分享的部分', async () => {
  const h = await boot()
  const res = await call(h, '/share?demo=1&hide=ws:日记')
  assert.equal(res.status, 200, res.body)
  assert.ok(res.body.includes('"hidden":7'))
  assert.ok(res.body.includes('"nodes":57'))
  assert.ok(!res.body.includes('（内置演示数据，不写盘）'), '来源本机路径不能进快照')
  assert.ok(!res.body.includes('"dbPath"'))
})

test('http: /diagnostics 只给环境与图规模，不带正文/路径', async () => {
  const h = await boot()
  const res = await call(h, '/diagnostics?demo=1')
  assert.equal(res.status, 200, res.body)
  assert.match(res.headers['content-type'], /text\/plain/)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.match(res.body, /memory-nebula diagnostics/)
  assert.match(res.body, /mode: standalone \(demo\)/)
  assert.match(res.body, /graph: 64 memories/)
  assert.match(res.body, /sources: 1/)
  assert.match(res.body, /capabilities: .*diagnostics/)
  assert.ok(!res.body.includes('content'), '不能出现正文标记')
  assert.ok(!res.body.includes('C:\\'), '不能出现本机路径')
  assert.ok(!res.body.includes('dbPath'))
})

test('http: 非法 hide 返回 400，空范围返回 404', async () => {
  const h = await boot()
  const bad = await call(h, '/share?demo=1&hide=nope:x')
  assert.equal(bad.status, 400)
  assert.match(bad.body, /hide 要写成/)
  const empty = await call(h, '/share?demo=1&scope=ws:日记&hide=ws:日记')
  assert.equal(empty.status, 404)
  assert.match(empty.body, /都被 hide 排除了/)
})
