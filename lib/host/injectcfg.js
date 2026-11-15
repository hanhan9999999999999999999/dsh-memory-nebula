/**
 * 每轮邻域注入的预算配置（$DSH_HOME/memory-nebula/inject.json）。
 *
 * 这份文件是给人手改的，所以每个键都要有范围：写错一个键不该让注入
 * 悄悄关掉（maxRounds: null），也不该让它每轮都注入（maxRounds: "two"）。
 * 认不出来的值一律回到默认值，并把「哪一项没认」记下来交给调用方写日志——
 * 静默回落正是这个项目栽过几次的坑。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 默认预算：会进 prompt 前缀，尽量保守。 */
export const INJECT_DEFAULTS = {
  maxRounds: 2,
  maxItems: 4,
  maxChars: 900,
  minWeight: 0.5,
  hops: 1,
  perWorkspace: 2,
  perLevel: 2,
}

/** 每个键的取值范围：整数键四舍五入，比例键保留小数。 */
export const INJECT_LIMITS = {
  maxRounds: { kind: 'int', min: 0, max: 5 },
  maxItems: { kind: 'int', min: 1, max: 20 },
  maxChars: { kind: 'int', min: 100, max: 4000 },
  minWeight: { kind: 'num', min: 0, max: 1 },
  hops: { kind: 'int', min: 0, max: 3 },
  perWorkspace: { kind: 'int', min: 0, max: 10 },
  perLevel: { kind: 'int', min: 0, max: 4 },
}

function clampOne(key, raw, notes) {
  const limit = INJECT_LIMITS[key]
  const fallback = INJECT_DEFAULTS[key]
  if (raw === undefined) return fallback
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (raw === null || raw === '' || !Number.isFinite(n)) {
    notes.push(key + ' 不是数字（' + JSON.stringify(raw) + '），用默认值 ' + fallback)
    return fallback
  }
  const v = limit.kind === 'int' ? Math.round(n) : n
  if (v < limit.min || v > limit.max) {
    const fixed = Math.max(limit.min, Math.min(limit.max, v))
    notes.push(key + ' 超出 ' + limit.min + '–' + limit.max + '（收到 ' + v + '），按 ' + fixed + ' 算')
    return fixed
  }
  return v
}

/**
 * 把一份「人手写的」配置规整成安全的一份。
 * @param {unknown} raw
 * @returns {{ value: Record<string, number>, notes: string[] }}
 */
export function normalizeInjectConfig(raw) {
  const notes = []
  const value = { ...INJECT_DEFAULTS }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) notes.push('顶层应该是对象，整份配置被忽略')
    return { value, notes }
  }
  for (const key of Object.keys(INJECT_DEFAULTS)) {
    value[key] = clampOne(key, raw[key], notes)
  }
  for (const key of Object.keys(raw)) {
    if (!(key in INJECT_DEFAULTS)) notes.push('不认识的键 ' + key + '（会被忽略）')
  }
  return { value, notes }
}

/**
 * 从 <home>/memory-nebula/inject.json 读配置；文件不在就是默认值（不记 note）。
 * @param {string} home DSH_HOME
 * @returns {{ value: Record<string, number>, notes: string[] }}
 */
export function readInjectConfig(home) {
  const notes = []
  const file = join(home, 'memory-nebula', 'inject.json')
  let raw
  try {
    if (!existsSync(file)) return { value: { ...INJECT_DEFAULTS }, notes }
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    notes.push('inject.json 读不动（' + (err && err.message ? err.message : String(err)) + '），整份用默认值')
    return { value: { ...INJECT_DEFAULTS }, notes }
  }
  return normalizeInjectConfig(raw)
}
