import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
  assert.equal(versionAtLeast('22.13.0', MIN_NODE), true)
  assert.equal(versionAtLeast('22.12.9', MIN_NODE), false)
  assert.equal(versionAtLeast('23.0.0', MIN_NODE), true)
  assert.equal(versionAtLeast('21.99.99', MIN_NODE), false)
})

test('doctor: Node 下界与无效版本', () => {
  assert.equal(checkRuntime('22.13.0').status, 'ok')
  assert.equal(checkRuntime('22.12.0').status, 'fail')
  assert.equal(checkRuntime('20.0.0').status, 'fail')
  assert.equal(checkRuntime('not-a-version').status, 'fail')
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
