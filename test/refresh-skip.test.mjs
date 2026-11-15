/**
 * 什么都没变，就别重建。
 *
 * 真实场景：用户按一次「重建星图」，磁盘上一个字节都没动，却要白付 5 秒 CPU
 * （5 万条库要 5.5 秒）。指纹没变时 refresh() 本来就该跳过，但 HTTP 的 /refresh
 * 一直传 force:true，把这条捷径关掉了。这一组测试锁住四件事：
 *   1. 第一次是重建，第二次没变就不建，且 lastRefresh.why === 'unchanged'；
 *   2. force:true 时照样重建（想强制刷新的人不能被拦住）；
 *   3. 库文件动过（mtime 变）就重建——跳过不能变成「永远不更新」；
 *   4. 跳过那次要真的快（拿掉这条捷径的代价是 5 秒级，这里给 1.5 秒的余量）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync } from 'node:fs'
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

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-refreshskip-'))
  const ws = join(root, 'proj')
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
  const dbPath = join(ws, '.dsh-meow', 'memory.db')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, keywords TEXT, importance INTEGER, status TEXT, project TEXT, created_at INTEGER, updated_at INTEGER, hit_count INTEGER)',
  )
  const ins = db.prepare(
    'INSERT INTO fact (id,title,content,keywords,importance,status,project,created_at,updated_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
  const now = 1763164800000
  db.exec('BEGIN')
  for (let i = 0; i < ROWS; i++) {
    ins.run(
      'f' + i,
      '标题 ' + i,
      '第 ' + i + ' 条记忆的正文，讲的是同一件事的不同侧面，用来把每一行都撑得像真的。',
      '["星图","重建"]',
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

/** DSH_HOME 指到临时目录：否则会顺带扫到本机真实记忆库，测试就不再是隔离的。 */
async function withNebula(fn) {
  const { root, dbPath } = makeRoot()
  const home = mkdtempSync(join(tmpdir(), 'nebula-home-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const nebula = new Nebula({ roots: [root], log: () => {} })
    await fn({ nebula, root, dbPath })
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    safeRm(root)
    safeRm(home)
  }
}

test('第一次重建，第二次什么都没变就不建', async () => {
  await withNebula(async ({ nebula }) => {
    const first = await nebula.refresh()
    assert.equal(first, true, '首次应该真的重建')
    assert.equal(nebula.lastRefresh.why, 'rebuilt')
    assert.equal(nebula.graph.nodes.length, ROWS)

    const t0 = Date.now()
    const second = await nebula.refresh()
    const ms = Date.now() - t0
    assert.equal(second, false, '没变就不该重建')
    assert.equal(nebula.lastRefresh.why, 'unchanged')
    assert.ok(ms < 1500, '跳过那次要真的快，实测 ' + ms + 'ms')
    assert.equal(nebula.graph.nodes.length, ROWS, '跳过不能把图弄丢')
  })
})

test('force 仍然强制重建', async () => {
  await withNebula(async ({ nebula }) => {
    await nebula.refresh()
    const forced = await nebula.refresh({ force: true })
    assert.equal(forced, true)
    assert.equal(nebula.lastRefresh.why, 'rebuilt')
  })
})

test('库文件动过就要重建，跳过不能变成永远不更新', async () => {
  await withNebula(async ({ nebula, dbPath }) => {
    await nebula.refresh()
    assert.equal(await nebula.refresh(), false)

    // 把 mtime 推到未来：指纹里带 size+mtime，动过就该重建
    const cur = statSync(dbPath)
    const later = new Date(Date.now() + 5000)
    utimesSync(dbPath, later, later)
    assert.ok(statSync(dbPath).mtimeMs > cur.mtimeMs, 'fixture 的 mtime 要真的变了')

    const again = await nebula.refresh()
    assert.equal(again, true, '来源变了就必须重建')
    assert.equal(nebula.lastRefresh.why, 'rebuilt')
  })
})

test('并发进来时不会两个一起建，等的那次记 joined', async () => {
  await withNebula(async ({ nebula }) => {
    const a = nebula.refresh()
    const b = nebula.refresh()
    const [ra, rb] = await Promise.all([a, b])
    assert.equal(ra, true, '先到的那一轮真的建了')
    assert.equal(rb, false, '后到的那一轮只等结果')
    // 后到的那次会把 why 覆盖成 joined；不管谁后写，至少有一个是 joined 或 unchanged
    assert.ok(['joined', 'unchanged'].includes(nebula.lastRefresh.why), 'why=' + nebula.lastRefresh.why)
    assert.equal(nebula.graph.nodes.length, ROWS)
  })
})

// ---- HTTP 层：三条「看起来要重建」的路都不该白重建 ----
// 这一层单独测，因为 1.11.24 的坑就出在路由把 force 写死：refresh() 自己有跳过，
// 路由不给它机会。只测引擎是测不出这个 bug 的。

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

test('HTTP：POST /refresh 第二次说 unchanged，不再全量重建', async () => {
  await withNebula(async ({ nebula }) => {
    const call = makeCaller(nebula)
    const first = await call('/refresh', 'POST')
    assert.equal(first.status, 200)
    assert.equal(first.json.rebuilt, true)
    assert.equal(first.json.why, 'rebuilt')

    const second = await call('/refresh', 'POST')
    assert.equal(second.status, 200)
    assert.equal(second.json.rebuilt, false)
    assert.equal(second.json.why, 'unchanged')
    assert.equal(second.json.unchanged, true)
    assert.equal(second.json.stats.nodes, ROWS, '跳过也要把整张图还回来')
  })
})

test('HTTP：/graph?refresh=1 没变时不动图，?force=1 才重建', async () => {
  await withNebula(async ({ nebula }) => {
    const call = makeCaller(nebula)
    const a = await call('/graph?refresh=1')
    const builtAt = a.json.builtAt
    assert.equal(a.json.stats.nodes, ROWS)

    const b = await call('/graph?refresh=1')
    assert.equal(b.json.builtAt, builtAt, '页面加载走这条路，没变就不该重建')

    const c = await call('/graph?force=1')
    assert.notEqual(c.json.builtAt, builtAt, 'force 必须真的重建')
    assert.equal(c.json.stats.nodes, ROWS)
  })
})

test('HTTP：POST /refresh?force=1 仍然强制重建', async () => {
  await withNebula(async ({ nebula }) => {
    const call = makeCaller(nebula)
    await call('/refresh', 'POST')
    const forced = await call('/refresh?force=1', 'POST')
    assert.equal(forced.json.rebuilt, true)
    assert.equal(forced.json.why, 'rebuilt')
  })
})
