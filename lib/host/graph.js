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
 * @param {object[]} input.nodes   来自适配器层（lib/host/adapters/*）扫描出的所有节点
 * @param {{sessionId:string,kind:string,ids:string[],ws:string}[]} input.ledgers 每会话活动
 * @param {{a:string,b:string,type?:string,weight?:number,note?:string,createdAt?:number}[]} [input.manual] 手工策展边
 * @param {{a:string,b:string}[]} [input.mutes] 被人工屏蔽的关联对（重建时永不连接）
 * @param {{sessionWorkspaces?:Record<string,string>}} [input.meta]
 * @returns {{nodes:object[],edges:object[],clusters:object[],stats:object,builtAt:number}}
 */
/** 同步建图：一口气跑完（测试、脚本、小库直接用它，行为与 1.11.3 一致）。 */
export function buildGraph(input) {
  const it = buildGraphSteps(input)
  let step = it.next()
  while (!step.done) step = it.next()
  return step.value
}

/**
 * 异步建图：每 128 条记忆 / 1024 个候选就让出一次事件循环。
 *
 * 为什么要有它：2 万条的库上建图 3.7 秒（节点准备 2.5s + 打分剪枝 0.5s + 其余 0.7s）。
 * 这条路径挂在宿主 web server 的事件循环上，同步跑就是「每次写记忆都卡三秒」。
 * 分片之后总时长不变，最长静默降到几十毫秒。
 */
