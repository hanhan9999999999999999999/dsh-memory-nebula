/**
 * 适配器：notes —— 通用「文件即记忆」来源
 *
 * 吃这几种落盘形态：
 *   · Markdown（.md / .markdown）—— frontmatter 认 title / tags / level / project / importance；
 *     hindsight 的知识页、Obsidian 库、日记、openviking 导出的 md 全在这一类。
 *   · JSON —— 整份是一个数组，或对象里有 items / pages / memories / entries 之一。
 *   · JSONL —— 一行一个对象（各种 agent 的日志式记忆）。
 *   · 纯文本（.txt）—— 一个文件当一条，标题取文件名。
 *
 * 只读。目录不存在就返回空，不报错。
 */
import { statSync } from 'node:fs'
import {
  dirExists,
  firstLine,
  hashShort,
  parseFrontmatter,
  readJsonSafe,
  readTextSafe,
  slugKey,
  stem,
  toKeywordList,
  toMs,
  walkFiles,
} from './util.js'

const DEFAULT_EXTS = ['.md', '.markdown', '.json', '.jsonl', '.txt']
const ARRAY_HINTS = ['items', 'pages', 'memories', 'entries', 'records', 'notes', 'data']

export const meta = {
  id: 'notes',
  name: '文件笔记',
  kind: 'files',
  description:
    '把一个目录当成记忆来源：每个 md / json / jsonl / txt 文件（或 JSON 数组里的每一条）算一条记忆。适合 hindsight 知识页、openviking 导出、Obsidian/日记目录。',
  config: {
    path: '必填。目录绝对路径（支持 ~ 开头）。',
    title: '展示名；默认取目录名。',
    level: '默认层级，默认 note。',
    levelField: '从 frontmatter 读层级的字段名，默认 level（也认 type / kind）。',
    titleField: '标题字段名，默认 title（也认 name / heading）。',
    keywordsField: '关键词字段名，默认 tags（也认 keywords）。',
    importanceField: '重要性字段名，默认 importance。',
    exts: '扩展名数组，默认 [.md,.markdown,.json,.jsonl,.txt]。',
    maxFiles: '最多读多少个文件，默认 4000。',
    maxDepth: '目录递归深度，默认 4。',
  },
}

/** 配置里 path 允许写 ~。 */
function expandHome(p) {
  const raw = String(p || '').trim()
  if (!raw) return ''
  if (raw === '~') return process.env.USERPROFILE || process.env.HOME || raw
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    return home ? home + raw.slice(1) : raw
  }
  return raw
}

/**
 * 探测：只看配置；没配 path 就不产出（notes 无法盲猜）。
 * @param {object} config 单个适配器配置
 */
export function detect(config = {}) {
  const path = expandHome(config.path)
  if (!path || !dirExists(path)) return []
  const exts = Array.isArray(config.exts) && config.exts.length ? config.exts : DEFAULT_EXTS
  let size = 0
  let mtimeMs = 0
  let count = 0
  const files = walkFiles(path, {
    exts,
    maxDepth: Number(config.maxDepth) || 4,
    maxFiles: Math.min(20000, Number(config.maxFiles) || 4000),
  })
  for (const f of files) {
    size += f.size
    count += 1
    mtimeMs = Math.max(mtimeMs, Math.round(f.mtimeMs))
  }
  if (count === 0) return []
  const title = String(config.title || '').trim() || path.split(/[\\/]/).filter(Boolean).pop() || 'notes'
  return [
    {
      id: 'notes:' + (config.id || slugKey(title)),
      provider: String(config.provider || config.id || 'notes'),
      adapter: 'notes',
      title,
      path,
      key: slugKey(title, 'notes'),
      size,
      mtimeMs,
      fileCount: count,
      config,
    },
  ]
}

/** 从 frontmatter / 对象里挑第一个存在的字段。 */
function pickField(obj, names, fallback = '') {
  for (const name of names) {
    const v = obj?.[name]
    if (v === undefined || v === null || v === '') continue
    return v
  }
  return fallback
}

/**
 * 扫描一个 notes store。
 * @param {object} store
 */
export function scan(store) {
  const config = store.config || {}
  const exts = Array.isArray(config.exts) && config.exts.length ? config.exts : DEFAULT_EXTS
  const files = walkFiles(store.path, {
    exts,
    maxDepth: Number(config.maxDepth) || 4,
    maxFiles: Math.min(20000, Number(config.maxFiles) || 4000),
  })
  const nodes = []
  for (const file of files) {
    try {
      const ext = file.file.toLowerCase().split('.').pop()
      if (ext === 'json') nodes.push(...readJsonNodes(store, config, file))
      else if (ext === 'jsonl') nodes.push(...readJsonlNodes(store, config, file))
      else nodes.push(readNoteNode(store, config, file))
    } catch {
      /* 单个文件坏了不影响别的 */
    }
  }
  return { nodes, ledgers: [] }
}

/** 造一个标准节点。 */
function makeNode(store, config, file, index, fields) {
  const level = String(fields.level || config.level || 'note').trim() || 'note'
  const content = String(fields.content || '').trim()
  const title = String(fields.title || '').trim() || firstLine(content, 46) || stem(file.rel)
  const uid = hashShort(file.rel + '#' + index)
  return {
    id: `notes:${store.key}:${level}:${uid}`,
    uid,
    provider: store.provider,
    adapter: 'notes',
    storeId: store.id,
    ws: store.key,
    wsTitle: store.title,
    wsPath: store.path,
    level,
    title,
    label: title.length > 42 ? title.slice(0, 42) + '…' : title,
    content,
    importance: Math.max(0, Math.min(4, Number(fields.importance) || 0)),
    status: String(fields.status || 'active'),
    project: String(fields.project || '').trim(),
    subcategory: String(fields.subcategory || '').trim(),
    goal: String(fields.goal || ''),
    corrected: false,
    keywords: toKeywordList(fields.keywords),
    sessionId: String(fields.sessionId || ''),
    hits: Number(fields.hits) || 0,
    createdAt: toMs(fields.createdAt) || Math.round(file.mtimeMs),
    updatedAt: toMs(fields.updatedAt) || Math.round(file.mtimeMs),
    accessedAt: 0,
    file: file.rel,
  }
}

