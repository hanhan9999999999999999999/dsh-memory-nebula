import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ingest 适配器只认 DSH_HOME 下的 memory-nebula/ingest 目录，测试把它指到临时目录。
const HOME = mkdtempSync(join(tmpdir(), 'nebula-ingest-test-'))
process.env.DSH_HOME = HOME

const mod = await import('../lib/host/adapters/ingest.js')

const reset = () => {
  rmSync(join(HOME, 'memory-nebula'), { recursive: true, force: true, maxRetries: 3, retryDelay: 60 })
}

test.after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 })
  } catch {
    /* Windows 上偶尔还占着 */
  }
})

test('meta：适配器 id / kind / 没有必填配置', () => {
  assert.equal(mod.meta.id, 'ingest')
  assert.equal(mod.meta.kind, 'file')
  assert.deepEqual(mod.meta.config, {})
  assert.equal(mod.meta.name, '外部推送')
})

test('detect：没有推送目录就是空，不抛', () => {
  reset()
  assert.deepEqual(mod.detect(), [])
})

test('detect：每个 .jsonl 一个 store，别的扩展名不算', () => {
  reset()
  const dir = mod.ingestDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'hindsight.jsonl'), '{"title":"a"}\n', 'utf8')
  writeFileSync(join(dir, 'openviking.jsonl'), '{"title":"b"}\n', 'utf8')
  writeFileSync(join(dir, 'notes.txt'), 'ignored\n', 'utf8')
  const stores = mod.detect({ any: 1 })
  assert.deepEqual(stores.map((s) => s.provider).sort(), ['hindsight', 'openviking'])
  const one = stores.find((s) => s.provider === 'hindsight')
  assert.equal(one.id, 'ingest:hindsight')
  assert.equal(one.adapter, 'ingest')
  assert.equal(one.title, 'hindsight')
  assert.equal(one.key, 'hindsight')
  assert.ok(one.size > 0)
  assert.ok(one.mtimeMs > 0)
  assert.deepEqual(one.config, { any: 1 })
})

test('scan：文件读不到时给空结果，不抛', () => {
  const out = mod.scan({ path: join(HOME, 'nope', 'missing.jsonl'), provider: 'x', key: 'x', id: 'ingest:x', title: 'x' })
  assert.deepEqual(out, { nodes: [], ledgers: [] })
})

test('scan：BOM / 注释 / 空行 / 坏行都跳过，好行照读', () => {
  reset()
  const dir = mod.ingestDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'raw.jsonl'),
    '\uFEFF# 注释\n' +
      '\n' +
      '{"title":"第一行","content":"甲"}\n' +
      '{坏行\n' +
      'null\n' +
      '"字符串不是对象"\n' +
      '{"title":"第二行","content":"乙"}\n',
    'utf8',
  )
  const store = mod.detect().find((s) => s.provider === 'raw')
  const out = mod.scan(store)
  assert.deepEqual(out.nodes.map((n) => n.title), ['第一行', '第二行'])
  assert.deepEqual(out.ledgers, [])
})

test('appendIngest：不给 uid 时按内容哈希，重复推送落回同一条', () => {
  reset()
  const items = [
    { title: '重复一', content: '同样的内容', level: 'fact', createdAt: 1794700000000 },
    { title: '重复二', content: '别的内容', level: 'note', createdAt: 1794700001000 },
  ]
  const first = mod.appendIngest('hindsight', items)
  assert.equal(first.written, 2)
  const one = mod.scan(mod.detect()[0])
  assert.equal(one.nodes.length, 2)

  const again = mod.appendIngest('hindsight', items)
  assert.equal(again.written, 2)
  const two = mod.scan(mod.detect()[0])
  assert.equal(two.nodes.length, 2, '同样的两条再推一次，不该长重影')
  assert.deepEqual(two.nodes.map((n) => n.id).sort(), one.nodes.map((n) => n.id).sort())

  // 时间戳不同、正文相同，仍然是同一条（uid 只看标题与正文）
  mod.appendIngest('hindsight', [{ title: '重复一', content: '同样的内容', createdAt: 1794799999999 }])
  assert.equal(mod.scan(mod.detect()[0]).nodes.length, 2)
})

test('appendIngest：显式 uid 后写覆盖', () => {
  reset()
  mod.appendIngest('p', [{ uid: 'stable-1', title: '旧标题', content: '旧内容' }])
  const before = mod.scan(mod.detect()[0]).nodes
  assert.equal(before.length, 1)
  assert.equal(before[0].title, '旧标题')

  mod.appendIngest('p', [{ uid: 'stable-1', title: '新标题', content: '新内容' }])
  const after = mod.scan(mod.detect()[0]).nodes
  assert.equal(after.length, 1)
  assert.equal(after[0].title, '新标题')
  assert.equal(after[0].content, '新内容')
})

