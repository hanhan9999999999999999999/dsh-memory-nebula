// 会话转写读取：DSH 的 session.v4.jsonl.zstd 是「多帧 zstd 拼接」，
// node 的 zstdDecompressSync 只解第一帧（198 字节），所以自己按帧头切。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { dshHome } from './sources.js'

const ZSTD_MAGIC = 0xfd2fb528
const SKIP_MAGIC = 0x184d2a50
const SKIP_MASK = 0xfffffff0
const TRANSCRIPT = 'session.v4.jsonl.zstd'
// 运行时上下文 / 记忆注入块 / 系统提示这类「假用户消息」不算主人说的话
const FAKE_USER =
  /^(Current runtime context|\[prompt-inject\]|\[本机长期记忆|\[记忆|（本机长期记忆|（现在是|【meow-memory|可能相关的记忆|=+\s*$|<goal_round>|<acp |<system-reminder>|<available_skills>|<|\s*\[bili\])/
// 长到不像人话的「用户消息」基本都是注入的系统上下文
const MAX_USER_CHARS = 1500

/**
 * 把多帧 zstd 切成单帧。[start,end) 可直接喂给 zstdDecompressSync。
 */
export function splitZstdFrames(buf) {
  const frames = []
  let o = 0
  while (o + 4 <= buf.length) {
    const magic = buf.readUInt32LE(o)
    if ((magic & SKIP_MASK) === SKIP_MAGIC) {
      if (o + 8 > buf.length) break
      const size = buf.readUInt32LE(o + 4)
      const end = o + 8 + size
      if (end > buf.length) break
      frames.push({ start: o, end, skip: true })
      o = end
      continue
    }
    if (magic !== ZSTD_MAGIC) return { frames, error: `bad magic at ${o}` }
    let p = o + 4
    if (p >= buf.length) break
    const fhd = buf[p]
    p += 1
    const fcsFlag = fhd >> 6
    const singleSegment = (fhd >> 5) & 1
    const hasChecksum = (fhd >> 2) & 1
    const dictFlag = fhd & 3
    if (!singleSegment) p += 1
    p += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
    if (fcsFlag === 0) p += singleSegment ? 1 : 0
    else p += fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    if (p > buf.length) break
    let last = false
    while (!last) {
      if (p + 3 > buf.length) return { frames, error: `truncated at ${p}` }
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
      p += 3
      last = (h & 1) === 1
      const type = (h >> 1) & 3
      const size = h >> 3
      if (type === 0 || type === 2) p += size
      else if (type === 1) p += 1
      else return { frames, error: `reserved block at ${p}` }
      if (p > buf.length) return { frames, error: `overrun at ${p}` }
    }
    if (hasChecksum) p += 4
    if (p > buf.length) return { frames, error: `overrun after frame at ${p}` }
    frames.push({ start: o, end: p, skip: false })
    o = p
  }
  return { frames }
}

/** 解整个多帧文件为 utf8 文本。 */
export function decompressTranscript(buf) {
  const { frames, error } = splitZstdFrames(buf)
  if (error) return { error }
  const parts = []
  for (const f of frames) {
    if (f.skip) continue
    try {
      parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)))
    } catch (e) {
      return { error: `frame ${f.start}: ${e.message}` }
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: frames.length }
}

let transcriptIndex = null
/** sessionId → 转写文件路径（第一次调用时扫一遍，之后用缓存）。 */
export function transcriptIndex_() {
  if (transcriptIndex) return transcriptIndex
  const root = join(dshHome(), 'sessions')
  const map = new Map()
  let dirs = []
  try {
    dirs = readdirSync(root)
  } catch {
    transcriptIndex = map
    return map
  }
  for (const d of dirs) {
    const p = join(root, d)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    let subs = []
    try {
      subs = readdirSync(p)
    } catch {
      continue
    }
    for (const s of subs) {
      const q = join(p, s)
      let st2
      try {
        st2 = statSync(q)
      } catch {
        continue
      }
      if (st2.isDirectory()) {
        const file = join(q, TRANSCRIPT)
        try {
          const stf = statSync(file)
          const id = s.replace(/^session-/, '')
          map.set(id, { file, mtime: stf.mtimeMs, size: stf.size })
          map.set(s, { file, mtime: stf.mtimeMs, size: stf.size })
        } catch {}
      }
    }
  }
  transcriptIndex = map
  return map
}

