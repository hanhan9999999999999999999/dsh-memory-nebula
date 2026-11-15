import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIN_NODE,
  PACKAGE_ROOT,
  parseVersion,
  versionAtLeast,
  checkRuntime,
  checkPackage,
  checkProfile,
  checkEndpoint,
  checkVersionDrift,
  formatDoctor,
} from '../lib/host/doctor.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'nebula-doctor-'))
}

test('doctor: 版本解析与下界比较', () => {
  assert.deepEqual(parseVersion('v22.13.0'), [22, 13, 0])
  assert.deepEqual(parseVersion('24.17.0-rc.1'), [24, 17, 0])
  assert.equal(parseVersion('nope'), null)
  // 下界不再写死在 doctor 里，必须跟着 package.json 的 engines 走
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.match(String(pkg.engines.node), /\d+\.\d+\.\d+/, 'engines.node 要写成 >=x.y.z')
  assert.equal(MIN_NODE, pkg.engines.node.match(/(\d+\.\d+\.\d+)/)[1], 'MIN_NODE 必须等于 engines 里的那个版本')
  const [maj, min, pat] = MIN_NODE.split('.').map(Number)
  assert.equal(versionAtLeast(MIN_NODE, MIN_NODE), true, '下界自己当然达标')
  assert.equal(versionAtLeast(`${maj}.${min}.${pat + 1}`, MIN_NODE), true)
  assert.equal(versionAtLeast(`${maj}.${min}.${pat - 1}`, MIN_NODE), false, '比下界低一个补丁就不达标')
  assert.equal(versionAtLeast(`${maj}.${min - 1}.9`, MIN_NODE), false, '低一个小版本也不达标')
})

test('doctor: Node 下界与无效版本', () => {
  assert.equal(checkRuntime(MIN_NODE).status, 'ok', '下界那一版必须判 ok')
  assert.equal(checkRuntime('22.13.0').status, process.versions.node.startsWith('22.') ? 'ok' : 'fail', '22.13 不再被承诺')
  assert.equal(checkRuntime('20.0.0').status, 'fail')
  assert.equal(checkRuntime('not-a-version').status, 'fail')
  const low = checkRuntime('20.0.0')
  assert.ok(JSON.stringify(low).includes(MIN_NODE), '提示里要写出真实下界 ' + MIN_NODE)
})

test('doctor: 本包关键文件齐全', () => {
  const r = checkPackage(PACKAGE_ROOT)
  assert.equal(r.ok, true)
  assert.ok(r.items.some((x) => x.name === 'files' && x.status === 'ok'))
  assert.match(r.version, /^\d+\.\d+\.\d+/)
})

test('doctor: 空目录会报缺文件', () => {
  const dir = tempDir()
  try {
    const r = checkPackage(dir)
    assert.equal(r.ok, false)
    assert.ok(r.items.some((x) => x.name === 'package.json' && x.status === 'fail'))
    assert.ok(r.items.some((x) => x.name === 'files' && x.status === 'fail'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: 合法 profile 通过依赖、bundles 与已安装检查', () => {
  const dir = tempDir()
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        private: true,
        dependencies: { 'dsh-memory-nebula': 'file:../../plugins/dsh-memory-nebula' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-memory-nebula'] } },
      }),
    )
    const mod = join(dir, 'node_modules', 'dsh-memory-nebula')
    mkdirSync(mod, { recursive: true })
    writeFileSync(join(mod, 'package.json'), JSON.stringify({ name: 'dsh-memory-nebula', version: '1.0.1' }))
    writeFileSync(join(mod, 'cordis.patch.yml'), 'plugins: []\n')
    const r = checkProfile(dir)
    assert.equal(r.ok, true)
    assert.ok(r.items.some((x) => x.name === 'bundle' && x.status === 'ok'))
    assert.ok(r.items.some((x) => x.name === 'installed' && x.status === 'ok'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: 只装了依赖但没进 bundles 会提醒', () => {
  const dir = tempDir()
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { 'dsh-memory-nebula': '1.0.1' } }),
    )
    const r = checkProfile(dir)
    assert.equal(r.ok, true) // warn 不阻断
    assert.ok(r.items.some((x) => x.name === 'bundle' && x.status === 'warn'))
    assert.ok(r.items.some((x) => x.name === 'installed' && x.status === 'warn'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: profile 完全没声明会失败', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true }))
    const r = checkProfile(dir)
    assert.equal(r.ok, false)
    assert.ok(r.items.some((x) => x.name === 'dependency' && x.status === 'fail'))
    assert.ok(r.items.some((x) => x.name === 'bundle' && x.status === 'fail'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor: 装的是新代码、跑的是旧宿主会提醒重启', () => {
  assert.equal(checkVersionDrift('1.1.4', '1.1.4'), null)
  assert.equal(checkVersionDrift('1.1.4', ''), null)
  assert.equal(checkVersionDrift('', '1.1.0'), null)
  const r = checkVersionDrift('1.1.4', '1.1.0')
  assert.equal(r.status, 'warn')
  assert.match(r.detail, /installed 1\.1\.4, running host 1\.1\.0/)
  assert.match(r.hint, /重启 DSH/)
})

test('doctor: 口令模式下 endpoint 带 Bearer，不把 token 写进 detail', async () => {
  let seen = ''
  const server = createServer((req, res) => {
    seen = req.headers.authorization || ''
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, version: '1.6.1', mode: 'standalone', stats: { nodes: 1 } }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/api/memory-nebula`
  try {
    const withToken = await checkEndpoint(base, 2000, 'secret-token-123')
    assert.equal(seen, 'Bearer secret-token-123')
    assert.equal(withToken.status, 'ok')
    assert.equal(withToken.version, '1.6.1')
    assert.doesNotMatch(withToken.detail, /secret-token-123/)

    const noToken = await checkEndpoint(base, 2000, '')
    assert.equal(seen, '')
    assert.equal(noToken.status, 'ok')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('doctor: 文本报告带状态与汇总', () => {
  const report = {
    ok: false,
    counts: { ok: 1, warn: 1, fail: 1, skip: 0 },
    checks: [
      { name: 'runtime', status: 'ok', detail: 'node 22.13.0 / win32 x64', hint: '' },
      { name: 'installed', status: 'warn', detail: 'missing', hint: 'npm install' },
      { name: 'dependency', status: 'fail', detail: 'not listed', hint: 'edit package.json' },
    ],
  }
  const zh = formatDoctor(report)
  assert.match(zh, /\[warn\] installed: missing/)
  assert.match(zh, /→ npm install/)
  assert.match(zh, /1 通过 \/ 1 提醒 \/ 1 失败/)
  const en = formatDoctor(report, { lang: 'en' })
  assert.match(en, /summary: 1 ok \/ 1 warn \/ 1 fail/)
  assert.match(en, /read-only/)
})
