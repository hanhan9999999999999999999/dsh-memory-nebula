// 会话转写：多帧 zstd 切分、主人说过的话、索引过期重扫、记忆出处。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

const HOME = mkdtempSync(join(tmpdir(), 'nebula-transcripts-'))
process.env.DSH_HOME = HOME
process.env.NEBULA_TRANSCRIPT_INDEX_TTL = '0'

const t = await import('../lib/host/transcripts.js')

test.after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
})

const T0 = 1763164800000

const event = (obj) => JSON.stringify(obj) + '\n'
const userLine = (text, ms) =>
  event({ type: 'user/message', time: T0 + ms, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const toolLine = (name, ms, args) =>
  event({ type: 'tool/call', time: T0 + ms, data: { name, arguments: args } })

const sessionDir = (ws, id) => {
  const dir = join(HOME, 'sessions', ws, 'session-' + id)
  mkdirSync(dir, { recursive: true })
  return dir
}
const writeSession = (ws, id, text) => {
  const dir = sessionDir(ws, id)
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(text, 'utf8')))
  return file
}

// ---------- 多帧 zstd ----------

test('单帧 zstd 能解出原文，帧数也报对', () => {
  const buf = zstdCompressSync(Buffer.from('hello 星图', 'utf8'))
  const r = t.decompressTranscript(buf)
  assert.equal(r.error, undefined)
  assert.equal(r.text, 'hello 星图')
  assert.equal(r.frames, 1)
})

test('多帧拼在一起的转写要全部解出来（node 的 zstd 只解第一帧，所以自己切）', () => {
  const a = zstdCompressSync(Buffer.from('第一段\n', 'utf8'))
  const b = zstdCompressSync(Buffer.from('第二段\n', 'utf8'))
  const buf = Buffer.concat([a, b])
  const { frames, error } = t.splitZstdFrames(buf)
  assert.equal(error, undefined)
  assert.equal(frames.length, 2)
  const r = t.decompressTranscript(buf)
  assert.equal(r.text, '第一段\n第二段\n')
})

test('可跳过的帧（skip frame）要跳过，不喂给 zstd', () => {
  const real = zstdCompressSync(Buffer.from('真的内容', 'utf8'))
  const payload = Buffer.from('随便什么', 'utf8')
  const head = Buffer.alloc(8)
  head.writeUInt32LE(0x184d2a50, 0)
  head.writeUInt32LE(payload.length, 4)
  const buf = Buffer.concat([head, payload, real])
  const { frames } = t.splitZstdFrames(buf)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].skip, true)
  assert.equal(t.decompressTranscript(buf).text, '真的内容')
})

test('不是 zstd 的东西要给 error，不是抛异常', () => {
  const r = t.decompressTranscript(Buffer.from('这不是 zstd，只是普通文本'))
  assert.match(r.error, /bad magic/)
  assert.equal(r.text, undefined)
})

// ---------- 主人说过的话 ----------

test('只留主人真说过的：滤掉注入块、非 user 来源、超长文本、坏行', () => {
  const file = writeSession(
    'ws-a',
    'u1',
    [
      userLine('第一句真话', 1000),
      userLine('Current runtime context: 假的', 2000),
      userLine('x'.repeat(1600), 3000),
      event({ type: 'assistant/message', time: T0 + 4000, data: { content: [{ type: 'text', text: '助手说的' }] } }),
      event({ type: 'user/message', time: T0 + 5000, data: { source: { kind: 'system' }, content: [{ type: 'text', text: '系统说的' }] } }),
      '坏行不是 JSON\n',
      userLine('第二句真话', 6000),
    ].join('')
  )
  const msgs = t.readUserMessages(file)
  assert.deepEqual(
    msgs.map((m) => m.text),
    ['第一句真话', '第二句真话']
  )
  assert.deepEqual(
    msgs.map((m) => m.time),
    [T0 + 1000, T0 + 6000]
  )
})

test('文件不存在 / 读不动的转写都是空数组，不抛', () => {
  assert.deepEqual(t.readUserMessages(join(HOME, '没有这个文件')), [])
  const dir = sessionDir('ws-a', 'u2')
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.from('坏文件'))
  assert.deepEqual(t.readUserMessages(file), [])
})

test('同一份文件不重复读（mtime 没变就走缓存）', () => {
  const file = writeSession('ws-a', 'u3', userLine('缓存这一句', 10))
  const first = t.readUserMessages(file)
  const second = t.readUserMessages(file)
  assert.deepEqual(second, first)
})

