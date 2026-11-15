import test from 'node:test'
import assert from 'node:assert/strict'
import { Nebula } from '../lib/host/nebula.js'
import { buildShareHtml, sliceShareGraph } from '../lib/host/share.js'

// 「有来源读不动」这件事，必须有机器可读的清单，也必须出现在导出的快照里。
// 以前只有每个 source 上的 error 字段：图上少了一整个工作区，界面与快照都不说。

async function demoNebula() {
  const nb = new Nebula({ demo: true, log: () => {} })
  await nb.refresh()
  return nb
}

function withBadSource(nb) {
  const ok = (nb.graph.sources || [])[0] || { key: 'demo', title: 'demo', size: 1, count: 10 }
  nb.graph.sources = [
    { ...ok, error: '' },
    { key: 'broken', title: 'broken ws', path: 'D:/secret/place', db: 'D:/secret/place/.dsh-meow/memory.db', size: 0, count: 0, error: '读不动 memory.db：file is not a database' },
  ]
  return nb
}

test('overview: 读不动的来源有一条 readErrors 清单（带路径，本机诊断用）', async () => {
  const nb = withBadSource(await demoNebula())
  const ov = nb.overview({ hygiene: false })
  assert.equal(ov.readErrors.length, 1)
  const [e] = ov.readErrors
  assert.equal(e.key, 'broken')
  assert.equal(e.title, 'broken ws')
  assert.match(e.error, /not a database/)
  assert.equal(e.path, 'D:/secret/place')
  assert.equal(ov.cards, null, 'hygiene:false 时不该顺手算 cards')
})

test('share 切片：快照里带着读不动的库，但不带本机路径', async () => {
  const nb = withBadSource(await demoNebula())
  const payload = sliceShareGraph(nb, null, { limit: 200 })
  const errs = payload.overview.readErrors
  assert.equal(errs.length, 1)
  assert.equal(errs[0].key, 'broken')
  assert.equal(errs[0].path, undefined, '路径不进快照')
  assert.equal(errs[0].db, undefined)
  assert.match(errs[0].error, /not a database/, '原因要留着，否则拿到文件的人不知道少了什么')
})

test('share 页面：有读不动的库时静态横幅在，干净时没有', async () => {
  const bad = withBadSource(await demoNebula())
  const dirty = await buildShareHtml(bad, { version: '0.0.0-test', build: 1 }, { limit: 200 })
  assert.ok(dirty.html.includes('id="snapshot-readerr"'), '缺读不动横幅')
  assert.ok(dirty.html.includes('个来源读不动'), '横幅文案不对')
  assert.ok(dirty.html.includes('broken'), '没写清是哪个来源')
  assert.ok(!dirty.html.includes('D:/secret/place'), '本机路径不该出现在快照里')

  const clean = await demoNebula()
  clean.graph.sources = (clean.graph.sources || []).map((s) => ({ ...s, error: '' }))
  const pure = await buildShareHtml(clean, { version: '0.0.0-test', build: 1 }, { limit: 200 })
  assert.ok(!pure.html.includes('id="snapshot-readerr"'), '干净时不该有横幅')
})
