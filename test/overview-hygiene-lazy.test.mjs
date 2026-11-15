import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'
import { registerRoutes } from '../lib/host/http.js'

// 夹具同 hygiene-warm.test.mjs：<root>/<ws>/.dsh-meow/memory.db，表名 fact，插入包事务。
const ROWS = 120
const HOST = '127.0.0.1:63111'

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-lazyhy-'))
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
    const kws = ['体检', 'rare' + g + 'a', 'rare' + g + 'b', 'rare' + g + 'c']
    ins.run('h' + i, '体检 ' + i, '第 ' + i + ' 条：' + kws.join(' ') + ' 同一组里的同一件事。', JSON.stringify(kws), i % 5, 'active', 'proj', now, now + i, i % 3)
  }
  db.exec('COMMIT')
  db.close()
  return { root }
}

const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 留给系统清 */
  }
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'nebula-lazyhyhome-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  process.env.NEBULA_HYGIENE_WARM = '0' // 体检预热关掉：这一轮只测「谁在什么时候算」
  closeStore()
  return Promise.resolve(fn(home)).finally(() => {
    closeStore()
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    delete process.env.NEBULA_HYGIENE_WARM
    safeRm(home)
  })
}

function makeCaller(handler) {
  return async (url, method = 'GET') => {
    const out = { status: 0, body: '' }
    const res = {
      statusCode: 0,
      setHeader() {},
      writeHead(code) { out.status = code; res.statusCode = code },
      write(chunk) { if (chunk) out.body += chunk.toString() },
      end(chunk) { if (chunk) out.body += chunk.toString() },
      getHeader() { return undefined },
    }
    // 处理器会先查 Host 是不是本机（防 DNS rebinding），所以这里得给一个环回 Host
    await handler({ method, url, headers: { host: HOST }, on: () => {} }, res, '/api/memory-nebula')
    return { status: out.status, json: () => JSON.parse(out.body) }
  }
}

test('概览默认不等体检：先给别的，并标上 pending', async () => {
  const fx = makeRoot()
  try {
    await withHome(async () => {
      const nb = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7, hygieneWarm: false })
      await nb.refresh()
      await nb.cacheWriteDone()

      const t0 = Date.now()
      const ov = nb.overview({ hygiene: 'cached' })
      const ms = Date.now() - t0

      assert.equal(ov.hygiene, null, '没算过就该是 null，而不是当场算一份')
      assert.equal(ov.cards, null, 'cards 也一样（它也要体检）')
      assert.equal(ov.hygienePending, true, '要说清「还在算」，不能让空清单冒充「库很干净」')
      assert.ok(nb._hygiene == null, '取概览不该顺手把体检算了')
      assert.ok(ms < 300, '取概览不该慢：' + ms + 'ms')
      // 其余部分照常给：来源、统计、规模都在
      assert.ok(ov.sources.length >= 1, '来源清单要照常给')
      assert.ok(ov.stats && ov.stats.nodes === ROWS, '统计要照常给')
    })
  } finally {
    safeRm(fx.root)
  }
})

test('算完体检之后，概览把它带上且不再标 pending', async () => {
  const fx = makeRoot()
  try {
    await withHome(async () => {
      const nb = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7, hygieneWarm: false })
      await nb.refresh()
      await nb.cacheWriteDone()

      const value = await nb.hygieneAsync()
      assert.ok(value.total > 0, '这批记忆有重复，体检该查出问题')

      const ov = nb.overview({ hygiene: 'cached' })
      assert.equal(ov.hygienePending, false, '算完了就不该再标 pending')
      assert.ok(ov.hygiene && ov.hygiene.counts.dup > 0, '缓存里的那份要带上')
      assert.ok(ov.cards, 'cards 这时也能给')
    })
  } finally {
    safeRm(fx.root)
  }
})

test('HTTP：/overview 先回、/hygiene 另走一趟，第二次命中缓存', async () => {
  const fx = makeRoot()
  try {
    await withHome(async () => {
      const nb = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7, hygieneWarm: false })
      await nb.refresh()
      await nb.cacheWriteDone()

      let handler = null
      registerRoutes({ register: (def) => { handler = def.handler } }, nb, () => {}, { mode: 'standalone' })
      assert.ok(handler, '要能拿到路由处理器')
      const call = makeCaller(handler)

      const t0 = Date.now()
      const ov1 = await call('/api/memory-nebula/overview')
      const ms = Date.now() - t0
      const body1 = ov1.json()
      assert.equal(ov1.status, 200)
      assert.equal(body1.hygienePending, true, '没算过时要说在算')
      assert.equal(body1.hygiene, null)
      assert.ok(ms < 1500, '/overview 不该去算体检：' + ms + 'ms')

      const hy1 = await call('/api/memory-nebula/hygiene')
      const hb = hy1.json()
      assert.equal(hy1.status, 200)
      assert.ok(hb.hygiene && hb.hygiene.total > 0, '/hygiene 要给出体检结果')
      assert.ok(hb.cards, '/hygiene 顺带把 cards 也给出来')

      const t1 = Date.now()
      const hy2 = await call('/api/memory-nebula/hygiene')
      const ms2 = Date.now() - t1
      assert.equal(hy2.json().hygiene.total, hb.hygiene.total, '第二次结果要一样')
      assert.ok(ms2 < 200, '第二次该命中缓存：' + ms2 + 'ms')

      const ov2 = (await call('/api/memory-nebula/overview')).json()
      assert.equal(ov2.hygienePending, false, '算完之后概览要带上体检')
      assert.ok(ov2.hygiene && ov2.hygiene.total === hb.hygiene.total)
    })
  } finally {
    safeRm(fx.root)
  }
})

test('?hygiene=1 还是要「算完再给」', async () => {
  const fx = makeRoot()
  try {
    await withHome(async () => {
      const nb = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7, hygieneWarm: false })
      await nb.refresh()
      await nb.cacheWriteDone()

      let handler = null
      registerRoutes({ register: (def) => { handler = def.handler } }, nb, () => {}, { mode: 'standalone' })
      const call = makeCaller(handler)

      const body = (await call('/api/memory-nebula/overview?hygiene=1')).json()
      assert.equal(body.hygienePending, false, '?hygiene=1 就是「算完再给」')
      assert.ok(body.hygiene && body.hygiene.total > 0, '这条路上体检一定要有')
    })
  } finally {
    safeRm(fx.root)
  }
})
