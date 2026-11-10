/**
 * 记忆星图的图构建器。
 *
 * 核心原则：**宁可少连线，不可连错线**。
 * 每条边都要能回答「凭什么连在一起」，答案必须是可复述的证据：
 *   - 同一个硬实体（路径 / URL / UUID / 文件名 / 邮箱 / 反引号代码）
 *   - 同一个项目名（跨工作区才算，因为那是真正的桥）
 *   - 稀有关键词重叠（Jaccard 门槛 + df 上限）
 *   - 高相似正文（idf 加权 Jaccard，阈值高）
 *   - 同一会话里被一起点亮（Hebbian 共激活，出现在 ≥2 次会话才认）
 *   - 手工策展（explicit，权重最高）
 */
import {
  tokenize,
  extractEntities,
  entityStrength,
  idf,
  jaccard,
  intersect,
  overlapSize,
  clip,
  hash32,
} from './text.js'

/**
 * 通用文件名：跨工作区时不作为「同一实体」的证据。
 * 两个项目各有一个 package.json，并不代表它们讲的是同一件事。
 */
const GENERIC_LEAF = /^(package\.json|package-lock\.json|pnpm-lock\.yaml|index\.(m?[jt]sx?|cjs)|app\.(html|js)|server\.(m?js|cjs)|main\.(m?js|ts)|readme\.md|tsconfig\.json|\.gitignore|styles?\.css|client\.js|lib|dist|src|node_modules|\.env)$/i

/** 边类型的展示元数据。 */
export const EDGE_META = {
  explicit: { label: '策展', zh: '人工连线', rank: 0, hue: 48 },
  project: { label: '同项目', zh: '项目桥', rank: 1, hue: 190 },
  entity: { label: '实体', zh: '同一标识', rank: 2, hue: 280 },
  keyword: { label: '关键词', zh: '稀有词重叠', rank: 3, hue: 215 },
  semantic: { label: '语义', zh: '正文相似', rank: 4, hue: 150 },
  hebbian: { label: '共激活', zh: '同会话点亮', rank: 5, hue: 20 },
}

/** 单条边最低权重（低于它的候选直接丢）。 */
const MIN_EDGE_WEIGHT = 0.3
/** 每个节点保留的最大边数（保留最强的）。 */
const MAX_EDGES_PER_NODE = 16
/** 关键词在语料里出现超过这个条数就不作为证据（太泛）。 */
const MAX_KEYWORD_DF_RATIO = 0.22
const MAX_KEYWORD_DF_ABS = 70

/**
 * 加权 Jaccard：交集按词的 idf 计分，联盟也按 idf 计分。
 * 比裸 Jaccard 更能抓住「共同拥有稀有词」这件事。
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @param {(t:string)=>number} weightOf
 */
function weightedJaccard(a, b, weightOf) {
  if (a.size === 0 || b.size === 0) return 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  let inter = 0
  for (const t of small) if (big.has(t)) inter += weightOf(t)
  if (inter <= 0) return 0
  let union = 0
  for (const t of a) union += weightOf(t)
  for (const t of b) if (!a.has(t)) union += weightOf(t)
  return union <= 0 ? 0 : inter / union
}

/**
 * 概率式 OR 合并：多条证据指向同一对节点时，权重接近 1 但永不超 1。
 * @param {number[]} parts
 */
function combine(parts) {
  let rest = 1
  for (const p of parts) rest *= 1 - Math.max(0, Math.min(0.99, p))
  return Math.min(0.99, 1 - rest)
}

/**
 * 计算节点热度：重要度 + 被检索次数 + 新鲜度。
 * @param {object} node
 * @param {number} now
 */
function heatOf(node, now) {
  const imp = Math.max(0, Math.min(4, node.importance || 0)) / 4
  const hits = Math.min(1, Math.log2(1 + (node.hits || 0)) / 4)
  const stamp = node.accessedAt || node.updatedAt || node.createdAt || 0
  const days = stamp > 0 ? Math.max(0, (now - stamp) / 86400000) : 365
  const fresh = Math.exp(-days / 30)
  return Math.round((0.34 + 0.32 * imp + 0.18 * hits + 0.16 * fresh) * 1000) / 1000
}

/**
 * 去掉「被更长实体包含」的短实体：`d:\a\b` 已经出现时，
 * `d:\a` 这种前缀不该再单独当证据（它只是同一个东西的截断）。
 * @param {Map<string,string>} entities
 */
function pruneEntities(entities) {
  const items = [...entities.entries()].map(([key, type]) => [key, type, key.slice(key.indexOf('|') + 1)])
  items.sort((a, b) => b[2].length - a[2].length)
  const out = new Map()
  const kept = []
  for (const [key, type, value] of items) {
    if (value.length < 4) continue
    let covered = false
    for (const other of kept) {
      if (other.type === type && other.value !== value && other.value.startsWith(value)) {
        covered = true
        break
      }
    }
    if (covered) continue
    kept.push({ type, value })
    out.set(key, type)
  }
  return out
}

/**
 * 构建整张记忆星云。
 *
 * @param {object} input
 * @param {object[]} input.nodes   来自 sources.readStoreNodes 的所有节点
 * @param {{sessionId:string,kind:string,ids:string[],ws:string}[]} input.ledgers 每会话活动
 * @param {{a:string,b:string,type?:string,weight?:number,note?:string,createdAt?:number}[]} [input.manual] 手工策展边
 * @param {{a:string,b:string}[]} [input.mutes] 被人工屏蔽的关联对（重建时永不连接）
 * @param {{sessionWorkspaces?:Record<string,string>}} [input.meta]
 * @returns {{nodes:object[],edges:object[],clusters:object[],stats:object,builtAt:number}}
 */
