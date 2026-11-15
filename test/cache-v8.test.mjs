import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync, brotliDecompressSync, constants as zc } from 'node:zlib'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'
import {
  cacheDir,
  cacheName,
  implFingerprint,
  loadGraphCache,
  parseCacheBytes,
  saveGraphCache,
  sourceSetKey,
} from '../lib/host/graphcache.js'

// 1.11.47：缓存换成 v8 序列化（v4 格式）。这一组盯着两件事：
//   ① 新写的文件确实是 v8（读回来与写进去一致）；
//   ② v3 的旧 JSON 缓存不能被判死 —— 插件升级不该让用户重新白等一遍建图。

const ROWS = 40

function makeRoot(rows = ROWS) {
  const root = mkdtempSync(join(tmpdir(), 'nebula-v8-'))
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
  db.exec('BEGIN')
  for (let i = 0; i < rows; i++) {
    const g = i % 6
    const kws = ['缓存', 'v8-' + g + '-a', 'v8-' + g + '-b']
    ins.run('v' + i, '缓存第 ' + i + ' 条', '第 ' + i + ' 条：' + kws.join(' ') + ' 讲同一件事。', JSON.stringify(kws), i % 5, 'active', 'proj', now, now + i, i % 3)
  }
  db.exec('COMMIT')
  db.close()
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
  const home = mkdtempSync(join(tmpdir(), 'nebula-v8home-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return Promise.resolve(fn(home)).finally(() => {
    closeStore()
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    safeRm(home)
  })
}

const newNebula = (root) =>
  new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })

test('v8：写出来的文件按 v8 解，内容与写进去的一致', async () => {
  await withHome(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nebula-v8out-'))
    try {
      const nodes = [{ id: 'a', title: '标题', content: '正文', keywords: ['k1', 'k2'], ws: 'w', project: 'p', importance: 2, updatedAt: 1, createdAt: 1, status: 'active' }]
      const graph = {
        nodes: [{ id: 'a', i: 0, title: '标题', preview: '正文', keywords: ['k1'], entities: ['x'] }],
        edges: [{ s: 0, t: 1, w: 0.5, type: 'keyword', why: ['共享关键词：k1'] }],
        stats: { nodes: 1, edges: 1 },
        builtAt: 123,
        muteCount: 0,
        sources: [{ key: 'meow:x', id: 'meow:x', adapter: 'meow', provider: 'meow-memory', title: 'x', path: 'p', size: 1, db: 'memory.db', error: '' }],
      }
      const written = await saveGraphCache(dir, 'sig-v8', { nodes, ledgers: { s1: ['a'] }, graph, srcs: 'srckey123456' })
      assert.equal(written.enc, 'v8', '写盘应该标出这是 v8')
      const files = readdirSync(dir).filter((n) => n.endsWith('.br'))
      assert.equal(files.length, 1)

      const raw = brotliDecompressSync(readFileSync(join(dir, files[0])))
      const { data, legacyJson } = parseCacheBytes(raw)
      assert.equal(legacyJson, false, '新文件不该被当成旧 JSON')
      assert.equal(data.enc, 'v8')
      assert.equal(data.v, 4)
      assert.equal(data.sig, 'sig-v8')
      assert.equal(data.srcs, 'srckey123456')
      assert.deepEqual(data.ledgers, { s1: ['a'] })
      assert.deepEqual(data.graph.nodes, graph.nodes)
      assert.deepEqual(data.graph.edges, graph.edges)
      assert.equal(data.nodes[0].content, '正文')

      const hit = await loadGraphCache(dir, 'sig-v8')
      assert.ok(hit, '同一签名应该读得回来')
      assert.equal(hit.nodes.length, 1)
      assert.equal(hit.graph.nodes[0].preview, '正文')
      assert.equal(hit.sig, 'sig-v8')
    } finally {
      safeRm(dir)
    }
  })
})

