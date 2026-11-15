/**
 * 注入桥（bridge）的单测。
 *
 * 这一支以前一行测试都没有（函数覆盖 0%）——而它的默认路径恰好是坏的：
 * 工具层把 hops 写成 Number(args.hops) ?? 1，没传就是 NaN，扩散循环一次都不跑，
 * 于是 nebula_bridge 永远回「没有可补充的邻居」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { adjacency, bridge, renderLine, seenFromText, spread } from '../lib/host/bridge.js'

const TITLES = [
  '种子的记忆',
  '邻居甲的记忆',
  '邻居乙的教训',
  '很久没动的记忆',
  '已经归档的记忆',
  '枢纽节点',
  '人工连上的记忆',
]

const node = (i, extra = {}) => ({
  i,
  id: 'meow:m' + i,
  title: TITLES[i],
  label: 'label' + i,
  ws: 'w' + (i % 2),
  wsTitle: '工作区' + (i % 2),
  level: i === 2 ? 'lesson' : 'fact',
  importance: i === 2 ? 5 : 1,
  status: i === 4 ? 'archived' : i === 3 ? 'stale' : 'active',
  heat: 1,
  degree: i === 5 ? 500 : 2,
  preview: '正文 ' + i,
  ...extra,
})

const NODES = [node(0), node(1), node(2), node(3), node(4), node(5)]
const EDGES = [
  { s: 0, t: 1, w: 0.9, type: 'shared', why: ['同一个词：星图'] },
  { s: 0, t: 2, w: 0.7, type: 'shared', why: ['同一个项目'] },
  { s: 1, t: 3, w: 0.6, type: 'shared', why: [] },
  { s: 0, t: 4, w: 0.95, type: 'shared', why: [] },
  { s: 0, t: 5, w: 0.9, type: 'shared', why: [] },
]
const GRAPH = { nodes: NODES, edges: EDGES }

const withExplicit = (graph, w = 1) => ({
  nodes: [...graph.nodes, node(6)],
  edges: [...graph.edges, { s: 0, t: 6, w, type: 'explicit', why: ['策展'] }],
})

test('邻接表是双向的，why 原样带过去', () => {
  const adj = adjacency(GRAPH)
  const fromZero = adj.get(0)
  assert.ok(fromZero.some((e) => e.j === 1 && e.w === 0.9 && e.why[0] === '同一个词：星图'))
  const fromOne = adj.get(1)
  assert.ok(fromOne.some((e) => e.j === 0), '反向边也要在')
})

test('扩散：一跳按权重给能量，两跳再衰减；hops=0 只剩种子', () => {
  const one = spread(GRAPH, { ids: ['meow:m0'], hops: 1 })
  assert.equal(one.seedIdx.size, 1)
  assert.equal(one.energy.get(1).e, 0.9)
  assert.equal(one.energy.get(2).e, 0.7)

  const two = spread(GRAPH, { ids: ['meow:m0'], hops: 2 })
  assert.ok(two.energy.has(3), '两跳要能走到 3')
  assert.ok(two.energy.get(3).e < two.energy.get(1).e, '两跳的能量该比一跳小')

  const none = spread(GRAPH, { ids: ['meow:m0'], hops: 0 })
  assert.equal(none.energy.size, 1)
})

test('扩散：hops 是 NaN 时按 1 跳算（nebula_bridge 的默认路径就踩过这个坑）', () => {
  const nan = spread(GRAPH, { ids: ['meow:m0'], hops: NaN })
  const one = spread(GRAPH, { ids: ['meow:m0'], hops: 1 })
  assert.equal(nan.energy.size, one.energy.size)
  assert.equal(nan.energy.get(1).e, 0.9)
})

test('bridge：预算里任何一个数字写成 NaN，都回落到默认值', () => {
  const res = bridge(GRAPH, { ids: ['meow:m0'], budget: { hops: NaN, maxItems: NaN, maxChars: NaN, minWeight: NaN } })
  assert.ok(res.items.length > 0, 'NaN 不该把结果清空')
  assert.equal(res.stats.hops, 1)
})

test('bridge：归档的、超枢纽的都被排除；策展边带出来并标 explicit', () => {
  const res = bridge(withExplicit(GRAPH), { ids: ['meow:m0'] })
  const uids = res.items.map((x) => x.uid)
  assert.ok(!uids.includes('m4'), 'archived 不该出现')
  assert.ok(!uids.includes('m5'), 'degree 超上限不该出现')
  const explicit = res.items.find((x) => x.uid === 'm6')
  assert.ok(explicit, '策展边该被带出来')
  assert.equal(explicit.edgeType, 'explicit')
})

test('bridge：策展边也受 minWeight 约束（真实策展边的 w 是 1，所以平时看不出来）', () => {
  const weak = bridge(withExplicit(GRAPH, 0.05), { ids: ['meow:m0'] })
  assert.ok(!weak.items.some((x) => x.uid === 'm6'), 'w 太低的策展边照样被最小权重挡住')
})

test('bridge：见过的（完整 id 或裸 uid）与冷却期内的都不再给', () => {
  const byUid = bridge(GRAPH, { ids: ['meow:m0'], seen: new Set(['m1']) })
  assert.ok(!byUid.items.some((x) => x.uid === 'm1'))

  const byFullId = bridge(GRAPH, { ids: ['meow:m0'], seen: new Set(['meow:m2']) })
  assert.ok(!byFullId.items.some((x) => x.uid === 'm2'))

  const cooled = bridge(GRAPH, { ids: ['meow:m0'], cooldown: new Map([['m2', Date.now()]]) })
  assert.ok(!cooled.items.some((x) => x.uid === 'm2'))
})

test('bridge：stale 默认不要，明确 allowStale 才带（0.7 降权）', () => {
  const byDefault = bridge(GRAPH, { ids: ['meow:m0'], budget: { hops: 2, maxItems: 6 } })
  assert.ok(!byDefault.items.some((x) => x.uid === 'm3'), '默认不该把过期的塞进来')

  const lenient = bridge(GRAPH, { ids: ['meow:m0'], allowStale: true, budget: { hops: 2, maxItems: 6 } })
  const stale = lenient.items.find((x) => x.uid === 'm3')
  assert.ok(stale, '明确允许时该带出来')

  const fresh = lenient.items.find((x) => x.uid === 'm1')
  assert.ok(stale.score < fresh.score, 'stale 要明显低于新鲜的')
})

test('bridge：同一个工作区最多 perWorkspace 条，不够才放宽', () => {
  const many = {
    nodes: [node(0), node(1, { ws: 'w0' }), node(2, { ws: 'w0' }), node(3, { ws: 'w0', status: 'active' })],
    edges: [
      { s: 0, t: 1, w: 0.9, type: 'shared', why: [] },
      { s: 0, t: 2, w: 0.8, type: 'shared', why: [] },
      { s: 0, t: 3, w: 0.7, type: 'shared', why: [] },
    ],
  }
  const tight = bridge(many, { ids: ['meow:m0'], budget: { maxItems: 3, perWorkspace: 1 } })
  assert.ok(tight.items.length <= 3)

  const loose = bridge(many, { ids: ['meow:m0'], budget: { maxItems: 3, perWorkspace: 3, perLevel: 3 } })
  assert.equal(loose.items.length, 3, '放宽之后要填满')
})

test('bridge：字符预算超了就从尾巴砍，text 行数与 items 一致', () => {
  const res = bridge(GRAPH, { ids: ['meow:m0'], budget: { maxItems: 4, maxChars: 40 } })
  assert.ok(res.items.length >= 1)
  assert.equal(res.text.split('\n').length, res.items.length)
})

test('renderLine：中文层级 + 工作区 + 标题，最多带两条理由', () => {
  const line = renderLine({
    level: 'fact',
    wsTitle: '记忆星图',
    title: '一个很长的标题'.repeat(4),
    why: ['同一个词：星图', '同一个项目', '第三条'],
  })
  assert.ok(line.startsWith('- 【事实·记忆星图】'))
  assert.ok(line.includes('同一个词：星图') && line.includes('同一个项目'))
  assert.ok(!line.includes('第三条'), '只带前两条')
})

test('seenFromText：长标题命中算已见，短标题宁可漏判', () => {
  const graph = {
    nodes: [
      { i: 0, id: 'meow:aaa', title: '这一条标题足够长会被认出来' },
      { i: 1, id: 'meow:bbb', title: '短标题' },
    ],
  }
  const seen = seenFromText(graph, '前面一段话……这一条标题足够长会被认出来……后面还有话')
  assert.ok(seen.has('aaa'))
  assert.ok(!seen.has('bbb'))

  assert.equal(seenFromText(graph, '太短').size, 0, '文本太短不猜')
})

test('bridge：没有种子时是空的，不会抛', () => {
  const res = bridge(GRAPH, {})
  assert.equal(res.stats.seedCount, 0)
  assert.deepEqual(res.items, [])
  assert.equal(res.text, '')
})
