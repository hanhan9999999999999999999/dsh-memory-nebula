import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 1.11.57 回归：来源体检（/sources 的 live 与 nebula_sources 工具）必须真的扫得动。
// 改前 sourcesReport() 调的是早已不存在的同步 scanAll，异常被兜成一条 error，
// 于是「已接入 N 个来源，共读到 0 条记忆」成了永远的输出。
const HOME = mkdtempSync(join(tmpdir(), 'nebula-sources-report-'))
process.env.DSH_HOME = HOME

const ROOT = mkdtempSync(join(tmpdir(), 'nebula-sources-root-'))
const NOTES = join(ROOT, 'notes')
mkdirSync(NOTES, { recursive: true })
writeFileSync(join(NOTES, 'a.md'), '---\ntitle: 第一条\n---\n\n正文一。\n', 'utf8')
writeFileSync(join(NOTES, 'b.md'), '---\ntitle: 第二条\n---\n\n正文二。\n', 'utf8')
const CFG_DIR = join(HOME, 'memory-nebula')
mkdirSync(CFG_DIR, { recursive: true })
writeFileSync(join(CFG_DIR, 'sources.json'), JSON.stringify({
  version: 1,
  autoDetect: false,
  sources: [{ adapter: 'notes', id: 'notes:fix', path: NOTES, title: '夹具笔记' }],
}), 'utf8')

const { Nebula } = await import('../lib/host/nebula.js')
const nb = new Nebula({ root: ROOT })

test('sourcesReport 是异步的：内部要 await 异步扫，不能再走不存在的同步版本', async () => {
  const pending = nb.sourcesReport()
  assert.equal(typeof pending.then, 'function', 'sourcesReport 必须返回 Promise')
  const rep = await pending
  assert.equal(rep.live.stores.length, 1, '应该有一个来源')
  assert.equal(rep.live.nodes, 2, '两篇笔记都该被读到')
  assert.deepEqual(rep.live.errors, [], '不该有读取失败：' + JSON.stringify(rep.live.errors))
})

test('sourcesReport 不会把内部异常伪装成「读到 0 条」', async () => {
  const rep = await nb.sourcesReport()
  const text = JSON.stringify(rep.live.errors || [])
  assert.ok(!text.includes('is not defined'), '错误里不该出现「is not defined」：' + text)
  assert.ok(rep.live.nodes > 0, 'live.nodes 必须大于 0')
})

test('来源清单报的是适配器与标题，不是一串 id', async () => {
  const rep = await nb.sourcesReport()
  const s0 = rep.live.stores[0] || {}
  assert.equal(s0.adapter, 'notes')
  assert.equal(s0.title, '夹具笔记')
  assert.ok(typeof rep.config.path === 'string' && rep.config.path.length > 0, '要给出配置文件路径')
})
