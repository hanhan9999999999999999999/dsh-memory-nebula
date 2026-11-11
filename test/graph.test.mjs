import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, findNode, auditHygiene } from '../lib/host/graph.js'

const now = Date.now()
const DAY = 86400000

function mem(id, over = {}) {
  return {
    id,
    title: id,
    content: id,
    keywords: [],
    project: 'p',
    wsTitle: 'p',
    level: 'fact',
    status: 'active',
    createdAt: now - DAY,
    updatedAt: now - DAY,
    ...over,
  }
}

const trio = [
  mem('a', {
    title: '星图实现',
    content: '记忆星图用 SQLite 存节点，用关键词和实体建边。',
    keywords: ['记忆星图', 'sqlite', '关键词'],
  }),
  mem('b', {
    title: '星图设计',
    content: '记忆星图用 SQLite 存节点，用关键词和实体建关联。',
    keywords: ['记忆星图', 'sqlite', '实体'],
  }),
  mem('c', {
    title: '今天天气',
    content: '下午出去走了走，风很大。',
    keywords: ['天气'],
    project: 'q',
    wsTitle: 'q',
    level: 'topic',
  }),
]

test('buildGraph：节点下标、统计与边形状', () => {
  const g = buildGraph({ nodes: trio })
  assert.equal(g.nodes.length, 3)
  assert.equal(g.nodes[0].i, 0)
  assert.equal(g.stats.nodes, 3)
  assert.equal(g.stats.edges, g.edges.length)
  assert.equal(g.stats.byLevel.fact, 2)
  assert.equal(g.stats.byWorkspace.p, 2)
  assert.equal(g.builtAt > 0, true)
  assert.equal(g.stats.byType[g.edges[0].type] >= 1, true)
  for (const e of g.edges) {
    assert.equal(typeof e.s, 'number')
    assert.equal(typeof e.t, 'number')
    assert.notEqual(e.s, e.t)
    assert.ok(e.w > 0 && e.w <= 1)
    assert.ok(Array.isArray(e.why))
    assert.ok(typeof e.type === 'string')
  }
})

test('buildGraph：相似的两条记忆连上了，无关的那条是孤岛', () => {
  const g = buildGraph({ nodes: trio })
  const ab = g.edges.find((e) => {
    const ids = [g.nodes[e.s].id, g.nodes[e.t].id].sort()
    return ids[0] === 'a' && ids[1] === 'b'
  })
  assert.ok(ab, 'a-b 应该有边')
  assert.ok(['keyword', 'entity', 'semantic'].includes(ab.type))
  const cIdx = g.nodes.findIndex((n) => n.id === 'c')
  assert.ok(g.stats.orphans >= 1)
  assert.equal(g.edges.some((e) => e.s === cIdx || e.t === cIdx), false)
})

test('buildGraph：手工策展边权重 1、类型 explicit', () => {
  const g = buildGraph({ nodes: trio, manual: [{ a: 'c', b: 'a', note: '手动连' }] })
  const e = g.edges.find((x) => x.type === 'explicit')
  assert.ok(e)
  assert.equal(e.w, 1)
  assert.ok(e.why.join(' ').includes('手动连'))
  assert.equal(g.stats.orphans, 0)
})

test('buildGraph：mute 掉的对不再直连', () => {
  const g = buildGraph({ nodes: trio, mutes: [{ a: 'a', b: 'b' }] })
  const ab = g.edges.find((e) => {
    const ids = [g.nodes[e.s].id, g.nodes[e.t].id].sort()
    return ids[0] === 'a' && ids[1] === 'b'
  })
  assert.equal(ab, undefined)
})

test('buildGraph：空输入不炸', () => {
  const g = buildGraph({ nodes: [] })
  assert.deepEqual(g.nodes, [])
  assert.deepEqual(g.edges, [])
  assert.equal(g.stats.nodes, 0)
})

test('findNode：按 id 找，找不到返回 null', () => {
  const g = buildGraph({ nodes: trio })
  assert.equal(findNode(g.nodes, 'b').id, 'b')
  assert.equal(findNode(g.nodes, 'nope'), null)
})

test('auditHygiene：六类结构齐全，重复与孤岛能查出来', () => {
  const dupA = mem('dup-a', { content: '同一段几乎一样的话，用来测试重复检测。', keywords: ['重复'] })
  const dupB = mem('dup-b', { content: '同一段几乎一样的话，用来测试重复检测。', keywords: ['重复'] })
  const lonely = mem('lonely', { content: '完全独立的一条记忆。', keywords: ['孤立'] })
  const h = auditHygiene({ nodes: [dupA, dupB, lonely], edges: [] })
  assert.deepEqual(Object.keys(h.items).sort(), ['dup', 'orphan', 'oversize', 'stale', 'thin', 'unread'])
  assert.ok(h.counts.dup >= 1)
  assert.equal(h.items.dup[0].sim, 1)
  assert.equal(h.counts.orphan, 3)
  assert.equal(h.total, Object.values(h.counts).reduce((a, b) => a + b, 0))
  assert.ok(h.meta.dup.label)
})

test('auditHygiene：source 层不参与体检', () => {
  const h = auditHygiene({ nodes: [mem('s1', { level: 'source', content: 'x'.repeat(9000) })], edges: [] })
  assert.equal(h.counts.orphan, 0)
  assert.equal(h.counts.oversize, 0)
})

test('auditHygiene：下标形状的边也要算进孤立与弱关系（0.5.0 修复）', () => {
  const a = mem('a', { content: '甲的内容，讲一件具体的事。' })
  const b = mem('b', { content: '乙的内容，另一件具体的事。' })
  const lonely = mem('lone', { content: '完全没人提到的一条。' })
  const nodes = [a, b, lonely]
  const nodeIds = nodes.map((n) => n.id)
  // 12 条同源弱边，平均权重 0.2 < 0.45、度数 12 >= 10 → 应该进 thin
  const edges = []
  for (let i = 0; i < 12; i++) edges.push({ s: 0, t: 1, w: 0.2, type: 'keyword' })
  const h = auditHygiene({ nodes, edges, nodeIds })
  assert.equal(h.counts.orphan, 1, '只有真的没边的那个才算孤立')
  assert.equal(h.items.orphan[0].id, 'lone')
  assert.equal(h.counts.thin, 2, '两端都该被认成弱关系')
  assert.deepEqual(h.items.thin.map((x) => x.id).sort(), ['a', 'b'])
})

test('auditHygiene：a/b 形状（公开图）照样能算', () => {
  const a = mem('a', { content: '甲。' })
  const b = mem('b', { content: '乙。' })
  const edges = []
  for (let i = 0; i < 12; i++) edges.push({ a: 'a', b: 'b', w: 0.1, type: 'keyword' })
  const h = auditHygiene({ nodes: [a, b], edges })
  assert.equal(h.counts.orphan, 0)
  assert.equal(h.counts.thin, 2)
})

test('auditHygiene：有强关系的节点不进「关系是凑的」', () => {
  const a = mem('a', { content: '甲。' })
  const b = mem('b', { content: '乙。' })
  const edges = []
  for (let i = 0; i < 11; i++) edges.push({ s: 0, t: 1, w: 0.3, type: 'keyword' })
  edges.push({ s: 0, t: 1, w: 0.62, type: 'entity' })
  const h = auditHygiene({ nodes: [a, b], edges, nodeIds: ['a', 'b'] })
  assert.equal(h.counts.thin, 0, '一条实体边就该把它从「凑的」里救出来')
})
