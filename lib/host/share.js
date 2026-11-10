/* 单文件快照
 *
 * 把一张星图压成一个 HTML：样式、脚本、数据全部内联，双击就能看。
 * 没有后端、没有网络请求 —— 搜索、点节点、证据链都在浏览器里本地算。
 *
 * 0.6.0 起支持「切片」：可以只导出一个工作区、一个项目，或某个节点周围 N 跳。
 * 切片不是把整图藏起来，而是根本不把范围外的记忆写进文件——隐私不能靠前端隐藏。
 *
 * 注意：快照里包含记忆全文。它是一份「用户主动导出」的文件，
 * 不是自动分享；界面上必须说清楚，别让人以为点一下就上传了。
 */
import { readFile } from 'node:fs/promises'
import { auditHygiene } from './graph.js'

const WEB = new URL('../web/', import.meta.url)
const MAX_HOPS = 5

function fail(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/** 内联进 <script> 的 JSON：把可能提前闭合标签的字符转义掉。 */
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** 内联进 <script> 的源码：只处理真正会闭合标签的那一处。 */
function inlineScript(source) {
  return String(source).replace(/<\/script/gi, '<\\/script')
}

function put(html, needle, replacement, what) {
  if (!html.includes(needle)) throw new Error('share: 页面结构变了，找不到' + what)
  // 用函数式 replace：源码里有 `$&` / `$1`（app.js 的转义正则就有），
  // 当字符串替换会被当成替换模式展开，把源码改坏——这是真踩过的坑。
  return html.replace(needle, () => replacement)
}

/**
 * 解析 ?scope=。返回 null 表示整张图；格式错误抛 400。
 * 支持的写法：
 *   ws:<工作区 slug 或显示名>
 *   project:<项目名>
 *   focus:<节点 id>
 */
export function parseShareScope(raw) {
  const text = String(raw || '').trim()
  if (!text || text === 'all') return null
  const at = text.indexOf(':')
  const kind = at > 0 ? text.slice(0, at).toLowerCase() : ''
  const value = at > 0 ? text.slice(at + 1).trim() : ''
  if (!kind || !value || !['ws', 'project', 'focus'].includes(kind)) {
    throw fail(400, 'scope 要写成 ws:<工作区>、project:<项目> 或 focus:<节点 id>')
  }
  return { kind, value }
}

export function parseShareHops(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 2
  return Math.max(1, Math.min(MAX_HOPS, Math.round(n)))
}

/**
 * 解析 ?hide=。可以重复传，也可以写成逗号分隔：
 *   hide=level:user
 *   hide=ws:日记&hide=project:私人
 * 只接受白名单里的字段；拼错就 400，不静默忽略——导出前的隐私规则，
 * 「我以为藏了」比「报错」危险得多。
 *
 * @param {string|string[]|null} raw
 * @returns {{kind:'level'|'ws'|'project'|'status',value:string}[]}
 */
export function parseShareHide(raw) {
  const parts = (Array.isArray(raw) ? raw : [raw])
    .filter((x) => x != null)
    .flatMap((x) => String(x).split(','))
    .map((x) => x.trim())
    .filter(Boolean)
  const rules = []
  for (const text of parts) {
    const at = text.indexOf(':')
    const kind = at > 0 ? text.slice(0, at).toLowerCase() : ''
    const value = at > 0 ? text.slice(at + 1).trim() : ''
    if (!kind || !value || !['level', 'ws', 'project', 'status'].includes(kind)) {
      throw fail(400, 'hide 要写成 level:<层级>、ws:<工作区>、project:<项目> 或 status:<状态>')
    }
    rules.push({ kind, value })
  }
  return rules
}

function hidesNode(node, rules) {
  for (const rule of rules) {
    if (rule.kind === 'level' && node.level === rule.value) return true
    if (rule.kind === 'ws' && (node.cluster === rule.value || node.ws === rule.value)) return true
    if (rule.kind === 'project' && String(node.project || '') === rule.value) return true
    if (rule.kind === 'status' && node.status === rule.value) return true
  }
  return false
}

/** 概览里的来源会带本机路径；快照是拿出去给人看的，只留名字与规模。 */
function publicSources(list) {
  return (list || []).map((s) => ({
    key: s.key,
    title: s.title,
    size: s.size,
    kind: s.kind,
    count: s.count,
  }))
}

/** 概览顶层还挂着数据库路径 / 上次错误；这些是本机诊断信息，不进快照。 */
function publicOverview(ov) {
  const { dbPath, db, lastError, ...rest } = ov || {}
  return { ...rest, sources: publicSources(rest.sources) }
}

function rawIndex(nebula) {
  return nebula.index?.rawById || new Map((nebula.nodes || []).map((n) => [n.id, n]))
}

function focusSet(full, id, hops) {
  const byId = new Map((full.nodes || []).map((n, i) => [n.id, i]))
  const start = byId.get(id)
  if (start == null) throw fail(404, '找不到这条记忆：' + id)
  const adj = new Map()
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a).push(b)
  }
  for (const e of full.edges || []) {
    link(e.s, e.d)
    link(e.d, e.s)
  }
  const seen = new Set([start])
  let edge = [start]
  for (let step = 0; step < hops; step++) {
    const next = []
    for (const at of edge) {
      for (const to of adj.get(at) || []) {
        if (seen.has(to)) continue
        seen.add(to)
        next.push(to)
      }
    }
    if (!next.length) break
    edge = next
  }
  return seen
}