test('v8：v3 的旧 JSON 缓存照旧读得出来（升级不该让人重等一遍）', async () => {
  await withHome(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nebula-v3out-'))
    try {
      const root = makeRoot(12)
      const sig = 'sig-legacy-1'
      const legacy = {
        v: 3,
        sig,
        impl: implFingerprint(),
        srcs: sourceSetKey(['meow:legacy']),
        builtAt: 999,
        nodes: [{ id: 'v0', title: '旧标题', content: '旧正文', keywords: ['旧词'], ws: 'proj', project: 'proj', importance: 1, updatedAt: 5, createdAt: 5, status: 'active' }],
        ledgers: {},
        graph: {
          nodes: [{ id: 'v0', i: 0, title: '旧标题', preview: '旧正文', keywords: ['旧词'], entities: [] }],
          edges: [],
          stats: { nodes: 1, edges: 0 },
          builtAt: 999,
          muteCount: 0,
          sources: [{ key: 'meow:legacy', id: 'meow:legacy', adapter: 'meow', provider: 'meow-memory', title: 'legacy', path: root, size: 1, db: 'memory.db', error: '读不动 memory.db：file is not a database' }],
        },
      }
      writeFileSync(join(dir, cacheName(sig) + '.br'), brotliCompressSync(Buffer.from(JSON.stringify(legacy), 'utf8'), { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } }))

      const raw = brotliDecompressSync(readFileSync(join(dir, cacheName(sig) + '.br')))
      assert.equal(parseCacheBytes(raw).legacyJson, true, 'JSON 写的文件要被认成旧格式')

      const hit = await loadGraphCache(dir, sig)
      assert.ok(hit, 'v3 的缓存不该被丢掉')
      assert.equal(hit.nodes[0].content, '旧正文')
      assert.equal(hit.graph.builtAt, 999)
      assert.equal(hit.graph.sources[0].error, '读不动 memory.db：file is not a database', '旧格式里的坏来源诊断也要带出来')
    } finally {
      safeRm(dir)
    }
  })
})

test('v8：坏文件照旧丢掉，不会让进程带病往下走', async () => {
  await withHome(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nebula-v8bad-'))
    try {
      writeFileSync(join(dir, cacheName('sig-x') + '.br'), Buffer.from('not brotli at all', 'utf8'))
      assert.equal(await loadGraphCache(dir, 'sig-x'), null)
      const left = readdirSync(dir).filter((n) => n.endsWith('.br'))
      assert.equal(left.length, 0, '解不开的文件应该被清掉')
    } finally {
      safeRm(dir)
    }
  })
})

test('v8：真建一次图，重启后走读盘命中，节点与来源都在', async () => {
  await withHome(async () => {
    const root = makeRoot()
    const a = newNebula(root)
    try {
      await a.refresh()
      await a.cacheWriteDone()
      assert.equal(a.lastRefresh.why, 'rebuilt')
      assert.equal(a.lastCache.enc, 'v8', '写盘应该走 v8')
      const nodes = a.graph.nodes.length
      const builtAt = a.graph.builtAt

      const b = newNebula(root)
      await b.refresh()
      assert.equal(b.lastRefresh.why, 'cached')
      assert.equal(b.graph.nodes.length, nodes)
      assert.equal(b.graph.builtAt, builtAt, '读盘命中就该是上一次那份图')
      assert.equal(b.lastCache.hit, true, '这一趟应该是读盘命中')
      // 恢复不是重建：建图耗时必须是 0，年纪放在 cacheAgeMs 里，别让一个数字说两件事
      assert.equal(b.lastBuildMs, 0, '读盘命中时 buildMs 应该是 0')
      assert.ok(b.cacheAgeMs > 0, '这一份图的年纪要单独给出来')
      assert.equal(b.graph.sources.length, 1, '来源清单一起来自缓存')
    } finally {
      closeStore()
      safeRm(root)
    }
  })
})
