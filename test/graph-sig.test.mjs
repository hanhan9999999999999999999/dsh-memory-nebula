// 参考实现：整表排序 + slice，用来钉死 topRareTokens 的等价性。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { topRareTokens } from '../lib/host/graph.js'

const reference = (tokens, weightOf, top) => {
  const arr = [...tokens]
  arr.sort((a, b) => weightOf(b) - weightOf(a))
  return new Set(arr.slice(0, top))
}

// 固定种子的伪随机，保证这条测试每次跑的是同一批用例
const rng = (seed) => {
  let x = seed >>> 0
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
}

test('有界插入与「整表排序 + slice」逐例等价（含等权重的先后）', () => {
  const rand = rng(20261115)
  for (let round = 0; round < 400; round++) {
    const size = 1 + Math.floor(rand() * 80)
    const tokens = []
    const weights = new Map()
    for (let i = 0; i < size; i++) {
      const t = 't' + i
      tokens.push(t)
      // 权重故意只用很少几档，制造大量并列，专门考「等权重谁排前面」
      weights.set(t, Math.floor(rand() * 5))
    }
    const weightOf = (t) => weights.get(t)
    for (const top of [1, 2, 5, 26, 40]) {
      const got = topRareTokens(tokens, weightOf, top)
      const want = reference(tokens, weightOf, top)
      assert.deepEqual([...got].sort(), [...want].sort(), 'round ' + round + ' top ' + top)
      assert.equal(got.size, want.size)
    }
  }
})

test('词数不足时全给，且不补空位', () => {
  const weights = new Map([['a', 1], ['b', 1], ['c', 1]])
  const got = topRareTokens(['a', 'b', 'c'], (t) => weights.get(t), 26)
  assert.deepEqual([...got].sort(), ['a', 'b', 'c'])
})

test('等权重时先来先得，不会把后来的挤到前面', () => {
  const weights = new Map([['a', 2], ['b', 2], ['c', 1]])
  const got = topRareTokens(['a', 'b', 'c'], (t) => weights.get(t), 2)
  assert.deepEqual([...got], ['a', 'b'])
  assert.deepEqual([...got], [...reference(['a', 'b', 'c'], (t) => weights.get(t), 2)])
})

test('权重全相等时取前 top 个（与稳定排序一致）', () => {
  const tokens = Array.from({ length: 30 }, (_, i) => 'w' + i)
  const got = topRareTokens(tokens, () => 7, 26)
  assert.deepEqual([...got], tokens.slice(0, 26))
})

test('冻结时间：同一份输入两次建图的边与 stats 完全一致', async () => {
  const { buildGraph } = await import('../lib/host/graph.js')
  const memories = []
  for (let i = 0; i < 40; i++) {
    memories.push({
      id: 'm' + i,
      kind: 'memory',
      ws: 'ws' + (i % 3),
      content: '共享稀有词 rare' + (i % 7) + ' alpha beta gamma ' + (i % 4 === 0 ? 'delta epsilon' : ''),
      keywords: ['k' + (i % 5)],
      importance: 1 + (i % 3),
      createdAt: 1700000000000 - i * 1000,
      updatedAt: 1700000000000 - i * 1000,
    })
  }
  const input = { nodes: memories, ledgers: [], manual: [], mutes: [], inventory: {}, now: 1763164800000 }
  const a = buildGraph(input)
  const b = buildGraph(input)
  const key = (g) => g.edges.map((e) => e.s + '>' + e.d + '|' + e.w + '|' + e.type).sort()
  assert.deepEqual(key(a), key(b))
  assert.deepEqual(a.stats, b.stats)
  // 不传 now 时仍要能跑（默认取当下）
  const c = buildGraph({ nodes: memories, ledgers: [], manual: [], mutes: [], inventory: {} })
  assert.equal(c.nodes.length, a.nodes.length)
})
