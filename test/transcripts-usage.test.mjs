// 工具调用画像：从转写里统计「哪个技能 / 哪个 MCP / 哪个插件真被用过」。
// 单独一个文件是有意的：usageIndex 的缓存挂在模块上，一个进程里第一次算出来的结果会被用 5 分钟。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

const HOME = mkdtempSync(join(tmpdir(), 'nebula-usage-'))
process.env.DSH_HOME = HOME
process.env.NEBULA_TRANSCRIPT_INDEX_TTL = '0'

const t = await import('../lib/host/transcripts.js')

test.after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
})

const T0 = 1763164800000
const line = (obj) => JSON.stringify(obj) + '\n'
const call = (name, ms, args) => line({ type: 'tool/call', time: T0 + ms, data: { name, arguments: args } })

const writeSession = (ws, id, text) => {
  const dir = join(HOME, 'sessions', ws, 'session-' + id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(text, 'utf8')))
  return file
}

writeSession(
  'ws--one--',
  's1',
  [
    // arguments 是字符串（真实转写里就是这样）
    call('skill', 1000, JSON.stringify({ name: 'Office' })),
    call('mcp__drawio__create_new_diagram', 2000, '{}'),
    call('memory_search', 3000, '{"q":"x"}'),
    call('weknora_search', 4000, '{}'),
    // 不归因的工具：只算进总数
    call('ops_bash', 5000, '{}'),
    // 坏 arguments 不许炸，也不许瞎归因
    call('skill', 6000, '这不是 JSON'),
  ].join('')
)
writeSession(
  'ws--two--',
  's2',
  [
    // arguments 是对象（有些客户端直接给对象）
    call('skill', 7000, { name: 'office' }),
    call('mcp__drawio__edit_diagram', 8000, '{}'),
    call('nebula_recall', 9000, '{}'),
  ].join('')
)

test('技能 / MCP / 插件分得清，不归因的工具只算总数', () => {
  const data = t.usageIndex()
  assert.equal(data.toolCalls, 9, '九次 tool/call')
  assert.equal(data.scanned, 2, '两个会话')
  const office = t.usageOf('skill', 'Office')
  assert.equal(office.calls, 2, '大小写不同也算同一个技能')
  assert.equal(office.sessions, 2)
  assert.equal(office.via, 'skill')
  const drawio = t.usageOf('mcp', 'drawio')
  assert.equal(drawio.calls, 2)
  assert.equal(drawio.via, 'mcp')
  assert.equal(t.usageOf('plugin', 'meow-memory').calls, 1)
  assert.equal(t.usageOf('plugin', 'weknora').calls, 1)
  assert.equal(t.usageOf('plugin', 'dsh-memory-nebula').calls, 1)
  // 没被归因的工具（ops_bash）与坏 arguments 的 skill 都不该出现
  assert.equal(t.usageOf('plugin', 'ops_bash').calls, 0)
})

test('没给 kind 时按 mcp → plugin → skill 依次找', () => {
  const found = t.usageOf(undefined, 'drawio')
  assert.equal(found.calls, 2)
  assert.equal(found.via, 'mcp')
})

test('查一个没被用过的东西：给 0，不是 null 也不是抛', () => {
  assert.deepEqual(t.usageOf('mcp', '没见过'), { calls: 0, sessions: 0, last: 0 })
  assert.equal(t.usageOf('mcp', ''), null)
  assert.equal(t.usageOf('mcp', undefined), null)
})

test('索引签名没变时复用同一份结果（别每次打开详情都全量扫）', () => {
  const a = t.usageIndex()
  const b = t.usageIndex()
  assert.equal(a, b, '同一份对象')
  assert.equal(a.bySource.get('mcp:drawio').last, T0 + 8000, 'last 取最晚那次')
})
