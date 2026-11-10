import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const i18nSrc = read('lib/web/i18n.js')
const EN_SRC = i18nSrc.slice(i18nSrc.indexOf('const EN = {'), i18nSrc.indexOf('\n  }', i18nSrc.indexOf('const EN = {')))

function decode(s) {
  return JSON.parse('"' + s.replace(/"/g, '\\"') + '"')
}
const keys = new Set()
for (const m of EN_SRC.matchAll(/^\s{4}"([^"]+)":/gm)) keys.add(decode(m[1]))

function boot(search = '?lang=en', language = 'en-US') {
  const toggles = []
  const doc = {
    readyState: 'complete',
    title: '',
    documentElement: { lang: '', classList: { toggle: (name, on) => toggles.push([name, on]) } },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  }
  const store = new Map()
  const window = {
    location: { search, reload() { this.reloaded = (this.reloaded || 0) + 1 } },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    navigator: { language },
    document: doc,
  }
  window.window = window
  const sandbox = { window, document: doc, navigator: window.navigator, localStorage: window.localStorage, location: window.location, console, URLSearchParams }
  vm.runInNewContext(i18nSrc, sandbox)
  return { i18n: window.NebulaI18n, toggles, store, doc, location: window.location }
}

test('字典：键与值都非空，且没有重复键', () => {
  assert.ok(keys.size > 350, `expected >350 keys, got ${keys.size}`)
  assert.equal(EN_SRC.match(/^\s{4}"([^"]+)":/gm).length, keys.size)
  for (const k of keys) assert.ok(k.trim(), 'empty key')
})

test('英文模式：t 查表、插值、未收录回退中文', () => {
  const { i18n } = boot()
  assert.equal(i18n.lang, 'en')
  assert.equal(i18n.t('记忆'), 'Memories')
  assert.equal(i18n.t('共 {n} 条', { n: 2 }), '共 2 条')
  assert.equal(i18n.t('这个词还没有翻译'), '这个词还没有翻译')
})

test('中文模式：查询参数优先，原样返回', () => {
  const { i18n } = boot('?lang=zh', 'en-US')
  assert.equal(i18n.lang, 'zh')
  assert.equal(i18n.t('记忆'), '记忆')
})

test('语言来源：没有 query 时读 localStorage，再退到 navigator', () => {
  const a = boot('', 'en-US')
  assert.equal(a.i18n.lang, 'en')
  const b = boot('', 'zh-CN')
  assert.equal(b.i18n.lang, 'zh')
})

test('applyDom：设置 html.lang 与 lang-en 类', () => {
  const { i18n, toggles } = boot()
  i18n.applyDom()
  assert.equal(toggles.at(-1)[0], 'lang-en')
  assert.equal(toggles.at(-1)[1], true)
})

test('所有 T(...) 与静态 data-zh 都在字典里', () => {
  const files = ['lib/web/app.js', 'lib/web/api.js', 'lib/web/render.js', 'lib/web/space3d.js']
  const missing = new Set()
  for (const f of files) {
    const src = read(f)
    let at = 0
    while ((at = src.indexOf("T('", at)) >= 0) {
      at += 3
      const end = src.indexOf("'", at)
      if (end < 0) break
      const key = decode(src.slice(at, end))
      if (!keys.has(key)) missing.add(key)
      at = end + 1
    }
  }
  const html = read('lib/web/index.html')
  for (const m of html.matchAll(/data-zh(?:-title|-ph|-aria)?="([^"]*)"/g)) {
    const key = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    if (!keys.has(key)) missing.add(key)
  }
  assert.deepEqual([...missing], [])
})

test('toggle：写 localStorage 并 reload', () => {
  const b = boot()
  b.i18n.toggle()
  assert.equal(b.store.get('nebula.lang'), 'zh')
  assert.equal(b.location.reloaded, 1)
})
