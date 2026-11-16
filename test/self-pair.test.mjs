import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Nebula } from '../lib/host/nebula.js'
import { closeStore, listLinks, listMutes } from '../lib/host/store.js'
import { registerRoutes } from '../lib/host/http.js'

// 1.11.64 的两件事：
//   1) 一条记忆和自己配对——以前回 ok:true，库里多一行，图上什么都不发生；
//   2) /path 的跳数参数——文档写 maxHops，代码只认 hops，照文档调的调用方被静默当成 6 跳。
const HOST = '127.0.0.1:63312'
const P = '/api/memory-nebula'

// 一条链：链 0 — 链 1 — 链 2 — 链 3，相邻两条共用一个稀有词
const CHAIN = [
  ['链 0', ['alpha词', 'beta词']],
  ['链 1', ['beta词', 'gamma词']],
  ['链 2', ['gamma词', 'delta词']],
  ['链 3', ['delta词', 'epsilon词']],
]

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nebula-selfpair-'))
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
  CHAIN.forEach(([title, kws], i) => {
    ins.run('c' + i, title, title + '：' + kws.join(' ') + ' 的样本。', JSON.stringify(kws), 3, 'active', 'proj', now, now + i, 1)
  })
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
  const home = mkdtempSync(join(tmpdir(), 'nebula-selfpair-home-'))
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

function makeCaller(handler) {
  return async (url, opts = {}) => {
    const out = { status: 0, body: '' }
    const res = {
      statusCode: 0,
      setHeader() {},
      writeHead(code) {
        out.status = code
        res.statusCode = code
      },
      write(chunk) {
        if (chunk) out.body += chunk.toString()
      },
      end(chunk) {
        if (chunk) out.body += chunk.toString()
      },
      getHeader() {
        return undefined
      },
    }
    // 假 req：POST 时把 JSON 体按流的方式吐出去（jsonBody 走 req.on('data'/'end')）
    const payload = opts.json === undefined ? '' : JSON.stringify(opts.json)
    const listeners = new Map()
    const req = {
      method: opts.method || 'GET',
      url: url.startsWith(P) ? url : P + url,
      headers: { host: HOST, 'content-type': 'application/json' },
      on(event, cb) {
        listeners.set(event, cb)
        return req
      },
    }
    const run = handler(req, res, P)
    if (payload) {
      setImmediate(() => {
        listeners.get('data')?.(Buffer.from(payload, 'utf8'))
        listeners.get('end')?.()
      })
    } else if (opts.method === 'POST') {
      setImmediate(() => listeners.get('end')?.())
    }
    await run
    return { status: out.status, json: () => JSON.parse(out.body) }
  }
}

async function setup() {
  const root = makeRoot()
  const nb = new Nebula({ roots: [root], log: () => {}, prewarmDelayMs: 10 ** 7, hygieneWarm: false })
  await nb.refresh()
  let handler = null
  registerRoutes({ register: (def) => { handler = def.handler } }, nb, () => {}, { mode: 'standalone' })
  const idOf = (title) => {
    const node = nb.graph.nodes.find((n) => n.label === title)
    assert.ok(node, '夹具里没有 ' + title)
    return node.id
  }
  return { root, nb, call: makeCaller(handler), idOf }
}

test('一条记忆连自己：400，且库里不留记录', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const { nb, idOf } = await setup()
      const id = idOf('链 0')
      const before = listLinks().length
      assert.throws(
        () => nb.link(id, id, '自己连自己'),
        (err) => {
          assert.equal(err.status, 400)
          assert.match(err.message, /不能把一条记忆和它自己配成一对/)
          return true
        },
      )
      assert.equal(listLinks().length, before, '失败的连边不该在库里留一行')
    })
  } finally {
    safeRm(root)
  }
})

test('一条记忆屏蔽自己：400，且屏蔽表不多一行', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const { nb, idOf } = await setup()
      const id = idOf('链 1')
      const before = listMutes().length
      assert.throws(
        () => nb.mute(id, id),
        (err) => {
          assert.equal(err.status, 400)
          assert.match(err.message, /不能把一条记忆和它自己配成一对/)
          return true
        },
      )
      assert.equal(listMutes().length, before)
    })
  } finally {
    safeRm(root)
  }
})

test('HTTP：POST /link 自己连自己回 400，而不是 ok:true', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const { call, idOf } = await setup()
      const id = idOf('链 2')
      const r = await call('/link', {
        method: 'POST',
        json: { a: id, b: id, note: '自己连自己' },
      })
      assert.equal(r.status, 400)
      assert.match(r.json().error, /不能把一条记忆和它自己配成一对/)
    })
  } finally {
    safeRm(root)
  }
})

test('/path 认文档里的 maxHops：跳数真的按它算', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const { call, idOf } = await setup()
      const a = idOf('链 0')
      const b = idOf('链 3')
      const near = await call(`/path?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&maxHops=1`)
      assert.equal(near.status, 200)
      assert.equal(near.json().found, false, '一跳之内到不了链 3')

      const far = await call(`/path?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&maxHops=8`)
      assert.equal(far.status, 200)
      const body = far.json()
      assert.equal(body.found, true, '八跳之内该到得了')
      assert.equal(body.hops, 3, '链 0 → 链 3 正好三跳')
    })
  } finally {
    safeRm(root)
  }
})

test('/path 的老名字 hops 还能用，写错一样报错', async () => {
  const root = makeRoot()
  try {
    await withHome(async () => {
      const { call, idOf } = await setup()
      const a = idOf('链 0')
      const b = idOf('链 3')

      const legacy = await call(`/path?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&hops=8`)
      assert.equal(legacy.status, 200)
      assert.equal(legacy.json().found, true, '老名字 hops 不该失效')

      const badDoc = await call(`/path?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&maxHops=abc`)
      assert.equal(badDoc.status, 400, '照文档写错参数要报错')
      assert.match(badDoc.json().error, /maxHops 需要 1–8 的整数/)

      const badLegacy = await call(`/path?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&hops=abc`)
      assert.equal(badLegacy.status, 400)
      assert.match(badLegacy.json().error, /hops 需要 1–8 的整数/)
    })
  } finally {
    safeRm(root)
  }
})
