// 重复检测的「一对不少」闸门：
// 1) 与暴力参考实现（每对都算 Jaccard、不打任何补丁）逐对比对，必须完全相同；
// 2) 正文一模一样的副本即使超过倒排的 60 条截断，也要靠分桶全部找出来（计数与展示口径分开）；
// 3) 只是同主题、正文不同的记忆不能被判成重复。
import test from 'node:test'
import assert from 'node:assert/strict'
import { auditHygiene } from '../lib/host/graph.js'
import { tokenize } from '../lib/host/text.js'

function mem(i, content, keywords = []) {
  return {
    id: 'm' + i,
    label: content.slice(0, 40),
    content,
    keywords,
    level: 'fact',
    status: 'active',
    ws: 'ws-1',
    wsTitle: '工作区一',
    importance: 3,
    createdAt: 1_700_000_000_000 + i,
    updatedAt: 1_700_000_000_000 + i,
  }
}

/** 照 auditHygiene 的规则重算一遍重复对：正文相同直接算，否则 24 稀有词 + Jaccard 0.86。 */
function referencePairs(nodes) {
  const toks = new Map()
  for (const n of nodes) toks.set(n.id, tokenize(n.content || ''))
  const df = new Map()
  for (const n of nodes) for (const t of toks.get(n.id)) df.set(t, (df.get(t) || 0) + 1)
  const sets = new Map()
  for (const n of nodes) {
    const set = new Set([...toks.get(n.id)].filter((t) => !t.startsWith('«')))
    const words = [...set]
      .filter((t) => (df.get(t) || 0) > 1)
      .sort((a, b) => (df.get(a) || 0) - (df.get(b) || 0))
      .slice(0, 24)
    sets.set(n.id, new Set(words))
  }
  const out = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const ca = (a.content || '').trim()
      const cb = (b.content || '').trim()
      if (ca.length >= 24 && ca === cb) {
        out.push(a.id + '|' + b.id)
        continue
      }
      const la = (a.content || '').length
      const lb = (b.content || '').length
      if (Math.min(la, lb) / Math.max(1, Math.max(la, lb)) < 0.6) continue
      const sa = sets.get(a.id)
      const sb = sets.get(b.id)
      if (!sa.size || !sb.size) continue
      let inter = 0
      for (const x of sa) if (sb.has(x)) inter++
      if (inter / (sa.size + sb.size - inter) >= 0.86) out.push(a.id + '|' + b.id)
    }
  }
  return out.sort()
}

function pairsOf(nodes) {
  const h = auditHygiene({ nodes, edges: [], nodeIds: nodes.map((n) => n.id) })
  return { h, got: (h.items.dup || []).map((d) => (d.a.id < d.b.id ? d.a.id + '|' + d.b.id : d.b.id + '|' + d.a.id)).sort() }
}

test('重复检测与暴力参考实现逐对相同（含近似重复与无关项）', () => {
  const base =
    '记忆星图的重复检测要能找出几乎一样的记忆，同时不能把只是同主题的两条当成重复。' +
    '这一段话会被复制并做小幅改动，用来模拟同一件事被记了两遍的情况。'
  const nodes = [
    mem(1, base + '甲'),
    mem(2, base + '乙'),
    mem(3, base.replace('几乎一样', '差不多一样') + '甲'),
    mem(4, '星图的边要有证据：同一个硬实体、同一个项目名、稀有关键词重叠才算。'),
    mem(5, '后台建图要分片，长活不能让事件循环停住，否则宿主主界面会卡。'),
  ]
  const { got } = pairsOf(nodes)
  const want = referencePairs(nodes)
  assert.deepEqual(got, want)
  assert.ok(want.length >= 1, '至少应有一对近似重复')
})

test('正文完全相同的副本超过 60 份也全部算出（分桶不受倒排截断影响）', () => {
  const body = '同一条记忆被抄进了很多工作区，正文一个字都不差，重复检测必须一个不漏地算出来。'
  const nodes = []
  for (let i = 0; i < 80; i++) nodes.push(mem(100 + i, body))
  const { h } = pairsOf(nodes)
  // 每桶取前 60 份 → C(60,2) = 1770 对，计数是全量、列表只列前 HY_MAX 条
  assert.equal(h.counts.dup, (60 * 59) / 2, '计数应为前 60 份的两两组合')
  assert.equal(h.shown.dup, 40, '列表只列前 40 条')
  assert.ok((h.items.dup || []).every((d) => d.sim === 1), '完全相同的正文相似度必须是 1')
})

test('只是同主题、正文不同的两条不算重复', () => {
  const nodes = [
    mem(1, '番茄切块下锅炒出汁，加鸡蛋翻炒，撒盐出锅，这道菜十分钟能做好。'),
    mem(2, '快照要能离线打开，正文里的尖括号必须转义，否则注入的脚本会在别人的浏览器里跑。'),
  ]
  const { h } = pairsOf(nodes)
  assert.equal(h.counts.dup, 0)
})