/**
 * 按范围切出一张自洽的公开图 + 该范围的 overview。
 * 边会在切片后重新编号；统计、簇、体检都只针对切出来的这一片重算，
 * 不让读者把「这个工作区的数字」误当成「整个库的数字」。
 *
 * @param {import('./nebula.js').Nebula} nebula
 * @param {null|{kind:'ws'|'project'|'focus',value:string}} scope
 * @param {{hops?:number}} [opts]
 */
export function sliceShareGraph(nebula, scope = null, opts = {}) {
  const full = nebula.publicGraph()
  const rawById = rawIndex(nebula)
  const rules =
    Array.isArray(opts.hide) && opts.hide.length && typeof opts.hide[0] === 'object'
      ? opts.hide // 路由层已经 parse 过，别把 {kind,value} 再字符串化一次
      : parseShareHide(opts.hide)
  const hops = parseShareHops(opts.hops)
  const withContent = (node) => {
    const raw = rawById.get(node.id)
    return raw?.content ? { ...node, content: raw.content } : { ...node }
  }

  // 没范围也没隐藏规则：原样整图，保留完整的 cards / truth / externals。
  if (!scope && !rules.length) {
    const ov = nebula.overview()
    return {
      graph: { ...full, sources: publicSources(full.sources), nodes: (full.nodes || []).map(withContent) },
      overview: publicOverview(ov),
      scope: { kind: 'all', value: '', label: '整张星图', hops: 0, hidden: 0, hide: [] },
    }
  }

  let keep
  let seedIdx = -1
  if (!scope) {
    keep = new Set(full.nodes.map((_, i) => i))
  } else if (scope.kind === 'focus') {
    seedIdx = full.nodes.findIndex((n) => n.id === scope.value)
    keep = focusSet(full, scope.value, hops)
  } else {
    keep = new Set()
    for (let i = 0; i < full.nodes.length; i++) {
      const n = full.nodes[i]
      if (scope.kind === 'ws' && (n.cluster === scope.value || n.ws === scope.value)) keep.add(i)
      else if (scope.kind === 'project' && String(n.project || '') === scope.value) keep.add(i)
    }
  }

  // 隐藏规则在范围之后生效：先选「分享哪一片」，再从中剔掉不该出门的记忆。
  // 顺序反了会把「整个日记工作区」重新算成空范围，错误信息也会误导。
  let hidden = 0
  for (const i of [...keep]) {
    if (hidesNode(full.nodes[i], rules)) {
      keep.delete(i)
      hidden++
    }
  }
  if (scope?.kind === 'focus' && !keep.has(seedIdx)) {
    throw fail(400, '起点这条记忆被 hide 排除了，没法以它为中心切片：' + scope.value)
  }
  if (!keep.size) {
    throw fail(
      404,
      hidden > 0
        ? '这个范围里没有可分享的记忆（' + hidden + ' 条都被 hide 排除了）'
        : '这个范围里没有记忆：' + (scope?.value || ''),
    )
  }

  const oldToNew = new Map()
  const nodes = []
  for (let i = 0; i < full.nodes.length; i++) {
    if (!keep.has(i)) continue
    oldToNew.set(i, nodes.length)
    nodes.push(withContent(full.nodes[i]))
  }

  const edges = []
  const degree = new Array(nodes.length).fill(0)
  for (const e of full.edges || []) {
    const s = oldToNew.get(e.s)
    const d = oldToNew.get(e.d)
    if (s == null || d == null) continue
    edges.push({ ...e, s, d })
    degree[s]++
    degree[d]++
  }
  for (let i = 0; i < nodes.length; i++) nodes[i].degree = degree[i]

  const byWorkspace = {}
  const byLevel = {}
  const byType = {}
  const sessions = new Set()
  for (const n of nodes) {
    byWorkspace[n.ws] = (byWorkspace[n.ws] || 0) + 1
    byLevel[n.level] = (byLevel[n.level] || 0) + 1
    const sid = rawById.get(n.id)?.sessionId
    if (sid) sessions.add(sid)
  }
  for (const e of edges) byType[e.t] = (byType[e.t] || 0) + 1

  const clusterMap = new Map()
  for (const n of nodes) {
    let c = clusterMap.get(n.cluster)
    if (!c) {
      const base = (full.clusters || []).find((x) => x.id === n.cluster || x.label === n.ws)
      c = base
        ? { ...base, size: 0 }
        : { id: n.cluster, title: n.ws, label: n.ws, size: 0, workspaces: [n.cluster] }
      clusterMap.set(n.cluster, c)
    }
    c.size++
  }
  const clusters = [...clusterMap.values()].sort((a, b) => b.size - a.size)

  const stats = {
    nodes: nodes.length,
    edges: edges.length,
    workspaces: Object.keys(byWorkspace).length,
    sessions: sessions.size,
    byType,
    byWorkspace,
    byLevel,
    orphans: degree.filter((d) => d === 0).length,
    avgDegree: Math.round((edges.length * 2 * 100) / Math.max(1, nodes.length)) / 100,
  }

  // 体检按切片重算：传原始节点（带正文）与切片后的下标边，不能拿整库的结果冒充。
  const hygiene = auditHygiene({
    nodes: nodes.map(
      (n) =>
        rawById.get(n.id) || {
          id: n.id,
          level: n.level,
          title: n.label,
          content: '',
          keywords: [],
          status: n.status,
          createdAt: n.createdAt,
          updatedAt: n.createdAt,
          hits: n.hits,
        },
    ),
    edges: edges.map((e) => ({ s: e.s, d: e.d, w: e.w, type: e.t })),
    nodeIds: nodes.map((n) => n.id),
  })

  const baseOverview = nebula.overview()
  const baseLabel = !scope
    ? '整张星图'
    : scope.kind === 'ws'
      ? '工作区 · ' + (nodes[0]?.ws || scope.value)
      : scope.kind === 'project'
        ? '项目 · ' + scope.value
        : '以「' + (nodes.find((n) => n.id === scope.value)?.label || scope.value) + '」为中心 · ' + hops + ' 跳'
  const label = baseLabel + (hidden ? ' · 已隐去 ' + hidden + ' 条' : '')
  const overview = {
    ...publicOverview(baseOverview),
    stats,
    workspaces: Object.entries(byWorkspace).map(([name, count]) => ({ name, count })),
    levels: byLevel,
    edgeTypes: byType,
    clusters: clusters.slice(0, 8).map((c) => ({ label: c.label, size: c.size, workspaces: c.workspaces })),
    hubs: nodes
      .slice()
      .sort((a, b) => b.degree * (1 + b.importance * 0.25) - a.degree * (1 + a.importance * 0.25))
      .slice(0, 12)
      .map((n) => ({ id: n.id, label: n.label, ws: n.ws, level: n.level, degree: n.degree, importance: n.importance })),
    hygiene,
    // 下面三块是「整库视角」的摘要；切片里留空，免得把全库结论带进局部快照。
    cards: null,
    truth: { total: 0, groups: [], scoped: true },
    externals: null,
  }

  return {
    graph: { ...full, sources: publicSources(full.sources), nodes, edges, clusters, stats },
    overview,
    scope: {
      kind: scope?.kind || 'all',
      value: scope?.value || '',
      label,
      hops: scope?.kind === 'focus' ? hops : 0,
      hidden,
      hide: rules.map((r) => r.kind + ':' + r.value),
    },
  }
}

