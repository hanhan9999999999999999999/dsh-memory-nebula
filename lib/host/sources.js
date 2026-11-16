/**
 * 记忆来源发现与只读抽取。
 *
 * 铁律：本文件只读别的插件写下的东西，绝不写入它们的目录。
 * 所有可能失败的地方都吞掉异常 —— 星图挂了不能影响宿主。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { clip } from './text.js'
import { dshHome } from './adapters/util.js'

/** meow-memory 的记忆层（表名）。 */
export const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

/** 每一层在星图里的语义（给 UI 用）。 */
export const LEVEL_META = {
  soul: { label: '灵魂', zh: 'AI 自身', rank: 6 },
  user: { label: '主人', zh: '用户画像', rank: 5 },
  project: { label: '项目', zh: '项目档案', rank: 4 },
  lesson: { label: '教训', zh: '经验', rank: 3 },
  topic: { label: '话题', zh: '事线', rank: 3 },
  fact: { label: '事实', zh: '碎事实', rank: 2 },
  rules: { label: '准则', zh: '行为准则', rank: 5 },
}

/** DSH 家目录 —— 只从 adapters/util.js 取一处定义，这里转出去给老调用方。 */
export { dshHome }

/** 星图自己的数据目录（唯一我们写的地方）。 */
export function nebulaHome() {
  const dir = join(dshHome(), 'memory-nebula')
  return dir
}

