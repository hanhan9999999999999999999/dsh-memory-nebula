/**
 * 1.11.0：快照校验和（sha256）。
 *
 * 单文件快照会被聊天软件改写、被网盘截断、被编辑器重存成别的编码；坏文件照样能渲染出
 * 半张星图，看着像「记忆变少了」。导出时对数据那段**原始文本**算 sha256，页面启动时
 * 逐字节比对。这里盯四件事：摘要算得对、文本可解析、篡改会被发现、旧快照不误报。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Nebula } from '../lib/host/nebula.js'
import { buildShareHtml } from '../lib/host/share.js'

let cached = null
async function demoNebula() {
  if (!cached) {
    cached = new Nebula({ demo: true, log: () => {} })
    await cached.refresh()
  }
  return cached
}

const DATA_RE = /<script type="application\/json" id="nebula-snapshot-data">([\s\S]*?)<\/script>/
const META_RE = /window\.__NEBULA_SNAPSHOT_INTEGRITY__ = \{ algo: "sha256", bytes: (\d+), sha256: "([0-9a-f]{64})" \}/

function extract(html) {
  const data = html.match(DATA_RE)
  const meta = html.match(META_RE)
  assert.ok(data, '快照里必须有 nebula-snapshot-data 数据块')
  assert.ok(meta, '快照里必须有 __NEBULA_SNAPSHOT_INTEGRITY__')
  return { text: data[1], bytes: Number(meta[1]), sha: meta[2] }
}

test('快照校验和：摘要与数据文本一致，bytes 按 UTF-8 算', async () => {
  const n = await demoNebula()
  const { html } = await buildShareHtml(n, { version: '1.11.0', build: 1 }, {})
  const { text, bytes, sha } = extract(html)
  const want = createHash('sha256').update(text, 'utf8').digest('hex')
  assert.equal(sha, want)
  assert.equal(bytes, Buffer.byteLength(text, 'utf8'))
})

test('快照校验和：数据文本能被 JSON.parse，且就是那份快照载荷', async () => {
  const n = await demoNebula()
  const { html } = await buildShareHtml(n, { version: '1.11.0', build: 1 }, { limit: 12 })
  const { text } = extract(html)
  const payload = JSON.parse(text)
  assert.equal(payload.graph.nodes.length, 12)
  assert.equal(payload.scope.trimmed.cap, 12)
  assert.ok(!text.includes('</script'), '数据文本不能提前闭合 script')
})

test('快照校验和：改动一个字节会算不出一致的摘要（客户端能发现）', async () => {
  const n = await demoNebula()
  const { html } = await buildShareHtml(n, { version: '1.11.0', build: 1 }, {})
  const { text, sha } = extract(html)
  // 把标题里的一个字改掉，模拟聊天软件/编辑器「顺手修正」
  const tampered = text.replace('星图', '星国')
  assert.notEqual(tampered, text, '夹具里应当出现「星图」两个字')
  const got = createHash('sha256').update(tampered, 'utf8').digest('hex')
  assert.notEqual(got, sha)
})

test('快照校验和：截断的数据长度对不上，且 JSON 解析失败', async () => {
  const n = await demoNebula()
  const { html } = await buildShareHtml(n, { version: '1.11.0', build: 1 }, {})
  const { text, bytes } = extract(html)
  const cut = text.slice(0, Math.floor(text.length / 2))
  assert.ok(Buffer.byteLength(cut, 'utf8') !== bytes)
  assert.throws(() => JSON.parse(cut), SyntaxError)
})

test('快照校验和：客户端启动脚本先取原始文本再解析，坏数据不会抛到全局', async () => {
  const n = await demoNebula()
  const { html } = await buildShareHtml(n, { version: '1.11.0', build: 1 }, {})
  assert.match(html, /window\.__NEBULA_SNAPSHOT_DATA_TEXT__ = document\.getElementById\("nebula-snapshot-data"\)\.textContent/)
  assert.match(html, /catch \(err\) \{ window\.__NEBULA_SNAPSHOT__ = null; window\.__NEBULA_SNAPSHOT_BROKEN__/)
})
