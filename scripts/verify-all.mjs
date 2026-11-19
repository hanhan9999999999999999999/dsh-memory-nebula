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
 *   node scripts/verify-all.mjs --dev <探针目录>  # 指定探针只从哪一份找
 *
 * 退出码: 0 全过；1 有失败；2 参数错误。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { existingProbeDirs, findProbe, pickFixtureRoot, probePlan } from './probes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
// 1.11.66：仓库根**就是**这个包目录（git rev-parse --show-toplevel 指到这里）。
// 以前这里算的是包的上一层，于是 dev/ 与临时测试库全落在仓库外面：
// 父目录恰好也有个老 dev/（11 月 11 日的安全探针、14 日的 fuzz），verify-all 一直
// 跑的是那两份积灰的副本，而包里今天这份从来没被跑到过。跑外面那份还等于「验证了
// 别人的代码」，比跳过更糟。
const REPO = PKG
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
// 1.11.69：探针可能住在包内 dev/，也可能住在工作区（包的上一级）dev/ 里。
// 按名字逐个找，跑之前把实际用到的那份打出来——否则六个「仓库里应当有它」
// 说的其实是同一件事：它不在 A，而在 B。
const PROBE_DIRS = existingProbeDirs(REPO, { dev: opt('dev') })
const ROOT = resolve(opt('root', pickFixtureRoot(REPO)))
const EXPECT_NODES = Number(opt('nodes', 50000))
const PORT = Number(opt('port', 0)) || freePortSeed()

// 跑之前先说清用哪份尺子、量哪个库：这两件事猜错，整张表的结论就没有意义。
if (!JSON_OUT) {
  console.log('探针：' + (PROBE_DIRS.length ? PROBE_DIRS.join(' + ') : '（没有 dev/，开发探针这几步会标跳过）'))
  if (FULL) console.log('测试库：' + ROOT + (existsSync(ROOT) ? '' : '（不存在）'))
  console.log('')
}

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
    '  --root   大库那一套用哪个目录（默认包内 .tmp-50k，没有就用上一层工作区的同名目录）',
    '  --nodes  这个目录期望有多少条（默认 50000）；不够时那几步标「跳过」而不是「失败」',
    '  --dev    探针只从这一份找（默认依次找包内 dev/ 与上一层 dev/，并在开头打印用到的目录）',
    '  --keep   跑完不删临时 DSH_HOME（默认全过就删；有失败会自动保留并打印路径）',
  ].join('\n')
}

const has = (p) => existsSync(p)
const devFile = (n) => findProbe(n, PROBE_DIRS) || join(REPO, 'dev', n)
// 1.11.66：dev/ 整个不在 = 装好的副本（跳过是诚实的）；dev/ 在、这个探针却不在 = 仓库里被删了。
// 以前两种都算跳过，于是安全探针与 fuzz 从仓库里消失之后，这一步一直「跳过」而没人发现。
// 1.11.69：判定交给 scripts/probes.mjs——它会在候选目录里按名字找，并说清找过哪几处。
const probeState = (n) => probePlan(n, PROBE_DIRS).state
const probeWhy = (n) => probePlan(n, PROBE_DIRS).why

// ---- 每一步用自己的 DSH_HOME ----
// 以前所有步骤共用一个 DSH_HOME：上一步留下的图缓存在下一步会被读盘恢复，
// 更进一步——签名对不上时会先端旧图再在后台重建，后台那轮和下一步的探针抢 CPU。
// 1.11.48 起每步一个新家，避免跨步串味。
//
// 1.11.76：基址以前写成 `process.env.DSH_HOME || tmpdir()`。在 DSH 会话里跑时
// DSH_HOME 就是 D:\dsh-home，于是 12 个临时家全建在宿主的数据目录顶层，跑完也不收，
// 目录名还按序号复用（上一轮的 db-wal 留在原地）。临时家永远只住临时目录，且带
// pid + 时间戳，保证这一轮绝不会读到上一轮。
const KEEP_HOME = flag('keep') || process.env.NEBULA_VERIFY_KEEP === '1'
const HOME_BASE = join(tmpdir(), 'nebula-verify-' + process.pid + '-' + Date.now())
let stepSeq = 0
// 先亮出这一轮的临时家在哪：它跑完就没了，但你知道它从没进过你的 DSH_HOME。
if (!JSON_OUT) console.log('临时家：' + HOME_BASE + '\n')

/** 跑完把临时家收掉。失败或 --keep 时留着，并把路径打出来——排查要证据，但证据不该留在宿主目录里。 */
async function disposeHomes() {
  if (KEEP_HOME) { console.error('\n临时家保留（--keep）：' + HOME_BASE); return }
  if (fail > 0) { console.error('\n临时家保留（有失败，证据在这里）：' + HOME_BASE); return }
  for (let i = 0; i < 3; i++) {
    try { rmSync(HOME_BASE, { recursive: true, force: true }); return } catch {}
    // Windows 上刚 kill 的子进程可能还捏着 sqlite 的 -shm/-wal，隔一会儿再试
    await sleep(300)
  }
  console.error('\n临时家删不掉（子进程可能还没退干净）：' + HOME_BASE)
}
function stepHome(label) {
  stepSeq += 1
  const safe = String(label).replace(/[^\w\u4e00-\u9fa5]+/g, '-').slice(0, 24)
  const dir = join(HOME_BASE, 'step-' + String(stepSeq).padStart(2, '0') + '-' + safe)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---- 跑一步 ----
function run(label, cmd, args, opts = {}) {
  return new Promise((done) => {
    const t0 = Date.now()
    const home = opts.env && opts.env.DSH_HOME ? opts.env.DSH_HOME : stepHome(label)
    const child = spawn(cmd, args, { cwd: opts.cwd || PKG, env: { ...process.env, ...(opts.env || {}), DSH_HOME: home } })
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
      if (probeState(file) !== 'ok') { note(label, probeState(file), 0, probeWhy(file)); continue }
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
    if (probeState(file) !== 'ok') { note(label, probeState(file), 0, probeWhy(file)); continue }
    if (!o.need) { note(label, 'skip', 0, o.why); continue }
    const r = await run(label, process.execPath, [devFile(file), ...args], { timeoutMs: o.timeoutMs })
    note(label, r.code === 0 ? 'pass' : 'fail', r.ms, pickSummary(r.out))
    if (r.code !== 0) console.log(tail(r.out))
  }
}

// ---- 10. 三维真 GPU（--gpu） ----
if (GPU) {
  if (probeState('probe-3d-gpu.mjs') !== 'ok') note('三维：真 GPU', probeState('probe-3d-gpu.mjs'), 0, probeWhy('probe-3d-gpu.mjs'))
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
  console.log(JSON.stringify({ ok: fail === 0, pass, fail, skip, totalMs: total, probes: PROBE_DIRS, root: FULL ? ROOT : null, steps: results }, null, 2))
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

await disposeHomes()
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
