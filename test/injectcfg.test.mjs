// $DSH_HOME/memory-nebula/inject.json 的取值规矩：抄错的键要说一声，不许静默回落。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INJECT_DEFAULTS,
  INJECT_LIMITS,
  normalizeInjectConfig,
  readInjectConfig,
} from '../lib/host/injectcfg.js'

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-inject-'))
  mkdirSync(join(dir, 'memory-nebula'), { recursive: true })
  return dir
}
const putFile = (dir, text) => writeFileSync(join(dir, 'memory-nebula', 'inject.json'), text, 'utf8')

test('没有 inject.json：整份用默认值，而且不抱怨', () => {
  const dir = home()
  try {
    const { value, notes } = readInjectConfig(dir)
    assert.deepEqual(value, INJECT_DEFAULTS)
    assert.deepEqual(notes, [], '没写配置文件不该产生提示')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写对的键照用，没写的键保持默认', () => {
  const dir = home()
  try {
    putFile(dir, JSON.stringify({ maxItems: 6, hops: 2 }))
    const { value, notes } = readInjectConfig(dir)
    assert.equal(value.maxItems, 6)
    assert.equal(value.hops, 2)
    assert.equal(value.maxRounds, INJECT_DEFAULTS.maxRounds)
    assert.deepEqual(notes, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('类型写错：那一项回默认，并且说明是哪一项', () => {
  const { value, notes } = normalizeInjectConfig({ maxRounds: 'two', maxChars: null, hops: '' })
  assert.equal(value.maxRounds, INJECT_DEFAULTS.maxRounds, 'NaN 不该被当成「永不注入」')
  assert.equal(value.maxChars, INJECT_DEFAULTS.maxChars)
  assert.equal(value.hops, INJECT_DEFAULTS.hops)
  assert.equal(notes.length, 3, notes.join(' / '))
  assert.ok(notes.some((n) => n.startsWith('maxRounds')), notes.join(' / '))
})

test('超出范围：夹到边界，并且说明按多少算', () => {
  const { value, notes } = normalizeInjectConfig({ hops: 99, maxChars: 10, minWeight: 3 })
  assert.equal(value.hops, INJECT_LIMITS.hops.max)
  assert.equal(value.maxChars, INJECT_LIMITS.maxChars.min)
  assert.equal(value.minWeight, 1)
  assert.equal(notes.length, 3, notes.join(' / '))
  assert.ok(notes.some((n) => n.startsWith('hops') && n.includes('按 ' + INJECT_LIMITS.hops.max + ' 算')), notes.join(' / '))
})

test('整数键四舍五入，比例键保留小数', () => {
  const { value } = normalizeInjectConfig({ maxItems: 4.6, minWeight: 0.35 })
  assert.equal(value.maxItems, 5)
  assert.equal(value.minWeight, 0.35)
})

test('认不出来的键：忽略，但要说一声', () => {
  const { value, notes } = normalizeInjectConfig({ maxItems: 3, maxIitems: 9 })
  assert.equal(value.maxItems, 3)
  assert.ok(!('maxIitems' in value), '拼错的键不该进结果')
  assert.equal(notes.length, 1)
  assert.match(notes[0], /maxIitems/)
})

test('顶层不是对象：整份忽略，并说明原因', () => {
  for (const raw of [[1, 2], 'nope', 42]) {
    const { value, notes } = normalizeInjectConfig(raw)
    assert.deepEqual(value, INJECT_DEFAULTS)
    assert.equal(notes.length, 1, JSON.stringify(raw))
    assert.match(notes[0], /顶层应该是对象/)
  }
  const empty = normalizeInjectConfig(undefined)
  assert.deepEqual(empty.notes, [], 'undefined 是「没配」，不该报错')
})

test('配置文件坏了（JSON 语法错）：用默认值，并且把原因带出来', () => {
  const dir = home()
  try {
    putFile(dir, '{ "maxItems": 4, }')
    const { value, notes } = readInjectConfig(dir)
    assert.deepEqual(value, INJECT_DEFAULTS)
    assert.equal(notes.length, 1)
    assert.match(notes[0], /inject\.json 读不动/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件带 BOM 也能读', () => {
  const dir = home()
  try {
    putFile(dir, '\uFEFF' + JSON.stringify({ maxItems: 2 }))
    const { value, notes } = readInjectConfig(dir)
    assert.equal(value.maxItems, 2)
    assert.deepEqual(notes, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('规整结果是一份新对象，不会改到默认值', () => {
  const first = normalizeInjectConfig({ maxItems: 7 }).value
  first.maxItems = 99
  first.hops = 3
  assert.equal(INJECT_DEFAULTS.maxItems, 4, '默认值被写坏了')
  assert.equal(INJECT_DEFAULTS.hops, 1)
})
