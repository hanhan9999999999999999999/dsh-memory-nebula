/**
 * 读一个库的时候也要让路。
 *
 * 真实事故场景：5 万条的库重建一次 6.6 秒，其中 0.45 秒在读四个 memory.db。
 * 原来每个库是 `SELECT * … .all()` 一口气拉完（一个 12,500 行的库约 110ms 不让路），
 * 那段时间宿主界面上的任何请求都排在后面。这一组测试锁住三件事：
 *   1. scanSteps 逐行取（iterate），每 512 行 yield 一次；
 *   2. 同步壳 scan 与生成器版拿到的节点/账本完全一致（老调用方不受影响）；
 *   3. 走 scanAllAsync 时，10ms 定时器在扫描期间还能跑，最长空档受控。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { scan, scanSteps } from '../lib/host/adapters/meow.js'
import { scanAllAsync } from '../lib/host/adapters/index.js'

function safeRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 临时目录留给系统清理 */
  }
}

const ROWS = 1500

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-scansteps-'))
  const ws = join(root, 'proj')
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
  const dbPath = join(ws, '.dsh-meow', 'memory.db')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, keywords TEXT, importance INTEGER, status TEXT, project TEXT, created_at INTEGER, updated_at INTEGER, hit_count INTEGER)',
  )
  const ins = db.prepare(
    'INSERT INTO fact (id,title,content,keywords,importance,status,project,created_at,updated_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
  const now = 1763164800000
  // 一定包在一个事务里：Windows 上每行一次自动提交要各自 fsync，
  // 1500 行能跑一分多钟（这一版测试第一次就是这么挂住的）。
  db.exec('BEGIN')
  for (let i = 0; i < ROWS; i++) {
    ins.run(
      'f' + i,
      '标题 ' + i,
      '第 ' + i + ' 条记忆的正文，讲的是同一件事的不同侧面，用来把每一行都撑得像真的。',
      '[]',
      i % 5,
      'active',
      'proj',
      now,
      now + i,
      i % 7,
    )
  }
  db.exec('COMMIT')
  db.close()
  return {
    root,
    store: {
      id: 'proj',
      title: 'proj',
      path: ws,
      key: 'proj',
      adapter: 'meow',
      provider: 'meow-memory',
      dbPath,
      sessionsDir: join(ws, '.dsh-meow', 'sessions'),
    },
  }
}

test('scanSteps：每 512 行 yield 一次，行还是一行不少', () => {
  const { root, store } = makeStore()
  try {
    const it = scanSteps(store)
    let yields = 0
    let rows = 0
    let step = it.next()
    while (!step.done) {
      if (step.value === 'rows') yields++
      step = it.next()
    }
    rows = (step.value?.nodes || []).length
    assert.equal(rows, ROWS, '节点数应该等于库里的行数')
    // 1500 行 / 512 → 在第 512、1024 行各让一次
    assert.ok(yields >= 2, '应该至少让路两次，实际 ' + yields)
  } finally {
    safeRm(root)
  }
})

test('同步壳 scan 与生成器版结果一致（老调用方不受影响）', () => {
  const { root, store } = makeStore()
  try {
    const sync = scan(store)
    const it = scanSteps(store)
    let step = it.next()
    while (!step.done) step = it.next()
    const gen = step.value
    assert.equal(sync.nodes.length, gen.nodes.length)
    assert.deepEqual(
      sync.nodes.map((n) => n.id),
      gen.nodes.map((n) => n.id),
    )
    assert.deepEqual(sync.ledgers, gen.ledgers)
    // 内容也要一致：别为了快把字段丢了
    assert.deepEqual(sync.nodes[7], gen.nodes[7])
  } finally {
    safeRm(root)
  }
})

test('scanAllAsync：扫描期间定时器还能跑，最长空档受控', async () => {
  const { root, store } = makeStore()
  try {
    let ticks = 0
    let last = process.hrtime.bigint()
    let maxGap = 0
    const timer = setInterval(() => {
      const now = process.hrtime.bigint()
      const dt = Number(now - last) / 1e6
      if (dt > maxGap) maxGap = dt
      last = now
      ticks++
    }, 10)
    const t0 = Date.now()
    const res = await scanAllAsync([store])
    // 收尾要让事件循环再转一次，否则「被拖迟的那一拍」还没机会报出来
    await new Promise((r) => setTimeout(r, 30))
    clearInterval(timer)
    const ms = Date.now() - t0
    assert.equal(res.nodes.length, ROWS)
    assert.ok(ticks >= 2, '扫描期间定时器至少跑两拍，实际 ' + ticks)
    assert.ok(maxGap <= 120, '最长空档应该受控，实际 ' + maxGap.toFixed(0) + 'ms（总时长 ' + ms + 'ms）')
  } finally {
    safeRm(root)
  }
})
