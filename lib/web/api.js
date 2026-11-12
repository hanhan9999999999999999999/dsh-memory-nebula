/* 记忆星图 —— API 客户端
 *
 * 默认打宿主自己的 /api/memory-nebula（同源）。
 * 宿主进程如果还跑着旧代码（/ping 里没有 build 指纹），页面会自动切到
 * 本机的独立引擎 http://127.0.0.1:7890 —— 这样不用重启 DSH 也能用最新算法。
 */
;(function () {
  // 口令只用于第一次换取 cookie；换完就从地址栏/历史里拿掉，避免截图或 shell 历史泄露。
  try {
    const here = new URL(location.href)
    if (here.searchParams.has('token')) {
      here.searchParams.delete('token')
      history.replaceState(null, '', here.pathname + (here.search ? here.search : '') + here.hash)
    }
  } catch {}
  'use strict'
  /** 中文即源文：英文模式查 i18n.js 的表，查不到就原样返回中文。 */
  const T = (zh, vars) => (window.NebulaI18n ? window.NebulaI18n.t(zh, vars) : zh)
  const DEFAULT_BASE = '/api/memory-nebula'
  const FALLBACK_BASE = 'http://127.0.0.1:7890'
  let BASE = DEFAULT_BASE
  /** 选中的那条腿的 /ping 元信息（版本、构建、能力清单、模式）。 */
  let META = null

  // 离线快照：导出的单个 HTML 会先把数据塞进 window.__NEBULA_SNAPSHOT__。
  // 一旦有它，客户端就不再发网络请求 —— 双击文件也能看、搜索、点开节点。
  const SNAP = typeof window !== 'undefined' ? window.__NEBULA_SNAPSHOT__ : null
  const IS_SNAPSHOT = Boolean(SNAP && SNAP.graph && Array.isArray(SNAP.graph.nodes))

  // 示例星系：数据在服务器内存里（不读盘、不写盘），每个请求带 demo=1。
  let DEMO = false

  // 允许 ?api=http://127.0.0.1:7890 手动指定
  const forced = new URL(location.href).searchParams.get('api')
  if (forced) BASE = forced.replace(/\/$/, '')

  function url(path, params) {
    const u = /^https?:/.test(BASE)
      ? new URL(BASE + path)
      : new URL(BASE + path, location.origin)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v)
      }
    }
    return u
  }

  // 请求不能无限等：宿主卡住、引擎半死时，人至少能看到「超时」而不是一直转。
  // 12s 也是首屏失败的判据——超过它就算这一路不通，交给失败态与换腿。
  const TIMEOUT_MS = 12000

  async function request(u, init) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(u, Object.assign({ signal: ctl.signal }, init))
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + u.pathname)
      return await res.json()
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 20)) {
        throw new Error(T('请求超时（') + TIMEOUT_MS / 1000 + 's）：' + u.pathname)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  function get(path, params) {
    return request(url(path, params), { headers: { accept: 'application/json' } })
  }

  function post(path, body) {
    return request(url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
  }

  /** 探测两条腿的构建时间，取代码更新的那一条（宿主没重启就自动用独立引擎）。 */
  async function resolveBase() {
    if (IS_SNAPSHOT) {
      META = snapPing()
      return BASE
    }
    const probe = async (base) => {
      try {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 3000)
        let res
        try {
          res = await fetch(base + '/ping', { headers: { accept: 'application/json' }, signal: ctl.signal })
        } finally {
          clearTimeout(timer)
        }
        if (!res.ok) return null
        const meta = await res.json()
        if (!meta || typeof meta.build !== 'number') return null
        return { base, build: meta.build, meta }
      } catch {
        return null
      }
    }
    if (forced) {
      META = (await probe(BASE))?.meta || null
      return BASE
    }
    // 独立引擎自己的页面：同源已是 standalone，没必要再去敲宿主 7890 的门（浏览器会在控制台记一条连接失败）。
    const host = await probe(DEFAULT_BASE)
    if (host && host.meta.mode === 'standalone') {
      BASE = DEFAULT_BASE
      META = host.meta
      return BASE
    }
    const side = await probe(FALLBACK_BASE)
    // 两边都能用就选新的：宿主往往还跑着安装那一刻加载的旧代码
    let picked
    if (host && side) picked = side.build > host.build ? side : host
    else picked = host || side || null
    BASE = picked ? picked.base : DEFAULT_BASE
    META = picked ? picked.meta : null
    return BASE
  }

  // v2 的图用「节点下标」传边（省 600KB+），这里还原成 id，下游代码完全不用改。
  // 幂等：已经展开过的图原样返回，所以可以放心在多层重复调用。
  function normalizeGraph(g) {
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges) || !g.edges.length) return g
    const e0 = g.edges[0]
    if (typeof e0.a === 'number' || typeof e0.a === 'string') return g
    if (typeof e0.s !== 'number' || typeof e0.d !== 'number') return g
    const ids = g.nodes.map((n) => n.id)
    g.edges = g.edges.map((e) => ({ a: ids[e.s], b: ids[e.d], w: e.w, t: e.t, curated: e.curated, why: e.why }))
    return g
  }

  /** 示例模式下所有请求都带 demo=1；快照模式没有请求，原样返回。 */
  function modeParams(params) {
    if (!DEMO || IS_SNAPSHOT) return params
    return Object.assign({ demo: 1 }, params)
  }

  /** 快照里没有写接口：明确报一句人话，调用方会把它当普通错误提示出来。 */
  function snapshotNo(what) {
    if (!IS_SNAPSHOT) return false
    throw new Error(T('这是一份离线快照，「') + what + T('」不可用；回到 DSH 里打开实时星图即可'))
  }

  /* ---------------- 离线快照的本地引擎 ---------------- */
  // 大快照的节点与边按列存（省掉重复键名），这里展开成对象。
  function expandSnapshotNodes(g) {
    if (!g || !Array.isArray(g.nodeColumns) || !Array.isArray(g.nodes) || !g.nodes.length) return g
    if (!Array.isArray(g.nodes[0])) return g
    const cols = g.nodeColumns
    g.nodes = g.nodes.map((row) => {
      const node = {}
      for (let i = 0; i < cols.length; i++) if (row[i] !== null) node[cols[i]] = row[i]
      return node
    })
    delete g.nodeColumns
    return g
  }

  function expandSnapshotEdges(g) {
    if (!g || !Array.isArray(g.edgeColumns) || !Array.isArray(g.edges) || !g.edges.length) return g
    if (!Array.isArray(g.edges[0])) return g
    const cols = g.edgeColumns
    g.edges = g.edges.map((row) => {
      const e = {}
      for (let i = 0; i < cols.length; i++) if (row[i] !== null) e[cols[i]] = row[i]
      return e
    })
    delete g.edgeColumns
    return g
  }

  let snapCache = null
  function snapData() {
    if (snapCache) return snapCache
    const graph = normalizeGraph(expandSnapshotEdges(expandSnapshotNodes(SNAP.graph)))
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const adj = new Map()
    for (const e of graph.edges || []) {
      if (!e || e.a == null || e.b == null) continue
      if (!byId.has(e.a) || !byId.has(e.b)) continue
      let la = adj.get(e.a)
      if (!la) adj.set(e.a, (la = []))
      la.push({ e, other: byId.get(e.b) })
      let lb = adj.get(e.b)
      if (!lb) adj.set(e.b, (lb = []))
      lb.push({ e, other: byId.get(e.a) })
    }
    snapCache = { graph, byId, adj }
    return snapCache
  }

  function snapPing() {
    const g = SNAP.graph
    return {
      ok: true,
      snapshot: true,
      version: SNAP.version || 'snapshot',
      build: SNAP.build || 0,
      startedAt: SNAP.builtAt || 0,
      mode: 'snapshot',
      capabilities: [],
      sig: SNAP.sig || 'snapshot',
      builtAt: SNAP.builtAt || g.builtAt || 0,
      stats: g.stats || {},
      buildMs: g.buildMs || 0,
      error: '',
    }
  }

  function snapNode(id) {
    const { byId, adj } = snapData()
    const node = byId.get(id)
    if (!node) return null
    const list = (adj.get(id) || []).slice().sort((x, y) => (y.e.w || 0) - (x.e.w || 0))
    const neighbors = list.map(({ e, other }) => ({
      id: other.id,
      label: other.label || other.title,
      ws: other.wsTitle || other.ws,
      level: other.level,
      importance: other.importance,
      type: e.t,
      weight: e.w,
      why: Array.isArray(e.why) ? e.why : e.why ? [String(e.why)] : [],
    }))
    return { node, neighbors, degree: neighbors.length, cluster: node.cluster != null ? node.cluster : null }
  }

  function snapRecall(query, opts) {
    const { graph } = snapData()
    const q = String(query || '').trim()
    const limit = Math.max(1, Math.min(50, Number(opts && opts.limit) || 12))
    if (!q) return { query: '', seeds: [], unknown: [], hits: [], scanned: graph.nodes.length }
    const terms = q
      .toLowerCase()
      .split(/[\s,，。；;、·|/]+/)
      .filter((t) => t.length >= 2)
      .slice(0, 6)
    const needle = q.toLowerCase()
    const hits = []
    for (const n of graph.nodes) {
      const title = String(n.title || n.label || '').toLowerCase()
      const content = String(n.content || n.preview || '').toLowerCase()
      const kws = (n.keywords || []).map((k) => String(k).toLowerCase())
      let score = 0
      const why = []
      if (title.includes(needle)) {
        score += 5
        why.push(T('标题命中'))
      }
      for (const t of terms) {
        if (kws.some((k) => k === t || k.includes(t))) {
          score += 2.5
          why.push(T('关键词「') + t + '」')
        } else if (title.includes(t)) {
          score += 2
          why.push(T('标题含「') + t + '」')
        }
        if (content.includes(t)) score += 0.8
      }
      if (score <= 0) continue
      hits.push({
        id: n.id,
        uid: String(n.id).split(':').pop(),
        ws: n.wsTitle || n.ws,
        level: n.level,
        label: n.label,
        title: n.title,
        preview: String(n.preview || n.content || '').slice(0, 220),
        importance: n.importance,
        project: n.project,
        status: n.status,
        keywords: (n.keywords || []).slice(0, 8),
        score: Math.round(Math.min(1, score / 8) * 1000) / 1000,
        direct: 1,
        spread: 0,
        why: why.slice(0, 2).join(' · ') || T('内容命中'),
        across: false,
        chain: [],
      })
    }
    hits.sort((a, b) => b.score - a.score)
    return { query: q, seeds: [], unknown: [], hits: hits.slice(0, limit), scanned: graph.nodes.length }
  }

  function snapPath(a, b, hops) {
    const { graph, byId, adj } = snapData()
    const maxHops = Math.max(1, Math.min(8, Number(hops) || 6))
    if (!byId.has(a) || !byId.has(b)) return { found: false, error: T('找不到这两个节点：') + a + ' / ' + b }
    const dist = new Map([[a, 0]])
    const prev = new Map()
    const queue = [a]
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]
      if (cur === b) break
      const d = dist.get(cur)
      if (d >= maxHops) continue
      for (const { e, other } of adj.get(cur) || []) {
        if (dist.has(other.id)) continue
        dist.set(other.id, d + 1)
        prev.set(other.id, { from: cur, e })
        queue.push(other.id)
      }
    }
    if (!dist.has(b)) return { found: false, hops: 0, score: 0 }
    const ids = [b]
    const edges = []
    let cur = b
    while (cur !== a) {
      const p = prev.get(cur)
      if (!p) return { found: false, hops: 0, score: 0 }
      edges.push({
        a: p.from,
        b: cur,
        w: p.e.w,
        t: p.e.t,
        why: Array.isArray(p.e.why) ? p.e.why.join(' · ') : p.e.why || '',
      })
      cur = p.from
      ids.push(cur)
    }
    ids.reverse()
    edges.reverse()
    const score = edges.reduce((acc, e) => acc * (e.w || 1), 1)
    const field = (n) => ({ id: n.id, label: n.label || n.title, level: n.level, ws: n.wsTitle || n.ws, importance: n.importance, kind: n.kind })
    return {
      found: true,
      hops: edges.length,
      score: Math.round(score * 1000) / 1000,
      nodes: ids.map((id) => field(byId.get(id))),
      edges,
    }
  }

  function snapOverview() {
    if (SNAP.overview) return SNAP.overview
    const g = SNAP.graph
    return { stats: g.stats || {}, workspaces: [], inventory: SNAP.inventory || {}, hygiene: null }
  }

  window.NebulaAPI = {
    get base() {
      return BASE
    },
    /** 当前 base 的版本/构建/能力清单；没探测过就是 null。 */
    get meta() {
      return META
    },
    /** 这个页面是不是一份离线快照（没有后端，全部靠内嵌数据）。 */
    get snapshot() {
      return IS_SNAPSHOT
    },
    /** 现在看的是不是示例星系。 */
    get demo() {
      return DEMO
    },
    /** 进 / 出示例星系。返回切换后的状态。 */
    setDemo(on) {
      DEMO = Boolean(on)
      return DEMO
    },
    resolveBase,
    /** 图的形状收口：所有拿到整图的地方都过它（幂等，重复调用无害）。 */
    normalizeGraph,
    /** 当前 base 挂了就试着换一条腿（宿主 ↔ 独立引擎）。变了返回 true。 */
    async failover() {
      if (forced || IS_SNAPSHOT) return false
      const other = BASE === FALLBACK_BASE ? DEFAULT_BASE : FALLBACK_BASE
      try {
        const res = await fetch(other + '/ping', { headers: { accept: 'application/json' } })
        if (!res.ok) return false
        const meta = await res.json()
        if (!meta || typeof meta.build !== 'number') return false
        BASE = other
        META = meta
        return true
      } catch {
        return false
      }
    },
    graph: (opts) =>
      IS_SNAPSHOT
        ? Promise.resolve(normalizeGraph(SNAP.graph))
        : get('/graph', modeParams(opts)).then(normalizeGraph),
    ping: () => (IS_SNAPSHOT ? Promise.resolve(snapPing()) : get('/ping', modeParams())),
    node: (id) => (IS_SNAPSHOT ? Promise.resolve(snapNode(id)) : get('/node', modeParams({ id }))),
    recall: (q, opts) => (IS_SNAPSHOT ? Promise.resolve(snapRecall(q, opts)) : get('/recall', modeParams(Object.assign({ q }, opts)))),
    path: (a, b, hops) => (IS_SNAPSHOT ? Promise.resolve(snapPath(a, b, hops)) : get('/path', modeParams({ a, b, hops }))),
    overview: () => (IS_SNAPSHOT ? Promise.resolve(snapOverview()) : get('/overview', modeParams())),
    mutes: () => (IS_SNAPSHOT ? Promise.resolve({ mutes: [] }) : get('/mutes', modeParams())),
    link: (a, b, note) => snapshotNo(T('连线')) || post('/link', { a, b, note }),
    unlink: (a, b) => snapshotNo(T('断线')) || post('/unlink', { a, b }),
    mute: (a, b, note) => snapshotNo(T('屏蔽')) || post('/mute', { a, b, note }),
    unmute: (a, b) => snapshotNo(T('解除屏蔽')) || post('/unmute', { a, b }),
    // 重建也返回整张图，必须走同一条展开路径——否则 v2 的 {s,d} 下标边会原样流到渲染层，
    // 下游按 e.a/e.b 找节点全部落空，表现就是「点重建后连线全没了」（真实踩过的坑）。
    refresh: () => snapshotNo(T('重建')) || post('/refresh', {}).then(normalizeGraph),
  }
})()