export function buildGraph(input) {
  const now = Date.now()
  const rawNodes = (input.nodes || []).filter((n) => n && n.id)
  const manual = Array.isArray(input.manual) ? input.manual : []
  const ledgers = Array.isArray(input.ledgers) ? input.ledgers : []
  const mutes = Array.isArray(input.mutes) ? input.mutes : []
  // 屏蔽对用「小 id + 0x00 + 大 id」做键；建边时直接跳过，等于人工否掉这条推断
  const muteSet = new Set(mutes.map((m) => (m.a < m.b ? m.a + '\u0000' + m.b : m.b + '\u0000' + m.a)))

  /** @type {Map<string,number>} nodeId -> index */
  const index = new Map()
  const nodes = rawNodes.map((n, i) => {
    index.set(n.id, i)
    const text = [n.title, n.content, n.project, n.goal, ...(n.keywords || [])].filter(Boolean).join('\n')
    const tokens = tokenize(text)
    const entities = pruneEntities(extractEntities(text))
    return {
      ...n,
      kind: n.kind || 'memory',
      i,
      tokens,
      blob: text.toLowerCase(),
      sig: null,
      entities,
      keywords: new Set((n.keywords || []).map((k) => String(k).toLowerCase())),
      heat: heatOf(n, now),
    }
  })

  const n = nodes.length
  if (n === 0) {
    return {
      nodes: [],
      edges: [],
      clusters: [],
      stats: { nodes: 0, edges: 0, workspaces: 0, byType: {}, byWorkspace: {}, byLevel: {}, orphans: 0 },
      builtAt: now,
    }
  }

  // ---------- 文档频次 ----------
  const tokenDF = new Map()
  const entityDF = new Map()
  const keywordDF = new Map()
  for (const node of nodes) {
    for (const t of node.tokens) tokenDF.set(t, (tokenDF.get(t) || 0) + 1)
    for (const k of node.entities.keys()) entityDF.set(k, (entityDF.get(k) || 0) + 1)
    for (const k of node.keywords) keywordDF.set(k, (keywordDF.get(k) || 0) + 1)
  }
  // idf 只跟 df 有关；同一条 token 在打分里会被反复问，缓存一次省掉大量 Math.log。
  const weightCache = new Map()
  const tokenWeight = (t) => {
    let w = weightCache.get(t)
    if (w === undefined) {
      w = idf(tokenDF.get(t) || 1, n)
      weightCache.set(t, w)
    }
    return w
  }

  // 「语义签名」：每个节点最稀有的 26 个词。
  // 长文本词多、短文本词少，直接比全集永远是短的那条吃亏；取稀有词签名更公平。
  for (const node of nodes) {
    const arr = [...node.tokens]
    arr.sort((a, b) => tokenWeight(b) - tokenWeight(a))
    node.sig = new Set(arr.slice(0, 26))
  }
  // 每个节点签名的总权重只算一次；scorePair 里每对候选都要用它，重复遍历是纯浪费。
  const sigWeight = new Float64Array(n)
  for (const node of nodes) {
    let sum = 0
    for (const t of node.sig) sum += tokenWeight(t)
    sigWeight[node.i] = sum
  }

  // ---------- 倒排索引（候选生成，避免 O(n²)） ----------
  /** @type {Map<string, number[]>} */
  const tokenPost = new Map()
  /** @type {Map<string, number[]>} */
  const entityPost = new Map()
  /** @type {Map<string, number[]>} */
  const keywordPost = new Map()
  const push = (map, key, i) => {
    const arr = map.get(key)
    if (arr) arr.push(i)
    else map.set(key, [i])
  }
  for (const node of nodes) {
    const tokenLimit = Math.max(6, Math.floor(n * 0.2))
    // 小图（≤1000 条）用全量 token 保召回；大图只用「最稀有的 26 个词」做候选。
    // 1 万条时全量 token 会把同一段模板文字里的常见 bigram 也拿去两两配对，
    // 是平方级浪费，而稀有词签名已经足够把真正相似的两条连起来。
    const candTokens = n <= 1000 ? node.tokens : node.sig
    for (const t of candTokens) {
      if ((tokenDF.get(t) || 0) > tokenLimit) continue
      push(tokenPost, t, node.i)
    }
    for (const key of node.entities.keys()) {
      const df = entityDF.get(key) || 0
      if (df < 2) continue
      if (df > Math.max(12, n * 0.12)) continue
      push(entityPost, key, node.i)
    }
    for (const k of node.keywords) {
      const df = keywordDF.get(k) || 0
      if (df < 2) continue
      if (df > MAX_KEYWORD_DF_ABS || df > n * MAX_KEYWORD_DF_RATIO) continue
      push(keywordPost, k, node.i)
    }
  }

  // ---------- 候选对累加 ----------
  /** @type {Map<string, {kw:string[], ent:string[], tok:number, sim:number}>} */
  const cand = new Map()
  const pairKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a)
  const slot = (a, b) => {
    const key = pairKey(a, b)
    let s = cand.get(key)
    if (!s) {
      s = { kw: [], ent: [], tok: 0 }
      cand.set(key, s)
    }
    return s
  }

  for (const [kw, list] of keywordPost) {
    if (list.length < 2) continue
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) slot(list[x], list[y]).kw.push(kw)
    }
  }
  for (const [key, list] of entityPost) {
    if (list.length < 2) continue
    // 一个标识出现在上百条记忆里就不再是「同一实体」的证据，只是公共路径/版本号。
    // 不设上限时，1 万条库里的共享路径会生成上千万对候选，建图直接掉到秒级以外。
    if (list.length > 120) continue
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) slot(list[x], list[y]).ent.push(key)
    }
  }
  const sharedTokenCount = new Map()
  for (const [, list] of tokenPost) {
    if (list.length < 2) continue
    if (list.length > 160) continue // 太常见的词不做语义候选
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const key = pairKey(list[x], list[y])
        sharedTokenCount.set(key, (sharedTokenCount.get(key) || 0) + 1)
      }
    }
  }
  for (const [key, count] of sharedTokenCount) {
    // 短笔记（签名 ≤12 个词）放宽到共享 2 个稀有词：新接入的笔记目录/小记忆库
    // 天然短，按长记忆的标准永远连不上，接进来就是一串孤岛。
    const cut = key.indexOf(':')
    const a = Number(key.slice(0, cut))
    const b = Number(key.slice(cut + 1))
    const minSig = Math.min(nodes[a].sig.size, nodes[b].sig.size)
    const need = minSig <= 12 ? 2 : 4
    if (count < need) continue
    const s = cand.get(key)
    if (s) s.tok = count
    else cand.set(key, { kw: [], ent: [], tok: count })
  }

  // ---------- 共激活（Hebbian）：按会话统计 ----------
  const coAct = new Map()
  const uidToIndex = new Map()
  for (const node of nodes) {
    const key = node.ws + '\u0000' + node.uid
    if (!uidToIndex.has(key)) uidToIndex.set(key, [])
    uidToIndex.get(key).push(node.i)
  }
  const coKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a)
  // 同一会话里被同时注入/检索/写下的记忆，视为「一起点亮」
  const bySession = new Map()
  for (const ledger of ledgers) {
    const ws = ledger.ws || ''
    const bucketKey = ws + '\u0000' + ledger.sessionId
    let bucket = bySession.get(bucketKey)
    if (!bucket) {
      bucket = new Set()
      bySession.set(bucketKey, bucket)
    }
    for (const uid of ledger.ids) {
      const list = uidToIndex.get(ws + '\u0000' + uid)
      if (!list) continue
      for (const i of list) bucket.add(i)
    }
  }
  for (const set of bySession.values()) {
    const arr = [...set]
    if (arr.length < 2 || arr.length > 80) continue
    const damp = 1 / Math.log2(2 + arr.length) // 大会话里「都出现过」的证据更弱
    for (let x = 0; x < arr.length; x++) {
      for (let y = x + 1; y < arr.length; y++) {
        const key = coKey(arr[x], arr[y])
        coAct.set(key, (coAct.get(key) || 0) + damp)
      }
    }
  }

  // 共激活本身也是候选来源。
  // 之前只在「文本已经相似」的候选对里读 coAct，于是注释写的「两次以上会话共激活也算数」
  // 其实永远不成立：两段正文毫无重叠、但每次都被同一条对话一起想起来的记忆，一条边都长不出来。
  // 现在把够强的共激活单独补成候选（parts 里只有 hebbian，权重由 scorePair 统一算）。
  for (const [key, co] of coAct) {
    if (co < 1.6) continue
    if (cand.has(key)) continue
    cand.set(key, { kw: [], ent: [], tok: 0 })
  }

  // ---------- 打分 ----------
  /** @type {{s:number,t:number,type:string,w:number,why:string[],parts:Record<string,number>}[]} */
  const edges = []
  const nSessions = bySession.size || 1

  const scorePair = (a, b, s) => {
    const A = nodes[a]
    const B = nodes[b]
    const parts = {}
    const why = []

    // 1) 关键词
    if (s.kw.length > 0) {
      const jac = jaccard(A.keywords, B.keywords)
      const rare = s.kw.filter((k) => (keywordDF.get(k) || 0) <= Math.max(3, n * 0.05))
      let w = 0
      if (s.kw.length >= 2 && jac >= 0.16) w = 0.3 + 0.4 * Math.min(1, jac * 1.7)
      else if (s.kw.length >= 2) w = 0.26 + 0.12 * Math.min(1, jac * 2)
      else if (rare.length >= 1) w = 0.3
      else w = 0.2
      if (w > 0.2) {
        parts.keyword = w
        why.push('共享关键词：' + s.kw.slice(0, 4).join('、'))
      }
    }

    // 2) 硬实体（最可信）
    //    跨工作区时，通用文件名（package.json / index.ts / app.html…）不算证据 ——
    //    两个项目各有一个 package.json，不代表它们说的是同一件事。
    if (s.ent.length > 0) {
      let best = 0
      const shown = []
      const crossWs = A.ws !== B.ws
      for (const key of s.ent.slice(0, 12)) {
        const leaf = String(key).split('|')[1] || ''
        if (crossWs && GENERIC_LEAF.test(leaf)) continue
        const df = entityDF.get(key) || 1
        const score = entityStrength(key, df, n)
        if (score > best) best = score
        if (shown.length < 3) shown.push(leaf)
      }
      if (best > 0.18) {
        parts.entity = Math.min(0.86, 0.26 + 0.68 * best)
        why.push('同一标识：' + shown.join('、'))
      }
    }

    // 3) 同项目（只在跨工作区时当桥用；同库同项目不连，否则一团糊）
    if (A.project && A.project === B.project && A.project !== '全局' && A.ws !== B.ws) {
      parts.project = 0.52
      why.push('跨工作区同项目：' + A.project)
    }

    // 4) 语义相似：稀有词签名的「重叠系数」（交集权重 / 较小一侧权重）
    //    长记忆和短记忆放在一起比也不吃亏；共同稀有词门槛按较短一侧的签名大小自适应
    //    （长记忆仍要 4 个，≤12 词的短笔记只要 2 个，否则新接入的笔记永远是孤岛）。
    const minSig = Math.min(A.sig.size, B.sig.size)
    const needInter = minSig <= 12 ? 2 : 4
    const needSim = minSig <= 12 ? 0.12 : 0.18
    if (s.tok >= needInter) {
      // 不分配交集数组：只需要「交集个数 + 交集权重」，边遍历边累加即可。
      const small = A.sig.size <= B.sig.size ? A.sig : B.sig
      const big = small === A.sig ? B.sig : A.sig
      let inter = 0
      let iw = 0
      for (const t of small) {
        if (big.has(t)) {
          inter++
          iw += tokenWeight(t)
        }
      }
      if (inter >= needInter) {
        const aw = sigWeight[a]
        const bw = sigWeight[b]
        const sim = iw / Math.max(1e-9, Math.min(aw, bw))
        if (sim >= needSim) {
          parts.semantic = Math.min(0.58, 0.12 + 0.6 * sim)
          why.push('正文共享 ' + inter + ' 个稀有词（覆盖 ' + sim.toFixed(2) + '）')
        }
      }
    }

    // 5) 共激活
    const co = coAct.get(coKey(a, b)) || 0
    if (co > 0) {
      // 单次共激活基本不算数：要 ≥2 次会话，或被别的证据加持
      const w = Math.min(0.5, 0.1 * Math.log2(1 + co * 2) * (1 + Math.log2(1 + co) * 0.25))
      if (co >= 1.6 || co >= 1) {
        parts.hebbian = w
        why.push('同会话共激活 ' + Math.round(co * 10) / 10 + ' 次')
      }
    }

    const keys = Object.keys(parts)
    if (keys.length === 0) return null
    let weight = combine(keys.map((k) => parts[k]))

    // 只靠一次共激活、没有其它证据的对，压到门槛以下 —— 这是最容易误连的一类
    if (keys.length === 1 && keys[0] === 'hebbian' && co < 1.6) return null
    if (weight < MIN_EDGE_WEIGHT) return null

    keys.sort((x, y) => parts[y] - parts[x])
    return { s: a, t: b, type: keys[0], w: Math.round(weight * 1000) / 1000, why, parts }
  }

  for (const [key, s] of cand) {
    const [a, b] = key.split(':').map(Number)
    // 人工否掉的关联对：无论证据多强都不连
    if (muteSet.size) {
      const ia = nodes[a].id
      const ib = nodes[b].id
      if (muteSet.has(ia < ib ? ia + '\u0000' + ib : ib + '\u0000' + ia)) continue
    }
    const edge = scorePair(a, b, s)
    if (edge) edges.push(edge)
  }

  // 手工策展边优先，权重 1
  for (const m of manual) {
    const a = index.get(m.a)
    const b = index.get(m.b)
    if (a === undefined || b === undefined || a === b) continue
    edges.push({
      s: Math.min(a, b),
      t: Math.max(a, b),
      type: 'explicit',
      w: 1,
      why: [m.note ? '策展：' + m.note : '人工策展关联'],
      parts: { explicit: 1 },
    })
  }

  // ---------- 剪枝：严格每节点上限 ----------
  // 贪心：按「权重 + 跨工作区加成」全局排序，一条边只有在两端都还有额度时才收。
  // 这样任何节点的度数都不会超过 MAX_EDGES_PER_NODE，跨工作区的桥优先保留。
  const priority = (edge) => edge.w + (nodes[edge.s].ws !== nodes[edge.t].ws ? 0.16 : 0)
  const order = edges.map((_, i) => i).sort((i, j) => priority(edges[j]) - priority(edges[i]))
  const keep = new Set()
  const degreeCap = new Uint16Array(n)
  for (const i of order) {
    const edge = edges[i]
    if (edge.type === 'explicit') {
      keep.add(i)
      degreeCap[edge.s]++
      degreeCap[edge.t]++
      continue
    }
    if (degreeCap[edge.s] >= MAX_EDGES_PER_NODE || degreeCap[edge.t] >= MAX_EDGES_PER_NODE) continue
    keep.add(i)
    degreeCap[edge.s]++
    degreeCap[edge.t]++
  }
  const finalEdges = edges.filter((_, i) => keep.has(i))

  // ---------- 孤立自举：新接入来源的第一条记忆不该是孤岛 ----------
  // 新来的笔记 / 小库通常只有几十个 token，稀有词签名与老记忆的交集常常只有 1 个，
  // 达不到语义门槛。不给它一条弱边，它接进来就是一颗看不见的孤星 ——
  // 页面上找不到、bridge 也扩散不到，等于没接。
  // 只对「非内置来源、且剪枝后仍然零度」的节点补一条，权重压在 0.32，不会污染主图。
  {
    const BOOT_W = 0.32
    const BUILTIN = new Set(['meow-memory', 'inventory'])
    const deg = new Uint8Array(n)
    for (const e of finalEdges) {
      deg[e.s] = 1
      deg[e.t] = 1
    }
    const lonely = (i) => deg[i] === 0 && !BUILTIN.has(nodes[i].provider || 'meow-memory')
    // 每个孤岛留前两条候选：一条经常不够 —— 唯一的邻居如果是 stale/archived，
    // 下游（bridge / 注入）会把它整条过滤掉，等于白连。
    const best = new Map()
    const pushHit = (i, other, count) => {
      const arr = best.get(i) || []
      const boost = nodes[other].status === 'active' ? 1 : nodes[other].status === 'archived' ? -2 : 0
      arr.push({ other, count, rank: count + boost })
      arr.sort((x, y) => y.rank - x.rank)
      if (arr.length > 2) arr.length = 2
      best.set(i, arr)
    }
    for (const [key, count] of sharedTokenCount) {
      if (count < 1) continue
      const cut = key.indexOf(':')
      const a = Number(key.slice(0, cut))
      const b = Number(key.slice(cut + 1))
      const la = lonely(a)
      const lb = lonely(b)
      if (!la && !lb) continue
      if (la) pushHit(a, b, count)
      if (lb) pushHit(b, a, count)
    }
    let bootCount = 0
    for (const [i, hits] of best) {
      if (bootCount >= 80) break
      for (const hit of hits) {
        if (hit.rank <= 0) continue
        // 只共享一个词、而对面还是 stale 的，宁可不连：这种边只会把不相关的记忆
        // 拉进注入，比孤岛更有害。
        if (hit.count < 2 && nodes[hit.other].status !== 'active') continue
        const ia = nodes[i].id
        const ib = nodes[hit.other].id
        if (muteSet.size && muteSet.has(ia < ib ? ia + '\u0000' + ib : ib + '\u0000' + ia)) continue
        finalEdges.push({
          s: Math.min(i, hit.other),
          t: Math.max(i, hit.other),
          type: 'semantic',
          w: BOOT_W,
          why: ['新来源自举：与最近的一条记忆共享 ' + hit.count + ' 个稀有词'],
          parts: { semantic: BOOT_W },
          boot: true,
        })
        bootCount++
      }
    }
  }

  // ---------- 来源节点：技能 / MCP / 插件 ----------
  // 只有「记忆正文里原样出现了这个名字」才连一条 mentions 边。
  // 不靠关键词猜、不靠语义推 —— 名字没出现就不算用过它，宁可不连也不误连。
  const SRC_ZH = { skill: '技能', mcp: 'MCP', plugin: '插件' }
  const SRC_LISTS = [
    ['mcp', input.inventory && input.inventory.mcp, 4],
    ['skill', input.inventory && input.inventory.skills, 4],
    ['plugin', input.inventory && input.inventory.plugins, 6],
  ]
  // 同一个名字可能既是 MCP 又是插件（例如 meow-memory），只做一个节点，按 mcp > 技能 > 插件的顺序认领
  const srcSeen = new Set()
  for (const [kind, list, minLen] of SRC_LISTS) {
    for (const item of Array.isArray(list) ? list : []) {
      const name = String((item && item.name) || '').trim()
      // 框架自带包不算「记忆来源」，短名字容易和普通英文词撞车
      if (name.length < minLen || name.startsWith('@deepseek-ai/')) continue
      const needle = name.toLowerCase()
      if (srcSeen.has(needle)) continue
      // 边界匹配：huashu-design 不该被 huashu-design-lite 的正文误判成出现
      const re = new RegExp('(^|[^a-z0-9_-])' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9_-]|$)')
      const hitIdx = []
      for (const node of nodes) {
        if (!node.blob || !re.test(node.blob)) continue
        hitIdx.push(node.i)
        if (hitIdx.length >= 24) break
      }
      if (hitIdx.length === 0) continue
      srcSeen.add(needle)
      const idx = nodes.length
      const desc = String((item && item.description) || '').slice(0, 200)
      // 来源节点不是一个独立「工作区」：它挂在最常提到它的那条记忆所在的工作区里，
      // 这样一眼就能看出「这个技能是被哪个项目在用的」。
      const wsTally = new Map()
      for (const i of hitIdx) {
        const key = nodes[i].ws || ''
        const cur = wsTally.get(key)
        if (cur) cur.n++
        else wsTally.set(key, { n: 1, title: nodes[i].wsTitle || key })
      }
      let bestWs = ''
      let bestTitle = ''
      let bestN = -1
      for (const [key, v] of wsTally) {
        if (v.n > bestN) {
          bestN = v.n
          bestWs = key
          bestTitle = v.title
        }
      }
      nodes.push({
        id: 'src:' + kind + ':' + needle,
        i: idx,
        kind: 'source',
        sourceKind: kind,
        provider: 'inventory',
        ws: bestWs,
        wsTitle: bestTitle,
        level: 'source',
        title: name,
        label: name,
        content: desc,
        preview: desc,
        importance: 1,
        status: 'active',
        project: SRC_ZH[kind],
        subcategory: null,
        goal: null,
        keywords: new Set(),
        entities: new Map(),
        tokens: new Set(),
        sig: new Set(),
        heat: 0.2,
        hits: 0,
        createdAt: now,
        updatedAt: now,
        accessedAt: null,
        sessionId: null,
        blob: '',
      })
      index.set(nodes[idx].id, idx)
      for (const i of hitIdx) {
        finalEdges.push({
          s: Math.min(i, idx),
          t: Math.max(i, idx),
          type: 'mentions',
          w: 0.92,
          why: ['正文原样提到' + SRC_ZH[kind] + '：' + name],
        })
      }
    }
  }

  // ---------- 聚类（弱连通分量，按边权加权） ----------
  const parent = new Int32Array(nodes.length).map((_, i) => i)
  const find = (x) => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) {
      const nx = parent[x]
      parent[x] = r
      x = nx
    }
    return r
  }
  const union = (x, y) => {
    const rx = find(x)
    const ry = find(y)
    if (rx !== ry) parent[rx] = ry
  }
  for (const edge of finalEdges) {
    // 来源节点不参与「记忆簇」合并：技能/MCP 是横跨所有簇的标签，不是记忆的一部分
    if (edge.type === 'mentions') continue
    if (edge.w < 0.34) continue
    union(edge.s, edge.t)
  }
  const clusterMap = new Map()
  for (let i = 0; i < nodes.length; i++) {
    const r = find(i)
    let c = clusterMap.get(r)
    if (!c) clusterMap.set(r, (c = []))
    c.push(i)
  }
  const clusters = []
  for (const [, members] of clusterMap) {
    if (members.length < 3) continue
    const projectCount = new Map()
    for (const i of members) {
      const p = nodes[i].project || nodes[i].wsTitle
      projectCount.set(p, (projectCount.get(p) || 0) + 1)
    }
    const [topProject] = [...projectCount.entries()].sort((x, y) => y[1] - x[1])[0]
    const wsCount = new Map()
    for (const i of members) wsCount.set(nodes[i].ws, (wsCount.get(nodes[i].ws) || 0) + 1)
    clusters.push({
      id: 'c' + hash32(topProject + members.length + members[0]).toString(36),
      label: topProject || '记忆簇',
      size: members.length,
      members,
      workspaces: [...wsCount.keys()],
      hue: (hash32(topProject) % 360),
    })
  }
  clusters.sort((a, b) => b.size - a.size)

  // ---------- 输出 ----------
  const byType = {}
  const degree = new Map()
  for (const edge of finalEdges) {
    byType[edge.type] = (byType[edge.type] || 0) + 1
    degree.set(edge.s, (degree.get(edge.s) || 0) + 1)
    degree.set(edge.t, (degree.get(edge.t) || 0) + 1)
  }
  const byWorkspace = {}
  const byLevel = {}
  for (const node of nodes) {
    byWorkspace[node.wsTitle] = (byWorkspace[node.wsTitle] || 0) + 1
    byLevel[node.level] = (byLevel[node.level] || 0) + 1
  }
  const orphans = nodes.filter((node) => !degree.has(node.i)).length

  const outNodes = nodes.map((node) => ({
    id: node.id,
    i: node.i,
    kind: node.kind || 'memory',
    sourceKind: node.sourceKind || null,
    provider: node.provider || 'meow-memory',
    adapter: node.adapter || null,
    ws: node.ws,
    wsTitle: node.wsTitle,
    level: node.level,
    title: node.title || clip(node.label, 60),
    label: node.label,
    preview: clip(node.content, 260),
    importance: node.importance,
    status: node.status,
    project: node.project,
    subcategory: node.subcategory,
    goal: clip(node.goal, 120),
    keywords: [...node.keywords],
    entities: [...node.entities.keys()].map((k) => String(k).split('|')[1]).slice(0, 8),
    hits: node.hits,
    heat: node.heat,
    degree: degree.get(node.i) || 0,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    accessedAt: node.accessedAt,
    sessionId: node.sessionId,
    seed: hash32(node.id) / 4294967296,
  }))

  return {
    nodes: outNodes,
    edges: finalEdges.map((edge) => ({
      s: edge.s,
      t: edge.t,
      w: edge.w,
      type: edge.type,
      why: edge.why.slice(0, 4),
    })),
    clusters: clusters.slice(0, 60),
    stats: {
      nodes: nodes.length,
      edges: finalEdges.length,
      workspaces: Object.keys(byWorkspace).length,
      sessions: nSessions,
      byType,
      byWorkspace,
      byLevel,
      orphans,
      avgDegree: Math.round((finalEdges.length * 2 * 100) / Math.max(1, nodes.length)) / 100,
    },
    builtAt: now,
  }
}

