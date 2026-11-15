/**
 * sources.js 的单测：发现层（工作区注册表 / 记忆库发现）与记录者层（会话账本 / 插件技能 MCP）。
 * 这一层原来是 54%，几乎全靠端到端探针间接覆盖；这里把每条分支钉住。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'nebula-sources-'))
process.env.DSH_HOME = HOME

const { discoverStores, readInventory, readSessionLedgers, readWorkspaceRegistry, workspaceKey } = await import(
  '../lib/host/sources.js'
)

const mk = (p) => mkdirSync(p, { recursive: true })
const put = (p, text) => {
  mk(join(p, '..'))
  writeFileSync(p, text, 'utf8')
}

/** 造一个「有记忆库」的工作区目录，库文件大小由 calls 控制。 */
const mkStore = (root, name, rows = 1) => {
  const dir = join(root, name)
  mk(join(dir, '.dsh-meow'))
  writeFileSync(join(dir, '.dsh-meow', 'memory.db'), Buffer.alloc(rows * 1024, 7))
  return dir
}

const writeRegistry = (table) => {
  put(join(HOME, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: table } }))
}

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* Windows 上偶发占用，忽略 */
  }
})

describe('工作区注册表', () => {
  test('没有文件 / 坏 JSON / 空表都给空数组', () => {
    rmSync(join(HOME, 'storages'), { recursive: true, force: true })
    assert.deepEqual(readWorkspaceRegistry(), [])
    put(join(HOME, 'storages', 'workspace.json'), '{ 坏掉的 json')
    assert.deepEqual(readWorkspaceRegistry(), [])
    put(join(HOME, 'storages', 'workspace.json'), '')
    assert.deepEqual(readWorkspaceRegistry(), [])
    writeRegistry({})
    assert.deepEqual(readWorkspaceRegistry(), [])
  })

  test('带 BOM 也能读；没有 path 的记录被跳过；title 缺失时取目录名', () => {
    const a = join(HOME, 'ws-a')
    const b = join(HOME, 'ws-b')
    writeRegistry({
      'id-a': { path: a, title: '甲工作区' },
      'id-b': { path: b },
      'id-c': { title: '没有路径的记录' },
      'id-d': { path: '' },
    })
    const text = '\uFEFF' + JSON.stringify({ tables: { workspaces: {
      'id-a': { path: a, title: '甲工作区' },
      'id-b': { path: b },
      'id-c': { title: '没有路径的记录' },
      'id-d': { path: '' },
    } } })
    put(join(HOME, 'storages', 'workspace.json'), text)
    const out = readWorkspaceRegistry()
    assert.deepEqual(out.map((x) => x.id).sort(), ['id-a', 'id-b'])
    assert.equal(out.find((x) => x.id === 'id-a').title, '甲工作区')
    assert.equal(out.find((x) => x.id === 'id-b').title, 'ws-b')
  })
})

describe('workspaceKey', () => {
  test('去掉空白、最多 24 个字符', () => {
    assert.equal(workspaceKey('D:/a/b', 'Memory  Universe'), 'MemoryUniverse')
    assert.equal(workspaceKey('D:/a/记忆星图工程目录很长的名字啊', ''), '记忆星图工程目录很长的名字啊'.slice(0, 24))
    assert.equal(workspaceKey('D:/x/myname', ''), 'myname')
  })
})

describe('discoverStores', () => {
  before(() => {
    writeRegistry({})
  })

  test('只收真的有 memory.db 的目录；按体积从大到小', () => {
    const root = join(HOME, 'roots', 'r1')
    mkStore(root, 'big', 8)
    mkStore(root, 'small', 1)
    mk(join(root, 'no-db'))
    const out = discoverStores({ extraRoots: [root] })
    assert.deepEqual(out.map((s) => s.title), ['big', 'small'])
    assert.ok(out[0].size > out[1].size)
    assert.equal(out[0].key, 'big')
    assert.ok(out[0].dbPath.endsWith(join('.dsh-meow', 'memory.db')))
    assert.ok(out[0].sessionsDir.endsWith(join('.dsh-meow', 'sessions')))
  })

  test('同一目录写两次只出现一次（大小写也不重）', () => {
    const root = join(HOME, 'roots', 'r2')
    const dir = mkStore(root, 'once', 2)
    const out = discoverStores({ extraRoots: [root, root, dir] })
    assert.equal(out.filter((s) => s.title === 'once').length, 1)
  })

  test('注册表里的工作区也被收进来，并保留它的 id 与 title', () => {
    const ws = mkStore(join(HOME, 'reg'), 'reg-ws', 3)
    writeRegistry({ 'ws-id': { path: ws, title: '注册表里的名字' } })
    const out = discoverStores({ extraRoots: [] })
    const hit = out.find((s) => s.id === 'ws-id')
    assert.ok(hit, '注册表里的工作区没被发现')
    assert.equal(hit.title, '注册表里的名字')
    writeRegistry({})
  })

  test('extraRoots 指向不存在的地方：不抛，只返回能看见的', () => {
    const out = discoverStores({ extraRoots: [join(HOME, 'nope'), ''] })
    assert.ok(Array.isArray(out))
  })
})

