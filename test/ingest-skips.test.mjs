// 1.11.68：推送里丢掉的条目要说清楚，一条也没写成要报错。
// 以前三条坏数据换来一句「已推入 0 条」，written 还把批内重复的 uid 算了两遍。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendIngest, describeSkips } from '../lib/host/adapters/ingest.js'
import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'nebula-ingest-skip-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
      try { rmSync(home, { recursive: true, force: true, maxRetries: 8 }) } catch { /* 忽略 */ }
    })
}

test('坏条目：不是对象、什么都没有、只有空白 —— 各自计数，一行也不写', () => withHome(() => {
  const out = appendIngest('bad', ['字符串', 42, null, { uid: 'a' }, { uid: 'b', content: '   ' }])
  assert.equal(out.written, 0)
  assert.equal(out.skipped, 5)
  assert.deepEqual(out.reasons, { notObject: 3, empty: 2 })
  assert.equal(existsSync(out.file), false, '一条都没写成时不该留下空文件')
  const why = describeSkips(out.reasons)
  assert.match(why, /3 条不是对象/)
  assert.match(why, /2 条既没有 title 也没有 content/)
}))

test('批内重复 uid：后写覆盖，written 按去重后的条数算', () => withHome(() => {
  const out = appendIngest('dup', [
    { uid: 'x', title: '旧标题', content: '旧正文' },
    { uid: 'x', title: '新标题', content: '新正文' },
    { uid: 'y', title: '另一条', content: '另一段正文' },
  ])
  assert.equal(out.written, 2, '两条同 uid 只算一条')
  assert.equal(out.duplicates, 1)
  const lines = readFileSync(out.file, 'utf8').trim().split('\n').map((s) => JSON.parse(s))
  assert.equal(lines.length, 2)
  const x = lines.find((l) => l.uid === 'x')
  assert.equal(x.title, '新标题', '同一批里后写的要覆盖前写的')
}))

test('好条目与坏条目混着来：写出好的，同时报出跳过与重复', () => withHome(() => {
  const out = appendIngest('mixed', [
    { uid: 'ok1', title: '好的一条', content: '正文一' },
    { uid: 'ok1', title: '好的第二条覆盖', content: '正文二' },
    null,
    { uid: 'blank', content: '' },
  ])
  assert.equal(out.written, 1)
  assert.equal(out.duplicates, 1)
  assert.equal(out.skipped, 2)
}))

test('Nebula.ingest：全是坏条目时返回可读的 error，不是 ok', () => withHome(async (home) => {
  const nb = new Nebula({ roots: [join(home, 'notes')] })
  const out = await nb.ingest('probe', [{ uid: 'x' }, 'nope'])
  assert.match(out.error, /没有可写入的内容/)
  assert.match(out.error, /1 条不是对象/)
  assert.match(out.error, /1 条既没有 title 也没有 content/)
  assert.equal(out.written, 0)
  await nb.flushCache?.(1000)
  closeStore()
}))
