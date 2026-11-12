import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// 快照按列存（1.3.0 起）后，graph() 必须走同一条展开路径。
// 这里用最小 window 直接跑浏览器版 api.js，避免「单测只测服务端、页面却白屏」。
const source = fs.readFileSync(new URL('../lib/web/api.js', import.meta.url), 'utf8')

function makeApi(graph) {
  const window = { __NEBULA_SNAPSHOT__: { graph, builtAt: 1, version: 'test' } }
  const ctx = vm.createContext({
    window,
    location: { href: 'http://127.0.0.1:1/api/memory-nebula/' },
    history: { replaceState() {} },
    URL,
    URLSearchParams,
    console,
  })
  vm.runInContext(source, ctx)
  return window.NebulaAPI
}

test('snapshot graph() expands column rows into objects', async () => {
  const api = makeApi({
    v: 2,
    nodeColumns: ['id', 'ws', 'cluster', 'level', 'label', 'content', 'x'],
    nodes: [
      ['a', '工作区 A', 'a', 'fact', 'A', '正文 A', 10],
      ['b', '工作区 A', 'a', 'fact', 'B', '正文 B', 20],
    ],
    edgeColumns: ['s', 'd', 'w', 't'],
    edges: [[0, 1, 0.8, 'keyword']],
    clusters: [{ id: 'a', title: '工作区 A', size: 2 }],
    stats: { nodes: 2, edges: 1 },
  })
  const graph = await api.graph()
  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.nodes[0].id, 'a')
  assert.equal(graph.nodes[0].content, '正文 A')
  assert.equal(graph.edges[0].a, 'a')
  assert.equal(graph.edges[0].b, 'b')
  assert.equal(graph.edges[0].w, 0.8)
})

test('snapshot detail and recall use the same expanded graph', async () => {
  const api = makeApi({
    v: 2,
    nodeColumns: ['id', 'ws', 'cluster', 'level', 'label', 'content'],
    nodes: [
      ['a', '工作区 A', 'a', 'fact', 'Alpha', 'alpha body'],
      ['b', '工作区 A', 'a', 'fact', 'Beta', 'beta body'],
    ],
    edgeColumns: ['s', 'd', 'w', 't'],
    edges: [[0, 1, 0.8, 'keyword']],
    clusters: [{ id: 'a', title: '工作区 A', size: 2 }],
    stats: { nodes: 2, edges: 1 },
  })
  const detail = await api.node('a')
  assert.equal(detail.node.id, 'a')
  assert.equal(detail.node.content, 'alpha body')
  const hits = await api.recall('Alpha')
  assert.equal(hits.hits[0].id, 'a')
})
