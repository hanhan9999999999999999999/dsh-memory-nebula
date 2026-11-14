/**
 * 星图的状态机：发现来源 → 只读抽取 → 建图 → 缓存 → 广播变更。
 *
 * 这里对「别的插件的文件」只做三件事：stat、readFile、SQLite 只读打开。
 * 没有写操作，没有迁移，没有 mark。
 */
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readInventory, nebulaHome, dshHome } from './sources.js'
import { discoverSources, scanAll, probeAll, adapterCatalog } from './adapters/index.js'
import { appendIngest } from './adapters/ingest.js'
import { buildGraph, findNode, auditHygiene } from './graph.js'
import { recall, resolveIds } from './recall.js'
import { bridge as bridgeFn } from './bridge.js'
import { readLedger, markSeen, readCooldown, markCooldown, ledgerStats } from './ledger.js'
import {
  addLink,
  listLinks,
  logEvent,
  removeLink,
  cacheGet,
  cacheSet,
  getMeta,
  setMeta,
  addMute,
  listMutes,
  removeMute,
} from './store.js'
import { clip, hueOf, tokenize } from './text.js'
import { DEMO_MEMORIES, DEMO_LEDGERS, DEMO_MANUAL, DEMO_INVENTORY, DEMO_SOURCES, DEMO_SIGNATURE } from './demo.js'

/** HSL → #rrggbb（固定的 72%/62% 亮度，保证深空里够亮又不刺眼）。 */
function hslHex(hue, sat = 72, light = 62) {
  const h = ((hue % 360) + 360) % 360
  const s = sat / 100
  const l = light / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return '#' + to(r) + to(g) + to(b)
}

/** 扫描默认根：常见的工作区父目录（用来抓注册表漏掉的项目）。 */
function defaultRoots() {
  const roots = []
  const seen = new Set()
  const candidates = [join(homedir(), 'Documents'), join(homedir(), 'document'), process.cwd()]
  for (const c of candidates) {
    try {
      if (!c || seen.has(c)) continue
      seen.add(c)
      if (existsSync(c)) roots.push(c)
    } catch {
      /* ignore */
    }
  }
  return roots
}

/** 找不到节点时抛的错误：带 404，接口层才不会把它当服务器故障。 */
function missingNodes(a, b) {
  const err = new Error('找不到这两条记忆：' + a + ' / ' + b)
  err.status = 404
  return err
}

export class Nebula extends EventEmitter {
  constructor(options = {}) {
    super()
    // 两个调用方各用一套名字：宿主用 logger，独立引擎 CLI 用 log；roots 同理。
    // 以前只认 logger/extraRoots，`node lib/standalone.mjs --root D:/x` 的根目录被静默忽略。
    this.logger = options.logger || (typeof options.log === 'function' ? { info: options.log } : null)
    const extra = Array.isArray(options.extraRoots) ? options.extraRoots : Array.isArray(options.roots) ? options.roots : []
    this.roots = extra.length > 0 ? extra : defaultRoots()
    /**
     * 演示模式：不读任何真实库，用 lib/host/demo.js 的内置数据建同一张图。
     * 走的是完全相同的 buildGraph / detail / recall / path 代码路径，
     * 这样「示例里能用的功能」和「真实库里的功能」不会分叉。
     */
    this.demo = Boolean(options.demo)
    this.stores = []
    this.nodes = []
    this.ledgers = []
    this.inventory = { plugins: [], skills: [], mcp: [] }
    this.graph = { nodes: [], edges: [], clusters: [], stats: { nodes: 0, edges: 0 }, builtAt: 0 }
    this.signature = ''
    this.building = false
    /** 正在等这一轮建图的调用方：冷启动时并发请求不该拿到一张空图。 */
    this._waiters = []
    this.lastError = ''
    this.lastBuildMs = 0
    this.timer = null
  }

