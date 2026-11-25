/**
 * notes 适配器：frontmatter 的时间与摘要字段
 *
 * 回归用例：`created_at` / `updated_at`（snake_case）曾被忽略，所有节点的时间退回文件 mtime。
 * 一次 git clone / rsync / 拷贝就会把整库压成同一时刻，时间螺旋塌成一个点，
 * 补充包的「久未访问」权重与体检的 stale 判定也一起失真。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detect, scan } from '../lib/host/adapters/notes.js'

const FILE_TIME = new Date('2020-01-01T00:00:00Z')
const CREATED = '2026-11-24T11:35:16.316Z'
const UPDATED = '2026-11-25T09:00:00.000Z'

/** 把一组文件落进临时目录，文件 mtime 统一钉在 2020，方便和 frontmatter 区分。 */
function storeOf(files, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-notes-'))
  for (const [name, text] of Object.entries(files)) {
    const p = join(dir, name)
    writeFileSync(p, text)
    utimesSync(p, FILE_TIME, FILE_TIME)
  }
  const [st] = detect({ id: 't', path: dir, title: 't', ...extra })
  assert.ok(st, 'detect 应当认出一个 notes store')
  const { nodes } = scan(st)
  return { dir, nodes }
}

/** 每个用例自己收拾临时目录。 */
function withStore(t, files, extra) {
  const { dir, nodes } = storeOf(files, extra)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return nodes
}

test('snake_case 的 created_at / updated_at 被认出来（不再退回文件 mtime）', (t) => {
  const nodes = withStore(t, {
    'a.md': `---\ntitle: "A"\ncreated_at: "${CREATED}"\nupdated_at: "${UPDATED}"\n---\n\n正文\n`,
  })
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].createdAt, Date.parse(CREATED))
  assert.equal(nodes[0].updatedAt, Date.parse(UPDATED))
  assert.notEqual(nodes[0].createdAt, FILE_TIME.getTime())
})

test('camelCase 的 createdAt / updatedAt 仍然有效（不回归）', (t) => {
  const nodes = withStore(t, {
    'b.md': `---\ntitle: "B"\ncreatedAt: "${CREATED}"\nupdatedAt: "${UPDATED}"\n---\n\n正文\n`,
  })
  assert.equal(nodes[0].createdAt, Date.parse(CREATED))
  assert.equal(nodes[0].updatedAt, Date.parse(UPDATED))
})

test('没有时间字段的旧文件仍然退回文件 mtime', (t) => {
  const nodes = withStore(t, {
    'c.md': `---\ntitle: "C"\n---\n\n正文\n`,
  })
  assert.equal(nodes[0].createdAt, FILE_TIME.getTime())
  assert.equal(nodes[0].updatedAt, FILE_TIME.getTime())
})

test('正文为空时用 description 兜底，不把 frontmatter 当正文', (t) => {
  const nodes = withStore(t, {
    'd.md': `---\ntitle: "D"\ndescription: "一句话摘要"\ncreated_at: "${CREATED}"\n---\n`,
  })
  assert.equal(nodes[0].content, '一句话摘要')
  assert.ok(!nodes[0].content.includes('---'), '正文字段里不该出现 frontmatter 分隔线')
  assert.ok(!nodes[0].content.includes('title:'), '正文字段里不该出现 frontmatter 键')
})

test('JSON 单对象：created_at 生效，原有的 ts 字段不回归', (t) => {
  const nodes = withStore(t, {
    'f.json': JSON.stringify({ title: 'F', content: '一条', created_at: CREATED, updated_at: UPDATED }),
    'g.json': JSON.stringify({ title: 'G', content: '两条', ts: '2021-05-05T00:00:00.000Z' }),
  })
  const f = nodes.find((n) => n.title === 'F')
  const g = nodes.find((n) => n.title === 'G')
  assert.equal(f.createdAt, Date.parse(CREATED))
  assert.equal(f.updatedAt, Date.parse(UPDATED))
  assert.equal(g.createdAt, Date.parse('2021-05-05T00:00:00.000Z'), 'ts 是 JSON 源原本就支持的字段')
})

test('JSONL 每行的 created_at / updated_at 同样生效', (t) => {
  const nodes = withStore(t, {
    'e.jsonl': JSON.stringify({
      title: 'E',
      content: '一行记忆',
      created_at: CREATED,
      updated_at: UPDATED,
    }) + '\n',
  })
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].createdAt, Date.parse(CREATED))
  assert.equal(nodes[0].updatedAt, Date.parse(UPDATED))
})