/** 安全读 JSON（Windows 上这些文件常带 BOM，JSON.parse 会直接炸）。 */
function readJsonFile(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (!text.trim()) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * 读 workspace 注册表：拿到所有工作区（id / title / path）。
 * @returns {{id:string,title:string,path:string}[]}
 */
export function readWorkspaceRegistry() {
  const file = join(dshHome(), 'storages', 'workspace.json')
  const data = readJsonFile(file, null)
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

/**
 * 工作区短键：给 UI 颜色、以及稳定的 node 前缀用。
 * @param {string} wsPath
 * @param {string} title
 */
export function workspaceKey(wsPath, title) {
  const t = String(title || basename(wsPath) || wsPath)
  return t.replace(/\s+/g, '').slice(0, 24)
}

/**
 * 发现所有 meow-memory 记忆库（只读）。
 * 扫描范围：注册表里的工作区 + DSH_HOME 自身，外加可选的额外根目录。
 * @param {{extraRoots?: string[]}} [opts]
 * @returns {{id:string,title:string,path:string,key:string,dbPath:string,sessionsDir:string,size:number,mtimeMs:number}[]}
 */
export function discoverStores(opts = {}) {
  const workspaces = readWorkspaceRegistry()
  const seen = new Set()
  const stores = []

  const consider = (wsPath, title, id) => {
    const norm = String(wsPath).replace(/[\\/]+$/, '')
    if (!norm || seen.has(norm.toLowerCase())) return
    seen.add(norm.toLowerCase())
    const dir = join(norm, '.dsh-meow')
    const dbPath = join(dir, 'memory.db')
    if (!existsSync(dbPath)) return
    let size = 0
    let mtimeMs = 0
    try {
      const st = statSync(dbPath)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      /* 文件在但读不到 stat 就跳过 */
    }
    stores.push({
      id: id || norm,
      title: String(title || basename(norm)),
      path: norm,
      key: workspaceKey(norm, title),
      dbPath,
      sessionsDir: join(dir, 'sessions'),
      size,
      mtimeMs,
    })
  }

  for (const ws of workspaces) consider(ws.path, ws.title, ws.id)

  // 兜底：注册表里没有、但工作区目录里确实有记忆库的，也收进来
  for (const root of opts.extraRoots || []) {
    try {
      if (!existsSync(root)) continue
      for (const name of readdirSync(root)) {
        const p = join(root, name)
        try {
          if (statSync(p).isDirectory()) consider(p, name, p)
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

/** 容忍老库缺列的读取器。 */
function columnsOf(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)))
  } catch {
    return new Set()
  }
}

/**
 * 读 meow-memory 每会话的活动账本（injected / searched / written ...）。
 * 这些账本是「谁和谁一起被点亮过」的原始证据，用来做 Hebbian 共激活连边。
 * @param {string} sessionsDir
 * @returns {{sessionId:string, kind:string, ids:string[], currentProject:string}[]}
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
    const rec = readJsonFile(join(sessionsDir, name), null)
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

/**
 * 安装了什么插件 / 技能 / MCP —— 星图的「记录者」图层。
 * 只读 profile 与 skills 目录，不动它们。
 * @returns {{plugins:{name:string,version:string,bundle:boolean,local:boolean}[], skills:{name:string,description:string}[], mcp:{name:string,transport:string}[]}}
 */
export function readInventory() {
  const inventory = { plugins: [], skills: [], mcp: [] }

  // 1) profile 里选中的 bundle + 依赖
  const profileDir = join(dshHome(), 'profiles', 'desktop')
  const pkg = readJsonFile(join(profileDir, 'package.json'), null)
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  for (const name of bundles) {
    const spec = typeof deps[name] === 'string' ? deps[name] : ''
    let version = ''
    try {
      const modPath = join(profileDir, 'node_modules', name, 'package.json')
      const mod = readJsonFile(modPath, null)
      version = String(mod?.version || '')
    } catch {
      /* ignore */
    }
    inventory.plugins.push({
      name,
      version,
      bundle: true,
      local: spec.startsWith('file:') || spec.startsWith('link:') || spec === '',
      spec,
    })
  }

  // 2) 技能目录（SKILL.md 的 frontmatter name/description）
  const skillsDir = join(dshHome(), 'skills')
  try {
    for (const name of readdirSync(skillsDir)) {
      const file = join(skillsDir, name, 'SKILL.md')
      if (!existsSync(file)) continue
      let text = ''
      try {
        text = readFileSync(file, 'utf8').slice(0, 4000)
      } catch {
        continue
      }
      let title = name
      let description = ''
      const fm = text.match(/^---\s*\n([\s\S]*?)\n---/)
      if (fm) {
        const body = fm[1]
        const nameMatch = body.match(/^\s*name:\s*(.+)$/m)
        const descMatch = body.match(/^\s*description:\s*(.+)$/m)
        if (nameMatch) title = nameMatch[1].trim().replace(/^["']|["']$/g, '')
        if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '')
      }
      inventory.skills.push({ name: title, dir: name, description: clip(description, 160) })
    }
  } catch {
    /* ignore */
  }

  // 3) MCP：profile patch + 家目录 patch 里 dsh-mcp-client 的条目
  const patches = [join(profileDir, 'cordis.patch.yml'), join(dshHome(), 'cordis.patch.yml')]
  for (const file of patches) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // 极简 YAML 嗅探：只认 `- id: xxx` 后面 10 行内出现 mcp 的情况
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*-\s*id:\s*([\w@./-]+)\s*$/)
      if (!m) continue
      // 只看到下一个条目为止：原来固定看 24 行，会把下一个插件的 mcp 字样算进来，
      // 于是普通插件被错认成 MCP 服务器（1.11.39）。
      const nextId = lines.findIndex((line, k) => k > i && /^\s*-\s*id:\s*[\w@./-]+\s*$/.test(line))
      const stop = nextId < 0 ? Math.min(lines.length, i + 24) : nextId
      const window = lines.slice(i, stop).join('\n')
      if (!/mcp/i.test(window)) continue
      const id = m[1]
      if (inventory.mcp.some((x) => x.name === id)) continue
      const transport = /"?(stdio|sse|streamable-http|http)"?/.exec(window)?.[1] || 'mcp'
      inventory.mcp.push({ name: id, transport })
    }
  }

  return inventory
}
