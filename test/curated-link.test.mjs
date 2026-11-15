import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'

// 人工连线（curated link）与自动边撞在同一对上时，两件事必须各自成立：
//   1) 主人手动连上（留一句话）要看得见 —— 边升级成 explicit，原有证据留在 why 里；
//   2) 主人取消自己那根线之后，系统自己找到的关系要回来 —— 取消的不是「这条关系」。
// 1.11.60 之前：第 1 步界面毫无变化，第 2 步把系统边一起摘掉，要等重建才回来。

const KWS = ['连线校验', '同一组词', '反复出现']

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-curated-root-'))
  const ws = join(root, 'proj')
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
  const db = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
  db.exec(
    'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, keywords TEXT, importance INTEGER, status TEXT, project TEXT, created_at INTEGER, updated_at INTEGER, hit_count INTEGER)',
  )
  const ins = db.prepare(
    'INSERT INTO fact (id,title,content,keywords,importance,status,project,created_at,updated_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
  for (let i = 0; i < 5; i++) {
    ins.run(
      'm' + i,
      '连线样本 ' + i,
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
  // 一条与谁都不沾边的记忆：用来验「本来没有这条边」的那条路
  ins.run(
    'solo',
    '孤零零的一条',
    '菜市场今天豆腐降价了，顺便买了两根葱和一斤豆角。',
    JSON.stringify(['买菜']),
    2,
    'active',
    'proj',
    1763164800000,
    1763164800009,
    0,
  )
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
  const home = mkdtempSync(join(tmpdir(), 'nebula-curated-home-'))
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

const open = (root) => new Nebula({ roots: root, log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })

const idx = (nb, id) => nb.graph.nodes.findIndex((n) => n.id === id)
const edgeOf = (nb, a, b) => {
  const s = Math.min(idx(nb, a), idx(nb, b))
  const t = Math.max(idx(nb, a), idx(nb, b))
  return nb.graph.edges.find((e) => e.s === s && e.t === t) || null
}

test('手动连上系统已有的那一对：边升级成人工，原有证据还在', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const nb = open(root)
      await nb.refresh()
      const auto = edgeOf(nb, 'meow:proj:fact:m0', 'meow:proj:fact:m1')
      assert.ok(auto, '夹具应当先有一条自动边')
      assert.notEqual(auto.type, 'explicit')
      const before = nb.graph.edges.length

      nb.link('meow:proj:fact:m0', 'meow:proj:fact:m1', '我确认这两条是一件事')
      const after = edgeOf(nb, 'meow:proj:fact:m0', 'meow:proj:fact:m1')
      assert.equal(nb.graph.edges.length, before, '升级不能多出一条边')
      assert.equal(after.type, 'explicit', '主人连的这条应当一眼看得出是人工的')
      assert.match(after.why[0], /策展：我确认这两条是一件事/)
      assert.ok(after.why.length >= 2, '系统原来的理由也要留着，不能只剩一句策展')
      assert.ok(after.why.some((w) => w === auto.why[0]), '原证据原样保留')
    })
  } finally {
    safeRm(root)
  }
})

test('取消连线：系统原本那条关系要回来，边数不变，也不用重建', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const nb = open(root)
      await nb.refresh()
      const auto = edgeOf(nb, 'meow:proj:fact:m0', 'meow:proj:fact:m1')
      const before = nb.graph.edges.length

      nb.link('meow:proj:fact:m0', 'meow:proj:fact:m1', '先连一下')
      assert.ok(nb.unlink('meow:proj:fact:m0', 'meow:proj:fact:m1'))
      const back = edgeOf(nb, 'meow:proj:fact:m0', 'meow:proj:fact:m1')
      assert.ok(back, '取消人工连线不该把系统那条一起摘掉')
      assert.equal(back.type, auto.type)
      assert.equal(back.w, auto.w)
      assert.deepEqual(back.why, auto.why)
      assert.equal(nb.graph.edges.length, before, '边数回到原样')
      assert.equal(nb.takeRebuildFlag(), false, '原样放回就够了，不需要重算整张图')
      assert.equal(nb.graph.muteCount, 0)
      assert.equal(nb.graph.stats.edges, nb.graph.edges.length)
    })
  } finally {
    safeRm(root)
  }
})

test('本来没有这条边：连上就多一条，取消就少一条', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const nb = open(root)
      await nb.refresh()
      const a = 'meow:proj:fact:solo'
      const b = 'meow:proj:fact:m0'
      assert.equal(edgeOf(nb, a, b), null, '这条孤零零的记忆本来不该和别人连着')
      const before = nb.graph.edges.length

      nb.link(a, b, '其实是一件事')
      const one = edgeOf(nb, a, b)
      assert.ok(one)
      assert.equal(one.type, 'explicit')
      assert.equal(nb.graph.edges.length, before + 1)

      assert.ok(nb.unlink(a, b))
      assert.equal(edgeOf(nb, a, b), null)
      assert.equal(nb.graph.edges.length, before, '取消之后边数回到原样')
      assert.equal(nb.graph.stats.edges, nb.graph.edges.length)
    })
  } finally {
    safeRm(root)
  }
})

test('屏蔽优先：被屏蔽的一对，取消连线也不许把边放回来', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const nb = open(root)
      await nb.refresh()
      const a = 'meow:proj:fact:m0'
      const b = 'meow:proj:fact:m1'
      const before = nb.graph.edges.length

      nb.link(a, b, '先连上，再屏蔽')
      nb.mute(a, b, '这一对是凑出来的')
      assert.equal(edgeOf(nb, a, b), null)
      assert.equal(nb.graph.edges.length, before - 1, '屏蔽要把这条边摘掉')

      assert.ok(nb.unlink(a, b), '人工连线记录还在，可以取消')
      assert.equal(edgeOf(nb, a, b), null, '屏蔽着的对，取消连线也不该把边放回来')
      assert.equal(nb.mutes().length, 1)
      assert.equal(nb.graph.muteCount, 1)

      assert.ok(nb.unmute(a, b))
      const back = edgeOf(nb, a, b)
      assert.ok(back, '撤销屏蔽之后这条关联要回来')
      assert.equal(nb.graph.muteCount, 0)
    })
  } finally {
    safeRm(root)
  }
})
