/**
 * 被 maxFiles 截断的来源：从适配器 → 汇总 → overview 告示，整条链都要说得出来。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'nebula-trunc-'))
process.env.DSH_HOME = HOME

const notes = await import('../lib/host/adapters/notes.js')
const { scanAll } = await import('../lib/host/adapters/index.js')

const root = join(HOME, 'vault')

test.before(() => {
  for (let i = 0; i < 9; i++) {
    const dir = join(root, 'd' + (i % 3))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'n' + i + '.md'), '# 笔记 ' + i + '\n\n正文 ' + i + '\n', 'utf8')
  }
})

test.after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* Windows 上偶发占用 */
  }
})

test('detect 记下 truncated 与 maxFiles；scan 也只读前 N 个', () => {
  const store = notes.detect({ adapter: 'notes', path: root, maxFiles: 3 })[0]
  assert.equal(store.truncated, true)
  assert.equal(store.maxFiles, 3)
  assert.equal(store.fileCount, 3)

  const res = notes.scan(store)
  assert.equal(res.truncated, true)
  assert.equal(res.nodes.length, 3)
})

test('没爬到上限时 truncated 是 false（别乱报警）', () => {
  const store = notes.detect({ adapter: 'notes', path: root, maxFiles: 50 })[0]
  assert.equal(store.truncated, false)
  assert.equal(notes.scan(store).truncated, false)
})

test('scanAll 把截断汇成 warnings，和 errors 分开', () => {
  const store = notes.detect({ adapter: 'notes', path: root, maxFiles: 2 })[0]
  const all = scanAll([store])
  assert.equal(all.errors.length, 0, '截断不是读坏，不该进 errors')
  assert.equal(all.warnings.length, 1)
  assert.equal(all.warnings[0].code, 'truncated')
  assert.equal(all.warnings[0].maxFiles, 2)
  assert.ok(all.warnings[0].message.includes('只读了前 2 个文件'), all.warnings[0].message)
})

test('overview 的告示里带 source-truncated，界面才有话可说', async () => {
  const { Nebula } = await import('../lib/host/nebula.js')
  const nb = new Nebula({ extraRoots: [], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
  await nb.refresh()
  nb.storeWarnings = [
    { store: 'vault', id: 'notes:vault', code: 'truncated', maxFiles: 2, message: '来源被文件数上限截断：只读了前 2 个文件，其余没有进图。' },
  ]
  const ov = nb.overview()
  const hit = (ov.warnings || []).find((w) => w.code === 'source-truncated')
  assert.ok(hit, '没有 source-truncated 告示')
  assert.equal(hit.store, 'vault')
  assert.equal(hit.maxFiles, 2)
  assert.ok(hit.message.includes('截断'))
})
