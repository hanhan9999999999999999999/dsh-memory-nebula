/**
 * 适配器公用工具的单测：这一层被所有来源共用，坏了是全平台一起坏。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  charLen,
  dirExists,
  expandHome,
  firstLine,
  hashShort,
  parseFrontmatter,
  pick,
  readJsonSafe,
  readTextSafe,
  slugKey,
  stem,
  toKeywordList,
  toMs,
  walkFiles,
} from '../lib/host/adapters/util.js'

const root = mkdtempSync(join(tmpdir(), 'nebula-util-'))
test.after(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* Windows 上偶尔 EBUSY，让它自己回收 */
  }
})

test('walkFiles：只收指定扩展名，并按目录递归', () => {
  const dir = join(root, 'basic')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'a.md'), 'a')
  writeFileSync(join(dir, 'b.txt'), 'b')
  writeFileSync(join(dir, 'sub', 'c.md'), 'c')
  const files = walkFiles(dir, { exts: ['.md'] })
  assert.deepEqual(files.map((f) => f.rel).sort(), ['a.md', 'sub/c.md'])
  assert.ok(files.every((f) => Number.isFinite(f.size) && f.size > 0))
})

test('walkFiles：跳过 node_modules 与隐藏目录', () => {
  const dir = join(root, 'skip')
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(dir, '.hidden'), { recursive: true })
  mkdirSync(join(dir, 'keep'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'x', 'bad.md'), 'bad')
  writeFileSync(join(dir, '.hidden', 'bad.md'), 'bad')
  writeFileSync(join(dir, 'keep', 'good.md'), 'good')
  const files = walkFiles(dir, { exts: ['.md'] })
  assert.deepEqual(files.map((f) => f.rel), ['keep/good.md'])
})

test('walkFiles：爬到 maxFiles 就停，并且把截断说出来', () => {
  const dir = join(root, 'cap')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 8; i++) writeFileSync(join(dir, 'n' + i + '.md'), 'x'.repeat(i + 1))
  const stats = {}
  const files = walkFiles(dir, { exts: ['.md'], maxFiles: 3, stats })
  assert.equal(files.length, 3)
  assert.equal(stats.scanned, 3)
  assert.equal(stats.truncated, true)

  const exact = {}
  walkFiles(dir, { exts: ['.md'], maxFiles: 8, stats: exact })
  assert.equal(exact.truncated, true, '正好等于上限时也算爬到顶了（可能还有没读到的）')

  const roomy = {}
  walkFiles(dir, { exts: ['.md'], maxFiles: 20, stats: roomy })
  assert.equal(roomy.truncated, false)
})

test('walkFiles：深度上限之外的文件不收', () => {
  const dir = join(root, 'deep')
  mkdirSync(join(dir, 'a', 'b', 'c', 'd'), { recursive: true })
  writeFileSync(join(dir, 'a', 'b', 'c', 'd', 'too-deep.md'), 'x')
  writeFileSync(join(dir, 'a', 'ok.md'), 'x')
  const files = walkFiles(dir, { exts: ['.md'], maxDepth: 2 })
  assert.deepEqual(files.map((f) => f.rel), ['a/ok.md'])
})

test('walkFiles：目录不存在时返回空数组，不抛', () => {
  assert.deepEqual(walkFiles(join(root, 'nope-nope'), { exts: ['.md'] }), [])
})

test('toMs：秒、毫秒、数字字符串、ISO 字符串都认，坏值给 0', () => {
  assert.equal(toMs(1794700000), 1794700000000)
  assert.equal(toMs(1794700000000), 1794700000000)
  assert.equal(toMs('1794700000'), 1794700000000)
  assert.equal(toMs('1794700000000'), 1794700000000)
  assert.equal(toMs('2026-11-15T02:00:00Z'), Date.parse('2026-11-15T02:00:00Z'))
  assert.equal(toMs(null), 0)
  assert.equal(toMs(''), 0)
  assert.equal(toMs(0), 0)
  assert.equal(toMs(-5), 0)
  assert.equal(toMs('不是时间'), 0)
})

