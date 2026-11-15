// 星图自己的小库（nebula.db）坏了：不能把整张图拖下水。
// 1.11.55：openStore 自愈——坏文件挪开留证据，新建空库，并把这件事报出来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { openStore, closeStore, storeRecovery, storePath, addLink, listLinks, addMute, listMutes } =
  await import('../lib/host/store.js')

function freshHome() {
  closeStore()
  const home = mkdtempSync(join(tmpdir(), 'nebula-store-heal-'))
  process.env.DSH_HOME = home
  mkdirSync(join(home, 'memory-nebula'), { recursive: true })
  return home
}

function cleanup(home) {
  closeStore()
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    /* Windows 上句柄没放干净就留着，临时目录会被系统清 */
  }
}

test('好库不会被当成坏库：recovery 是空的', () => {
  const home = freshHome()
  try {
    const db = openStore()
    assert.ok(db)
    addLink('meow:a', 'meow:b', '人工连的')
    assert.equal(listLinks().length, 1)
    assert.equal(storeRecovery(), null)
  } finally {
    cleanup(home)
  }
})

test('文件根本不是 sqlite：挪开、重建、继续能用，并留下证据', () => {
  const home = freshHome()
  try {
    const file = join(home, 'memory-nebula', 'nebula.db')
    writeFileSync(file, 'this is not a sqlite database'.repeat(30))

    const db = openStore()
    assert.ok(db, '坏库也要给出一个能用的句柄')

    const rec = storeRecovery()
    assert.ok(rec, '挪开坏文件这件事必须能被读到')
    assert.equal(rec.path, file)
    assert.equal(rec.error.length > 0, true)
    assert.match(rec.movedTo, /nebula\.db\.broken-/)
    assert.equal(existsSync(rec.movedTo), true, '坏文件要留在旁边当证据')
    assert.equal(existsSync(file), true, '原路径上要有一个新库')

    // 新库真的能用：写进去的连边能读回来
    addLink('meow:a', 'meow:b', '重建之后还能策展')
    addMute('meow:c', 'meow:d', '重建之后还能屏蔽')
    assert.equal(listLinks().length, 1)
    assert.equal(listMutes().length, 1)

    const names = readdirSync(join(home, 'memory-nebula'))
    assert.equal(names.filter((n) => n.includes('.broken-')).length, 1)
  } finally {
    cleanup(home)
  }
})

test('同一个进程里再开一次：不重复挪，也不重复报', () => {
  const home = freshHome()
  try {
    writeFileSync(join(home, 'memory-nebula', 'nebula.db'), 'garbage'.repeat(50))
    const first = openStore()
    const rec = storeRecovery()
    const second = openStore()
    assert.equal(first, second, '第二次打开要复用同一个句柄')
    assert.equal(storeRecovery(), rec, 'recovery 不该被第二次打开改写')
    assert.equal(readdirSync(join(home, 'memory-nebula')).filter((n) => n.includes('.broken-')).length, 1)
  } finally {
    cleanup(home)
  }
})

test('把库换成目录（连 sqlite 都打不开）：照样自愈', () => {
  const home = freshHome()
  try {
    const file = join(home, 'memory-nebula', 'nebula.db')
    mkdirSync(join(file, 'junk'), { recursive: true })
    const db = openStore()
    assert.ok(db)
    const rec = storeRecovery()
    assert.ok(rec)
    assert.match(rec.movedTo, /nebula\.db\.broken-/)
    addLink('meow:x', 'meow:y', '')
    assert.equal(listLinks().length, 1)
  } finally {
    cleanup(home)
  }
})

test('closeStore 之后 recovery 归零：换库不会继承上一个库的告示', () => {
  const home = freshHome()
  try {
    writeFileSync(join(home, 'memory-nebula', 'nebula.db'), 'garbage'.repeat(50))
    openStore()
    assert.ok(storeRecovery())
    closeStore()
    assert.equal(storeRecovery(), null)
    assert.equal(storePath(), join(home, 'memory-nebula', 'nebula.db'))
  } finally {
    cleanup(home)
  }
})

test('坏库不该挡住建图：图照样建起来，概览里说清小库重建过', async () => {
  const home = freshHome()
  try {
    // 一个正常工作区：一条记忆
    const ws = join(home, 'ws-1')
    mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(
      join(home, 'storages', 'workspace.json'),
      JSON.stringify({ tables: { workspaces: { 'ws-1': { path: ws, title: '记忆星图' } } } }),
    )
    const { DatabaseSync } = await import('node:sqlite')
    const src = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
    src.exec(
      'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, created_at INTEGER, keywords TEXT, level TEXT, importance INTEGER, status TEXT)',
    )
    src.exec("INSERT INTO fact VALUES ('a1','标题','内容',1794700000000,'记忆','fact',2,'active')")
    src.close()
    // 星图自己的小库是坏的
    writeFileSync(join(home, 'memory-nebula', 'nebula.db'), 'not a database'.repeat(40))

    const { Nebula } = await import('../lib/host/nebula.js')
    const nb = new Nebula({ roots: [], log: () => {} })
    await nb.refresh({ force: true })
    assert.equal(nb.graph.nodes.length >= 1, true, '记忆库里那条记忆要进图')

    const codes = (nb.overview({ hygiene: false }).warnings || []).map((w) => w.code)
    assert.equal(codes.includes('store-recovered'), true, '概览要说明小库重建过')
  } finally {
    cleanup(home)
  }
})
