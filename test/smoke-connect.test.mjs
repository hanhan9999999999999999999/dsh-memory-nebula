import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SMOKE = join(PKG, 'scripts', 'smoke.mjs')

// 一个几乎肯定没人监听的地址：连不上要说得清，而不是甩一句 `TypeError: fetch failed`
const DEAD = 'http://127.0.0.1:9/api/memory-nebula'

const run = (base) => {
  const r = spawnSync(process.execPath, [SMOKE, base], {
    cwd: PKG,
    encoding: 'utf8',
    env: { ...process.env, NEBULA_BASE: '' },
    timeout: 60000,
  })
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' }
}

test('连不上时：说清连的是哪个地址，并给出三条现成的起法', () => {
  const r = run(DEAD)
  assert.equal(r.code, 1)
  assert.match(r.err, /smoke 连不上：/)
  assert.ok(r.err.includes(DEAD), '要把 base 原样打出来')
  assert.match(r.err, /standalone\.mjs --port 7890/)
  assert.match(r.err, /NEBULA_BASE=/)
  assert.match(r.err, /7891/)
})

test('连不上时不叫「自己出错了」——那是脚本的 bug，不是环境的', () => {
  const r = run(DEAD)
  assert.ok(!r.err.includes('smoke 自己出错了'), '连接失败不该被打成脚本 bug')
  assert.ok(!/TypeError: fetch failed/.test(r.err), '别把原始 fetch 报错直接甩给用户')
})

test('base 只在开头打一次', () => {
  const r = run(DEAD)
  const lines = r.out.split('\n').filter((l) => l.startsWith('base = '))
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes(DEAD))
})

test('源码里留着连接失败的三条出路', () => {
  const src = readFileSync(SMOKE, 'utf8')
  assert.ok(src.includes('connectHint'))
  assert.ok(src.includes('isConnectError'))
  assert.ok(src.includes('NEBULA_BASE'))
})
