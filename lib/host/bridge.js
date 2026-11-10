/**
 * 注入桥（bridge）—— 「别的记忆插件喂了什么，星图补什么」
 *
 * 这是星图和其他记忆插件协同工作的核心。
 *
 * 场景：meow-memory 本轮注入了 3 条记忆；hindsight 又塞了 2 条知识页。
 * 星图知道这些记忆在图上连着什么，但**不该重复**把已注入的东西再讲一遍。
 * 它该做的是：从那 5 条出发，沿边扩散一跳，挑出 2~4 条「最强、最没被讲过、
 * 又能把这件事补圆」的邻居，作为补充包一起注入。
 *
 * 于是同一个上下文预算里，装载的信息量变大，而不是同一句话说五遍。
 *
 * 打分（score）：
 *   扩散能量（seed=1，一跳 × w，二跳 × w₁·w₂）
 *   × 重要性系数（1 + imp·0.15）
 *   × 热度系数（1 + min(heat,3)·0.08）
 *   × 状态系数（active 1，stale 0.7，archived 0）
 *   × 同工作区亲和（1.08 / 跨区 1.0）
 *   × 超连接惩罚（degree>60 时 0.85：枢纽节点什么都连，信息密度低）
 *   再排除：已见、冷却中、权重低于门槛、自己
 *
 * 最后按工作区/层级做多样性配额，避免四条全是同一类东西。
 */
import { resolveIds } from './recall.js'
import { recall } from './recall.js'
import { clip } from './text.js'

export const DEFAULT_BUDGET = {
  maxItems: 4,
  maxChars: 900,
  minWeight: 0.5,
  hops: 1,
  perWorkspace: 2,
  perLevel: 2,
  maxDegree: 400,
}

/** 建邻接表（i → [{j,w,type,why}]）。O(E)。 */
export function adjacency(graph) {
  const adj = new Map()
  const add = (a, b, edge) => {
    let list = adj.get(a)
    if (!list) adj.set(a, (list = []))
    list.push({ j: b, w: edge.w, type: edge.type, why: edge.why || [] })
  }
  for (const edge of graph?.edges || []) {
    add(edge.s, edge.t, edge)
    add(edge.t, edge.s, edge)
  }
  return adj
}

/** 节点的所有「身份串」：完整 id + 裸 uid。 */
function identitiesOf(node) {
  const out = [node.id]
  const parts = String(node.id).split(':')
  if (parts.length > 1) out.push(parts[parts.length - 1])
  if (node.uid) out.push(String(node.uid))
  return out
}

function isSeen(node, seen) {
  if (!seen) return false
  for (const key of identitiesOf(node)) if (seen.has(key)) return true
  return false
}

function statusFactor(status) {
  const s = String(status || 'active').toLowerCase()
  if (s === 'archived' || s === 'deleted') return 0
  if (s === 'stale' || s === 'done') return 0.7
  return 1
}

/**
 * 从种子扩散，返回候选（未过滤筛选）。
 * @param {object} graph buildGraph 产物
 * @param {object} opts {ids, query, hops, adj}
 */
