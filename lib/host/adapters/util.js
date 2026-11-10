/**
 * 适配器公用工具：所有适配器都从这里拿「读文件 / 走目录 / 抠 frontmatter / 造 id」。
 *
 * 这里只做纯函数与只读 IO。任何失败都吞掉并返回空，星图不能因为某个来源坏掉而整体挂。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

/** DSH 家目录。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 星图自己的数据目录（唯一我们写的地方）。 */
export function nebulaHome() {
  return join(dshHome(), 'memory-nebula')
}

/** 安全读 JSON（Windows 上这些文件常带 BOM）。 */
export function readJsonSafe(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (!text.trim()) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 安全读文本。 */
export function readTextSafe(file, limit = 0) {
  try {
    if (!existsSync(file)) return ''
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return limit > 0 ? text.slice(0, limit) : text
  } catch {
    return ''
  }
}

/** 工作区短键：给人看、给 UI 上色、当 node id 的一段。 */
export function slugKey(text, fallback = 'ws') {
  const raw = String(text || '').trim()
  if (!raw) return fallback
  const cleaned = raw.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 24)
  return cleaned || fallback
}

/** 8 位短 hash（内容定位用，避免路径里的冒号/斜杠污染 id）。 */
export function hashShort(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 8)
}

/** 取首行/首句，当标题用。 */
export function firstLine(text, max = 46) {
  const line = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((x) => x.trim())
    .find((x) => x.length > 0)
  const s = (line || '').replace(/^#+\s*/, '')
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 极简 frontmatter 解析：只认 key: value 与 key: [a, b] / - 列表。
 * 够读 SKILL.md、Obsidian 笔记、hindsight 知识页的头部；不引第三方 YAML。
 */
export function parseFrontmatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '')
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { data: {}, body: src }
  const data = {}
  let lastKey = ''
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (kv) {
      lastKey = kv[1]
      let value = kv[2].trim()
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value
          .slice(1, -1)
          .split(',')
          .map((x) => x.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean)
      } else {
        value = value.replace(/^["']|["']$/g, '')
      }
      data[lastKey] = value
      continue
    }
    const li = line.match(/^\s*-\s+(.*)$/)
    if (li && lastKey) {
      const cur = data[lastKey]
      const value = li[1].trim().replace(/^["']|["']$/g, '')
      if (Array.isArray(cur)) cur.push(value)
      else data[lastKey] = [value]
    }
  }
  return { data, body: src.slice(m[0].length) }
}

/**
 * 递归列文件（受控：限制深度、数量、单文件大小）。
 * @param {string} dir
 * @param {{exts?:string[], maxDepth?:number, maxFiles?:number, skipDirs?:Set<string>}} opts
 * @returns {{file:string, rel:string, size:number, mtimeMs:number}[]}
 */
export function walkFiles(dir, opts = {}) {
  const exts = (opts.exts || []).map((e) => e.toLowerCase())
  const maxDepth = opts.maxDepth ?? 4
  const maxFiles = opts.maxFiles ?? 4000
  const skip = opts.skipDirs || new Set(['node_modules', '.git', 'dist', 'build', '.cache', '__pycache__'])
  const out = []
  const seen = new Set()

  const visit = (current, depth) => {
    if (out.length >= maxFiles) return
    let names
    try {
      names = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of names) {
      if (out.length >= maxFiles) return
      const p = join(current, ent.name)
      if (ent.isDirectory()) {
        if (skip.has(ent.name) || ent.name.startsWith('.')) continue
        if (depth >= maxDepth) continue
        visit(p, depth + 1)
        continue
      }
      if (!ent.isFile()) continue
      const ext = extname(ent.name).toLowerCase()
      if (exts.length > 0 && !exts.includes(ext)) continue
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (seen.has(p)) continue
      seen.add(p)
      out.push({ file: p, rel: relative(dir, p).replace(/\\/g, '/'), size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  visit(dir, 0)
  return out
}

/** 目录里最新的 mtime（用来算变化指纹）。 */
export function newestMtime(dir, exts = []) {
  const files = walkFiles(dir, { exts, maxDepth: 3, maxFiles: 800 })
  let max = 0
  for (const f of files) max = Math.max(max, Math.round(f.mtimeMs))
  return { count: files.length, mtime: max }
}

/** 把任意值拍平成字符串关键词数组。 */
export function toKeywordList(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,;，；、\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  }
  return []
}

/** 字符数（中文按 1 算，够用）。 */
export function charLen(text) {
  return String(text || '').length
}

/** 安全取字段（列名可能在配置里换过）。 */
export function pick(row, columns, key, fallback = '') {
  const col = columns?.[key]
  if (!col) return fallback
  const value = row?.[col]
  return value === null || value === undefined ? fallback : value
}

/** 常见时间列：秒 / 毫秒 / ISO 字符串都认。 */
export function toMs(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  const num = Number(value)
  if (Number.isFinite(num) && num > 0) return num < 1e12 ? Math.round(num * 1000) : Math.round(num)
  const t = Date.parse(String(value))
  return Number.isFinite(t) ? t : 0
}

/** 目录是否存在（不抛）。 */
export function dirExists(dir) {
  try {
    return !!dir && existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 文件名去扩展名。 */
export function stem(name) {
  return basename(String(name || '')).replace(/\.[^.]+$/, '')
}

/** 展开 ~ / ~/xx 为真实路径（Windows 用 USERPROFILE）。 */
export function expandHome(p) {
  const raw = String(p || '').trim()
  if (!raw) return ''
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (raw === '~') return home || raw
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return home ? home + raw.slice(1) : raw
  return raw
}
