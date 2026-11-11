import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('package.json：身份与发布字段', () => {
  assert.equal(pkg.name, 'dsh-memory-nebula')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(pkg.dsh?.bundle?.patch)
  assert.ok(pkg.dsh?.client?.platform === 'web')
  assert.ok(pkg.engines?.node)
  assert.equal(pkg.dependencies, undefined, '运行时零依赖：不能把自己列进 dependencies')
})

test('package.json：files 覆盖运行所需，不夹带测试与临时文件', () => {
  for (const p of ['lib', 'docs', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', 'cordis.patch.yml', 'scripts']) {
    assert.ok(pkg.files.includes(p), p)
  }
  assert.equal(pkg.files.includes('test'), false)
  assert.ok(!pkg.files.some((p) => /dev|\.edge|screenshot/i.test(p)))
})

test('清单里没有指向不存在文件的导出', () => {
  for (const p of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'scripts/smoke.mjs', 'README.md', 'README.en.md']) {
    assert.ok(existsSync(join(ROOT, p)), p)
  }
})

test('死文件不再进包：graph.debug.js / hygiene.js', () => {
  assert.equal(existsSync(join(ROOT, 'lib/host/graph.debug.js')), false)
  assert.equal(existsSync(join(ROOT, 'lib/host/hygiene.js')), false)
})

test('CHANGELOG 顶部版本与 package.json 一致', () => {
  const m = read('CHANGELOG.md').match(/^## (\d+\.\d+\.\d+)/m)
  assert.ok(m, 'CHANGELOG 要有版本标题')
  assert.equal(m[1], pkg.version)
})

test('Cordis patch 指向本包', () => {
  const yml = read('cordis.patch.yml')
  assert.ok(yml.includes('memory-nebula'))
  assert.ok(yml.includes(pkg.name))
})

test('lib 内的相对 import 都能解析', () => {
  const files = []
  const scan = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) scan(p)
      else if (/\.m?js$/.test(name)) files.push(p)
    }
  }
  scan(join(ROOT, 'lib'))
  const bad = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(f), m[1])
      if (!existsSync(target)) bad.push(`${f.replace(ROOT + '\\', '')} → ${m[1]}`)
    }
  }
  assert.deepEqual(bad, [])
})
