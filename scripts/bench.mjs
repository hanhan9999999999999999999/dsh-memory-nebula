#!/usr/bin/env node
// 万条规模基准：不依赖真实记忆库，生成确定性的合成数据，量建图、检索、证据链、
// 体检和单文件快照的耗时。用法：
//   node scripts/bench.mjs                 # 1 万条记忆
//   node scripts/bench.mjs --nodes 3000    # 小一号
//   node scripts/bench.mjs --json          # 只输出 JSON，方便进 CI
//
// 目标（路线图 0.8）：建图 < 3s、检索 < 80ms、体检 < 300ms、快照 < 2s。
import { writeFileSync } from 'node:fs'
import { buildGraph, auditHygiene } from '../lib/host/graph.js'
import { recall } from '../lib/host/recall.js'
import { findPath } from '../lib/host/path.js'
import { buildShareHtml } from '../lib/host/share.js'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const NODES = Math.max(100, Number(flag('--nodes', 10000)) || 10000)
const JSON_ONLY = argv.includes('--json')
const DAY = 86400000
const now = Date.UTC(2026, 10, 10, 4, 0, 0)

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(0x5eed)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

const WS_COUNT = 20
const LEVELS = ['project', 'lesson', 'topic', 'fact', 'user', 'rules', 'soul']
const LEVEL_W = [7, 14, 18, 45, 8, 6, 2]
const STATUS = ['active', 'active', 'active', 'active', 'stale', 'archived']
const VOCAB = []
for (let i = 0; i < 900; i++) VOCAB.push(`词${String(i).padStart(4, '0')}`)
const PROJECTS = Array.from({ length: 30 }, (_, i) => `项目-${String(i).padStart(2, '0')}`)

function weighted(arr, weights) {
  let sum = 0
  for (const w of weights) sum += w
  let r = rand() * sum
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i]
    if (r <= 0) return arr[i]
  }
  return arr[arr.length - 1]
}

const nodes = []
const byWs = Array.from({ length: WS_COUNT }, () => [])
for (let i = 0; i < NODES; i++) {
  const w = i % WS_COUNT
  const ws = `ws-${String(w + 1).padStart(2, '0')}`
  const level = weighted(LEVELS, LEVEL_W)
  const clusterStart = (w * 37 + (i % 5) * 11) % VOCAB.length
  const kws = []
  for (let k = 0; k < 12; k++) kws.push(VOCAB[(clusterStart + k * 7 + (i % 3)) % VOCAB.length])
  const extra = [`项目-${String((i * 7) % 30).padStart(2, '0')}`]
  const body = []
  for (let k = 0; k < 8; k++) {
    body.push(`${kws[(k + i) % kws.length]}${k % 3 === 0 ? '的取舍' : '记录'}：${kws[(k + i * 3) % kws.length]}在 ${ws} 里怎么落地`)
  }
  body.push(`路径 \`D:\\work\\${ws}\\file-${i % 400}.ts\``)
  body.push(`接口 https://example.test/api/${ws}/${i % 200}`)
  body.push(`「先别动 ${kws[0]}」`)
  const id = `bench-${String(i).padStart(5, '0')}`
  const node = {
    id,
    uid: `u-${i}`,
    ws,
    wsTitle: `工作区 ${w + 1}`,
    level,
    title: `${kws[0]} · ${level} ${i}`,
    label: `${kws[0]} · ${level} ${i}`,
    content: body.join('\n'),
    preview: body.slice(0, 2).join(' '),
    keywords: [...new Set(kws.concat(extra))].slice(0, 14),
    entities: [],
    project: (i % 11 === 0 ? '跨区共享项目' : extra[0]),
    subcategory: level === 'project' ? 'overview' : '',
    goal: '',
    importance: 1 + (i % 4),
    status: pick(STATUS),
    hits: i % 9 === 0 ? 0 : Math.floor(rand() * 60),
    heat: rand() * 100,
    createdAt: now - Math.floor(rand() * 365) * DAY,
    updatedAt: now - Math.floor(rand() * 40) * DAY,
    accessedAt: i % 4 === 0 ? now - Math.floor(rand() * 20) * DAY : 0,
    sessionId: `sess-${i % 900}`,
    provider: 'bench',
  }
  nodes.push(node)
  byWs[w].push(id)
}

const ledgers = []
for (let s = 0; s < 900; s++) {
  const ids = []
  const count = 5 + (s % 8)
  for (let k = 0; k < count; k++) ids.push(`bench-${String((s * 13 + k * 7) % NODES).padStart(5, '0')}`)
  ledgers.push({ sessionId: `sess-${s}`, kind: 'session', ids: [...new Set(ids)], ws: `ws-${String((s % WS_COUNT) + 1).padStart(2, '0')}` })
}
const manual = []
for (let i = 0; i < 200; i++) {
  manual.push({ a: `bench-${String(i * 17 % NODES).padStart(5, '0')}`, b: `bench-${String((i * 29 + 5) % NODES).padStart(5, '0')}`, note: '人工连线' })
}
const inventory = { mcp: ['nebula_recall'], skills: ['huashu-design'], plugins: ['memory-nebula'] }

function ms(fn, runs = 1) {
  const times = []
  let out
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    out = fn()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  return { ms: Math.round(times[Math.floor(times.length / 2)] * 10) / 10, out }
}

if (!JSON_ONLY) console.log(`合成数据：${NODES} 条记忆 / ${WS_COUNT} 个工作区 / ${ledgers.length} 个会话`)

