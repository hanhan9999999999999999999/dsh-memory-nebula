/**
 * deriveKeywords：给没有 tags 的 md 库补关键词边（默认关）。
 *
 * 这条改动只在配置打开时生效，所以测试要点是「默认一点不动」与
 * 「打开后只补空位、不覆盖原字段」。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as notes from '../lib/host/adapters/notes.js'
import { deriveKeywords } from '../lib/host/adapters/util.js'

const DOC = [
  '---',
  'title: 记忆插件对比：mnemon 与 nebula',
  '---',
  '开场白。',
  '',
  '## 检索行为',
  '正文。',
  '',
  '## 存储边界',
  '正文。',
].join('\n')

function makeDir(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-kw-'))
  writeFileSync(join(dir, 'doc.md'), DOC)
  return dir
}

test('deriveKeywords: 切标题、去停用词、封顶 6 个', () => {
  const words = deriveKeywords('## 如何 做 the thing\n## 记忆 修复', '插件 对比', 6)
  assert.ok(words.includes('记忆'))
  assert.ok(words.includes('修复'))
  assert.ok(!words.includes('如何'), '停用词不该进来')
  assert.ok(!words.includes('the'))
  assert.ok(words.length <= 6)
})

test('notes: 默认不派生关键词（行为不变）', () => {
  const dir = makeDir()
  try {
    const [store] = notes.detect({ path: dir })
    const [node] = notes.scan(store).nodes
    assert.deepEqual(node.keywords, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('notes: deriveKeywords=true 时从标题/H2 补词，且不覆盖原 tags', () => {
  const dir = makeDir()
  try {
    const [store] = notes.detect({ path: dir, deriveKeywords: true })
    const [node] = notes.scan(store).nodes
    assert.ok(node.keywords.length > 0, '应该派生出关键词')
    assert.ok(node.keywords.includes('检索行为') || node.keywords.includes('存储边界'))

    // 原字段优先：有 tags 时仍保留 tags，派生词只做追加
    writeFileSync(join(dir, 'tagged.md'), ['---', 'title: 带标签', 'tags: [alpha, beta]', '---', '## 小节一', '正文'].join('\n'))
    const [store2] = notes.detect({ path: dir, deriveKeywords: true })
    const tagged = notes.scan(store2).nodes.find((n) => n.title === '带标签')
    assert.ok(tagged.keywords.includes('alpha'))
    assert.ok(tagged.keywords.includes('beta'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
