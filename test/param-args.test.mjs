import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'
import { registerRoutes, readIntArg, readNumArg } from '../lib/host/http.js'

// 1.11.63：参数写错要能看见。以前 recall/path/bridge/export 都是 Number(raw) || 默认值，
// 于是「abc」静默变默认值、连 0 也被吞掉；只有 /graph 与 /share 报了 400。
const HOST = '127.0.0.1:63211'
const ROWS = 40
const P = '/api/memory-nebula'

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-param-'))
  const ws = join(root, 'proj')
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
  const db = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
  db.exec(
    'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, keywords TEXT, importance INTEGER, status TEXT, project TEXT, created_at INTEGER, updated_at INTEGER, hit_count INTEGER)',
  )
  const ins = db.prepare(
    'INSERT INTO fact (id,title,content,keywords,importance,status,project,created_at,updated_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
  const now = 1763164800000
  db.exec('BEGIN')
  for (let i = 0; i < ROWS; i++) {
    const g = i % 8
    const kws = ['参数', 'rare' + g + 'a', 'rare' + g + 'b', 'rare' + g + 'c']
    ins.run('p' + i, '参数 ' + i, '第 ' + i + ' 条：' + kws.join(' ') + ' 同一组里的同一件事。', JSON.stringify(kws), i % 5, 'active', 'proj', now, now + i, i % 3)
  }
  db.exec('COMMIT')
  db.close()
  return root
}

const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 留给系统清 */
  }
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'nebula-paramhome-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  closeStore()
  return Promise.resolve(fn(home)).finally(() => {
    closeStore()
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    safeRm(home)
  })
}

function makeCaller(handler) {
  return async (url) => {
    const out = { status: 0, body: '' }
    const res = {
      statusCode: 0,
      setHeader() {},
      writeHead(code) {
        out.status = code
        res.statusCode = code
      },
      write(chunk) {
        if (chunk) out.body += chunk.toString()
      },
      end(chunk) {
        if (chunk) out.body += chunk.toString()
      },
      getHeader() {
        return undefined
      },
    }
    // 处理器先查 Host 是不是本机（防 DNS rebinding），这里给一个环回 Host
    await handler({ method: 'GET', url, headers: { host: HOST }, on: () => {} }, res, P)
    return { status: out.status, json: () => JSON.parse(out.body) }
  }
}

test('readIntArg：不传给默认值，写错报错，0 也照用', () => {
  const sp = (q) => new URLSearchParams(q)
  const spec = { min: 0, max: 3, fallback: 2 }

  assert.equal(readIntArg(sp(''), 'hops', spec).value, 2, '不传就是默认值')
  assert.equal(readIntArg(sp('hops='), 'hops', spec).value, 2, '留空也是默认值')
  assert.equal(readIntArg(sp('hops=0'), 'hops', spec).value, 0, '0 是合法值，不许被吞成默认值')
  assert.equal(readIntArg(sp('hops=3'), 'hops', spec).value, 3)
  assert.equal(readIntArg(sp('hops= 1 '), 'hops', spec).value, 1, '两头空格要容忍')

  for (const bad of ['abc', '2跳', '-1', '1.5', '4', '99', 'Infinity', '1e2', '0x2']) {
    const got = readIntArg(sp('hops=' + encodeURIComponent(bad)), 'hops', spec)
    assert.ok(got.error, bad + ' 该报错')
    assert.match(got.error, /hops 需要 0–3 的整数/)
    assert.match(got.error, new RegExp('收到的是「' + bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '」'))
  }
})

test('readNumArg：小数合法，写错报错，0 也照用', () => {
  const sp = (q) => new URLSearchParams(q)
  const spec = { min: 0, max: 1, fallback: 0.45 }

  assert.equal(readNumArg(sp(''), 'min_weight', spec).value, 0.45)
  assert.equal(readNumArg(sp('min_weight=0'), 'min_weight', spec).value, 0)
  assert.equal(readNumArg(sp('min_weight=0.7'), 'min_weight', spec).value, 0.7)
  assert.equal(readNumArg(sp('min_weight=1'), 'min_weight', spec).value, 1)

  for (const bad of ['abc', '1.5', '-0.1', '一半', '1e-3']) {
    const got = readNumArg(sp('min_weight=' + encodeURIComponent(bad)), 'min_weight', spec)
    assert.ok(got.error, bad + ' 该报错')
    assert.match(got.error, /min_weight 需要 0–1 之间的数/)
  }
})

