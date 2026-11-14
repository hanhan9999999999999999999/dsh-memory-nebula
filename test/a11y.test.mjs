import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

const html = read('lib/web/index.html')
const app = read('lib/web/app.js')
const css = read('lib/web/style.css')
const render2d = read('lib/web/render.js')
const space3d = read('lib/web/space3d.js')

/** 取出某个 id 元素的开始标签，省得用正则去猜整棵 DOM。 */
function tagOf(id) {
  const at = html.indexOf('id="' + id + '"')
  if (at < 0) return ''
  const start = html.lastIndexOf('<', at)
  const end = html.indexOf('>', at)
  return html.slice(start, end + 1)
}

test('键盘入口：存在一个可聚焦的星图层，并说明它管什么', () => {
  const layer = tagOf('skykeys')
  assert.match(layer, /tabindex="0"/, '#skykeys 必须能被 Tab 聚焦')
  assert.match(layer, /role="application"/, '方向键要被星图接管，不能留给浏览器的滚动')
  assert.match(layer, /aria-describedby="kb-help"/, '读屏需要听到键位说明')
  assert.match(layer, /aria-label="[^"]+"/, '没有可见文字的元素必须有 aria-label')
  assert.ok(html.includes('id="kb-help"'), '键位说明的锚点必须存在')
})

test('键位说明写清楚了全部按键，且与实现一致', () => {
  const help = html.slice(html.indexOf('id="kb-help"'), html.indexOf('</p>', html.indexOf('id="kb-help"')))
  for (const word of ['方向键', '回车', '[', ']', '缩放', '0', 'Esc']) {
    assert.ok(help.includes(word), `说明里缺「${word}」`)
  }
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Home']) {
    assert.ok(app.includes(`case '${key}'`), `app.js 没有处理 ${key}`)
  }
})

test('播报区：aria-live 存在，且是 polite + atomic', () => {
  const live = tagOf('a11y-live')
  assert.match(live, /aria-live="polite"/)
  assert.match(live, /aria-atomic="true"/)
  assert.match(live, /role="status"/)
  assert.ok(app.includes("$('#a11y-live')"), 'app.js 要把走位结果写进播报区')
})

test('纯文本索引：摘要与列表都在，且索引随图重建', () => {
  assert.ok(tagOf('a11y-summary').includes('sr-only'))
  assert.ok(tagOf('a11y-index').includes('sr-only'))
  assert.match(tagOf('a11y-index'), /aria-label="[^"]+"/)
  assert.ok(app.includes('function renderA11yIndex'), '缺 renderA11yIndex')
  const body = app.slice(app.indexOf('function applyGraph'))
  assert.ok(body.includes('renderA11yIndex(g)'), '换图之后要重算索引')
})

test('画布保持 aria-hidden，且不再往它身上挂死代码', () => {
  assert.match(tagOf('sky'), /aria-hidden="true"/)
  assert.match(tagOf('sky3d'), /aria-hidden="true"/)
  // 在 aria-hidden 的节点上设 role/aria-label，读屏根本不会念——这是修掉过的坑
  assert.ok(!/setAttribute\('role',\s*'img'\)/.test(app), '不要回到 aria-hidden + role=img 的死代码')
  assert.ok(!/aria-hidden="true"[^>]*role="img"/.test(html))
})

test('.sr-only 用的是「视觉隐藏但仍在无障碍树里」的写法', () => {
  const at = css.indexOf('.sr-only')
  assert.ok(at > 0, 'style.css 缺 .sr-only')
  const block = css.slice(at, css.indexOf('}', at))
  assert.match(block, /position:\s*absolute/)
  assert.match(block, /clip-path:\s*inset\(50%\)/)
  assert.ok(!/display:\s*none/.test(block), 'display:none 会把内容从读屏里一起摘掉')
  assert.ok(!/visibility:\s*hidden/.test(block))
})

test('键盘层不吃鼠标：点画布照旧能拖动，点下去才把焦点递进来', () => {
  const at = css.indexOf('#skykeys')
  const block = css.slice(at, css.indexOf('}', at))
  assert.match(block, /pointer-events:\s*none/)
  assert.ok(app.includes("layer.focus({ preventScroll: true })"), '点画布要把焦点递给键盘层')
})

test('两个渲染器都提供 zoomBy 与 centerOn，键盘不会只在 2D 能用', () => {
  assert.ok(render2d.includes('api.zoomBy'), '2D 缺 zoomBy')
  assert.ok(render2d.includes('api.centerOn'), '2D 缺 centerOn')
  assert.ok(/zoomBy\(factor\)/.test(space3d), '3D 缺 zoomBy')
  assert.ok(/centerOn\(id\)/.test(space3d), '3D 缺 centerOn')
  // 限位必须和滚轮一致，否则键盘能把视图推进滚轮到不了的死角
  assert.ok(render2d.includes('Math.min(5.5, Math.max(0.18'))
  assert.ok(space3d.includes('clamp(state.cam.dist / f, 180, 9000)'))
})

test('导航几何单独成文件、先于 app.js 加载，且不碰 DOM', () => {
  assert.ok(html.indexOf('src="nav.js"') > 0)
  assert.ok(html.indexOf('src="nav.js"') < html.indexOf('src="app.js"'), 'nav.js 要先加载')
  const nav = read('lib/web/nav.js')
  assert.ok(!/document\.|window\.document/.test(nav), 'nav.js 只算几何，别掺 DOM')
  assert.ok(app.includes('window.NebulaNav'), 'app.js 要用这套几何')
})

test('跳过链接：第一个 Tab 能直接进星图，不用逐个穿过工具栏', () => {
  const at = html.indexOf('class="skip-link"')
  assert.ok(at > 0, '缺跳过链接')
  const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1)
  assert.match(tag, /href="#skykeys"/, '跳过链接要指向星图层')
  assert.ok(html.indexOf('class="skip-link"') < html.indexOf('id="stage"'), '跳过链接要是正文里的第一个可聚焦元素')
  assert.ok(css.includes('.skip-link'), 'style.css 要有跳过链接的样式')
  assert.ok(/\.skip-link:focus/.test(css), '聚焦时必须有可见样式，否则等于没加')
})

test('地标与控件命名：main 包裹舞台，滑杆与站点横向截图条都能被读屏认出', () => {
  assert.ok(html.includes('<main id="app">'), '星图页要有 main 地标')
  assert.ok(html.indexOf('</main>') > html.indexOf('id="stage"'), 'main 要包住整个舞台')
  for (const zh of ['最小连接强度', '最低重要度']) {
    assert.ok(app.includes(`setAttribute('data-zh-aria', '${zh}')`), `滑杆「${zh}」要有可翻译的 aria 标签`)
    assert.ok(app.includes(`setAttribute('aria-label', T('${zh}'))`), `滑杆「${zh}」要立刻写 aria-label`)
  }
  const site = read('docs/index.html')
  assert.match(site, /--faint:#8a94a6/, '站点的弱文字要过 4.5:1 对比度')
  assert.match(site, /class="shots reveal" role="region" tabindex="0"/, '横向截图条必须能键盘聚焦滚动')
})