const built = ms(() => buildGraph({ nodes, ledgers, manual, mutes: [], inventory, meta: {} }), 3)
const graph = built.out
if (!JSON_ONLY) {
  console.log(`建图        ${String(built.ms).padStart(8)} ms   ${graph.nodes.length} 节点 / ${graph.edges.length} 边`)
}

const queries = ['词0001', '取舍', '跨区共享项目', '先别动', '工作区 7', 'file-123.ts', '接口 example.test', '词0450 词0451']
const recallTimes = []
for (let round = 0; round < 5; round++) {
  for (const q of queries) {
    const t = performance.now()
    recall(graph, q, { limit: 20, hops: 1 })
    recallTimes.push(performance.now() - t)
  }
}
recallTimes.sort((a, b) => a - b)
const recallMs = Math.round(recallTimes[Math.floor(recallTimes.length / 2)] * 10) / 10
if (!JSON_ONLY) console.log(`检索        ${String(recallMs).padStart(8)} ms   ${queries.length} 种查询 × 5 轮的中位数`)

const benchTokens = new Map(graph.nodes.map((n) => [n.id, n.tokens]))
const hy = ms(() => auditHygiene({ nodes, edges: graph.edges, nodeIds: graph.nodes.map((n) => n.id), tokensById: benchTokens }), 2)
if (!JSON_ONLY) console.log(`体检        ${String(hy.ms).padStart(8)} ms   ${hy.out.total} 项`)

let pathMs = 0
let found = 0
if (graph.edges.length) {
  const e = graph.edges[Math.floor(graph.edges.length / 2)]
  const t = performance.now()
  const p = findPath(graph, e.s, e.t, { hops: 5 })
  pathMs = Math.round((performance.now() - t) * 10) / 10
  found = p ? p.hops : 0
  if (!JSON_ONLY) console.log(`证据链      ${String(pathMs).padStart(8)} ms   中间一条边之间的最短链 ${found} 跳`)
}

// 用轻量对象模拟 Nebula 的公开面，量快照拼装（读模板 + 序列化 + 内联脚本）。
const rawById = new Map(nodes.map((n) => [n.id, n]))
const lightweight = {
  graph,
  signature: 'bench',
  publicGraph() {
    // 和 lib/host/nebula.js 的 publicGraph 保持一致：簇＝工作区，节点 cluster 用工作区 slug。
    // （基准脚本以前直接塞 graph.clusters，导致节点 cluster 与簇 id 对不上、布局全挤在原点。）
    const idx = new Map(graph.nodes.map((n, i) => [n.id, i]))
    const wsMap = new Map()
    for (const n of graph.nodes) {
      let c = wsMap.get(n.ws)
      if (!c) {
        c = { id: n.ws, title: n.wsTitle, label: n.wsTitle, size: 0, color: '#6cc8ff', workspaces: [n.ws] }
        wsMap.set(n.ws, c)
      }
      c.size++
    }
    return {
      v: 2,
      nodes: graph.nodes.map((n) => ({
        id: n.id, i: idx.get(n.id), ws: n.wsTitle, cluster: n.ws, level: n.level,
        label: n.title || n.label, importance: n.importance, status: n.status, project: n.project,
        hits: n.hits, heat: n.heat, degree: n.degree, createdAt: n.createdAt, provider: n.provider || 'bench',
      })),
      edges: graph.edges.map((e) => ({ s: e.s, d: e.t, w: e.w, t: e.type })),
      clusters: [...wsMap.values()],
      stats: graph.stats,
      builtAt: graph.builtAt,
    }
  },
  overview() {
    return { stats: graph.stats, workspaces: [], levels: [], edgeTypes: [], clusters: graph.clusters, hubs: [], sources: [], inventory, hygiene: hy.out, cards: null, truth: { total: 0, groups: [] }, externals: null }
  },
  index: { rawById },
}
let share
{
  const t = performance.now()
  const out = await buildShareHtml(lightweight, { version: 'bench', build: 1 })
  share = { ms: Math.round((performance.now() - t) * 10) / 10, out }
}
if (!JSON_ONLY) {
  console.log(`单文件快照  ${String(share.ms).padStart(8)} ms   ${(share.out.bytes / 1048576).toFixed(1)} MB / ${share.out.nodes} 节点`)
}
const shareOut = flag('--share-out', null)
if (shareOut) {
  writeFileSync(shareOut, share.out.html)
  if (!JSON_ONLY) console.log(`已写出      ${shareOut}`)
}

if (global.gc) global.gc()
const mem = process.memoryUsage()
if (!JSON_ONLY) {
  console.log(`内存        ${String(Math.round(mem.heapUsed / 1048576)).padStart(8)} MB  heapUsed（进程峰值 rss ${Math.round(mem.rss / 1048576)} MB）`)
}

const result = {
  nodes: NODES,
  graph: { ms: built.ms, nodes: graph.nodes.length, edges: graph.edges.length, orphans: graph.stats.orphans, avgDegree: graph.stats.avgDegree },
  recall: { ms: recallMs, queries: queries.length },
  hygiene: { ms: hy.ms, total: hy.out.total },
  path: { ms: pathMs, hops: found },
  share: { ms: share.ms, bytes: share.out.bytes, nodes: share.out.nodes },
  memory: { heapMB: Math.round(mem.heapUsed / 1048576), rssMB: Math.round(mem.rss / 1048576) },
}
if (JSON_ONLY) console.log(JSON.stringify(result))
else console.log(`\nJSON: ${JSON.stringify(result)}`)
