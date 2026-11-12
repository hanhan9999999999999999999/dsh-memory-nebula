/**
 * 安装体检：在一个可能还没跑起来的机器上，回答「为什么装不上」。
 *
 * 和 `--diagnose` 不同：诊断假设插件已经在跑，拿的是运行时事实；
 * doctor 在启动之前读文件、读 profile、读记忆库，最多再 ping 一下端口。
 * 全部只读，不改 profile、不写记忆库。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverStores } from './sources.js'

export const MIN_NODE = '22.13.0'
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const REQUIRED_FILES = [
  'package.json',
  'lib/index.js',
  'lib/host/http.js',
  'lib/web/index.html',
  'cordis.patch.yml',
  'docs/distribution.md',
]

/** @returns {[number,number,number]|null} */
export function parseVersion(value) {
  const m = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function versionAtLeast(version, min) {
  const a = parseVersion(version)
  const b = parseVersion(min)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return true
}

function item(name, status, detail, hint = '') {
  return { name, status, detail: String(detail || ''), hint: String(hint || '') }
}

export function checkRuntime(version = process.versions.node, platform = process.platform, arch = process.arch) {
  const ok = versionAtLeast(version, MIN_NODE)
  return item(
    'runtime',
    ok ? 'ok' : 'fail',
    `node ${version} / ${platform} ${arch}`,
    ok ? '' : `需要 Node >= ${MIN_NODE}；升级 Node 后重开终端`,
  )
}

export function checkPackage(root = PACKAGE_ROOT) {
  const items = []
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    items.push(item('package.json', 'ok', `${pkg.name || '?'} ${pkg.version || '?'}`))
  } catch (err) {
    items.push(item('package.json', 'fail', String(err.message || err), '确认安装目录完整；重新解包 tgz'))
  }
  const missing = []
  for (const rel of REQUIRED_FILES) {
    if (!existsSync(join(root, rel))) missing.push(rel)
  }
  if (missing.length) {
    items.push(item('files', 'fail', `缺少 ${missing.join(', ')}`, '重新解包 tgz，不要只拷 lib/'))
  } else {
    items.push(item('files', 'ok', `${REQUIRED_FILES.length} 个关键文件齐全`))
  }
  const ok = items.every((x) => x.status !== 'fail')
  return { ok, items, version: pkg?.version || '' }
}

export function checkProfile(profileDir) {
  const dir = resolve(String(profileDir || ''))
  const items = []
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    items.push(item('profile', 'ok', join(dir, 'package.json')))
  } catch (err) {
    items.push(
      item('profile', 'fail', String(err.message || err), '指向 profile 目录（里面有 package.json），不是 plugins 目录'),
    )
    return { ok: false, items }
  }

  const dep = pkg.dependencies?.['dsh-memory-nebula'] || pkg.devDependencies?.['dsh-memory-nebula'] || ''
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const listed = bundles.includes('dsh-memory-nebula')

  if (dep && listed) {
    items.push(item('dependency', 'ok', `dependencies: ${dep}`))
    items.push(item('bundle', 'ok', 'dsh.profile.bundles 已包含 dsh-memory-nebula'))
  } else if (dep && !listed) {
    items.push(item('dependency', 'ok', `dependencies: ${dep}`))
    items.push(
      item('bundle', 'warn', 'dsh.profile.bundles 没有列它', '只装依赖不会加载；把名字加进 bundles 后重启 DSH'),
    )
  } else if (!dep && listed) {
    items.push(item('dependency', 'warn', ' bundles 有，但 dependencies 没声明', '补 dependencies 或 link 后重新安装'))
    items.push(item('bundle', 'ok', 'dsh.profile.bundles 已包含 dsh-memory-nebula'))
  } else {
    items.push(item('dependency', 'fail', 'profile 没有声明 dsh-memory-nebula', '按 docs/distribution.md 的安装步骤加入依赖与 bundles'))
    items.push(item('bundle', 'fail', 'dsh.profile.bundles 没有列它', '把 dsh-memory-nebula 加进 bundles 后重启 DSH'))
  }

  const installedPkg = join(dir, 'node_modules', 'dsh-memory-nebula', 'package.json')
  if (existsSync(installedPkg)) {
    try {
      const ip = JSON.parse(readFileSync(installedPkg, 'utf8'))
      items.push(item('installed', 'ok', `node_modules 里是 ${ip.version || '?'}`))
      if (pkg.dsh?.profile?.bundles && !existsSync(join(dir, 'node_modules', 'dsh-memory-nebula', 'cordis.patch.yml'))) {
        items.push(item('patch', 'warn', '缺 cordis.patch.yml', '包可能被裁剪；重新 npm install'))
      }
    } catch (err) {
      items.push(item('installed', 'fail', String(err.message || err), '删掉 node_modules/dsh-memory-nebula 后重新安装'))
    }
  } else {
    items.push(item('installed', 'warn', 'node_modules 里没有 dsh-memory-nebula', '在 profile 目录运行 npm install'))
  }

  return { ok: items.every((x) => x.status !== 'fail'), items }
}

