/**
 * 适配器注册表 —— 星图的「外部记忆」入口层
 *
 * 星图不假设记忆长什么样。它只要求一个适配器能回答四件事：
 *
 *   meta                    这个适配器叫什么、接什么、配置怎么写
 *   detect(config) → Store[]  按配置找出可读的「库」（文件/目录/远端缓存）
 *   scan(store)   → {nodes, ledgers}  把库读成统一节点
 *   probe(config) → 报告      给人/AI 看的接入体检（不写、不炸）
 *
 * 于是接入一个新记忆插件有两条路：
 *   1. 有落盘（SQLite / JSONL / Markdown / 目录）→ 在 sources.json 写一条，零代码；
 *   2. 没落盘（远端服务）→ 用 ingest 通道把它「推」进来，或写一个 10 行的新适配器。
 *
 * 详细接入说明见 docs/adapters.md。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, nebulaHome, expandHome, slugKey } from './util.js'
import * as meow from './meow.js'
import * as notes from './notes.js'
import * as sqlite from './sqlite.js'
import * as ingest from './ingest.js'

export const ADAPTERS = { meow, notes, sqlite, ingest }

/** 适配器清单（给 nebula_sources 工具和文档用）。 */
export function adapterCatalog() {
  return Object.entries(ADAPTERS).map(([key, a]) => ({
    id: a.meta?.id || key,
    name: a.meta?.name || key,
    kind: a.meta?.kind || 'file',
    description: a.meta?.description || '',
    config: a.meta?.config || {},
    builtin: key === 'meow' || key === 'ingest',
  }))
}

export function configPath() {
  return join(nebulaHome(), 'sources.json')
}

const DEFAULT_CONFIG = {
  version: 1,
  autoDetect: true,
  sources: [],
  extraRoots: [],
  disabled: {},
}

/** 读配置；文件不存在/坏了都用默认值（永远不因为配置炸掉）。 */
export function readSourcesConfig() {
  const file = configPath()
  if (!existsSync(file)) return { ...DEFAULT_CONFIG, file, exists: false }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG, file, exists: false }
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      sources: Array.isArray(raw.sources) ? raw.sources : [],
      extraRoots: Array.isArray(raw.extraRoots) ? raw.extraRoots : [],
      disabled: raw.disabled && typeof raw.disabled === 'object' ? raw.disabled : {},
      file,
      exists: true,
    }
  } catch (err) {
    return { ...DEFAULT_CONFIG, file, exists: true, error: String(err?.message || err) }
  }
}

/** 已知的「别人家记忆插件」落盘约定：存在才接，不存在不吭声。 */
const KNOWN_LOCATIONS = [
  { path: '~/.hindsight/knowledge', title: 'Hindsight 知识页', level: 'topic', adapter: 'notes' },
  { path: '~/.hindsight/pages', title: 'Hindsight 页面', level: 'topic', adapter: 'notes' },
  { path: '~/.hindsight/memories', title: 'Hindsight 记忆', level: 'note', adapter: 'notes' },
  { path: '~/.openviking/memory', title: 'OpenViking 记忆', level: 'note', adapter: 'notes' },
  { path: '~/.openviking/skills', title: 'OpenViking 技能', level: 'note', adapter: 'notes' },
  { path: '~/.dsh/memories', title: 'DSH 记忆', level: 'note', adapter: 'notes' },
  { path: '~/.claude/memory', title: 'Claude 记忆', level: 'note', adapter: 'notes' },
]

/**
 * 发现所有可读来源。
 * @param {{extraRoots?: string[], autoDetect?: boolean, disabled?: object}} opts
 * @returns {{stores: object[], reports: object[], errors: object[]}}
 */
