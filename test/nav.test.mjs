import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)
const navSrc = readFileSync(new URL('lib/web/nav.js', root), 'utf8')

/** 和浏览器里一样地加载：挂到 window.NebulaNav 上。 */
function boot() {
  const sandbox = { console, Math }
  sandbox.window = sandbox
  vm.runInNewContext(navSrc, sandbox)
  return sandbox.NebulaNav
}

/** vm 里造出来的数组原型不是本域的：比之前先翻译回本域数组。 */
const host = (arr) => Array.from(arr)

const pts = [
  { id: 'a', x: 0, y: 0 },
  { id: 'b', x: 40, y: 0 },
  { id: 'c', x: 400, y: 0 },
  { id: 'd', x: 0, y: 60 },
  { id: 'e', x: -30, y: 0 },
]

test('方向键：四个方向各挑各的，取最近那颗', () => {
  const nav = boot()
  assert.equal(nav.pick(pts, 'a', 'right'), 'b')
  assert.equal(nav.pick(pts, 'a', 'left'), 'e')
  assert.equal(nav.pick(pts, 'a', 'down'), 'd')
  assert.equal(nav.pick(pts, 'a', 'up'), null, '上面没有星星就不该乱跳')
})

test('方向键：偏太多的远处正前方，会输给近处略偏的那颗', () => {
  const nav = boot()
  const set = [
    { id: 'a', x: 0, y: 0 },
    { id: 'near', x: 10, y: 3 },
    { id: 'far', x: 40, y: 0 },
  ]
  assert.equal(nav.pick(set, 'a', 'right'), 'near')
})

test('方向键：斜到 58° 的星会让位给正前方较远的那颗', () => {
  const nav = boot()
  const set = [
    { id: 'a', x: 0, y: 0 },
    { id: 'diag', x: 50, y: 80 },
    { id: 'straight', x: 200, y: 0 },
  ]
  assert.equal(nav.pick(set, 'a', 'right'), 'straight')
})

test('方向键：没有当前点 / 方向不合法 / 坐标坏了都返回 null 或跳过坏点', () => {
  const nav = boot()
  assert.equal(nav.pick(pts, 'nope', 'right'), null)
  assert.equal(nav.pick(pts, 'a', 'northeast'), null)
  assert.equal(nav.pick(pts, 'a', ['x', 'y']), null)
  assert.equal(nav.pick(pts, 'a', [1]), null)
  const dirty = [...pts, { id: 'bad', x: NaN, y: 0 }, { id: 'bad2', x: 9 }]
  assert.equal(nav.pick(dirty, 'a', 'right'), 'b')
})

test('方向键：重合的点不会被选中（否则会在原地来回跳）', () => {
  const nav = boot()
  const set = [
    { id: 'a', x: 0, y: 0 },
    { id: 'same', x: 0, y: 0 },
  ]
  assert.equal(nav.pick(set, 'a', 'right'), null)
  assert.equal(nav.pick(set, 'a', 'down'), null)
})

test('方向键：代价打平时按 id 排，结果是确定的', () => {
  const nav = boot()
  const set = [
    { id: 'a', x: 0, y: 0 },
    { id: 'z', x: 50, y: 0 },
    { id: 'm', x: 50, y: 0 },
  ]
  assert.equal(nav.pick(set, 'a', 'right'), 'm')
})

test('nearest：最近的一颗；没有当前点时退回阅读顺序的第一颗', () => {
  const nav = boot()
  assert.equal(nav.nearest(pts, 'a'), 'e', 'e 在 (-30,0)，比 b(40,0) 更近')
  assert.equal(nav.nearest(pts, 'ghost'), 'e', '没有当前点：按 y 再 x 排，e(-30,0) 在最前')
  assert.equal(nav.nearest([], 'a'), null)
})

test('hub：连接最多的那颗；没有度数数据时退回点集的第一个', () => {
  const nav = boot()
  const degree = { a: 2, b: 9, c: 9, d: 1 }
  assert.equal(nav.hub(pts, degree), 'b', 'b 与 c 打平，按 id 取小')
  assert.equal(nav.hub(pts, new Map([['d', 7]])), 'd')
  assert.equal(nav.hub(pts, (id) => (id === 'c' ? 3 : 0)), 'c')
  assert.equal(nav.hub(pts), 'a', '没有度数时退回第一个，不挑三拣四')
  assert.equal(nav.hub([], null), null)
})

test('neighbors：双向都算，按强度从高到低，支持最小权重过滤', () => {
  const nav = boot()
  const edges = [
    { a: 'a', b: 'b', w: 0.3 },
    { a: 'a', b: 'c', w: 0.9 },
    { a: 'd', b: 'a', w: 0.6 },
    { a: 'x', b: 'y', w: 1 },
  ]
  assert.deepEqual(host(nav.neighbors(edges, 'a')).map((n) => n.id), ['c', 'd', 'b'])
  assert.deepEqual(host(nav.neighbors(edges, 'a', 0.5)).map((n) => n.id), ['c', 'd'])
  assert.deepEqual(host(nav.neighbors(edges, '')), [])
  assert.deepEqual(host(nav.neighbors(null, 'a')), [])
})

test('DIRS：四个方向向量是屏幕坐标（y 向下）', () => {
  const nav = boot()
  assert.deepEqual(host(nav.DIRS.up), [0, -1])
  assert.deepEqual(host(nav.DIRS.down), [0, 1])
  assert.deepEqual(host(nav.DIRS.left), [-1, 0])
  assert.deepEqual(host(nav.DIRS.right), [1, 0])
})
