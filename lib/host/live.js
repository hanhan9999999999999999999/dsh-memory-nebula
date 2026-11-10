/**
 * 引擎热载（hot engine）
 *
 * 为什么要这个：DSH 的插件模块在进程里 import 一次就进缓存了，
 * 改 lib/host/*.js 不会重新执行。为了「不重启 DSH 也能迭代星图的算法」，
 * 这里把引擎文件按 mtime 复制到一个带版本号的目录，再从那份新文件 import。
 * 新版 URL 不同 → Node 重新解析整棵树 → 拿到改后的代码。
 *
 * v0.3 起：**递归枚举** lib/host 下所有 .js（含 adapters/ 子目录），
 * 新增适配器/模块不用再回来改这份清单。
 *
 * 换引擎时：新实例先建好图，再原子替换引用；旧实例停掉 watcher。
 * 数据都在 sidecar 库里，换引擎不丢东西。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nebulaHome } from './sources.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 不进热载清单的文件：入口本身静态加载，改了必须重启。 */
const SKIP = new Set(['live.js'])

/** 递归列出引擎文件（相对路径，用 / 分隔）。 */
function listEngineFiles() {
  const out = []
  const walk = (rel) => {
    let entries = []
    try {
      entries = readdirSync(rel ? join(HERE, rel) : HERE, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        walk(childRel)
        continue
      }
      if (!entry.name.endsWith('.js')) continue
      if (SKIP.has(childRel)) continue
      out.push(childRel)
    }
  }
  walk('')
  return out.sort()
}

/** 文件清单 + mtime 指纹；1.5 秒内复用，避免每个 HTTP 请求都 stat 一遍。 */
let stampCache = { at: 0, value: 0, files: [] }
export function engineStamp() {
  const now = Date.now()
  if (now - stampCache.at < 1500 && stampCache.files.length > 0) return stampCache.value
  const files = listEngineFiles()
  let max = 0
  for (const rel of files) {
    try {
      max = Math.max(max, statSync(join(HERE, rel)).mtimeMs)
    } catch {
      /* 文件缺失就当没变 */
    }
  }
  const value = Math.round(max)
  stampCache = { at: now, value, files }
  return value
}

/** 每个 mtime 版本建一个目录。改几十次就攒出一堆（本机曾攒到 110 个 / 10MB），只留最近 3 个 + 当前。 */
function pruneEngineDirs(current) {
  const root = join(nebulaHome(), 'engine')
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return
  }
  const keep = new Set(names.slice(-3))
  keep.add(current)
  for (const name of names) {
    if (keep.has(name)) continue
    try {
      rmSync(join(root, name), { recursive: true, force: true })
    } catch {
      /* 正在被别的版本用着就下次再说 */
    }
  }
}

export class LiveEngine {
  constructor({ onLog } = {}) {
    this.onLog = onLog || (() => {})
    this.instance = null
    this.stamp = 0
    this.loading = null
    this.failures = 0
    this.retryAt = 0
  }

  /** 同步检查：代码变了就在后台换引擎，立刻返回当前实例。 */
  sync() {
    const stamp = engineStamp()
    if (this.instance && stamp === this.stamp) return this.instance
    if (this.loading) return this.instance
    // 失败后必须退避：轮询每 45ms 一次，一次 import 失败会变成一分钟上千条同样的栈，
    // 日志能被撑到几百兆（0.3.0 之前真的发生过）。
    if (this.retryAt && Date.now() < this.retryAt) return this.instance
    this.loading = this.#load(stamp)
      .then((next) => {
        this.failures = 0
        this.retryAt = 0
        return next
      })
      .catch((err) => {
        this.failures += 1
        const backoff = Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6))
        this.retryAt = Date.now() + backoff
        this.onLog(`引擎热载失败（第 ${this.failures} 次，${Math.round(backoff / 1000)}s 后重试）：${err?.stack || err}`)
      })
      .finally(() => {
        this.loading = null
      })
    return this.instance
  }

  /** 确保有实例（首次用）。 */
  async ensure() {
    if (this.instance && engineStamp() === this.stamp) return this.instance
    if (this.loading) await this.loading
    if (this.instance && engineStamp() === this.stamp) return this.instance
    await this.#load(engineStamp())
    return this.instance
  }

  async #load(stamp) {
    const dir = join(nebulaHome(), 'engine', String(stamp))
    const files = stampCache.files.length > 0 ? stampCache.files : listEngineFiles()
    if (!existsSync(join(dir, 'nebula.js'))) {
      mkdirSync(dir, { recursive: true })
      for (const rel of files) {
        const target = join(dir, rel)
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(join(HERE, rel), target)
      }
    }
    pruneEngineDirs(String(stamp))
    const mod = await import(pathToFileURL(join(dir, 'nebula.js')).href)
    const next = new mod.Nebula()
    await next.refresh()
    const prev = this.instance
    this.instance = next
    this.stamp = stamp
    if (prev) {
      try {
        prev.stopWatching()
      } catch {
        /* ignore */
      }
    }
    try {
      next.startWatching(12000)
    } catch {
      /* ignore */
    }
    this.onLog(`引擎就绪 build=${stamp}（记忆 ${next.graph?.nodes?.length ?? 0} 条，模块 ${files.length} 个）`)
    return next
  }
}

/**
 * 门面：调用方拿到的对象永远指向「当前那一版引擎」。
 * 属性读、方法调都实时转发，不会抓到旧实例。
 */
export function liveFacade(live) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const inst = live.sync()
        if (!inst) {
          if (prop === 'refresh' || prop === 'ensure') return () => live.ensure()
          return undefined
        }
        const value = inst[prop]
        if (typeof value !== 'function') return value
        return (...args) => {
          const now = live.instance || inst
          return now[prop](...args)
        }
      },
      set(_target, prop, value) {
        if (live.instance) live.instance[prop] = value
        return true
      },
      has(_target, prop) {
        return live.instance ? prop in live.instance : false
      },
    },
  )
}
