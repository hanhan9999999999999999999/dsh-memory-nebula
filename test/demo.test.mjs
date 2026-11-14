import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph } from '../lib/host/graph.js'
import {
  DEMO_MEMORIES,
  DEMO_LEDGERS,
  DEMO_MANUAL,
  DEMO_INVENTORY,
  DEMO_SOURCES,
  DEMO_SIGNATURE,
} from '../lib/host/demo.js'
import { Nebula } from '../lib/host/nebula.js'

function demoGraph() {
  return buildGraph({
    nodes: DEMO_MEMORIES,
    ledgers: DEMO_LEDGERS,
    manual: DEMO_MANUAL,
    mutes: [],
    inventory: DEMO_INVENTORY,
    meta: { demo: true },
  })
}

test('demo: 内置数据能建出一张多工作区、有跨区桥的图', () => {
  const g = demoGraph()
  assert.equal(g.nodes.length, 64, '61 条记忆 + 3 个来源节点')
  assert.ok(g.edges.length >= 60, '边数 ' + g.edges.length)
  assert.equal(g.stats.workspaces, 6)
  assert.ok(g.stats.sessions >= 40)
  assert.ok(g.stats.byType.mentions > 0, '来源节点应该被提到')
  assert.ok(g.stats.byType.hebbian >= 8, '演示库要有共激活边')
  assert.ok(g.stats.byType.explicit >= 1, '演示库要有一条手工连边')
  // 跨工作区：星港 ↔ 设计 / 语音 / 日记之间都该有桥
  const ws = new Set(g.nodes.map((n) => n.ws))
  assert.ok(ws.size >= 5)
})

test('demo: 手工连边与「同一实体」都能真的连上', () => {
  const g = demoGraph()
  const idx = new Map(g.nodes.map((n, i) => [n.id, i]))
  const manual = g.edges.find(
    (e) => idx.get('vc-quote') === e.s && idx.get('dy-touched') === e.t && e.type === 'explicit',
  )
  assert.ok(manual, 'vc-quote ↔ dy-touched 的手工边')
  assert.ok(g.edges.some((e) => e.type === 'entity'), '至少有一条实体边')
  assert.ok(g.nodes.some((n) => n.level === 'source' && n.title === 'nebula_recall'))
})

test('demo: 体检能报出故意埋下的问题（重复 / 超长 / 过时 / 只靠弱边）', () => {
  const g = demoGraph()
  // auditHygiene 是纯函数，这里直接再算一次，避免依赖 Nebula 的缓存
  return import('../lib/host/graph.js').then(({ auditHygiene }) => {
    // 体检吃原始节点（图节点只留 preview，没有正文）
    const h = auditHygiene({ nodes: DEMO_MEMORIES, edges: g.edges, nodeIds: g.nodes.map((n) => n.id) })
    assert.ok(h.counts.dup >= 1, 'dy-copy 与 xg-vision 近似重复')
    assert.ok(h.counts.oversize >= 1)
    assert.ok(h.counts.stale >= 1)
    assert.ok(h.counts.thin >= 1, 'xg-weekly 只有弱边')
  })
})

test('demo: Nebula 走同一套代码路径，不读真实库也不写盘', async () => {
  const n = new Nebula({ demo: true, log: () => {} })
  await n.refresh()
  assert.equal(n.signature, DEMO_SIGNATURE)
  assert.equal(n.stores.length, 1)
  assert.equal(n.stores[0].key, 'demo')
  assert.equal(DEMO_SOURCES[0].dbPath, '')
  assert.equal(n.graph.nodes.length, 64)
  const pub = n.publicGraph()
  assert.equal(pub.v, 2)
  assert.ok(pub.edges.every((e) => typeof e.s === 'number' && typeof e.d === 'number'))
  assert.ok(pub.nodes.every((x) => !('content' in x)), '公开图不带正文')
  const ov = n.overview()
  assert.equal(ov.dbPath, '')
  assert.equal(ov.lastBuiltAt, '')
  assert.equal(ov.sources.length, 1)
  assert.equal(ov.sources[0].key, 'demo')
})

test('demo: 详情 / 检索 / 证据链都能用', async () => {
  const n = new Nebula({ demo: true, log: () => {} })
  await n.refresh()
  const d = await n.detail('xg-weekly')
  assert.equal(d.id, 'xg-weekly')
  assert.ok((d.content || '').length > 20, '详情要拿得到全文')
  assert.ok(d.neighbors.length >= 10)
  const r = n.recall('星港', { limit: 8 })
  assert.ok(r.hits.length >= 5)
  const p = await n.path('vc-quote', 'dy-touched', { hops: 3 })
  assert.equal(p.found, true)
  assert.equal(p.hops, 1)
})

test('demo: 来源面板不把示例库报成读取失败', async () => {
  const n = new Nebula({ demo: true, log: () => {} })
  await n.refresh()
  const rep = n.sourcesReport()
  assert.equal(rep.live.errors.length, 0, '示例库不该有读取错误')
  assert.equal(rep.live.nodes, DEMO_MEMORIES.length)
  assert.ok(rep.live.byProvider.demo > 0, '按 provider 统计里应有 demo')
})
