// 验收集合本身也要有契约：这条命令是发布前的唯一入口，参数写错就会静默跑一套错的。
// 这里只测「不跑任何尺子」的那部分——用法说明与参数解析，避免把整套验收嵌进单测里。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existingProbeDirs, pickFixtureRoot, probeDirs, probePlan } from '../scripts/probes.mjs'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = resolve(PKG, 'scripts/verify-all.mjs')

test('--help 打印用法并以 0 退出', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd: PKG, encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /--full/)
  assert.match(r.stdout, /--nodes/)
  assert.match(r.stdout, /--root/)
})

test('汇总口径写在脚本里：通过 / 失败 / 跳过分开计数，并明说跳过不是通过', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  assert.match(src, /const skip = results\.filter/)
  assert.match(src, /跳过不是通过/)
  assert.match(src, /process\.exit\(fail === 0 \? 0 : 1\)/)
  // 「拿错尺子」不能被报成产品坏了：测试库条数要现问，不能假设
  assert.match(src, /async function countNodes/)
  assert.match(src, /fixtureNodes >= EXPECT_NODES/)
  // 装进别人项目里的副本没有 test/ 与 docs/：这几步必须标跳过，不能崩、也不能报失败
  assert.match(src, /const TEST_DIR = join\(PKG, 'test'\)/)
  assert.match(src, /这个副本没带 test\/（单测只在仓库里跑）/)
  assert.match(src, /const REPO_ONLY = /)
  assert.match(src, /missingRepoOnly\.length/)
})

test('package.json 暴露了两个入口', () => {
  const pkg = JSON.parse(readFileSync(resolve(PKG, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['verify:all'], 'node scripts/verify-all.mjs')
  assert.equal(pkg.scripts['verify:full'], 'node scripts/verify-all.mjs --full')
})

// 1.11.69：探针住在包内 dev/ 还是上一层 dev/，不能靠猜——猜错的代价是六步全红，
// 摘要里还写着「仓库里应当有它」，而它就在上面一层。
test('探针目录：默认包内 dev 与上一层 dev，--dev 只认一份', () => {
  const repo = resolve(PKG, 'some', 'pkg')
  assert.deepEqual(probeDirs(repo), [join(repo, 'dev'), join(dirname(repo), 'dev')])
  assert.deepEqual(probeDirs(repo, { dev: 'D:/only' }), [resolve('D:/only')])
})

test('探针判定：先按名字在候选目录里找，找到就用那份跑', () => {
  const base = mkdtempSync(join(tmpdir(), 'nebula-probes-'))
  try {
    const repo = join(base, 'pkg')
    const upDev = join(base, 'dev')
    mkdirSync(join(repo, 'dev'), { recursive: true })
    mkdirSync(upDev, { recursive: true })
    writeFileSync(join(upDev, 'verify-page2.mjs'), '// here\n')
    const dirs = existingProbeDirs(repo)
    assert.deepEqual(dirs, [join(repo, 'dev'), upDev])

    const found = probePlan('verify-page2.mjs', dirs)
    assert.equal(found.state, 'ok')
    assert.equal(found.file, join(upDev, 'verify-page2.mjs'))

    // 一处都没有、但 dev/ 在 → 失败（探针被删了要红，不能悄悄跳过）
    const gone = probePlan('verify-20k.mjs', dirs)
    assert.equal(gone.state, 'fail')
    assert.match(gone.why, /仓库里应当有它/)

    // 连 dev/ 都没有 → 跳过（装好的副本没带开发探针）
    const none = probePlan('verify-page2.mjs', existingProbeDirs(join(base, 'empty', 'pkg')))
    assert.equal(none.state, 'skip')
    assert.match(none.why, /这个副本没带开发探针/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('测试库默认位置：包内 .tmp-50k 优先，其次上一层，都没有时指向包内那个', () => {
  const base = mkdtempSync(join(tmpdir(), 'nebula-root-'))
  try {
    const repo = join(base, 'pkg')
    mkdirSync(repo, { recursive: true })
    assert.equal(pickFixtureRoot(repo), join(repo, '.tmp-50k'))
    mkdirSync(join(base, '.tmp-50k'))
    assert.equal(pickFixtureRoot(repo), join(base, '.tmp-50k'))
    mkdirSync(join(repo, '.tmp-50k'))
    assert.equal(pickFixtureRoot(repo), join(repo, '.tmp-50k'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('编排脚本把探针目录打印出来，不再让人对着六个数字猜', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  assert.match(src, /existingProbeDirs, findProbe, pickFixtureRoot, probePlan/)
  assert.match(src, /'探针：' \+ \(PROBE_DIRS\.length/)
  assert.match(src, /probes: PROBE_DIRS/)
})

// 1.11.76：临时家基址以前是 `process.env.DSH_HOME || tmpdir()`。在 DSH 会话里跑验收时
// 那就是 D:\dsh-home，12 步的家全建在宿主数据目录顶层、跑完不删。这条契约钉住两件事：
// 基址只认临时目录（带 pid + 时间戳），以及跑完有人收（失败/--keep 才留）。
test('临时家：只住 tmpdir、带 pid 与时间戳、跑完就收', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(src, /process\.env\.DSH_HOME\s*\|\|\s*join\(tmpdir\(\)/)
  assert.match(src, /join\(tmpdir\(\), 'nebula-verify-' \+ process\.pid \+ '-' \+ Date\.now\(\)\)/)
  assert.match(src, /async function disposeHomes/)
  assert.match(src, /rmSync\(HOME_BASE, \{ recursive: true, force: true \}\)/)
  assert.match(src, /await disposeHomes\(\)\s*\n\s*process\.exit/)
  assert.match(src, /flag\('keep'\)/)
  assert.match(src, /--keep/)
})
