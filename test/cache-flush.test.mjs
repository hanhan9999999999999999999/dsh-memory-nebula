import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(REPO, 'lib', 'standalone.mjs')

// 一次性命令（--export / --share / --diagnose）建完图立刻退出，
// 而缓存是「开始写、不等它」——写盘那一半被 exit 掐掉，下次启动又得整张图重算。
// 1.11.62 起退出前等这一笔（flushCache），并且读盘恢复要带着 clusters 一起回来，
// 否则导出报告会在 .map 上撞 undefined。

const KWS = ['缓存落盘', '第二进程', '同一件事']

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-cache-root-'))
  const ws = join(root, 'proj')
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
  writeFileSync(join(root, 'sources.json'), JSON.stringify({ sources: [{ adapter: 'meow', root }] }), 'utf8')
  const db = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
  db.exec(
    'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, keywords TEXT, importance INTEGER, status TEXT, project TEXT, created_at INTEGER, updated_at INTEGER, hit_count INTEGER)',
  )
  const ins = db.prepare(
    'INSERT INTO fact (id,title,content,keywords,importance,status,project,created_at,updated_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
  for (let i = 0; i < 6; i++) {
    ins.run(
      'm' + i,
      '缓存样本 ' + i,
      '这一条和另外几条讲同一件事 ' + KWS.join(' ') + ' 第 ' + i + ' 次',
      JSON.stringify(KWS),
      3,
      'active',
      'proj',
      1763164800000,
      1763164800000 + i,
      1,
    )
  }
  db.close()
  return root
}

const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    /* Windows 上偶尔被句柄占着，测试清理失败不该让整轮挂掉 */
  }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'nebula-cache-home-'))
  process.env.DSH_HOME = home
  return home
}

function brFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.br'))
  } catch {
    return []
  }
}

test('建图后 flushCache 会把缓存真的写到盘上（不然一次性命令白算）', async () => {
  const root = makeRoot()
  makeHome()
  const nb = new Nebula({ roots: root, log: () => {} })
  try {
    assert.equal(await nb.refresh(), true)
    await nb.flushCache()
    const files = brFiles(nb.cacheDir)
    assert.equal(files.length, 1, '缓存目录里应该有一份图')
    assert.ok(!files[0].endsWith('.tmp'), '不能留下半截文件')
  } finally {
    safeRm(root)
  }
})

test('还没建图就 flushCache：不抛异常，也不假装写了什么', async () => {
  makeHome()
  const nb = new Nebula({ roots: [], log: () => {} })
  const out = await nb.flushCache(50)
  assert.equal(out, null)
  assert.equal(brFiles(nb.cacheDir).length, 0)
})

test('读盘恢复之后导出报告不崩，团也跟着回来', async () => {
  const root = makeRoot()
  makeHome()
  const first = new Nebula({ roots: root, log: () => {} })
  let nodes = 0
  try {
    assert.equal(await first.refresh(), true)
    nodes = first.graph.nodes.length
    await first.flushCache()
  } finally {
    closeStore()
  }

  const second = new Nebula({ roots: root, log: () => {} })
  try {
    // 命中缓存时 refresh() 返回 false —— 这不等于失败，图是好的。
    assert.equal(await second.refresh(), false)
    assert.equal(second.graph.nodes.length, nodes)
    assert.ok(Array.isArray(second.graph.clusters), '恢复的图要带 clusters')
    const report = second.exportReport({ format: 'json' })
    assert.equal(report.nodes.length, nodes)
    assert.ok(Array.isArray(report.clusters))
    const md = second.exportReport({ format: 'md' })
    assert.equal(md.format, 'md')
    assert.ok(md.text.length > 0, 'md 报告不能是空的')
  } finally {
    closeStore()
    safeRm(root)
  }
})

test('旧缓存里没有 clusters（1.11.62 之前写的）也不能崩', async () => {
  const root = makeRoot()
  makeHome()
  const nb = new Nebula({ roots: root, log: () => {} })
  try {
    await nb.refresh()
    // 模拟老缓存：字段整个不存在
    nb.graph.clusters = undefined
    const report = nb.exportReport({ format: 'json' })
    assert.ok(Array.isArray(report.clusters))
    assert.equal(report.clusters.length, 0)
    assert.ok(report.nodes.length > 0)
  } finally {
    closeStore()
    safeRm(root)
  }
})

test('同一份 home 连跑两次 --export：都退出 0，缓存真的落盘（1.11.62）', () => {
  const root = makeRoot()
  const home = makeHome()
  const out = join(home, 'export.json')
  try {
    const first = spawnSync(process.execPath, [CLI, '--root', root, '--export', out, '--format', 'json'], {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, DSH_HOME: home },
    })
    assert.equal(first.status, 0, first.stderr || first.stdout)
    assert.ok(brFiles(join(home, 'memory-nebula', 'nebula-cache')).length >= 1, '第一次跑完缓存就该在盘上')

    // 第二次命中缓存：refresh() 返回 false，但图是好的，绝不能当成「建图失败」。
    const second = spawnSync(process.execPath, [CLI, '--root', root, '--export', out, '--format', 'json'], {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, DSH_HOME: home },
    })
    assert.equal(second.status, 0, second.stderr || second.stdout)
    assert.match(second.stdout, /已写出/)
    const parsed = JSON.parse(readFileSync(out, 'utf8'))
    assert.ok(parsed.nodes.length > 0, '第二次导出的报告不能是空的')
  } finally {
    safeRm(root)
    safeRm(home)
  }
})