const userCache = new Map() // file → { mtime, messages }

/** 抽出这个会话里「主人真的说过」的话（按时间升序），带 5 分钟内存缓存。 */
export function readUserMessages(file) {
  let st
  try {
    st = statSync(file)
  } catch {
    return []
  }
  const hit = userCache.get(file)
  if (hit && hit.mtime === st.mtimeMs) return hit.messages
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return []
  }
  const r = decompressTranscript(buf)
  if (r.error || !r.text) return []
  const messages = []
  for (const line of r.text.split('\n')) {
    if (!line || line[0] !== '{') continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type !== 'user/message') continue
    const data = o.data || {}
    const kind = data.source && data.source.kind
    if (kind && kind !== 'user') continue
    const parts = Array.isArray(data.content) ? data.content : []
    let text = ''
    for (const part of parts) if (part && part.type === 'text' && part.text) text += part.text
    text = text.trim()
    if (!text || FAKE_USER.test(text) || text.length > MAX_USER_CHARS) continue
    messages.push({ time: o.time || 0, text })
  }
  messages.sort((a, b) => a.time - b.time)
  userCache.set(file, { mtime: st.mtimeMs, messages })
  return messages
}

const originCache = new Map() // sessionId|createdAt → origin

/**
 * 这条记忆是在「哪句话」之后写下的？
 * 取该会话里时间上最近的前一条真实用户消息（允许往后找 2 分钟内的）。
 */
export function originOfMemory({ sessionId, createdAt, maxGapMs = 45 * 60 * 1000 }) {
  if (!sessionId || !createdAt) return null
  const key = `${sessionId}|${createdAt}`
  if (originCache.has(key)) return originCache.get(key)
  const idx = transcriptIndex_()
  const entry = idx.get(sessionId) || idx.get(`session-${sessionId}`)
  if (!entry) {
    originCache.set(key, null)
    return null
  }
  let messages
  try {
    messages = readUserMessages(entry.file)
  } catch {
    messages = []
  }
  let best = null
  for (const m of messages) {
    if (m.time <= createdAt + 2000) {
      if (!best || m.time > best.time) best = m
    }
  }
  let origin = null
  if (best && createdAt - best.time <= maxGapMs) {
    origin = {
      text: best.text.length > 600 ? best.text.slice(0, 600) + '…' : best.text,
      time: best.time,
      gapMs: createdAt - best.time,
      sessionId,
      source: 'transcript',
    }
  }
  originCache.set(key, origin)
  return origin
}

/** 会话转写统计：给「来源面板」用。 */
export function transcriptStats() {
  const idx = transcriptIndex_()
  const files = new Set()
  for (const v of idx.values()) files.add(v.file)
  let bytes = 0
  for (const f of files) {
    for (const v of idx.values()) {
      if (v.file === f) {
        bytes += v.size
        break
      }
    }
  }
  return { sessions: files.size, bytes }
}

/**
 * 工具调用画像：从转写里的 `tool/call` 事件统计「哪个技能 / 哪个 MCP 真被调用过」。
 *
 * 映射规则（宁少不多）：
 * - `name === 'skill'` 且 arguments 里 `{ name }` → 技能名
 * - `name` 形如 `mcp__<server>__<tool>` → MCP 服务器名
 * 别的工具（ops_bash / edit …）只算进总数，不归因到来源。
 *
 * 结果按「索引签名」缓存（文件数 + 总大小 + 最新 mtime），转写有变动才重扫。
 */
let usageCache = { sig: '', data: null }

/**
 * 有些记忆 / 记忆类插件不走 `mcp__` 前缀，而是自己的工具名（`memory_search`…），
 * 这里按前缀归因，仍然是「名字对得上才认」。
 */