/**
 * 生成快照 HTML。
 * @param {import('./nebula.js').Nebula} nebula
 * @param {{version?:string, build?:number}} [meta]
 * @param {{scope?:null|{kind:string,value:string}, hops?:number|string, hide?:string|string[]}} [opts]
 */
export async function buildShareHtml(nebula, meta = {}, opts = {}) {
  const { graph, overview, scope } = sliceShareGraph(nebula, opts.scope || null, {
    hops: opts.hops,
    hide: opts.hide,
  })
  const nodes = graph.nodes || []
  const payload = {
    version: meta.version || '',
    build: meta.build || 0,
    builtAt: Date.now(),
    sig: (nebula.signature || '') + '-snapshot',
    scope: { ...scope, nodes: nodes.length, edges: (graph.edges || []).length },
    graph: { ...graph, nodes },
    overview,
    inventory: graph.inventory || null,
  }

  const [html, css, api, i18n, render, space3d, app] = await Promise.all(
    ['index.html', 'style.css', 'api.js', 'i18n.js', 'render.js', 'space3d.js', 'app.js'].map((name) =>
      readFile(new URL(name, WEB), 'utf8'),
    ),
  )

  let out = html
  out = put(out, '<title>记忆星图 · Memory Nebula</title>', '<title>记忆星图 · 离线快照</title>', ' 标题')
  out = put(
    out,
    '<link rel="stylesheet" href="style.css" />',
    '<style>\n' + css + '\n</style>',
    ' 样式表',
  )
  // 原来的 space3d 是「动态插 script，404 就回落到独立引擎」；快照里没有服务器，直接内联。
  out = out.replace(/<script>\s*\/\/ 三维视图脚本[\s\S]*?<\/script>/, () => '<script>\n' + inlineScript(space3d) + '\n</script>')
  for (const [name, source] of [
    ['i18n.js', i18n],
    ['api.js', api],
    ['render.js', render],
    ['app.js', app],
  ]) {
    out = put(
      out,
      '<script src="' + name + '"></script>',
      '<script>\n' + inlineScript(source) + '\n</script>',
      ' ' + name,
    )
  }
  // 数据必须比 api.js 先就位：客户端一启动就要判断「这是不是快照」。
  out = put(
    out,
    '<body>',
    '<body>\n<script>window.__NEBULA_SNAPSHOT__ = ' + safeJson(payload) + ';</script>',
    ' <body>',
  )
  // 快照自己的界面提示（app.js 也会画一条；这里保证脚本没跑起来时也说得清）
  out = out.replace(
    '<div id="boot" role="status" aria-live="polite">',
    () => '<noscript><div style="position:fixed;inset:0;display:grid;place-items:center;background:#04060c;color:#cfe6f5;font:13px system-ui;z-index:99">这是一份离线快照，需要启用 JavaScript 才能点亮星图。</div></noscript>\n  <div id="boot" role="status" aria-live="polite">',
  )

  const bytes = Buffer.byteLength(out, 'utf8')
  return { html: out, bytes, nodes: nodes.length, edges: (graph.edges || []).length, scope }
}
