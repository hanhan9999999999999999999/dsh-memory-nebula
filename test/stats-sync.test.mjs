// 边的统计数字只有一个来源：图本身。
// 以前 restamp() 用 { ...g.stats } 浅拷贝，byType 一直停在建图那一刻 ——
// 屏蔽一条边之后，图例里各类型加起来比总边数多一条（1.11.65 修）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Nebula } from '../lib/host/nebula.js'

const HOME = mkdtempSync(join(tmpdir(), 'nebula-stats-sync-'))
const ROOT = mkdtempSync(join(tmpdir(), 'nebula-stats-root-'))
const notes = join(ROOT, 'notes')
mkdirSync(notes, { recursive: true })
for (let i = 0; i < 6; i += 1) {
  writeFileSync(join(notes, `n${i}.md`), `# 卡片 ${i}\n\n星图 旁路库 共激活 稀有词 记忆 关联 扩散 证据 链路 ${i}\n`, 'utf8')
}
mkdirSync(join(HOME, 'memory-nebula'), { recursive: true })
writeFileSync(
  join(HOME, 'memory-nebula', 'sources.json'),
  JSON.stringify({ sources: [{ type: 'notes', id: 'stats-notes', path: notes }] }),
  'utf8',
)

const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME

const nb = new Nebula({ roots: ROOT, log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })

/** 图里的边、stats.edges、byType 合计必须同时相等。 */
function assertConsistent(tag) {
  const g = nb.graph
  const sum = Object.values(g.stats.byType || {}).reduce((s, v) => s + v, 0)
  assert.equal(g.stats.edges, g.edges.length, `${tag}：stats.edges 和图里的边数不一致`)
  assert.equal(sum, g.edges.length, `${tag}：byType 合计 ${sum} 与边数 ${g.edges.length} 不一致`)
}

test.after(() => {
  try {
    nb.close?.()
  } catch {
    /* 关不掉不影响结论 */
  }
  if (oldHome == null) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  for (const dir of [ROOT, HOME]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8 })
    } catch {
      /* Windows 上偶尔锁住，交给系统清理 */
    }
  }
})

test('建图之后三个数字本来就一致', async () => {
  await nb.refresh({ force: true })
  assert.ok(nb.graph.edges.length > 0, '夹具没连出边来，后面的断言没有意义')
  assertConsistent('建图后')
})

test('屏蔽一条边：总边数与按类型分同时减一', () => {
  const before = nb.graph.edges.length
  const [a, b] = nb.graph.nodes.map((n) => n.id)
  nb.mute(a, b)
  assert.equal(nb.mutes().length, 1, '屏蔽没有记进库里')
  assert.equal(nb.graph.edges.length, before - 1, '屏蔽后图里应该少一条边')
  assertConsistent('屏蔽后')
})

test('撤销屏蔽：放回来的那条也算进按类型', () => {
  const [a, b] = nb.graph.nodes.map((n) => n.id)
  const before = nb.graph.edges.length
  assert.equal(nb.unmute(a, b), true)
  assert.equal(nb.graph.edges.length, before + 1, '撤销屏蔽应该把边放回来')
  assertConsistent('撤销屏蔽后')
})

test('人工连线与取消连线都不破坏统计', () => {
  const [a, b] = nb.graph.nodes.map((n) => n.id)
  nb.link(a, b, '我确认这两条是一件事')
  assertConsistent('人工连线后')
  nb.unlink(a, b)
  assertConsistent('取消连线后')
})

test('屏蔽一对本来没有边的记忆，也不许把统计改坏', () => {
  nb.mute(nb.graph.nodes[0].id, nb.graph.nodes[5].id)
  assertConsistent('屏蔽一对没有边的')
})
