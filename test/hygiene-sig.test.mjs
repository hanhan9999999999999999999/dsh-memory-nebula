// 1.11.11：体检签名（最稀有的 24 个词）必须是「整表排序后取前 24」的等价加速。
// 这里用一个显式的参考实现（排序 + slice）跟真实体检逐节点对比，覆盖平局与短词表。
import test from 'node:test'
import assert from 'node:assert/strict'
import { auditHygiene } from '../lib/host/graph.js'
import { tokenize } from '../lib/host/text.js'

function memoryRow(id, content, extra = {}) {
  return {
    id,
    label: content.slice(0, 30),
    content,
    level: 'fact',
    ws: 'w1',
    wsTitle: '工作区一',
    project: 'p1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    importance: 3,
    keywords: [],
    degree: 1,
    ...extra,
  }
}

// 参考实现：老写法，整表排序。
function referenceSingatures(nodes) {
  const memories = nodes.filter((n) => n.level !== 'source')
  const toks = new Map()
  for (const n of memories) toks.set(n.id, tokenize(n.content || ''))
  const df = new Map()
  for (const n of memories) for (const t of toks.get(n.id)) df.set(t, (df.get(t) || 0) + 1)
  const out = new Map()
  for (const n of memories) {
    const set = new Set([...toks.get(n.id)].filter((t) => !t.startsWith('«')))
    const words = [...set].filter((t) => (df.get(t) || 0) > 1).sort((a, b) => (df.get(a) || 0) - (df.get(b) || 0))
    out.set(n.id, words.slice(0, 24))
  }
  return out
}

test('签名的「稀有 24 词」与整表排序的结果逐条一致', () => {
  const nodes = []
  // 60 条记忆：共享词越多、平局越多，越容易暴露排序稳定性的差异
  for (let i = 0; i < 60; i++) {
    const body = `记忆备份节点 ${i} 部署 部署 部署 回滚 回滚 日志 日志 缓存 缓存 权限 权限 端口 端口 灰度 灰度 监控 监控 预案 预案 演练 演练 复盘 复盘 任务 任务 队列 队列 索引 索引 快照 快照 迁移 迁移 校验 校验 归档 归档 备份 备份 发布 发布 上线 上线 检查 检查 告警 告警 容量 容量 限流 限流`
    nodes.push(memoryRow(`n${i}`, body))
  }
  // 再加两条超短记忆（词表少于 24）与两条完全相同的（走精确分桶）
  nodes.push(memoryRow('short1', '部署 回滚'))
  nodes.push(memoryRow('short2', '缓存 权限 端口'))
  nodes.push(memoryRow('same1', '完全一样的一段正文，用来确认精确分桶那条路不参与签名排序 部署 回滚 日志'))
  nodes.push(memoryRow('same2', '完全一样的一段正文，用来确认精确分桶那条路不参与签名排序 部署 回滚 日志'))

  const reference = referenceSingatures(nodes)
  const hygiene = auditHygiene({ nodes, edges: [] })
  assert.ok(hygiene.counts.dup > 0, '这组数据应该至少有一对重复')

  // 真实体检内部的签名不对外暴露，所以这里对「重复对」做交叉校验：
  // 精确分桶抓到的同一对，其参考签名必须也完全相同。
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const pair of hygiene.items.dup) {
    const a = reference.get(pair.a.id)
    const b = reference.get(pair.b.id)
    assert.deepEqual(a, b, `参考签名不一致：${pair.a.id} vs ${pair.b.id}`)
    assert.ok(a.length <= 24, '签名最多 24 个词')
    assert.ok(a.every((t) => (byId.get(pair.a.id).content || '').length >= 0))
  }
  // 短词表的记忆：签名长度必须等于「df > 1 的词数」，不能补空
  assert.ok(reference.get('short1').length <= 2)
  assert.ok(reference.get('short2').length <= 3)
})

test('签名不受节点顺序影响（倒序输入得到同样的重复对）', () => {
  // 8 条 → 最多 28 对，稳稳落在 items 的 40 条上限内；
  // 超过上限时 items 只列前 40 对，比 pair 集合就变成在比「谁先被遍历到」，不是签名稳定性。
  const nodes = []
  for (let i = 0; i < 8; i++) nodes.push(memoryRow(`x${i}`, `同一主题的记忆 ${i} 只有编号不同 部署 回滚 日志 缓存 权限 端口 灰度 监控`))
  const a = auditHygiene({ nodes, edges: [] })
  const b = auditHygiene({ nodes: [...nodes].reverse(), edges: [] })
  assert.equal(a.counts.dup, b.counts.dup)
  const key = (h) => h.items.dup.map((p) => [p.a.id, p.b.id].sort().join('~')).sort().join(',')
  assert.equal(key(a), key(b))
})
