/**
 * 1.11.5：导快照不该顺手把体检算两遍。
 *
 * 事故形状：`overview({ hygiene: false })` 只把 hygiene 字段置空，可是同一份返回里的
 * `cards()` 内部又调了一次 `this.hygiene()` —— 5 万条的库上这一步要 7 秒，
 * 于是「不算体检」成了一句空话，冷启动的 /share 把整个宿主按住。
 * 这里盯三件事：不再算、切片里体检仍然是真的、异步壳与同步壳结果一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Nebula } from '../lib/host/nebula.js'
import { sliceShareGraph, sliceShareGraphAsync } from '../lib/host/share.js'

let cached = null
async function demoNebula() {
  if (!cached) {
    cached = new Nebula({ demo: true, log: () => {} })
    await cached.refresh()
  }
  return cached
}

test('overview({hygiene:false}) 真的不算体检：hygiene 与 cards 都为空', async () => {
  const nebula = await demoNebula()
  // 先把缓存清掉，逼它「如果要算就得真算」
  nebula._hygiene = null
  nebula._cards = null
  let calls = 0
  const real = nebula.hygiene.bind(nebula)
  nebula.hygiene = () => {
    calls++
    return real()
  }
  const ov = nebula.overview({ hygiene: false })
  nebula.hygiene = real
  assert.equal(ov.hygiene, null)
  assert.equal(ov.cards, null)
  assert.equal(calls, 0, '不该顺手把体检算出来（实测调用了 ' + calls + ' 次）')
})

test('切片快照里体检仍然是真的，只是由壳算完再填', async () => {
  const nebula = await demoNebula()
  const payload = sliceShareGraph(nebula, null, { limit: 5000 })
  assert.ok(payload.overview.hygiene, '切片必须带体检，不能因为「不算」就丢给用户一个空面板')
  assert.equal(typeof payload.overview.hygiene.total, 'number')
  assert.equal(payload.overview.cards, null, '切片里本来就不带整库视角的 cards')
  assert.ok(payload.scope && payload.scope.kind === 'all')
})

test('异步壳与同步壳给出同一份切片', async () => {
  const nebula = await demoNebula()
  const sync = sliceShareGraph(nebula, null, { limit: 5000 })
  const async_ = await sliceShareGraphAsync(nebula, null, { limit: 5000 })
  assert.equal(async_.graph.nodes.length, sync.graph.nodes.length)
  assert.equal(async_.graph.edges.length, sync.graph.edges.length)
  assert.deepEqual(async_.overview.hygiene.counts, sync.overview.hygiene.counts)
})
