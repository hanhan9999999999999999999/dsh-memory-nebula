import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../lib/standalone.mjs', import.meta.url))

test('standalone --demo --share 写出可打开的单文件快照', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-share-'))
  const out = join(dir, 'snapshot.html')
  try {
    const r = spawnSync(process.execPath, [cli, '--demo', '--share', out], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /64 节点 \/ 78 连接/)
    const html = readFileSync(out, 'utf8')
    assert.match(html, /window\.__NEBULA_SNAPSHOT__/)
    assert.match(html, /记忆星图 · 离线快照/)
    assert.ok(!/<script[^>]+src=/.test(html), '快照不应依赖外部脚本')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('standalone --share 拒绝非法 scope 并以 2 退出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-share-bad-'))
  const out = join(dir, 'snapshot.html')
  try {
    const r = spawnSync(process.execPath, [cli, '--demo', '--share', out, '--scope', 'bogus'], { encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /scope 要写成/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('standalone --export 按工作区导出结构化 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-export-'))
  const out = join(dir, 'scope.json')
  try {
    const r = spawnSync(process.execPath, [cli, '--demo', '--export', out, '--scope', 'ws:星港产品'], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const report = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(report.scope.kind, 'ws')
    assert.equal(report.scope.value, '星港产品')
    assert.equal(report.stats.nodes, 32)
    assert.equal(report.stats.edges, 31)
    assert.equal(report.stats.workspaces, 1)
    assert.ok(report.nodes.length <= 200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('standalone --export 拒绝空范围并以 2 退出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-export-bad-'))
  const out = join(dir, 'scope.json')
  try {
    const r = spawnSync(process.execPath, [cli, '--demo', '--export', out, '--scope', 'ws:不存在'], { encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /这个范围里没有记忆/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
