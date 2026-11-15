/**
 * 坏库不能安静地变成「0 条」。
 *
 * 真实事故场景：某个工作区的 memory.db 被截断/半拷贝，用户打开星图看到那个工作区
 * 一条都没有，第一反应是「我的记忆被删了」。这一组测试锁住三件事：
 *   1. 扫描层要带着原文错误返回，而不是当成「没有这张表」；
 *   2. 建图成功后错误不能被清掉，诊断里要能点名是哪个来源；
 *   3. 库修好之后，错误要自己消失（不能永久挂着吓人）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { scan } from '../lib/host/adapters/meow.js'
import { Nebula } from '../lib/host/nebula.js'
import { buildDiagnostics, formatDiagnostics } from '../lib/host/diagnostics.js'
import { checkSources } from '../lib/host/doctor.js'

function safeRm(dir) {
  // Windows 上刚关掉的 sqlite / 文件监视器可能还占着句柄：EPERM 不该把测试判红
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 临时目录留给系统清理 */
  }
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-corrupt-'))
  const ws = join(root, 'proj')
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
  writeFileSync(join(ws, '.dsh-meow', 'memory.db'), Buffer.from(Array.from({ length: 256 }, (_, i) => i)))
  return { root, ws }
}

function storeOf(ws) {
  return {
    id: 'proj',
    title: 'proj',
    path: ws,
    key: 'proj',
    dbPath: join(ws, '.dsh-meow', 'memory.db'),
    sessionsDir: join(ws, '.dsh-meow', 'sessions'),
  }
}

test('scan：截断/非 SQLite 的库要报原文错误，不能当成空库', () => {
  const { root, ws } = makeRoot()
  try {
    const res = scan(storeOf(ws))
    assert.equal(res.nodes.length, 0)
    assert.match(res.error || '', /读不动/)
    assert.match(res.error || '', /not a database/i)
  } finally {
    safeRm(root)
  }
})

test('建图成功后不能把来源错误清掉，sources 里要能对上是哪个库', async () => {
  const { root } = makeRoot()
  const home = mkdtempSync(join(tmpdir(), 'nebula-home-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const nebula = new Nebula({ roots: [root], log: () => {} })
    await nebula.refresh()
    assert.equal(nebula.graph.nodes.length, 0)
    assert.equal(nebula.storeErrors.length, 1)
    assert.equal(nebula.storeErrors[0].store, 'proj')
    assert.match(nebula.lastError, /proj 读取失败/)
    const src = (nebula.graph.sources || []).find((s) => s.key === 'proj')
    assert.ok(src, '坏库也要出现在 sources 里')
    assert.match(src.error, /not a database/i)
  } finally {
    process.env.DSH_HOME = before
    safeRm(root)
    safeRm(home)
  }
})

test('诊断文本点名坏库，而不是只写一句 lastError', () => {
  const d = buildDiagnostics({
    version: '1.10.1',
    build: 1,
    startedAt: Date.now(),
    mode: 'standalone',
    nebula: {
      graph: { stats: { nodes: 0, edges: 0, workspaces: 0, sessions: 0 } },
      stores: [{ key: 'proj', title: 'proj', adapter: 'meow', provider: 'meow-memory', size: 256 }],
      storeErrors: [{ store: 'proj', error: '读不动 memory.db：file is not a database' }],
      lastError: 'proj 读取失败：读不动 memory.db：file is not a database',
    },
  })
  // 诊断可以对外贴：来源名保留了，文件名被抹成 [数据库]
  assert.equal(d.sources[0].error, '读不动 [数据库]：file is not a database')
  assert.equal(d.errors.length, 1)
  const text = formatDiagnostics(d)
  assert.match(text, /sourceErrors: 1/)
  assert.match(text, /! proj：读不动/)
  assert.ok(!text.includes('memory.db'), '诊断里不该出现库文件名')
})

test('doctor 的来源检查：坏库判 fail 并点名，提示怎么救', () => {
  const { root } = makeRoot()
  const home = mkdtempSync(join(tmpdir(), 'nebula-home-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const res = checkSources({ roots: [root] })
    assert.equal(res.status, 'fail')
    assert.match(res.detail, /proj/)
    assert.match(res.detail, /not a database/i)
    assert.match(res.hint, /备份/)
  } finally {
    process.env.DSH_HOME = before
    safeRm(root)
    safeRm(home)
  }
})

test('库修好之后，错误要自己消失', async () => {
  const { root, ws } = makeRoot()
  const home = mkdtempSync(join(tmpdir(), 'nebula-home-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const nebula = new Nebula({ roots: [root], log: () => {} })
    await nebula.refresh()
    assert.equal(nebula.storeErrors.length, 1)

    // 换成一个真的、能读的库（最小列集，meow 适配器按 PRAGMA 自适配）
    rmSync(join(ws, '.dsh-meow', 'memory.db'), { force: true })
    const db = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
    db.exec(
      'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, keywords TEXT, importance INTEGER, status TEXT, project TEXT, created_at INTEGER, updated_at INTEGER, hit_count INTEGER)',
    )
    db.prepare('INSERT INTO fact (id,title,content,keywords,importance,status,project,created_at,updated_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      'f1',
      '修好了',
      '数据库恢复之后这条记忆应该出现',
      '[]',
      3,
      'active',
      'proj',
      Date.now(),
      Date.now(),
      0,
    )
    db.close()

    await nebula.refresh({ force: true })
    assert.equal(nebula.storeErrors.length, 0)
    assert.equal(nebula.lastError, '')
    assert.ok(nebula.graph.nodes.length >= 1)
    assert.ok((nebula.graph.sources || []).every((s) => !s.error))
  } finally {
    process.env.DSH_HOME = before
    safeRm(root)
    safeRm(home)
  }
})