test('HTTP：recall 的参数写错回 400，写 0 真的按 0 跑', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const nb = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 10 ** 7, hygieneWarm: false })
      await nb.refresh()
      let handler = null
      registerRoutes({ register: (def) => { handler = def.handler } }, nb, () => {}, { mode: 'standalone' })
      const call = makeCaller(handler)

      const badHops = await call(P + '/recall?q=' + encodeURIComponent('参数') + '&hops=abc')
      assert.equal(badHops.status, 400, 'hops=abc 不许静默按默认值跑')
      assert.match(badHops.json().error, /hops 需要 0–3 的整数/)

      const badLimit = await call(P + '/recall?q=' + encodeURIComponent('参数') + '&limit=0')
      assert.equal(badLimit.status, 400, 'limit=0 越界，也要报错')
      assert.match(badLimit.json().error, /limit 需要 1–50 的整数/)

      // 用一个只有 5 条会命中的稀有词：这样 limit=30 时「扩散」才有位置显形
      // （用「参数」这种人人都带的词，直连命中就把 limit 填满了，hops 差不出来）。
      const q = encodeURIComponent('rare3a')
      const zero = await call(P + '/recall?q=' + q + '&limit=30&hops=0')
      assert.equal(zero.status, 200)
      const spread = await call(P + '/recall?q=' + q + '&limit=30&hops=2')
      assert.equal(spread.status, 200)
      const idOf = (h) => h.id || h.node || h.nodeId || JSON.stringify(h)
      const zeroHits = zero.json().hits || []
      const spreadHits = spread.json().hits || []
      const spreadSet = new Set(spreadHits.map(idOf))
      assert.ok(zeroHits.length >= 1, 'hops=0 至少要有命中')
      assert.ok(zeroHits.map(idOf).every((id) => spreadSet.has(id)), 'hops=0 的命中必须也在 hops=2 里（只是少了扩散出来的那些）')
      // 夹具里的边只连同一组内的节点，扩散不会带出新 id，但会给命中加「扩散分」。
      // hops=0 就该一分不加——这一条同时把「0 被吞成 2」钉死。
      assert.ok(
        zeroHits.every((h) => !h.spread),
        'hops=0 不许有任何扩散分，否则说明 hops=0 又被当成 2 跑了（' + JSON.stringify(zeroHits.map((h) => h.spread)) + '）',
      )
      assert.ok(
        spreadHits.some((h) => Number(h.spread) > 0),
        'hops=2 要给扩散分，否则说明扩散这条路根本没跑',
      )

      // 不带 hops 时默认还是 2：拿同样的 limit 比一遍
      const plain = await call(P + '/recall?q=' + q + '&limit=30')
      assert.equal(plain.status, 200, '不传参数照旧')
      assert.deepEqual(
        (plain.json().hits || []).map(idOf),
        spreadHits.map(idOf),
        '默认 hops 还是 2：结果要和显式 hops=2 一模一样',
      )
    })
  } finally {
    safeRm(root)
  }
})

test('HTTP：path / bridge / export 的参数同样不许静默回落', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const nb = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 10 ** 7, hygieneWarm: false })
      await nb.refresh()
      let handler = null
      registerRoutes({ register: (def) => { handler = def.handler } }, nb, () => {}, { mode: 'standalone' })
      const call = makeCaller(handler)

      const path = await call(P + '/path?a=p0&b=p1&hops=abc')
      assert.equal(path.status, 400)
      assert.match(path.json().error, /hops 需要 1–8 的整数/)

      const bridge = await call(P + '/bridge?query=' + encodeURIComponent('参数') + '&hops=0')
      assert.equal(bridge.status, 200, 'hops=0 对补充包是合法的（只给直接邻居）')
      const bridgeBad = await call(P + '/bridge?query=' + encodeURIComponent('参数') + '&limit=99')
      assert.equal(bridgeBad.status, 400, 'limit 超上限要报错')
      assert.match(bridgeBad.json().error, /limit 需要 1–20 的整数/)

      const weightBad = await call(P + '/bridge?query=' + encodeURIComponent('参数') + '&min_weight=2')
      assert.equal(weightBad.status, 400)
      assert.match(weightBad.json().error, /min_weight 需要 0–1 之间的数/)

      const weightZero = await call(P + '/bridge?query=' + encodeURIComponent('参数') + '&min_weight=0')
      assert.equal(weightZero.status, 200, 'min_weight=0 是「不过滤」，要给结果')

      const expBad = await call(P + '/export?hops=abc')
      assert.equal(expBad.status, 400)
      assert.match(expBad.json().error, /hops 需要 0–5 的整数/)

      const expZero = await call(P + '/export?hops=0')
      assert.equal(expZero.status, 200, 'export hops=0 要能跑')
      assert.ok(typeof expZero.json().text === 'string', '导出报告照旧给正文')
    })
  } finally {
    safeRm(root)
  }
})
