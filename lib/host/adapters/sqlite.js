/**
 * 适配器：sqlite —— 任意 SQLite 记忆库（列映射驱动）
 *
 * 现实里「记忆插件」的存储五花八门，但一大半最后都是 SQLite。
 * 这个适配器不猜语义，只按配置把「表 → 层」「列 → 字段」对上：
 *
 *   多表模式： { "tables": { "fact": "facts", "lesson": "lessons" } }
 *   单表模式： { "table": "memories", "levelField": "kind" }
 *
 * 没给 columns 时按常见列名自动猜（id / title / content / keywords …），
 * 猜不到就跳过这一列，不会把库读炸。
 *
 * 只读：`new DatabaseSync(path, { readOnly: true })`。
 */
import { existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { hashShort, slugKey, toKeywordList, toMs } from './util.js'

/** 列名候选：按优先级，命中第一个就用。 */
const COLUMN_HINTS = {
  id: ['id', 'uid', 'key', 'uuid', 'memory_id', 'rowid'],
  title: ['title', 'name', 'heading', 'subject', 'label'],
  content: ['content', 'text', 'body', 'memory', 'detail', 'value', 'summary', 'description'],
  keywords: ['keywords', 'tags', 'labels', 'keyword', 'tag'],
  importance: ['importance', 'weight', 'priority', 'score', 'salience'],
  project: ['project', 'project_name', 'scope', 'workspace'],
  status: ['status', 'state', 'active', 'archived'],
  created: ['created_at', 'createdAt', 'created', 'ctime', 'timestamp', 'ts', 'time'],
  updated: ['updated_at', 'updatedAt', 'updated', 'mtime', 'modified'],
  accessed: ['last_accessed_at', 'accessed_at', 'lastAccess', 'accessed'],
  session: ['source_session', 'session_id', 'sessionId', 'session'],
  hits: ['hit_count', 'hits', 'access_count', 'used_count', 'read_count'],
  subcategory: ['subcategory', 'sub_category', 'subtype'],
  goal: ['goal', 'objective', 'intent'],
  level: ['level', 'kind', 'layer', 'category', 'type', 'mem_type'],
}

export const meta = {
  id: 'sqlite',
  name: 'SQLite 记忆库',
  kind: 'sqlite',
  description:
    '把任意 SQLite 记忆库接进星图：配置表与列的对应关系即可。适合自己写的记忆插件、或换皮的同构实现。',
  config: {
    path: '必填。.db 文件绝对路径（支持 ~ 开头）。',
    title: '展示名；默认取文件名。',
    tables: '多表模式：{ 层名: 表名 }，例如 {"fact":"facts","lesson":"lessons"}。',
    table: '单表模式：表名；配合 levelField 使用。',
    levelField: '单表模式下从哪列读层名，默认 level。',
    defaultLevel: '读不到层名时用哪个，默认 note。',
    columns: '列映射 { id, title, content, keywords, importance, project, status, created, updated, accessed, session, hits, subcategory, goal }，缺省自动猜。',
    where: '附加 SQL 过滤条件（只接受简单比较，不要写 UPDATE/DELETE）。',
  },
}

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

/** 拒绝任何会改写数据的 where（适配器是只读的，这里多一道闸）。 */
function safeWhere(where) {
  const text = String(where || '').trim()
  if (!text) return ''
  if (/\b(insert|update|delete|drop|alter|attach|pragma|create|replace)\b/i.test(text)) return ''
  return text
}

/** 列名自动猜：只在表的实际列里找。 */
function guessColumns(actualCols, given = {}) {
  const out = {}
  for (const [key, hints] of Object.entries(COLUMN_HINTS)) {
    if (given[key]) {
      out[key] = given[key]
      continue
    }
    const lower = new Map([...actualCols].map((c) => [c.toLowerCase(), c]))
    for (const hint of hints) {
      const hit = lower.get(hint.toLowerCase())
      if (hit) {
        out[key] = hit
        break
      }
    }
  }
  return out
}

function tableCols(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((c) => String(c.name))
  } catch {
    return []
  }
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

/** 列出库里所有普通表（探测/给 nebula_sources 用）。 */
export function listTables(dbPath) {
  let db = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => String(r.name))
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

/** 表 → 层的映射（多表 / 单表 / 兜底「表名就是层名」）。 */
function tableMap(db, config) {
  const declared = config.tables && typeof config.tables === 'object' ? config.tables : null
  if (declared && Object.keys(declared).length > 0) {
    return Object.entries(declared).map(([level, table]) => ({ level, table: String(table) }))
  }
  if (config.table) {
    return [{ level: null, table: String(config.table) }]
  }
  const KNOWN = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules', 'note', 'notes', 'memory']
  const all = listTables(db)
  const known = all.filter((t) => KNOWN.includes(t.toLowerCase())).map((t) => ({ level: t.toLowerCase(), table: t }))
  if (known.length > 0) return known
  return all.slice(0, 8).map((t) => ({ level: null, table: t }))
}

/** 探测：给了 path 且是真 sqlite 就产出一个 store。 */
export function detect(config = {}) {
  const path = expandHome(config.path)
  if (!path || !existsSync(path)) return []
  let size = 0
  let mtimeMs = 0
  try {
    const st = statSync(path)
    if (!st.isFile()) return []
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    return []
  }
  const tables = listTables(path)
  if (tables.length === 0) return []
  const title = String(config.title || '').trim() || path.split(/[\\/]/).pop().replace(/\.(db|sqlite3?|db3)$/i, '')
  return [
    {
      id: 'sqlite:' + (config.id || slugKey(title)),
      provider: String(config.provider || config.id || 'sqlite'),
      adapter: 'sqlite',
      title,
      path,
      key: slugKey(title, 'sqlite'),
      dbPath: path,
      size,
      mtimeMs,
      tables,
      config,
    },
  ]
}

/** 扫描一个 sqlite store。 */
export function scan(store) {
  const config = store.config || {}
  const nodes = []
  let db = null
  try {
    db = new DatabaseSync(store.dbPath, { readOnly: true })
  } catch {
    return { nodes, ledgers: [], error: '打不开 ' + store.dbPath }
  }
  try {
    for (const { level, table } of tableMap(db, config)) {
      const cols = tableCols(db, table)
      if (cols.length === 0) continue
      const map = guessColumns(cols, config.columns || {})
      if (!map.content && !map.title) continue
      const where = safeWhere(config.where)
      let rows
      try {
        rows = db.prepare(`SELECT * FROM ${quoteIdent(table)}${where ? ' WHERE ' + where : ''}`).all()
      } catch {
        continue
      }
      for (const row of rows) {
        const content = String(row[map.content] ?? '').trim()
        const title = String(row[map.title] ?? '').trim()
        if (!content && !title) continue
        const rawId = String(row[map.id] ?? '').trim() || hashShort(title + '\u0000' + content)
        const levelName = String(level || (map.level ? row[map.level] : '') || config.defaultLevel || 'note')
          .trim()
          .toLowerCase()
        const uid = rawId
        nodes.push({
          id: `${store.key}:${levelName}:${uid}`.replace(/^/, 'sqlite:'),
          uid,
          provider: store.provider,
          adapter: 'sqlite',
          storeId: store.id,
          ws: store.key,
          wsTitle: store.title,
          wsPath: store.path,
          level: levelName || 'note',
          title,
          label: (title || content).length > 42 ? (title || content).slice(0, 42) + '…' : title || content,
          content,
          importance: Math.max(0, Math.min(4, Number(map.importance ? row[map.importance] : 0) || 0)),
          status: String(map.status ? row[map.status] : 'active') || 'active',
          project: String(map.project ? row[map.project] : '').trim(),
          subcategory: String(map.subcategory ? row[map.subcategory] : '').trim(),
          goal: String(map.goal ? row[map.goal] : ''),
          corrected: false,
          keywords: toKeywordList(map.keywords ? row[map.keywords] : ''),
          sessionId: String(map.session ? row[map.session] : ''),
          hits: Number(map.hits ? row[map.hits] : 0) || 0,
          createdAt: toMs(map.created ? row[map.created] : 0),
          updatedAt: toMs(map.updated ? row[map.updated] : 0) || toMs(map.created ? row[map.created] : 0),
          accessedAt: toMs(map.accessed ? row[map.accessed] : 0),
          table,
        })
      }
    }
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
  return { nodes, ledgers: [] }
}

export function probe(config = {}) {
  const stores = detect(config)
  if (stores.length === 0) {
    return { ok: false, note: '不是可读的 SQLite 文件，或路径为空：' + (config.path || '(未配置 path)') }
  }
  const st = stores[0]
  return {
    ok: true,
    stores: stores.map((s) => ({ id: s.id, title: s.title, db: s.dbPath, tables: s.tables })),
    note: `${st.tables.length} 张表：${st.tables.slice(0, 8).join(', ')}`,
  }
}
