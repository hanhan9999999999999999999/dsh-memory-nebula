/**
 * 星图自己的 sidecar 数据库。
 *
 * 位置：$DSH_HOME/memory-nebula/nebula.db
 * 只放三样东西：人工策展的连边、缓存、事件日志。
 * **绝不写别的插件的记忆库**。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { nebulaHome } from './sources.js'

let db = null
let dbPath = ''

/** 打开（并在需要时创建）sidecar 库。 */
export function openStore() {
  if (db) return db
  const dir = nebulaHome()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  dbPath = join(dir, 'nebula.db')
  db = new DatabaseSync(dbPath)
  db.exec(`
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
  return db
}

/** 当前 sidecar 库路径。 */
export function storePath() {
  return dbPath || join(nebulaHome(), 'nebula.db')
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