const TOOL_OWNER = {
  memory_search: 'plugin:meow-memory',
  memory_remember: 'plugin:meow-memory',
  memory_update: 'plugin:meow-memory',
  memory_read: 'plugin:meow-memory',
  memory_project: 'plugin:meow-memory',
  memory_dream: 'plugin:meow-memory',
  hindsight_search_knowledge_pages: 'plugin:hindsight',
  hindsight_reflect: 'plugin:hindsight',
  hindsight_ingest_document: 'plugin:hindsight',
  nebula_recall: 'plugin:dsh-memory-nebula',
  nebula_inspect: 'plugin:dsh-memory-nebula',
  nebula_link: 'plugin:dsh-memory-nebula',
  nebula_path: 'plugin:dsh-memory-nebula',
  nebula_stats: 'plugin:dsh-memory-nebula',
}
const TOOL_PREFIX = [
  ['weknora_', 'weknora'],
  ['bsk_', 'browser-skill'],
  ['ov_', 'openviking'],
]

function usageSignature(idx) {
  const files = new Set()
  let bytes = 0
  let mtime = 0
  for (const v of idx.values()) {
    if (files.has(v.file)) continue
    files.add(v.file)
    bytes += v.size
    if (v.mtime > mtime) mtime = v.mtime
  }
  return `${files.size}:${bytes}:${Math.round(mtime)}`
}

/** @returns {{bySource: Map<string, {calls:number, sessions:Set<string>, last:number}>, toolCalls:number, scanned:number}} */
export function usageIndex() {
  const idx = transcriptIndex_()
  const sig = usageSignature(idx)
  if (usageCache.data && usageCache.sig === sig) return usageCache.data
  // 会话一直在写，签名几乎每分钟都变；统计很贵（141 个转写 ≈ 4s），
  // 所以 5 分钟内直接用上次结果，别把每次打开详情都做成全量扫描。
  if (usageCache.data && Date.now() - (usageCache.at || 0) < 5 * 60 * 1000) return usageCache.data

  const bySource = new Map()
  const seen = new Set()
  let toolCalls = 0
  for (const [key, entry] of idx) {
    if (key.startsWith('session-')) continue // 双键登记，只用裸 id 那一条
    if (seen.has(entry.file)) continue
    seen.add(entry.file)
    let text = ''
    try {
      const res = decompressTranscript(readFileSync(entry.file))
      text = res.text || ''
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"tool/call"')) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      const d = ev?.data || {}
      const name = String(d.name || '')
      if (!name) continue
      toolCalls += 1
      let src = null
      if (name === 'skill') {
        try {
          const args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments || {}
          if (args && args.name) src = 'skill:' + String(args.name).toLowerCase()
        } catch {}
      } else if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        if (parts.length >= 2) src = 'mcp:' + parts[1].toLowerCase()
      } else if (TOOL_OWNER[name] || TOOL_PREFIX.find((p) => name.startsWith(p[0]))) {
        src = TOOL_OWNER[name] || 'plugin:' + TOOL_PREFIX.find((p) => name.startsWith(p[0]))[1]
      }
      if (!src) continue
      let row = bySource.get(src)
      if (!row) {
        row = { calls: 0, sessions: new Set(), last: 0 }
        bySource.set(src, row)
      }
      row.calls += 1
      row.sessions.add(key)
      if (ev.time > row.last) row.last = ev.time
    }
  }
  usageCache = { sig, at: Date.now(), data: { bySource, toolCalls, scanned: seen.size } }
  return usageCache.data
}

/** 某个来源（技能 / MCP / 插件）实际被调用过多少次、分布在几个会话。 */
export function usageOf(kind, name) {
  if (!name) return null
  const { bySource } = usageIndex()
  const lower = String(name).toLowerCase()
  // 同一个名字可能既是 MCP 又是插件（meow-memory 就是），按 mcp → plugin → skill 依次找
  const kinds = [kind, 'mcp', 'plugin', 'skill'].filter(Boolean)
  for (const k of [...new Set(kinds)]) {
    const row = bySource.get(`${k}:${lower}`)
    if (row) return { calls: row.calls, sessions: row.sessions.size, last: row.last, via: k }
  }
  return { calls: 0, sessions: 0, last: 0 }
}
