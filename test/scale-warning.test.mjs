/**
 * 库大到什么程度，就该有人说一声。
 *
 * 20 万条实测（1.11.34）：建图 24.5 秒、堆 1.2GB、整图 JSON 106MB、缓存 17MB。
 * 这不是硬上限，超过了照样能跑；但界面与接口得说实话，别让人以为卡住了。
 * 这里锁三件事：
 *   1. 小库不吵人（level === 'ok'、warnings 为空）；
 *   2. 过线时 scale 与 warnings 都带得出「多少条、上一次建了多久」；
 *   3. /ping 上也看得见——探针和外部面板都从这儿读规模。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula, LARGE_LIBRARY_NODES } from '../lib/host/nebula.js'
import { registerRoutes, PREFIX } from '../lib/host/http.js'

const ROWS = 120

function safeRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 临时目录留给系统清理 */
  }
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-scale-'))
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
    ins.run(
      'f' + i,
      '标题 ' + i,
      '第 ' + i + ' 条记忆的正文，讲的是同一件事的不同侧面，用来把每一行都撑得像真的。',
      '["缓存","规模"]',
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
  return { root, dbPath: join(ws, '.dsh-meow', 'memory.db') }
}

async function withNebula(options, fn) {
  const { root } = makeRoot()
  const home = mkdtempSync(join(tmpdir(), 'nebula-scalehome-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const nebula = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false, ...options })
    await fn({ nebula, root })
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    safeRm(root)
    safeRm(home)
  }
}

/** 真的走一遍 HTTP 处理器：/ping 的字段是给面板和探针看的，不能只在引擎里对。 */
async function callPing(nebula) {
  let handler = null
  registerRoutes({ register({ handler: h }) { handler = h } }, nebula, () => {}, { mode: 'standalone' })
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status },
    getHeader(k) { return this.headers[k] },
    setHeader(k, v) { this.headers[k] = v },
    write(chunk) { this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '') },
    end(body) { if (body != null) this.body += Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '') },
  }
  const req = {
    url: PREFIX + '/ping',
    method: 'GET',
    headers: { host: '127.0.0.1:7891', origin: 'http://127.0.0.1:7891' },
  }
  await handler(req, res)
  return res.body ? JSON.parse(res.body) : null
}

test('小库不吵人：level 是 ok，warnings 是空', async () => {
  await withNebula({}, async ({ nebula }) => {
    await nebula.refresh()
    assert.equal(nebula.graph.nodes.length, ROWS)
    assert.equal(nebula.scale.level, 'ok')
    assert.equal(nebula.scale.nodes, ROWS)
    const ov = await nebula.overview()
    assert.deepEqual(ov.warnings, [])
    assert.equal(ov.scale.level, 'ok')
  })
})

test('过线就说话：说清多少条、上一次建了多久', async () => {
  await withNebula({ largeLibraryNodes: 50 }, async ({ nebula }) => {
    await nebula.refresh()
    assert.equal(nebula.scale.level, 'large')
    const ov = await nebula.overview()
    assert.equal(ov.warnings.length, 1)
    const w = ov.warnings[0]
    assert.equal(w.code, 'large-library')
    assert.equal(w.nodes, ROWS)
    assert.ok(w.message.includes(String(ROWS)), '告示里要有条数：' + w.message)
    assert.ok(typeof w.buildMs === 'number' && w.buildMs >= 0, '告示里要有上一次的耗时')
  })
})

test('默认门槛是 15 万条，且 /ping 上看得见规模', async () => {
  assert.equal(LARGE_LIBRARY_NODES, 150000)
  await withNebula({ largeLibraryNodes: 50 }, async ({ nebula }) => {
    await nebula.refresh()
    const ping = await callPing(nebula)
    assert.equal(ping.ok, true)
    assert.equal(ping.scale.level, 'large')
    assert.equal(ping.scale.nodes, ROWS)
  })
})
