import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'
import { cacheDir, cacheName } from '../lib/host/graphcache.js'

// 布局同 curate-incremental.test.mjs：<root>/<ws>/.dsh-meow/memory.db，表名 fact。
const ROWS = 120

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-cache-'))
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
    const g = i % 8
    const kws = ['缓存', 'rare' + g + 'a', 'rare' + g + 'b', 'rare' + g + 'c']
    ins.run(
      'f' + i,
      '缓存 ' + i,
      '第 ' + i + ' 条：' + kws.join(' ') + ' 讲同一组里的同一件事。',
      JSON.stringify(kws),
      i % 5,
      'active',
      'proj',
      now,
      now + i,
      i % 3,
    )
  }
  db.exec('COMMIT')
  db.close()
  return { root, dbPath }
}

const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 留给系统清 */
  }
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'nebula-cachehome-'))
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

test('建完图会写一份盘上缓存，重启时直接读盘不重建', async () => {
  const fx = makeRoot()
  try {
    await withHome(async (home) => {
      const a = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7 })
      await a.refresh()
      await a.cacheWriteDone() // 写盘不阻塞响应，测试要等它落定
      const files = readdirSync(cacheDir(join(home, 'memory-nebula'))).filter((n) => n.startsWith('graph-'))
      assert.equal(files.length, 1, '建完图应该正好一份缓存')
      assert.match(files[0], /^graph-[0-9a-f]{16}\.json\.br$/)
      assert.ok(a.lastCache && a.lastCache.writeMs >= 0, 'lastCache 应该记下写入耗时')

      // 换一个实例（模拟重启）：同一个 home、同一份库
      closeStore()
      const b = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7 })
      const rebuilt = await b.refresh()
      assert.equal(rebuilt, false, '读盘恢复不该报「重建了」')
      assert.equal(b.lastRefresh.why, 'cached', '应该是 cached 而不是 rebuilt')
      assert.equal(b.graph.nodes.length, a.graph.nodes.length, '节点数必须一样')
      assert.equal(b.graph.edges.length, a.graph.edges.length, '边数必须一样')
      assert.equal(b.signature, a.signature, '签名必须一样')
      // 检索能直接用（说明原始记忆也一起恢复出来了，不只是投影）
      const hits = (await b.recallAsync('rare3a 缓存', { limit: 5, hops: 0 })).hits
      assert.ok(hits.length > 0, '读盘恢复之后检索应该还能命中')
    })
  } finally {
    safeRm(fx.root)
  }
})

test('库动过之后缓存不认，照常重建并覆盖', async () => {
  const fx = makeRoot()
  try {
    await withHome(async (home) => {
      const dir = cacheDir(join(home, 'memory-nebula'))
      const a = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7 })
      await a.refresh()
      await a.cacheWriteDone() // 写盘不阻塞响应，测试要等它落定
      const before = readdirSync(dir)
      assert.equal(before.length, 1)

      // 改库：加一行（mtime 也变了）
      const db = new DatabaseSync(fx.dbPath)
      db.exec('BEGIN')
      db.prepare(
        'INSERT INTO fact (id,title,content,keywords,importance,status,project,created_at,updated_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run('f999', '新的一条', '新的一条：rare3a rare3b rare3c 缓存', '["缓存"]', 1, 'active', 'proj', 1763164800000, 1763164800000, 0)
      db.exec('COMMIT')
      db.close()

      closeStore()
      const b = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7 })
      await b.refresh()
      // 1.11.30 起：签名对不上不整份作废，先把上一份给出来（stale-cache），
      // 真正的重建排在后台 —— 所以这里要等后台那一轮建完，才看到 rebuilt 与 +1。
      assert.equal(b.lastRefresh.why, 'stale-cache', '签名变了：先给上一份，并说明它是旧的')
      assert.equal(b.staleGraph, true)
      const t0 = Date.now()
      while ((b.building || b.staleGraph || b.graph.nodes.length !== a.graph.nodes.length + 1) && Date.now() - t0 < 20000) {
        await new Promise((r) => setTimeout(r, 20))
      }
      await b.cacheWriteDone() // 写盘不阻塞响应，测试要等它落定
      assert.equal(b.lastRefresh.why, 'rebuilt', '后台那一轮建完之后就是重建')
      assert.equal(b.graph.nodes.length, a.graph.nodes.length + 1)
      const after = readdirSync(dir).filter((n) => n.startsWith('graph-'))
      assert.equal(after.length, 2, '旧缓存不该被立刻删掉（万一还要回滚看）')
    })
  } finally {
    safeRm(fx.root)
  }
})

test('缓存坏了就当没有：不抛错、照常重建', async () => {
  const fx = makeRoot()
  try {
    await withHome(async (home) => {
      const dir = cacheDir(join(home, 'memory-nebula'))
      const a = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7 })
      await a.refresh()
      await a.cacheWriteDone() // 写盘不阻塞响应，测试要等它落定
      const name = readdirSync(dir).find((n) => n.startsWith('graph-'))
      assert.ok(name)
      writeFileSync(join(dir, name), 'not a brotli stream at all', 'utf8') // 坏压缩体

      closeStore()
      const b = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7 })
      await b.refresh()
      await b.cacheWriteDone() // 重建之后的那次写盘也要等它落定
      assert.equal(b.lastRefresh.why, 'rebuilt', '坏缓存必须退化成重建')
      assert.equal(b.graph.nodes.length, a.graph.nodes.length)
      // 坏文件已被清掉，重建后写了新的（新的能被下一次启动读出来才算数）
      const left = readdirSync(dir).filter((n) => n.startsWith('graph-'))
      assert.equal(left.length, 1)
      closeStore()
      const c = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7 })
      await c.refresh()
      assert.equal(c.lastRefresh.why, 'cached', '重建写下的缓存必须能被下一次启动读出来')
      assert.equal(c.graph.nodes.length, a.graph.nodes.length)
    })
  } finally {
    safeRm(fx.root)
  }
})

test('NEBULA_CACHE=0 时完全不碰盘', async () => {
  const fx = makeRoot()
  try {
    await withHome(async (home) => {
      const prev = process.env.NEBULA_CACHE
      process.env.NEBULA_CACHE = '0'
      try {
        const a = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7 })
        await a.refresh()
        let files = []
        try {
          files = readdirSync(cacheDir(join(home, 'memory-nebula')))
        } catch {
          files = []
        }
        assert.equal(files.length, 0, '关掉之后一个文件都不该写')

        closeStore()
        const b = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7 })
        await b.refresh()
        assert.equal(b.lastRefresh.why, 'rebuilt', '关掉之后每次都得自己建')
      } finally {
        if (prev === undefined) delete process.env.NEBULA_CACHE
        else process.env.NEBULA_CACHE = prev
      }
    })
  } finally {
    safeRm(fx.root)
  }
})

test('文件名就是签名：同一签名同一文件，不同签名不同文件', () => {
  assert.equal(cacheName('a|b|c'), cacheName('a|b|c'))
  assert.notEqual(cacheName('a|b|c'), cacheName('a|b|d'))
  assert.match(cacheName('x'), /^graph-[0-9a-f]{16}\.json$/)
})