/**
 * 抽一个节点的完整正文（详情面板用）。
 * @param {object[]} nodes
 * @param {string} id
 */
export function findNode(nodes, id) {
  return nodes.find((x) => x.id === id) || null
}

export { overlapSize, intersect }

/* ------------------------------------------------------------------ *
 * 记忆体检（memory hygiene）
 *
 * 思路来自 luanyujia-workbench 的「记忆机制」：那里把失效模式列成一张表——
 * 越写越肥没人读 / 两份数字打架 / 体积正常但没用 / 关系是凑的。
 * 星图手里有全量正文和度数，这些病可以直接查出来，而不是等人自觉。
 *
 * 这里只诊断、不改任何记忆。
 * ------------------------------------------------------------------ */

const DAY = 86400000

export const HYGIENE_META = {
  dup: { label: '疑似重复', hint: '两条记忆几乎在说同一件事，留着会各写一半、互相打脸' },
  oversize: { label: '超重', hint: '单条正文超过 4000 字，读它一次就吃掉一大截上下文' },
  stale: { label: '该更新了', hint: '还挂着 active，但同一项目里有更新、更重要的记忆覆盖了它' },
  unread: { label: '没人读过', hint: '写下一周以上、一次都没被检索命中过' },
  thin: { label: '关系是凑的', hint: '边很多，但没有一条强关系（实体/项目级），全是关键词撞出来的' },
  orphan: { label: '孤立', hint: '一条边都没有：要么是独特知识，要么是没人会再想起的碎片' },
}

