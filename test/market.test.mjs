import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const json = (p) => JSON.parse(read(p))
const exists = (p) => fs.existsSync(path.join(ROOT, p))

test('market index declares this package at its current version', () => {
  const pkg = json('package.json')
  const index = json('market/index.json')
  assert.equal(index.format, 1)
  assert.equal(typeof index.title.en, 'string')
  assert.equal(index.plugins.length, 1)
  const plugin = index.plugins[0]
  assert.equal(plugin.name, pkg.name)
  assert.equal(plugin.versions.length, 1)
  assert.equal(plugin.versions[0].version, pkg.version)
  assert.equal(plugin.versions[0].source.type, 'npm')
  assert.equal(plugin.metadata.category, 'memory')
  assert.ok(plugin.metadata.labels.includes('local-first'))
})

test('market icon and localized detail documents exist', () => {
  const index = json('market/index.json')
  const icon = index.plugins[0].icon
  assert.equal(icon, 'assets/icon.svg')
  assert.ok(exists(path.join('market', icon)))
  for (const language of ['en', 'zh']) {
    const locale = json(`locale/${language}.json`)
    assert.equal(typeof locale.meta.title, 'string')
    assert.equal(typeof locale.meta.description, 'string')
    assert.match(locale.meta.detail, /^docs\/market\.(en|zh)\.md$/)
    assert.ok(exists(locale.meta.detail), `${locale.meta.detail} should exist`)
  }
  const pkg = json('package.json')
  assert.ok(read('docs/market.zh.md').includes(`dsh-memory-nebula@${pkg.version}`))
  assert.ok(read('docs/market.en.md').includes(`dsh-memory-nebula@${pkg.version}`))
  assert.ok(read('docs/market.zh.md').includes('https://unpkg.com/'))
  assert.ok(read('docs/market.en.md').includes('https://unpkg.com/'))
})

test('market detail images resolve next to the document', () => {
  for (const file of ['docs/market.zh.md', 'docs/market.en.md']) {
    const text = read(file)
    const refs = [...text.matchAll(/!\[[^\]]*\]\((assets\/[^)]+)\)/g)].map((m) => m[1])
    assert.ok(refs.length >= 4, `${file} should reference screenshots`)
    for (const ref of refs) {
      assert.ok(exists(path.join('docs', ref)), `${ref} referenced by ${file} should exist`)
    }
  }
})
