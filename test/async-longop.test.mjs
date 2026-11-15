/**
 * 1.11.4：长活分片——同步壳与异步壳必须给出**一模一样**的结果，
 * 而且异步版真的要把事件循环让出去（否则分片就是白改）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, buildGraphAsync, auditHygiene, auditHygieneAsync } from '../lib/host/graph.js'
import { scanAll, scanAllAsync } from '../lib/host/adapters/index.js'

const now = Date.now()
const DAY = 86400000

/** 造一批「看起来像真的」记忆：模板 + 少量专有词，保证既有边也有孤岛。 */
function corpus(count) {
  const topics = ['星图', '分页', '快照', '体检', '三维', '导出', '安装', '压缩', '检索', '预算']
  const nodes = []
  for (let i = 0; i < count; i++) {
    const topic = topics[i % topics.length]
    const ws = 'ws-' + (i % 4)
    // 每 20 条共享 5 个稀有词：候选生成要求「共享 ≥4 个稀有词」才连边，
    // 全是模板套话的话一条边都长不出来（真实库里也这样）。
    const group = Math.floor(i / 20)
    const rare = [0, 1, 2, 3, 4].map((k) => `rare${group}x${k}`)
    nodes.push({
      id: 'n' + i,
      title: `${topic} 第 ${i} 次记录`,
      content: `${topic} 这件事在 ${ws} 里反复出现：${topic} 的细节、${topic} 的取舍、${topic} 的验收。编号 ${i}。${rare.join(' ')}`,
      keywords: [topic, rare[0], rare[1]],
      project: 'p' + (i % 4),
      wsTitle: ws,
      level: 'fact',
      status: 'active',
      importance: (i % 5) + 1,
      createdAt: now - DAY * (1 + (i % 30)),
      updatedAt: now - DAY,
    })
  }
  return nodes
}

const edgeKey = (e) => `${e.s}-${e.t}-${e.type}-${e.w}`

test('buildGraphAsync 与 buildGraph 结果完全一致', async () => {
  const nodes = corpus(1200)
  const sync = buildGraph({ nodes })
  const async_ = await buildGraphAsync({ nodes })
  assert.equal(async_.nodes.length, sync.nodes.length)
  assert.equal(async_.edges.length, sync.edges.length)
  assert.deepEqual(async_.edges.map(edgeKey).sort(), sync.edges.map(edgeKey).sort())
  assert.deepEqual(async_.stats, sync.stats)
  assert.ok(sync.edges.length > 0, '样本应该连出边来')
})

test('auditHygieneAsync 与 auditHygiene 结果完全一致', async () => {
  const nodes = corpus(600)
  const g = buildGraph({ nodes })
  const args = { nodes, edges: g.edges, nodeIds: g.nodes.map((n) => n.id), tokensById: new Map(g.nodes.map((n) => [n.id, n.tokens])) }
  const sync = auditHygiene(args)
  const async_ = await auditHygieneAsync(args)
  assert.deepEqual(async_.counts, sync.counts)
  assert.deepEqual(async_.shown, sync.shown)
  assert.deepEqual(async_.items, sync.items)
  assert.equal(async_.total, sync.total)
})

test('scanAllAsync 与 scanAll 结果完全一致（含坏来源的报错）', async () => {
  const stores = [
    { key: 'broken', id: 'broken:1', adapter: 'nope' },
    { key: 'also-broken', id: 'also:2', adapter: 'empty' },
  ]
  assert.deepEqual(await scanAllAsync(stores), scanAll(stores))
  assert.deepEqual(await scanAllAsync([]), scanAll([]))
})

/** 跑 fn 的同时开一个 10ms 定时器，返回最长空档。 */
async function gapOf(fn) {
  let last = Date.now()
  let maxGap = 0
  let ticks = 0
  const timer = setInterval(() => {
    const t = Date.now()
    maxGap = Math.max(maxGap, t - last)
    last = t
    ticks++
  }, 10)
  const started = Date.now()
  await fn()
  const ms = Date.now() - started
  maxGap = Math.max(maxGap, Date.now() - last)
  clearInterval(timer)
  return { ms, maxGap, ticks }
}

test('异步建图期间事件循环不被饿住', async () => {
  const nodes = corpus(3000)
  const r = await gapOf(() => buildGraphAsync({ nodes }))
  // 机器太快时这一段可能几十毫秒就跑完，断言退化成「至少让出过几次」
  assert.ok(r.ticks >= 4, `定时器只跑了 ${r.ticks} 次（${r.ms}ms），说明整段被按住`)
  assert.ok(r.maxGap <= 120, `最长空档 ${r.maxGap}ms，超过 120ms 就等于没让路`)
})

test('异步建图不会把同步建图的结果改坏（交叉调用）', async () => {
  const nodes = corpus(300)
  const a = buildGraph({ nodes })
  const b = await buildGraphAsync({ nodes })
  const c = buildGraph({ nodes })
  assert.deepEqual(b.edges.map(edgeKey).sort(), a.edges.map(edgeKey).sort())
  assert.deepEqual(c.edges.map(edgeKey).sort(), a.edges.map(edgeKey).sort())
})
