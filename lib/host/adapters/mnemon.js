/**
 * 适配器：mnemon —— dsh-mnemon 的项目档案
 *
 * dsh-mnemon 把「项目档案」落成一批 markdown：
 *
 *   $DSH_HOME/.mnemon/documents/active/<slug>-<id>.md
 *
 *   ---
 *   id: doc_xxxx
 *   title: 一页纸说明
 *   description: 一句话摘要
 *   status: active
 *   created_at: 2026-10-26T13:14:27.061Z
 *   updated_at: 2026-11-25T08:43:10.467Z
 *   content_hash: sha256:...
 *   source_paths: ["docs/a.md"]
 *   ---
 *   正文……
 *
 * 这些文件本来就是「一篇文档 = 一条记忆」，所以不借用 notes 适配器的
 * 通用猜测，而是直接用它们自己的字段契约：id（稳定，用来做 uid，
 * 文档改写后节点 id 不变，屏蔽/连线不会丢）、description（正文为空时的摘要）、
 * source_paths（派生关键词，让同一批文件的档案连成一片）。
 *
 * 只读。目录不存在就返回空，不报错 —— 没装 mnemon 的人看不出任何变化。
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import {
  deriveKeywords,
  dirExists,
  dshHome,
  expandHome,
  firstLine,
  hashShort,
  parseFrontmatter,
  readTextSafe,
  slugKey,
  stem,
  toKeywordList,
  toMs,
  walkFiles,
} from './util.js'

const DEFAULT_SUBDIR = join('.mnemon', 'documents', 'active')
const DEFAULT_EXTS = ['.md', '.markdown']

export const meta = {
  id: 'mnemon',
  name: 'Mnemon 项目档案',
  kind: 'files',
  description:
    '读 dsh-mnemon 的项目档案（默认 $DSH_HOME/.mnemon/documents/active 下的 markdown，一篇文档算一条记忆）。认它自己的 frontmatter：id / title / description / status / created_at / updated_at / source_paths。',
  config: {
    path: '可选。档案目录，默认 $DSH_HOME/.mnemon/documents/active（支持 ~ 开头）。',
    title: '展示名，默认 Mnemon 项目档案。',
    level: '默认层级，默认 project。',
    maxFiles: '最多读多少个文件，默认 4000。',
    maxDepth: '目录递归深度，默认 2（档案目录是平的）。',
    deriveKeywords: '设为 true 时，没有 source_paths / tags 的档案从标题与一至三级标题里抽关键词（默认关）。',
  },
}

/** 档案目录：配置优先，否则 $DSH_HOME/.mnemon/documents/active。 */
function archiveDir(config = {}) {
  const raw = String(config.path || '').trim()
  if (raw) return expandHome(raw)
  return join(dshHome(), DEFAULT_SUBDIR)
}

/**
 * 找出可读的档案目录。
 * @param {{path?:string,title?:string,id?:string}} config
 */
export function detect(config = {}) {
  const path = archiveDir(config)
  if (!path || !dirExists(path)) return []
  const exts = Array.isArray(config.exts) && config.exts.length ? config.exts : DEFAULT_EXTS
  const cap = Math.min(20000, Number(config.maxFiles) || 4000)
  const stats = {}
  const files = walkFiles(path, {
    exts,
    maxDepth: Number(config.maxDepth) || 2,
    maxFiles: cap,
    stats,
  })
  if (files.length === 0) return []
  let size = 0
  let mtimeMs = 0
  for (const f of files) {
    size += f.size
    mtimeMs = Math.max(mtimeMs, Math.round(f.mtimeMs))
  }
  const title = String(config.title || '').trim() || 'Mnemon 项目档案'
  return [
    {
      id: 'mnemon:' + (config.id || slugKey(title)),
      provider: String(config.provider || 'mnemon'),
      adapter: 'mnemon',
      title,
      path,
      key: slugKey(title, 'mnemon'),
      size,
      mtimeMs,
      fileCount: files.length,
      truncated: Boolean(stats.truncated),
      maxFiles: cap,
      config,
    },
  ]
}

