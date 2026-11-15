/**
 * 适配器 notes：把一个目录当记忆来源（.md / .json / .jsonl / .txt）。
 *
 * 这一支以前一行测试都没有（覆盖率 25%，函数覆盖 0%），
 * 而它恰恰是「别人的笔记能不能接进来」的唯一通道——
 * hindsight 知识页、Obsidian 库、日记、各种导出全走这里。
 * 这里锁住四件事：
 *   1. 目录不存在 / 空目录不产出 store，也不报错；
 *   2. 四种落盘形态各读成什么（frontmatter、JSON 数组、对象、JSONL、纯文本）；
 *   3. 单条记忆的字段怎么落（层级、标题、关键词、重要性上限）；
 *   4. probe 说人话。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detect, scan, probe, meta } from '../lib/host/adapters/notes.js'

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-notes-'))
  return {
    dir,
    write(rel, text) {
      const full = join(dir, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, text, 'utf8')
      return full
    },
    done() {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {
        /* 临时目录留给系统清理 */
      }
    },
  }
}

test('notes.detect：没配 path / 目录不存在 / 空目录，一律不产出且不报错', () => {
  assert.deepEqual(detect({}), [])
  assert.deepEqual(detect({ path: join(tmpdir(), 'nebula-notes-does-not-exist-xyz') }), [])

  const box = makeDir()
  try {
    assert.deepEqual(detect({ path: box.dir }), [], '空目录没有可读文件，不该冒出一个空来源')

    box.write('a.md', '# 一')
    const stores = detect({ path: box.dir })
    assert.equal(stores.length, 1)
    const st = stores[0]
    assert.equal(st.adapter, 'notes')
    assert.equal(st.id, 'notes:' + st.key)
    assert.equal(st.fileCount, 1)
    assert.ok(st.size > 0)
    assert.ok(st.mtimeMs > 0)
    assert.equal(st.title, box.dir.split(/[\\/]/).filter(Boolean).pop(), '标题默认取目录名')
  } finally {
    box.done()
  }
})

test('notes.scan：markdown 认 frontmatter，纯文本按文件名当标题', () => {
  const box = makeDir()
  try {
    box.write(
      'with-front.md',
      ['---', 'title: 缓存的三条规则', 'tags: 缓存, 失效, 版本', 'level: lesson', 'importance: 9', '---', '', '正文第一行', '第二行'].join('\n'),
    )
    box.write('plain.txt', '这是一份没有 frontmatter 的笔记\n第二行')

    const st = detect({ path: box.dir })[0]
    const { nodes, ledgers } = scan(st)
    assert.deepEqual(ledgers, [])
    assert.equal(nodes.length, 2, '一个文件一条记忆')

    const md = nodes.find((n) => n.file.endsWith('with-front.md'))
    assert.equal(md.level, 'lesson', 'layers 从 frontmatter 读')
    assert.equal(md.title, '缓存的三条规则')
    assert.deepEqual(md.keywords, ['缓存', '失效', '版本'])
    assert.equal(md.importance, 4, '重要性封顶到 4')
    assert.match(md.content, /正文第一行/)
    assert.equal(md.adapter, 'notes')
    assert.equal(md.storeId, st.id)
    assert.ok(md.id.startsWith('notes:'))

    const txt = nodes.find((n) => n.file.endsWith('plain.txt'))
    assert.equal(txt.title, 'plain', '没有 frontmatter 时标题取文件名（去扩展名）')
    assert.equal(txt.level, 'note', '默认层级 note')
    assert.match(txt.content, /没有 frontmatter/)
    assert.ok(txt.label.length <= 43, 'label 是给图上用的短标签')
  } finally {
    box.done()
  }
})

test('notes.scan：JSON 数组、带 items 的对象、单个对象、JSONL 各读成什么样', () => {
  const box = makeDir()
  try {
    box.write('array.json', JSON.stringify([{ title: 'A', content: '甲' }, { title: 'B', content: '乙' }]))
    box.write('wrapped.json', JSON.stringify({ items: [{ title: 'C', content: '丙' }] }))
    box.write('single.json', JSON.stringify({ title: 'D', content: '丁' }))
    box.write(
      'lines.jsonl',
      ['{"title":"E","content":"戊"}', '// 注释行要跳过', '这不是 JSON', '{"title":"F","content":"己"}', ''].join('\n'),
    )

    const st = detect({ path: box.dir })[0]
    const { nodes } = scan(st)
    const titles = nodes.map((n) => n.title).sort()
    assert.deepEqual(titles, ['A', 'B', 'C', 'D', 'E', 'F'], '坏行被跳过，别的照吃')

    const wrapped = nodes.find((n) => n.title === 'C')
    assert.equal(wrapped.content, '丙')
  } finally {
    box.done()
  }
})

test('notes.scan：扩展名可以收窄，只读 md 时 txt / json 都不进图', () => {
  const box = makeDir()
  try {
    box.write('a.md', '# 一')
    box.write('b.txt', '二')
    box.write('c.json', JSON.stringify([{ title: 'C', content: '丙' }]))

    const st = detect({ path: box.dir, exts: ['.md'] })[0]
    assert.equal(st.fileCount, 1, '探测也按 exts 数')
    const { nodes } = scan(st)
    assert.equal(nodes.length, 1)
    assert.ok(nodes[0].file.endsWith('a.md'))
  } finally {
    box.done()
  }
})

test('notes.probe：说人话，不假装成功', () => {
  const bad = probe({ path: join(tmpdir(), 'nebula-notes-nope-xyz') })
  assert.equal(bad.ok, false)
  assert.match(bad.note, /目录不存在/)

  const box = makeDir()
  try {
    box.write('x.md', '内容')
    const good = probe({ path: box.dir })
    assert.equal(good.ok, true)
    assert.equal(good.stores.length, 1)
    assert.match(good.note, /1 个文件/)
  } finally {
    box.done()
  }
})

test('notes.meta：文档写清了配置项，别让人猜', () => {
  assert.equal(meta.id, 'notes')
  assert.equal(meta.kind, 'files')
  assert.ok(meta.config.path.includes('必填'))
  assert.ok(meta.description.length > 20)
})
