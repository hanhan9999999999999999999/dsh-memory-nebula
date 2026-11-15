import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'

// 屏蔽（mute）只在内存里摘边，并且刻意不进签名 —— 改一条边不该让整张图重算。
// 代价是：落盘的图永远是「建图那一刻」的样子，重启读到的是屏蔽前那一份。
// 1.11.59 之前，屏蔽记录还在库里，边却回来了，界面上「已屏蔽 N 条」也变回旧数字。

const ROWS = 6
const KWS = ['屏蔽验证', '同一组词', '反复出现']

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-mute-root-'))
  const ws = join(root, 'proj')
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
  writeFileSync(join(root, 'sources.json'), JSON.stringify({ sources: [{ adapter: 'meow', root }] }), 'utf8')
  const db = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
  db.exec(
    'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, keywords TEXT, importance INTEGER, status TEXT, project TEXT, created_at INTEGER, updated_at INTEGER, hit_count INTEGER)',
  )
  const ins = db.prepare(
    'INSERT INTO fact (id,title,content,keywords,importance,status,project,created_at,updated_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
  for (let i = 0; i < ROWS; i++) {
    ins.run(
      'm' + i,
      '屏蔽样本 ' + i,
      '这一条与其它几条讲同一件事 ' + KWS.join(' ') + ' 第 ' + i + ' 次',
      JSON.stringify(KWS),
      3,
      'active',
      'proj',
      1763164800000,
      1763164800000 + i,
      1,
    )
  }
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
  const home = mkdtempSync(join(tmpdir(), 'nebula-mute-home-'))
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

function pairOf(nb) {
  const ids = nb.graph.nodes.map((n) => n.id)
  const e = nb.graph.edges.find((x) => x.s !== x.t)
  return { a: ids[e.s], b: ids[e.t], ids }
}

const hasPair = (nb, a, b) => {
  const ids = nb.graph.nodes.map((n) => n.id)
  return nb.graph.edges.some((e) => (ids[e.s] === a && ids[e.t] === b) || (ids[e.s] === b && ids[e.t] === a))
}

const open = (root) => new Nebula({ roots: root, log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })

test('屏蔽过的边：重启读盘之后也不许回来', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const first = open(root)
      await first.refresh()
      await first.cacheWriteDone()
      const total = first.graph.edges.length
      const { a, b } = pairOf(first)

      first.mute(a, b, '测试：这条是凑出来的')
      assert.equal(hasPair(first, a, b), false, '屏蔽之后内存里就该没有这条边')
      assert.equal(first.graph.muteCount, 1, '屏蔽完计数立刻要变（界面读的是它）')

      // 「重启」：同一个 DSH_HOME、同一批库，图还躺在盘上
      closeStore()
      const second = open(root)
      await second.refresh()
      assert.equal(second.lastRefresh.why, 'cached', '这一趟应当是读盘命中的')
      assert.equal(hasPair(second, a, b), false, '读盘恢复也要按屏蔽记录摘掉这条边')
      assert.equal(second.graph.edges.length, total - 1, '只摘掉被屏蔽的那一条')
      assert.equal(second.graph.muteCount, 1, '计数要跟着屏蔽记录，不是跟着旧图')
      assert.equal(second.mutes().length, 1, '屏蔽记录还在库里')
    })
  } finally {
    safeRm(root)
  }
})

test('撤销屏蔽之后：需要重算就明说，重算完那条边要回来', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const first = open(root)
      await first.refresh()
      await first.cacheWriteDone()
      const { a, b } = pairOf(first)
      first.mute(a, b)
      closeStore()

      const second = open(root)
      await second.refresh()
      assert.equal(hasPair(second, a, b), false, '读盘恢复时已经按屏蔽摘掉')

      const ok = second.unmute(a, b)
      assert.equal(ok, true)
      assert.equal(second.graph.muteCount, 0, '撤销之后计数归零')
      assert.equal(second.takeRebuildFlag(), true, '这条边回不来，必须说明「需要重算」')

      await second.refresh({ force: true })
      assert.equal(hasPair(second, a, b), true, '重算之后那条边要回来')
      assert.equal(second.graph.muteCount, 0)
    })
  } finally {
    safeRm(root)
  }
})

test('屏蔽一对根本没有边的记忆：读盘恢复不该崩，也不该少摘别的', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const first = open(root)
      await first.refresh()
      await first.cacheWriteDone()
      const before = first.graph.edges.length

      // 挑两个不相连的节点（m0 与 m5 在样本里不一定有边，这里只用 id 屏蔽）
      first.mute('meow:proj:fact:m0', 'meow:proj:fact:m5', '测试：本来就没边')
      closeStore()

      const second = open(root)
      await second.refresh()
      assert.equal(second.lastRefresh.why, 'cached')
      assert.ok(second.graph.edges.length >= before - 1, '不该因为一条不存在的边把别的边也摘掉')
      assert.equal(second.graph.muteCount, 1)
    })
  } finally {
    safeRm(root)
  }
})

test('读盘恢复之后，图里的统计也跟得上：stats.edges 与真实条数一致', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const first = open(root)
      await first.refresh()
      await first.cacheWriteDone()
      const { a, b } = pairOf(first)
      first.mute(a, b)
      closeStore()

      const second = open(root)
      await second.refresh()
      assert.equal(second.graph.edges.length, second.graph.stats.edges, '摘掉边之后 stats.edges 不能还是旧数字')
      assert.equal(second.graph.muteCount, 1, '载荷里的屏蔽数要跟着屏蔽记录')
      const ov = second.overview({ hygiene: false })
      assert.equal(ov.stats.edges, second.graph.edges.length, '概览里的边数也得是摘过之后的')
    })
  } finally {
    safeRm(root)
  }
})
