// 策展改动应该是「就地」，不是「重来一遍」。
// 这里钉三件事：① 就地改动对得上全量重建（link 是精确的 +1 条）；
// ② mute 只删那一条、不补位（补位是重建的事）；③ 撤销能把原来那条原样放回来。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'
import { buildGraph } from '../lib/host/graph.js'
import { registerRoutes, PREFIX } from '../lib/host/http.js'

const ROWS = 120
const key = (e) => e.s + '|' + e.t

// 布局跟 refresh-skip.test.mjs 一样：<root>/<ws>/.dsh-meow/memory.db，表名 fact。
// DSH_HOME 必须另指一个空目录，否则会顺带扫到本机真实记忆库，测试就不再隔离。
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-curate-'))
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
    // 每 8 条共享三个稀有词：太小（每组 4 条）一个共用词都凑不出权重，边长不出来；
    // 8 条这一档实测能长满（120 条 → 840 条边），策展那几条才有东西可删、可加。
    const g = i % 8
    const kws = ['星图', 'rare' + g + 'a', 'rare' + g + 'b', 'rare' + g + 'c']
    ins.run(
      'f' + i,
      '标题 ' + i,
      '第 ' + i + ' 条记忆的正文：' + kws.join(' ') + ' —— 同一组里的几条讲的是同一件事的不同侧面。',
      JSON.stringify(kws),
      i % 5,
      'active',
      'proj',
      now,
      now + i,
      i % 7,
    )
  }
  db.exec('COMMIT')
  db.close()
  return { root }
}

function safeRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 临时目录留给系统 */
  }
}

async function withNebula(fn) {
  const fx = makeRoot()
  const home = mkdtempSync(join(tmpdir(), 'nebula-curatehome-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  // sidecar 库是模块级单例：不先关掉，上一跑的 links 会被这一跑读进来
  closeStore()
  try {
    const nebula = new Nebula({ roots: [fx.root], log: () => {} })
    await nebula.refresh()
    assert.equal(nebula.graph.nodes.length, ROWS, 'fixture 的节点数不对：' + nebula.graph.nodes.length)
    await fn({ nebula, fx })
  } finally {
    closeStore()
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    safeRm(fx.root)
    safeRm(home)
  }
}

test('link：就地 +1 条边，builtAt 不变，度数跟着涨', async () => {
  await withNebula(async ({ nebula }) => {
    const g = nebula.graph
    const before = { edges: g.edges.length, builtAt: g.builtAt }
    const a = g.nodes[0].id
    const b = g.nodes[ROWS - 1].id
    const da = g.nodes[0].degree
    const db = g.nodes[ROWS - 1].degree

    nebula.link(a, b, '测试策展')

    assert.equal(g.edges.length, before.edges + 1, '应该正好多一条')
    assert.equal(g.builtAt, before.builtAt, '没有重建，builtAt 不许动')
    assert.equal(g.stats.edges, g.edges.length, 'stats.edges 要跟着改')
    const added = g.edges[g.edges.length - 1]
    assert.equal(added.type, 'explicit')
    assert.equal(added.w, 1)
    assert.ok(Array.isArray(added.why) && added.why[0].includes('测试策展'))
    assert.equal(g.nodes[0].degree, da + 1)
    assert.equal(g.nodes[ROWS - 1].degree, db + 1)
    assert.equal(nebula._hygiene, null, '体检缓存必须作废（它的键是来源签名，策展改不动签名）')
  })
})

test('link：重复策展同一对不重复加边', async () => {
  await withNebula(async ({ nebula }) => {
    const g = nebula.graph
    const a = g.nodes[0].id
    const b = g.nodes[ROWS - 1].id
    nebula.link(a, b, '第一次')
    const once = g.edges.length
    nebula.link(a, b, '第二次')
    assert.equal(g.edges.length, once, '同一对只该有一条策展边')
  })
})

test('mute：就地删掉那一条、不补位；unmute 把它原样放回来', async () => {
  await withNebula(async ({ nebula }) => {
    const g = nebula.graph
    assert.ok(g.edges.length > 0, 'fixture 应该长出边，否则这条测不到')
    const target = g.edges.slice().sort((x, y) => (y.w || 0) - (x.w || 0))[0]
    const a = g.nodes[target.s].id
    const b = g.nodes[target.t].id
    const before = { edges: g.edges.length, builtAt: g.builtAt }

    nebula.mute(a, b, '测试屏蔽')

    assert.equal(g.edges.length, before.edges - 1, '就地只删这一条，不补位')
    assert.equal(g.builtAt, before.builtAt, '没有重建')
    assert.ok(!g.edges.some((e) => key(e) === key(target)), '那一对应该没了')

    nebula.unmute(a, b)

    assert.equal(g.edges.length, before.edges, '撤销要把原来那条放回来')
    const back = g.edges.find((e) => key(e) === key(target))
    assert.ok(back, '放回来的应该还是同一对')
    assert.equal(back.w, target.w, '连权重都得一样')
    assert.equal(back.type, target.type)
    assert.equal(g.builtAt, before.builtAt, '撤销也不用重建')
    assert.equal(nebula.takeRebuildFlag(), false, '放回去了就不需要重算')
  })
})

test('就地策展与全量重建对得上：冻结 now 下策展一条就正好是 +1 条边', async () => {
  await withNebula(async ({ nebula }) => {
    const NOW = 1763164800000
    const nodes = nebula.nodes
    const ledgers = nebula.ledgers
    const inventory = nebula.inventory
    const base = buildGraph({ nodes, ledgers, manual: [], mutes: [], inventory, now: NOW })
    const a = base.nodes[0].id
    const b = base.nodes[ROWS - 1].id
    const withEdge = buildGraph({ nodes, ledgers, manual: [{ a, b, note: 'x' }], mutes: [], inventory, now: NOW })

    const setA = new Set(base.edges.map(key))
    const setB = new Set(withEdge.edges.map(key))
    const added = [...setB].filter((k) => !setA.has(k))
    const removed = [...setA].filter((k) => !setB.has(k))
    assert.equal(added.length, 1, '策展一条应该只多一条边，实际 ' + added.length)
    assert.equal(removed.length, 0, '不该因为策展而少边，实际少 ' + removed.length)
    assert.equal(withEdge.stats.edges, base.stats.edges + 1)

    // 就地路径算出来的那一条，必须和重建算出来的那一条是同一对
    const local = nebula.graph
    nebula.link(a, b, 'x')
    const localAdded = local.edges.filter((e) => e.type === 'explicit').map(key)
    assert.deepEqual(localAdded.sort(), added.sort(), '就地加的那一对要和重建一致')
  })
})

// ---- HTTP 层：策展接口不再等一次全量重建 ----

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      Object.assign(this.headers, headers || {})
    },
    getHeader(k) {
      return this.headers[k]
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(body) {
      if (body != null) this.body += Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
    },
  }
}

