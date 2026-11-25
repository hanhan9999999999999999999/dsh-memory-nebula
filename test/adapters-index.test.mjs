import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 造一个最小可读的记忆库：meow.detect 只认 .dsh-meow/memory.db 这个约定。 */
function makeMeowDb(wsRoot, rows = 1) {
  const dir = join(wsRoot, '.dsh-meow')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'memory.db'))
  db.exec('CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, created_at INTEGER, keywords TEXT, level TEXT, importance INTEGER, status TEXT)')
  for (let i = 1; i <= rows; i += 1) {
    db.prepare('INSERT INTO fact (id, title, content, created_at, keywords, level, importance, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('f' + i, '第 ' + i + ' 条', '内容 ' + i, 1794700000000 + i, '记忆,星图', 'fact', 2, 'active')
  }
  db.close()
}

const HOME = mkdtempSync(join(tmpdir(), 'nebula-adapters-'))
process.env.DSH_HOME = HOME
process.env.NEBULA_CACHE = '0'
process.env.NEBULA_PREWARM_DELAY = '1000000'
process.env.NEBULA_HYGIENE_WARM = '0'

const NEB = join(HOME, 'memory-nebula')

function writeConfig(obj) {
  mkdirSync(NEB, { recursive: true })
  writeFileSync(join(NEB, 'sources.json'), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')
}

function clearConfig() {
  rmSync(join(NEB, 'sources.json'), { force: true })
}

const {
  ADAPTERS,
  adapterCatalog,
  configPath,
  readSourcesConfig,
  discoverSources,
  scanAll,
  scanAllSteps,
  scanAllAsync,
  probeAll,
} = await import('../lib/host/adapters/index.js')

process.on('exit', () => {
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {}
})

// ── 清单 ────────────────────────────────────────────────
test('清单：五个适配器都在，内置标记正确', () => {
  const cat = adapterCatalog()
  assert.equal(cat.length, 5, '五个内置适配器要都在清单里')
  assert.deepEqual(cat.map((c) => c.id).sort(), ['ingest', 'meow', 'mnemon', 'notes', 'sqlite'])
  const meow = cat.find((c) => c.id === 'meow')
  assert.equal(meow.builtin, true, 'meow 是内置的')
  assert.equal(cat.find((c) => c.id === 'notes').builtin, false, 'notes 不是内置的')
  assert.equal(cat.find((c) => c.id === 'mnemon').builtin, false, 'mnemon 不是内置的')
  for (const c of cat) {
    assert.equal(typeof c.description, 'string')
    assert.equal(typeof c.config, 'object')
  }
  assert.ok(configPath().endsWith(join('memory-nebula', 'sources.json')), '配置路径要在 memory-nebula 下')
})

// ── 配置读取的六种形状 ──────────────────────────────────
test('配置：六种形状都读得出来，坏了留原因', () => {
  clearConfig()
  const none = readSourcesConfig()
  assert.equal(none.exists, false, '没有文件时 exists=false')
  assert.deepEqual(none.sources, [], '默认没有来源')
  assert.equal(none.autoDetect, true, '默认开自动发现')

  writeConfig({ version: 1, sources: [{ adapter: 'notes', path: '/x' }], extraRoots: ['/y'], disabled: { notes: true }, autoDetect: false })
  const ok = readSourcesConfig()
  assert.equal(ok.exists, true)
  assert.equal(ok.sources.length, 1, '声明的来源要读出来')
  assert.equal(ok.autoDetect, false, '关掉自动发现的设置要尊重')
  assert.equal(ok.disabled.notes, true, '禁用表要读出来')
  assert.equal(ok.error, undefined, '读得出来时不该有 error')

  writeConfig({ sources: 'nope', extraRoots: 'nope', disabled: 'nope' })
  const fixed = readSourcesConfig()
  assert.deepEqual(fixed.sources, [], 'sources 不是数组就当空')
  assert.deepEqual(fixed.extraRoots, [], 'extraRoots 不是数组就当空')
  assert.deepEqual(fixed.disabled, {}, 'disabled 不是对象就当空')

  writeConfig('"just a string"')
  assert.equal(readSourcesConfig().exists, false, '顶层不是对象时当没有配置')

  writeConfig('{ this is not json }')
  const broken = readSourcesConfig()
  assert.equal(broken.exists, true, '坏文件也 exists=true（文件确实在）')
  assert.match(broken.error, /sources\.json|JSON|Unexpected/i, '坏 JSON 要留下原因')
  assert.deepEqual(broken.sources, [], '坏配置回默认值')

  writeFileSync(join(NEB, 'sources.json'), '\uFEFF{"sources":[{"adapter":"notes","path":"/bom"}]}', 'utf8')
  assert.equal(readSourcesConfig().sources.length, 1, '带 BOM 的配置也要读得出来')
  clearConfig()
})

// ── 发现层：禁用、未知适配器、找不到内容 ────────────────
test('发现层：禁用、未知适配器、空目录都要说清楚', () => {
  const empty = mkdtempSync(join(tmpdir(), 'nebula-empty-'))
  clearConfig()
  const off = discoverSources({ extraRoots: [empty], disabled: { meow: true, ingest: true } })
  assert.equal(off.stores.length, 0, '两个内置都禁用时不该有来源')
  assert.equal(off.reports.some((r) => r.adapter === 'meow'), false, '禁用后不该出现 meow 的报告')

  const on = discoverSources({ extraRoots: [empty] })
  assert.ok(on.reports.some((r) => r.adapter === 'meow'), '默认要尝试 meow')
  assert.equal(on.stores.some((s) => s.adapter === 'ingest'), false, '外部推送目录还不存在时不该有 ingest 来源')

  // 外部推送目录里放一个 jsonl，ingest 就要被接进来
  const ingestDir = join(NEB, 'ingest')
  mkdirSync(ingestDir, { recursive: true })
  writeFileSync(join(ingestDir, 'hindsight.jsonl'), JSON.stringify({ title: '推过来的一条', content: '远端记忆' }) + '\n', 'utf8')
  const withIngest = discoverSources({ extraRoots: [empty] })
  assert.ok(withIngest.stores.some((s) => s.adapter === 'ingest'), '外部推送目录有东西时要接进来')
  assert.ok(withIngest.reports.some((r) => r.adapter === 'ingest'), '接进来之后要有它的报告')
  rmSync(ingestDir, { recursive: true, force: true })

  const ws = join(empty, 'ws-1', '.dsh-meow')
  makeMeowDb(join(empty, 'ws-1'))
  const foundAgain = discoverSources({ extraRoots: [empty, empty] })
  const meowStores = foundAgain.stores.filter((s) => s.adapter === 'meow')
  assert.equal(meowStores.length, 1, '同一个来源不会因为重复的 root 出现两次')

  writeConfig({ sources: [{ adapter: 'nope' }, { adapter: 'notes', path: join(empty, 'nothing-here'), title: '空目录' }, { adapter: 'notes', path: ws, enabled: false }, null, 'string'] })
  const mixed = discoverSources({ extraRoots: [empty] })
  assert.ok(mixed.errors.some((e) => /没有这个适配器/.test(e.error)), '未知适配器要报出来')
  assert.ok(mixed.reports.some((r) => r.note && r.note.includes('按配置没找到可读内容')), '配置指到空目录要留一句')
  assert.equal(mixed.stores.some((s) => s.title === '空目录'), false, '空目录不该变成来源')
  clearConfig()
  rmSync(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ── 扫描层：四种结果形状 + 三种失败 ─────────────────────
test('扫描层：四种结果形状与三种失败', async () => {
  const nodes = []
  const steps = [
    { nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', storeId: 'keep-me' }], ledgers: [{ sessionId: 's1', kind: 'inject', ids: ['a'] }] },
  ]
  ADAPTERS.fakeGen = {
    meta: { id: 'fakeGen' },
    * scanSteps() {
      yield 'row'
      return steps[0]
    },
  }
  ADAPTERS.fakeSync = { meta: { id: 'fakeSync' }, scan: () => ({ nodes: [{ id: 'c', title: 'C' }], ledgers: { s2: { kind: 'inject', ids: ['c'] }, s3: { kind: 'inject', ids: 'not-array' } } }) }
  ADAPTERS.fakeError = { meta: { id: 'fakeError' }, scan: () => ({ nodes: [], error: '库锁住了' }) }
  ADAPTERS.fakeThrow = { meta: { id: 'fakeThrow' }, scan: () => { throw new Error('炸了') } }
  ADAPTERS.fakeBroken = { meta: { id: 'fakeBroken' } }

  const stores = [
    { id: 'gen', key: 'gen', adapter: 'fakeGen' },
    { id: 'sync', key: 'sync', adapter: 'fakeSync' },
    { id: 'err', key: 'err', adapter: 'fakeError' },
    { id: 'throw', key: 'throw', adapter: 'fakeThrow' },
    { id: 'broken', key: 'broken', adapter: 'fakeBroken' },
    { id: 'ghost', key: 'ghost', adapter: 'no-such-adapter' },
  ]

  const it = scanAllSteps(stores)
  const yields = []
  for (;;) {
    const step = it.next()
    if (step.done) break
    yields.push(step.value)
  }
  const out = scanAll(stores)
  assert.equal(out.nodes.length, 3, '生成器版两条 + 同步版一条，都要在')
  assert.equal(out.nodes.find((n) => n.id === 'b').storeId, 'keep-me', '节点自己带 storeId 时不要覆盖')
  assert.equal(out.nodes.find((n) => n.id === 'a').storeId, 'gen', '没带 storeId 时要补上来源 id')
  assert.equal(out.ledgers.length, 2, '账本两种形状都要收（sessionId 数组那条 + 对象那条），ids 不是数组的丢掉')
  assert.deepEqual(out.ledgers.map((l) => l.sessionId).sort(), ['s1', 's2'])
  assert.ok(out.errors.some((e) => /不能扫描/.test(e.error)), '没有 scan 的适配器要报「不能扫描」')
  assert.ok(out.errors.some((e) => e.error === '库锁住了'), '适配器自己返回的 error 要收集')
  assert.ok(out.errors.some((e) => /炸了/.test(e.error)), '抛异常要变成一条 error 而不是中断扫描')
  assert.ok(out.errors.some((e) => e.store === 'ghost'), '报错里用人看得懂的短名')
  assert.ok(yields.length >= 2, '生成器版要按库让路（每个库至少一次）')
  void nodes

  // 截断：上限只在 res 里时也要说得对
  ADAPTERS.fakeTrunc = { meta: { id: 'fakeTrunc' }, scan: () => ({ nodes: [], truncated: true, maxFiles: 7 }) }
  const tr = scanAll([{ id: 'tr', key: 'tr', adapter: 'fakeTrunc' }])
  assert.equal(tr.warnings.length, 1, '截断要留一条告示')
  assert.equal(tr.warnings[0].maxFiles, 7, '上限取自适配器时不能变成 0')
  assert.match(tr.warnings[0].message, /前 7 个文件/)

  ADAPTERS.fakeTrunc2 = { meta: { id: 'fakeTrunc2' }, scan: () => ({ nodes: [], truncated: true }) }
  const tr2 = scanAll([{ id: 'tr2', key: 'tr2', adapter: 'fakeTrunc2', maxFiles: 3 }])
  assert.equal(tr2.warnings[0].maxFiles, 3, '上限写在来源里时用它')

  // 同步与异步结果一致
  const asyncOut = await scanAllAsync(stores)
  assert.equal(asyncOut.nodes.length, out.nodes.length, '异步扫描与同步扫描结果要一样')
  assert.equal(asyncOut.errors.length, out.errors.length, '错误条数也要一样')
  assert.deepEqual(asyncOut.ledgers, out.ledgers)

  // 空输入
  const none = scanAll([])
  assert.deepEqual(none, { nodes: [], ledgers: [], errors: [], warnings: [] }, '没有来源时给空结果')
  assert.deepEqual(scanAll(null), { nodes: [], ledgers: [], errors: [], warnings: [] }, 'null 也不该炸')

  for (const k of ['fakeGen', 'fakeSync', 'fakeError', 'fakeThrow', 'fakeBroken', 'fakeTrunc', 'fakeTrunc2']) delete ADAPTERS[k]
})

// ── 体检 ────────────────────────────────────────────────
test('体检：未知适配器与坏配置都写进报告', () => {
  writeConfig({ sources: [{ adapter: 'nope', path: '/n' }, { adapter: 'notes', path: join(NEB, 'missing') }] })
  const r = probeAll()
  assert.equal(r.probes[0].adapter, 'meow', '内置两个总要问一遍')
  assert.equal(r.probes[1].adapter, 'ingest')
  assert.ok(r.probes.some((p) => p.note === '未知适配器'), '未知适配器在体检里要说明')
  assert.ok(r.probes.some((p) => p.adapter === 'notes'), '已知适配器要真的被问')
  assert.equal(typeof r.config.path, 'string')
  clearConfig()
})

// ── 配置坏了要出现在概览的告示里（不只是日志） ──────────
test('配置坏了要出现在概览告示里', async () => {
  const wsRoot = join(HOME, 'workspace-file')
  mkdirSync(join(HOME, 'storages'), { recursive: true })
  makeMeowDb(wsRoot, 3)
  writeFileSync(join(HOME, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { 'ws-1': { path: wsRoot, title: '记忆星图' } } } }), 'utf8')
  writeConfig('{ "sources": [ this is broken ] }')

  const { Nebula } = await import('../lib/host/nebula.js')
  const nb = new Nebula({ roots: [], log: () => {} })
  await nb.refresh({ force: true })
  const ov = nb.overview({ hygiene: false })
  const warn = (ov.warnings || []).find((w) => w.code === 'config-unreadable')
  assert.ok(warn, 'sources.json 坏了要有 config-unreadable 告示')
  assert.match(warn.message, /sources\.json/, '告示里要说清是哪个文件')
  assert.match(warn.message, /剩下的|没有接入/, '告示里要说清后果')
  await nb.cacheWriteDone?.()

  writeConfig({ version: 1, autoDetect: false, sources: [] })
  const nb2 = new Nebula({ roots: [], log: () => {} })
  await nb2.refresh({ force: true })
  assert.equal((nb2.overview({ hygiene: false }).warnings || []).some((w) => w.code === 'config-unreadable'), false, '配置正常时不该有这个告示')
  await nb2.cacheWriteDone?.()
  clearConfig()
})

console.log('adapters/index 契约测试：全部通过')
