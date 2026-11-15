// 1.11.61：meow 的库是 WAL 模式，新记忆先进 <db>-wal，主库文件的 size/mtime 不动。
// 星图签名以前只看主库 → 「写了新记忆，/refresh 却说没有变化」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const FACT_DDL = `create table fact (
  id text primary key,
  title text,
  content text,
  importance integer,
  keywords text,
  status text,
  source_session text,
  hit_count integer,
  created_at integer,
  updated_at integer,
  last_accessed_at integer,
  project text
)`

function insertFact(conn, id, content) {
  const now = Date.now()
  conn
    .prepare(
      'insert into fact (id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at, project) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, id, content, 2, JSON.stringify(['wal', 'probe']), 'active', 's1', 0, now, now, now, 'p')
}

/** 造一个 WAL 模式的 meow 工作区（写入连接一直开着，数据留在 -wal 里）。 */
function makeWalWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'nebula-walws-'))
  const ws = join(base, 'proj')
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
  const dbPath = join(ws, '.dsh-meow', 'memory.db')
  const writer = new DatabaseSync(dbPath)
  writer.exec('pragma journal_mode = wal')
  writer.exec(FACT_DDL)
  insertFact(writer, 'f1', '第一条记忆：星图的 WAL 签名测试。')
  return { base, ws, dbPath, writer }
}

async function makeNebula(roots) {
  const home = mkdtempSync(join(tmpdir(), 'nebula-walhome-'))
  process.env.DSH_HOME = home
  const { Nebula } = await import('../lib/host/nebula.js')
  return new Nebula({ roots, log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
}

test('WAL 里新写的记忆，签名跟着变，refresh 能把它带进图', async () => {
  const { base, dbPath, writer } = makeWalWorkspace()
  const nb = await makeNebula([base])

  const sig1 = nb.computeSignature()
  await nb.refresh()
  assert.equal(nb.graph.nodes.length, 1, '夹具应该只有一条记忆')

  const before = statSync(dbPath)

  insertFact(writer, 'f2', '第二条记忆：只写进了 WAL，主库文件一动不动。')

  const after = statSync(dbPath)
  assert.equal(after.size, before.size, '主库大小不该变（这正是坑所在）')
  assert.equal(Math.round(after.mtimeMs), Math.round(before.mtimeMs), '主库 mtime 也不该变')

  assert.notEqual(nb.computeSignature(), sig1, 'WAL 有写入，签名必须变')

  await nb.refresh()
  assert.equal(nb.lastRefresh.why, 'rebuilt', '签名变了就该重建')
  assert.equal(nb.graph.nodes.length, 2, '节点数应 1 → 2')
  assert.ok(
    nb.graph.nodes.some((n) => JSON.stringify(n).includes('第二条记忆')),
    '新记忆必须在图里',
  )
  writer.close()
})

test('没有 WAL 的时候，签名不该抖动（别为了不存在的写入反复重建）', async () => {
  const { base, writer } = makeWalWorkspace()
  writer.close() // 关库会 checkpoint，-wal 消失，数据落到主库

  const nb = await makeNebula([base])
  const sig1 = nb.computeSignature()
  await nb.refresh()
  assert.equal(nb.graph.nodes.length, 1)

  const sig2 = nb.computeSignature()
  assert.equal(sig2, sig1, '什么都没写，签名必须一样')

  const rebuilt = await nb.refresh()
  assert.equal(rebuilt, false, '不该重建')
  assert.equal(nb.lastRefresh.why, 'unchanged')
})

test('WAL 与主库两条线索只要有一条变，就要认出来', async () => {
  const { base, dbPath, writer } = makeWalWorkspace()
  const nb = await makeNebula([base])
  const sigClean = nb.computeSignature()

  insertFact(writer, 'f2', 'WAL 追加。')
  const sigWal = nb.computeSignature()
  assert.notEqual(sigWal, sigClean, '只写 WAL 也必须让签名变')

  writer.close() // checkpoint 把 WAL 写回主库，-wal 消失
  const sigAfterCheckpoint = nb.computeSignature()
  assert.notEqual(sigWal, sigAfterCheckpoint, 'checkpoint 前后状态不同，签名也该不同')
  assert.ok(statSync(dbPath).size > 0)
})
