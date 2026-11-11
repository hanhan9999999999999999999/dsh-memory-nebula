import test from 'node:test'
import assert from 'node:assert/strict'
import { findPath } from '../lib/host/path.js'

const graph = {
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
  edges: [
    { s: 0, t: 1, w: 0.5, type: 'keyword' },
    { s: 1, t: 2, w: 0.5, type: 'entity' },
    // 0-2 有一条更贵但更短的直连：优先走它（-log 代价更小 → 0.9 比 0.5*0.5 高）
    { s: 0, t: 2, w: 0.9, type: 'explicit' },
  ],
}

test('findPath：同点返回 0 跳、分数 1', () => {
  const r = findPath(graph, 1, 1)
  assert.equal(r.found, true)
  assert.equal(r.hops, 0)
  assert.equal(r.score, 1)
  assert.deepEqual(r.ids, [1])
})

test('findPath：优先走权重更高的直连', () => {
  const r = findPath(graph, 0, 2)
  assert.equal(r.found, true)
  assert.equal(r.hops, 1)
  assert.deepEqual(r.ids, [0, 2])
  assert.ok(Math.abs(r.score - 0.9) < 1e-9)
  assert.equal(r.edges[0].type, 'explicit')
})

test('findPath：只能绕行时按跳数返回路径', () => {
  const g = { nodes: graph.nodes, edges: graph.edges.filter((e) => e.type !== 'explicit') }
  const r = findPath(g, 0, 2)
  assert.equal(r.found, true)
  assert.equal(r.hops, 2)
  assert.deepEqual(r.ids, [0, 1, 2])
  assert.ok(Math.abs(r.score - 0.25) < 1e-9)
})

test('findPath：跳数上限会切断长路', () => {
  const g = { nodes: graph.nodes, edges: graph.edges.filter((e) => e.type !== 'explicit') }
  const r = findPath(g, 0, 2, { maxHops: 1 })
  assert.equal(r.found, false)
})

test('findPath：不存在的节点返回 null', () => {
  assert.equal(findPath(graph, 0, 99), null)
})

test('findPath：完全没边的图返回 null（不是空路径）', () => {
  const r = findPath({ nodes: graph.nodes, edges: [] }, 0, 3)
  assert.equal(r, null)
})