// ---------- 索引 ----------

test('新开的会话会在下一轮扫描里出现（索引不能停在开机那一刻）', () => {
  t.resetTranscriptIndex()
  const a = t.transcriptStats()
  const fileB = writeSession('ws-b', 'u4', userLine('新会话', 20))
  const b = t.transcriptStats()
  assert.equal(b.sessions, a.sessions + 1)
  assert.ok(b.bytes > a.bytes)
  // 双键登记：裸 id 与 session-<id> 都指向同一个文件，统计时只能算一次
  const idx = t.transcriptIndex_()
  assert.equal(idx.get('u4').file, fileB)
  assert.equal(idx.get('session-u4').file, fileB)
})

test('有效期设成 30 秒时，窗口内不重扫（省）', () => {
  process.env.NEBULA_TRANSCRIPT_INDEX_TTL = '30000'
  t.resetTranscriptIndex()
  const a = t.transcriptStats()
  writeSession('ws-c', 'u5', userLine('窗口内新会话', 30))
  const b = t.transcriptStats()
  assert.equal(b.sessions, a.sessions, '窗口内不该重扫')
  process.env.NEBULA_TRANSCRIPT_INDEX_TTL = '0'
  assert.equal(t.transcriptStats().sessions, a.sessions + 1, '有效期到点之后要看得见')
})

test('sessions 目录不存在时给空索引，不抛', () => {
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = join(HOME, '根本不存在')
  t.resetTranscriptIndex()
  assert.deepEqual(t.transcriptStats(), { sessions: 0, bytes: 0 })
  process.env.DSH_HOME = saved
  t.resetTranscriptIndex()
})

// ---------- 记忆出处 ----------

test('origin 取「写下这条记忆之前最近的那句话」，超时就不算', () => {
  process.env.NEBULA_TRANSCRIPT_INDEX_TTL = '0'
  writeSession('ws-d', 'u6', [userLine('第一句', 0), userLine('第二句（更近）', 60000)].join(''))
  t.resetTranscriptIndex()
  const hit = t.originOfMemory({ sessionId: 'u6', createdAt: T0 + 61000 })
  assert.equal(hit.text, '第二句（更近）')
  assert.equal(hit.gapMs, 1000)
  assert.equal(hit.source, 'transcript')
  assert.equal(t.originOfMemory({ sessionId: 'u6', createdAt: T0 + 61000 + 46 * 60 * 1000 }), null, '超过 45 分钟不算')
  assert.equal(t.originOfMemory({ sessionId: 'u6' }), null, '没有 createdAt 就不查')
  assert.equal(t.originOfMemory({}), null)
})

test('长句只留 600 字，后面加省略号', () => {
  const long = '很长'.repeat(400)
  writeSession('ws-e', 'u7', userLine(long, 0))
  t.resetTranscriptIndex()
  const hit = t.originOfMemory({ sessionId: 'u7', createdAt: T0 + 100 })
  assert.equal(hit.text.length, 601)
  assert.ok(hit.text.endsWith('…'))
})

test('会话还不在索引里时不能把 null 记死（下一轮扫描要能找回来）', () => {
  process.env.NEBULA_TRANSCRIPT_INDEX_TTL = '0'
  t.resetTranscriptIndex()
  assert.equal(t.originOfMemory({ sessionId: 'u8', createdAt: T0 + 100 }), null)
  const dir = sessionDir('ws-f', 'u8')
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(userLine('刚刚才有的话', 50), 'utf8')))
  const hit = t.originOfMemory({ sessionId: 'u8', createdAt: T0 + 100 })
  assert.equal(hit && hit.text, '刚刚才有的话')
})

test('转写文件被追加之后（mtime 变了）读到的是新内容', () => {
  const file = writeSession('ws-g', 'u9', userLine('旧的', 0))
  assert.deepEqual(
    t.readUserMessages(file).map((m) => m.text),
    ['旧的']
  )
  writeFileSync(file, zstdCompressSync(Buffer.from(userLine('旧的', 0) + userLine('新的', 1000), 'utf8')))
  const later = new Date(Date.now() + 2000)
  utimesSync(file, later, later)
  assert.deepEqual(
    t.readUserMessages(file).map((m) => m.text),
    ['旧的', '新的']
  )
})

test('usageIndex 里用到的行也得能解析：tool/call 不是 user/message', () => {
  const file = writeSession('ws-h', 'u10', toolLine('memory_search', 100, '{"q":"x"}'))
  assert.deepEqual(t.readUserMessages(file), [])
})