export function spread(graph, opts = {}) {
  const nodes = graph?.nodes || []
  const adj = opts.adj || adjacency(graph)
  const hops = Math.max(0, Math.min(3, Number(opts.hops ?? 1)))
  const energy = new Map() // i → {e, seeds:Set<i>, via:edge}
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const seedIdx = new Set()
  if (Array.isArray(opts.ids) && opts.ids.length > 0) {
    for (const node of resolveIds(nodes, opts.ids)) seedIdx.add(node.i)
  }
  if (seedIdx.size === 0 && opts.query) {
    try {
      const res = recall(graph, String(opts.query), { limit: opts.seedLimit || 6, hops: 0 })
      // recall() 的返回键是 hits（早期版本叫 items），两种都认
      const hits = res?.hits || res?.items || []
      for (const hit of hits) {
        const node = byId.get(hit.id)
        if (node) seedIdx.add(node.i)
      }
    } catch {
      /* recall 失败不影响 bridge 本身 */
    }
  }
  for (const i of seedIdx) energy.set(i, { e: 1, seeds: new Set([i]), via: null })

  // 兼容两种邻接表：bridge 自己的 {j,w,type,why} 和 nebula 索引的 {n,w,t,why}
  const target = (edge) => (edge.j !== undefined ? edge.j : edge.n)
  const kind = (edge) => edge.type || edge.t || ''

  let frontier = [...seedIdx]
  for (let hop = 1; hop <= hops; hop += 1) {
    const next = []
    for (const from of frontier) {
      const fromE = energy.get(from)
      if (!fromE) continue
      for (const raw of adj.get(from) || []) {
        const to = target(raw)
        if (to === undefined || to === null) continue
        const edge = { j: to, w: raw.w, type: kind(raw), why: raw.why || [] }
        if (edge.type === 'explicit') {
          // 策展边：一步到位，按 1.0 计
          const cur = energy.get(edge.j) || { e: 0, seeds: new Set(), via: null }
          const gain = 1.0
          if (gain > cur.e) {
            cur.e = gain
            cur.seeds.add(from)
            cur.via = { ...edge, from, hop }
            energy.set(edge.j, cur)
            next.push(edge.j)
          }
          continue
        }
        const gain = (fromE.e / Math.max(1, hop)) * edge.w
        if (gain < 0.08) continue
        const cur = energy.get(edge.j) || { e: 0, seeds: new Set(), via: null }
        if (gain > cur.e) {
          cur.e = gain
          cur.seeds.add(from)
          cur.via = { ...edge, from, hop }
          energy.set(edge.j, cur)
          next.push(edge.j)
        }
      }
    }
    frontier = [...new Set(next)]
    if (frontier.length === 0) break
  }

  energy.delete(-1)
  return { energy, seedIdx, adj }
}

/**
 * 主入口：算出「该补什么」。
 *
 * @param {object} graph
 * @param {object} opts
 * @param {string[]} [opts.ids]     别的插件刚喂过的记忆 id（种子）
 * @param {string} [opts.query]     没有 ids 时，用查询词找种子
 * @param {Set<string>} [opts.seen] 已见集合（完整 id 或裸 uid）
 * @param {Map<string,number>} [opts.cooldown] uid → 上次注入时间
 * @param {object} [opts.budget]    预算
 * @param {boolean} [opts.allowStale] 是否允许 stale（默认允许，降权）
 * @returns {{items: object[], text: string, seeds: object[], stats: object}}
 */
