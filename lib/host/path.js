// 两点之间「最短证据链」——回答“这两条记忆到底怎么连上的”
// 代价用 -log(w)：权重越高的边越便宜，等于优先走证据最硬的那条路。
// 同时限制跳数，避免 800 节点图上绕一大圈出来一个“六度分隔”式的假解释。

const MAX_HOPS = 6
const MIN_W = 0.05

function adjacency(graph) {
  const adj = new Map()
  for (const e of graph.edges) {
    const s = e.s ?? e._s
    const t = e.t ?? e._t
    if (s == null || t == null) continue
    const w = Math.max(MIN_W, e.w || 0)
    if (!adj.has(s)) adj.set(s, [])
    if (!adj.has(t)) adj.set(t, [])
    adj.get(s).push({ to: t, w, e })
    adj.get(t).push({ to: s, w, e })
  }
  return adj
}

/**
 * @returns {null | {found:boolean, ids:number[], edges:object[], hops:number, score:number}}
 */
export function findPath(graph, fromIdx, toIdx, opts = {}) {
  const maxHops = opts.maxHops || MAX_HOPS
  if (fromIdx === toIdx) return { found: true, ids: [fromIdx], edges: [], hops: 0, score: 1 }
  const adj = adjacency(graph)
  if (!adj.has(fromIdx) || !adj.has(toIdx)) return null

  const n = graph.nodes.length
  const dist = new Float64Array(n).fill(Infinity)
  const hops = new Int32Array(n).fill(1 << 30)
  const prevEdge = new Array(n).fill(null)
  const prevNode = new Int32Array(n).fill(-1)
  const seen = new Uint8Array(n)
  dist[fromIdx] = 0
  hops[fromIdx] = 0

  // 节点数 ~1000，线性取最小就够快，不必上堆
  for (;;) {
    let u = -1
    let best = Infinity
    for (let i = 0; i < n; i += 1) {
      if (!seen[i] && dist[i] < best) {
        best = dist[i]
        u = i
      }
    }
    if (u < 0) break
    if (u === toIdx) break
    seen[u] = 1
    if (hops[u] >= maxHops) continue
    for (const link of adj.get(u) || []) {
      if (seen[link.to]) continue
      const nd = dist[u] - Math.log(link.w)
      // 同样便宜时，优先跳数少的（更好解释）
      if (nd < dist[link.to] - 1e-9 || (Math.abs(nd - dist[link.to]) < 1e-9 && hops[u] + 1 < hops[link.to])) {
        dist[link.to] = nd
        hops[link.to] = hops[u] + 1
        prevNode[link.to] = u
        prevEdge[link.to] = link.e
      }
    }
  }

  if (!Number.isFinite(dist[toIdx])) return { found: false, ids: [], edges: [], hops: 0, score: 0 }
  const ids = []
  const edges = []
  let cur = toIdx
  while (cur !== -1 && ids.length <= maxHops + 1) {
    ids.push(cur)
    const e = prevEdge[cur]
    if (e) edges.push(e)
    if (cur === fromIdx) break
    cur = prevNode[cur]
  }
  ids.reverse()
  edges.reverse()
  const score = edges.reduce((acc, e) => acc * Math.max(MIN_W, e.w || 0), 1)
  return { found: true, ids, edges, hops: edges.length, score }
}
