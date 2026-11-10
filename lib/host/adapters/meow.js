/**
 * 适配器：meow-memory
 *
 * 数据面：每个工作区目录下的 `.dsh-meow/memory.db`（SQLite，7 张层表）
 *        + `.dsh-meow/sessions/*.json`（每会话的活动账本：injected / searched / accessed / written）
 *
 * 这是星图最早、也是最深的来源：节点自带层（soul/user/project/fact/lesson/topic/rules）、
 * 重要性、命中次数，账本还能算「谁和谁被一起点亮过」（Hebbian 共激活）。
 *
 * 只读：`new DatabaseSync(path, { readOnly: true })`，从不写对方目录。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dshHome, readJsonSafe, readTextSafe, slugKey, toMs, toKeywordList } from './util.js'

/** meow-memory 的记忆层（表名）。有顺序：越靠前越「重」。 */
export const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

export const meta = {
  id: 'meow',
  name: 'meow-memory',
  kind: 'sqlite',
  description: '每个工作区 .dsh-meow/memory.db 里的分层记忆 + sessions/*.json 活动账本。星图的原生来源，无需配置。',
  config: {
    extraRoots: '额外的父目录数组：会扫描其下每个子目录，发现带 .dsh-meow/memory.db 的就算一个工作区。留空则只用工作区注册表 + 默认探针。',
    dirName: '记忆目录名，默认 .dsh-meow',
  },
}

/**
 * 读 workspace 注册表：拿到所有工作区（id / title / path）。
 * @returns {{id:string,title:string,path:string}[]}
 */
export function readWorkspaceRegistry() {
  const file = join(dshHome(), 'storages', 'workspace.json')
  const data = readJsonSafe(file, null)
  const out = []
  const table = data?.tables?.workspaces
  if (table && typeof table === 'object') {
    for (const [id, rec] of Object.entries(table)) {
      const path = typeof rec?.path === 'string' ? rec.path : ''
      if (!path) continue
      out.push({ id, title: String(rec?.title || basename(path)), path })
    }
  }
  return out
}

/** 扫描默认根：常见的工作区父目录（抓注册表漏掉的项目）。 */
export function defaultRoots() {
  const candidates = [
    'D:\\document',
    join(process.env.USERPROFILE || 'C:\\Users\\Administrator', 'Documents'),
    join(dshHome(), '..', 'document'),
  ]
  const out = []
  for (const c of candidates) {
    try {
      if (existsSync(c)) out.push(c)
    } catch {
      /* ignore */
    }
  }
  return [...new Set(out)]
}

/**
 * 发现所有 meow-memory 记忆库（只读）。
 * @param {{extraRoots?: string[], dirName?: string}} [config]
 * @returns {object[]} store 列表
 */
export function detect(config = {}) {
  const dirName = config.dirName || '.dsh-meow'
  const roots = Array.isArray(config.extraRoots) && config.extraRoots.length > 0 ? config.extraRoots : defaultRoots()
  const workspaces = readWorkspaceRegistry()
  const seen = new Set()
  const stores = []

  const consider = (wsPath, title, id, via) => {
    const norm = String(wsPath || '').replace(/[\\/]+$/, '')
    if (!norm || seen.has(norm.toLowerCase())) return
    seen.add(norm.toLowerCase())
    const dir = join(norm, dirName)
    const dbPath = join(dir, 'memory.db')
    if (!existsSync(dbPath)) return
    let size = 0
    let mtimeMs = 0
    try {
      const st = statSync(dbPath)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      /* 有文件但 stat 不到：仍然收进来，读的时候再失败一次 */
    }
    stores.push({
      id: 'meow:' + (id || norm),
      provider: 'meow-memory',
      adapter: 'meow',
      title: String(title || basename(norm)),
      path: norm,
      key: slugKey(title || basename(norm), 'ws'),
      dbPath,
      sessionsDir: join(dir, 'sessions'),
      size,
      mtimeMs,
      via,
    })
  }

  for (const ws of workspaces) consider(ws.path, ws.title, ws.id, 'registry')

  // 兜底：注册表里没有、但目录里确实有记忆库的，也收进来
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue
      for (const name of readdirSyncSafe(root)) {
        const p = join(root, name)
        try {
          if (statSync(p).isDirectory()) consider(p, name, p, 'scan')
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  stores.sort((a, b) => b.size - a.size)
  return stores
}

/** readdir 的容错包装。 */
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 容忍老库缺列的读取器。 */
function columnsOf(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)))
  } catch {
    return new Set()
  }
}

