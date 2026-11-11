/**
 * 记忆星图 · 宿主插件
 *
 * 干三件事：
 *  1. 以只读方式把各处记忆库（meow-memory 等）抽出来，建一张带证据的连接图；
 *  2. 在左侧栏给主人一个能看、能点的星云界面（同源 iframe）；
 *  3. 把这张图接进 AI 的检索路径：工具 + 每轮「邻域提示」，
 *     让别的记忆插件检索到 A 的时候，能顺带读出与 A 相连的 B。
 *
 * 只写自己的目录：$DSH_HOME/memory-nebula/
 */
import { registerRoutes, PREFIX, VERSION } from './host/http.js'
import { LiveEngine, liveFacade } from './host/live.js'
import { nebulaHome } from './host/sources.js'
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { clip } from './host/text.js'

/** 插件自己的日志（引擎还没起来时也能写）。 */
function appendLog(line) {
  try {
    const home = nebulaHome()
    mkdirSync(home, { recursive: true })
    appendFileSync(join(home, 'nebula.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export const name = 'memory-nebula'
export const version = VERSION
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection']

/** 每轮注入的稳定部分（进 prompt 缓存前缀，越短越好）。 */
const RULE = [
  '【记忆星图 memory-nebula】你有一张跨工作区记忆网络（不同项目的记忆之间已经算好并验证过关联）。',
  '- 想找记忆时用 nebula_recall(query=…)：它从命中点沿关联扩散，会带回别的项目里真正相关的记忆，每条都给出关联证据。',
  '- 别的记忆工具（meow-memory / hindsight / openviking 等）返回了记忆 id 时，把 id 传给 nebula_recall(memory_ids=[…])，星图会把与它们相连的记忆一并读出——这是「检索 A 连带读出 B」的用法。',
  '- 不确定两条记忆为什么相连：用 nebula_path(a, b) 看它们之间的最短证据链，每一步都带连接类型和权重；这条路走不通就说明它们没有关系。',
  '- 想确认某条记忆的全部上下文（正文、关键词、邻居与每条边的证据、写它时主人说的原话），用 nebula_inspect(id)。',
  '- 发现关联是错的：`nebula_link(action="mute", a, b)` 屏蔽它（重建也不会再连），比 unlink 更彻底；撤销用 action="unmute"。',
  '- 想查记忆库自己的毛病（重复、该更新、关系凑数、超重、没人读、孤立）用 nebula_hygiene()；它只诊断，改不改由你或主人定。',
  '- 别的插件刚喂过记忆、你想补上下文又不想重复：nebula_bridge(memory_ids=[…]) 会挑出强相关但还没读过的邻居。要接新记忆库先看 nebula_sources 的指南；远端记忆服务可用 nebula_ingest 推进来。',
].join('\n')

/** 注入预算：默认值 + $DSH_HOME/memory-nebula/inject.json 覆盖（60 秒缓存）。 */
const INJECT_DEFAULTS = {
  maxRounds: 2,
  maxItems: 4,
  maxChars: 900,
  minWeight: 0.5,
  hops: 1,
  perWorkspace: 2,
  perLevel: 2,
}
let injectCfgCache = { at: 0, value: null }
function injectConfig() {
  const now = Date.now()
  if (injectCfgCache.value && now - injectCfgCache.at < 60000) return injectCfgCache.value
  let value = INJECT_DEFAULTS
  try {
    const file = join(nebulaHome(), 'inject.json')
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (raw && typeof raw === 'object') value = { ...INJECT_DEFAULTS, ...raw }
    }
  } catch {
    /* 配置写坏了就用默认值 */
  }
  injectCfgCache = { at: now, value }
  return value
}

/** 抽会话信息。 */
function sessionOf(context) {
  const header = context?.agent?.session?.header
  const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
  const id = typeof header?.id === 'string' ? header.id : ''
  return { cwd, id }
}

/** 会话账本路径（meow-memory 的写法：非法字符转 %XX）。 */
function ledgerPath(cwd, sessionId) {
  if (!cwd || !sessionId) return ''
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
  return join(cwd, '.dsh-meow', 'sessions', safe + '.json')
}

function readLedger(cwd, sessionId) {
  const file = ledgerPath(cwd, sessionId)
  if (!file || !existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
    return {
      injected: arr(parsed.injected),
      searched: arr(parsed.searched),
      accessed: arr(parsed.accessed),
      written: arr(parsed.written),
      currentProject: typeof parsed.currentProject === 'string' ? parsed.currentProject : '',
    }
  } catch {
    return null
  }
}

/** 数字对齐，纯文本表格。 */
function pad(text, width) {
  const s = String(text ?? '')
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) > 127 ? 2 : 1
  return s + ' '.repeat(Math.max(0, width - w))
}

/**
 * 把命中结果排成给模型看的文本。
 * @param {{hits:any[], query:string, scanned?:number}} res
 * @param {string} [note]
 */
function formatHits(res, note = '') {
  const hits = res?.hits || []
  if (hits.length === 0) {
    return ['nebula_recall: 星图里没有匹配「' + (res?.query || '') + '」的记忆。', note].filter(Boolean).join('\n')
  }
  const lines = []
  lines.push(`nebula_recall「${res.query || ''}」→ ${hits.length} 条（扫描 ${res.scanned || 0} 条候选${note ? '；' + note : ''}）`)
  hits.forEach((h, i) => {
    lines.push(
      `${i + 1}. [${h.level}] ${pad(h.ws, 12)} 强度 ${String(h.score).padEnd(5)} ${clip(h.label || h.title || h.id, 46)}`,
    )
    lines.push(`   id: ${h.id}`)
    if (h.why) lines.push(`   为什么：${h.why}`)
    if (h.preview) lines.push(`   摘要：${clip(h.preview, 150)}`)
  })
  return lines.join('\n')
}

export function apply(ctx) {
  const live = new LiveEngine({ onLog: appendLog })
  const nebula = liveFacade(live)
  const log = appendLog

  // ---------- 启动：后台建图 + 12s 巡检（引擎热载也在 LiveEngine 里） ----------
  live
    .ensure()
    .then(() => log('首次建图完成'))
    .catch((err) => log('首次建图失败：' + (err?.stack || err)))

  ctx.effect(() => {
    return () => {
      try {
        nebula.stopWatching()
      } catch {
        /* ignore */
      }
    }
  }, 'memory-nebula:cleanup')

  // ---------- HTTP + 页面 ----------
  try {
    registerRoutes(ctx.webServer, nebula, log, { mode: 'host', connection: ctx.connection })
    log(`已挂载 ${PREFIX}（页面 ${PREFIX}/app）`)
  } catch (err) {
    log('挂载 webServer 失败：' + (err?.stack || err))
  }

  // ---------- 工具 ----------
  const render = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  const out = { schema: { type: 'string' }, render }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_recall',
      description:
        '在「记忆星图」里检索记忆：先按语义/关键词命中，再沿已算好的关联（同一实体、同项目、同关键词、共激活、语义相似）向外扩散，把别的项目里真正相关的记忆一起带回来，并给出每一层的关联证据。适合跨项目回忆、找「和这件事有关但记在别处」的东西。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '自然语言描述或关键词。只给 memory_ids 时可以为空。' },
          memory_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '别的记忆工具刚返回的记忆 id（meow 的 id 或星图的完整 id），用来从这些点向外交扩散。',
          },
          limit: { type: 'number', description: '返回条数，默认 10，上限 30。' },
          hops: { type: 'number', description: '扩散跳数，默认 2；1=只看直接邻居，2=邻居的邻居。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        if (!nebula.graph || nebula.graph.nodes.length === 0) await nebula.refresh()
        const query = String(args.query || '').trim()
        const ids = Array.isArray(args.memory_ids) ? args.memory_ids.filter((x) => typeof x === 'string' && x.trim()) : []
        if (!query && ids.length === 0) return 'nebula_recall 需要 query 或 memory_ids 至少一个。'
        const limit = Math.max(1, Math.min(30, Number(args.limit) || 10))
        const hops = Math.max(0, Math.min(3, Number(args.hops) || 2))
        const res = nebula.recall(query, { limit, hops, seedIds: ids })
        return formatHits(res, ids.length ? `种子来自你给的 ${ids.length} 条记忆 id` : '')
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_inspect',
      description:
        '看一条记忆在星图里的完整上下文：全文、项目、关键词，以及它连接到的每一条记忆和「为什么相连」的证据。用来验证关联是否可信，或顺着一条记忆摸清一整片。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆 id（星图完整 id，或 meow-memory 的裸 id）。' },
          neighbors: { type: 'number', description: '最多列出多少条邻居，默认 12。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        const id = String(args.id || '').trim()
        if (!id) return 'nebula_inspect 需要 id。'
        const d = nebula.detail(id)
        if (!d) return `星图里没有 id=${id} 的记忆。可以先用 nebula_recall 搜一下。`
        const max = Math.max(1, Math.min(40, Number(args.neighbors) || 12))
        const lines = [
          `# ${d.title || d.label}`,
          `层级 ${d.level} · 工作区 ${d.wsTitle} · 项目 ${d.project || '—'} · 重要性 ${d.importance} · 连接 ${d.degree || (d.neighbors || []).length}`,
          `id: ${d.id}`,
          '',
          clip(d.content, 1600),
          '',
        ]
        if ((d.keywords || []).length) lines.push('关键词：' + d.keywords.join('、'), '')
        const nbrs = (d.neighbors || []).slice(0, max)
        lines.push(`## 连接到的记忆（${nbrs.length}/${(d.neighbors || []).length}）`)
        for (const n of nbrs) {
          lines.push(`- [${n.type} ${(n.weight ?? n.w ?? 0).toFixed(2)}] ${n.label}  ·  ${n.ws}  ·  ${n.level}`)
          lines.push(`  id: ${n.id}`)
          if (n.why) lines.push(`  证据：${n.why}`)
        }
        return lines.join('\n')
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_link',
      description:
        '人工校正星图连接：action="link" 把两条记忆固化成一条手工连线（永不剪掉）；action="unlink" 断开一条手工连线；' +
        'action="mute" 屏蔽一条**推断错了**的自动关联（记进黑名单，之后每次重建都不会再连它）；action="unmute" 撤销屏蔽。' +
        '改动只写进星图自己的库，不会动任何原记忆。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['link', 'unlink', 'mute', 'unmute'],
            description: 'link=固化连线；unlink=断开手工连线；mute=屏蔽错误的自动关联；unmute=撤销屏蔽',
          },
          a: { type: 'string', description: '记忆 A 的 id' },
          b: { type: 'string', description: '记忆 B 的 id' },
          note: { type: 'string', description: '理由（可选，建议写，方便以后回看为什么连/为什么屏蔽）' },
        },
        required: ['action', 'a', 'b'],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        const action = String(args.action || '').trim()
        const a = String(args.a || '').trim()
        const b = String(args.b || '').trim()
        if (!a || !b) return '需要 a 和 b 两条记忆 id。'
        if (action === 'link') {
          const r = nebula.link(a, b, String(args.note || ''))
          await nebula.refresh({ force: true })
          return `已固化连线：${r.a} ↔ ${r.b}${r.note ? '（' + r.note + '）' : ''}`
        }
        if (action === 'unlink') {
          const ok = nebula.unlink(a, b)
          await nebula.refresh({ force: true })
          return ok ? `已断开：${a} ✕ ${b}` : '没有找到这条手工连线（可能本来就是断的，或 id 不对）。'
        }
        if (action === 'mute') {
          const r = nebula.mute(a, b, String(args.note || ''))
          await nebula.refresh({ force: true })
          return `已屏蔽这条关联：${r.a} ✕ ${r.b}（以后重建不会再连；要撤销用 action="unmute"）`
        }
        if (action === 'unmute') {
          const ok = nebula.unmute(a, b)
          await nebula.refresh({ force: true })
          return ok ? `已撤销屏蔽：${a} ↔ ${b}（下次重建会重新按证据连）` : '这一对本来就没有被屏蔽。'
        }
        return 'action 只能是 link / unlink / mute / unmute。'
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_path',
      description:
        '解释两条记忆之间「到底怎么连上的」：在星图里找一条代价最小的证据链（优先走权重高的边），' +
        '逐步列出每一步的连接类型、权重和证据。找不到就说明这两条在星图里没有关系——不会硬凑。' +
        '用来核对推断是否合理，或回答「这条记忆和那个项目有什么干系」。',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'string', description: '起点记忆 id' },
          b: { type: 'string', description: '终点记忆 id' },
          maxHops: { type: 'number', description: '最多几跳，默认 6' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        const a = String(args.a || '').trim()
        const b = String(args.b || '').trim()
        if (!a || !b) return '需要 a 和 b 两个 id。'
        const r = await nebula.path(a, b, { maxHops: Number(args.maxHops) || 6 })
        if (!r || !r.found) {
          return `这两条记忆在星图里没有连上（${r?.error || '超过 ' + (Number(args.maxHops) || 6) + ' 跳'}）。没有关系就不编关系。`
        }
        if (!r.hops) return '是同一条记忆。'
        const lines = [`${r.nodes[0].label} ⇢ ${r.nodes[r.nodes.length - 1].label}：${r.hops} 跳，链强度 ${r.score}`, '']
        for (let i = 0; i < r.edges.length; i += 1) {
          const e = r.edges[i]
          const from = r.nodes[i]
          const to = r.nodes[i + 1]
          lines.push(`${i + 1}. ${from.label}`)
          lines.push(`   ↳ [${e.t}] ${e.w} · ${e.why}`)
          lines.push(`   → ${to.label}`)
        }
        lines.push('', '每一步都来自建图时算出的边；如果某一步你觉得不该连，用 nebula_link(action="mute") 把它按掉。')
        return lines.join('\n')
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_stats',
      description: '看记忆星图的整体状况：多少条记忆、多少条连接、各工作区分布、连接类型分布、以及连接最多的枢纽记忆。',
      parameters: {
        type: 'object',
        properties: {
          hubs: { type: 'number', description: '列多少个枢纽，默认 10。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        if (!nebula.graph || nebula.graph.nodes.length === 0) await nebula.refresh()
        const o = nebula.overview()
        const s = o.stats || {}
        const top = o.hubs.slice(0, Math.max(1, Math.min(40, Number(args.hubs) || 10)))
        const lines = [
          `记忆星图：${s.nodes} 条记忆 / ${s.edges} 条连接 / ${s.workspaces} 个工作区 / ${s.sessions} 个会话账本`,
          `平均连接度 ${(s.avgDegree || 0).toFixed(2)}，孤立记忆 ${s.orphans} 条，构建耗时 ${o.buildMs}ms`,
          '',
          '工作区：' + o.workspaces.map((w) => `${w.name}(${w.count})`).join('  '),
          '层级：' + Object.entries(o.levels || {}).map(([k, v]) => `${k}(${v})`).join('  '),
          '连接类型：' + Object.entries(o.edgeTypes || {}).map(([k, v]) => `${k}(${v})`).join('  '),
          '',
          '枢纽记忆：',
        ]
        for (const h of top) lines.push(`- [${h.level}] ${h.label} · ${h.ws} · 连接 ${h.degree} · 重要性 ${h.importance}`)
        if (o.lastError) lines.push('', '最近一次错误：' + o.lastError)
        return lines.join('\n')
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_hygiene',
      description:
        '记忆体检：把六类失效模式查出来给你——疑似重复、该更新了、关系是凑的、超重、没人读过、孤立。只诊断不改任何记忆；要不要合并、删掉、补连接由你或主人决定。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan'],
            description: '只看某一类；不传就返回全部概览。',
          },
          limit: { type: 'number', description: '每类最多列多少条，默认 6。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        if (!nebula.graph || nebula.graph.nodes.length === 0) await nebula.refresh()
        const h = nebula.hygiene()
        const items = h.items || {}
        const limit = Math.max(1, Math.min(20, Number(args.limit) || 6))
        const NAME = {
          dup: '疑似重复',
          stale: '该更新了',
          thin: '关系是凑的',
          oversize: '超重',
          unread: '没人读过',
          orphan: '孤立',
        }
        const kinds = args.kind ? [args.kind] : Object.keys(NAME)
        const lines = [`记忆体检：共 ${h.total} 项（只诊断，不动任何记忆）`]
        for (const k of kinds) {
          const arr = items[k] || []
          if (!arr.length) {
            lines.push('', `${NAME[k]}（0）`)
            continue
          }
          lines.push('', `${NAME[k]}（${arr.length}）`)
          for (const it of arr.slice(0, limit)) {
            if (k === 'dup' && it.a && it.b) {
              lines.push(`- ${(it.a.label || '').slice(0, 40)} ⇄ ${(it.b.label || '').slice(0, 40)}（相似 ${it.sim}）`)
              lines.push(`  A: ${it.a.id}`)
              lines.push(`  B: ${it.b.id}`)
              continue
            }
            const extra = k === 'oversize' ? ` · ${it.size} 字` : k === 'thin' ? ` · 度 ${it.degree} 均权 ${it.avg}` : ''
            lines.push(`- [${it.level || ''}] ${(it.label || '').slice(0, 50)} · ${it.ws || ''}${extra}`)
            lines.push(`  ${it.id}`)
          }
          if (arr.length > limit) lines.push(`  …还有 ${arr.length - limit} 条`)
        }
        lines.push('', '要动手就按 id 来：合并/改写属于别人的记忆库，先问主人；星图这边只提供 nebula_link(action="mute") 断掉错误关联。')
        return lines.join('\n')
      },
    }),
  )

  // ---------- 跨插件协同：补充包 / 来源体检 / 外部推送 ----------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_bridge',
      description:
        '跨记忆插件的「补充包」。把别的记忆插件刚注入或刚检索到的记忆 id 交给星图，它沿已算好的关联扩散一跳，去掉已经注入过的，按预算挑出 2~4 条「强相关但还没讲过」的记忆。适合：你刚用 meow-memory / hindsight / openviking 检索过，想知道还有什么该一起读；或你只想补上下文，不想重复读同一批。',
      parameters: {
        type: 'object',
        properties: {
          memory_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '种子记忆 id（任意插件的完整 id 或裸 id 都行）。',
          },
          query: { type: 'string', description: '没有 memory_ids 时，用查询词找种子。' },
          limit: { type: 'number', description: '最多返回几条，默认 4。' },
          chars: { type: 'number', description: '文本预算（字符），默认 900。' },
          min_weight: { type: 'number', description: '最低关联权重，默认 0.5。' },
          hops: { type: 'number', description: '扩散跳数，默认 1。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        if (!nebula.graph || nebula.graph.nodes.length === 0) await nebula.refresh()
        const ids = Array.isArray(args.memory_ids) ? args.memory_ids.filter((x) => typeof x === 'string' && x.trim()) : []
        const query = String(args.query || '').trim()
        if (ids.length === 0 && !query) return 'nebula_bridge 需要 memory_ids 或 query 至少一个。'
        const res = nebula.bridge({
          ids,
          query,
          mark: true,
          budget: {
            maxItems: Math.max(1, Math.min(12, Number(args.limit) || 4)),
            maxChars: Math.max(200, Math.min(4000, Number(args.chars) || 900)),
            minWeight: Math.max(0, Math.min(1, Number(args.min_weight) || 0.5)),
            hops: Math.max(0, Math.min(2, Number(args.hops) ?? 1)),
          },
        })
        if (!res || !res.items?.length) {
          return `nebula_bridge：没有可补充的邻居（种子 ${res?.stats?.seedCount ?? 0} 条，候选 ${res?.stats?.considered ?? 0} 条都已读过或在冷却期）。`
        }
        return [
          `nebula_bridge：从 ${res.stats.seedCount} 条种子扩散，候选 ${res.stats.considered} 条，选出 ${res.items.length} 条（${res.stats.chars} 字）`,
          res.text,
        ].join('\n')
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_sources',
      description:
        '记忆来源体检 + 接入指南。列出星图现在接了哪些记忆库（meow / 笔记目录 / 任意 SQLite / 外部推送）、各自读到多少条、配置文件在哪、有哪些适配器可用。要接入一个新的记忆插件时先调它，按返回的 hint 填配置即可；改完再调一次确认。',
      parameters: {
        type: 'object',
        properties: {
          verbose: { type: 'boolean', description: '是否列出每个适配器的配置字段说明，默认 false。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        const r = nebula.sourcesReport ? nebula.sourcesReport() : null
        if (!r) return '星图引擎还没起来（等宿主重启后生效）。'
        const lines = []
        lines.push(`配置：${r.config.path}${r.config.exists ? '' : '（还没有，可新建）'}${r.config.error ? ' · 读坏了：' + r.config.error : ''}`)
        lines.push(`自动探测：${r.config.autoDetect ? '开' : '关'}`)
        lines.push('')
        lines.push(`已接入 ${r.live.stores.length} 个来源，共读到 ${r.live.nodes} 条记忆：`)
        for (const s of r.live.stores) {
          lines.push(`- [${s.adapter}] ${s.title} · ${s.size ? Math.round(s.size / 1024) + 'KB' : '—'}${s.hasSessions ? ' · 有会话账本' : ''}`)
          lines.push(`  ${s.path}`)
        }
        if (r.graph) {
          lines.push('')
          lines.push(`星图：${r.graph.nodes} 节点 / ${r.graph.edges} 边 / ${r.graph.workspaces} 工作区 / ${r.graph.sessions} 会话`)
        }
        if (r.live.errors?.length) {
          lines.push('')
          lines.push('读取失败：')
          for (const e of r.live.errors) lines.push(`- ${e.store || e.adapter}：${e.error}`)
        }
        lines.push('')
        lines.push('可用适配器：')
        for (const a of r.adapters) {
          lines.push(`- ${a.id}（${a.kind}）${a.name}：${a.description}`)
          if (args.verbose !== false && a.config && Object.keys(a.config).length > 0) {
            for (const [k, v] of Object.entries(a.config)) lines.push(`    ${k}: ${v}`)
          }
        }
        lines.push('')
        lines.push(r.hint)
        return lines.join('\n')
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_ingest',
      description:
        '把外部记忆推入星图。给「记忆不在本地落盘」的服务用（远端 hindsight / openviking / 或任何 API-only 记忆插件）：把条目推过来，它们就进同一张图，和 meow 的记忆一起参与关联与注入。同 uid 后写覆盖，重复推送不会长重影。',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: '来源名，例如 hindsight / openviking / my-memory。' },
          items: {
            type: 'array',
            description: '记忆条目。至少给 title 或 content。',
            items: {
              type: 'object',
              properties: {
                uid: { type: 'string', description: '稳定 id；不给就按内容哈希。' },
                title: { type: 'string' },
                content: { type: 'string' },
                level: { type: 'string', description: 'soul / user / project / fact / lesson / topic / rules / note' },
                keywords: { type: 'array', items: { type: 'string' } },
                project: { type: 'string' },
                importance: { type: 'number' },
                status: { type: 'string' },
                ws: { type: 'string', description: '归属工作区名（展示用）。' },
                createdAt: { type: 'number', description: '毫秒时间戳。' },
              },
              additionalProperties: true,
            },
          },
        },
        required: ['provider', 'items'],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        const provider = String(args.provider || '').trim()
        const items = Array.isArray(args.items) ? args.items : []
        if (!provider) return 'nebula_ingest 需要 provider。'
        if (items.length === 0) return 'nebula_ingest 需要至少一条 items。'
        const res = await nebula.ingest(provider, items)
        return [
          `已推入 ${res.written} 条 → ${res.file}`,
          res.graph ? `星图现在是 ${res.graph.nodes} 节点 / ${res.graph.edges} 边` : '重建未完成（下次请求时生效）',
        ].join('\n')
      },
    }),
  )

  // ---------- 每轮注入：稳定规则 + 本会话「该被连带读出」的邻居 ----------
  //
  // 这里是「和其他记忆插件有选择地一同注入」的落点：
  //   1. 读 meow 账本（别的插件喂过什么）→ 得到种子；
  //   2. 交给 bridge 沿星图扩散 → 去掉已见/冷却中的 → 按预算挑几条；
  //   3. 注入后记账（本会话 + 全局冷却），下一轮不会重复。
  // 节流：每会话最多 maxRounds 批；后续批次要求「本轮新读到的记忆比上批多 3 条」，
  // 否则同一批补充会在每轮请求里反复膨胀上下文。
  const injectState = new Map() // sessionId → { rounds, seenSize }

  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'memory-nebula:neighbors',
      order: 960,
      text: (context) => {
        const base = RULE
        try {
          const { cwd, id: sessionId } = sessionOf(context)
          if (!sessionId) return base
          if (typeof nebula.bridge !== 'function') return base
          if (!nebula.graph || nebula.graph.nodes.length === 0) return base
          const cfg = injectConfig()
          const state = injectState.get(sessionId) || { rounds: 0, seenSize: 0 }
          if (state.rounds >= cfg.maxRounds) return base

          const ledger = readLedger(cwd, sessionId)
          const seen = new Set()
          for (const key of ['injected', 'searched', 'accessed', 'written']) {
            for (const v of ledger?.[key] || []) {
              const s = String(v || '').trim()
              if (!s) continue
              seen.add(s)
              const parts = s.split(':')
              if (parts.length > 1) seen.add(parts[parts.length - 1])
            }
          }
          if (seen.size === 0) return base
          if (state.rounds > 0 && seen.size - state.seenSize < 3) return base

          // 账本可能很长：只取最近 40 条当种子，避免每轮做 O(n·m) 的 id 对齐
          const ids = [...seen].slice(-40)
          const res = nebula.bridge({
            ids,
            seen,
            sessionId,
            ws: cwd,
            budget: {
              maxItems: cfg.maxItems,
              maxChars: cfg.maxChars,
              minWeight: cfg.minWeight,
              hops: cfg.hops,
              perWorkspace: cfg.perWorkspace,
              perLevel: cfg.perLevel,
            },
            mark: true,
          })
          if (!res || !Array.isArray(res.items) || res.items.length === 0) {
            injectState.set(sessionId, { rounds: state.rounds, seenSize: seen.size })
            return base
          }
          injectState.set(sessionId, { rounds: state.rounds + 1, seenSize: seen.size })
          log(`邻域补充 ${res.items.length} 条（会话 ${sessionId.slice(0, 8)} 第 ${state.rounds + 1} 批）`)
          return [
            base,
            '',
            '【与本会话已读记忆相连、但还没读过的】星图挑了下面这些（要细节用 nebula_inspect(id) 或 nebula_recall(memory_ids=[…])）：',
            res.text,
          ].join('\n')
        } catch (err) {
          log('邻域提示失败：' + (err?.message || err))
          return base
        }
      },
    }),
  )

  log(`记忆星图已启动：${live.instance?.stores?.length ?? 0} 个记忆库候选`)
}
