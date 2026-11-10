import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDiagnostics, formatDiagnostics } from '../lib/host/diagnostics.js'

function fakeNebula() {
  return {
    graph: {
      stats: { nodes: 12, edges: 30, workspaces: 3, sessions: 4 },
      builtAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    },
    lastBuildMs: 456,
    lastError: '一个来源读失败：权限',
    stores: [
      {
        key: 'diary',
        title: '日记库',
        adapter: 'meow',
        provider: 'meow-memory',
        size: 1234,
        kind: 'dir',
        path: 'C:\\Users\\someone\\Documents\\memory.db',
        dbPath: 'C:\\Users\\someone\\Documents\\memory.db',
      },
    ],
  }
}

function collectKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      collectKeys(v, out)
    }
  }
  return out
}

test('diagnostics: 只报告规模/来源身份，不出现路径或正文', () => {
  const d = buildDiagnostics({
    version: '1.0.0',
    build: 42,
    startedAt: 1000,
    mode: 'host',
    nebula: fakeNebula(),
    capabilities: ['graph', 'diagnostics'],
    runtime: { node: 'v24.0.0', platform: 'win32', arch: 'x64', pid: 7, uptimeSec: 9, rssMb: 100 },
  })
  assert.equal(d.product, 'memory-nebula')
  assert.equal(d.content, 'none')
  assert.equal(d.graph.nodes, 12)
  assert.equal(d.graph.edges, 30)
  assert.equal(d.sources.length, 1)
  assert.deepEqual(Object.keys(d.sources[0]).sort(), ['adapter', 'key', 'kind', 'provider', 'size', 'title'])
  const keys = collectKeys(d)
  assert.ok(!keys.includes('path'))
  assert.ok(!keys.includes('dbPath'))
  assert.ok(!keys.includes('contentText'))
  const text = formatDiagnostics(d)
  assert.ok(!text.includes('C:\\'))
  assert.ok(!text.includes('someone'))
  assert.ok(!text.includes('memory.db'))
  assert.match(text, /version: 1\.0\.0/)
  assert.match(text, /graph: 12 memories \/ 30 links/)
  assert.match(text, /lastError: 一个来源读失败/)
})

test('diagnostics: 空图/无来源也能格式化', () => {
  const d = buildDiagnostics({ version: '1.0.0', build: 0, startedAt: 0, mode: 'host', nebula: {} })
  const text = formatDiagnostics(d)
  assert.match(text, /graph: 0 memories \/ 0 links/)
  assert.match(text, /sources: 0/)
  assert.match(text, /lastError: none/)
})

test('diagnostics: 英文说明可切换，字段名保持稳定', () => {
  const d = buildDiagnostics({ version: '1.1.7', build: 1, startedAt: 0, mode: 'host', nebula: {} })
  const zh = formatDiagnostics(d)
  const en = formatDiagnostics(d, { lang: 'en' })
  assert.match(zh, /不含记忆正文/)
  assert.match(en, /contains no memory text/)
  assert.doesNotMatch(en, /不含记忆正文/)
  assert.match(en, /version: 1\.1\.7/)
  assert.match(en, /lastError: none/)
})
