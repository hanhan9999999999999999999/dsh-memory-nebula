// 1.11.66：默认扫描根目录不许写死盘符，隔离了 DSH_HOME 就得真的隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultRoots, detect } from '../lib/host/adapters/meow.js'
import * as util from '../lib/host/adapters/util.js'
import * as sources from '../lib/host/sources.js'

/** 造一个隔离沙箱，跑完删干净。 */
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'nebula-roots-'))
  const home = join(base, 'home')
  const user = join(base, 'user')
  mkdirSync(home, { recursive: true })
  mkdirSync(user, { recursive: true })
  // 家目录在 Windows 上读 USERPROFILE、在 Linux/macOS 上读 HOME。
  // 只改 USERPROFILE 的话，CI 的 ubuntu 那一半仍然会去翻真实家目录——1.11.66 第一次
  // 推送就是这么红的：本机绿、ubuntu 红，测试本身没跨平台。
  const KEYS = ['DSH_HOME', 'USERPROFILE', 'HOME', 'NEBULA_DEFAULT_ROOTS']
  const saved = {}
  for (const key of KEYS) saved[key] = process.env[key]
  process.env.DSH_HOME = home
  process.env.USERPROFILE = user
  process.env.HOME = user
  delete process.env.NEBULA_DEFAULT_ROOTS
  return {
    base,
    home,
    user,
    done() {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      try {
        rmSync(base, { recursive: true, force: true, maxRetries: 8 })
      } catch {
        /* 临时目录清不掉不影响结论 */
      }
    },
  }
}

test('隔离了 DSH_HOME：只认家目录推出来的那几处，不碰 D:\\document', () => {
  const box = sandbox()
  try {
    const sibling = join(box.base, 'document')
    mkdirSync(sibling, { recursive: true })
    const roots = defaultRoots()
    assert.deepEqual(roots, [sibling], '只应有 DSH_HOME 的兄弟目录 document')
    assert.ok(!roots.some((r) => /^[A-Za-z]:[\\/]document$/i.test(r)), '不许出现写死的盘符根目录')
    assert.ok(!roots.some((r) => r.toLowerCase().includes('users\\administrator')), '不许写死 C 盘用户目录')
  } finally {
    box.done()
  }
})

test('家目录下的 Documents 也认，DSH_HOME 的兄弟目录排在前', () => {
  const box = sandbox()
  try {
    const sibling = join(box.base, 'document')
    const docs = join(box.user, 'Documents')
    mkdirSync(sibling, { recursive: true })
    mkdirSync(docs, { recursive: true })
    const roots = defaultRoots()
    assert.deepEqual(roots, [sibling, docs])
  } finally {
    box.done()
  }
})

test('NEBULA_DEFAULT_ROOTS 能多指几处：分号逗号都行，重复与尾斜杠要去掉', () => {
  const box = sandbox()
  try {
    const sibling = join(box.base, 'document')
    const extraA = join(box.base, 'extraA')
    const extraB = join(box.base, 'extraB')
    for (const dir of [sibling, extraA, extraB]) mkdirSync(dir, { recursive: true })
    process.env.NEBULA_DEFAULT_ROOTS = `${extraB};${extraA},${extraB}/`
    const roots = defaultRoots()
    assert.deepEqual(roots, [extraB, extraA, sibling], '外部指定的排最前，重复只留一次')
    assert.ok(!roots.includes(`${extraB}/`), '尾斜杠要去掉')
  } finally {
    box.done()
  }
})

test('detect() 在隔离环境里只扫到我们造的库，扫不到本机真实工作区', () => {
  const box = sandbox()
  try {
    const sibling = join(box.base, 'document')
    const ws = join(sibling, 'ws-a')
    mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
    writeFileSync(join(ws, '.dsh-meow', 'memory.db'), '', 'utf8')
    const stores = detect({})
    assert.equal(stores.length, 1, '只应扫到沙箱里那一个库')
    assert.equal(stores[0].path, ws)
    assert.equal(stores[0].via, 'scan')
    assert.ok(!stores.some((s) => /Memory Universe|Live2D|Stellaris|数学网站/.test(String(s.title))), '不许带出本机真实工作区')
  } finally {
    box.done()
  }
})

test('DSH 家目录只有一个定义：sources.js 转出去的与 adapters/util.js 是同一个', () => {
  assert.equal(sources.dshHome, util.dshHome)
  const box = sandbox()
  try {
    assert.equal(sources.dshHome(), box.home)
    assert.equal(util.dshHome(), box.home)
    assert.ok(existsSync(box.home))
  } finally {
    box.done()
  }
})
