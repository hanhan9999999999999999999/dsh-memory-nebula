// 结构门：当前时态的文档不许写死「全套件条数」与「大约几秒」。
// 理由不是洁癖：1.11.70 之前 README 写「126 项单测」、release.md 写「约 90 秒」，
// 而当时真实数字是 499 项 / 176 秒——数字一旦抄进文档，每加 5 个测试就变成谎话。
// 允许的写法：让脚本自己打印条数（smoke 结尾会打印），文档只描述「怎么跑、看什么」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(PKG, rel), 'utf8')

// release.md 上半是「现在怎么做」，从第一个 `## x.y.z 实测` 往下是历史账本，
// 历史账本里的 63 项 / 126 单测 是当时的真实记录，必须原样留着。
const livePartOfRelease = (text) => {
  const lines = text.split('\n')
  const cut = lines.findIndex((l) => /^## \d+\.\d+\.\d+ 实测/.test(l))
  return (cut === -1 ? lines : lines.slice(0, cut)).join('\n')
}

const FILES = () => [
  ['README.md', read('README.md')],
  ['README.en.md', read('README.en.md')],
  ['docs/testing.md', read('docs/testing.md')],
  ['docs/accessibility.md', read('docs/accessibility.md')],
  ['docs/release.md', livePartOfRelease(read('docs/release.md'))],
]

// 会腐烂的写法：写死一整套的数量、写死「约 N 秒」。
// 单个文件自己的条数（如「nav 的 10 项几何」）不在此列——它跟着那个文件走，不会因为别处加测试而变。
const ROTTING = [
  [/全量\s*\d+\s*项/, '「全量 N 项」'],
  [/\d+\s*项(单元测试|单测|接口契约|冒烟|安全探针|契约|smoke)/, '「N 项单测/冒烟/安全探针」'],
  [/\d+\s+(unit tests|unit assertions|contract assertions|smoke checks|security probes|read-only contract checks)/,
    '「N unit tests / smoke checks」'],
  [/约\s*\d+\s*秒/, '「约 N 秒」'],
  [/约\s*\d+\s*分钟/, '「约 N 分钟」'],
]

test('当前时态文档里没有会腐烂的成套条数', () => {
  const bad = []
  for (const [name, text] of FILES()) {
    text.split('\n').forEach((line, i) => {
      for (const [re, why] of ROTTING) {
        if (re.test(line)) bad.push(`${name}:${i + 1} ${why} → ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(bad, [], '把条数交给脚本打印，文档只写怎么跑：\n' + bad.join('\n'))
})

test('历史账本没有被这道门改坏', () => {
  const release = read('docs/release.md')
  const live = livePartOfRelease(release)
  assert.ok(release.length > live.length, 'release.md 应当还有 `## x.y.z 实测` 之后的历史段落')
  assert.match(release, /^## \d+\.\d+\.\d+ 实测/m)
})

test('smoke 自己报条数', () => {
  const smoke = read('scripts/smoke.mjs')
  assert.match(smoke, /let passed = 0/)
  assert.match(smoke, /passed\+\+/)
  assert.ok(smoke.includes('全部通过（${passed} 项）'), '通过时要打印「全部通过（N 项）」')
  assert.ok(smoke.includes('失败 ${fails} 项 / 共 ${passed + fails} 项'), '失败时要连总数一起打印')
})

test('文档把「条数从哪看」说清楚了', () => {
  assert.ok(read('docs/testing.md').includes('全部通过（N 项）'))
  assert.ok(read('README.md').includes('结尾打印条数') || read('README.md').includes('自己打印'))
  assert.ok(read('README.en.md').includes('prints its own count'))
})
