import test from 'node:test'
import assert from 'node:assert/strict'

import { ensureTokenCacheAsync, tokenCacheReady } from '../lib/host/recall.js'

// 这一条回答一个问题：两处同时要词频表，是不是只算了一遍。
//
// 起因（1.11.33）：后台预热已经开算，用户这时按下搜索 ——
// 两个调用各自从头分词，5 万条库上两份全量分词互相拖，第一次检索量到 3.5 秒。
// 现在正在算的那一趟会被复用：后来的那个拿到同一个 promise，一起等结果。

function bigGraph(n) {
  const nodes = []
  for (let i = 0; i < n; i++) {
    nodes.push({
      id: 'n' + i,
      title: '节点 ' + i + ' 说明',
      content: ('第 ' + i + ' 条记忆讲了同一组里的同一件事，' + '很长的正文用来把分词拖长一些。').repeat(6),
      keywords: ['重复' + (i % 8), 'rare' + (i % 8)],
      project: 'proj',
    })
  }
  return { nodes, edges: [] }
}

test('两处同时要词频表：只算一趟，拿到同一个 promise', async () => {
  const graph = bigGraph(4000)
  assert.equal(tokenCacheReady(graph), false, '刚开始当然没有')

  const a = ensureTokenCacheAsync(graph)
  const b = ensureTokenCacheAsync(graph)
  assert.equal(a, b, '第二个人应当等第一个人那一趟，而不是从头再算')

  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra, rb, '两处拿到的是同一份表')
  assert.equal(ra.n, 4000)
  assert.equal(tokenCacheReady(graph), true, '算完就挂在图上')

  // 算完之后再要：不该再跑一遍，直接给结果。
  const c = await ensureTokenCacheAsync(graph)
  assert.equal(c, ra)
})