export function checkSources(opts = {}) {
  try {
    const stores = discoverStores({ extraRoots: opts.roots || [] })
    const names = stores.slice(0, 6).map((s) => s.title || s.key)
    const detail = stores.length ? `${stores.length} 个记忆库：${names.join(' / ')}${stores.length > 6 ? ' …' : ''}` : '没有找到记忆库'
    return item('sources', stores.length ? 'ok' : 'warn', detail, stores.length ? '' : '先在对话里写几条记忆，或确认 .dsh-meow/memory.db 的位置')
  } catch (err) {
    return item('sources', 'warn', String(err.message || err), '检查 DSH 工作区注册表与目录权限')
  }
}

/**
 * @param {string} base
 * @param {number} timeoutMs
 * @param {string} [token] standalone `--token` 的本机口令；只放进 Authorization，不打印
 */
export async function checkEndpoint(base, timeoutMs = 3000, token = '') {
  const url = String(base || '').replace(/\/+$/, '') + '/ping'
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const headers = { accept: 'application/json' }
    if (token) headers.authorization = 'Bearer ' + token
    const res = await fetch(url, { signal: ctl.signal, headers })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return item('endpoint', 'warn', `${url} → HTTP ${res.status}`, '看 DSH 日志或 standalone 控制台；口令模式下确认 --token 正确')
    const out = item(
      'endpoint',
      'ok',
      `${url} → ${body.version || '?'} / ${body.mode || '?'} / ${body.stats?.nodes ?? '?'} memories`,
    )
    out.version = String(body.version || '')
    return out
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : String(err.message || err)
    return item('endpoint', 'warn', `${url} → ${reason}`, '插件没在跑、端口不对，或被别的进程占用')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 装的是新代码、跑的还是旧代码：这是宿主最常见的「升级后没生效」。
 * 只提醒，不阻断；页面通常仍兼容，但新路由/新能力不会出现。
 */
export function checkVersionDrift(installed, running) {
  const have = String(installed || '')
  const live = String(running || '')
  if (!have || !live || have === live) return null
  return item(
    'version',
    'warn',
    `installed ${have}, running host ${live}`,
    '重启 DSH 让宿主加载新代码；只刷新页面不会换掉后端',
  )
}

/**
 * @param {{profile?:string, roots?:string[], base?:string, token?:string}} opts
 */
export async function runDoctor(opts = {}) {
  const pkg = checkPackage(opts.root || PACKAGE_ROOT)
  const checks = [checkRuntime(), ...pkg.items]
  if (opts.profile) checks.push(...checkProfile(opts.profile).items)
  checks.push(checkSources({ roots: opts.roots || [] }))
  if (opts.base) {
    const endpoint = await checkEndpoint(opts.base, 3000, opts.token || '')
    checks.push(endpoint)
    const drift = checkVersionDrift(pkg.version, endpoint.version)
    if (drift) checks.push(drift)
  }
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1
  return { ok: counts.fail === 0, counts, checks }
}

export function formatDoctor(report, opts = {}) {
  const en = opts.lang === 'en'
  const lines = [
    'memory-nebula doctor',
    en ? '# read-only checks; nothing is installed or changed' : '# 只读检查；不安装、不改 profile、不写记忆库',
  ]
  for (const c of report.checks || []) {
    lines.push(`[${c.status}] ${c.name}: ${c.detail}`)
    if (c.hint) lines.push(`       → ${c.hint}`)
  }
  const n = report.counts || {}
  lines.push(
    en
      ? `summary: ${n.ok || 0} ok / ${n.warn || 0} warn / ${n.fail || 0} fail`
      : `summary: ${n.ok || 0} 通过 / ${n.warn || 0} 提醒 / ${n.fail || 0} 失败`,
  )
  if (report.ok === false) lines.push(en ? 'Fix failures above, then run doctor again.' : '先处理上面的 fail，再跑一次 doctor。')
  return lines.join('\n')
}
