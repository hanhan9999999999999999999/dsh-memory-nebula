import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'

// 这一条盯的是「重启之后，坏来源还告不告示」。
//
// 起因（1.11.33）：图缓存只存了图，读盘恢复时来源清单是按当前来源重新拼的，
// error 一律写成空字符串 —— 于是坏来源既不进图、也不出现在横幅里，
// 1.11.23 那个「少了一整块要一直说」的功能被缓存悄悄改掉了。

const ROWS = 120

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-readerr-cache-'))
  const good = join(root, 'good')
  mkdirSync(join(good, '.dsh-meow'), { recursive: true })
  const db = new DatabaseSync(join(good, '.dsh-meow', 'memory.db'))
  db.exec(
    'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, keywords TEXT, importance INTEGER, status TEXT, project TEXT, created_at INTEGER, updated_at INTEGER, hit_count INTEGER)',
  )
  const ins = db.prepare(
    'INSERT INTO fact (id,title,content,keywords,importance,status,project,created_at,updated_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
  const now = 1763164800000
  db.exec('BEGIN')
  for (let i = 0; i < ROWS; i++) {
    const g = i % 8
    const kws = ['坏来源', 'c' + g + 'a', 'c' + g + 'b', 'c' + g + 'c']
    ins.run('g' + i, '好记忆 ' + i, '第 ' + i + ' 条：' + kws.join(' ') + ' 说同一组里的同一件事。', JSON.stringify(kws), i % 5, 'active', 'good', now, now + i, i % 3)
  }
  db.exec('COMMIT')
  db.close()

  const bad = join(root, 'bad')
  mkdirSync(join(bad, '.dsh-meow'), { recursive: true })
  writeFileSync(join(bad, '.dsh-meow', 'memory.db'), Buffer.from('SQLite format 3\u0000' + 'x'.repeat(200)))
  return root
}

const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 留给系统清 */
  }
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'nebula-readerr-home-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  closeStore()
  return Promise.resolve(fn()).finally(() => {
    closeStore()
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    safeRm(home)
  })
}

test('读盘恢复之后，读不动的来源仍然在告示里', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const a = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
      await a.refresh()
      await a.cacheWriteDone()
      assert.equal(a.lastRefresh.why, 'rebuilt')
      const badA = (a.graph.sources || []).filter((s) => s.error)
      assert.equal(badA.length, 1, '建图这一趟就该看见坏来源')
      assert.match(badA[0].error, /读不动|打不开/)
      assert.equal(a.overview().readErrors.length, 1)

      // 重启：这次是读盘命中，坏来源那句诊断必须一起回来。
      const b = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
      await b.refresh()
      assert.equal(b.lastRefresh.why, 'cached', '同一批来源应当读盘命中')
      const badB = (b.graph.sources || []).filter((s) => s.error)
      assert.equal(badB.length, 1, '缓存恢复之后坏来源不能消失')
      assert.match(badB[0].error, /读不动|打不开/)
      const ov = b.overview()
      assert.equal(ov.readErrors.length, 1, '概览接口里也要有它')
      assert.ok(ov.readErrors[0].error, '错误原文要带着')
      assert.ok(ov.readErrors[0].key, '要能点回来源')
    })
  } finally {
    safeRm(root)
  }
})
