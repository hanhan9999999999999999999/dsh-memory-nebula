#!/usr/bin/env node
/**
 * 一条命令跑完整套验收。
 *
 * 这里只做编排：每一步都是项目里已经存在、单独也跑得起来的那把尺子，
 * 汇总成一张表，任何一步红了整体就红。装在别人机器上没有 dev/ 与测试库时，
 * 相关的步骤会标成「跳过」并说明原因——**跳过不是通过**，汇总里分开计数。
 *
 * 用法:
 *   node scripts/verify-all.mjs                 # 单测 + 发行构件 + HTTP 三件套
 *   node scripts/verify-all.mjs --full          # 再加 5 万条库与浏览器三步
 *   node scripts/verify-all.mjs --full --gpu    # 再加三维真 GPU 探针
 *   node scripts/verify-all.mjs --root <库目录> --json
 *
 * 退出码: 0 全过；1 有失败；2 参数错误。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '..') // dev/ 与临时测试库都在仓库根，不在包里
const DEV = join(REPO, 'dev')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}

if (flag('help') || flag('h')) {
  console.log(readMe())
  process.exit(0)
}

const FULL = flag('full') || flag('gpu')
const GPU = flag('gpu')
const JSON_OUT = flag('json')
const ROOT = resolve(opt('root', join(REPO, '.tmp-50k')))
const EXPECT_NODES = Number(opt('nodes', 50000))
const PORT = Number(opt('port', 0)) || freePortSeed()

function freePortSeed() {
  return 62900 + Math.floor(Math.random() * 60)
}

function readMe() {
  return [
    '用法: node scripts/verify-all.mjs [--full] [--gpu] [--root <库目录>] [--nodes <期望条数>] [--json]',
    '',
    '  默认     单测 · 发行构件 · HTTP 冒烟 · 安全面 · 畸形参数',
    '  --full   再加 5 万条库验收 · 浏览器翻页 · 无障碍八状态 · 键盘 Tab 序列',
    '  --gpu    再加三维真 GPU 探针（--gpu 隐含 --full）',
    '  --root   大库那一套用哪个目录（默认仓库根的 .tmp-50k）',
    '  --nodes  这个目录期望有多少条（默认 50000）；不够时那几步标「跳过」而不是「失败」',
  ].join('\n')
}

const has = (p) => existsSync(p)
const devFile = (n) => join(DEV, n)

// ---- 跑一步 ----
function run(label, cmd, args, opts = {}) {
  return new Promise((done) => {
    const t0 = Date.now()
    const child = spawn(cmd, args, { cwd: opts.cwd || PKG, env: { ...process.env, ...(opts.env || {}) } })
    let out = ''
    child.stdout.on('data', (b) => { out += b })
    child.stderr.on('data', (b) => { out += b })
    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill(); out += '\n[超时] ' + opts.timeoutMs + 'ms' }, opts.timeoutMs)
      : null
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      done({ label, code: code == null ? 1 : code, ms: Date.now() - t0, out })
    })
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      done({ label, code: 1, ms: Date.now() - t0, out: String(e && e.message) })
    })
  })
}

// ---- demo 服务（HTTP 三件套共用一台，跑完就收） ----
async function demoServer(port) {
  const child = spawn(process.execPath, ['lib/standalone.mjs', '--demo', '--port', String(port)], { cwd: PKG })
  const base = `http://127.0.0.1:${port}/api/memory-nebula`
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + '/ping')
      if (r.ok) return { base, stop: () => child.kill(), version: (await r.json()).version }
    } catch {}
    await sleep(100)
  }
  child.kill()
  throw new Error('demo 服务起不来（端口 ' + port + '）')
}

const results = []
const note = (label, state, ms, detail) => results.push({ label, state, ms: ms || 0, detail: detail || '' })

// ---- 1. 单测 ----
// 装进别人项目里的副本不带 test/（那 30 个文件只在仓库里跑）。少了它不该崩，
// 也不该假装通过——标跳过，并说清「这个副本没带单测」。
const TEST_DIR = join(PKG, 'test')
if (!has(TEST_DIR)) {
  note('单测', 'skip', 0, '这个副本没带 test/（单测只在仓库里跑）')
} else {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join('test', f))
  const r = await run('单测', process.execPath, ['--test', ...files], { timeoutMs: 300000 })
  const pass = (r.out.match(/^ℹ pass (\d+)/m) || [])[1]
  const fail = (r.out.match(/^ℹ fail (\d+)/m) || [])[1]
  note('单测（' + files.length + ' 个文件）', r.code === 0 ? 'pass' : 'fail', r.ms, pass ? pass + ' 项通过 / ' + fail + ' 失败' : '')
  if (r.code !== 0) console.log(tail(r.out))
}

// ---- 2. 发行构件 ----
// 构件门要读 docs/roadmap.md、market/index.json、test/ 这些只在仓库里齐的东西；
// 装好的副本（或发布出去的 tarball）没有它们，这里只能标跳过，不能报失败。
const REPO_ONLY = ['docs/roadmap.md', 'docs/verified.md', 'market/index.json', 'test']
const missingRepoOnly = REPO_ONLY.filter((p) => !has(join(PKG, p)))
if (missingRepoOnly.length) {
  note('发行构件（每个版本的门）', 'skip', 0, '这个副本没带 ' + missingRepoOnly.join(' / ') + '（构件门只在仓库里跑）')
} else {
  const r = await run('发行构件', process.execPath, ['scripts/release-check.mjs'], { timeoutMs: 120000 })
  note('发行构件（每个版本的门）', r.code === 0 ? 'pass' : 'fail', r.ms, r.code === 0 ? '全部通过' : '')
  if (r.code !== 0) console.log(tail(r.out))
}

// ---- 3–5. HTTP：冒烟 / 安全 / 畸形参数 ----
{
  const port = PORT
  let srv = null
  try {
    srv = await demoServer(port)
    note('HTTP 冒烟', 'pass', 0, 'demo ' + srv.version + ' · ' + srv.base)
    const smoke = await run('冒烟', process.execPath, ['scripts/smoke.mjs', srv.base], { timeoutMs: 180000 })
    note('冒烟（接口契约）', smoke.code === 0 ? 'pass' : 'fail', smoke.ms, lastLine(smoke.out))
    if (smoke.code !== 0) console.log(tail(smoke.out))

    for (const [label, file] of [['安全面（CORS / CSRF / 路径穿越）', 'security-probe.mjs'], ['畸形参数', 'fuzz-1.8.mjs']]) {
      if (!has(devFile(file))) { note(label, 'skip', 0, '没有 dev/' + file + '（这个副本没带开发探针）'); continue }
      const r = await run(label, process.execPath, [devFile(file), srv.base], { timeoutMs: 300000 })
      note(label, r.code === 0 ? 'pass' : 'fail', r.ms, lastLine(r.out))
      if (r.code !== 0) console.log(tail(r.out))
    }
  } catch (e) {
    note('HTTP 三件套', 'fail', 0, String(e.message || e))
  } finally {
    if (srv) srv.stop()
  }
}

// ---- 6–9. 5 万条库与浏览器（--full） ----
let ready = false
let sizeWhy = '没有测试库：' + ROOT
if (FULL) {
  const haveFixture = has(ROOT) && statSync(ROOT).isDirectory()
  const haveEdge = has(EDGE)
  // 先量这个目录里到底有多少条：探针里写死的期望值（5 万）与小库对不上时，
  // 那不是产品的问题，是「拿错了尺子」——这种情况要标成跳过并说清楚，不能报失败。
  let fixtureNodes = 0
  if (haveFixture) {
    try { fixtureNodes = await countNodes(ROOT, PORT + 9) }
    catch (e) { note('测试库预检', 'fail', 0, String(e.message || e)) }
  }
  const sizeOk = fixtureNodes >= EXPECT_NODES
  sizeWhy = haveFixture
    ? `这个目录只有 ${fixtureNodes} 条，探针期望 ≥ ${EXPECT_NODES} 条（用 --nodes 改期望，或换 --root）`
    : '没有测试库：' + ROOT
  if (haveFixture && !sizeOk) note('测试库预检', 'skip', 0, sizeWhy)
  ready = haveFixture && sizeOk
  // 浏览器那两把尺子（翻页、八状态 axe）的断言里写死了 5 万条库的实际数字，
  // 拿 2 万条库去跑它们只会红——那不是产品坏了，是问题问错了。
  const bigReady = ready && fixtureNodes >= 50000
  const bigWhy = ready ? `翻页与八状态探针的断言按 5 万条库写死（这里 ${fixtureNodes} 条）` : sizeWhy
  const steps = [
    ['大库验收（22 项）', 'verify-20k.mjs', [ROOT, String(PORT + 1), String(EXPECT_NODES)], { need: ready, why: sizeWhy, timeoutMs: 900000 }],
    ['浏览器：翻一页', 'verify-page2.mjs', [ROOT], { need: bigReady && haveEdge, why: !haveEdge ? '没有 Edge' : bigWhy, timeoutMs: 600000 }],
    ['无障碍：八状态 axe', 'verify-axe-states.mjs', [ROOT, String(PORT + 2)], { need: bigReady && haveEdge, why: !haveEdge ? '没有 Edge' : bigWhy, timeoutMs: 900000 }],
    ['键盘：Tab 序列', 'verify-taborder.mjs', [ROOT, String(PORT + 3)], { need: bigReady && haveEdge, why: !haveEdge ? '没有 Edge' : bigWhy, timeoutMs: 600000 }],
    // 读不动的来源：自己造一好一坏的目录（好库从 ROOT 里借一个），再用同一把 axe 量
    ['读不动的来源：常驻横幅', 'verify-readerr.mjs', [], { need: bigReady && haveEdge, why: !haveEdge ? '没有 Edge' : bigWhy, timeoutMs: 900000 }],
    // 什么都没变：第二次点「重建星图」必须说没变，而且几百毫秒内回来
    ['重建星图：不变就不建', 'verify-refresh-toast.mjs', [ROOT], { need: bigReady && haveEdge, why: !haveEdge ? '没有 Edge' : bigWhy, timeoutMs: 900000 }],
  ]
  for (const [label, file, args, o] of steps) {
    if (!has(devFile(file))) { note(label, 'skip', 0, '没有 dev/' + file); continue }
    if (!o.need) { note(label, 'skip', 0, o.why); continue }
    const r = await run(label, process.execPath, [devFile(file), ...args], { timeoutMs: o.timeoutMs })
    note(label, r.code === 0 ? 'pass' : 'fail', r.ms, pickSummary(r.out))
    if (r.code !== 0) console.log(tail(r.out))
  }
}

// ---- 10. 三维真 GPU（--gpu） ----
if (GPU) {
  if (!has(devFile('probe-3d-gpu.mjs'))) note('三维：真 GPU', 'skip', 0, '没有 dev/probe-3d-gpu.mjs')
  else if (!ready) note('三维：真 GPU', 'skip', 0, sizeWhy)
  else if (!has(EDGE)) note('三维：真 GPU', 'skip', 0, '没有 Edge')
  else {
    const r = await run('三维：真 GPU', process.execPath, [devFile('probe-3d-gpu.mjs'), ROOT, '--all', '--settle', '--cold'], { timeoutMs: 900000 })
    note('三维：真 GPU（冷布局收敛）', r.code === 0 ? 'pass' : 'fail', r.ms, pickSummary(r.out))
    if (r.code !== 0) console.log(tail(r.out))
  }
}

// ---- 汇总 ----
const pass = results.filter((r) => r.state === 'pass').length
const fail = results.filter((r) => r.state === 'fail').length
const skip = results.filter((r) => r.state === 'skip').length
const total = results.reduce((s, r) => s + r.ms, 0)

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: fail === 0, pass, fail, skip, totalMs: total, steps: results }, null, 2))
} else {
  console.log('')
  for (const r of results) {
    const mark = r.state === 'pass' ? '✓' : r.state === 'fail' ? '✗' : '–'
    const secs = r.ms ? (r.ms / 1000).toFixed(1) + 's' : ''
    console.log(` ${mark} ${r.label.padEnd(30, ' ')} ${secs.padStart(7, ' ')}  ${r.detail}`)
  }
  console.log('')
  console.log(`${fail === 0 ? '全部通过' : fail + ' 步失败'} · ${pass} 通过 / ${fail} 失败 / ${skip} 跳过 · 合计 ${(total / 1000).toFixed(1)}s`)
  if (skip) console.log('（跳过不是通过：上面写清了每一步为什么跳过）')
}

process.exit(fail === 0 ? 0 : 1)

// ---- 小工具 ----
/** 起一个只读服务，问它这个目录里有多少条，然后收掉。预检用，不参与任何断言。 */
async function countNodes(root, port) {
  const child = spawn(process.execPath, ['lib/standalone.mjs', '--root', root, '--port', String(port)], { cwd: PKG })
  const base = `http://127.0.0.1:${port}/api/memory-nebula`
  try {
    for (let i = 0; i < 200; i++) {
      try {
        const r = await fetch(base + '/graph?limit=1')
        if (r.ok) {
          const j = await r.json()
          return (j.stats && j.stats.nodes) || (j.nodes && j.nodes.length) || 0
        }
      } catch {}
      await sleep(100)
    }
    throw new Error('测试库预检：服务起不来（端口 ' + port + '）')
  } finally {
    child.kill()
  }
}

function lastLine(s) {
  const lines = s.trim().split(/\r?\n/).filter(Boolean)
  return lines.length ? lines[lines.length - 1].trim() : ''
}

function pickSummary(s) {
  const lines = s.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  // 红了的时候，表格里要直接写「哪一条红了」——只写「1 项未通过」等于让人再去翻日志
  const bad = lines.find((l) => /^(FAIL|✗|✖)/.test(l))
  if (bad) return bad.slice(0, 120)
  const done = lines.find((l) => /^(全部通过|全部达成|\d+ \/ \d+ 通过)/.test(l))
  return done || lines[lines.length - 1] || ''
}

function tail(s, n = 14) {
  const lines = s.trimEnd().split(/\r?\n/)
  return '  ' + lines.slice(-n).join('\n  ')
}
