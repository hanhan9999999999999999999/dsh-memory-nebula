import test from 'node:test'
import assert from 'node:assert/strict'
import { Nebula } from '../lib/host/nebula.js'
import { buildShareHtml, parseShareHide, parseShareScope, sliceShareGraph } from '../lib/host/share.js'

let cached = null
let cachedNebula = null
async function demoNebula() {
  if (!cachedNebula) {
    cachedNebula = new Nebula({ demo: true, log: () => {} })
    await cachedNebula.refresh()
  }
  return cachedNebula
}
async function share() {
  if (cached) return cached
  cached = await buildShareHtml(await demoNebula(), { version: '0.9.0', build: 123 })
  return cached
}

test('share: 生成的是一份自带样式与脚本的单文件', async () => {
  const { html, bytes, nodes, edges } = await share()
  assert.ok(bytes > 200000, '至少几百 KB：' + bytes)
  assert.ok(html.startsWith('<!doctype html') || html.startsWith('<!DOCTYPE html'))
  assert.ok(html.includes('<style>'), '样式内联')
  assert.ok(!/<link[^>]+stylesheet/i.test(html), '不再有外部样式表')
  assert.ok(!/<script[^>]+src=/i.test(html), '不再有外部脚本')
  assert.ok(html.includes('记忆星图 · 离线快照'))
  assert.ok(html.includes('window.__NEBULA_SNAPSHOT__'))
  assert.equal(nodes, 64)
  assert.ok(edges >= 60)
})

