import test from 'node:test'
import assert from 'node:assert/strict'
import { FIRST_PAGE_MAX, PAGE_MAX, pageOrder, selectPage } from '../lib/host/page.js'
import { Nebula } from '../lib/host/nebula.js'

const node = (i, importance, degree = 0) => ({ id: 'n' + i, importance, degree, title: 't' + i })

test('pageOrder：重要度优先，其次度数，最后按 id 兜底', () => {
  const g = { nodes: [node(0, 1, 2), node(1, 5, 1), node(2, 1, 9), node(3, 5, 1)] }
  const order = Array.from(pageOrder(g))
  // n1 与 n3 重要度和度数都一样 → 按 id 升序，n1 在前
  assert.deepEqual(order, [1, 3, 2, 0])
})

test('pageOrder：空图不炸', () => {
  assert.deepEqual(Array.from(pageOrder({ nodes: [] })), [])
})

test('selectPage：不传参数时小图全量返回', () => {
  const g = { nodes: [node(0, 3), node(1, 2), node(2, 1)] }
  const { indices, page } = selectPage(g)
  assert.deepEqual(indices, [0, 1, 2])
  assert.deepEqual(page, { total: 3, offset: 0, limit: 3, next: null, order: 'importance' })
})

test('selectPage：大图缺省截第一页，next 指到下一页', () => {
  const nodes = []
  for (let i = 0; i < FIRST_PAGE_MAX + 5; i++) nodes.push(node(i, i))
  const { indices, page } = selectPage({ nodes })
  assert.equal(indices.length, FIRST_PAGE_MAX)
  assert.equal(page.total, FIRST_PAGE_MAX + 5)
  assert.equal(page.next, FIRST_PAGE_MAX)
})

test('selectPage：显式 limit/offset 生效，越界收敛', () => {
  const g = { nodes: [node(0, 9), node(1, 8), node(2, 7), node(3, 6)] }
  const a = selectPage(g, { limit: 2, offset: 1 })
  assert.deepEqual(a.indices, [1, 2])
  assert.equal(a.page.next, 3)
  const b = selectPage(g, { limit: 2, offset: 99 })
  assert.deepEqual(b.indices, [])
  assert.equal(b.page.next, null)
})

test('selectPage：limit 超过 PAGE_MAX 时按 PAGE_MAX 截断', () => {
  const g = { nodes: [node(0, 1), node(1, 2)] }
  const { page } = selectPage(g, { limit: PAGE_MAX + 100 })
  assert.equal(page.limit, 2) // 图本身只有两条，上限只防「一次要太多」
})

function fakeNebula(n, edges) {
  const nebula = Object.create(Nebula.prototype)
  nebula._pageCache = null
  nebula.lastBuildMs = 1
  nebula.lastError = ''
  nebula.signature = 'sig-test'
  nebula.graph = {
    nodes: Array.from({ length: n }, (_, i) => ({
      ...node(i, n - i),
      i,
      ws: 'w1',
      wsTitle: '工作区一',
      level: 'fact',
      heat: 0.5,
      hits: 0,
      status: 'active',
      createdAt: 0,
    })),
    edges: edges.map(([s, t, w = 0.5, type = 'keyword']) => ({ s, t, w, type, curated: false })),
    clusters: [],
    stats: {},
    builtAt: 1,
  }
  return nebula
}

test('publicGraph：小图保持整图，page.next 为 null', () => {
  const nebula = fakeNebula(5, [[0, 1], [1, 2]])
  const g = nebula.publicGraph()
  assert.equal(g.nodes.length, 5)
  assert.equal(g.edges.length, 2)
  assert.equal(typeof g.edges[0].s, 'number')
  assert.equal(g.page.next, null)
})

test('publicGraph：分页时页内边用下标、跨页边用 id', () => {
  // 顺序 n0..n4；取 rank 2..3（n2、n3）
  const nebula = fakeNebula(5, [
    [0, 2], // 跨页（前一页 → 当前页）：要留下，用 id
    [2, 3], // 页内：用下标
    [3, 4], // 另一端还没加载：不发
    [0, 1], // 两端都在前面：不发
  ])
  const g = nebula.publicGraph({ limit: 2, offset: 2 })
  assert.equal(g.nodes.length, 2)
  assert.deepEqual(g.nodes.map((x) => x.id), ['n2', 'n3'])
  assert.deepEqual(g.page, { total: 5, offset: 2, limit: 2, next: 4, order: 'importance' })
  const local = g.edges.find((e) => typeof e.s === 'number')
  assert.ok(local, '页内边应当用下标')
  assert.deepEqual([local.s, local.d], [0, 1])
  const cross = g.edges.find((e) => typeof e.a === 'string')
  assert.ok(cross, '跨页边应当用 id')
  assert.deepEqual([cross.a, cross.b], ['n0', 'n2'])
  assert.equal(g.edges.length, 2)
})

test('publicGraph：最后一页 next 为 null', () => {
  const nebula = fakeNebula(5, [])
  const g = nebula.publicGraph({ limit: 2, offset: 4 })
  assert.equal(g.nodes.length, 1)
  assert.equal(g.page.next, null)
})

test('publicGraph：重复请求复用同一份排序（签名不变就不重排）', () => {
  const nebula = fakeNebula(5, [])
  nebula.publicGraph({ limit: 2 })
  const cache = nebula._pageCache
  nebula.publicGraph({ limit: 2, offset: 2 })
  assert.equal(nebula._pageCache, cache)
})

test('Nebula 大图：page 字段与节点数一致，边两端都落在已加载集合里', async () => {
  const demo = new Nebula({ demo: true, log: () => {} })
  await demo.refresh()
  const total = demo.graph.nodes.length
  const pageSize = Math.max(1, Math.floor(total / 3))
  const g = demo.publicGraph({ limit: pageSize })
  assert.equal(g.nodes.length, Math.min(pageSize, total))
  assert.equal(g.page.total, total)
  const ids = new Set(g.nodes.map((x) => x.id))
  for (const e of g.edges) {
    if (typeof e.s === 'number') {
      assert.ok(g.nodes[e.s] && g.nodes[e.d], '下标边必须指向本页节点')
    } else {
      assert.ok(ids.has(e.a) || ids.has(e.b), '跨页边至少有一端在本页')
    }
  }
})
