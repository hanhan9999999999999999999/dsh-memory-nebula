/**
 * 星图自己的 sidecar 数据库。
 *
 * 位置：$DSH_HOME/memory-nebula/nebula.db
 * 只放三样东西：人工策展的连边、缓存、事件日志。
 * **绝不写别的插件的记忆库**。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { nebulaHome } from './sources.js'

let db = null
let dbPath = ''
let recovery = null

/**
 * 上一次打开 sidecar 库时，是否把坏掉的文件挪开了。
 * 坏库不该让整张图起不来，但也不该悄悄发生了没人说。
 * @returns {{path: string, movedTo: string, error: string, at: number}|null}
 */
export function storeRecovery() {
  return recovery
}

/** 打开并建表；打不开就抛给调用方。 */
function tryOpen(file) {
  const handle = new DatabaseSync(file)
  try {
    handle.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cache (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
    CREATE TABLE IF NOT EXISTS mutes (
      id TEXT PRIMARY KEY,
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `)
  } catch (err) {
    try {
      handle.close()
    } catch {
      /* 连关都关不掉就让它带着句柄走 */
    }
    throw err
  }
  return handle
}

/** 坏掉的那个文件挪到旁边：留证据，也让新库能建起来。 */
function moveAside(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = file + '.broken-' + stamp
  try {
    renameSync(file, target)
  } catch {
    return ''
  }
  for (const extra of ['-wal', '-shm']) {
    if (existsSync(file + extra)) {
      try {
        renameSync(file + extra, target + extra)
      } catch {
        /* 附属文件挪不动不影响新库 */
      }
    }
  }
  return target
}

/** 打开（并在需要时创建）sidecar 库；坏库挪开重建，不拖垮建图。 */
export function openStore() {
  if (db) return db
  const dir = nebulaHome()
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    /* 建不出目录也让下面的打开去报错，统一走自愈那一条路 */
  }
  dbPath = join(dir, 'nebula.db')
  try {
    db = tryOpen(dbPath)
  } catch (err) {
    const movedTo = existsSync(dbPath) ? moveAside(dbPath) : ''
    const first = String((err && err.message) || err)
    try {
      db = tryOpen(dbPath)
    } catch (again) {
      // 挪开也建不起来（目录只读、磁盘满…）：退到内存库，
      // 让建图与检索照常跑，并把这件事说清楚。
      recovery = {
        path: dbPath,
        movedTo,
        error: first + ' / 重建失败：' + String((again && again.message) || again),
        memoryOnly: true,
        at: Date.now(),
      }
      db = tryOpen(':memory:')
      return db
    }
    recovery = { path: dbPath, movedTo, error: first, memoryOnly: false, at: Date.now() }
  }
  return db
}

/** 当前 sidecar 库路径。 */
export function storePath() {
  return dbPath || join(nebulaHome(), 'nebula.db')
}

/**
 * 关掉 sidecar 库，并忘掉它的路径。
 *
 * 生产里一个进程只有一个 DSH_HOME，用不上；但测例要在同一个进程里换 DSH_HOME，
 * 不关掉的话 `db` 与 `dbPath` 会一直指向第一个临时目录——
 * 1.11.26 的策展测试就是这么被上一跑的链接污染了一次（同一对 id 已经在库里，
 * 就地策展于是变成「边已存在」，测试看到的是 1 条边而不是 2 条）。
 */
export function closeStore() {
  if (db) {
    try {
      db.close()
    } catch {
      /* 已经关了就算了 */
    }
  }
  db = null
  dbPath = ''
  recovery = null
}

/**
 * 列出人工策展的连边。
 * @returns {{a:string,b:string,note:string,createdAt:number,updatedAt:number}[]}
 */
export function listLinks() {
  const d = openStore()
  const rows = d.prepare('SELECT a, b, note, created_at, updated_at FROM links ORDER BY updated_at DESC').all()
  return rows.map((r) => ({
    a: String(r.a),
    b: String(r.b),
    note: String(r.note || ''),
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
  }))
}

/**
 * 建立（或更新）一条人工策展边。
 * @param {string} a
 * @param {string} b
 * @param {string} [note]
 */
export function addLink(a, b, note = '') {
  const [x, y] = a < b ? [a, b] : [b, a]
  const d = openStore()
  const now = Date.now()
  d.prepare(
    `INSERT INTO links (id, a, b, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
  ).run(x + '\u0000' + y, x, y, String(note || ''), now, now)
  logEvent('link.add', { a: x, b: y, note })
  return { a: x, b: y, note }
}

/**
 * 删掉一条人工策展边。
 * @param {string} a
 * @param {string} b
 */
export function removeLink(a, b) {
  const [x, y] = a < b ? [a, b] : [b, a]
  const d = openStore()
  const res = d.prepare('DELETE FROM links WHERE id = ?').run(x + '\u0000' + y)
  logEvent('link.remove', { a: x, b: y })
  return Number(res.changes || 0) > 0
}

/**
 * 列出被人工屏蔽的关联对（重建时不会再连上）。
 * @returns {{a:string,b:string,note:string,createdAt:number}[]}
 */
export function listMutes() {
  const d = openStore()
  const rows = d.prepare('SELECT a, b, note, created_at FROM mutes ORDER BY created_at DESC').all()
  return rows.map((r) => ({
    a: String(r.a),
    b: String(r.b),
    note: String(r.note || ''),
    createdAt: Number(r.created_at) || 0,
  }))
}

/**
 * 屏蔽一对节点之间的自动关联。
 * 回答的是「这条连线是错的」——不是删掉一条边，而是让**每次重建**都不再连它。
 * @param {string} a
 * @param {string} b
 * @param {string} [note]
 */
export function addMute(a, b, note = '') {
  const [x, y] = a < b ? [a, b] : [b, a]
  const d = openStore()
  d.prepare(
    'INSERT INTO mutes (id, a, b, note, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET note = excluded.note',
  ).run(x + '\u0000' + y, x, y, String(note || ''), Date.now())
  logEvent('mute.add', { a: x, b: y, note })
  return { a: x, b: y, note }
}

/**
 * 取消屏蔽。
 * @param {string} a
 * @param {string} b
 */
export function removeMute(a, b) {
  const [x, y] = a < b ? [a, b] : [b, a]
  const d = openStore()
  const res = d.prepare('DELETE FROM mutes WHERE id = ?').run(x + '\u0000' + y)
  logEvent('mute.remove', { a: x, b: y })
  return Number(res.changes || 0) > 0
}

/**
 * 读 meta。
 * @param {string} k
 * @param {string} [fallback]
 */export function getMeta(k, fallback = '') {
  const d = openStore()
  const row = d.prepare('SELECT v FROM meta WHERE k = ?').get(String(k))
  return row ? String(row.v) : fallback
}

/**
 * 写 meta。
 * @param {string} k
 * @param {string} v
 */
export function setMeta(k, v) {
  const d = openStore()
  d.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(String(k), String(v))
}

/**
 * 读缓存。
 * @param {string} k
 */
export function cacheGet(k) {
  const d = openStore()
  const row = d.prepare('SELECT v, updated_at FROM cache WHERE k = ?').get(String(k))
  if (!row) return null
  try {
    return { value: JSON.parse(String(row.v)), updatedAt: Number(row.updated_at) || 0 }
  } catch {
    return null
  }
}

/**
 * 写缓存。
 * @param {string} k
 * @param {unknown} value
 */
export function cacheSet(k, value) {
  const d = openStore()
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return
  }
  d.prepare(
    'INSERT INTO cache (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
  ).run(String(k), text, Date.now())
}

/**
 * 记一条事件（谁在什么时候连了什么 / 星图什么时候重建）。
 * @param {string} kind
 * @param {unknown} [payload]
 */
export function logEvent(kind, payload) {
  try {
    const d = openStore()
    let text = ''
    try {
      text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null)
    } catch {
      text = ''
    }
    d.prepare('INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)').run(Date.now(), String(kind), text)
    // 只留最近 2000 条，避免无限膨胀
    d.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) - 2000 FROM events)').run()
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/**
 * 读最近事件。
 * @param {number} [limit]
 */
export function listEvents(limit = 40) {
  const d = openStore()
  const rows = d.prepare('SELECT ts, kind, payload FROM events ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(500, limit)))
  return rows.map((r) => ({ ts: Number(r.ts), kind: String(r.kind), payload: String(r.payload || '') }))
}
