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
import { createHash } from 'node:crypto'
import { auditHygiene, auditHygieneAsync } from './graph.js'

// NEBULA_SHARE_PROFILE=1 时把切片与拼装的分段耗时打去 stderr。
// 导出慢的时候先问「慢在哪一段」，别拿总时长猜。
let shareT0 = 0
const shareTick = (label) => {
  if (process.env.NEBULA_SHARE_PROFILE) console.error('[share] ' + label + ' +' + (Date.now() - shareT0) + 'ms')
}

const WEB = new URL('../web/', import.meta.url)
const MAX_HOPS = 5
// 快照分片：5 万条的整库快照单文件会到 40MB 上下，双击打开先卡半分钟。
// 默认只写前 2 万条（按重要度），其余分片导出；上限仍允许到 5 万，想全量得显式传 limit。
export const SHARE_NODE_CAP = 20000
export const SHARE_NODE_MAX = 50000
/** 快照里的边按列存，省掉 15 万条边重复的键名。客户端 api.js 会按列展开。 */
const EDGE_COLUMNS = ['s', 'd', 'w', 't', 'curated']

function packEdgeRows(edges) {
  return (edges || []).map((e) => EDGE_COLUMNS.map((key) => (e[key] === undefined ? null : e[key])))
}

/** 节点也按列存：20k 节点的字段名重复 20k 次，是快照体积的大头。 */
function packNodeRows(nodes) {
  const columns = []
  const seen = new Set()
  for (const node of nodes || []) {
    for (const key of Object.keys(node || {})) {
      if (seen.has(key)) continue
      seen.add(key)
      columns.push(key)
    }
  }
  const rows = (nodes || []).map((node) => columns.map((key) => (node[key] === undefined ? null : node[key])))
  return { columns, rows }
}

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
 * 解析 ?limit=（快照分片上限）。不传就是默认 2 万条；
 * 拼错直接 400，不静默回落到默认值——导出前的裁剪数量被悄悄改掉，
 * 用户会以为「整库都在这份文件里」。
 * @param {string|number|null} raw
 */
