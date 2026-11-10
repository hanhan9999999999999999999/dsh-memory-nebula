/**
 * 适配器：ingest —— 星图自己的「外部推送」落点
 *
 * 有些记忆插件根本没把记忆落在本地（hindsight、openviking 都是远端服务），
 * 硬读磁盘是读不到的。这一层给一条正路：
 *
 *     任何插件 / 任何 agent → nebula_ingest 工具 或 POST /api/memory-nebula/ingest
 *                          → $DSH_HOME/memory-nebula/ingest/<provider>.jsonl
 *                          → 星图重建时读回来，进同一张图
 *
 * 写的是星图自己的目录，从不碰别人的库；同 uid 后写覆盖，重复推送不会长重影。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { nebulaHome, slugKey, toKeywordList, toMs, hashShort } from './util.js'

export const meta = {
  id: 'ingest',
  name: '外部推送',
  kind: 'file',
  description:
    '接收其他记忆插件/外部 agent 主动推进来的记忆（星图自己的目录，JSONL）。给「读不到磁盘」的远端记忆服务（hindsight / openviking）留的正路。',
  config: {},
}

/** 推送目录。 */
export function ingestDir() {
  return join(nebulaHome(), 'ingest')
}

/**
 * 探测：有文件就产出一个 store（每个 provider 一文件）。
 * @param {object} config
 */
export function detect(config = {}) {
  const dir = ingestDir()
  if (!existsSync(dir)) return []
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return []
  }
  return names.map((name) => {
    const provider = name.replace(/\.jsonl$/, '')
    let size = 0
    let mtimeMs = 0
    try {
      const st = statSync(join(dir, name))
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      /* ignore */
    }
    return {
      id: 'ingest:' + provider,
      provider,
      adapter: 'ingest',
      title: provider,
      path: join(dir, name),
      key: slugKey(provider, 'ingest'),
      size,
      mtimeMs,
      config,
    }
  })
}

/** 扫描：读所有推送文件，按 uid 去重（后写覆盖先写）。 */
export function scan(store) {
  const nodes = []
  const seen = new Map()
  let text = ''
  try {
    text = readFileSync(store.path, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return { nodes, ledgers: [] }
  }
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    let row
    try {
      row = JSON.parse(s)
    } catch {
      continue
    }
    if (!row || typeof row !== 'object') continue
    const uid = String(row.uid || row.id || hashShort(String(row.content || row.title || '') + seen.size))
    seen.set(uid, row)
  }
  for (const [uid, row] of seen) {
    const content = String(row.content ?? '').trim()
    const title = String(row.title ?? '').trim()
    if (!content && !title) continue
    const level = String(row.level || 'note').trim().toLowerCase() || 'note'
    const ws = String(row.ws || row.workspace || store.title)
    nodes.push({
      id: `ingest:${store.key}:${level}:${uid}`,
      uid,
      provider: store.provider,
      adapter: 'ingest',
      storeId: store.id,
      ws: slugKey(ws, 'ingest'),
      wsTitle: ws,
      wsPath: String(row.wsPath || ''),
      level,
      title,
      label: (title || content).length > 42 ? (title || content).slice(0, 42) + '…' : title || content,
      content,
      importance: Math.max(0, Math.min(4, Number(row.importance) || 0)),
      status: String(row.status || 'active'),
      project: String(row.project || '').trim(),
      subcategory: String(row.subcategory || ''),
      goal: String(row.goal || ''),
      corrected: false,
      keywords: toKeywordList(row.keywords),
      sessionId: String(row.sessionId || ''),
      hits: Number(row.hits) || 0,
      createdAt: toMs(row.createdAt) || Date.now(),
      updatedAt: toMs(row.updatedAt) || toMs(row.createdAt) || Date.now(),
      accessedAt: toMs(row.accessedAt),
    })
  }
  return { nodes, ledgers: [] }
}

/**
 * 追加推送。同 uid 后写覆盖（读取端按 uid 去重）。
 * @param {string} provider
 * @param {object[]} items
 * @returns {{written:number, file:string}}
 */
export function appendIngest(provider, items) {
  const name = slugKey(provider || 'external', 'external').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'external'
  const dir = ingestDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name + '.jsonl')
  const lines = []
  let written = 0
  for (const raw of items || []) {
    if (!raw || typeof raw !== 'object') continue
    const content = String(raw.content ?? '').trim()
    const title = String(raw.title ?? '').trim()
    if (!content && !title) continue
    const uid = String(raw.uid || raw.id || hashShort((title || content) + '\u0000' + (raw.createdAt || '') + Math.random()))
    lines.push(
      JSON.stringify({
        uid,
        title,
        content,
        level: String(raw.level || 'note'),
        project: String(raw.project || ''),
        keywords: toKeywordList(raw.keywords),
        importance: Number(raw.importance) || 0,
        status: String(raw.status || 'active'),
        ws: String(raw.ws || raw.workspace || provider || 'external'),
        wsPath: String(raw.wsPath || ''),
        sessionId: String(raw.sessionId || ''),
        createdAt: toMs(raw.createdAt),
        updatedAt: toMs(raw.updatedAt),
        at: Date.now(),
      }),
    )
    written += 1
  }
  if (lines.length > 0) appendFileSync(file, lines.join('\n') + '\n', 'utf8')
  return { written, file }
}

export function probe() {
  const dir = ingestDir()
  let files = []
  try {
    files = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
  } catch {
    /* ignore */
  }
  return {
    ok: true,
    stores: files.map((f) => ({ id: 'ingest:' + f.replace(/\.jsonl$/, ''), path: join(dir, f) })),
    note: files.length ? `${files.length} 个推送来源` : '还没有外部推送（目录 ' + dir + '）',
  }
}
