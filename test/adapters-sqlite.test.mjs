/**
 * 适配器 sqlite：任意 SQLite 记忆库（列映射驱动）。
 *
 * 以前它也是 0 函数覆盖——而「自己写的记忆插件」用的就是这条路。
 * 这里锁五件事：
 *   1. 探测：文件在、表读得出才算一个来源；不是 sqlite 就当没有；
 *   2. 列自动猜：常见列名对得上就读，猜不到的列跳过，不把库读炸；
 *   3. 表 → 层：多表模式、单表模式、兜底按表名；
 *   4. where 只认简单比较，写 UPDATE/DELETE 一律当没写（适配器是只读的）；
 *   5. 512 行让一次路——生成器真的 yield 过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { detect, scan, scanSteps, probe, listTables, meta } from '../lib/host/adapters/sqlite.js'

function makeDb(rows = 3, build = null) {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-sqlite-'))
  const dbPath = join(dir, 'facts.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE facts (id TEXT, title TEXT, content TEXT, tags TEXT, importance INTEGER, created_at INTEGER)')
  db.exec('BEGIN')
  const stmt = db.prepare('INSERT INTO facts (id, title, content, tags, importance, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  for (let i = 1; i <= rows; i++) {
    stmt.run('f' + i, '第 ' + i + ' 条', '内容 ' + i, '缓存,失效', i % 5, 1763164800000 + i * 1000)
  }
  db.exec('COMMIT')
  if (build) build(db)
  db.close()
  return {
    dbPath,
    done() {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {
        /* 临时目录留给系统清理 */
      }
    },
  }
}

test('sqlite.detect：不是 sqlite、路径不存在、没配路径都不产出', () => {
  assert.deepEqual(detect({}), [])

  const dir = mkdtempSync(join(tmpdir(), 'nebula-notdb-'))
  const fake = join(dir, 'fake.db')
  writeFileSync(fake, 'SQLite format 3\u0000' + 'x'.repeat(100))
  try {
    assert.deepEqual(detect({ path: fake }), [], '半截文件不是可读的库，不该冒出来源')
    assert.equal(listTables(fake).length, 0)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }

  const box = makeDb()
  try {
    const stores = detect({ path: box.dbPath })
    assert.equal(stores.length, 1)
    const st = stores[0]
    assert.equal(st.adapter, 'sqlite')
    assert.equal(st.dbPath, box.dbPath)
    assert.deepEqual(st.tables, ['facts'])
    assert.equal(st.title, 'facts', '标题默认取文件名（去扩展名）')
    assert.ok(st.size > 0 && st.mtimeMs > 0)
  } finally {
    box.done()
  }
})

test('sqlite.scan：按常见列名猜字段，表名当层名', () => {
  const box = makeDb(3)
  try {
    const st = detect({ path: box.dbPath })[0]
    const { nodes, ledgers } = scan(st)
    assert.deepEqual(ledgers, [])
    assert.equal(nodes.length, 3)

    const n = nodes[0]
    assert.ok(n.id.startsWith('sqlite:'), 'id 前缀标明来源适配器')
    assert.equal(n.level, 'fact', '表名 facts → 层 fact')
    assert.equal(n.title, '第 1 条')
    assert.equal(n.content, '内容 1')
    assert.deepEqual(n.keywords, ['缓存', '失效'], 'tags 列按关键词读')
    assert.equal(n.importance, 1, 'importance 原样读进来（0–4 之内）')
    assert.ok(n.createdAt > 0, 'created_at 读成毫秒')
    assert.equal(n.table, 'facts')
    assert.equal(n.adapter, 'sqlite')
  } finally {
    box.done()
  }
})

test('sqlite.scan：单表模式按 levelField 分层，columns 可以点名覆盖', () => {
  const box = makeDb(2, (db) => {
    db.exec('CREATE TABLE memories (uid TEXT, heading TEXT, body TEXT, kind TEXT)')
    db.exec("INSERT INTO memories VALUES ('m1', '标题一', '正文一', 'lesson'), ('m2', '标题二', '正文二', 'fact')")
  })
  try {
    const st = detect({ path: box.dbPath, table: 'memories', levelField: 'kind', columns: { content: 'body' } })[0]
    const { nodes } = scan(st)
    assert.equal(nodes.length, 2)
    const byTitle = new Map(nodes.map((n) => [n.title, n]))
    assert.equal(byTitle.get('标题一').level, 'lesson', 'levelField 说了算')
    assert.equal(byTitle.get('标题二').level, 'fact')
    assert.equal(byTitle.get('标题一').content, '正文一', 'columns.content 点名 body 列')
    assert.equal(byTitle.get('标题一').uid, 'm1')
  } finally {
    box.done()
  }
})

test('sqlite.scan：where 只认简单比较，写 UPDATE/DELETE 一律当没写', () => {
  const box = makeDb(5)
  try {
    const filtered = scan(detect({ path: box.dbPath, where: 'importance > 1' })[0])
    assert.ok(filtered.nodes.length > 0 && filtered.nodes.length < 5, '正常过滤生效')

    const malicious = scan(detect({ path: box.dbPath, where: 'DELETE FROM facts' })[0])
    assert.equal(malicious.nodes.length, 5, '会改数据的 where 被丢掉，只读不变')
  } finally {
    box.done()
  }
})

test('sqlite.scanSteps：512 行让一次路，行数不丢', () => {
  const box = makeDb(600)
  try {
    const st = detect({ path: box.dbPath })[0]
    const it = scanSteps(st)
    let yields = 0
    let result = null
    for (;;) {
      const step = it.next()
      if (step.done) {
        result = step.value
        break
      }
      assert.equal(step.value, 'rows')
      yields += 1
    }
    assert.ok(yields >= 1, '600 行至少让一次路')
    assert.equal(result.nodes.length, 600)
  } finally {
    box.done()
  }
})

test('sqlite.probe：读得出表和读不出表，说法不一样', () => {
  const missing = probe({ path: join(tmpdir(), 'nebula-sqlite-nope-xyz.db') })
  assert.equal(missing.ok, false)
  assert.match(missing.note, /不是可读的 SQLite/)

  const box = makeDb(1)
  try {
    const good = probe({ path: box.dbPath })
    assert.equal(good.ok, true)
    assert.match(good.note, /1 张表：facts/)
  } finally {
    box.done()
  }
})

test('sqlite.meta：配置项写清楚了，别让人翻源码', () => {
  assert.equal(meta.id, 'sqlite')
  assert.equal(meta.kind, 'sqlite')
  assert.ok(meta.config.path.includes('必填'))
  assert.ok(meta.config.tables.includes('多表'))
})
