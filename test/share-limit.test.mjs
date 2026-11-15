/**
 * 1.9.0：快照分片（?limit=）。
 *
 * 5 万条的整库快照单文件约 40MB，双击打开会先卡半分钟；默认只写前 2 万条，
 * 并且在页面上写明「已裁剪 N / M 条」——用户必须一眼看出这不是全量。
 * 这里同时盯住三件事：默认值、参数校验（400 而不是静默回落）、裁剪后边不越界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Nebula } from '../lib/host/nebula.js'
import {
  SHARE_NODE_CAP,
  SHARE_NODE_MAX,
  buildShareHtml,
  parseShareLimit,
  sliceShareGraph,
} from '../lib/host/share.js'
import { registerRoutes, PREFIX } from '../lib/host/http.js'

let cached = null
async function demoNebula() {
  if (!cached) {
    cached = new Nebula({ demo: true, log: () => {} })
    await cached.refresh()
  }
  return cached
}

test('share limit: 不传就是默认 2 万条；整数照收', () => {
  assert.equal(SHARE_NODE_CAP, 20000)
  assert.equal(SHARE_NODE_MAX, 50000)
  assert.equal(parseShareLimit(null), 20000)
  assert.equal(parseShareLimit(''), 20000)
  assert.equal(parseShareLimit('500'), 500)
  assert.equal(parseShareLimit(1500), 1500)
  assert.equal(parseShareLimit('50000'), 50000)
})

test('share limit: 拼错、零、负数、超出上限都报 400，不静默回落', () => {
  const bad = ['abc', '1.5', '-1', '0', '60000', '1e5']
  for (const raw of bad) {
    assert.throws(() => parseShareLimit(raw), (err) => err.status === 400, raw)
  }
})

test('share limit: 超过上限时按重要度裁剪，并写明裁掉了多少', async () => {
  const n = await demoNebula()
  const full = n.publicGraph()
  assert.ok(full.nodes.length > 32, 'demo 图节点数 ' + full.nodes.length)
  const { graph, scope, overview } = sliceShareGraph(n, null, { limit: 20 })
  assert.equal(graph.nodes.length, 20)
  assert.deepEqual(scope.trimmed, { cap: 20, total: full.nodes.length, shown: 20, by: 'importance' })
  assert.match(scope.label, /已裁剪 20 \/ \d+ 条/)
  assert.equal(overview.stats.nodes, 20, '切片统计按裁剪后的图算')
  // 保留下来的应是最重要的那批：importance 不升序说明排序没生效
  const kept = graph.nodes.map((x) => x.importance || 0)
  const all = full.nodes.map((x) => x.importance || 0).sort((a, b) => b - a).slice(0, 20)
  assert.deepEqual(kept.slice().sort((a, b) => b - a), all)
})

test('share limit: 裁剪后每条边都指向保留下来的节点', async () => {
  const n = await demoNebula()
  const { graph } = sliceShareGraph(n, null, { limit: 12 })
  const ids = new Set(graph.nodes.map((x) => x.id))
  assert.equal(graph.nodes.length, 12)
  for (const e of graph.edges) {
    assert.ok(e.s >= 0 && e.s < graph.nodes.length, '边下标越界 s=' + e.s)
    assert.ok(e.d >= 0 && e.d < graph.nodes.length, '边下标越界 d=' + e.d)
  }
  assert.ok(graph.stats.nodes === 12)
  assert.equal(ids.size, 12)
})

test('share limit: 没超上限时 trimmed 为 null（不假装裁剪过）', async () => {
  const n = await demoNebula()
  const { scope } = sliceShareGraph(n, null, { limit: 50000 })
  assert.equal(scope.trimmed, null)
  assert.ok(!/已裁剪/.test(scope.label))
})

test('share limit: 快照 HTML 里带 trimmed 元信息，体积随上限下降', async () => {
  const n = await demoNebula()
  const big = await buildShareHtml(n, { version: '1.9.0', build: 1 }, { limit: 50000 })
  const small = await buildShareHtml(n, { version: '1.9.0', build: 1 }, { limit: 12 })
  assert.ok(small.bytes < big.bytes, '裁剪后应该更小：' + small.bytes + ' < ' + big.bytes)
  assert.equal(small.nodes, 12)
  const payload = JSON.parse(
    small.html.match(/<script type="application\/json" id="nebula-snapshot-data">([\s\S]*?)<\/script>/)[1],
  )
  assert.equal(payload.scope.trimmed.cap, 12)
  assert.equal(payload.scope.trimmed.shown, 12)
  assert.match(payload.scope.label, /已裁剪/)
  assert.equal(payload.graph.nodes.length, 12)
})

// ---- HTTP 契约 ----
function makeRes() {
  const chunks = []
  return {
    status: 0,
    headers: {},
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
      if (body != null) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    },
    get body() {
      return Buffer.concat(chunks)
    },
  }
}

test('share limit: /share?limit=abc 与 0 都是 400，limit=8 只写 8 条', async () => {
  const nebula = await demoNebula()
  let handler = null
  registerRoutes({ register({ handler: h }) { handler = h } }, nebula, () => {}, { mode: 'standalone' })
  const call = async (path) => {
    const req = { url: PREFIX + path, method: 'GET', headers: { host: '127.0.0.1:7891', origin: 'http://127.0.0.1:7891' } }
    const res = makeRes()
    await handler(req, res)
    return res
  }
  for (const raw of ['abc', '0', '60000']) {
    const res = await call('/share?limit=' + raw)
    assert.equal(res.status, 400, raw + ' 应该是 400')
    assert.match(res.body.toString('utf8'), /limit/)
  }
  const ok = await call('/share?limit=8')
  assert.equal(ok.status, 200)
  assert.match(ok.headers['content-type'], /text\/html/)
  const text = ok.body.toString('utf8')
  const payload = JSON.parse(
    text.match(/<script type="application\/json" id="nebula-snapshot-data">([\s\S]*?)<\/script>/)[1],
  )
  assert.equal(payload.graph.nodes.length, 8)
  assert.equal(payload.scope.trimmed.shown, 8)
})
