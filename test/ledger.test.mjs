/**
 * 会话账本（ledger）的单测。
 *
 * 它管的是「这条记忆这一轮是不是已经讲过了」——桥接、注入、冷却全靠它，
 * 之前覆盖 52%（函数 41%），`markSeen` / `markCooldown` / `seenSet` 这几条
 * 真正会改写磁盘的路径一条都没测。
 *
 * 整个文件把 DSH_HOME 指到临时目录，绝不碰主人真正的 injected/ 目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'nebula-ledger-'))
process.env.DSH_HOME = HOME

const { GLOBAL_COOLDOWN_MS, injectedDir, ledgerFile, readLedger, markSeen, seenSet, readCooldown, markCooldown, ledgerStats } =
  await import('../lib/host/ledger.js')

test.after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {}
})

test('账本目录就在 DSH_HOME/memory-nebula/injected 下', () => {
  assert.equal(injectedDir(), join(HOME, 'memory-nebula', 'injected'))
  assert.equal(ledgerFile('s1'), join(injectedDir(), 's1.json'))
})

test('会话 id 里的怪字符会被换成 %，不会跑出目录', () => {
  const file = ledgerFile('../a b/c')
  assert.equal(file.slice(0, injectedDir().length), injectedDir())
  assert.ok(!file.includes('/../'), '不能带出上一级')
})

test('没写过的会话读出来是空账本，不抛', () => {
  const empty = readLedger('nobody')
  assert.deepEqual(empty.seen, {})
  assert.deepEqual(empty.external, {})
  assert.deepEqual(empty.injected, [])
  assert.equal(empty.updatedAt, 0)
})

test('markSeen 记账：seen 有时间戳、injected 只在第一次追加', () => {
  assert.deepEqual(markSeen('s1', ['a', 'b'], 'nebula:inject'), { marked: 2 })
  let cur = readLedger('s1')
  assert.ok(cur.seen.a > 0 && cur.seen.b > 0)
  assert.deepEqual(cur.injected, ['a', 'b'])
  assert.ok(cur.updatedAt > 0)

  markSeen('s1', ['b', 'c'])
  cur = readLedger('s1')
  assert.deepEqual(cur.injected, ['a', 'b', 'c'], '重复的不再追加')
})

test('markSeen 的 by=external 会额外记进 external 段', () => {
  markSeen('s2', ['x'], 'external:hindsight')
  const cur = readLedger('s2')
  assert.ok(cur.seen.x > 0)
  assert.ok(cur.external.x > 0, 'external 段要有')

  markSeen('s2', ['y'])
  assert.equal(readLedger('s2').external.y, undefined, '自己注入的不进 external')
})

test('markSeen 空数组/空串不会建文件', () => {
  assert.deepEqual(markSeen('s3', []), { marked: 0 })
  assert.deepEqual(markSeen('s3', ['', '  ']), { marked: 0 })
  assert.equal(existsSync(ledgerFile('s3')), false)
})

test('seenSet 把 meow 账本与自己的账本合起来，完整 id 同时收裸 uid', () => {
  markSeen('s4', ['mine1'])
  const set = seenSet('s4', {
    injected: ['meow:aaa'],
    searched: ['bbb'],
    accessed: [null, '  ', 'ccc'],
    written: ['meow:ddd'],
  })
  assert.ok(set.has('mine1'))
  assert.ok(set.has('meow:aaa') && set.has('aaa'), '完整 id 与裸 uid 都要有')
  assert.ok(set.has('bbb') && set.has('ccc') && set.has('ddd'))
  assert.ok(set.has('meow:ddd'), '完整 id 本身也在集合里')
  assert.equal(set.size, 7, 'mine1 + meow:aaa/aaa + bbb + ccc + meow:ddd/ddd')
})

test('seenSet 没有 meow 账本也能用', () => {
  const set = seenSet('s5', null)
  assert.ok(set instanceof Set)
})

test('冷却表：写进去能读出来，过期的自己消失', () => {
  const now = Date.now()
  markCooldown(['u1', 'u2'])
  let map = readCooldown()
  assert.ok(map.has('u1') && map.has('u2'))

  // 手动把 u2 改成 8 天前，再读就只该剩 u1
  const file = join(injectedDir(), '_global.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.u2 = now - GLOBAL_COOLDOWN_MS - 1000
  writeFileSync(file, JSON.stringify(raw), 'utf8')
  map = readCooldown()
  assert.ok(map.has('u1'))
  assert.ok(!map.has('u2'), '过期的要滤掉')
})

test('markCooldown 顺手清掉过期项，不让文件越滚越大', () => {
  const file = join(injectedDir(), '_global.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.ancient = 1
  writeFileSync(file, JSON.stringify(raw), 'utf8')
  markCooldown(['u3'])
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.ancient, undefined, '陈年项被清掉')
  assert.ok(after.u3 > 0)
})

test('损坏的账本文件当空的读，不炸', () => {
  mkdirSync(injectedDir(), { recursive: true })
  writeFileSync(ledgerFile('broken'), '{ 这不是 JSON', 'utf8')
  const cur = readLedger('broken')
  assert.deepEqual(cur.seen, {})
  assert.deepEqual(cur.injected, [])
})

test('ledgerStats 报的是会话文件数与冷却条数', () => {
  const stats = ledgerStats()
  assert.equal(stats.dir, injectedDir())
  assert.ok(stats.sessions >= 2, '至少 s1 与 s2')
  assert.equal(stats.cooldown, readCooldown().size)
})