export function bridge(graph, opts = {}) {
  const budget = { ...DEFAULT_BUDGET, ...(opts.budget || {}) }
  const nodes = graph?.nodes || []
  const byIdx = new Map(nodes.map((n) => [n.i, n]))
  const { energy, seedIdx } = spread(graph, {
    ids: opts.ids,
    query: opts.query,
    hops: budget.hops,
    adj: opts.adj,
  })
  const seen = opts.seen || new Set()
  const cooldown = opts.cooldown || new Map()
  const now = Date.now()

  const seeds = []
  for (const i of seedIdx) {
    const node = byIdx.get(i)
    if (node) seeds.push({ id: node.id, title: node.title || node.label, ws: node.wsTitle, level: node.level })
  }

  const candidates = []
  for (const [i, info] of energy) {
    if (seedIdx.has(i)) continue
    const node = byIdx.get(i)
    if (!node) continue
    if (isSeen(node, seen)) continue
    const sf = statusFactor(node.status)
    if (sf === 0) continue
    if (!opts.allowStale && sf < 1) continue
    const edge = info.via
    const weight = edge ? edge.w : 0
    if (weight < budget.minWeight) continue
    const degree = Number(node.degree) || 0
    if (degree > budget.maxDegree) continue
    const uid = String(node.id).split(':').pop()
    if (cooldown.has(uid)) continue

    const co = 1 + Math.min(4, Number(node.importance) || 0) * 0.15
    const heat = 1 + Math.min(3, Number(node.heat) || 0) * 0.08
    const hub = degree > 60 ? 0.85 : 1
    let score = info.e * co * heat * sf * hub
    if (opts.ws && node.ws === opts.ws) score *= 1.08
    // 越久没被碰过的，稍微抬一点：让「沉底的好记忆」有机会浮上来
    const last = Number(node.accessedAt || node.updatedAt || node.createdAt || 0)
    if (last > 0) {
      const days = (now - last) / 86400000
      if (days > 45) score *= 1.06
    }

    candidates.push({
      i,
      id: node.id,
      uid,
      title: node.title || node.label,
      label: node.label,
      ws: node.ws,
      wsTitle: node.wsTitle,
      level: node.level,
      importance: node.importance,
      status: node.status,
      project: node.project,
      preview: clip(node.preview || node.content || '', 220),
      score,
      edgeWeight: weight,
      edgeType: edge?.type || '',
      why: (edge?.why || []).slice(0, 3),
      hop: edge?.hop || 1,
      seeds: [...info.seeds].map((s) => byIdx.get(s)).filter(Boolean).map((n) => n.title || n.label),
    })
  }

  candidates.sort((a, b) => b.score - a.score)

  // 多样性配额：先按 ws / level 各限 perWorkspace / perLevel，不够再放宽
  const picked = []
  const wsCount = new Map()
  const levelCount = new Map()
  const take = (item, relax) => {
    if (picked.length >= budget.maxItems) return false
    const ws = item.ws || ''
    const lv = item.level || ''
    if (!relax) {
      if ((wsCount.get(ws) || 0) >= budget.perWorkspace) return false
      if ((levelCount.get(lv) || 0) >= budget.perLevel) return false
    }
    picked.push(item)
    wsCount.set(ws, (wsCount.get(ws) || 0) + 1)
    levelCount.set(lv, (levelCount.get(lv) || 0) + 1)
    return true
  }
  for (const item of candidates) take(item, false)
  if (picked.length < budget.maxItems) {
    for (const item of candidates) {
      if (picked.includes(item)) continue
      take(item, true)
    }
  }

  // 字符预算：超了就从尾巴砍
  let chars = 0
  const bounded = []
  for (const item of picked) {
    const cost = renderLine(item).length
    if (chars + cost > budget.maxChars && bounded.length > 0) break
    chars += cost
    bounded.push(item)
  }

  return {
    items: bounded,
    text: bounded.map(renderLine).join('\n'),
    seeds,
    stats: {
      seedCount: seedIdx.size,
      considered: candidates.length,
      picked: bounded.length,
      chars,
      hops: budget.hops,
    },
  }
}

/** 一条补充项的紧凑渲染（给模型读的）。 */
export function renderLine(item) {
  const why = (item.why || []).slice(0, 2).join('；')
  const head = `- 【${LEVEL_ZH[item.level] || item.level || '记忆'}·${shortWs(item.wsTitle)}】${clip(item.title || item.label || '', 46)}`
  return why ? `${head} —— ${why}` : head
}

const LEVEL_ZH = {
  project: '项目',
  fact: '事实',
  lesson: '教训',
  topic: '话题',
  user: '主人',
  rules: '准则',
  soul: '灵魂',
  note: '笔记',
}

function shortWs(title) {
  const s = String(title || '').trim()
  if (s.length <= 14) return s
  return s.slice(0, 13) + '…'
}

/**
 * 从一段上下文文本里提出「已经被别家插件写进 prompt 的记忆标题」。
 *
 * 用途：不是所有插件都留账本。有的只是把一段 markdown 塞进 systemPrompt。
 * 那就从文本里反查：这段话里点到的标题，算已见。
 *
 * 做法保守：只认长度 ≥ 6 的节点标题在文本里出现，且要求成对出现（标题 + 工作区/层名）
 * 太容易误判，所以这里只做「标题完全一致」这一条，宁可漏判不误判。
 */
export function seenFromText(graph, text) {
  const out = new Set()
  const haystack = String(text || '')
  if (haystack.length < 20) return out
  for (const node of graph?.nodes || []) {
    const title = String(node.title || '').trim()
    if (title.length < 8) continue
    if (haystack.includes(title)) {
      const parts = String(node.id).split(':')
      out.add(parts[parts.length - 1])
    }
  }
  return out
}
