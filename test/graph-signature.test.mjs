/**
 * 建图指纹（IMPL_FILES）：决定「插件升级后旧图缓存还算不算数」。
 *
 * 缓存只看来源签名（库的大小与时间戳）。适配器决定节点字段（比如 frontmatter
 * 认不认 created_at），它也变了就意味着「同样的库会长出不同的图」，必须算进指纹；
 * 否则库文件没动过的用户会一直命中旧图，修复对他们等于没生效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IMPL_FILES, implFingerprint } from '../lib/host/graphcache.js'

test('notes 适配器被纳入建图指纹', () => {
  assert.ok(
    IMPL_FILES.includes('adapters/notes.js'),
    '适配器改了字段映射，指纹就得变，否则旧图永远不会重建',
  )
})

test('指纹清单里的每个文件都真的存在（拼错会静默退化成 unknown）', () => {
  for (const name of IMPL_FILES) {
    const url = new URL('../lib/host/' + name, import.meta.url)
    assert.doesNotThrow(() => readFileSync(url), `指纹清单里的 ${name} 读不到`)
  }
  assert.match(implFingerprint(), /^[0-9a-f]{16}$/)
})