/** 单个 md / txt 文件 → 一个节点。 */
function readNoteNode(store, config, file) {
  const text = readTextSafe(file.file, 400_000)
  const { data, body } = parseFrontmatter(text)
  const level = pickField(data, [config.levelField || 'level', 'type', 'kind'], config.level || 'note')
  const title = pickField(data, [config.titleField || 'title', 'name', 'heading'], '')
  const keywords = pickField(data, [config.keywordsField || 'tags', 'keywords', 'tag'], '')
  return makeNode(store, config, file, 0, {
    level,
    title: title || stem(file.rel),
    content: body.trim() || text,
    keywords,
    importance: pickField(data, [config.importanceField || 'importance', 'weight', 'priority'], 0),
    status: data.status || 'active',
    project: data.project || '',
    createdAt: pickField(data, ['created', 'createdAt', 'date'], 0),
    updatedAt: pickField(data, ['updated', 'updatedAt', 'modified'], 0),
  })
}

/** JSON：整份数组 / 或对象里带一个数组字段 → 每条一个节点。 */
function readJsonNodes(store, config, file) {
  const data = readJsonSafe(file.file, null)
  if (!data) return []
  let list = null
  if (Array.isArray(data)) list = data
  else if (data && typeof data === 'object') {
    for (const key of ARRAY_HINTS) {
      if (Array.isArray(data[key])) {
        list = data[key]
        break
      }
    }
  }
  if (!Array.isArray(list) || list.length === 0) {
    // 单个对象也当一条记忆（很多导出是 {title, content} 一件一文件）
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return [
        makeNode(store, config, file, 0, {
          level: pickField(data, [config.levelField || 'level', 'type', 'kind'], config.level || 'note'),
          title: pickField(data, [config.titleField || 'title', 'name', 'heading'], stem(file.rel)),
          content: pickField(data, ['content', 'text', 'body', 'summary', 'value'], ''),
          keywords: pickField(data, [config.keywordsField || 'tags', 'keywords'], ''),
          importance: pickField(data, ['importance', 'weight', 'priority'], 0),
          status: data.status || 'active',
          project: data.project || '',
          createdAt: pickField(data, ['created', 'createdAt', 'date', 'ts'], 0),
          updatedAt: pickField(data, ['updated', 'updatedAt', 'modified'], 0),
        }),
      ]
    }
    return []
  }
  const out = []
  const cap = Math.min(list.length, 5000)
  for (let i = 0; i < cap; i++) {
    const row = list[i]
    if (!row || typeof row !== 'object') continue
    const content = pickField(row, ['content', 'text', 'body', 'summary', 'value', 'detail'], '')
    if (!content && !pickField(row, ['title', 'name'], '')) continue
    out.push(
      makeNode(store, config, file, i, {
        level: pickField(row, [config.levelField || 'level', 'type', 'kind'], config.level || 'note'),
        title: pickField(row, [config.titleField || 'title', 'name', 'heading'], ''),
        content,
        keywords: pickField(row, [config.keywordsField || 'tags', 'keywords'], ''),
        importance: pickField(row, ['importance', 'weight', 'priority'], 0),
        status: row.status || 'active',
        project: row.project || '',
        createdAt: pickField(row, ['created', 'createdAt', 'date', 'ts', 'timestamp'], 0),
        updatedAt: pickField(row, ['updated', 'updatedAt', 'modified'], 0),
      }),
    )
  }
  return out
}

/** JSONL：一行一条。 */
function readJsonlNodes(store, config, file) {
  const text = readTextSafe(file.file, 4_000_000)
  if (!text) return []
  const out = []
  const lines = text.split(/\r?\n/)
  const cap = Math.min(lines.length, 5000)
  for (let i = 0; i < cap; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('//')) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!row || typeof row !== 'object') continue
    const content = pickField(row, ['content', 'text', 'body', 'summary', 'message', 'value'], '')
    if (!content && !pickField(row, ['title', 'name'], '')) continue
    out.push(
      makeNode(store, config, file, i, {
        level: pickField(row, [config.levelField || 'level', 'type', 'kind'], config.level || 'note'),
        title: pickField(row, [config.titleField || 'title', 'name'], ''),
        content,
        keywords: pickField(row, [config.keywordsField || 'tags', 'keywords'], ''),
        importance: pickField(row, ['importance', 'weight'], 0),
        status: row.status || 'active',
        project: row.project || '',
        createdAt: pickField(row, ['created', 'createdAt', 'date', 'ts', 'timestamp'], 0),
        updatedAt: pickField(row, ['updated', 'updatedAt'], 0),
      }),
    )
  }
  return out
}

export function probe(config = {}) {
  const stores = detect(config)
  if (stores.length === 0) {
    return { ok: false, note: '目录不存在或里面没有可读的 md/json/jsonl/txt：' + (config.path || '(未配置 path)') }
  }
  const st = stores[0]
  return {
    ok: true,
    stores: stores.map((s) => ({ id: s.id, title: s.title, path: s.path, files: s.fileCount, size: s.size })),
    note: `${st.fileCount} 个文件，只读`,
  }
}