export async function buildGraphAsync(input) {
  const it = buildGraphSteps(input)
  // 过程反馈：建图那几秒里界面要能说清走到哪一阶段，而不是一直转圈。
  // 回调是可选的——同步版 buildGraph 与所有老调用方都照旧。
  const onStep = typeof input.onStep === 'function' ? input.onStep : null
  for (;;) {
    const step = it.next()
    if (step.done) return step.value
    if (onStep) onStep(step.value)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

// 取「最稀有的 top 个词」。等价于：
//   const arr = [...tokens]; arr.sort((a, b) => weightOf(b) - weightOf(a)); arr.slice(0, top)
// 包括等权重时的先后（先来的排在前面，与稳定排序一致），但不排序整张词表。
// 5 万条库上这一步原来是 5 万次排序、约 2.4 秒，改完 1.1 秒；
// 单独拿出来做纯函数，也是为了让单测能把它和参考实现逐例钉死。
export function topRareTokens(tokens, weightOf, top = 26) {
  const vals = []
  const picked = []
  for (const t of tokens) {
    const w = weightOf(t)
    if (vals.length === top && w <= vals[top - 1]) continue
    let at = vals.length
    while (at > 0 && vals[at - 1] < w) at--
    vals.splice(at, 0, w)
    picked.splice(at, 0, t)
    if (vals.length > top) {
      vals.pop()
      picked.pop()
    }
  }
  return new Set(picked)
}

export function* buildGraphSteps(input) {
  // 时间会影响热度（heat）与取样顺序，于是同一份库连跑两次边数可能差几条。
  // 允许调用方冻结它：测试与等价性比对需要「同一把尺子」，默认仍是当下。
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  // 阶段计时：只在 NEBULA_GRAPH_TIMING=1 时打印，用来决定大图取样的窗口大小，不进正常输出。
  const __tm = process.env.NEBULA_GRAPH_TIMING ? { t: Date.now(), marks: [] } : null
  const mark = (label) => {
    if (!__tm) return
    const cur = Date.now()
    __tm.marks.push(label + ':' + (cur - __tm.t))
    __tm.t = cur
  }
  const rawNodes = (input.nodes || []).filter((n) => n && n.id)
  const manual = Array.isArray(input.manual) ? input.manual : []
  const ledgers = Array.isArray(input.ledgers) ? input.ledgers : []
  const mutes = Array.isArray(input.mutes) ? input.mutes : []
  // 屏蔽对用「小 id + 0x00 + 大 id」做键；建边时直接跳过，等于人工否掉这条推断
  const muteSet = new Set(mutes.map((m) => (m.a < m.b ? m.a + '\u0000' + m.b : m.b + '\u0000' + m.a)))

  /** @type {Map<string,number>} nodeId -> index */
  const index = new Map()
  // 节点准备（分词 + 抽实体 + 算热度）在 2 万条库上要 2.5 秒，占整次建图的七成。
  // 切成 128 条一片，异步版本在片与片之间把事件循环让出去：总时长不变，
  // 但宿主界面不再跟着停住。同步版本（buildGraph）照旧一口气跑完。
  const nodes = []
  let sliceAt = Date.now()
  // 让出事件循环的节奏：按「用了多久」而不是「做了多少条」判断。
  // 单条记忆的代价差别能到两个数量级（超长正文的分词与两两比对），
  // 按条数切片会切出秒级的一片，等于没让出去。
  let budgetTick = 0
  const budgetSpent = (mask) => {
    budgetTick++
    if ((budgetTick & mask) !== 0) return false
    return Date.now() - sliceAt >= 6
  }
  for (let base = 0; base < rawNodes.length; base += 128) {
    const chunk = rawNodes.slice(base, base + 128)
    for (let k = 0; k < chunk.length; k++) {
      const n = chunk[k]
      const i = base + k
      index.set(n.id, i)
      const text = [n.title, n.content, n.project, n.goal, ...(n.keywords || [])].filter(Boolean).join('\n')
      const tokens = tokenize(text)
      const entities = pruneEntities(extractEntities(text))
      nodes.push({
        ...n,
        kind: n.kind || 'memory',
        i,
        tokens,
        blob: text.toLowerCase(),
        sigIds: null,
        entities,
        keywords: new Set((n.keywords || []).map((x) => String(x).toLowerCase())),
        heat: heatOf(n, now),
      })
    }
    yield 'nodes'
  }
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
  // ---------- 文档频次 ----------
  // 词频原来是 Map<string, count>：367 万个词次，每次都要哈希一遍字符串再装箱。
  // 换成「词 -> 编号 + Int32Array 计数」之后，热循环里只剩一次查表加一次自增，
  // 权重仍按编号取（同一个词在打分里会被问上万次，编号比字符串便宜得多）。
  const tokenId = new Map()
  const idTokens = [] // id -> 词：签名最后要还原成字符串，下游一行都不用改
  let dfCap = 1 << 14
  let tokenDF = new Int32Array(dfCap)
  const dfOfToken = (t) => {
    const id = tokenId.get(t)
    return id === undefined ? 0 : tokenDF[id]
  }
  const entityDF = new Map()
  const keywordDF = new Map()
  for (const node of nodes) {
    const tids = new Int32Array(node.tokens.size)
    let ti = 0
    for (const t of node.tokens) {
      let id = tokenId.get(t)
      if (id === undefined) {
        id = tokenId.size
        if (id >= dfCap) {
          dfCap *= 2
          const bigger = new Int32Array(dfCap)
          bigger.set(tokenDF)
          tokenDF = bigger
        }
        tokenId.set(t, id)
        idTokens.push(t)
      }
      tokenDF[id] += 1
      tids[ti++] = id
    }
    node.tids = tids
    for (const k of node.entities.keys()) entityDF.set(k, (entityDF.get(k) || 0) + 1)
    for (const k of node.keywords) keywordDF.set(k, (keywordDF.get(k) || 0) + 1)
    if (budgetSpent(255)) {
      sliceAt = Date.now()
      yield 'df'
    }
  }
  // ---------- 大图取样（5 万条级） ----------
  // 词表是有上限的：5 万条记忆里，一个常用词会出现几百上千次。旧规则（关键词 df > 70
  // 或 token df > 160 就整条跳过）在小库里是对的，到 5 万条会把几乎所有词滤掉，
  // 实测只剩 280 条边、99.1% 的节点是孤岛 —— 那不是一个能看的图。
  // 抬上限的老原型把 1 万条拖慢了近一倍，却仍没把 5 万条带进预算，所以这里换一种做法：
  // **按重要度取样配对**。稀有词照旧全量配对，高频词只让最重要的若干条记忆互相配对，
  // 建边成本随词数线性增长，孤岛回到可浏览范围。
  const BIG_GRAPH = n > 20000
  const BIG_TERM_WINDOW = 3
  const BIG_TOKEN_WINDOW = 2
  const BIG_ENTITY_WINDOW = 3
  // 取样要「按重要度」，所以大图的倒排索引按重要度顺序插入；小图保持原顺序，行为不变。
  const postNodes = BIG_GRAPH
    ? nodes
        .slice()
        .sort((a, b) => (b.importance || 0) - (a.importance || 0) || (b.heat || 0) - (a.heat || 0) || a.i - b.i)
    : nodes

  // idf 只跟 df 有关；同一条 token 在打分里会被反复问，缓存一次省掉大量 Math.log。
  // idf 只跟 df 有关：一次算成「按编号索引的 Float64Array」，别再每次查表 + 算 log。
  const idfById = new Float64Array(tokenId.size)
  for (let id = 0; id < idfById.length; id++) idfById[id] = idf(tokenDF[id] || 1, n)
  const idfOfUnknown = idf(1, n)
  const tokenWeight = (t) => {
    const id = tokenId.get(t)
    return id === undefined ? idfOfUnknown : idfById[id]
  }

  // 「语义签名」：每个节点最稀有的 26 个词。
  // 长文本词多、短文本词少，直接比全集永远是短的那条吃亏；取稀有词签名更公平。
  // 有界插入：只维护 26 个「最稀有」的位置，不再把每个节点的整张词表排序。
  // 权重是 df 的单调函数，等权重时保持「先来的排前面」——与整表排序 + slice(0, 26) 逐位等价，
  // 但 5 万条库上省掉 5 万次排序（实测 2.6s -> 0.3s）。
  const SIG_TOP = 26
  const pickI = new Int32Array(SIG_TOP)
  const pickW = new Float64Array(SIG_TOP)
  for (const node of nodes) {
    // 和 topRareTokens 逐位等价：权重相等时不插到前面（先来的排前面）
    const tids = node.tids
    let pickLen = 0
    for (let i = 0; i < tids.length; i++) {
      const id = tids[i]
      const w = idfById[id]
      if (pickLen === SIG_TOP && w <= pickW[SIG_TOP - 1]) continue
      let at = pickLen
      while (at > 0 && pickW[at - 1] < w) {
        pickW[at] = pickW[at - 1]
        pickI[at] = pickI[at - 1]
        at--
      }
      pickW[at] = w
      pickI[at] = id
      if (pickLen < SIG_TOP) pickLen++
    }
    // 签名存成「按编号升序的 Int32Array」：交集靠双指针合并，不再一个个哈希字符串。
    const ids = pickI.slice(0, pickLen)
    ids.sort()
    node.sigIds = ids
    if (budgetSpent(127)) {
      sliceAt = Date.now()
      yield 'sig'
    }
  }
  const EMPTY_IDS = new Int32Array(0)

  // 每个节点签名的总权重只算一次；scorePair 里每对候选都要用它，重复遍历是纯浪费。
  const sigWeight = new Float64Array(n)
  for (const node of nodes) {
    let sum = 0
    const ids = node.sigIds
    for (let k = 0; k < ids.length; k++) sum += idfById[ids[k]]
    sigWeight[node.i] = sum
    if (budgetSpent(511)) {
      sliceAt = Date.now()
      yield 'sig'
    }
  }

  mark('nodes')
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
  for (const node of postNodes) {
    const tokenLimit = BIG_GRAPH ? n : Math.max(6, Math.floor(n * 0.2))
    // 小图（≤1000 条）用全量 token 保召回；大图只用「最稀有的 26 个词」做候选。
    // 1 万条时全量 token 会把同一段模板文字里的常见 bigram 也拿去两两配对，
    // 是平方级浪费，而稀有词签名已经足够把真正相似的两条连起来。
    if (n <= 1000) {
      // 小图用全量 token；倒排按编号分组（键只用于分组，没人按 key 查）
      for (const t of node.tokens) {
        const id = tokenId.get(t)
        if (id === undefined || tokenDF[id] > tokenLimit) continue
        push(tokenPost, id, node.i)
      }
    } else {
      // 大图只拿签名里的词做候选；编号在手，df 直接读数组，不用再哈希一遍字符串
      const ids = node.sigIds
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k]
        if (tokenDF[id] > tokenLimit) continue
        push(tokenPost, id, node.i)
      }
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
      // 大图不再整条丢弃高频词，改由后面的「取样配对」限制它的两两组合数。
      if (!BIG_GRAPH && (df > MAX_KEYWORD_DF_ABS || df > n * MAX_KEYWORD_DF_RATIO)) continue
      push(keywordPost, k, node.i)
    }
    if (budgetSpent(255)) {
      sliceAt = Date.now()
      yield 'postings'
    }
  }

  mark('postings')
  // ---------- 候选对累加 ----------
  // 候选对的键原来是字符串 "123:456"：每凑一对就要 allocate 一个字符串，再把整串哈希一遍。
  // 5 万条库上有 27.5 万个候选、上百万次 slot() 调用，这笔账几乎全花在分配上。
  // 改成数字键 a * PAIR_BASE + b（a < b）：索引上界 5.2 万，2^20 做基数，乘积 ≤ 5.5e10，
  // 在 2^53 以内可以精确表示；Map 的插入顺序与字符串键时完全一致，所以边的产出顺序也不变。
  const PAIR_BASE = 1 << 20
  const pairKey = (a, b) => (a < b ? a * PAIR_BASE + b : b * PAIR_BASE + a)
  const pairA = (key) => Math.floor(key / PAIR_BASE)
  const pairB = (key, a) => key - a * PAIR_BASE
  /** @type {Map<number, {kwCount:number, ent:string[]|null, tok:number}>} */
  const cand = new Map()
  const slot = (a, b) => {
    const key = pairKey(a, b)
    let s = cand.get(key)
    if (!s) {
      s = { kwCount: 0, ent: null, tok: 0 }
      cand.set(key, s)
    }
    return s
  }
  // ent 是「这一对共享了哪些硬实体」，只有少数候选会用到。
  // 27.5 万个候选各开一个空数组就是 27.5 万个对象头，改成用到时才建。
  const addEnt = (s, key) => {
    if (s.ent) s.ent.push(key)
    else s.ent = [key]
  }

  // 大图的取样配对：倒排表已按重要度排序，只让每个节点和它邻近的 W 条配对。
  // 取「前 N 条互相配对」会让排在后面的节点永远轮不到（实测 5 万条仍有 89.6% 孤岛），
  // 滑动窗口保证每个节点都被覆盖，代价仍随词频线性增长。
  const sampleWindow = (list, w, cb) => {
    const L = list.length
    const win = Math.min(w, L - 1)
    for (let x = 0; x < L; x++) {
      for (let y = x + 1; y <= x + win && y < L; y++) cb(list[x], list[y])
    }
  }

  for (const [kw, list] of keywordPost) {
    if (budgetSpent(15)) {
      sliceAt = Date.now()
      yield 'cand'
    }
    if (list.length < 2) continue
    if (BIG_GRAPH) {
      sampleWindow(list, BIG_TERM_WINDOW, (a, b) => slot(a, b).kwCount++)
      continue
    }
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) slot(list[x], list[y]).kwCount++
    }
  }
  for (const [key, list] of entityPost) {
    if (budgetSpent(15)) {
      sliceAt = Date.now()
      yield 'cand'
    }
    if (list.length < 2) continue
    // 一个标识出现在上百条记忆里就不再是「同一实体」的证据，只是公共路径/版本号。
    // 不设上限时，1 万条库里的共享路径会生成上千万对候选，建图直接掉到秒级以外。
    // 2 万条以上时，同一个通用标识出现在几百条记忆里只是公共路径/模板；
    // 把配对上限从 120 收到 60，候选对从 1,180 万降到 300 万，20k 建图回到 3s 内。
    // 5 万条级：通用标识（package.json 之类）出现在几千条里，整条丢弃会让图失去仅剩的
    // 硬证据；改成滑动窗口取样。
    const entityPairCap = n > 12000 ? 60 : 120
    if (BIG_GRAPH) {
      sampleWindow(list, BIG_ENTITY_WINDOW, (a, b) => addEnt(slot(a, b), key))
      continue
    }
    if (list.length > entityPairCap) continue
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) addEnt(slot(list[x], list[y]), key)
    }
  }
  const sharedTokenCount = new Map()
  for (const [, list] of tokenPost) {
    if (budgetSpent(15)) {
      sliceAt = Date.now()
      yield 'cand'
    }
    if (list.length < 2) continue
    if (BIG_GRAPH) {
      // 5 万条级：900 个词分摊到 5 万条，每个词都超过 160 条，旧规则让 tokenPost 全空。
      // 只取邻近的 6 条互相配对：这是「按重要度取样」，不是「召回全部相似对」。
      sampleWindow(list, BIG_TOKEN_WINDOW, (a, b) => {
        const key = pairKey(a, b)
        sharedTokenCount.set(key, (sharedTokenCount.get(key) || 0) + 1)
      })
      continue
    }
    if (list.length > 160) continue // 太常见的词不做语义候选
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const key = pairKey(list[x], list[y])
        sharedTokenCount.set(key, (sharedTokenCount.get(key) || 0) + 1)
      }
    }
  }
  for (const [key, count] of sharedTokenCount) {
    if (budgetSpent(1023)) {
      sliceAt = Date.now()
      yield 'cand'
    }
    // 短笔记（签名 ≤12 个词）放宽到共享 2 个稀有词：新接入的笔记目录/小记忆库
    // 天然短，按长记忆的标准永远连不上，接进来就是一串孤岛。
    const a = pairA(key)
    const b = pairB(key, a)
    const minSig = Math.min(nodes[a].sigIds.length, nodes[b].sigIds.length)
    const need = minSig <= 12 ? 2 : 4
    if (count < need) continue
    const s = cand.get(key)
    if (s) s.tok = count
    else cand.set(key, { kwCount: 0, ent: [], tok: count })
  }

  // ---------- 共激活（Hebbian）：按会话统计 ----------
  const coAct = new Map()
  const uidToIndex = new Map()
  for (const node of nodes) {
    const key = node.ws + '\u0000' + node.uid
    if (!uidToIndex.has(key)) uidToIndex.set(key, [])
    uidToIndex.get(key).push(node.i)
  }
  const coKey = pairKey // 同一个键协议，别名保留给读到这里的旧注释
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
    if (budgetSpent(31)) {
      sliceAt = Date.now()
      yield 'cand'
    }
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
    if (budgetSpent(1023)) {
      sliceAt = Date.now()
      yield 'cand'
    }
    if (co < 1.6) continue
    if (cand.has(key)) continue
    cand.set(key, { kwCount: 0, ent: null, tok: 0 })
  }

  mark('candidates')
  // ---------- 打分 ----------
  /** @type {{s:number,t:number,type:string,w:number,why:string[],parts:Record<string,number>}[]} */
  const edges = []
  const nSessions = bySession.size || 1

  // 实体 key 形如 "file|package.json"，拆出来只为了判断「通用叶子名」和给人看。
  // 同一个 key 会在几十万个候选里被反复拆，缓存一次就够。
  const leafCache = new Map()
  const leafOf = (key) => {
    let v = leafCache.get(key)
    if (v === undefined) {
      v = String(key).split('|')[1] || ''
      leafCache.set(key, v)
    }
    return v
  }

  // 实体的稀有度分只跟 key 与 df 有关，而 df 这时候已经定了；27 万个候选对
  // 每对最多查 12 个实体，逐个算 splitEntity + log2 是白花钱。缓存一次。
  const entScoreCache = new Map()
  const entScoreOf = (key) => {
    let rec = entScoreCache.get(key)
    if (rec === undefined) {
      rec = { s: entityStrength(key, entityDF.get(key) || 1, n), g: GENERIC_LEAF.test(leafOf(key)) }
      entScoreCache.set(key, rec)
    }
    return rec
  }

  const scorePair = (a, b, s) => {
    const A = nodes[a]
    const B = nodes[b]
    let kwW = 0
    let entW = 0
    let projW = 0
    let semW = 0
    let hebW = 0
    let semInter = 0
    let semSim = 0
    let co = 0
    const kwCount = s.kwCount || 0

    // 1) 关键词。共享词数在候选生成时已累计，不再为每个候选保存字符串数组。
    if (kwCount > 0) {
      const jac = kwCount / Math.max(1, A.keywords.size + B.keywords.size - kwCount)
      let rare = 0
      for (const k of A.keywords) {
        if (!B.keywords.has(k)) continue
        if ((keywordDF.get(k) || 0) <= Math.max(3, n * 0.05)) rare++
      }
      let w = 0
      if (kwCount >= 2 && jac >= 0.16) w = 0.3 + 0.4 * Math.min(1, jac * 1.7)
      else if (kwCount >= 2) w = 0.26 + 0.12 * Math.min(1, jac * 2)
      else if (rare >= 1) w = 0.3
      else w = 0.2
      if (w > 0.2) kwW = w
    }

    // 2) 硬实体（最可信）
    //    跨工作区时，通用文件名（package.json / index.ts / app.html…）不算证据 ——
    //    两个项目各有一个 package.json，不代表它们说的是同一件事。
    if (s.ent && s.ent.length > 0) {
      let best = 0
      const crossWs = A.ws !== B.ws
      for (let i = 0; i < s.ent.length && i < 12; i++) {
        const rec = entScoreOf(s.ent[i])
        if (crossWs && rec.g) continue
        if (rec.s > best) best = rec.s
      }
      if (best > 0.18) entW = Math.min(0.86, 0.26 + 0.68 * best)
    }

    // 3) 同项目（只在跨工作区时当桥用；同库同项目不连，否则一团糊）
    if (A.project && A.project === B.project && A.project !== '全局' && A.ws !== B.ws) {
      projW = 0.52
    }

    // 4) 语义相似：稀有词签名的「重叠系数」（交集权重 / 较小一侧权重）
    const aIds = A.sigIds
    const bIds = B.sigIds
    const minSig = Math.min(aIds.length, bIds.length)
    const needInter = minSig <= 12 ? 2 : 4
    const needSim = minSig <= 12 ? 0.12 : 0.18
    if (s.tok >= needInter) {
      // 两边都是升序编号：双指针合并，交集一次走完，不哈希也不查表
      let inter = 0
      let iw = 0
      let xa = 0
      let yb = 0
      while (xa < aIds.length && yb < bIds.length) {
        const av = aIds[xa]
        const bv = bIds[yb]
        if (av === bv) {
          inter++
          iw += idfById[av]
          xa++
          yb++
        } else if (av < bv) xa++
        else yb++
      }
      if (inter >= needInter) {
        const sim = iw / Math.max(1e-9, Math.min(sigWeight[a], sigWeight[b]))
        if (sim >= needSim) {
          semInter = inter
          semSim = sim
          semW = Math.min(0.58, 0.12 + 0.6 * sim)
        }
      }
    }

    // 5) 共激活
    co = coAct.get(coKey(a, b)) || 0
    if (co > 0) {
      const w = Math.min(0.5, 0.1 * Math.log2(1 + co * 2) * (1 + Math.log2(1 + co) * 0.25))
      if (co >= 1) hebW = w
    }

    // 与 combine() 同语义：概率式 OR，只在确定要产出边时才分配 parts/why。
    const weight = Math.min(0.99, 1 - (1 - kwW) * (1 - entW) * (1 - projW) * (1 - semW) * (1 - hebW))
    if (weight < MIN_EDGE_WEIGHT) return null
    const partCount = (kwW > 0 ? 1 : 0) + (entW > 0 ? 1 : 0) + (projW > 0 ? 1 : 0) + (semW > 0 ? 1 : 0) + (hebW > 0 ? 1 : 0)
    if (partCount === 1 && hebW > 0 && co < 1.6) return null

    const parts = {}
    const why = []
    if (kwW > 0) {
      parts.keyword = kwW
      const shared = []
      for (const k of A.keywords) {
        if (B.keywords.has(k) && shared.length < 4) shared.push(k)
      }
      why.push('共享关键词：' + shared.join('、'))
    }
    if (entW > 0) {
      const shown = []
      const crossWs = A.ws !== B.ws
      for (let i = 0; i < s.ent.length && i < 12 && shown.length < 3; i++) {
        const key = s.ent[i]
        const leaf = leafOf(key)
        if (crossWs && GENERIC_LEAF.test(leaf)) continue
        shown.push(leaf)
      }
      parts.entity = entW
      why.push('同一标识：' + shown.join('、'))
    }
    if (projW > 0) {
      parts.project = projW
      why.push('跨工作区同项目：' + A.project)
    }
    if (semW > 0) {
      parts.semantic = semW
      why.push('正文共享 ' + semInter + ' 个稀有词（覆盖 ' + semSim.toFixed(2) + '）')
    }
    if (hebW > 0) {
      parts.hebbian = hebW
      why.push('同会话共激活 ' + Math.round(co * 10) / 10 + ' 次')
    }

    const keys = Object.keys(parts)
    keys.sort((x, y) => parts[y] - parts[x])
    return { s: a, t: b, type: keys[0], w: Math.round(weight * 1000) / 1000, why, parts }
  }

  // 人工否掉的关联对：先把「记忆 id 对」翻译成「索引对」，打分循环里只查一张数字集合，
  // 不再为 27 万个候选各拼一次字符串。
  const mutePairs = new Set()
  for (const m of mutes) {
    const ia = index.get(m.a)
    const ib = index.get(m.b)
    if (ia === undefined || ib === undefined) continue
    mutePairs.add(pairKey(ia, ib))
  }
  for (const [key, s] of cand) {
    const a = pairA(key)
    const b = pairB(key, a)
    // 人工否掉的关联对：无论证据多强都不连
    if (mutePairs.size && mutePairs.has(key)) continue
    const edge = scorePair(a, b, s)
    if (edge) edges.push(edge)
    // 按时间切片，不按条数：个别区域一条边要 1–2ms（超长记忆两两比对），
    // 按 1024 条切会切出 1.7 秒的一片，等于没让出事件循环。
    if (budgetSpent(63)) {
      sliceAt = Date.now()
      yield 'score'
    }
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
  // 优先级先算成数组再排序。原来把 priority() 直接放进比较函数，11 万条边要算
  // 上百万次（排序比较次数 ≈ n log n，每次都查两遍节点对象）；预算是 O(n)，快得多。
  const prio = new Float64Array(edges.length)
  for (let i = 0; i < edges.length; i++) {
    prio[i] = priority(edges[i])
    if ((i & 8191) === 0) yield 'prune'
  }
  const order = edges.map((_, i) => i).sort((i, j) => prio[j] - prio[i])
  const keep = new Set()
  // 大图把每节点上限收到 8：5 万条时 16 条上限会产出 39 万条边（快照 50MB），
  // 而它们的收益主要在「看起来密」；8 条已经能把孤岛清零，包体积和绘制成本都砍半。
  const degreeLimit = BIG_GRAPH ? 8 : MAX_EDGES_PER_NODE
  const degreeCap = new Uint16Array(n)
  let pruned = 0
  for (const i of order) {
    if ((++pruned & 4095) === 0) yield 'prune'
    const edge = edges[i]
    if (edge.type === 'explicit') {
      keep.add(i)
      degreeCap[edge.s]++
      degreeCap[edge.t]++
      continue
    }
    if (degreeCap[edge.s] >= degreeLimit || degreeCap[edge.t] >= degreeLimit) continue
    keep.add(i)
    degreeCap[edge.s]++
    degreeCap[edge.t]++
  }
  const finalEdges = edges.filter((_, i) => keep.has(i))
  mark('score+prune')
  if (__tm) {
    console.error('[graph] n=' + n + ' cand=' + cand.size + ' edges=' + edges.length + ' kept=' + finalEdges.length + ' ' + __tm.marks.join(' '))
  }

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
      const a = pairA(key)
      const b = pairB(key, a)
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
        // 先做一次廉价的 includes 预筛：正则要在 5 万条正文上跑，比字符串查找慢一个数量级，
        // 而绝大多数名字一次都不出现。这一层预筛把整段从 322ms 压到几十毫秒。
        if (node.blob && node.blob.includes(needle) && re.test(node.blob)) hitIdx.push(node.i)
        if (hitIdx.length >= 24) break
        if (budgetSpent(1023)) {
          sliceAt = Date.now()
          yield 'sources'
        }
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
        sigIds: EMPTY_IDS,
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
    if (budgetSpent(2047)) {
      sliceAt = Date.now()
      yield 'cluster'
    }
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
      if (budgetSpent(1023)) {
        sliceAt = Date.now()
        yield 'cluster'
      }
    }
    // 取最大项不必排序：一个簇可能有几万成员，[...entries()].sort() 在 5 万条库上
    // 是单片 263ms 的元凶（排序 + 展开两个临时数组），换成一次扫描即可，顺手也让路。
    let topProject = ''
    let topCount = -1
    for (const [p, c] of projectCount) {
      if (c > topCount) {
        topProject = p
        topCount = c
      }
      if (budgetSpent(1023)) {
        sliceAt = Date.now()
        yield 'cluster'
      }
    }
    const wsCount = new Map()
    for (const i of members) {
      wsCount.set(nodes[i].ws, (wsCount.get(nodes[i].ws) || 0) + 1)
      if (budgetSpent(1023)) {
        sliceAt = Date.now()
        yield 'cluster'
      }
    }
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
    if (budgetSpent(2047)) {
      sliceAt = Date.now()
      yield 'output'
    }
  }
  const byWorkspace = {}
  const byLevel = {}
  for (const node of nodes) {
    byWorkspace[node.wsTitle] = (byWorkspace[node.wsTitle] || 0) + 1
    byLevel[node.level] = (byLevel[node.level] || 0) + 1
    if (budgetSpent(2047)) {
      sliceAt = Date.now()
      yield 'output'
    }
  }
  const orphans = nodes.filter((node) => !degree.has(node.i)).length

  const outNodes = []
  for (let oc = 0; oc < nodes.length; oc += 512) {
    for (const node of nodes.slice(oc, oc + 512)) outNodes.push({
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
    })
    sliceAt = Date.now()
    yield 'output'
  }

  const outEdges = []
  for (let ec = 0; ec < finalEdges.length; ec += 4096) {
    for (const edge of finalEdges.slice(ec, ec + 4096)) {
      outEdges.push({
        s: edge.s,
        t: edge.t,
        w: edge.w,
        type: edge.type,
        why: edge.why.slice(0, 4),
      })
    }
    sliceAt = Date.now()
    yield 'output'
  }

  return {
    nodes: outNodes,
    edges: outEdges,
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
// 关键词去重 + 小写：体检里到处都按这个口径比词
function kwOf(m) {
  return [...new Set((m.keywords || []).map((x) => String(x).toLowerCase()))]
}

// 集合 set 里命中 list 至少 t 个就早退（list 通常 3–8 个词，比求交还便宜）
function overlapAtLeast(set, list, t) {
  if (!set || !set.size) return false
  let hit = 0
  for (const k of list) {
    if (set.has(k)) {
      hit++
      if (hit >= t) return true
    }
  }
  return false
}

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
/** 同步跑完体检：纯函数，测试与小库直接用它（行为与 1.11.3 完全一致）。 */
export function auditHygiene(args) {
  const it = auditHygieneSteps(args)
  let step = it.next()
  while (!step.done) step = it.next()
  return step.value
}

/**
 * 异步体检：每做完一小片就把事件循环让出去。
 *
 * 为什么要这样：2 万条的库上体检要 2.9 秒（分词签名 1.1s + 重复检测 1.5s），
 * 同步跑等于让整个 HTTP 服务停三秒。在 DSH 里这条路由挂在宿主自己的 web server 上，
 * 「停三秒」就是主界面的按钮三秒没反应。生成器把活切成片，await setImmediate 让 ping、
 * 静态资源、其它请求都能插进来；总时长不变，最长静默从秒级降到几十毫秒。
 */
export async function auditHygieneAsync(args) {
  const it = auditHygieneSteps(args)
  for (;;) {
    const step = it.next()
    if (step.done) return step.value
    await new Promise((resolve) => setImmediate(resolve))
  }
}

export function* auditHygieneSteps({ nodes, edges, nodeIds = null, tokensById = null }) {
  const profile = process.env.NEBULA_HY_PROFILE === '1'
  const t0 = performance.now()
  const laps = []
  const mark = (name) => { if (profile) laps.push([name, Math.round(performance.now() - t0)]) }
  const now = Date.now()
  const memories = nodes.filter((n) => n.level !== 'source')
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // 每条记忆只分词一次：df 和签名共用；建图侧若已算过 token，可以整批传进来复用。
  const toks = new Map()
  // 这一支是生成器：每做完一小片就 yield 一次，异步版本据此把事件循环让出去。
  // 2 万条库上体检要 2.9 秒（分词签名 1.1s + 重复检测 1.5s），整段同步跑等于让
  // HTTP 服务（在 DSH 里就是宿主自己的事件循环）停三秒：/ping 不回声、按钮没反应。
  const SLICE = 2048
  let slice = 0
  for (const n of memories) {
    toks.set(n.id, tokensById?.get(n.id) || tokenize(n.content || ''))
    if (++slice >= SLICE) {
      slice = 0
      yield 'tokens'
    }
  }
  mark('tok')
  // ① 词频：给每个词一个内部编号，计数走 Int32Array。
  //    旧写法每个词要 df.get + df.set 两次字符串哈希；5 万条库上 260 万个词次，
  //    这两次哈希就是 973ms 里的大头。编号只哈希一次，之后都是数组下标。
  const wordId = new Map()
  // 每个词的字符串也要留一份：签名最后要交回「词」，比对时只需要编号。
  const words = []
  // 每个节点的词表存成 Int32Array（编号）。签名阶段因此不必再对每个词做一次
  // 字符串哈希——5 万条库上 367 万个词次，那就是 780ms 里免掉的一大半。
  const idsOf = new Map()
  let wordCount = 0
  let cap = 1 << 12
  let dfCount = new Int32Array(cap)
  for (const n of memories) {
    let set = toks.get(n.id)
    if (!(set instanceof Set)) set = new Set(set)
    const ids = new Int32Array(set.size)
    let k = 0
    for (const t of set) {
      let id = wordId.get(t)
      if (id === undefined) {
        id = wordCount++
        wordId.set(t, id)
        words[id] = t
        if (id >= cap) {
          cap = cap << 1
          const bigger = new Int32Array(cap)
          bigger.set(dfCount)
          dfCount = bigger
        }
      }
      dfCount[id] += 1
      ids[k++] = id
    }
    idsOf.set(n.id, ids)
    if ((++slice & 2047) === 0) yield 'df'
  }
  mark('df')
  const sig = new Map()
  const sigSets = new Map()
  // ② 签名：每个节点只要「最稀有的 24 个词」。
  //    旧写法把整份词表排一次序（每节点 50–100 次比较，每次两次 Map 查表），
  //    5 万条库上 1,684ms。改成 24 个位置的有界插入：比当前第 24 名还常见就直接跳过。
  //    平局按 Set 的迭代顺序排在后面 —— 和 Array#sort（V8 稳定排序）的结果一致。
  const SIG_N = 24
  for (const n of memories) {
    const ids = idsOf.get(n.id)
    const pickC = []
    const pickI = []
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]
      // 「«短语»」是整段 CJK 短词，相似度不该看它（旧实现也是先滤掉再挑）。
      if (words[id].charCodeAt(0) === 171) continue
      const c = dfCount[id]
      if (c <= 1) continue
      if (pickC.length === SIG_N && c >= pickC[SIG_N - 1]) continue
      let i = pickC.length
      pickC.push(c)
      pickI.push(id)
      while (i > 0 && pickC[i - 1] > c) {
        pickC[i] = pickC[i - 1]
        pickI[i] = pickI[i - 1]
        i--
      }
      pickC[i] = c
      pickI[i] = id
      if (pickC.length > SIG_N) {
        pickC.length = SIG_N
        pickI.length = SIG_N
      }
    }
    const sigWords = pickI.map((wid) => words[wid])
    sig.set(n.id, sigWords)
    // 每对候选都 new Set 一次是 1 万条库上重复检测的主要开销；每个节点只建一次，
    // 之后所有比较都直接 has()。
    sigSets.set(n.id, new Set(sigWords))
    if ((++slice & 2047) === 0) yield 'sig'
  }

  mark('sig')
  mark('tokens+df+sig')
  // 重复检测两段，缺一段就会漏：
  //   ① 正文一字不差的分桶（O(n)）——同一段记忆被抄进几个工作区是最常见的重复形态，
  //      而这类副本共享的词在库里出现几百次，靠倒排反而容易漏；
  //   ② 近似重复用「稀有词倒排 → 共享数下界 → Jaccard」。
  //
  // 5 万条库上实测：旧写法 907 万次候选迭代、去重后 58 万对，每对都真的算 24 词 Jaccard，
  // 还要为每一对拼一个 "a\0b" 字符串键——这一段占体检九成。两处改动都不损召回：
  //   · 候选对用下标数值做键（i * base + j），不再分配字符串；
  //   · 先数这对共享了多少词，连 Jaccard 阈值需要的下界都够不着就不算 Jaccard。
  //     need 是按两边签名长度算出来的，共享数不到 need 就一定过不了 0.86。
  //
  // 抽样上限（这是 O(n²) 不可行的原因，写在这里免得下次又以为是全对）：
  // 每个词最多进 60 条进倒排、每个正文桶最多取前 60 条。
  const POST_CAP = 60
  const BUCKET_MAX = 60
  const base = memories.length
  const idx = new Map()
  for (let i = 0; i < memories.length; i++) idx.set(memories[i].id, i)

  const bucket = new Map()
  for (let i = 0; i < memories.length; i++) {
    const body = (memories[i].content || '').trim()
    if (body.length < 24) continue
    let arr = bucket.get(body)
    if (!arr) bucket.set(body, (arr = []))
    if (arr.length < BUCKET_MAX) arr.push(i)
    if ((++slice & 2047) === 0) yield 'dup'
  }
  const exact = new Set()
  for (const [, ids] of bucket) {
    if (ids.length < 2) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) exact.add(ids[i] * base + ids[j])
    }
    if ((++slice & 511) === 0) yield 'dup'
  }
  mark('dup-exact')

  const post = new Map()
  for (const n of memories) {
    for (const t of sig.get(n.id) || []) {
      let arr = post.get(t)
      if (!arr) post.set(t, (arr = []))
      if (arr.length < POST_CAP) arr.push(idx.get(n.id))
    }
    if ((++slice & 2047) === 0) yield 'postings'
  }
  mark('postings')

  const shared = new Map()
  for (const [, ids] of post) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = ids[i] < ids[j] ? ids[i] * base + ids[j] : ids[j] * base + ids[i]
        if (exact.has(key)) continue
        shared.set(key, (shared.get(key) || 0) + 1)
      }
    }
    if ((++slice & 1023) === 0) yield 'dup'
  }
  mark('dup-count')

  const dupPairs = []
  for (const key of exact) {
    const ia = Math.floor(key / base)
    const ib = key - ia * base
    const na = memories[ia]
    const nb = memories[ib]
    if (na && nb) dupPairs.push({ a: na.id, b: nb.id, j: 1 })
  }
  // 试过在这之前加一道「共享词数够不着阈值就别算 Jaccard」的预筛：倒排每条只留
  // 60 条，共享词会被截断，`inter` 是低估，于是真重复被判成无关（5 万条实测漏 8.8 万对）。
  // 无损的提速只有上面那两条：数值键、正文分桶。
  for (const key of shared.keys()) {
    const ia = Math.floor(key / base)
    const ib = key - ia * base
    const na = memories[ia]
    const nb = memories[ib]
    if (!na || !nb) continue
    const la = (na.content || '').length
    const lb = (nb.content || '').length
    if (Math.min(la, lb) / Math.max(1, Math.max(la, lb)) < 0.6) continue
    const j2 = hyJaccardAtLeast(sigSets.get(na.id), sigSets.get(nb.id), 0.86)
    if ((++slice & 4095) === 0) yield 'dup'
    if (j2 > 0) dupPairs.push({ a: na.id, b: nb.id, j: j2 })
  }
  mark('dup-pairs')
  dupPairs.sort((x, y) => y.j - x.j)

  // 阈值不写死：跟这批记忆的实际体量比，取「最重的 3%」，但不低于 1200 字
  const lens = memories.map((m) => (m.content || '').length).sort((a, b) => a - b)
  const overLimit = Math.max(600, lens[Math.floor(lens.length * 0.97)] || 600)
  const oversizeAll = memories
    .filter((n) => (n.content || '').length > overLimit)
    .sort((a, b) => (b.content || '').length - (a.content || '').length)
  const oversize = oversizeAll
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
    // 先把工作区按 updatedAt 从新到旧排一遍，再建倒排：倒排表天生就是有序的。
    // 旧写法在建完倒排之后对**每个关键词**各排一次序（每张表还要按 updatedAt 重排几千条），
    // 5 万条库上这部分占了 stale 那一秒里的三分之一。等价性：原来每张表的降序排列，
    // 与「按 updatedAt 降序遍历、依次 push」得到的顺序一致（同 updatedAt 时保持原顺序）。
    const ordered = [...list].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
    const kwPost = new Map()
    const kwSets = new Map()
    for (const m of ordered) {
      const kws = kwOf(m)
      kwSets.set(m.id, new Set(kws))
      for (const k of kws) {
        let arr = kwPost.get(k)
        if (!arr) kwPost.set(k, (arr = []))
        arr.push(m)
      }
    }
    for (const n of list) {
      if ((++slice & 2047) === 0) yield 'stale'
      const ageDays = (now - (n.updatedAt || n.createdAt || now)) / DAY
      if (ageDays < 14) continue
      const kws = kwOf(n)
      // 要「3 个共同关键词」才对得上：先把 n 的词按倒排链长（≈全局稀有度）从短到长排，
      // 只在前 |kws|-2 个词里找候选就够了 —— 若某个 m 与 n 共享 ≥3 个词，那 3 个词不可能
      // 全落在最后 2 个位置。这一步把 5 万条库上的候选从几十万压到 4 万，stale 段 910ms → 328ms。
      if (kws.length < 3) continue
      const prefix = kws
        .map((k) => ({ k, len: (kwPost.get(k) || []).length }))
        .sort((a, b) => a.len - b.len)
        .slice(0, kws.length - 2)
      let cover = null
      const seen = new Set()
      for (const { k } of prefix) {
        for (const m of kwPost.get(k) || []) {
          if ((m.updatedAt || 0) <= (n.updatedAt || 0)) break
          if (m.id === n.id || seen.has(m.id)) continue
          seen.add(m.id)
          if ((m.importance || 0) < (n.importance || 0)) continue
          if (overlapAtLeast(kwSets.get(m.id), kws, 3)) {
            cover = m
            break
          }
        }
        if (cover) break
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
  // 「该更新了」在 2 万条的库里能有一万多条：全塞进 /overview 会让首屏多出 4.5MB，
  // 而界面一次只显示前 5 条。所以列表截到 HY_MAX，计数用下面的全量数字。
  const staleTotal = stale.length
  if (stale.length > HY_MAX) stale.length = HY_MAX

  mark('stale')
  const unreadAll = memories
    .filter((n) => !n.hits && (now - (n.createdAt || now)) / DAY > 3 && n.status === 'active')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  const unread = unreadAll
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
  const thinTotal = thin.length
  if (thin.length > HY_MAX) thin.length = HY_MAX

  mark('thin')
  const orphanAll = memories
    .filter((n) => !(cnt.get(n.id) || 0))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
  const orphan = orphanAll
    .slice(0, HY_MAX)
    .map((n) => ({ id: n.id, label: n.label, ws: n.wsTitle, level: n.level, importance: n.importance || 0 }))

  const dup = dupPairs.slice(0, HY_MAX).map((p) => ({
    a: { id: p.a, label: byId.get(p.a)?.label || '', ws: byId.get(p.a)?.wsTitle || '' },
    b: { id: p.b, label: byId.get(p.b)?.label || '', ws: byId.get(p.b)?.wsTitle || '' },
    sim: Number(p.j.toFixed(3)),
  }))

  const items = { dup, oversize, stale, unread, thin, orphan }
  // 计数用「全部命中」，列表只留前 HY_MAX 条：payload 有上限，数字不失真。
  const full = {
    dup: dupPairs.length,
    oversize: oversizeAll.length,
    stale: staleTotal,
    unread: unreadAll.length,
    thin: thinTotal,
    orphan: orphanAll.length,
  }
  const counts = {}
  const shown = {}
  let total = 0
  let totalShown = 0
  for (const k of Object.keys(items)) {
    counts[k] = full[k] || 0
    shown[k] = items[k].length
    total += counts[k]
    totalShown += shown[k]
  }
  mark('orphan')
  if (profile) console.error('[hygiene]', laps.map(([n, t]) => `${n}:${t}ms`).join(' '))
  return { generatedAt: now, counts, shown, total, totalShown, items, meta: HYGIENE_META }
}
