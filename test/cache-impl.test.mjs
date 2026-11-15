// 1.11.31：缓存里记着「这份图是谁算的」。插件升级改了建图算法，来源签名一个字节都没变，
// 旧图不能被当成正确答案 —— 这条测试就是钉死这件事。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore } from '../lib/host/store.js'
import { cacheDir, implFingerprint, loadGraphCache, loadNewestGraphCache, saveGraphCache } from '../lib/host/graphcache.js'

const ROWS = 120

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-impl-'))
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
  for (let i = 0; i < ROWS; i++) {
    const g = i % 8
    const kws = ['指纹', 'rare' + g + 'a', 'rare' + g + 'b', 'rare' + g + 'c']
    ins.run('f' + i, '指纹 ' + i, '第 ' + i + ' 条：' + kws.join(' ') + ' 讲同一组里的同一件事。', JSON.stringify(kws), i % 5, 'active', 'proj', now, now + i, i % 3)
  }
  db.exec('COMMIT')
  db.close()
  return { root, dbPath }
}

const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 留给系统清 */
  }
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'nebula-implhome-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  closeStore()
  return Promise.resolve(fn(home)).finally(() => {
    closeStore()
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    safeRm(home)
  })
}

const newNebula = (root, extra = {}) =>
  new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false, ...extra })

test('算法指纹：同一次进程里稳定，16 位十六进制', () => {
  const a = implFingerprint()
  const b = implFingerprint()
  assert.equal(a, b, '同一个进程里两次算出来必须一样')
  assert.match(a, /^[0-9a-f]{16}$/, '指纹应该是 16 位十六进制，实际是 ' + a)
})

test('旧算法写的缓存：严格读盘不认，但仍然能当「上一版」拿出来', async () => {
  await withHome(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nebula-implcache-'))
    try {
      const graph = { nodes: [{ id: 'a' }], edges: [], stats: { edges: 0 }, builtAt: 1 }
      await saveGraphCache(dir, 'sig-1', { nodes: [{ id: 'a' }], ledgers: {}, graph, impl: 'deadbeefdeadbeef' })
      assert.equal(await loadGraphCache(dir, 'sig-1'), null, '算法对不上时严格读盘必须当没有缓存')
      const newest = await loadNewestGraphCache(dir)
      assert.ok(newest, '「上一版」这条路仍要能拿到它')
      assert.equal(newest.impl, 'deadbeefdeadbeef')
      assert.equal(newest.graph.nodes.length, 1)
    } finally {
      safeRm(dir)
    }
  })
})

test('升级之后第一次启动：先给旧图（标 implStale），后台重建成新算法，下一次就命中', async () => {
  const { root } = makeRoot()
  try {
    await withHome(async () => {
      // 1) 先正常建一次，拿到真实的签名与目录
      const a = newNebula(root)
      await a.refresh()
      await a.cacheWriteDone()
      const dir = cacheDir(join(process.env.DSH_HOME, 'memory-nebula'))
      const sig = a.signature
      const builtAt = a.graph.builtAt
      assert.equal(a.lastCache.hit, false)
      closeStore()

      // 2) 把盘上那份改写成「旧算法」建的：模拟插件升级后算法变了、来源没变
      const files = readdirSync(dir).filter((n) => n.endsWith('.br'))
      assert.ok(files.length >= 1, '应该写出了缓存文件')
      const old = readFileSync(join(dir, files[0]))
      const { brotliDecompress, brotliCompressSync } = await import('node:zlib')
      const { parseCacheBytes } = await import('../lib/host/graphcache.js')
      const { serialize } = await import('node:v8')
      const unpacked = (await new Promise((res, rej) => brotliDecompress(old, (e, v) => (e ? rej(e) : res(v)))))
      const { data: raw, legacyJson } = parseCacheBytes(unpacked)
      // 解出来是什么格式就按什么格式写回去（1.11.47 起是 v8；老格式是 JSON）
      raw.impl = 'oldalgorithm0000'
      const bytes = legacyJson ? Buffer.from(JSON.stringify(raw), 'utf8') : serialize(raw)
      const repacked = brotliCompressSync(bytes)
      const { writeFileSync: wf } = await import('node:fs')
      wf(join(dir, files[0]), repacked)

      // 3) 重启：严格读盘不认它，于是按「上一版」给出来，并排队后台重建
      const b = newNebula(root)
      const t0 = Date.now()
      await b.refresh()
      const took = Date.now() - t0
      assert.equal(b.lastRefresh.why, 'stale-cache', '旧算法的缓存不能当成「就是它」')
      assert.equal(b.staleGraph, true)
      assert.equal(b.lastCache.implStale, true, '要能说清「这是别的算法算的」')
      assert.equal(b.graph.builtAt, builtAt, '给出来的确实是上一份')
      assert.ok(took < 4000, '先把旧图给出来，不该等重建（实际 ' + took + 'ms）')

      // 4) 后台建完：新算法写进新缓存
      const deadline = Date.now() + 20000
      while (b.building || b.staleGraph) {
        if (Date.now() > deadline) throw new Error('后台重建超时')
        await new Promise((r) => setTimeout(r, 40))
      }
      await b.cacheWriteDone()
      assert.equal(b.staleGraph, false)
      assert.equal(b.lastRefresh.why, 'rebuilt')
      closeStore()

      // 5) 再起一台：这次的缓存是新算法建的，严格路径就该命中了
      const c = newNebula(root)
      await c.refresh()
      assert.equal(c.lastRefresh.why, 'cached', '新算法的缓存应该被当成正确答案')
      assert.equal(c.lastCache.implStale, false)
      assert.equal(c.signature, sig)
      closeStore()
    })
  } finally {
    safeRm(root)
  }
})