export function parseShareLimit(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return SHARE_NODE_CAP
  if (!/^\d+$/.test(text)) throw fail(400, 'limit 需要 1–' + SHARE_NODE_MAX + ' 的整数，收到的是「' + text + '」')
  const n = Number(text)
  if (!Number.isFinite(n) || n < 1) throw fail(400, 'limit 需要 1–' + SHARE_NODE_MAX + ' 的整数')
  if (n > SHARE_NODE_MAX) {
    throw fail(400, 'limit 最多 ' + SHARE_NODE_MAX + ' 条；更大的库请按工作区切片，分几份导出')
  }
  return n
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
  const { dbPath, db, lastError, readErrors, ...rest } = ov || {}
  // 读不动的库要留在快照里（不然拿到文件的人不知道少了哪一块），
  // 但本机路径不能跟着出去：只留名字、标题与原因。
  const safeReadErrors = (readErrors || []).map((e) => ({
    key: e?.key || '',
    title: e?.title || e?.key || '',
    error: e?.error || '',
  }))
  return { ...rest, sources: publicSources(rest.sources), readErrors: safeReadErrors }
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
/**
 * 体检的入参：把切片节点还原成原始记忆（要正文与关键词），边换成下标。
 * 只备料不算账——算账那一步必须留在两个壳里，不然同步体检会把事件循环按住 3 秒。
 */
function hygieneArgsFor(nodes, edges, rawById) {
  return {
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
    edges: edges.map((e) => ({ s: e.s, d: e.d, w: e.w, type: e.t || e.type })),
    nodeIds: nodes.map((n) => n.id),
  }
}

function buildShareSlice(nebula, scope = null, opts = {}) {
  shareT0 = Date.now()
  // 必须拿整张图，不能拿默认的第一页：publicGraph() 对大库只会给前 1 万条，
  // 于是「整张星图」的快照里其实只有 1 万条，而 scope.trimmed 还是 null（看起来没裁）。
  // 5 万条的库上这条 bug 让 8.65MB 的快照只装了两成记忆，且毫无提示。
  const full = nebula.publicGraph({ all: true })
  shareTick('publicGraph(all)')
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
  // 但超过分片上限时不能走这条「原样」：那会绕过裁剪，把 40MB 全塞进一个文件。
  if (!scope && !rules.length && (full.nodes || []).length <= parseShareLimit(opts.limit)) {
    const ov = nebula.overview({ hygiene: false })
    const nodes = (full.nodes || []).map(withContent)
    return {
      payload: {
        graph: { ...full, sources: publicSources(full.sources), nodes },
        overview: publicOverview(ov),
        scope: { kind: 'all', value: '', label: '整张星图', hops: 0, hidden: 0, hide: [], trimmed: null },
      },
      // 整库视图不重算：直接按整库节点算一遍体检（异步壳上照样分片）
      hygieneArgs: hygieneArgsFor(nodes, full.edges || [], rawById),
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

  // 快照分片：范围选好之后再按上限裁一次。
  // 5 万条的整库快照单文件 40MB 上下，双击打开会先卡住；这里按重要度取前 N 条，
  // 并把「裁了多少」写进标签与 scope.trimmed —— 用户打开必须一眼看出这不是全量。
  const limit = parseShareLimit(opts.limit)
  const keptTotal = keep.size
  let trimmed = null
  if (keptTotal > limit) {
    const ranked = [...keep]
      .sort((ia, ib) => {
        const a = full.nodes[ia]
        const b = full.nodes[ib]
        return (
          (b.importance || 0) - (a.importance || 0) ||
          (b.hits || 0) - (a.hits || 0) ||
          (b.createdAt || 0) - (a.createdAt || 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        )
      })
      .slice(0, limit)
    keep = new Set(ranked)
    trimmed = { cap: limit, total: keptTotal, shown: keep.size, by: 'importance' }
  }

  const oldToNew = new Map()
  const nodes = []
  for (let i = 0; i < full.nodes.length; i++) {
    if (!keep.has(i)) continue
    oldToNew.set(i, nodes.length)
    nodes.push(withContent(full.nodes[i]))
  }

  shareTick('nodes ' + nodes.length)
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

  shareTick('edges ' + edges.length)
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

  shareTick('clusters ' + clusters.length)
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
  // 只准备入参，算留给调用方：2 万条的重复检测要 3 秒，同步算完就把事件循环按住了，
  // 所以同步壳用 auditHygiene、异步壳（HTTP / 快照导出）用 auditHygieneAsync。
  const hygieneArgs = hygieneArgsFor(nodes, edges, rawById)

  const baseOverview = nebula.overview({ hygiene: false })
  shareTick('overview base')
  const baseLabel = !scope
    ? '整张星图'
    : scope.kind === 'ws'
      ? '工作区 · ' + (nodes[0]?.ws || scope.value)
      : scope.kind === 'project'
        ? '项目 · ' + scope.value
        : '以「' + (nodes.find((n) => n.id === scope.value)?.label || scope.value) + '」为中心 · ' + hops + ' 跳'
  const label =
    baseLabel +
    (hidden ? ' · 已隐去 ' + hidden + ' 条' : '') +
    (trimmed ? ' · 已裁剪 ' + trimmed.shown + ' / ' + trimmed.total + ' 条' : '')
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
    hygiene: null, // 由两个壳算完再填：算一次要 3 秒（2 万条），不能挡在这里
    // 下面三块是「整库视角」的摘要；切片里留空，免得把全库结论带进局部快照。
    cards: null,
    truth: { total: 0, groups: [], scoped: true },
    externals: null,
  }

  return {
    payload: {
      graph: { ...full, sources: publicSources(full.sources), nodes, edges, clusters, stats },
      overview,
      scope: {
        kind: scope?.kind || 'all',
        value: scope?.value || '',
        label,
        hops: scope?.kind === 'focus' ? hops : 0,
        hidden,
        hide: rules.map((r) => r.kind + ':' + r.value),
        trimmed,
      },
    },
    hygieneArgs,
  }
}

/**
 * 切片快照（同步壳）：体检同步算完。MCP 工具与单测走这条。
 * @param {import('./nebula.js').Nebula} nebula
 * @param {null|{kind:string,value:string}} [scope]
 * @param {{hops?:number|string, hide?:string|string[], limit?:number|string}} [opts]
 */
export function sliceShareGraph(nebula, scope = null, opts = {}) {
  const { payload, hygieneArgs } = buildShareSlice(nebula, scope, opts)
  if (hygieneArgs) payload.overview.hygiene = auditHygiene(hygieneArgs)
  return payload
}

/**
 * 切片快照（异步壳）：体检按 6ms 一片算，让出事件循环。HTTP / 导出走这条。
 */
export async function sliceShareGraphAsync(nebula, scope = null, opts = {}) {
  const { payload, hygieneArgs } = buildShareSlice(nebula, scope, opts)
  if (hygieneArgs) payload.overview.hygiene = await auditHygieneAsync(hygieneArgs)
  return payload
}

/**
 * 生成快照 HTML。
 * @param {import('./nebula.js').Nebula} nebula
 * @param {{version?:string, build?:number}} [meta]
 * @param {{scope?:null|{kind:string,value:string}, hops?:number|string, hide?:string|string[], limit?:number|string}} [opts]
 */
export async function buildShareHtml(nebula, meta = {}, opts = {}) {
  shareT0 = Date.now()
  // 走异步壳：体检（2 万条要 3 秒）分片算，导出期间 HTTP 事件循环照常回声。
  const { graph, overview, scope } = await sliceShareGraphAsync(nebula, opts.scope || null, {
    hops: opts.hops,
    hide: opts.hide,
    limit: opts.limit,
  })
  const nodes = graph.nodes || []
  shareTick('slice')
  const packedNodes = packNodeRows(nodes)
  shareTick('pack')
  const payload = {
    version: meta.version || '',
    build: meta.build || 0,
    builtAt: Date.now(),
    sig: (nebula.signature || '') + '-snapshot',
    scope: { ...scope, nodes: nodes.length, edges: (graph.edges || []).length },
    graph: {
      ...graph,
      nodes: packedNodes.rows,
      nodeColumns: packedNodes.columns,
      edges: packEdgeRows(graph.edges),
      edgeColumns: EDGE_COLUMNS,
    },
    overview,
    inventory: graph.inventory || null,
  }

  const [html, css, api, nav, i18n, render, space3d, app] = await Promise.all(
    ['index.html', 'style.css', 'api.js', 'nav.js', 'i18n.js', 'render.js', 'space3d.js', 'app.js'].map((name) =>
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
    ['nav.js', nav],
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
  //
  // 校验和（1.11.0）：快照会被聊天软件改写、被网盘截断、被编辑器重存成别的编码。
  // 数据以 `<script type="application/json">` 的原始文本存下来，导出时对**这段文本**
  // 算 sha256；客户端拿到的是同一段文本，能一对一比对——不靠重新序列化，也就不会
  // 因为键序或数字格式不同而误报。`<` 已被 safeJson 转义，不会提前闭合 script。
  const dataText = safeJson(payload)
  shareTick('safeJson ' + Math.round(dataText.length / 1048576) + 'MB')
  const dataBytes = Buffer.byteLength(dataText, 'utf8')
  const dataSha = createHash('sha256').update(dataText, 'utf8').digest('hex')
  const bootScript =
    '<script type="application/json" id="nebula-snapshot-data">' +
    dataText +
    '</script>\n' +
    '<script>window.__NEBULA_SNAPSHOT_DATA_TEXT__ = document.getElementById("nebula-snapshot-data").textContent;\n' +
    'try { window.__NEBULA_SNAPSHOT__ = JSON.parse(window.__NEBULA_SNAPSHOT_DATA_TEXT__) }\n' +
    'catch (err) { window.__NEBULA_SNAPSHOT__ = null; window.__NEBULA_SNAPSHOT_BROKEN__ = String((err && err.message) || err) }\n' +
    'window.__NEBULA_SNAPSHOT_INTEGRITY__ = { algo: "sha256", bytes: ' +
    dataBytes +
    ', sha256: "' +
    dataSha +
    '" };</script>'
  out = put(out, '<body>', '<body>\n' + bootScript, ' <body>')
  // 裁剪过的快照必须在画面上说清楚：用户打开文件看到 12 个点，
  // 不能让他以为整库就这 12 条。这条提示是纯静态的，脚本没跑起来也在。
  if (scope.trimmed) {
    const note =
      '这是一份裁剪过的离线快照：已写入 ' +
      scope.trimmed.shown +
      ' / ' +
      scope.trimmed.total +
      ' 条（按重要度与访问量取前 ' +
      scope.trimmed.cap +
      ' 条）。完整数据请按工作区分片导出。'
    out = put(
      out,
      '<body>',
      '<body>\n<div id="snapshot-trim" role="note" style="position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:60;max-width:min(92vw,720px);padding:8px 14px;border-radius:999px;background:rgba(20,32,48,.92);border:1px solid rgba(120,170,220,.35);color:#cfe6f5;font:12px/1.5 system-ui;text-align:center">' +
        note +
        '</div>',
      ' 裁剪提示',
    )
  }

  // 快照的诚实性有两件事要说：裁过多少条（上面那条），以及**有没有库根本读不动**。
  // 读不动的库在图上只是「少了」，导出给别人之后没人知道少了什么——所以这里单独立一条。
  const readErrors = (overview.readErrors || []).filter((e) => e && e.error)
  if (readErrors.length) {
    const names = readErrors.map((e) => e.key || e.title || '?').join(' / ')
    const note =
      '这份快照里有 ' +
      readErrors.length +
      ' 个来源读不动：' +
      names +
      '。它们的记忆没有进图（' +
      String(readErrors[0].error).slice(0, 120) +
      '）。'
    out = put(
      out,
      '<body>',
      '<body>\n<div id="snapshot-readerr" role="note" style="position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:60;max-width:min(92vw,760px);padding:8px 14px;border-radius:10px;background:rgba(48,20,24,.94);border:1px solid rgba(255,150,150,.4);color:#ffd9d9;font:12px/1.5 system-ui;text-align:center">' +
        note +
        '</div>',
      ' 读不动提示',
    )
  }

  // 快照自己的界面提示（app.js 也会画一条；这里保证脚本没跑起来时也说得清）
  out = out.replace(    '<div id="boot" role="status" aria-live="polite">',
    () => '<noscript><div style="position:fixed;inset:0;display:grid;place-items:center;background:#04060c;color:#cfe6f5;font:13px system-ui;z-index:99">这是一份离线快照，需要启用 JavaScript 才能点亮星图。</div></noscript>\n  <div id="boot" role="status" aria-live="polite">',
  )

  const bytes = Buffer.byteLength(out, 'utf8')
  return { html: out, bytes, nodes: nodes.length, edges: (graph.edges || []).length, scope }
}