/**
 * 只读打开一个 meow-memory 库并抽出全部记忆。
 * @param {object} store
 * @returns {object[]} 记忆节点（未做 token/实体计算）
 */
export function scan(store) {
  const nodes = []
  let db = null
  try {
    db = new DatabaseSync(store.dbPath, { readOnly: true })
  } catch {
    return { nodes, ledgers: [], error: '打不开 ' + store.dbPath }
  }
  try {
    for (const level of LEVELS) {
      const cols = columnsOf(db, level)
      if (cols.size === 0) continue
      let rows
      try {
        rows = db.prepare(`SELECT * FROM ${level}`).all()
      } catch {
        continue
      }
      for (const row of rows) {
        const rawId = String(row.id ?? '')
        if (!rawId) continue
        const keywords = toKeywordList(row.keywords)
        const title = row.title === null || row.title === undefined ? '' : String(row.title)
        const content = row.content === null || row.content === undefined ? '' : String(row.content)
        const project = row.project === null || row.project === undefined ? '' : String(row.project)
        nodes.push({
          id: `meow:${store.key}:${level}:${rawId}`,
          uid: rawId,
          provider: 'meow-memory',
          adapter: 'meow',
          storeId: store.id,
          ws: store.key,
          wsTitle: store.title,
          wsPath: store.path,
          level,
          title: title.trim(),
          label: clipText(title.trim() || content, 42),
          content,
          importance: Number(row.importance) || 0,
          status: String(row.status ?? 'active'),
          project: project.trim(),
          subcategory: cols.has('subcategory') ? String(row.subcategory ?? '').trim() : '',
          goal: cols.has('goal') ? String(row.goal ?? '').trim() : '',
          corrected: cols.has('corrected') ? Number(row.corrected) === 1 : false,
          keywords,
          sessionId: String(row.source_session ?? ''),
          hits: Number(row.hit_count) || 0,
          createdAt: toMs(row.created_at),
          updatedAt: toMs(row.updated_at),
          accessedAt: toMs(row.last_accessed_at),
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
  const ledgers = readSessionLedgers(store.sessionsDir).map((row) => ({ ...row, ws: store.key, storeId: store.id }))
  return { nodes, ledgers }
}

/**
 * 读 meow-memory 每会话的活动账本（injected / searched / written ...）。
 * 这些账本是「谁和谁一起被点亮过」的原始证据，用来做 Hebbian 共激活连边。
 * @param {string} sessionsDir
 */
export function readSessionLedgers(sessionsDir) {
  const out = []
  if (!sessionsDir || !existsSync(sessionsDir)) return out
  let names
  try {
    names = readdirSync(sessionsDir)
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const rec = readJsonSafe(join(sessionsDir, name), null)
    if (!rec || typeof rec !== 'object') continue
    const sessionId = name.replace(/\.json$/, '')
    const currentProject = typeof rec.currentProject === 'string' ? rec.currentProject : ''
    for (const [kind, value] of Object.entries(rec)) {
      if (!Array.isArray(value)) continue
      const ids = value.filter((x) => typeof x === 'string' && x.length > 0)
      if (ids.length === 0) continue
      out.push({ sessionId, kind, ids, currentProject })
    }
  }
  return out
}

/** 本文件自己用的小工具（避免为了 clip 再拉一个模块进热载图）。 */
function clipText(text, max) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 探测信息（给 nebula_sources 用）。 */
export function probe(config = {}) {
  const stores = detect(config)
  return {
    ok: stores.length > 0,
    stores: stores.map((s) => ({ id: s.id, title: s.title, db: s.dbPath, size: s.size })),
    note: stores.length ? `${stores.length} 个工作区记忆库，只读` : '没有找到 .dsh-meow/memory.db',
  }
}
