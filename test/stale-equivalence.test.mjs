import test from 'node:test'
import assert from 'node:assert/strict'
import { auditHygiene } from '../lib/host/graph.js'

const DAY = 86400000

// 造一批记忆：同主题共享 3–5 个词，另有各自独有的词，混着新旧与重要性
function corpus() {
  const now = Date.now()
  const nodes = []
  const ws = 'ws-a'
  for (let i = 0; i < 60; i++) {
    const group = i % 6
    const kws = ['topic' + group, 'sub' + group, 'kind' + group]
    if (i % 2 === 0) kws.push('extra' + group)
    kws.push('own' + i)
    // 越靠前的越新：i 越大越老
    const updatedAt = now - (i + 1) * 3 * DAY
    nodes.push({
      id: 'n' + i,
      label: '记忆 ' + i,
      ws,
      wsTitle: '工作区 A',
      level: 3,
      status: 'active',
      keywords: kws,
      content: '正文 ' + i,
      importance: (i % 3) + 1,
      createdAt: updatedAt,
      updatedAt,
      hits: 1,
    })
  }
  return nodes
}

// 参考实现：把旧写法的语义原样写一遍（逐条扫全工作区，不做任何前缀剪枝）
function reference(nodes) {
  const now = Date.now()
  const out = new Set()
  for (const n of nodes) {
    if (n.status !== 'active') continue
    const ageDays = (now - (n.updatedAt || n.createdAt || now)) / DAY
    if (ageDays < 14) continue
    const kwsN = new Set(n.keywords.map((x) => String(x).toLowerCase()))
    for (const m of nodes) {
      if (m.id === n.id || m.status !== 'active') continue
      if ((m.updatedAt || 0) <= (n.updatedAt || 0)) continue
      if ((m.importance || 0) < (n.importance || 0)) continue
      let hit = 0
      for (const k of new Set(m.keywords.map((x) => String(x).toLowerCase()))) if (kwsN.has(k)) hit++
      if (hit >= 3) {
        out.add(n.id)
        break
      }
    }
  }
  return out
}

test('「该更新了」：前缀剪枝与逐条全扫给出同一批记忆', () => {
  const nodes = corpus()
  const h = auditHygiene({ nodes, edges: [], nodeIds: nodes.map((n) => n.id) })
  const got = new Set()
  for (const it of h.items.stale || []) got.add(it.id)
  const want = reference(nodes)
  // items 只列前 40 条，但计数是全量：两者要能对上
  assert.equal(h.counts.stale, want.size)
  assert.equal(h.shown.stale, Math.min(40, want.size))
  for (const id of got) assert.ok(want.has(id), id + ' 不该被标成该更新')
  // 反方向：前 40 条里不能漏（按天数排序，取前 40 与参考集合的交集）
  assert.equal(got.size, h.shown.stale)
})

test('「该更新了」：by 指向的确实是一条更新的、更重要的、共享 ≥3 个词的记忆', () => {
  const nodes = corpus()
  const h = auditHygiene({ nodes, edges: [], nodeIds: nodes.map((n) => n.id) })
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const it of h.items.stale || []) {
    const n = byId.get(it.id)
    const m = byId.get(it.by.id)
    assert.ok(n && m, 'id 要在原数据里找得到')
    assert.ok((m.updatedAt || 0) > (n.updatedAt || 0), 'by 必须更新')
    assert.ok((m.importance || 0) >= (n.importance || 0), 'by 不能更不重要')
    const a = new Set(n.keywords.map((x) => x.toLowerCase()))
    let hit = 0
    for (const k of new Set(m.keywords.map((x) => x.toLowerCase()))) if (a.has(k)) hit++
    assert.ok(hit >= 3, 'by 与它至少要共享 3 个关键词，实际 ' + hit)
  }
  assert.ok((h.items.stale || []).length > 0, '这批数据里应该有人该更新')
})

test('「该更新了」：关键词不足 3 个的记忆永远不会被判为该更新', () => {
  const now = Date.now()
  const old = now - 60 * DAY
  const nodes = []
  for (let i = 0; i < 12; i++) {
    nodes.push({
      id: 'f' + i,
      label: '少词 ' + i,
      ws: 'ws-b',
      wsTitle: '工作区 B',
      level: 3,
      status: 'active',
      keywords: ['only' + i, 'shared' + (i % 3)],
      content: 'x',
      importance: 1,
      createdAt: old,
      updatedAt: old + i,
      hits: 1,
    })
  }
  const h = auditHygiene({ nodes, edges: [], nodeIds: nodes.map((n) => n.id) })
  assert.equal(h.counts.stale, 0)
})
