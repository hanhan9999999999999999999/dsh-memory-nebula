/**
 * mnemon 适配器：认 dsh-mnemon 自己的档案契约。
 *
 * 这里造的是一个最小档案目录（两个 md），验证：
 *   1. detect 能数出文件、给出 store；
 *   2. frontmatter 的 created_at / updated_at 生效（不退回文件 mtime）；
 *   3. 正文为空时用 description 兜底，且正文不含 frontmatter；
 *   4. uid 取自 frontmatter.id —— 文档改写后节点 id 不变；
 *   5. source_paths 派生成关键词（让同批档案连成一片）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as mnemon from '../lib/host/adapters/mnemon.js'
import { hashShort } from '../lib/host/adapters/util.js'

function makeArchive() {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-mnemon-'))
  const active = join(dir, 'active')
  mkdirSync(active, { recursive: true })
  writeFileSync(
    join(active, 'one-pager-doc_alpha.md'),
    [
      '---',
      'id: doc_alpha',
      'title: 记忆插件对比',
      'description: 对比 mnemon 与 nebula',
      'status: active',
      'created_at: 2026-10-26T13:14:27.061Z',
      'updated_at: 2026-11-25T08:43:10.467Z',
      'content_hash: sha256:aaaa',
      'source_paths: ["docs/a.md", "src/b.ts"]',
      '---',
      '正文第一段。',
      '',
      '## 小节',
      '正文第二段。',
    ].join('\n'),
  )
  writeFileSync(
    join(active, 'empty-doc_beta.md'),
    [
      '---',
      'id: doc_beta',
      'title: 只有摘要的档案',
      'description: 正文是空的，摘要在这里',
      'created_at: 2026-11-01T00:00:00.000Z',
      'updated_at: 2026-11-02T00:00:00.000Z',
      '---',
      '',
    ].join('\n'),
  )
  return { dir, active }
}

test('mnemon: detect 数出文件并给出可扫描的 store', () => {
  const { dir, active } = makeArchive()
  try {
    const stores = mnemon.detect({ path: active, title: '测试档案' })
    assert.equal(stores.length, 1)
    assert.equal(stores[0].adapter, 'mnemon')
    assert.equal(stores[0].fileCount, 2)
    assert.ok(stores[0].id.startsWith('mnemon:'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mnemon: created_at / updated_at 生效，正文不含 frontmatter，空正文用 description', () => {
  const { dir, active } = makeArchive()
  try {
    const [store] = mnemon.detect({ path: active })
    const { nodes } = mnemon.scan(store)
    assert.equal(nodes.length, 2)
    const alpha = nodes.find((n) => n.docId === 'doc_alpha')
    const beta = nodes.find((n) => n.docId === 'doc_beta')
    assert.ok(alpha && beta)

    assert.equal(alpha.title, '记忆插件对比')
    assert.equal(alpha.createdAt, Date.parse('2026-10-26T13:14:27.061Z'))
    assert.equal(alpha.updatedAt, Date.parse('2026-11-25T08:43:10.467Z'))
    assert.equal(alpha.level, 'project')
    assert.ok(alpha.content.includes('正文第一段'))
    assert.ok(!alpha.content.includes('---'), '正文里不该带 frontmatter 分隔线')
    assert.ok(!alpha.content.includes('content_hash'))

    assert.equal(beta.content, '正文是空的，摘要在这里')
    assert.equal(beta.createdAt, Date.parse('2026-11-01T00:00:00.000Z'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mnemon: uid 取自 frontmatter.id，改写标题后节点 id 不变', () => {
  const { dir, active } = makeArchive()
  try {
    const [store] = mnemon.detect({ path: active })
    const before = mnemon.scan(store).nodes.find((n) => n.docId === 'doc_alpha')
    assert.equal(before.uid, hashShort('doc_alpha'))

    writeFileSync(
      join(active, 'one-pager-doc_alpha.md'),
      ['---', 'id: doc_alpha', 'title: 换了个标题', 'created_at: 2026-10-26T13:14:27.061Z', '---', '正文'].join('\n'),
    )
    const after = mnemon.scan(store).nodes.find((n) => n.docId === 'doc_alpha')
    assert.equal(after.title, '换了个标题')
    assert.equal(after.uid, before.uid, '文档改写不该让节点变成新的一条')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mnemon: source_paths 派生成关键词；probe 能报出读了什么', () => {
  const { dir, active } = makeArchive()
  try {
    const [store] = mnemon.detect({ path: active })
    const alpha = mnemon.scan(store).nodes.find((n) => n.docId === 'doc_alpha')
    assert.deepEqual(alpha.keywords.sort(), ['a', 'b'])
    const report = mnemon.probe({ path: active })
    assert.equal(report.exists, true)
    assert.equal(report.nodes, 2)
    assert.equal(report.sample.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mnemon: 不配 path 时读 $DSH_HOME/.mnemon/documents/active', () => {
  const home = mkdtempSync(join(tmpdir(), 'nebula-mnemon-home-'))
  const active = join(home, '.mnemon', 'documents', 'active')
  mkdirSync(active, { recursive: true })
  writeFileSync(
    join(active, 'x-doc_x.md'),
    ['---', 'id: doc_x', 'title: 默认路径档案', 'created_at: 2026-11-03T00:00:00.000Z', '---', '正文'].join('\n'),
  )
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const stores = mnemon.detect({})
    assert.equal(stores.length, 1, '默认路径要能命中，否则自动探测永远是空')
    assert.equal(stores[0].fileCount, 1)
    const node = mnemon.scan(stores[0]).nodes[0]
    assert.equal(node.title, '默认路径档案')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('mnemon: 目录不存在时安静返回空（不影响别人的图）', () => {
  const missing = join(tmpdir(), 'nebula-mnemon-does-not-exist-' + Date.now())
  assert.deepEqual(mnemon.detect({ path: missing }), [])
  assert.equal(mnemon.probe({ path: missing }).exists, false)
})