test('appendIngest：items 不是数组时给 0 条并说明，不抛', () => {
  reset()
  const out = mod.appendIngest('p', { title: '不是数组' })
  assert.equal(out.written, 0)
  assert.equal(out.error, 'items 必须是数组')
  assert.equal(mod.appendIngest('p', null).written, 0)
  assert.equal(mod.appendIngest('p', []).written, 0)
})

test('appendIngest：空行不落盘，provider 名字被清洗', () => {
  reset()
  const empty = mod.appendIngest('Hindsight 记忆', [{ title: '   ', content: '\n' }])
  assert.equal(empty.written, 0)
  assert.ok(empty.file.endsWith(join('ingest', 'hindsight.jsonl')), '实际是 ' + empty.file)

  const one = mod.appendIngest('', [{ title: '没有 provider', content: 'x' }])
  assert.equal(one.written, 1)
  assert.ok(one.file.endsWith(join('ingest', 'external.jsonl')), '实际是 ' + one.file)
})

test('字段归一化：level 小写、importance 夹在 0..4、keywords 认字符串与数组', () => {
  reset()
  const dir = mod.ingestDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'norm.jsonl'),
    [
      JSON.stringify({ title: '大写层级', content: 'x', level: 'FACT', importance: 9 }),
      JSON.stringify({ title: '默认层级', content: 'y', keywords: 'a, b、c' }),
      JSON.stringify({ title: '负重要度', content: 'z', importance: -3, keywords: ['甲', ' 乙 ', ''] }),
    ].join('\n') + '\n',
    'utf8',
  )
  const nodes = mod.scan(mod.detect()[0]).nodes
  const byTitle = Object.fromEntries(nodes.map((n) => [n.title, n]))
  assert.equal(byTitle['大写层级'].level, 'fact')
  assert.equal(byTitle['大写层级'].importance, 4)
  assert.equal(byTitle['默认层级'].level, 'note')
  assert.deepEqual(byTitle['默认层级'].keywords, ['a', 'b', 'c'])
  assert.equal(byTitle['负重要度'].importance, 0)
  assert.deepEqual(byTitle['负重要度'].keywords, ['甲', '乙'])
})

test('只有标题的行也进图，标签过长会截断', () => {
  reset()
  const long = '很长的标题'.repeat(20)
  mod.appendIngest('p', [{ title: long, content: '' }, { title: '短的', content: '' }])
  const nodes = mod.scan(mod.detect()[0]).nodes
  assert.equal(nodes.length, 2)
  const longNode = nodes.find((n) => n.title === long)
  assert.ok(longNode, '只有标题的行应该进图')
  assert.equal(longNode.label.length, 43)
  assert.ok(longNode.label.endsWith('…'))
  assert.equal(longNode.content, '')
  assert.equal(longNode.provider, 'p')
  assert.equal(longNode.adapter, 'ingest')
  assert.equal(nodes.find((n) => n.title === '短的').label, '短的')
})

test('scanSteps：600 行里至少让一次路，同步壳与生成器结果相同', () => {
  reset()
  const dir = mod.ingestDir()
  mkdirSync(dir, { recursive: true })
  const rows = []
  for (let i = 0; i < 600; i += 1) rows.push(JSON.stringify({ title: '行 ' + i, content: '内容 ' + i }))
  writeFileSync(join(dir, 'many.jsonl'), rows.join('\n') + '\n', 'utf8')
  const store = mod.detect()[0]

  const it = mod.scanSteps(store)
  let steps = 0
  let step = it.next()
  while (!step.done) {
    steps += 1
    step = it.next()
  }
  assert.ok(steps >= 1, '600 行至少要 yield 一次（否则事件循环被整段占住）')
  assert.equal(step.value.nodes.length, 600)

  const sync = mod.scan(store)
  assert.deepEqual(sync.nodes.map((n) => n.id), step.value.nodes.map((n) => n.id))
})

test('probe：没有推送时说清目录，有推送时列出来', () => {
  reset()
  const empty = mod.probe()
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.stores, [])
  assert.ok(empty.note.includes(mod.ingestDir()))

  mod.appendIngest('hindsight', [{ title: 'a', content: 'x' }])
  mod.appendIngest('openviking', [{ title: 'b', content: 'y' }])
  const full = mod.probe()
  assert.deepEqual(full.stores.map((s) => s.id).sort(), ['ingest:hindsight', 'ingest:openviking'])
  assert.ok(full.note.includes('2 个推送来源'))
})

test('落盘的行自己带 uid，读回来不再重新编号', () => {
  reset()
  const out = mod.appendIngest('hindsight', [{ title: '自带 uid', content: '正文' }])
  const line = readFileSync(out.file, 'utf8').trim().split('\n').pop()
  const row = JSON.parse(line)
  assert.match(row.uid, /^[0-9a-f]{8}$/)
  const node = mod.scan(mod.detect()[0]).nodes[0]
  assert.ok(node.id.endsWith(row.uid), '节点 id 用的是文件里的 uid：' + node.id)
})