test('share: 内联 i18n，英文快照不依赖外部脚本', async () => {
  const { html } = await share()
  assert.match(html, /window\.NebulaI18n/)
  assert.ok(!/<script[^>]+src=["']?i18n\.js/i.test(html))
  assert.match(html, /data-lang-label/)
})

test('share: 数据里带正文，但不会提前闭合 script', async () => {
  const { html } = await share()
  const dataStart = html.indexOf('window.__NEBULA_SNAPSHOT__ = ') + 'window.__NEBULA_SNAPSHOT__ = '.length
  const dataEnd = html.indexOf(';</script>', dataStart)
  assert.ok(dataStart > 0 && dataEnd > dataStart, '找不到快照数据段')
  const data = html.slice(dataStart, dataEnd)
  assert.ok(!data.includes('</script'))
  const payload = JSON.parse(data)
  assert.ok(Array.isArray(payload.graph.nodeColumns), '节点应按列存')
  assert.ok(Array.isArray(payload.graph.edgeColumns), '边应按列存')
  const contentAt = payload.graph.nodeColumns.indexOf('content')
  assert.ok(contentAt >= 0, 'nodeColumns 应包含 content')
  const contents = payload.graph.nodes.filter((row) => row[contentAt]).length
  assert.ok(contents >= 55, '带正文的节点数 ' + contents)
})

test('share: 节点与边按列压缩后，核心字段仍能一一还原', async () => {
  const { html } = await share()
  const slice = sliceShareGraph(await demoNebula())
  const dataStart = html.indexOf('window.__NEBULA_SNAPSHOT__ = ') + 'window.__NEBULA_SNAPSHOT__ = '.length
  const payload = JSON.parse(html.slice(dataStart, html.indexOf(';</script>', dataStart)))
  const nodeCols = payload.graph.nodeColumns
  const rows = payload.graph.nodes
  const coreNodeKeys = ['id', 'ws', 'cluster', 'level', 'label', 'importance', 'status', 'project', 'provider', 'degree', 'seed']
  assert.equal(rows.length, slice.graph.nodes.length)
  for (let i = 0; i < slice.graph.nodes.length; i++) {
    for (const key of coreNodeKeys) {
      assert.deepEqual(rows[i][nodeCols.indexOf(key)] ?? undefined, slice.graph.nodes[i][key], `node ${i}.${key}`)
    }
  }
  const edgeCols = payload.graph.edgeColumns
  assert.equal(edgeCols.join(','), 's,d,w,t,curated')
  for (let i = 0; i < slice.graph.edges.length; i++) {
    const e = slice.graph.edges[i]
    for (const key of ['s', 'd', 'w', 't', 'curated']) {
      assert.deepEqual(payload.graph.edges[i][edgeCols.indexOf(key)] ?? undefined, e[key], `edge ${i}.${key}`)
    }
  }
})

test('share: 正文里的尖括号被转义成 JSON 安全形式', async () => {
  const fake = {
    publicGraph: () => ({ v: 2, nodes: [{ id: 'a', title: 'a', label: 'a' }], edges: [], clusters: [], stats: {} }),
    graph: { nodes: [{ id: 'a' }] },
    index: { rawById: new Map([['a', { id: 'a', content: '看这段 <script>alert(1)</script> 会不会断' }]]) },
    overview: () => ({ stats: {} }),
    signature: 'test-sig',
  }
  const { html } = await buildShareHtml(fake, { version: 't', build: 1 })
  assert.ok(html.includes('\\u003cscript>alert(1)\\u003c/script>'), '尖括号必须转义')
})

test('share: 内联源码里的 $& 不被替换模式吃掉（真实踩过的坑）', async () => {
  const { html } = await share()
  // app.js 原文：.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.ok(html.includes("'\\\\$&'"), '源码里的 $& 必须原样保留')
  assert.ok(!html.includes('<script src="app.js"></script>'), '不能残留被展开的替换结果')
})

test('share: <noscript> 提示与只读元信息都在', async () => {
  const { html } = await share()
  assert.ok(html.includes('<noscript>'))
  assert.ok(html.includes('"mode":"snapshot"') || html.includes('snapshot'))
  assert.ok(html.includes('"sig":"demo-v1-snapshot"'))
})

test('share: scope 参数解析与非法格式', () => {
  assert.equal(parseShareScope(''), null)
  assert.equal(parseShareScope('all'), null)
  assert.deepEqual(parseShareScope('ws:xingang'), { kind: 'ws', value: 'xingang' })
  assert.deepEqual(parseShareScope('project:星港'), { kind: 'project', value: '星港' })
  assert.deepEqual(parseShareScope('focus:vc-quote'), { kind: 'focus', value: 'vc-quote' })
  for (const bad of ['xingang', 'ws:', 'nope:x']) {
    assert.throws(() => parseShareScope(bad), (err) => err.status === 400, bad)
  }
})

test('share: 工作区切片只保留本区，边重新编号且自洽', async () => {
  const n = await demoNebula()
  const { graph, overview, scope } = sliceShareGraph(n, { kind: 'ws', value: 'xingang' })
  assert.equal(scope.kind, 'ws')
  assert.match(scope.label, /星港产品/)
  assert.equal(graph.stats.nodes, 32)
  assert.equal(graph.stats.workspaces, 1)
  assert.equal(overview.stats.nodes, 32)
  assert.equal(Object.keys(graph.stats.byWorkspace).length, 1)
  const ids = new Set(graph.nodes.map((x) => x.id))
  assert.ok(graph.nodes.every((x) => x.cluster === 'xingang'))
  for (const e of graph.edges) {
    assert.ok(graph.nodes[e.s] && graph.nodes[e.d], '边的下标必须在切片内')
  }
  assert.ok(graph.nodes.some((x) => x.content), '切片仍带正文')
  assert.ok(ids.has('xg-weekly'))
  assert.ok(!ids.has('dy-locker'))
  assert.ok(overview.hygiene && overview.hygiene.counts, '切片体检重算')
  assert.equal(overview.cards, null, '不把整库卡片带进局部快照')
})

test('share: 项目与焦点切片按预期收敛，跳数可增可减', async () => {
  const n = await demoNebula()
  const project = sliceShareGraph(n, { kind: 'project', value: '星港' })
  assert.ok(project.graph.nodes.length > 5)
  assert.ok(project.graph.nodes.every((x) => x.project === '星港'))
  assert.match(project.scope.label, /项目 · 星港/)

  const one = sliceShareGraph(n, { kind: 'focus', value: 'vc-quote' }, { hops: 1 })
  const three = sliceShareGraph(n, { kind: 'focus', value: 'vc-quote' }, { hops: 3 })
  assert.ok(one.graph.nodes.length >= 1)
  assert.ok(three.graph.nodes.length >= one.graph.nodes.length)
  assert.match(one.scope.label, /1 跳/)
  assert.throws(() => sliceShareGraph(n, { kind: 'focus', value: 'nope' }), (err) => err.status === 404)
})

test('share: 切片 HTML 不含范围外正文', async () => {
  const n = await demoNebula()
  const { html, nodes } = await buildShareHtml(
    n,
    { version: '0.9.0', build: 123 },
    { scope: { kind: 'ws', value: 'xingang' } },
  )
  assert.equal(nodes, 32)
  assert.ok(html.includes('"scope":{"kind":"ws"'))
  assert.ok(html.includes('星港产品'))
  assert.ok(!html.includes('dy-locker'), '范围外的节点不能出现在文件里')
  assert.ok(!html.includes('储物柜'), '范围外的正文不能出现在文件里')
})

test('share: hide 参数解析与白名单校验', () => {
  assert.deepEqual(parseShareHide([]), [])
  assert.deepEqual(parseShareHide(null), [])
  assert.deepEqual(parseShareHide('ws:日记'), [{ kind: 'ws', value: '日记' }])
  assert.deepEqual(parseShareHide(['level:user', 'project:私人']), [
    { kind: 'level', value: 'user' },
    { kind: 'project', value: '私人' },
  ])
  assert.deepEqual(parseShareHide('level:fact,ws:日记'), [
    { kind: 'level', value: 'fact' },
    { kind: 'ws', value: '日记' },
  ])
  for (const bad of ['日记', 'ws:', 'nope:x', 'level:']) {
    assert.throws(() => parseShareHide(bad), (err) => err.status === 400, bad)
  }
})

test('share: hide 把工作区从数据和统计里一起剔掉', async () => {
  const n = await demoNebula()
  const r = sliceShareGraph(n, null, { hide: ['ws:日记'] })
  assert.equal(r.scope.kind, 'all')
  assert.equal(r.scope.hidden, 7)
  assert.match(r.scope.label, /已隐去 7 条/)
  assert.equal(r.graph.nodes.length, 57)
  assert.ok(!r.graph.nodes.some((x) => x.ws === '日记'), '日记节点不能留在图里')
  assert.equal(r.overview.stats.nodes, 57)
  assert.ok(!Object.keys(r.overview.stats.byWorkspace).includes('日记'))
})

test('share: 起点被 hide 排除时给 400，而不是悄悄返回邻居', async () => {
  const n = await demoNebula()
  assert.throws(
    () => sliceShareGraph(n, { kind: 'focus', value: 'dy-copy' }, { hide: ['ws:日记'] }),
    (err) => err.status === 400 && /起点/.test(err.message),
  )
  assert.throws(
    () => sliceShareGraph(n, { kind: 'ws', value: 'diary' }, { hide: ['ws:日记'] }),
    (err) => err.status === 404,
  )
})

test('share: 快照不携带本机路径与数据库位置', async () => {
  const n = await demoNebula()
  const r = sliceShareGraph(n)
  for (const s of r.overview.sources) {
    assert.ok(s.key, '来源保留 key')
    assert.equal(s.path, undefined, '来源路径不能进快照')
    assert.equal(s.dbPath, undefined)
  }
  assert.equal(r.overview.dbPath, undefined)
  assert.equal(r.graph.sources[0].path, undefined)
})