  /** 写一条日志到 $DSH_HOME/memory-nebula/nebula.log（不污染宿主日志）。 */
  log(line) {
    const text = `[${new Date().toISOString()}] ${line}\n`
    try {
      const dir = nebulaHome()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'nebula.log'), text, { flag: 'a' })
    } catch {
      /* ignore */
    }
    try {
      this.logger?.info?.(`[memory-nebula] ${line}`)
    } catch {
      /* ignore */
    }
  }

  /**
   * 变化指纹：来源库的 size+mtime、会话账本目录的条目数、人工边数量。
   * 只要这些没变，就不重建图（重建一次约几百毫秒）。
   */
  computeSignature() {
    if (this.demo) {
      this.stores = DEMO_SOURCES
      return DEMO_SIGNATURE
    }
    const { stores } = discoverSources({ extraRoots: this.roots })
    this.stores = stores
    const parts = []
    for (const store of stores) {
      parts.push(`${store.id}:${store.size}:${Math.round(store.mtimeMs || 0)}`)
      if (!store.sessionsDir) continue
      try {
        const names = readdirSync(store.sessionsDir)
        let latest = 0
        for (const name of names) {
          if (!name.endsWith('.json')) continue
          try {
            latest = Math.max(latest, Math.round(statSync(join(store.sessionsDir, name)).mtimeMs))
          } catch {
            /* ignore */
          }
        }
        parts.push(`s${names.length}:${latest}`)
      } catch {
        parts.push('s0:0')
      }
    }
    let linkSig = ''
    try {
      const links = listLinks()
      linkSig = `l${links.length}:${links[0]?.updatedAt || 0}`
    } catch {
      linkSig = 'l0:0'
    }
    const invSig = `${this.inventory?.skills?.length || 0}:${this.inventory?.plugins?.length || 0}:${this.inventory?.mcp?.length || 0}`
    return parts.join('|') + '|' + linkSig + '|' + invSig
  }

  /**
   * 建图后一次性建好的查找索引。
   *
   * 之前 `detail()` 里每次 `graph.nodes.find(...)`，一次点击在 1300 条记忆上是
   * O(deg·n) 的线性扫；邻居多的节点能扫出几十万次比较。这里全部换成 Map 直取，
   * 另外把邻接表建好，详情面板不用再遍历整张边表。
   */
  #buildIndex() {
    const g = this.graph
    const byId = new Map()
    const byI = new Map()
    const byUid = new Map()
    const adj = new Map()
    for (const n of g.nodes) {
      byId.set(n.id, n)
      byI.set(n.i, n)
      const uid = String(n.id).split(':').pop()
      if (!byUid.has(uid)) byUid.set(uid, n)
    }
    for (const e of g.edges) {
      let a = adj.get(e.s)
      if (!a) adj.set(e.s, (a = []))
      a.push({ n: e.t, w: e.w, t: e.type, why: e.why, curated: e.curated })
      let b = adj.get(e.t)
      if (!b) adj.set(e.t, (b = []))
      b.push({ n: e.s, w: e.w, t: e.type, why: e.why, curated: e.curated })
    }
    for (const list of adj.values()) list.sort((x, y) => y.w - x.w)
    const rawById = new Map()
    for (const n of this.nodes || []) if (!rawById.has(n.id)) rawById.set(n.id, n)
    this.index = { byId, byI, byUid, adj, rawById }
    // 详情面板的两处「贵操作」加内存缓存：会话转写解码（zstd）与 sidecar 证据读库。
    // 不缓存的话，连点 50 条记忆要 1.5 秒；缓存后只在首次访问时付一次代价。
    this._originCache = new Map()
    this._evCache = new Map()
  }

  /**
   * 动态加载「可选」引擎模块（会话转写、路径搜索）。
   * 热载目录里可能还没有这些新文件，缺了就让对应功能优雅缺席。
   */
  async #loadOptionalModules() {
    if (!this._originOfMemory) {
      try {
        const m = await import('./transcripts.js')
        this._originOfMemory = m.originOfMemory
        this._transcriptStats = m.transcriptStats
        this._usageOf = m.usageOf
      } catch {
        this._originOfMemory = null
      }
    }
    if (!this._findPath) {
      try {
        const m = await import('./path.js')
        this._findPath = m.findPath
      } catch {
        this._findPath = null
      }
    }
  }

  /**
   * 重建星图。返回是否真的重建了。
   * @param {{force?:boolean}} [opts]
   */
  async refresh(opts = {}) {
    if (this.building) {
      // 等这一轮建完再返回：以前并发请求直接拿到 false + 一张空图，首屏偶尔一片黑。
      await new Promise((resolve) => this._waiters.push(resolve))
      return false
    }
    this.building = true
    const started = Date.now()
    try {
      // 引擎文件是逐个复制的（热载），新模块可能还没到位 —— 用动态 import 兜住，
      // 缺了就退化成「没有出处 / 没有路径」，而不是整个引擎加载失败。
      await this.#loadOptionalModules()
      const signature = this.computeSignature()
      if (!opts.force && signature === this.signature && this.graph.nodes.length > 0) {
        return false
      }

      // 适配器层统一扫描：meow / 笔记 / 任意 SQLite / 外部推送，每种都可能多个库。
      // 单个库读坏只记一条错误，不影响其它来源。
      // 演示模式换一套内置节点，后面的建图、索引、详情、检索全部复用。
      const scanned = this.demo ? { nodes: DEMO_MEMORIES, ledgers: DEMO_LEDGERS, errors: [] } : scanAll(this.stores)
      const nodes = scanned.nodes
      const ledgers = scanned.ledgers || []
      for (const err of scanned.errors || []) {
        this.lastError = `${err.store || err.adapter || '来源'} 读取失败：${err.error}`
        this.log(this.lastError)
      }

      this.inventory = this.demo ? DEMO_INVENTORY : readInventory()
      this.nodes = nodes
      this.ledgers = ledgers

      const manual = this.demo ? DEMO_MANUAL : listLinks().map((x) => ({ a: x.a, b: x.b, note: x.note }))
      const mutes = this.demo ? [] : listMutes().map((x) => ({ a: x.a, b: x.b }))
      const graph = buildGraph({ nodes, ledgers, manual, mutes, inventory: this.inventory })
      graph.muteCount = mutes.length
      graph.inventory = this.inventory
      graph.sources = this.stores.map((s) => ({
        key: s.key,
        id: s.id,
        adapter: s.adapter,
        provider: s.provider,
        title: s.title,
        path: s.path,
        size: s.size,
        db: s.dbPath,
      }))
      this.graph = graph
      this.#buildIndex()
      this.signature = signature
      this.lastBuildMs = Date.now() - started
      this.lastError = ''
      if (!this.demo)
        try {
          cacheSet('graph', {
            builtAt: graph.builtAt,
            stats: graph.stats,
            builtMs: this.lastBuildMs,
          })
          setMeta('lastBuiltAt', String(graph.builtAt))
        } catch {
          /* ignore */
        }
      this.log(
        `重建完成：${graph.nodes.length} 条记忆 / ${graph.edges.length} 条关联 / ${graph.stats.workspaces} 个工作区 / ${this.lastBuildMs}ms${this.demo ? '（示例）' : ''}`,
      )
      if (!this.demo) logEvent('graph.rebuild', { nodes: graph.nodes.length, edges: graph.edges.length, ms: this.lastBuildMs })
      // 写入时挂证据：新长出来的记忆，第一次建图就把「它凭什么连上别人」算好存进 sidecar，
      // 以后开详情直接读缓存（也不必再现场算一遍）。
      if (!this.demo)
        try {
        const seenAt = Number(getMeta('evidenceAt', '0')) || 0
        const adj = new Map()
        for (const e of graph.edges) {
          const w = e.w || 0
          for (const [self, other] of [
            [e.s, e.t],
            [e.t, e.s],
          ]) {
            let arr = adj.get(self)
            if (!arr) adj.set(self, (arr = []))
            arr.push({ n: other, w, t: e.type, why: e.why })
          }
        }
        let added = 0
        const byIdx = new Map(graph.nodes.map((x) => [x.i, x]))
        for (const n of graph.nodes) {
          if (n.level === 'source') continue
          if ((n.createdAt || 0) <= seenAt) continue
          const list = (adj.get(n.i) || []).sort((a, b) => b.w - a.w).slice(0, 3)
          cacheSet('ev:' + n.id, {
            at: Date.now(),
            edges: list.map((e) => ({
              id: byIdx.get(e.n)?.id || '',
              label: clip(byIdx.get(e.n)?.label || '', 48),
              type: e.t,
              w: Math.round(e.w * 100) / 100,
              why: e.why,
            })),
          })
          added++
          if (added > 400) break
        }
        if (added) setMeta('evidenceAt', String(graph.builtAt))
      } catch {
        /* 缓存失败不影响建图 */
      }
      this.emit('updated', { builtAt: graph.builtAt, stats: graph.stats })
      return true
    } catch (err) {
      this.lastError = err?.stack || String(err)
      this.log('重建失败：' + this.lastError)
      return false
    } finally {
      this.building = false
      for (const wake of this._waiters.splice(0)) wake()
    }
  }

  /** 轻量轮询：只 stat，不重建；有变化才重建。 */
  startWatching(intervalMs = 15000) {
    if (this.timer) return
    if (this.demo) return // 示例数据是常量，没有「文件变化」可看
    const tick = async () => {
      try {
        if (this.building) return
        const sig = this.computeSignature()
        if (sig !== this.signature) await this.refresh({ force: true })
      } catch (err) {
        this.log('轮询异常：' + (err?.message || err))
      }
    }
    this.timer = setInterval(tick, Math.max(4000, intervalMs))
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stopWatching() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 给前端的精简图。**只发「画得出来」的字段**：
   * 正文/关键词/实体/每条边的 why 都不发（那些走 /node 按需取），
   * 这样 1300 条记忆的包从 2.6MB 降到 0.5MB 量级，首帧早得多。
   */
  publicGraph() {
    const g = this.graph
    const idOf = new Map(g.nodes.map((n) => [n.i, n.id]))

    // 簇＝工作区：星云里每个工作区一团光，跨工作区的连线就是桥。
    const wsMap = new Map()
    for (const n of g.nodes) {
      let c = wsMap.get(n.ws)
      if (!c) {
        c = { id: n.ws, title: n.wsTitle, label: n.wsTitle, size: 0, hue: hueOf(n.ws), color: hslHex(hueOf(n.ws)), workspaces: [n.ws] }
        wsMap.set(n.ws, c)
      }
      c.size++
    }
    const clusters = [...wsMap.values()].sort((a, b) => b.size - a.size)

    const nodes = g.nodes.map((n) => ({
      id: n.id,
      ws: n.wsTitle,
      cluster: n.ws,
      level: n.level,
      label: clip(n.title || n.label, 46),
      importance: n.importance,
      status: n.status,
      project: n.project,
      hits: n.hits,
      heat: n.heat,
      degree: n.degree,
      createdAt: n.createdAt,
      provider: n.provider || 'meow-memory',
      adapter: n.adapter || null,
      seed: n.seed,
    }))

    // 边用「下标」而不是 id：id 长 60+ 字符，5000 条边光 id 就是 600KB
    const idxOf = new Map(g.nodes.map((n, i) => [n.i, i]))
    const edges = []
    for (const e of g.edges) {
      const s = idxOf.get(e.s)
      const t = idxOf.get(e.t)
      if (s == null || t == null) continue
      edges.push({ s, d: t, w: Math.round(e.w * 1000) / 1000, t: e.type, curated: !!e.curated })
    }

    return {
      v: 2,
      nodes,
      edges,
      clusters,
      stats: g.stats,
      sources: g.sources || [],
      inventory: g.inventory || { plugins: [], skills: [], mcp: [] },
      builtAt: g.builtAt,
      buildMs: this.lastBuildMs,
      lastError: this.lastError,
    }
  }

  /**
   * 单条记忆的完整详情：正文 + 邻居 + 每一条关联的证据。
   * @param {string} id
   */
  detail(id) {
    const idx = this.index || {}
    const node =
      idx.byId?.get(id) || idx.byUid?.get(String(id)) || findNode(this.graph.nodes, id)
    if (!node) return null
    const raw = idx.rawById?.get(node.id) || this.nodes.find((x) => x.id === node.id) || null
    const edges = []
    if (idx.adj?.has(node.i)) {
      for (const link of idx.adj.get(node.i)) {
        const other = idx.byI?.get(link.n)
        if (!other) continue
        edges.push({
          id: other.id,
          label: other.label,
          ws: other.wsTitle,
          level: other.level,
          importance: other.importance,
          type: link.t,
          weight: link.w,
          why: link.why,
        })
      }
    } else {
      for (const edge of this.graph.edges) {
        if (edge.s !== node.i && edge.t !== node.i) continue
        const otherIdx = edge.s === node.i ? edge.t : edge.s
        const other = idx.byI?.get(otherIdx) || this.graph.nodes.find((x) => x.i === otherIdx)
        if (!other) continue
        edges.push({
          id: other.id,
          label: other.label,
          ws: other.wsTitle,
          level: other.level,
          importance: other.importance,
          type: edge.type,
          weight: edge.w,
          why: edge.why,
        })
      }
    }
    edges.sort((a, b) => b.weight - a.weight)
    const wsSize =
      this.graph.stats?.byWorkspace?.[node.wsTitle] ??
      this.graph.nodes.reduce((acc, x) => acc + (x.ws === node.ws ? 1 : 0), 0)
    // 来源节点（技能 / MCP / 插件）：反过来看「谁提到过它」，按项目分组统计
    let mentionedBy = null
    if (node.level === 'source') {
      const tally = new Map()
      for (const e of edges) {
        if (e.type !== 'mentions' || e.level === 'source') continue
        tally.set(e.ws, (tally.get(e.ws) || 0) + 1)
      }
      mentionedBy = {
        total: edges.filter((e) => e.type === 'mentions' && e.level !== 'source').length,
        byWorkspace: [...tally.entries()].map(([ws, n]) => ({ ws, n })).sort((a, b) => b.n - a.n),
        top: edges
          .filter((e) => e.type === 'mentions' && e.level !== 'source')
          .sort((a, b) => (b.importance || 0) - (a.importance || 0) || b.weight - a.weight)
          .slice(0, 12)
          .map((e) => ({ id: e.id, label: e.label, ws: e.ws, level: e.level, importance: e.importance })),
      }
      // 实际调用次数（从会话转写的 tool/call 里数出来，和「被提到」是两条独立证据）
      if (this._usageOf) {
        const kindKey = node.sourceKind === 'MCP' ? 'mcp' : node.sourceKind === '技能' ? 'skill' : 'plugin'
        try {
          mentionedBy.usage = this._usageOf(kindKey, node.title || node.label)
        } catch {}
      }
    }
    // 归属：这条记忆是在「主人在会话里说的哪句话」之后写下的。
    // 读的是 DSH 的会话转写（多帧 zstd），只在真正打开详情时懒加载。
    let origin = null
    try {
      if (this._originOfMemory) {
        const sid = raw?.sessionId || ''
        const at = raw?.createdAt || node.createdAt || 0
        const key = sid + ':' + at
        if (this._originCache?.has(key)) {
          origin = this._originCache.get(key)
        } else {
          origin = this._originOfMemory({ sessionId: sid, createdAt: at })
          this._originCache?.set(key, origin)
        }
      }
    } catch {}
    // 同一次会话里还写下了哪些记忆：一条上下文脉络，比单条记忆更好定位
    let peers = null
    const sid = raw?.sessionId || ''
    if (sid && node.level !== 'source') {
      const anchor = raw?.createdAt || node.createdAt || 0
      const same = this.graph.nodes.filter((x) => x.level !== 'source' && x.sessionId === sid && x.id !== node.id)
      const rawById = idx.rawById || new Map(this.nodes.map((x) => [x.id, x]))
      peers = {
        total: same.length,
        items: same
          // 按「时间上离它最近」排：前后几分钟写下的，才是同一条思路里的东西
          .sort(
            (a, b) =>
              Math.abs((rawById.get(a.id)?.createdAt || 0) - anchor) - Math.abs((rawById.get(b.id)?.createdAt || 0) - anchor),
          )
          .slice(0, 12)
          .map((x) => ({
            id: x.id,
            label: x.label,
            level: x.level,
            importance: x.importance,
            ws: x.wsTitle,
            createdAt: rawById.get(x.id)?.createdAt || 0,
          })),
      }
    }
    return {
      ...node,
      content: raw?.content || node.preview,
      goal: raw?.goal || '',
      subcategory: raw?.subcategory || '',
      corrected: raw?.corrected || false,
      sessionId: raw?.sessionId || '',
      keywords: raw?.keywords || node.keywords,
      mentions: this.mentionsOf(raw?.content || node.preview || ''),
      mentionedBy,
      peers,
      origin,
      // 重要度建议：只提示，不改别人的库
      suggest: (() => {
        try {
          const m = this._sugg && this._sugg.sig === this.signature ? this._sugg.value : null
          const mm = m || this.suggestImportance()
          this._sugg = { sig: this.signature, value: mm }
          return mm.get(node.id) || null
        } catch {
          return null
        }
      })(),
      // 写入时就算过的那几条证据（sidecar 缓存），只在第一次建图时算
      evidence: (() => {
        try {
          if (this._evCache?.has(node.id)) return this._evCache.get(node.id)
          const c = cacheGet('ev:' + node.id)
          const val = c && c.edges ? c : null
          this._evCache?.set(node.id, val)
          return val
        } catch {
          return null
        }
      })(),
      degree: edges.length,
      cluster: { id: node.ws, label: node.wsTitle, size: wsSize },
      neighbors: edges,
    }
  }

  /**
   * 这条记忆提到了哪些技能 / MCP / 记忆插件。
   * 只认「名字原样出现」——不做模糊匹配，避免把无关记忆挂到技能上。
   */
  mentionsOf(text) {
    const out = []
    const body = String(text || '')
    if (!body) return out
    const lower = body.toLowerCase()
    for (const skill of this.inventory.skills || []) {
      const name = String(skill.name || '')
      if (name.length >= 4 && lower.includes(name.toLowerCase())) {
        out.push({ kind: 'skill', name, description: String(skill.description || '').slice(0, 90) })
      }
    }
    for (const m of this.inventory.mcp || []) {
      const name = String(m.name || '')
      if (name.length >= 4 && lower.includes(name.toLowerCase())) {
        out.push({ kind: 'mcp', name, description: '' })
      }
    }
    for (const p of this.inventory.plugins || []) {
      const name = String(p.name || '')
      const short = name.replace(/^@[^/]+\//, '')
      if (short.length >= 6 && lower.includes(short.toLowerCase())) {
        out.push({ kind: 'plugin', name: short, description: '' })
      }
    }
    // 去重（同名只留一条，技能 > MCP > 插件）+ 上限
    const order = { skill: 0, mcp: 1, plugin: 2 }
    const seen = new Set()
    return out
      .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))
      .filter((x) => {
        const k = x.name.toLowerCase()
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      .slice(0, 8)
  }

  /**
   * 扩散检索。
   * @param {string} query
   * @param {object} [opts]
   */
  recall(query, opts = {}) {
    return recall(this.graph, query, opts)
  }

  /**
   * 注入桥：从「别的记忆插件刚喂过的东西」出发，挑出该补充的邻居。
   *
   * 这是星图和其他记忆插件协同的正式接口。任何插件/agent 都能调：
   *   nebula_bridge({ ids: [...刚注入的记忆], sessionId })
   * 返回的 items 是「没被讲过、但和这件事强相关」的记忆，可直接拼进上下文。
   *
   * @param {object} opts
   * @param {string[]} [opts.ids] 种子记忆（完整 id 或裸 uid）
   * @param {string} [opts.query] 没有 ids 时用查询词找种子
   * @param {string} [opts.sessionId]
   * @param {Set<string>|string[]} [opts.seen]
   * @param {object} [opts.budget]
   * @param {boolean} [opts.mark] 是否记账（默认 true，有 sessionId 时）
   */
  bridge(opts = {}) {
    const seen = opts.seen instanceof Set ? new Set(opts.seen) : new Set(opts.seen || [])
    if (opts.sessionId) {
      const mine = readLedger(opts.sessionId)
      for (const uid of Object.keys(mine.seen)) seen.add(uid)
      for (const uid of Object.keys(mine.external)) seen.add(uid)
    }
    const res = bridgeFn(this.graph, {
      ids: opts.ids,
      query: opts.query,
      seen,
      cooldown: opts.cooldown || readCooldown(),
      budget: opts.budget,
      ws: opts.ws,
      adj: this.index?.adj,
      allowStale: opts.allowStale,
    })
    if (opts.mark !== false && opts.sessionId && res.items.length > 0) {
      const uids = res.items.map((x) => x.uid)
      try {
        markSeen(opts.sessionId, uids, opts.by || 'nebula:inject')
        markCooldown(uids)
      } catch {
        /* 记账失败不影响返回 */
      }
    }
    return res
  }

  /**
   * 接收外部推送的记忆（给没有本地落盘的记忆服务用）。
   * 写的是星图自己的目录，重建后立刻进图。
   * @param {string} provider
   * @param {object[]} items
   */
  async ingest(provider, items) {
    const res = appendIngest(provider, items)
    if (res.written > 0) {
      this.signature = ''
      await this.refresh({ force: true })
    }
    return { ...res, graph: this.graph?.stats || null }
  }

  /**
   * 来源体检：现在接了谁、读到了什么、配置在哪、怎么加新的。
   * 给人看，也给 AI 看（AI 照着填 sources.json 就能接入新插件）。
   */
  sourcesReport() {
    const probe = probeAll()
    let scanned = { nodes: [], ledgers: [], errors: [] }
    try {
      // 示例库没有「适配器」可扫：直接拿内置数据，别让来源面板挂一条假警报。
      scanned = this.demo
        ? { nodes: DEMO_MEMORIES, ledgers: DEMO_LEDGERS, errors: [] }
        : scanAll(this.stores || [])
    } catch (err) {
      scanned.errors = [{ store: 'all', error: String(err?.message || err) }]
    }
    const byProvider = {}
    const byAdapter = {}
    for (const n of scanned.nodes) {
      byProvider[n.provider || '?'] = (byProvider[n.provider || '?'] || 0) + 1
      byAdapter[n.adapter || '?'] = (byAdapter[n.adapter || '?'] || 0) + 1
    }
    return {
      config: probe.config,
      adapters: adapterCatalog(),
      probes: probe.probes,
      live: {
        stores: (this.stores || []).map((s) => ({
          id: s.id,
          adapter: s.adapter,
          provider: s.provider,
          title: s.title,
          path: s.path,
          size: s.size,
          hasSessions: Boolean(s.sessionsDir),
        })),
        nodes: scanned.nodes.length,
        byProvider,
        byAdapter,
        errors: scanned.errors.slice(0, 8),
      },
      graph: this.graph?.stats || null,
      ledger: (() => {
        try {
          return ledgerStats()
        } catch {
          return null
        }
      })(),
      hint:
        '要接一个新记忆插件：读 docs/adapters.md，在 sources.json 里加一条（简单情况零代码），' +
        '远端服务用 nebula_ingest 推。改完调 nebula_sources 体检。',
    }
  }

  /**
   * 注入账本快照：谁被注入过、什么时候、冷却表还有多少。
   * @param {string} [sessionId]
   */
  ledger(sessionId = '') {
    const stats = ledgerStats()
    if (!sessionId) return { stats }
    const book = readLedger(sessionId)
    return {
      stats,
      sessionId,
      seen: Object.keys(book.seen || {}).length,
      injected: (book.injected || []).length,
      recent: (book.injected || []).slice(-24),
      updatedAt: book.updatedAt || null,
    }
  }

  /**
   * 导出图谱：给人看 Markdown，给别的 AI 看 JSON。
   * 不导出正文（正文在节点详情里，避免一次吐几十万字）。
   * @param {{format?:'md'|'json', scope?:'all'|'ws', ws?:string, limit?:number}} [opts]
   */
  exportReport(opts = {}) {
    const format = (opts.format || 'md').toLowerCase()
    const limit = Math.max(10, Math.min(2000, Number(opts.limit) || 200))
    const g = this.graph
    if (!g) return { error: '星图还没建好' }

    // 范围导出：`all`，或 ws:<工作区> / project:<项目> / focus:<节点 id>。
    // 只影响这次导出，不改图、不写库。旧调用不传 scope 时行为与 all 完全一致。
    const rawScope = String(opts.scope || 'all').trim()
    const cut = rawScope.indexOf(':')
    const scopeKind = cut > 0 ? rawScope.slice(0, cut).toLowerCase() : 'all'
    const scopeValue = cut > 0 ? rawScope.slice(cut + 1) : ''
    let allowed = null
    if (scopeKind === 'ws' || scopeKind === 'project') {
      const want = scopeValue.toLowerCase()
      allowed = new Set()
      for (const n of g.nodes) {
        const hit = scopeKind === 'ws'
          ? (String(n.ws || '').toLowerCase() === want || String(n.wsTitle || '').toLowerCase() === want || String(n.cluster || '').toLowerCase() === want)
          : String(n.project || '').toLowerCase() === want
        if (hit) allowed.add(n.i)
      }
      if (!allowed.size) return { error: `这个范围里没有记忆：${rawScope}` }
    } else if (scopeKind === 'focus') {
      const start = g.nodes.find((n) => n.id === scopeValue || n.uid === scopeValue || n.label === scopeValue)
      if (!start) return { error: `找不到这条记忆：${scopeValue}` }
      const hops = Math.max(1, Math.min(5, Number(opts.hops) || 2))
      const adj = new Map()
      for (const e of g.edges) {
        if (!adj.has(e.s)) adj.set(e.s, [])
        if (!adj.has(e.t)) adj.set(e.t, [])
        adj.get(e.s).push(e.t)
        adj.get(e.t).push(e.s)
      }
      allowed = new Set([start.i])
      let frontier = [start.i]
      for (let h = 0; h < hops; h++) {
        const next = []
        for (const i of frontier) {
          for (const j of adj.get(i) || []) {
            if (allowed.has(j)) continue
            allowed.add(j)
            next.push(j)
          }
        }
        frontier = next
        if (!frontier.length) break
      }
    }

    const idx = allowed ? g.nodes.filter((n) => allowed.has(n.i)) : g.nodes
    const byIndex = new Map(idx.map((n) => [n.i, n]))
    const scopedEdges = allowed ? g.edges.filter((e) => allowed.has(e.s) && allowed.has(e.t)) : g.edges
    const top = [...idx].sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, limit)
    const strong = [...scopedEdges].sort((a, b) => b.w - a.w).slice(0, Math.min(limit, 120))

    // 切片后按切片内的边重算度数，避免沿用全图的 degree 把「孤岛」写错。
    const degree = new Map()
    for (const e of scopedEdges) {
      degree.set(e.s, (degree.get(e.s) || 0) + 1)
      degree.set(e.t, (degree.get(e.t) || 0) + 1)
    }
    const orphans = idx.filter((n) => (allowed ? (degree.get(n.i) || 0) : n.degree) === 0)
    const rawById = new Map((this.nodes || []).map((n) => [n.id, n]))
    const keptIds = new Set(idx.map((n) => n.id))
    const keptUids = new Set(idx.map((n) => n.uid).filter(Boolean))
    const scopedSessions = allowed
      ? new Set((this.ledgers || []).filter((l) => (l.ids || []).some((id) => keptIds.has(id) || keptUids.has(id))).map((l) => l.sessionId)).size
      : g.stats.sessions
    const stats = allowed ? {
      ...g.stats,
      nodes: idx.length,
      edges: scopedEdges.length,
      workspaces: new Set(idx.map((n) => n.wsTitle)).size,
      sessions: scopedSessions,
      orphans: orphans.length,
      avgDegree: idx.length ? Math.round((2 * scopedEdges.length / idx.length) * 10) / 10 : 0,
    } : g.stats
    const clusters = allowed
      ? g.clusters.map((c) => {
          const members = (c.members || []).filter((i) => allowed.has(i))
          const workspaces = [...new Set(members.map((i) => g.nodes[i]?.ws).filter(Boolean))]
          return { ...c, members, size: members.length, workspaces }
        }).filter((c) => c.size > 0)
      : g.clusters
    const scopeInfo = allowed ? { kind: scopeKind, value: scopeValue, nodes: idx.length, edges: scopedEdges.length } : { kind: 'all' }

    if (format === 'json') {
      return {
        generatedAt: Date.now(),
        scope: scopeInfo,
        stats,
        clusters: clusters.map((c) => ({ id: c.id, title: c.title || c.label, size: c.size, color: c.color })),
        nodes: top.map((n) => ({
          id: n.id,
          label: n.label,
          ws: n.wsTitle,
          level: n.level,
          provider: n.provider,
          importance: n.importance,
          degree: n.degree,
        })),
        edges: strong.map((e) => [byIndex.get(e.s)?.id, byIndex.get(e.t)?.id, Math.round(e.w * 1000) / 1000, e.type]),
        orphans: orphans.slice(0, 200).map((n) => ({ id: n.id, label: n.label, ws: n.wsTitle })),
      }
    }

    const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
    const L = []
    L.push(`# 记忆星图导出${allowed ? ' · ' + rawScope : ''} · ${stamp}`)
    L.push('')
    L.push(`节点 ${stats.nodes} · 连接 ${stats.edges} · 工作区 ${stats.workspaces} · 会话 ${stats.sessions} · 平均连接 ${stats.avgDegree}`)
    L.push('')
    L.push('## 工作区')
    L.push('')
    L.push('| 工作区 | 记忆 |')
    L.push('| --- | ---: |')
    for (const [ws, n] of Object.entries(stats.byWorkspace || {}).sort((a, b) => b[1] - a[1])) {
      L.push(`| ${ws} | ${n} |`)
    }
    L.push('')
    L.push('## 层级')
    L.push('')
    L.push('| 层级 | 记忆 |')
    L.push('| --- | ---: |')
    for (const [lv, n] of Object.entries(stats.byLevel || {}).sort((a, b) => b[1] - a[1])) {
      L.push(`| ${lv} | ${n} |`)
    }
    L.push('')
    L.push(`## 枢纽（连接最多的 ${top.length} 条）`)
    L.push('')
    top.forEach((n, i) => {
      L.push(`${i + 1}. 【${n.level}·${n.wsTitle}】${clip(n.title || n.label, 80)} —— 连接 ${n.degree}`)
    })
    L.push('')
    L.push('## 最强关联')
    L.push('')
    for (const e of strong) {
      const a = byIndex.get(e.s)
      const b = byIndex.get(e.t)
      if (!a || !b) continue
      const why = (e.why || []).map((x) => x.label || x.k).filter(Boolean).slice(0, 2).join('；')
      L.push(`- ${clip(a.title || a.label, 40)} ⇄ ${clip(b.title || b.label, 40)} · w=${e.w.toFixed(2)} · ${e.type}${why ? ' · ' + why : ''}`)
    }
    L.push('')
    L.push(`## 孤岛（${orphans.length} 条）`)
    L.push('')
    for (const n of orphans.slice(0, 60)) L.push(`- 【${n.level}·${n.wsTitle}】${clip(n.title || n.label, 70)}`)
    if (orphans.length > 60) L.push(`- …还有 ${orphans.length - 60} 条`)
    return { format: 'md', text: L.join('\n'), stats }
  }

  /**
   * 两个节点之间的最短证据链：回答「A 和 B 到底怎么连上的」。
   * 只走星图里已经算出来的边，不猜、不补；找不到就是找不到。
   * @param {string} a
   * @param {string} b
   * @param {{maxHops?:number}} [opts]
   */
  async path(a, b, opts = {}) {
    if (!this._findPath) await this.#loadOptionalModules()
    if (!this._findPath) return { found: false, error: '这个引擎版本还没带上路径搜索（等宿主重启后生效）' }
    const n = resolveIds(this.graph.nodes, [a, b])
    if (n.length < 2) return { found: false, error: '找不到这两个节点：' + a + ' / ' + b }
    const i = this.graph.nodes.indexOf(n[0])
    const j = this.graph.nodes.indexOf(n[1])
    if (i < 0 || j < 0) return { found: false, error: '节点不在当前星图里' }
    const res = this._findPath(this.graph, i, j, opts)
    if (!res || !res.found) {
      const e0 = this.graph.edges[0]
      return { found: false, debug: { i, j, nodes: this.graph.nodes.length, edges: this.graph.edges.length } }
    }
    const nodes = this.graph.nodes
    const field = (x) => ({
      id: x.id,
      label: x.label,
      level: x.level,
      ws: x.wsTitle,
      importance: x.importance,
      kind: x.kind,
    })
    return {
      found: res.found,
      hops: res.hops,
      score: Math.round(res.score * 1000) / 1000,
      nodes: res.ids.map((k) => field(nodes[k])),
      edges: res.edges.map((e) => ({
        a: nodes[e.s].id,
        b: nodes[e.t].id,
        w: e.w,
        t: e.type,
        why: Array.isArray(e.why) ? e.why.join(' · ') : e.why,
      })),
    }
  }

  /**
   * 人工连线。
   * @param {string} a
   * @param {string} b
   * @param {string} [note]
   */
  link(a, b, note = '') {
    const n = resolveIds(this.graph.nodes, [a, b])
    if (n.length < 2) throw missingNodes(a, b)
    addLink(n[0].id, n[1].id, note)
    return { a: n[0].id, b: n[1].id, note }
  }

  /**
   * 解除人工连线。
   * @param {string} a
   * @param {string} b
   */
  unlink(a, b) {
    const n = resolveIds(this.graph.nodes, [a, b])
    if (n.length < 2) return false
    return removeLink(n[0].id, n[1].id)
  }

  /**
   * 屏蔽一对节点之间的自动关联：重建星图时这条边不会再出现。
   * 这是「关联算错了」的正规出口 —— 不是一删了之，而是把这条推断记进黑名单。
   * @param {string} a
   * @param {string} b
   * @param {string} [note]
   */
  mute(a, b, note = '') {
    const n = resolveIds(this.graph.nodes, [a, b])
    if (n.length < 2) throw missingNodes(a, b)
    addMute(n[0].id, n[1].id, note)
    return { a: n[0].id, b: n[1].id, note }
  }

  /**
   * 取消屏蔽。
   * @param {string} a
   * @param {string} b
   */
  unmute(a, b) {
    const n = resolveIds(this.graph.nodes, [a, b])
    if (n.length < 2) return false
    return removeMute(n[0].id, n[1].id)
  }

  /** 当前被屏蔽的关联对（UI 里要能看见、能撤销）。 */
  mutes() {
    return listMutes()
  }

  /** 记忆体检：把「越写越肥、两份打架、没人读、关系是凑的」查成一张清单。 */
  hygiene() {
    if (this._hygiene && this._hygiene.sig === this.signature) return this._hygiene.value
    let value
    try {
      // 体检要看正文，用原始节点（图节点只带 200 字预览）
      // 边是下标形状，必须把「下标 → id」一起交给体检，否则孤立/弱关系两格会被算成假数据
      // 建图时每条记忆已经分过一次词（graph.nodes[i].tokens）；体检再分一遍
      // 在 1 万条库上要多花一秒多。这里把 token 直接传过去复用。
      const tokensById = new Map(this.graph.nodes.map((n) => [n.id, n.tokens]))
      value = auditHygiene({ nodes: this.nodes, edges: this.graph.edges, nodeIds: this.graph.nodes.map((n) => n.id), tokensById })
    } catch (err) {
      value = { total: 0, counts: {}, items: {}, error: String(err && err.message) }
    }
    this._hygiene = { sig: this.signature, value }
    return value
  }

  /**
   * 项目卡片：每个工作区一张「交接卡」——现状 / 最近变更 / 下一步与卡点 / 代表记忆。
   *
   * 只做聚合，不判断谁对谁错：数字全部来自只读抽取，卡片是给「换会话接活」的人看的。
   */
  cards() {
    if (this._cards && this._cards.sig === this.signature) return this._cards.value
    const memories = this.nodes.filter((n) => n.level !== 'source')
    const degOf = new Map(this.graph.nodes.map((n) => [n.id, n.degree]))
    const hy = this.hygiene()
    const healthByWs = new Map()
    for (const [kind, list] of Object.entries((hy && hy.items) || {})) {
      for (const it of list || []) {
        const ws = it.ws
        if (!ws) continue
        const cur = healthByWs.get(ws) || {}
        cur[kind] = (cur[kind] || 0) + 1
        healthByWs.set(ws, cur)
      }
    }
    const byWs = new Map()
    for (const n of memories) {
      const ws = n.ws || 'unknown'
      let arr = byWs.get(ws)
      if (!arr) byWs.set(ws, (arr = []))
      arr.push(n)
    }
    const cards = []
    for (const [ws, list] of byWs) {
      const levels = {}
      for (const n of list) levels[n.level] = (levels[n.level] || 0) + 1
      const sessions = new Set(list.map((n) => n.sessionId).filter(Boolean)).size
      const projects = [...new Set(list.map((n) => n.project).filter((p) => p && p !== '全局'))].slice(0, 4)
      const recent = list
        .slice()
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
        .slice(0, 3)
        .map((n) => ({
          id: n.id,
          label: clip(n.title || n.label, 42),
          level: n.level,
          status: n.status,
          at: n.updatedAt || n.createdAt || 0,
        }))
      // 下一步与卡点：project/todo 子类里还 active 的那几条
      const todos = list
        .filter((n) => n.level === 'project' && n.subcategory === 'todo' && n.status === 'active')
        .sort((a, b) => (b.importance || 0) - (a.importance || 0) || (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 3)
        .map((n) => ({ id: n.id, label: clip(n.title || n.label, 72), importance: n.importance, goal: n.goal || '' }))
      const hubs = list
        .slice()
        .sort((a, b) => b.importance * 3 + (degOf.get(b.id) || 0) - (a.importance * 3 + (degOf.get(a.id) || 0)))
        .slice(0, 3)
        .map((n) => ({
          id: n.id,
          label: clip(n.title || n.label, 42),
          level: n.level,
          importance: n.importance,
          degree: degOf.get(n.id) || 0,
        }))
      const updatedAt = list.reduce((m, n) => Math.max(m, n.updatedAt || n.createdAt || 0), 0)
      cards.push({
        ws,
        title: list[0].wsTitle || ws,
        total: list.length,
        levels,
        sessions,
        projects,
        recent,
        todos,
        hubs,
        health: healthByWs.get(ws) || {},
        updatedAt,
      })
    }
    cards.sort((a, b) => b.total - a.total)
    const value = { generatedAt: Date.now(), cards }
    this._cards = { sig: this.signature, value }
    return value
  }

  /**
   * 单一真源清单：把「声明过自己是权威」的记忆挑出来。
   *
   * 只看正文里明确写了「以…为准 / 单一真源 / 唯一权威 / 以此为准 / 权威版本」的，
   * 不做语义猜测——宁可少列，也不给一堆要你判断的假冲突。
   */
  truthSources() {
    if (this._truth && this._truth.sig === this.signature) return this._truth.value
    const RE = /(以.{0,12}为准|单一真源|唯一权威|以此为准|权威版本|以这条为准|source of truth)/i
    const byProject = new Map()
    for (const n of this.nodes) {
      if (n.level === 'source') continue
      if (!RE.test(n.content || '')) continue
      const key = n.project && n.project !== '全局' ? n.project : n.wsTitle || n.ws
      let arr = byProject.get(key)
      if (!arr) byProject.set(key, (arr = []))
      arr.push({ id: n.id, label: clip(n.title || n.label, 56), ws: n.wsTitle, level: n.level, importance: n.importance })
    }
    const groups = [...byProject.entries()]
      .map(([project, items]) => ({ project, items }))
      .sort((a, b) => b.items.length - a.items.length)
    const value = { total: groups.reduce((s, g) => s + g.items.length, 0), groups }
    this._truth = { sig: this.signature, value }
    return value
  }

  /**
   * 重要度建议：只给「建议」，不改别人的库。
   *
   * 依据三条可解释信号：被读过（hits）、连了几条（degree）、写了多久没人碰（age）。
   */
  suggestImportance() {
    const now = Date.now()
    const out = new Map()
    for (const n of this.graph.nodes) {
      if (n.level === 'source') continue
      const cur = n.importance || 1
      const reasons = []
      let d = 0
      if (n.hits > 0) {
        d += 1
        reasons.push('被读过 ' + n.hits + ' 次')
      }
      if (n.degree >= 14) {
        d += 1
        reasons.push('连了 ' + n.degree + ' 条')
      } else if (n.degree <= 1) {
        d -= 1
        reasons.push('只连了 ' + n.degree + ' 条')
      }
      const days = (now - (n.createdAt || now)) / 86400000
      if (n.hits === 0 && days > 45) {
        d -= 1
        reasons.push('写了 ' + Math.round(days) + ' 天没人读')
      }
      const next = Math.max(1, Math.min(4, cur + Math.sign(d) * Math.min(2, Math.abs(d))))
      if (next !== cur) out.set(n.id, { from: cur, to: next, why: reasons.join('，') })
    }
    return out
  }

  /** 外部记忆源探测：能读就读，读不到就说读不到（不假装有数据）。 */
  externals() {
    const home = dshHome()
    const user = process.env.USERPROFILE || ''
    const items = []
    const cfg = join(user, '.hindsight', 'coding-agent.json')
    items.push({
      id: 'hindsight',
      name: 'Hindsight',
      ok: existsSync(cfg),
      note: existsSync(cfg) ? '检测到本地配置，知识页可作为来源节点' : '没有本地 token / 知识页，暂时读不到',
    })
    const ovDir = join(user, '.openviking')
    let pending = 0
    try {
      pending = existsSync(join(ovDir, 'pending')) ? readdirSync(join(ovDir, 'pending')).length : 0
    } catch {}
    items.push({
      id: 'openviking',
      name: 'OpenViking',
      ok: false,
      note: pending ? '只有待上传队列（' + pending + ' 条），没有可查记忆库' : '没有可查记忆库',
    })
    items.push({
      id: 'meow',
      name: 'meow-memory',
      ok: (this.stores || []).length > 0,
      note: (this.stores || []).length + ' 个工作区记忆库，只读',
    })
    return { items, home }
  }

  /** 星图概览（给 AI 用的极简摘要）。 */
  overview() {
    const s = this.graph.stats
    const top = this.graph.nodes
      .slice()
      .sort((a, b) => b.degree * (1 + b.importance * 0.25) - a.degree * (1 + a.importance * 0.25))
      .slice(0, 12)
      .map((n) => ({ id: n.id, label: n.label, ws: n.wsTitle, level: n.level, degree: n.degree, importance: n.importance }))
    return {
      stats: s,
      workspaces: Object.entries(s.byWorkspace || {}).map(([name, count]) => ({ name, count })),
      levels: s.byLevel || {},
      edgeTypes: s.byType || {},
      clusters: (this.graph.clusters || []).slice(0, 8).map((c) => ({ label: c.label, size: c.size, workspaces: c.workspaces })),
      hubs: top,
      sources: this.graph.sources || [],
      inventory: {
        plugins: (this.inventory.plugins || []).length,
        skills: (this.inventory.skills || []).length,
        mcp: (this.inventory.mcp || []).length,
        // 谁在记记忆：名字里带这些词的插件，多半就是记忆/上下文类
        // （排除 @deepseek-ai/* 框架包——"deepseek" 里也含 "seek"，会误伤）
        memoryPlugins: (this.inventory.plugins || [])
          .filter((p) => !/^@deepseek-ai\//i.test(p.name))
          .filter((p) => /memory|memewiki|hindsight|openviking|seekmemory|context|recall|billion|mind/i.test(p.name))
          .map((p) => p.name),
        mcpNames: (this.inventory.mcp || []).map((m) => m.name).slice(0, 8),
      },
      builtAt: this.graph.builtAt,
      buildMs: this.lastBuildMs,
      lastError: this.lastError,
      lastSignature: this.signature.slice(0, 120),
      dbPath: this.demo ? '' : join(nebulaHome(), 'nebula.db'),
      lastBuiltAt: this.demo ? '' : getMeta('lastBuiltAt', ''),
      hygiene: this.hygiene(),
      cards: this.cards(),
      truth: this.truthSources(),
      externals: this.externals(),
    }
  }
}

/** 读一个文件的前 N 字节（给调试用）。 */
export function head(file, n = 400) {
  try {
    return readFileSync(file, 'utf8').slice(0, n)
  } catch {
    return ''
  }
}