test('parseFrontmatter：只认头部，数组两种写法都收', () => {
  const text = ['---', 'title: 一条笔记', 'tags: [a, b, "c"]', 'level: fact', 'refs:', '  - x', '  - y', '---', '正文第一行'].join('\n')
  const { data, body } = parseFrontmatter(text)
  assert.equal(data.title, '一条笔记')
  assert.deepEqual(data.tags, ['a', 'b', 'c'])
  assert.equal(data.level, 'fact')
  assert.deepEqual(data.refs, ['x', 'y'])
  assert.equal(body.trim(), '正文第一行')

  const plain = parseFrontmatter('没有头部的正文')
  assert.deepEqual(plain.data, {})
  assert.equal(plain.body, '没有头部的正文')
})

test('parseFrontmatter：BOM 与 CRLF 也不影响', () => {
  const text = '\uFEFF---\r\ntitle: 带 BOM\r\n---\r\n正文\r\n'
  const { data, body } = parseFrontmatter(text)
  assert.equal(data.title, '带 BOM')
  assert.equal(body.trim(), '正文')
})

test('firstLine / slugKey / stem / charLen / hashShort 的边界', () => {
  assert.equal(firstLine('# 标题\n第二行'), '标题')
  assert.equal(firstLine('\n\n  \n'), '')
  assert.equal(firstLine('x'.repeat(60)).length, 47) // 46 + 省略号
  assert.equal(slugKey('我的 工作区/名字'), '我的工作区名字')
  assert.equal(slugKey('   '), 'ws')
  assert.equal(slugKey('a'.repeat(40)).length, 24)
  assert.equal(stem('导出/报告.final.md'), '报告.final')
  assert.equal(charLen('记忆'), 2)
  assert.equal(hashShort('同一个').length, 8)
  assert.equal(hashShort('同一个'), hashShort('同一个'))
  assert.notEqual(hashShort('甲'), hashShort('乙'))
})

test('toKeywordList / pick：脏数据不抛', () => {
  assert.deepEqual(toKeywordList('a, b；c、d e'), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(toKeywordList([' a ', '', 'b']), ['a', 'b'])
  assert.deepEqual(toKeywordList(42), [])
  assert.deepEqual(toKeywordList(null), [])
  const row = { c_title: '标题', c_null: null }
  assert.equal(pick(row, { title: 'c_title' }, 'title'), '标题')
  assert.equal(pick(row, { title: 'c_null' }, 'title', '兜底'), '兜底')
  assert.equal(pick(row, { title: '没有这列' }, 'title'), '')
})

test('readJsonSafe / readTextSafe：BOM、坏 JSON、空文件、限制长度', () => {
  const dir = join(root, 'files')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ok.json'), '\uFEFF{"a":1}', 'utf8')
  writeFileSync(join(dir, 'bad.json'), '{不是 JSON', 'utf8')
  writeFileSync(join(dir, 'empty.json'), '   \n', 'utf8')
  assert.deepEqual(readJsonSafe(join(dir, 'ok.json')), { a: 1 })
  assert.equal(readJsonSafe(join(dir, 'bad.json'), '兜底'), '兜底')
  assert.equal(readJsonSafe(join(dir, 'empty.json'), null), null)
  assert.equal(readJsonSafe(join(dir, 'nope.json'), '没有'), '没有')

  writeFileSync(join(dir, 'text.md'), '\uFEFF前面十个字够了吧', 'utf8')
  assert.equal(readTextSafe(join(dir, 'text.md'), 4), '前面十个')
  assert.equal(readTextSafe(join(dir, 'nope.md')), '')
})

test('expandHome / dirExists：~ 展开与存在的判断', () => {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  assert.equal(expandHome('~'), home || '~')
  assert.equal(expandHome('~/x'), home ? home + '/x' : '~/x')
  assert.equal(expandHome(''), '')
  assert.equal(expandHome('D:/绝对/路径'), 'D:/绝对/路径')
  assert.equal(dirExists(root), true)
  assert.equal(dirExists(join(root, 'nope')), false)
  assert.equal(dirExists(''), false)
})

test('walkFiles：mtime 跟着文件变（签名靠它）', () => {
  const dir = join(root, 'mtime')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'a.md')
  writeFileSync(file, 'a')
  const before = walkFiles(dir, { exts: ['.md'] })[0].mtimeMs
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)
  const after = walkFiles(dir, { exts: ['.md'] })[0].mtimeMs
  assert.ok(after > before)
})
