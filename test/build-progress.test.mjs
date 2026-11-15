/**
 * 建图那几秒，界面要能说清走到哪了。
 *
 * 以前遮罩上只有一个转圈：五万条库要建六秒多，用户没法判断是卡住了还是快好了。
 * 这一组测试锁住三件事：
 *   1. buildGraphSteps 的阶段名真的会通过 onStep 报出来（且不改变建出来的图）；
 *   2. 引擎在 refresh 期间维护 buildProgress，建完必须清空（不能留一个假进度在转）；
 *   3. HTTP 的 /progress 在建图期间也要立刻回答——这条要是 await 住，界面就又只能转圈。
 *
 * 第 3 条必须在 HTTP 层测：引擎里做对了、路由却等建图，页面照样看不到进度。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula, BUILD_STAGES } from '../lib/host/nebula.js'
import { buildGraph, buildGraphAsync } from '../lib/host/graph.js'
import { registerRoutes, PREFIX, CAPABILITIES } from '../lib/host/http.js'

function safeRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 临时目录留给系统清理 */
  }
}

const ROWS = 120
const INSERT_SQL =
  'INSERT INTO fact (id,title,content,keywords,importance,status,project,created_at,updated_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,?)'

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-progress-'))
  const ws = join(root, 'proj')
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
  const dbPath = join(ws, '.dsh-meow', 'memory.db')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, keywords TEXT, importance INTEGER, status TEXT, project TEXT, created_at INTEGER, updated_at INTEGER, hit_count INTEGER)',
  )
  const ins = db.prepare(INSERT_SQL)
  const now = 1763164800000
  db.exec('BEGIN')
  for (let i = 0; i < ROWS; i++) {
    ins.run(
      'f' + i,
      '标题 ' + i,
      '第 ' + i + ' 条记忆的正文，讲的是同一件事的不同侧面，用来把每一行都撑得像真的。',
      '["星图","进度"]',
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
  return { root, dbPath }
}

async function withNebula(fn) {
  const { root, dbPath } = makeRoot()
  const home = mkdtempSync(join(tmpdir(), 'nebula-progress-home-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const nebula = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
    await fn({ nebula, root, dbPath })
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    safeRm(root)
    safeRm(home)
  }
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      Object.assign(this.headers, headers || {})
    },
    getHeader(k) {
      return this.headers[k]
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(body) {
      if (body != null) this.body += Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
    },
  }
}

function makeCaller(nebula) {
  let handler = null
  registerRoutes({ register({ handler: h }) { handler = h } }, nebula, () => {}, { mode: 'standalone' })
  return async (path, method = 'GET') => {
    const req = { url: PREFIX + path, method, headers: { host: '127.0.0.1:7891', origin: 'http://127.0.0.1:7891' } }
    const res = makeRes()
    await handler(req, res)
    return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
  }
}

test('buildGraphAsync 会把阶段名报出来，且建出来的图与同步版一致', async () => {
  const nodes = []
  for (let i = 0; i < 200; i++) {
    nodes.push({
      id: 'n' + i,
      ws: 'w',
      title: '节点 ' + i,
      content: '第 ' + i + ' 条的正文，星图 关联 记忆 ' + (i % 17),
      keywords: ['星图', '关联', '记忆' + (i % 17)],
      importance: i % 5,
      createdAt: 1763164800000 - i * 1000,
      updatedAt: 1763164800000 - i * 1000,
      status: 'active',
      project: 'w',
      hitCount: 0,
    })
  }
  const input = { nodes, ledgers: [], manual: [], mutes: [], inventory: { plugins: [], skills: [], mcp: [] }, now: 1763164800000 }

  const seen = []
  const asyncGraph = await buildGraphAsync(Object.assign({}, input, { onStep: (stage) => seen.push(stage) }))
  const syncGraph = buildGraph(input)

  // 分片是按时间让路的：库小的时候一次建图只会让路几次，
  // 所以这里断言「报过、名字合法、第一个是 nodes」，不假设具体次数。
  assert.ok(seen.length >= 2, '应该报出阶段（实际 ' + seen.length + ' 次）')
  const unique = [...new Set(seen)]
  assert.ok(unique.length >= 2, '至少应该走过两个阶段，实际 ' + unique.join(','))
  for (const stage of unique) {
    assert.ok(BUILD_STAGES.includes(stage), '阶段名必须是已知的：' + stage)
  }
  assert.equal(unique[0], 'nodes', '第一个报出来的阶段应该是整理节点')
  assert.equal(asyncGraph.nodes.length, syncGraph.nodes.length, '节点数应与同步版一致')
  assert.equal(asyncGraph.edges.length, syncGraph.edges.length, '边数应与同步版一致')
})

test('建图期间 buildProgress 有阶段，建完必须清空', async () => {
  await withNebula(async ({ nebula }) => {
    assert.equal(nebula.buildProgress, null, '还没建的时候没有进度')

    const pending = nebula.refresh()
    let seen = null
    const t0 = Date.now()
    while (Date.now() - t0 < 8000) {
      if (nebula.buildProgress) {
        seen = Object.assign({}, nebula.buildProgress)
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.ok(seen, '建图期间应该能读到 buildProgress')
    assert.ok(BUILD_STAGES.includes(seen.stage), '阶段名要合法：' + seen.stage)
    assert.ok(seen.label && seen.label !== seen.stage, '要给人看的名字，不是内部键名')
    assert.equal(seen.total, BUILD_STAGES.length, '总步数应等于阶段表长度')
    assert.ok(seen.step >= 0 && seen.step < seen.total, 'step 应落在 0..total-1')
    assert.equal(typeof seen.ms, 'number', '要带耗时')

    await pending
    assert.equal(nebula.buildProgress, null, '建完必须清空，不能留一个假进度在转')
    assert.equal(nebula.lastRefresh.why, 'rebuilt')
    assert.equal(nebula.graph.nodes.length, ROWS, '图应该是这个库的 ' + ROWS + ' 条')
  })
})

test('HTTP：/progress 在建图期间也立刻回答', async () => {
  assert.ok(CAPABILITIES.includes('progress'), '接口清单里要有 progress')
  await withNebula(async ({ nebula }) => {
    const call = makeCaller(nebula)

    // 手上还没有图：立刻回，别等建图
    const t0 = Date.now()
    const idle = await call('/progress')
    const idleMs = Date.now() - t0
    assert.equal(idle.status, 200)
    assert.equal(idle.json.building, false, '还没开始建')
    assert.equal(idle.json.progress, null)
    assert.equal(idle.json.nodes, 0)
    assert.ok(idleMs < 2000, '没有图时也不该卡住，实测 ' + idleMs + 'ms（' + idle.json.nodes + ' 条）')

    // 正在建：这条路由不许等
    const pending = nebula.refresh()
    let busy = null
    const tBusy = Date.now()
    while (Date.now() - tBusy < 8000) {
      const r = await call('/progress')
      if (r.json.building && r.json.progress) {
        busy = r.json
        break
      }
      await new Promise((res) => setTimeout(res, 5))
    }
    assert.ok(busy, '建图期间 /progress 应该给出 building:true 和进度')
    assert.ok(BUILD_STAGES.includes(busy.progress.stage), '阶段名合法：' + busy.progress.stage)

    await pending
    const after = await call('/progress')
    assert.equal(after.json.building, false, '建完就不在 building')
    assert.equal(after.json.progress, null, '建完不再报进度')
    assert.equal(after.json.nodes, ROWS)
  })
})
