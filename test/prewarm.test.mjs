import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'
import { tokenCacheReady } from '../lib/host/recall.js'
import { waitFor } from '../testkit/wait.mjs'

// 布局同 curate-incremental.test.mjs：<root>/<ws>/.dsh-meow/memory.db，表名 fact。
// 每组 8 条共享三个稀有词，才长得出边（4 条一组时一个像样的权重都凑不出来）。
const ROWS = 120

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-prewarm-'))
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
    const kws = ['星图', 'rare' + g + 'a', 'rare' + g + 'b', 'rare' + g + 'c']
    ins.run(
      'f' + i,
      '预热 ' + i,
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
  return { root }
}

function safeRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 临时目录留给系统 */
  }
}

async function withNebula(fn, opts = {}) {
  const fx = makeRoot()
  const home = mkdtempSync(join(tmpdir(), 'nebula-prewarmhome-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  // sidecar 库是模块级单例，不关掉就会读到上一跑的连线
  closeStore()
  try {
    const nebula = new Nebula({ roots: [fx.root], log: () => {}, ...opts })
    await nebula.refresh()
    await fn({ nebula, fx })
  } finally {
    closeStore()
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    safeRm(fx.root)
    safeRm(home)
  }
}

test('建完图隔一拍，词频表自己在后台算好', async () => {
  await withNebula(
    async ({ nebula }) => {
      const graph = nebula.graph
      assert.equal(tokenCacheReady(graph), false, '刚建完图时不该已经有词频表')
      assert.equal(nebula.lastPrewarm?.scheduled, true, '应该有一次待办的预热')
      await waitFor('词频表预热完成', () => tokenCacheReady(graph))
      assert.equal(tokenCacheReady(graph), true, '预热没跑起来')
      assert.equal(nebula.lastPrewarm.done, true, 'lastPrewarm 应该记成已完成')
      assert.ok(nebula.lastPrewarm.ms >= 0, 'lastPrewarm.ms 应该是个数字')
    },
    { prewarmDelayMs: 20 },
  )
})

test('预热过的检索结果，与现算的一模一样', async () => {
  const hot = makeRoot()
  const cold = makeRoot()
  const home = mkdtempSync(join(tmpdir(), 'nebula-prewarmhome-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  closeStore()
  try {
    const a = new Nebula({ roots: [hot.root], log: () => {}, prewarmDelayMs: 10 })
    await a.refresh()
    await waitFor('a 这台预热完成', () => tokenCacheReady(a.graph))
    assert.equal(tokenCacheReady(a.graph), true, '这台应该已经预热过')

    // 另一台：把预热推到很远，等于从不算（同一份库、同样的图）
    const b = new Nebula({ roots: [cold.root], log: () => {}, prewarmDelayMs: 10 ** 7 })
    await b.refresh()
    assert.equal(tokenCacheReady(b.graph), false, '这台不该预热')

    const q = 'rare3a 星图'
    // recall 返回的是 { query, seeds, unknown, hits, scanned }，命中的在 hits 里
    const ra = (await a.recallAsync(q, { limit: 10, hops: 0 })).hits
    const rb = (await b.recallAsync(q, { limit: 10, hops: 0 })).hits
    assert.deepEqual(
      ra.map((x) => x.id),
      rb.map((x) => x.id),
      '预热不该改变检索结果（顺序也不行）',
    )
    assert.ok(ra.length > 0, '这个查询应该能命中几条')
    // 现算那一台跑完之后也有缓存了，再查一次结果必须一样
    assert.equal(tokenCacheReady(b.graph), true, 'recallAsync 自己也会把缓存算出来')
    const rb2 = (await b.recallAsync(q, { limit: 10, hops: 0 })).hits
    assert.deepEqual(rb2.map((x) => x.id), ra.map((x) => x.id))
  } finally {
    closeStore()
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    safeRm(hot.root)
    safeRm(cold.root)
    safeRm(home)
  }
})

test('重建之后预热跟着换到新图上，旧图不再被提起', async () => {
  await withNebula(
    async ({ nebula }) => {
      const first = nebula.graph
      await waitFor('第一张图预热完成', () => tokenCacheReady(first))
      assert.equal(tokenCacheReady(first), true, '第一张图应该预热过')

      await nebula.refresh({ force: true })
      const second = nebula.graph
      assert.notEqual(second, first, '强制重建应该换了一个 graph 对象')
      assert.equal(tokenCacheReady(second), false, '新图刚建好时还没有词频表')
      assert.equal(nebula.lastPrewarm.scheduled, true, '新图应该排上一次新的预热')
      await waitFor('第二张图预热完成', () => tokenCacheReady(second))
      assert.equal(tokenCacheReady(second), true, '第二次预热没跑起来')
    },
    { prewarmDelayMs: 20 },
  )
})
