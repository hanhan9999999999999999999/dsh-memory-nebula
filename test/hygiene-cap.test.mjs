/**
 * 体检清单的上限（1.11.3）
 *
 * 2 万条的库里「该更新了」能有一万多条。以前 auditHygiene 把 stale 全量塞进返回值，
 * /overview 因此变成 4.5MB —— 首屏先下几 MB 才发现界面只显示前 5 条。
 * 现在列表每类最多 HY_MAX(40) 条，计数仍是全量。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { auditHygiene } from '../lib/host/graph.js'

const DAY = 86400000
const NOW = Date.now()
const CAP = 40

function mem(id, opts = {}) {
  return {
    id,
    level: opts.level || 'fact',
    title: opts.title || '记忆 ' + id,
    content: opts.content || ('内容 ' + id + '，讲一件具体的事，长度足够参与相似度判断。'),
    keywords: opts.keywords || ['孤立'],
    status: 'active',
    importance: opts.importance ?? 5,
    hits: opts.hits ?? 0,
    createdAt: opts.createdAt ?? NOW - 90 * DAY,
    updatedAt: opts.updatedAt ?? NOW - 90 * DAY,
    ws: 'w1',
    wsTitle: '工作区一',
  }
}

test('体检：列表每类不超过上限，计数仍是全量（1.11.3）', () => {
  // 130 条老记忆 + 3 条「更新的同主题记忆」→ stale 全量 130，列表只留 40。
  const nodes = []
  for (let i = 0; i < 130; i++) {
    nodes.push(mem('old-' + i, { keywords: ['施工', '部署', '回滚', '验证'], importance: 1 }))
  }
  for (let i = 0; i < 3; i++) {
    nodes.push(mem('cover-' + i, { keywords: ['施工', '部署', '回滚', '验证'], importance: 10, updatedAt: NOW }))
  }
  const h = auditHygiene({ nodes, edges: [] })

  assert.ok(h.counts.stale >= 130, '全量计数不缩水：' + h.counts.stale)
  assert.equal(h.items.stale.length, CAP, '列表截到上限')
  assert.equal(h.shown.stale, CAP)
  assert.equal(h.total, Object.values(h.counts).reduce((a, b) => a + b, 0), 'total 是各项全量之和')
  assert.ok(h.totalShown < h.total, '展示条数少于命中数')
  for (const [k, list] of Object.entries(h.items)) {
    assert.ok(list.length <= CAP, k + ' 超过上限：' + list.length)
    assert.ok(h.shown[k] <= h.counts[k], k + ' 的展示数不该大于命中数')
  }
  const bytes = Buffer.byteLength(JSON.stringify(h.items), 'utf8')
  assert.ok(bytes < 120 * 1024, '清单不该因为一条线索膨胀成几 MB：' + bytes)
})

test('体检：小库不截断时，展示数等于命中数', () => {
  const h = auditHygiene({ nodes: [mem('a', { content: '独立的一条。' }), mem('b', { content: '另一条。' })], edges: [] })
  for (const k of Object.keys(h.items)) {
    assert.equal(h.shown[k], h.counts[k], k + ' 不该出现「只列前 N 条」')
  }
  assert.equal(h.totalShown, h.total)
})
