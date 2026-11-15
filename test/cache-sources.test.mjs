import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'
import { cacheDir, loadNewestGraphCache, saveGraphCache, sourceSetKey } from '../lib/host/graphcache.js'

// 这一组回答一个问题：盘上的图能不能端给「另一批库」。
//
// 起因（1.11.33）：DSH_HOME 只有一个缓存目录，本机几个工作区共用它。
// 给一个临时库起服务时，宽松读盘（loadNewestGraphCache）会挑 mtime 最新的那一份，
// 于是端上来的是本机真实库的图 —— 条数不对，坏来源也不报错。
// 缓存可以旧，不能是别人家的。

const ROWS = 120

function makeRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), 'nebula-srcs-' + tag + '-'))
  const ws = join(root, 'proj-' + tag)
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
    const kws = ['来源集', 'r' + g + 'a', 'r' + g + 'b', 'r' + g + 'c']
    ins.run(
      tag + 'f' + i,
      tag + ' 记忆 ' + i,
      '第 ' + i + ' 条：' + kws.join(' ') + ' 说同一组里的同一件事。',
      JSON.stringify(kws),
      i % 5,
      'active',
      'proj-' + tag,
      now,
      now + i,
      i % 3,
    )
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
  const home = mkdtempSync(join(tmpdir(), 'nebula-srcshome-'))
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

test('来源集合指纹：与顺序无关，换一批就换', () => {
  const a = sourceSetKey(['meow:/x', 'meow:/y'])
  const b = sourceSetKey(['meow:/y', 'meow:/x'])
  const c = sourceSetKey(['meow:/x'])
  assert.equal(a, b, '同样的集合换个顺序不该换指纹')
  assert.notEqual(a, c, '少一个来源就该换指纹')
  assert.match(a, /^[0-9a-f]{16}$/)
})

test('宽松读盘只交同一批来源的图', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-srcsdir-'))
  try {
    const graph = { nodes: [{ id: 'n1', x: 0, y: 0 }], edges: [], stats: { edges: 0 }, builtAt: 1, muteCount: 0 }
    await saveGraphCache(dir, 'sig-a', { nodes: [{ id: 'n1', content: 'x' }], ledgers: {}, graph, srcs: 'aaaa' })

    const wrong = await loadNewestGraphCache(dir, 'bbbb')
    assert.equal(wrong, null, '另一批来源的图不能端出来')

    const right = await loadNewestGraphCache(dir, 'aaaa')
    assert.ok(right, '同一批来源应当读得到')
    assert.equal(right.srcs, 'aaaa')
    assert.equal(right.graph.nodes.length, 1)
  } finally {
    safeRm(dir)
  }
})

test('换了库就不认上一份缓存：宁可重建，也不能端别人的图', async () => {
  const rootA = makeRoot('a')
  const rootB = makeRoot('b')
  try {
    await withHome(async () => {
      const a = new Nebula({ roots: rootA, log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
      await a.refresh()
      await a.cacheWriteDone()
      assert.equal(a.lastRefresh.why, 'rebuilt')
      assert.equal(a.graph.nodes.length, ROWS)

      // 同一个 DSH_HOME、另一批库：盘上明明有一份更新的图，也不能拿来用。
      const b = new Nebula({ roots: rootB, log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
      await b.refresh()
      assert.equal(b.lastRefresh.why, 'rebuilt', '来源集合不同，就该重建而不是读盘')
      assert.equal(b.staleGraph, false, '不该标成「先给你旧的」')
      assert.equal(b.graph.nodes.length, ROWS, '条数必须是这批库的，不是上一批的')
      await b.cacheWriteDone()

      // 回到 A：这回是真的同一批来源，应当命中。
      const a2 = new Nebula({ roots: rootA, log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
      await a2.refresh()
      assert.equal(a2.lastRefresh.why, 'cached', '同一批来源要能读盘命中')
      assert.equal(a2.graph.nodes.length, ROWS)
    })
  } finally {
    safeRm(rootA)
    safeRm(rootB)
  }
})