/** source_paths → 关键词：取文件名本体（不带目录、不带扩展名），最多 6 个。 */
function keywordsFromPaths(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;]/) : []
  const out = []
  for (const item of list) {
    const text = String(item || '').trim()
    if (!text) continue
    const base = text.split(/[\\/]/).filter(Boolean).pop() || text
    const stemmed = stem(base).trim()
    if (stemmed && !out.includes(stemmed)) out.push(stemmed)
    if (out.length >= 6) break
  }
  return out
}

/** 造一个节点。字段与 notes 适配器对齐，额外带上 mnemon 的 docId。 */
function makeNode(store, config, file, data, body) {
  const level = String(config.level || data.level || 'project').trim() || 'project'
  const description = String(data.description || '').trim()
  const content = String(body || '').trim() || description
  const title =
    String(data.title || '').trim() || firstLine(content, 46) || stem(file.rel) || file.rel
  // id 优先：mnemon 改写文档时 id 不变，节点也就不会在星图里变成另一条。
  const docId = String(data.id || '').trim()
  const uid = hashShort(docId || file.rel)
  const tagKeywords = toKeywordList(data.tags || data.keywords || '')
  const fromPaths = keywordsFromPaths(data.source_paths)
  const derived = config.deriveKeywords && fromPaths.length === 0 ? deriveKeywords(body, title) : []
  const keywords = [...new Set([...tagKeywords, ...fromPaths, ...derived])].slice(0, 8)
  return {
    id: `mnemon:${store.key}:${level}:${uid}`,
    uid,
    docId,
    provider: store.provider,
    adapter: 'mnemon',
    storeId: store.id,
    ws: store.key,
    wsTitle: store.title,
    wsPath: store.path,
    level,
    title,
    label: title.length > 42 ? title.slice(0, 42) + '…' : title,
    content,
    importance: Math.max(0, Math.min(4, Number(data.importance) || 0)),
    status: String(data.status || 'active'),
    project: String(data.project || '').trim(),
    subcategory: String(data.category || '').trim(),
    goal: '',
    corrected: false,
    keywords,
    sessionId: '',
    hits: Number(data.hits) || 0,
    createdAt: toMs(data.created_at) || toMs(data.createdAt) || Math.round(file.mtimeMs),
    updatedAt: toMs(data.updated_at) || toMs(data.updatedAt) || Math.round(file.mtimeMs),
    accessedAt: 0,
    file: file.rel,
  }
}

/**
 * 扫描一个 mnemon store。
 * @param {object} store
 * @returns {{nodes:object[],ledgers:object[],truncated?:boolean,maxFiles?:number}}
 */
export function scan(store) {
  const config = store.config || {}
  const exts = Array.isArray(config.exts) && config.exts.length ? config.exts : DEFAULT_EXTS
  const cap = Math.min(20000, Number(config.maxFiles) || 4000)
  const stats = {}
  const files = walkFiles(store.path, {
    exts,
    maxDepth: Number(config.maxDepth) || 2,
    maxFiles: cap,
    stats,
  })
  const nodes = []
  for (const file of files) {
    try {
      const text = readTextSafe(file.file, 400_000)
      const { data, body } = parseFrontmatter(text)
      const node = makeNode(store, config, file, data || {}, body)
      if (node.content || node.title) nodes.push(node)
    } catch {
      // 单个文件读坏不影响整库；扫描器已经有 warnings 通道，这里静默跳过。
    }
  }
  return { nodes, ledgers: [], truncated: Boolean(stats.truncated), maxFiles: cap }
}

/**
 * 接入体检：给 nebula_sources / 医生看「这个目录读成了什么」。
 * @param {{path?:string}} config
 */
export function probe(config = {}) {
  const path = archiveDir(config)
  const exists = Boolean(path) && dirExists(path)
  const report = {
    adapter: 'mnemon',
    path,
    exists,
    files: 0,
    nodes: 0,
    newest: 0,
    sample: [],
  }
  if (!exists) return report
  const stores = detect(config)
  if (!stores.length) return report
  const res = scan(stores[0])
  report.files = stores[0].fileCount
  report.nodes = res.nodes.length
  report.newest = stores[0].mtimeMs
  report.sample = res.nodes.slice(0, 3).map((n) => ({ id: n.id, title: n.title, level: n.level }))
  try {
    report.newestFile = new Date(statSync(path).mtimeMs).toISOString()
  } catch {
    // 目录刚被删掉：报告里少一行就行
  }
  return report
}
