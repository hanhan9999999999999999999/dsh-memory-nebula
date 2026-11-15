import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'
import { waitFor } from '../testkit/wait.mjs'

// 夹具同 graph-cache.test.mjs：<root>/<ws>/.dsh-meow/memory.db，表名 fact，插入包事务。
const ROWS = 120

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-hwarm-'))
  const ws = join(root, 'proj')
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
  const db = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
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
    const kws = ['体检', 'rare' + g + 'a', 'rare' + g + 'b', 'rare' + g + 'c']
    ins.run('h' + i, '体检 ' + i, '第 ' + i + ' 条：' + kws.join(' ') + ' 同一组里的同一件事。', JSON.stringify(kws), i % 5, 'active', 'proj', now, now + i, i % 3)
  }
  db.exec('COMMIT')
  db.close()
  return { root }
}

const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 留给系统清 */
  }
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'nebula-hwarmhome-'))
  const prev = process.env.DSH_HOME
  const prevWarm = process.env.NEBULA_HYGIENE_WARM
  delete process.env.NEBULA_HYGIENE_WARM
  process.env.DSH_HOME = home
  closeStore()
  return Promise.resolve(fn(home)).finally(() => {
    closeStore()
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    if (prevWarm === undefined) delete process.env.NEBULA_HYGIENE_WARM
    else process.env.NEBULA_HYGIENE_WARM = prevWarm
    safeRm(home)
  })
}

test('建完图在后台把体检算好，点开看板时是现成的', async () => {
  const fx = makeRoot()
  try {
    await withHome(async () => {
      const nb = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 20 })
      await nb.refresh()
      await nb.cacheWriteDone()
      // 等条件成立，不等固定的 600ms：CI 机器慢、并发跑的时候固定表会红一次
      await waitFor('词频表与体检都预热完', () => nb.lastPrewarm?.done === true && nb.lastHygieneWarm?.done === true)
      assert.equal(nb.lastPrewarm?.done, true, '词频表该预热完')
      assert.equal(nb.lastHygieneWarm?.done, true, '体检该预热完')
      assert.ok(nb.lastHygieneWarm.ms >= 0)
      // 命中缓存：overview 不再重算（同一份签名）
      const ov = nb.overview()
      assert.ok(ov.hygiene && ov.hygiene.counts, 'overview 里要有体检结果')
      assert.ok(ov.hygiene.counts.dup > 0, '这批记忆有重复，dup 应该大于 0')
      assert.equal(nb._hygiene.sig, nb.signature, '缓存该挂在当前签名上')
    })
  } finally {
    safeRm(fx.root)
  }
})

test('关掉预热就没人先算：_hygiene 一直是空的', async () => {
  const fx = makeRoot()
  try {
    await withHome(async () => {
      const nb = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 20, hygieneWarm: false })
      await nb.refresh()
      await nb.cacheWriteDone()
      await waitFor('词频表预热完', () => nb.lastPrewarm?.done === true)
      await sleep(150) // 再空一拍：被关掉的体检不该在这之后冒出来
      assert.equal(nb.lastPrewarm?.done, true, '词频表照常预热（那是另一件事）')
      assert.equal(nb.lastHygieneWarm, null, '关掉之后不该去算体检')
      // 注意：没算过的时候这个字段是 undefined（不是 null），只在 restamp 时被显式置空。
      assert.ok(nb._hygiene == null, '也不该留下体检缓存')
    })
  } finally {
    safeRm(fx.root)
  }
})

test('预热出来的体检与当场算的结果一致', async () => {
  const fx = makeRoot()
  try {
    await withHome(async () => {
      const warm = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 20 })
      await warm.refresh()
      await warm.cacheWriteDone()
      await waitFor('体检预热完', () => warm.lastHygieneWarm?.done === true)
      const a = warm.overview().hygiene.counts

      closeStore()
      const cold = new Nebula({ roots: [fx.root], log: () => {}, prewarmDelayMs: 10 ** 7, hygieneWarm: false })
      await cold.refresh({ force: true })
      const b = cold.overview().hygiene.counts

      for (const k of ['dup', 'oversize', 'stale', 'thin', 'orphan']) {
        assert.equal(a[k], b[k], k + ' 不一致：预热 ' + a[k] + ' / 当场 ' + b[k])
      }
    })
  } finally {
    safeRm(fx.root)
  }
})
