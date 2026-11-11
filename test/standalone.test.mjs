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
