/**
 * notes 适配器：按文件拆分工作区（wsField / wsMode）。
 *
 * 背景：默认整个来源算一个工作区，于是「按项目分目录」或「frontmatter 写着 project」的
 * markdown 库在星图里全部落在同一个 ws，跨工作区能力（补充包至少 2 条来自别的项目、
 * 每工作区配额）无从谈起。这里锁住两种拆分方式，同时保证默认行为不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detect, scan } from '../lib/host/adapters/notes.js'

function makeStore(t, files, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-ws-'))
  for (const [name, text] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  const [store] = detect({ id: 't', path: dir, title: 'T', ...extra })
  assert.ok(store, 'detect 应当认出一个 notes store')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { store, nodes: scan(store).nodes }
}

const md = (title, body = '正文', extra = '') => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`

test('默认：整个来源一个工作区（行为不变）', (t) => {
  const { store, nodes } = makeStore(t, {
    'a.md': md('A'),
    'sub/b.md': md('B'),
  })
  assert.equal(nodes.length, 2)
  for (const n of nodes) {
    assert.equal(n.ws, store.key)
    assert.equal(n.wsTitle, store.title)
  }
})

test('wsField：按 frontmatter 字段拆开', (t) => {
  const { nodes } = makeStore(
    t,
    {
      'a.md': md('A', '正文', 'project: alpha\n'),
      'b.md': md('B', '正文', 'project: beta\n'),
      'c.md': md('C', '正文', 'project: alpha\n'),
    },
    { wsField: 'project' },
  )
  const byTitle = Object.fromEntries(nodes.map((n) => [n.title, n]))
  assert.equal(byTitle.A.ws, byTitle.C.ws, '同一个 project 应归到同一个工作区')
  assert.notEqual(byTitle.A.ws, byTitle.B.ws)
  assert.equal(byTitle.A.wsTitle, 'alpha')
  assert.equal(byTitle.B.wsTitle, 'beta')
})

test('wsMode=dir：按第一段目录拆开', (t) => {
  const { nodes } = makeStore(
    t,
    {
      'alpha/a.md': md('A'),
      'beta/b.md': md('B'),
      'beta/deep/c.md': md('C'),
      'root.md': md('R'),
    },
    { wsMode: 'dir' },
  )
  const byTitle = Object.fromEntries(nodes.map((n) => [n.title, n]))
  assert.equal(byTitle.A.wsTitle, 'alpha')
  assert.equal(byTitle.B.wsTitle, 'beta')
  assert.equal(byTitle.B.ws, byTitle.C.ws, '嵌套目录归到第一段')
  assert.ok(byTitle.R.wsTitle !== 'alpha', '根目录文件回落到来源工作区')
})

test('未知的 wsMode 不改变默认行为', (t) => {
  const { store, nodes } = makeStore(t, { 'alpha/a.md': md('A') }, { wsMode: 'nonsense' })
  assert.equal(nodes[0].ws, store.key)
})
