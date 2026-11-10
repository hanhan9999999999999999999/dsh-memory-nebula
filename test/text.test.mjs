import test from 'node:test'
import assert from 'node:assert/strict'
import {
  tokenize,
  normalizeKeywords,
  parseKeywords,
  extractEntities,
  clip,
  idf,
  jaccard,
  overlapSize,
  intersect,
} from '../lib/host/text.js'

test('tokenize：中文 bigram + 短词、英文小写、数字', () => {
  const t = tokenize('记忆星图 Memory Nebula v0.3.0 2026')
  assert.ok(t.has('记忆'))
  assert.ok(t.has('忆星'))
  assert.ok(t.has('星图'))
  assert.ok(t.has('«记忆星图»'))
  assert.ok(t.has('memory'))
  assert.ok(t.has('nebula'))
  assert.ok(t.has('2026'))
  assert.ok(!t.has('the'))
})

test('tokenize：空输入与停用词', () => {
  assert.equal(tokenize(null).size, 0)
  assert.equal(tokenize('').size, 0)
  const t = tokenize('的 了 是 the and')
  assert.ok(!t.has('the'))
  assert.ok(!t.has('and'))
})

test('normalizeKeywords：小写、去重、过滤弱词与超长', () => {
  const k = normalizeKeywords(['DSH', '记忆', '记忆', '  SQLite  ', 'x', 'a'.repeat(41), null])
  assert.deepEqual([...k].sort(), ['sqlite', '记忆'])
})

test('parseKeywords：JSON / 逗号 / 分号 / 数组 / 坏 JSON', () => {
  assert.deepEqual(parseKeywords('["a","b"]'), ['a', 'b'])
  assert.deepEqual(parseKeywords('a, b，c；d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(parseKeywords(['a', 1]), ['a', '1'])
  assert.deepEqual(parseKeywords('[bad json'), ['[bad json'])
  assert.deepEqual(parseKeywords(null), [])
})

test('extractEntities：路径 / URL / UUID / ref / 文件 / 邮箱 / IP / 版本', () => {
  const text = [
    'D:\\document\\Memory Universe\\lib\\index.js',
    'https://example.com/a?b=1',
    '123e4567-e89b-12d3-a456-426614174000',
    '见 m00123',
    'package.json',
    'a.b@example.com',
    '127.0.0.1:7890',
    'v0.3.0',
  ].join(' ')
  const e = extractEntities(text)
  assert.equal(e.get('url|https://example.com/a?b=1'), 'url')
  assert.equal(e.get('uuid|123e4567-e89b-12d3-a456-426614174000'), 'uuid')
  assert.equal(e.get('ref|m00123'), 'ref')
  assert.equal(e.get('file|package.json'), 'file')
  assert.equal(e.get('email|a.b@example.com'), 'email')
  assert.equal(e.get('ip|127.0.0.1:7890'), 'ip')
  assert.equal(e.get('version|v0.3.0'), 'version')
  assert.ok([...e.values()].includes('path'))
})

test('extractEntities：空输入', () => {
  assert.equal(extractEntities('').size, 0)
  assert.equal(extractEntities(undefined).size, 0)
})

test('clip：压空白、按长度截断、加省略号', () => {
  assert.equal(clip('  a\n\n b  '), 'a b')
  assert.equal(clip('abcdef', 4), 'abc…')
  assert.equal(clip('abc', 3), 'abc')
})

test('idf：越常见的词权重越低', () => {
  assert.ok(idf(1, 100) > idf(50, 100))
  assert.ok(idf(100, 100) > 0)
})

test('集合工具：jaccard / overlapSize / intersect', () => {
  const a = new Set(['x', 'y', 'z'])
  const b = new Set(['y', 'z', 'w'])
  assert.equal(jaccard(a, b), 0.5)
  assert.equal(jaccard(new Set(), b), 0)
  assert.equal(overlapSize(a, b), 2)
  assert.deepEqual(intersect(a, b).sort(), ['y', 'z'])
})