function makeCaller(nebula) {
  let handler = null
  registerRoutes({ register({ handler: h }) { handler = h } }, nebula, () => {}, { mode: 'standalone' })
  return async (path, method = 'GET', body = null) => {
    const req = {
      url: PREFIX + path,
      method,
      headers: { host: '127.0.0.1:7891', origin: 'http://127.0.0.1:7891' },
    }
    if (body != null) {
      const { Readable } = await import('node:stream')
      const stream = Readable.from([Buffer.from(JSON.stringify(body))])
      req.on = stream.on.bind(stream)
      req.destroy = stream.destroy.bind(stream)
    }
    const res = makeRes()
    await handler(req, res)
    return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
  }
}

test('HTTP：POST /link 就地生效（不重建），随后 /graph 能看到这条边', async () => {
  await withNebula(async ({ nebula }) => {
    const call = makeCaller(nebula)
    const g0 = await call('/graph?refresh=1')
    const builtAt = g0.json.builtAt
    const before = g0.json.stats.edges
    // 要一对「本来没有边」的节点：dense fixture 里首尾很可能已经连着，
    // 那时候再 link 就只是给已有边打标（边数不变），测的就不是「新增」了。
    const has = new Set(nebula.graph.edges.map((e) => e.s + '|' + e.t))
    let a = ''
    let b = ''
    outer: for (let i = 0; i < nebula.graph.nodes.length; i++) {
      for (let j = nebula.graph.nodes.length - 1; j > i; j--) {
        if (!has.has(i + '|' + j)) {
          a = nebula.graph.nodes[i].id
          b = nebula.graph.nodes[j].id
          break outer
        }
      }
    }
    assert.ok(a && b, '找不到一对不相连的节点')

    const linked = await call('/link', 'POST', { a, b, note: 'HTTP 测试' })
    assert.equal(linked.status, 200)
    assert.equal(linked.json.ok, true)

    const g1 = await call('/graph?refresh=1')
    assert.equal(g1.json.builtAt, builtAt, '策展不该触发重建（why=' + nebula.lastRefresh.why + '）')
    assert.equal(g1.json.stats.edges, before + 1, '/graph 应该看得见这条新边')
    // 载荷里的边是 { s, d, w, t }（t 就是 type），别按 { type } 找
    assert.ok(g1.json.edges.some((e) => e.t === 'explicit' || e.type === 'explicit'), '新边类型是 explicit')
  })
})

test('HTTP：POST /mute 就地删边，POST /unmute 放回来，全程不重建', async () => {
  await withNebula(async ({ nebula }) => {
    const call = makeCaller(nebula)
    const g0 = await call('/graph?refresh=1')
    const builtAt = g0.json.builtAt
    const target = nebula.graph.edges.slice().sort((x, y) => (y.w || 0) - (x.w || 0))[0]
    const a = nebula.graph.nodes[target.s].id
    const b = nebula.graph.nodes[target.t].id
    const before = g0.json.stats.edges

    const muted = await call('/mute', 'POST', { a, b, note: 'HTTP 屏蔽' })
    assert.equal(muted.status, 200)
    const g1 = await call('/graph?refresh=1')
    assert.equal(g1.json.stats.edges, before - 1)
    assert.equal(g1.json.builtAt, builtAt)

    const undone = await call('/unmute', 'POST', { a, b })
    assert.equal(undone.status, 200)
    const g2 = await call('/graph?refresh=1')
    assert.equal(g2.json.stats.edges, before, '撤销后边数回到原样')
    assert.equal(g2.json.builtAt, builtAt, '撤销也不重建')
  })
})