const HY_MAX = 40

function hyJaccard(a, b) {
  if (!a.length || !b.length) return 0
  const s = new Set(a)
  let inter = 0
  for (const x of b) if (s.has(x)) inter++
  return inter / (s.size + b.length - inter)
}

/**
 * 超过阈值才返回 Jaccard，否则 0。重复检测对每对候选都做一次，提前退出能省掉
 * 绝大多数「共享两个词」的无意义比较。
 */
function hyJaccardAtLeast(a, b, min) {
  if (!a || !b || !a.size || !b.size) return 0
  const total = a.size + b.size
  const need = Math.ceil((min * total) / (1 + min))
  const small = a.size <= b.size ? a : b
  const big = small === a ? b : a
  let inter = 0
  let seen = 0
  for (const x of small) {
    if (big.has(x)) inter++
    seen++
    if (inter + (small.size - seen) < need) return 0
  }
  return inter >= need ? inter / (total - inter) : 0
}

/**
 * 边的两端统一成「节点 id」。
 *
 * 图里为了省包体，边用的是节点下标（`{s,d,t,w}`，buildGraph 产出的则是 `{s,t}`）；
 * 早期版本这里直接读 `e.a / e.b`，于是「孤立」把每一条记忆都算了进去、
 * 「关系是凑的」永远是空的——体检报告看着有数字，其实那两格是假的。
 * 现在两种形状都认：有 id（a/b）就用 id，只有下标就借 nodeIds 还原。
 *
 * @param {object} e 边
 * @param {string[]|null} nodeIds 下标 -> id（与建图时 nodes 的顺序一致）
 */
