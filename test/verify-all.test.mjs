// 验收集合本身也要有契约：这条命令是发布前的唯一入口，参数写错就会静默跑一套错的。
// 这里只测「不跑任何尺子」的那部分——用法说明与参数解析，避免把整套验收嵌进单测里。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
