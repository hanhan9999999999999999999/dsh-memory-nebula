/**
 * 回归：ETag 里不能出现非 ASCII。
 *
 * 起因是一个真事故（探针抓的，不是单测抓的）：来源标题里有中文时，
 * /graph 的 ETag 带着中文进 setHeader → Node 抛 ERR_INVALID_CHAR →
 * 响应永远发不出去，页面就一直转圈（客户端只看到超时）。
 *
 * 这里锁三件事：
 *   1. 签名里带中文时 /graph 照样 200，且 etag 是纯 ASCII；
 *   2. 同一个中文签名两次请求拿到同一个 etag（弱缓存仍然有效）；
 *   3. If-None-Match 命中时回 304——换成哈希之后 304 这条路没坏。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { Nebula } from '../lib/host/nebula.js'
import { registerRoutes, PREFIX } from '../lib/host/http.js'

const ASCII = /^[\x20-\x7e]*$/

/** 假的 res：像 Node 一样，非 ASCII 头值直接抛（这正是我们要防的那一下）。 */
function makeRes() {
  const headers = {}
  const chunks = []
  const res = {
    statusCode: 0,
    headersSent: false,
    headers,
    body: '',
    setHeader(name, value) {
      if (!ASCII.test(String(value))) throw new TypeError('Invalid character in header content ["' + name + '"]')
      headers[String(name).toLowerCase()] = String(value)
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()]
    },
    writeHead(code, extra) {
      if (extra) for (const k of Object.keys(extra)) this.setHeader(k, extra[k])
      this.statusCode = code
      this.headersSent = true
      return this
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk))
      res.body = Buffer.concat(chunks).toString('utf8')
    },
    on() {},
    once() {},
    emit() {},
    destroy() {},
  }
  return res
}

async function call(handler, path, headers = {}) {
  const req = { method: 'GET', url: PREFIX + path, headers: { host: '127.0.0.1', ...headers } }
  const res = makeRes()
  await handler(req, res)
  return res
}

function makeNebula() {
  const nb = new Nebula({ demo: true, log: () => {}, prewarmDelayMs: 1e7, hygieneWarm: false })
  let handler = null
  registerRoutes({ register: (def) => { handler = def.handler } }, nb, () => {}, { mode: 'standalone' })
  return { nb, handler }
}

test('签名里有中文，/graph 照样 200，etag 是纯 ASCII', async () => {
  const { nb, handler } = makeNebula()
  await nb.refresh()
  nb.signature = 'sqlite:外部记忆库|ws:日记|会话:2026-11-15'

  const res = await call(handler, '/graph?limit=20')
  assert.equal(res.statusCode, 200, '非 ASCII 签名不该把响应卡死')
  const etag = res.headers.etag
  assert.ok(etag, '仍然要带 ETag（不然每次都得整包重传）')
  assert.ok(ASCII.test(etag), 'etag 必须是纯 ASCII：' + etag)
  assert.match(etag, /^W\/"[0-9a-f]+-/, '非 ASCII 签名被换成了十六进制摘要')
  const payload = JSON.parse(res.body)
  assert.equal(payload.sig, nb.signature, '载荷里的 sig 还是签名原文（这里不受头限制）')
})

test('同一个中文签名两次请求的 etag 相同；If-None-Match 命中回 304', async () => {
  const { nb, handler } = makeNebula()
  await nb.refresh()
  nb.signature = '工具:记忆星图|库:别人的'

  const first = await call(handler, '/graph')
  const second = await call(handler, '/graph')
  assert.equal(first.headers.etag, second.headers.etag, '签名没变，标签就不该变')

  const third = await call(handler, '/graph', { 'if-none-match': first.headers.etag })
  assert.equal(third.statusCode, 304, '命中弱缓存仍然要走 304')
  assert.equal(third.body, '')
})

test('分页参数进了 etag：整图和某一页不能互相 304', async () => {
  const { nb, handler } = makeNebula()
  await nb.refresh()
  nb.signature = '中文签名'

  const whole = await call(handler, '/graph')
  const page = await call(handler, '/graph?limit=5&offset=0')
  assert.notEqual(whole.headers.etag, page.headers.etag)
  assert.ok(ASCII.test(page.headers.etag))
})