describe('readSessionLedgers', () => {
  test('目录不存在 / 空目录给空数组', () => {
    assert.deepEqual(readSessionLedgers(join(HOME, 'no-such-dir')), [])
    assert.deepEqual(readSessionLedgers(''), [])
    const empty = join(HOME, 'ledgers-empty')
    mk(empty)
    assert.deepEqual(readSessionLedgers(empty), [])
  })

  test('只认 .json；坏 JSON 跳过；空数组与非字符串 id 被过滤', () => {
    const dir = join(HOME, 'ledgers')
    put(join(dir, 's1.json'), JSON.stringify({ injected: ['a', 'b'], searched: ['c'], bad: 'x', empty: [], mixed: ['d', 3, '', null] }))
    put(join(dir, 's2.json'), '不是 json')
    put(join(dir, 'notes.txt'), '{"injected":["z"]}')
    const out = readSessionLedgers(dir)
    assert.deepEqual(
      out.map((x) => x.sessionId + '/' + x.kind),
      ['s1/injected', 's1/searched', 's1/mixed'],
    )
    assert.deepEqual(out[0].ids, ['a', 'b'])
    assert.deepEqual(out[2].ids, ['d'])
  })

  test('currentProject 透传，缺省是空串', () => {
    const dir = join(HOME, 'ledgers-2')
    put(join(dir, 'p.json'), JSON.stringify({ currentProject: 'MemoryUniverse', injected: ['a'] }))
    put(join(dir, 'q.json'), JSON.stringify({ injected: ['b'] }))
    const out = readSessionLedgers(dir)
    assert.equal(out.find((x) => x.sessionId === 'p').currentProject, 'MemoryUniverse')
    assert.equal(out.find((x) => x.sessionId === 'q').currentProject, '')
  })
})

describe('readInventory', () => {
  const profile = join(HOME, 'profiles', 'desktop')

  test('什么都没有时是三张空表', () => {
    const inv = readInventory()
    assert.deepEqual(inv.plugins, [])
    assert.deepEqual(inv.skills, [])
    assert.deepEqual(inv.mcp, [])
  })

  test('profile 里选中的 bundle：读得到版本，认得出是不是本地装的', () => {
    put(
      join(profile, 'package.json'),
      JSON.stringify({
        dsh: { profile: { bundles: ['dsh-memory-nebula', 'some-remote', 'no-version'] } },
        dependencies: {
          'dsh-memory-nebula': 'file:D:/document/Memory Universe/dsh-memory-nebula',
          'some-remote': '^1.2.3',
        },
      }),
    )
    put(join(profile, 'node_modules', 'dsh-memory-nebula', 'package.json'), JSON.stringify({ version: '1.11.38' }))
    const inv = readInventory()
    const byName = Object.fromEntries(inv.plugins.map((p) => [p.name, p]))
    assert.equal(byName['dsh-memory-nebula'].version, '1.11.38')
    assert.equal(byName['dsh-memory-nebula'].bundle, true)
    assert.equal(byName['dsh-memory-nebula'].local, true)
    assert.equal(byName['some-remote'].local, false)
    assert.equal(byName['no-version'].version, '')
    assert.equal(byName['no-version'].local, true) // 没写进 dependencies 就当本地
  })

  test('技能目录：读 SKILL.md 的 frontmatter，缺字段时退回目录名，描述被裁到 160', () => {
    const skills = join(HOME, 'skills')
    put(join(skills, 'alpha', 'SKILL.md'), '---\nname: "阿尔法"\ndescription: "做一件事"\n---\n正文')
    put(join(skills, 'beta', 'SKILL.md'), '没有 frontmatter 的技能')
    put(join(skills, 'gamma', 'README.md'), '不是 SKILL.md')
    put(join(skills, 'delta', 'SKILL.md'), '---\nname: delta\ndescription: ' + '长'.repeat(300) + '\n---\n')
    const byName = Object.fromEntries(readInventory().skills.map((s) => [s.dir, s]))
    assert.deepEqual(Object.keys(byName).sort(), ['alpha', 'beta', 'delta'])
    assert.equal(byName.alpha.name, '阿尔法')
    assert.equal(byName.alpha.description, '做一件事')
    assert.equal(byName.beta.name, 'beta')
    assert.equal(byName.delta.description.length, 160) // clip 到 160 就停
    assert.ok(byName.delta.description.startsWith('长'))
  })

  test('MCP：只认跟在 mcp 字样附近的 id，同一个 id 不重复，认得出 transport', () => {
    const text = [
      'plugins:',
      '  - id: dsh-memory-nebula',
      '    config:',
      '      type: mcp',
      '      transport: stdio',
      '  - id: unrelated-plugin',
      '    config:',
      '      type: bundle',
      '  - id: drawio',
      '    config:',
      '      kind: mcp',
      '      transport: streamable-http',
      '',
    ].join('\n')
    put(join(profile, 'cordis.patch.yml'), text)
    put(join(HOME, 'cordis.patch.yml'), text)
    const mcp = readInventory().mcp
    // 普通插件被误列成 MCP：原来固定看 24 行，紧随其后的插件会被算进来
    assert.deepEqual(mcp.map((x) => x.name), ['dsh-memory-nebula', 'drawio'], '普通插件被误列成 MCP 了')
    assert.equal(mcp[0].transport, 'stdio')
    assert.equal(mcp[1].transport, 'streamable-http')
  })
})
