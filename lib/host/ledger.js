/**
 * 统一注入账本 —— 「哪些记忆已经给模型看过了」
 *
 * 为什么需要它：星图不是唯一的记忆来源。meow-memory 每轮注入它自己的条目，
 * hindsight / openviking 也可能注入，星图再注入「邻居」时如果不知道别人已经喂过什么，
 * 就会重复、抢预算、把上下文塞满同一件事。
 *
 * 这一层把三路信号合成一个集合：
 *
 *   1. meow 的会话账本      <cwd>/.dsh-meow/sessions/<sid>.json（只读，别人的）
 *   2. 星图自己的注入记录   $DSH_HOME/memory-nebula/injected/<sid>.json（可写）
 *   3. 外部插件的声明       同目录下 <sid>.json 里的 external 段（别人可以往里写）
 *
 * 另外维护一个跨会话冷却表：
 *
 *   $DSH_HOME/memory-nebula/injected/_global.json  { uid: lastInjectedAt }
 *
 * 冷却的意义：一条高价值邻居不该每个新会话都占一次预算。默认 7 天内不再主动推同一条，
 * 除非它被显式检索（那是用户/模型自己要点，不冷却）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { nebulaHome } from './adapters/util.js'

export const GLOBAL_COOLDOWN_MS = 7 * 24 * 3600 * 1000
/** 单文件最大读取（防呆：账本不该有几十 MB） */
const MAX_LEDGER_BYTES = 4 * 1024 * 1024

export function injectedDir() {
  return join(nebulaHome(), 'injected')
}

export function ledgerFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^\w.@-]+/g, '%')
  return join(injectedDir(), safe + '.json')
}

function globalFile() {
  return join(injectedDir(), '_global.json')
}

function readJson(file) {
  try {
    if (!existsSync(file)) return null
    const st = statSync(file)
    if (!st.isFile() || st.size > MAX_LEDGER_BYTES) return null
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 读本会话的星图账本。
 * @returns {{seen: Record<string, number>, injected: string[], external: Record<string, number>, updatedAt: number}}
 */
export function readLedger(sessionId) {
  const raw = readJson(ledgerFile(sessionId)) || {}
  const seen = raw.seen && typeof raw.seen === 'object' ? raw.seen : {}
  const external = raw.external && typeof raw.external === 'object' ? raw.external : {}
  return {
    seen,
    external,
    injected: Array.isArray(raw.injected) ? raw.injected : [],
    updatedAt: Number(raw.updatedAt) || 0,
  }
}

/**
 * 把一批 uid 记为「已见」。
 * @param {string} sessionId
 * @param {string[]} uids
 * @param {string} by 来源标记：nebula:inject / nebula:tool / external:<name>
 */
export function markSeen(sessionId, uids, by = 'nebula:inject') {
  const list = (uids || []).map((u) => String(u || '').trim()).filter(Boolean)
  if (list.length === 0) return { marked: 0 }
  const file = ledgerFile(sessionId)
  const cur = readJson(file) || {}
  const now = Date.now()
  cur.seen = cur.seen && typeof cur.seen === 'object' ? cur.seen : {}
  cur.injected = Array.isArray(cur.injected) ? cur.injected : []
  const external = String(by).startsWith('external')
  if (external) cur.external = cur.external && typeof cur.external === 'object' ? cur.external : {}
  for (const uid of list) {
    cur.seen[uid] = now
    if (external) cur.external[uid] = now
    if (!cur.injected.includes(uid)) cur.injected.push(uid)
  }
  // 账本别无限长：只留最近 2000 条
  if (cur.injected.length > 2000) cur.injected = cur.injected.slice(-2000)
  cur.updatedAt = now
  cur.sessionId = String(sessionId || '')
  writeJson(file, cur)
  return { marked: list.length }
}

/**
 * 合并「谁已经看过什么」，得到本轮可用的已见集合。
 *
 * @param {string} sessionId
 * @param {{injected?: string[], searched?: string[], accessed?: string[], written?: string[]}} meowLedger
 *        meow 的会话账本（可空）
 * @returns {Set<string>} uid 集合
 */
export function seenSet(sessionId, meowLedger = null) {
  const out = new Set()
  const add = (v) => {
    if (v === null || v === undefined) return
    const s = String(v).trim()
    if (!s) return
    out.add(s)
    // 兼容完整 id：同时收裸 uid
    const parts = s.split(':')
    if (parts.length > 1) out.add(parts[parts.length - 1])
  }
  for (const key of ['injected', 'searched', 'accessed', 'written']) {
    const list = meowLedger && Array.isArray(meowLedger[key]) ? meowLedger[key] : []
    for (const v of list) add(v)
  }
  const mine = readLedger(sessionId)
  for (const uid of Object.keys(mine.seen)) add(uid)
  for (const uid of Object.keys(mine.external)) add(uid)
  return out
}

/** 读全局冷却表：uid → lastInjectedAt */
export function readCooldown() {
  const raw = readJson(globalFile()) || {}
  const map = new Map()
  const now = Date.now()
  for (const [uid, at] of Object.entries(raw)) {
    const t = Number(at) || 0
    if (t && now - t < GLOBAL_COOLDOWN_MS) map.set(uid, t)
  }
  return map
}

/** 写冷却表（顺手裁掉过期项）。 */
export function markCooldown(uids) {
  const list = (uids || []).map((u) => String(u || '').trim()).filter(Boolean)
  if (list.length === 0) return { marked: 0 }
  const now = Date.now()
  const cur = readJson(globalFile()) || {}
  const next = {}
  for (const [uid, at] of Object.entries(cur)) {
    const t = Number(at) || 0
    if (t && now - t < GLOBAL_COOLDOWN_MS) next[uid] = t
  }
  for (const uid of list) next[uid] = now
  writeJson(globalFile(), next)
  return { marked: list.length }
}

/** 体检用：账本规模。 */
export function ledgerStats() {
  const dir = injectedDir()
  let files = []
  try {
    files = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    files = []
  }
  return { dir, sessions: files.length, cooldown: readCooldown().size }
}