export function discoverSources(opts = {}) {
  const config = readSourcesConfig()
  const autoDetect = opts.autoDetect ?? config.autoDetect
  const disabled = opts.disabled || config.disabled || {}
  const stores = []
  const reports = []
  const errors = []

  const push = (list, label, adapterId) => {
    for (const store of list || []) {
      if (stores.some((s) => s.id === store.id)) continue
      stores.push(store)
      reports.push({ adapter: adapterId, label, store: store.id, title: store.title, ok: true })
    }
  }

  // 1) 内置：meow-memory（本机主存储，永远尝试）
  if (!disabled.meow) {
    try {
      const roots = [
        ...(Array.isArray(opts.extraRoots) ? opts.extraRoots : []),
        ...(Array.isArray(config.extraRoots) ? config.extraRoots : []),
      ]
      const list = meow.detect({ extraRoots: roots })
      push(list, '各工作区 .dsh-meow', 'meow')
      if (list.length === 0) reports.push({ adapter: 'meow', ok: false, note: '没找到 .dsh-meow 记忆库' })
    } catch (err) {
      errors.push({ adapter: 'meow', error: String(err?.message || err) })
    }
  }

  // 2) 内置：外部推送（本机其他插件推过来的）
  if (!disabled.ingest) {
    try {
      push(ingest.detect({}), '外部推送目录', 'ingest')
    } catch (err) {
      errors.push({ adapter: 'ingest', error: String(err?.message || err) })
    }
  }

  // 3) 配置声明的来源（用户/AI 自己加的）
  for (const item of config.sources) {
    if (!item || typeof item !== 'object') continue
    const adapterId = String(item.adapter || item.type || '').trim()
    const adapter = ADAPTERS[adapterId]
    if (!adapter) {
      errors.push({ adapter: adapterId || '(未指定)', error: '没有这个适配器；可用：' + Object.keys(ADAPTERS).join(' / ') })
      continue
    }
    if (disabled[adapterId] || item.enabled === false) continue
    try {
      const list = adapter.detect(item)
      push(list, item.title || item.path || adapterId, adapterId)
      if ((list || []).length === 0) {
        reports.push({
          adapter: adapterId,
          ok: false,
          note: `按配置没找到可读内容：${item.path || '(未配置 path)'}`,
        })
      }
    } catch (err) {
      errors.push({ adapter: adapterId, path: item.path, error: String(err?.message || err) })
    }
  }

  // 4) 自动探测：常见记忆插件的落盘位置
  if (autoDetect) {
    for (const item of KNOWN_LOCATIONS) {
      const path = expandHome(item.path)
      if (!path || !existsSync(path)) continue
      if (stores.some((s) => s.path === path)) continue
      try {
        const list = notes.detect({ path, title: item.title, level: item.level, id: 'auto:' + slugKey(item.title) })
        push(list, '自动发现：' + item.title, 'notes')
      } catch (err) {
        errors.push({ adapter: 'notes', path, error: String(err?.message || err) })
      }
    }
  }

  return { stores, reports, errors, config }
}

/**
 * 扫描全部来源，聚合节点与账本。
 * 单个库读坏不影响其它库。
 */
export function scanAll(stores) {
  const nodes = []
  /** buildGraph 要的是数组：{sessionId, kind, ids[], ws} —— 别拍成 map。 */
  const ledgers = []
  const errors = []
  for (const store of stores || []) {
    const adapter = ADAPTERS[store.adapter]
    if (!adapter || typeof adapter.scan !== 'function') {
      errors.push({ store: store.id, error: '适配器 ' + store.adapter + ' 不能扫描' })
      continue
    }
    try {
      const res = adapter.scan(store) || {}
      for (const n of res.nodes || []) nodes.push({ ...n, storeId: n.storeId || store.id })
      if (Array.isArray(res.ledgers)) {
        for (const row of res.ledgers) if (row && row.sessionId && Array.isArray(row.ids)) ledgers.push(row)
      } else if (res.ledgers && typeof res.ledgers === 'object') {
        for (const [session, value] of Object.entries(res.ledgers)) {
          if (value && Array.isArray(value.ids)) ledgers.push({ ...value, sessionId: session })
        }
      }
      if (res.error) errors.push({ store: store.id, error: res.error })
    } catch (err) {
      errors.push({ store: store.id, error: String(err?.message || err) })
    }
  }
  return { nodes, ledgers, errors }
}

/** 体检：把每个配置项/适配器都问一遍，给人类看的报告。 */
export function probeAll() {
  const config = readSourcesConfig()
  const out = []
  out.push({ adapter: 'meow', ...(meow.probe ? meow.probe() : { ok: false, note: '无 probe' }) })
  out.push({ adapter: 'ingest', ...(ingest.probe ? ingest.probe() : { ok: false, note: '无 probe' }) })
  for (const item of config.sources || []) {
    const adapterId = String(item.adapter || item.type || '')
    const adapter = ADAPTERS[adapterId]
    if (!adapter) {
      out.push({ adapter: adapterId, ok: false, note: '未知适配器' })
      continue
    }
    try {
      out.push({ adapter: adapterId, path: item.path, ...(adapter.probe ? adapter.probe(item) : { ok: true }) })
    } catch (err) {
      out.push({ adapter: adapterId, path: item.path, ok: false, note: String(err?.message || err) })
    }
  }
  return { config: { path: config.file, exists: config.exists, error: config.error, autoDetect: config.autoDetect }, probes: out }
}