function edgeEnds(e, nodeIds) {
  if (e.a != null || e.b != null) return [e.a, e.b]
  if (!nodeIds) return [undefined, undefined]
  // 内部边第二端叫 t，公开图（v2）叫 d —— 两个都认
  return [nodeIds[e.s], nodeIds[e.d != null ? e.d : e.t]]
}

/**
 * @param {{nodes:object[], edges:object[], nodeIds?:string[]}} input
 */
export function auditHygiene({ nodes, edges, nodeIds = null, tokensById = null }) {
  const profile = process.env.NEBULA_HY_PROFILE === '1'
  const t0 = performance.now()
  const laps = []
  const mark = (name) => { if (profile) laps.push([name, Math.round(performance.now() - t0)]) }
  const now = Date.now()
  const memories = nodes.filter((n) => n.level !== 'source')
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // 每条记忆只分词一次：df 和签名共用；建图侧若已算过 token，可以整批传进来复用。
  const toks = new Map()
  for (const n of memories) toks.set(n.id, tokensById?.get(n.id) || tokenize(n.content || ''))
  const df = new Map()
  for (const n of memories) {
    for (const t of toks.get(n.id)) df.set(t, (df.get(t) || 0) + 1)
  }
  const sig = new Map()
  const sigSets = new Map()
  for (const n of memories) {
    const set = new Set([...toks.get(n.id)].filter((t) => !t.startsWith('«')))
    const words = [...set].filter((t) => (df.get(t) || 0) > 1).sort((a, b) => (df.get(a) || 0) - (df.get(b) || 0))
    const sigWords = words.slice(0, 24)
    sig.set(n.id, sigWords)
    // 每对候选都 new Set 一次是 1 万条库上重复检测的主要开销；每个节点只建一次，
    // 之后所有比较都直接 has()。
    sigSets.set(n.id, new Set(sigWords))
  }

  mark('tokens+df+sig')
  const post = new Map()
  for (const n of memories) {
    for (const t of sig.get(n.id) || []) {
      let arr = post.get(t)
      if (!arr) post.set(t, (arr = []))
      if (arr.length < 60) arr.push(n.id)
    }
  }
  mark('postings')
  const dupPairs = []
  const seen = new Set()
  for (const [, ids] of post) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]
        const b = ids[j]
        const key = a < b ? a + '\u0000' + b : b + '\u0000' + a
        if (seen.has(key)) continue
        seen.add(key)
        const na = byId.get(a)
        const nb = byId.get(b)
        if (!na || !nb) continue
        const la = (na.content || '').length
        const lb = (nb.content || '').length
        if (Math.min(la, lb) / Math.max(1, Math.max(la, lb)) < 0.6) continue
        const j2 = hyJaccardAtLeast(sigSets.get(a), sigSets.get(b), 0.86)
        if (j2 > 0) dupPairs.push({ a, b, j: j2 })
      }
    }
  }
  mark('dup-pairs')
  dupPairs.sort((x, y) => y.j - x.j)

  // 阈值不写死：跟这批记忆的实际体量比，取「最重的 3%」，但不低于 1200 字
  const lens = memories.map((m) => (m.content || '').length).sort((a, b) => a - b)
  const overLimit = Math.max(600, lens[Math.floor(lens.length * 0.97)] || 600)
  const oversize = memories
    .filter((n) => (n.content || '').length > overLimit)
    .sort((a, b) => (b.content || '').length - (a.content || '').length)
    .slice(0, HY_MAX)
    .map((n) => ({ id: n.id, label: n.label, ws: n.wsTitle, level: n.level, size: (n.content || '').length }))

  const byWs = new Map()
  for (const n of memories) {
    if (n.status !== 'active') continue
    let arr = byWs.get(n.ws)
    if (!arr) byWs.set(n.ws, (arr = []))
    arr.push(n)
  }
  mark('oversize')
  const stale = []
  for (const [, list] of byWs) {
    // 倒排：keyword → 该工作区里含这个词的记忆（按 updatedAt 从新到旧）。
    // 旧写法对每条记忆都扫一遍整个工作区，1 万条时是平方级；倒排后只看
    // 「更新 + 更重要」的少量候选，命中 3 个共同关键词就停。
    const kwPost = new Map()
    for (const m of list) {
      for (const k of new Set((m.keywords || []).map((x) => String(x).toLowerCase()))) {
        let arr = kwPost.get(k)
        if (!arr) kwPost.set(k, (arr = []))
        arr.push(m)
      }
    }
    for (const arr of kwPost.values()) arr.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
    for (const n of list) {
      const ageDays = (now - (n.updatedAt || n.createdAt || now)) / DAY
      if (ageDays < 14) continue
      const hitsPer = new Map()
      let cover = null
      outer: for (const k of new Set((n.keywords || []).map((x) => String(x).toLowerCase()))) {
        for (const m of kwPost.get(k) || []) {
          if ((m.updatedAt || 0) <= (n.updatedAt || 0)) break
          if (m.id === n.id) continue
          if ((m.importance || 0) < (n.importance || 0)) continue
          const hit = (hitsPer.get(m.id) || 0) + 1
          hitsPer.set(m.id, hit)
          if (hit >= 3) {
            cover = m
            break outer
          }
        }
      }
      if (cover) {
        stale.push({
          id: n.id,
          label: n.label,
          ws: n.wsTitle,
          level: n.level,
          days: Math.round(ageDays),
          by: { id: cover.id, label: cover.label },
        })
      }
    }
  }
  stale.sort((a, b) => b.days - a.days)

  mark('stale')
  const unread = memories
    .filter((n) => !n.hits && (now - (n.createdAt || now)) / DAY > 3 && n.status === 'active')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(0, HY_MAX)
    .map((n) => ({ id: n.id, label: n.label, ws: n.wsTitle, level: n.level, days: Math.round((now - (n.createdAt || now)) / DAY) }))

  mark('unread')
  const sum = new Map()
  const cnt = new Map()
  const strong = new Map()
  // 强关系门槛：实体边中位数 0.62、项目边 0.52，关键词边绝大多数钉在 0.30 —— 0.45 正好把「撞词」和「真关系」分开
  const STRONG_W = 0.45
  for (const e of edges) {
    const w = e.w || 0
    for (const id of edgeEnds(e, nodeIds)) {
      if (id == null) continue
      sum.set(id, (sum.get(id) || 0) + w)
      cnt.set(id, (cnt.get(id) || 0) + 1)
      if (w >= STRONG_W) strong.set(id, (strong.get(id) || 0) + 1)
    }
  }
  mark('edges')
  const thin = []
  for (const n of memories) {
    // 只看「边很多、却一条强边都没有」：均值会被大量 0.30 的关键词边拖低，
    // 单看均值会把有实体关系的节点也误判进来（实测 326 条里 202 条其实有硬关系）。
    const c = cnt.get(n.id) || 0
    if (c < 10) continue
    if (strong.get(n.id) || 0) continue
    const avg = (sum.get(n.id) || 0) / c
    thin.push({ id: n.id, label: n.label, ws: n.wsTitle, level: n.level, degree: c, avg: Number(avg.toFixed(2)) })
  }
  thin.sort((a, b) => a.avg - b.avg)

  mark('thin')
  const orphan = memories
    .filter((n) => !(cnt.get(n.id) || 0))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, HY_MAX)
    .map((n) => ({ id: n.id, label: n.label, ws: n.wsTitle, level: n.level, importance: n.importance || 0 }))

  const dup = dupPairs.slice(0, HY_MAX).map((p) => ({
    a: { id: p.a, label: byId.get(p.a)?.label || '', ws: byId.get(p.a)?.wsTitle || '' },
    b: { id: p.b, label: byId.get(p.b)?.label || '', ws: byId.get(p.b)?.wsTitle || '' },
    sim: Number(p.j.toFixed(3)),
  }))

  const items = { dup, oversize, stale, unread, thin, orphan }
  const counts = {}
  let total = 0
  for (const k of Object.keys(items)) {
    counts[k] = items[k].length
    total += items[k].length
  }
  mark('orphan')
  if (profile) console.error('[hygiene]', laps.map(([n, t]) => `${n}:${t}ms`).join(' '))
  return { generatedAt: now, counts, total, items, meta: HYGIENE_META }
}
