import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recall, recallAsync, ensureTokenCache } from '../lib/host/recall.js'
import { buildGraph } from '../lib/host/graph.js'

/** 造一批有真实关联的小库：每 10 条共享 4 个稀有词。 */
function corpus(count) {
  const nodes = []
  for (let i = 0; i < count; i++) {
    const group = Math.floor(i / 10)
    const words = []
    for (let k = 0; k < 4; k++) words.push('rare' + group + 'x' + k)
    nodes.push({
      id: 'node-' + i,
      label: '记忆 ' + i,
      title: '记忆 ' + i,
      content: '第 ' + i + ' 条，关于部署与回滚的细节。' + words.join(' '),
      keywords: words,
      importance: 2,
      level: 'fact',
      ws: 'ws-' + (i % 3),
      createdAt: 1700000000000 + i * 1000,
      updatedAt: 1700000000000 + i * 1000,
    })
  }
  return nodes
}

const graph = buildGraph({ nodes: corpus(600), ledgers: [], manual: [], mutes: [], inventory: {} })

test('recallAsync 与 recall 结果一致（词频表同一份）', async () => {
  const sync = recall(graph, '部署 回滚', { limit: 8 })
  const first = await recallAsync(graph, '部署 回滚', { limit: 8 })
  assert.deepEqual(first.hits.map((h) => h.id), sync.hits.map((h) => h.id))
  assert.equal(first.scanned, sync.scanned)
})

test('第一次查（冷）走异步版时，事件循环没被按住', async () => {
  const fresh = buildGraph({ nodes: corpus(4000), ledgers: [], manual: [], mutes: [], inventory: {} })
  // 直接数 setImmediate：分片是否真的让路，比「定时器有没有跑」更好断言——
  // 小库上整段不到 6ms，一次都不让也是对的，那样测不出东西。
  let yields = 0
  const realSetImmediate = globalThis.setImmediate
  globalThis.setImmediate = (fn, ...args) => {
    yields++
    return realSetImmediate(fn, ...args)
  }
  let maxGap = 0
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const gap = now - last
    if (gap > maxGap) maxGap = gap
    last = now
  }, 10)
  try {
    await recallAsync(fresh, '部署', { limit: 5 })
  } finally {
    clearInterval(timer)
    globalThis.setImmediate = realSetImmediate
  }
  assert.ok(yields >= 1, '异步壳至少让出过一次事件循环（实测 ' + yields + ' 次）')
  assert.ok(maxGap <= 120, '最长空档 ' + maxGap + 'ms 超过 120ms')
})

test('词频表只算一次：同步壳与异步壳共用同一份缓存', () => {
  const g = buildGraph({ nodes: corpus(120), ledgers: [], manual: [], mutes: [], inventory: {} })
  const a = ensureTokenCache(g)
  const b = ensureTokenCache(g)
  assert.equal(a, b, '第二次应直接拿到同一份缓存')
})
