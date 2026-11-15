/**
 * 打开页面不该先等五秒：手上有旧图就先给旧图，新图在后台建。
 *
 * 真实场景：五万条库上一次重建要五秒多，而页面加载走的就是 /graph?refresh=1。
 * 以前这条路要等建完才返回，于是每次打开都是一段没有任何说明的空白等待。
 * 这一组测试锁住四件事：
 *   1. refreshInBackground 立刻返回，建完之后图真的换掉了；
 *   2. 并发再点一次不会另起一轮，复用同一个 promise；
 *   3. HTTP 层：库变了之后 /graph?refresh=1 立刻返回旧图 + refreshing:true，builtAt 不动；
 *   4. 轮询 /graph 等到 refreshing 变 false，新图就在那儿（条数 +1、builtAt 变了）。
 *
 * 第 3 条必须在 HTTP 层测：引擎里做对了、路由却 await 住，用户照样等五秒。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { registerRoutes, PREFIX } from '../lib/host/http.js'

function safeRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 临时目录留给系统清理 */
  }
}

const ROWS = 120
const INSERT_SQL =
  'INSERT INTO fact (id,title,content,keywords,importance,status,project,created_at,updated_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,?)'

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-bgrefresh-'))
  const ws = join(root, 'proj')
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
  const dbPath = join(ws, '.dsh-meow', 'memory.db')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, keywords TEXT, importance INTEGER, status TEXT, project TEXT, created_at INTEGER, updated_at INTEGER, hit_count INTEGER)',
  )
  const ins = db.prepare(INSERT_SQL)
  const now = 1763164800000
  db.exec('BEGIN')
  for (let i = 0; i < ROWS; i++) {
    ins.run(
      'f' + i,
      '标题 ' + i,
      '第 ' + i + ' 条记忆的正文，讲的是同一件事的不同侧面，用来把每一行都撑得像真的。',
      '["星图","后台"]',
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
  return { root, dbPath }
}

/** 往 fixture 里再塞一条：mtime 与 size 都变，指纹跟着变。 */
function addRow(dbPath, id) {
  const db = new DatabaseSync(dbPath)
  const now = Date.now()
  db.prepare(INSERT_SQL).run(
    id,
    '新增的 ' + id,
    '这是后来写进去的一条记忆，用来让来源指纹变化。',
    '["星图","新增"]',
    3,
    'active',
    'proj',
    now,
    now,
    0,
  )
  db.close()
}

async function withNebula(fn) {
  const { root, dbPath } = makeRoot()
  const home = mkdtempSync(join(tmpdir(), 'nebula-bghome-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const nebula = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
    await fn({ nebula, root, dbPath })
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    safeRm(root)
    safeRm(home)
  }
}

async function waitIdle(nebula, timeoutMs = 15000) {
  const t0 = Date.now()
  while (nebula.building) {
    if (Date.now() - t0 > timeoutMs) throw new Error('后台重建超过 ' + timeoutMs + 'ms 没结束')
    await new Promise((r) => setTimeout(r, 20))
  }
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
  return async (path, method = 'GET') => {
    const req = { url: PREFIX + path, method, headers: { host: '127.0.0.1:7891', origin: 'http://127.0.0.1:7891' } }
    const res = makeRes()
    await handler(req, res)
    return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
  }
}

test('refreshInBackground 立刻返回，建完图真的换了', async () => {
  await withNebula(async ({ nebula, dbPath }) => {
    await nebula.refresh()
    const before = nebula.graph.builtAt
    addRow(dbPath, 'extra-1')

    const t0 = Date.now()
    const p = nebula.refreshInBackground({})
    const callMs = Date.now() - t0
    assert.ok(p && typeof p.then === 'function', '应该返回一个 promise')
    assert.ok(callMs < 50, '启动后台重建这一步本身应当立即返回，实测 ' + callMs + 'ms')

    await p
    assert.notEqual(nebula.graph.builtAt, before, '建完之后图要真的换掉')
    assert.equal(nebula.graph.nodes.length, ROWS + 1)
    assert.equal(nebula.building, false)
  })
})

test('已经在建的时候再叫一次，不会另起一轮', async () => {
  await withNebula(async ({ nebula, dbPath }) => {
    await nebula.refresh()
    addRow(dbPath, 'extra-2')
    const a = nebula.refreshInBackground({})
    const b = nebula.refreshInBackground({})
    assert.equal(a, b, '同一个 promise：不能两次重建互相覆盖')
    await a
    await waitIdle(nebula)
  })
})

test('HTTP：/graph?refresh=1 先给旧图并标 refreshing，随后轮询能等到新图', async () => {
  await withNebula(async ({ nebula, dbPath }) => {
    const call = makeCaller(nebula)
    const first = await call('/graph?refresh=1')
    const builtAt = first.json.builtAt
    assert.equal(first.json.refreshing, false, '首次建图会等，返回时已经建完')
    assert.equal(first.json.stats.nodes, ROWS)

    addRow(dbPath, 'extra-3')
    const t0 = Date.now()
    const second = await call('/graph?refresh=1')
    const ms = Date.now() - t0
    assert.equal(second.status, 200)
    assert.equal(second.json.refreshing, true, '库变了：这一次应该只把旧图给出来，同时说明正在重建')
    assert.equal(second.json.builtAt, builtAt, '旧图就是旧图，不能假装是新的')
    assert.equal(second.json.stats.nodes, ROWS, '旧图是上一版，条数也应该是上一版')
    assert.ok(ms < 1500, '这一次不该等建完，实测 ' + ms + 'ms')

    // 轮询：跟界面做的一样，直到 refreshing 变 false
    let last = null
    for (let i = 0; i < 200; i++) {
      last = await call('/graph')
      if (!last.json.refreshing) break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(last.json.refreshing, false, '后台建完就该说建完了')
    assert.notEqual(last.json.builtAt, builtAt, '轮询拿到的必须是新图')
    assert.equal(last.json.stats.nodes, ROWS + 1)
  })
})

test('HTTP：手上还没有图时，/graph?refresh=1 仍然等建完再返回', async () => {
  await withNebula(async ({ nebula }) => {
    const call = makeCaller(nebula)
    const r = await call('/graph?refresh=1')
    assert.equal(r.status, 200)
    assert.equal(r.json.refreshing, false, '没图可给的时候只能等，返回时就已经建完了')
    assert.equal(r.json.stats.nodes, ROWS, '首屏必须是完整的图，不能是空壳')
  })
})

test('重启后签名对不上：先把上一份图给出来，再在后台换成新的', async () => {
  await withNebula(async ({ root, dbPath }) => {
    // 第一台：建图并把缓存写到盘上
    const a = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
    await a.refresh()
    await a.cacheWriteDone()
    assert.ok(a.lastCache && a.lastCache.bytes > 0, '第一台应该真的写了缓存')

    // 库变了：签名跟着变，盘上那份就「过期」了
    addRow(dbPath, 'extra-4')

    // 第二台：文件级模拟重启
    const b = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
    const t0 = Date.now()
    await b.refresh()
    const ms = Date.now() - t0
    assert.equal(b.lastRefresh.why, 'stale-cache', '签名对不上不该整份作废，应该给出上一份并说明它是旧的')
    assert.equal(b.staleGraph, true, '对外要说得清「你看到的是旧图」')
    assert.equal(b.lastCache.stale, true)
    assert.equal(b.graph.nodes.length, ROWS, '先给的是上一版的图')
    assert.ok(ms < 3000, '读旧图不该等重建，实测 ' + ms + 'ms')

    // 后台那一轮会自己起来，建完后 stale 落下、条数 +1
    for (let i = 0; i < 300; i++) {
      if (!b.building && !b.staleGraph && b.graph.nodes.length === ROWS + 1) break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(b.staleGraph, false, '后台建完就不该再说自己是旧图')
    assert.equal(b.graph.nodes.length, ROWS + 1, '后台那一轮换上了新图')
    // 写盘是在响应之后异步做的（164MB 压成 4.3MB 要 1.6 秒，不能让人等着），
    // 所以要等它落定再看 lastCache，否则读到的是上一次「读盘命中」的读数。
    await b.cacheWriteDone()
    // lastRefresh / lastCache 讲的都是「最近一次和缓存/重建有关的事」：
    // 后台那一轮建完会把它覆盖成一次写盘（hit:false + writeMs），这是对的，别去留住旧读数。
    assert.equal(b.lastRefresh.why, 'rebuilt')
    assert.equal(b.lastCache.hit, false)
    assert.ok(b.lastCache.writeMs > 0, '重建之后要把新图写回盘上，否则下次重启又白等')
  })
})

test('签名没变：读盘命中就是最终的图，不会再多建一遍', async () => {
  await withNebula(async ({ root }) => {
    const a = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
    await a.refresh()
    await a.cacheWriteDone()
    const builtAt = a.graph.builtAt

    const b = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
    await b.refresh()
    assert.equal(b.lastRefresh.why, 'cached')
    assert.equal(b.staleGraph, false, '签名对得上就是最新的图，不该标旧')
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(b.building, false, '没有过期就不该偷偷重建')
    assert.equal(b.graph.builtAt, builtAt)
  })
})
