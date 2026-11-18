// 插件工具层的契约：宿主看到的每个工具都得真的回得了话。
// 这一层是「用户真正碰到的东西」——工具回错话，前面算得再准也没用。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HOME = mkdtempSync(join(tmpdir(), 'nebula-tools-'))
const WS = join(HOME, 'ws-1')
const DB_DIR = join(WS, '.dsh-meow')
mkdirSync(DB_DIR, { recursive: true })

const db = new DatabaseSync(join(DB_DIR, 'memory.db'))
db.exec(
  'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, created_at INTEGER, keywords TEXT, level TEXT, importance INTEGER, status TEXT, project TEXT)',
)
const rows = [
  ['a1', '门禁里的 dev 依赖', '把发布门禁里对 dev 目录的依赖去掉了，CI 才绿。', '["门禁","CI"]'],
  ['a2', 'zstd 的 node 下限', 'node:zlib 的 zstd 是 22.15 才有的，下限写错会让插件起不来。', '["zstd","node"]'],
  ['a3', '停端口别杀邻居', 'sidecar 脚本按端口停进程时，6341 不该把 63411 一起停掉。', '["端口","sidecar"]'],
]
db.exec('BEGIN')
for (const [id, title, content, keywords] of rows) {
  db.prepare(
    'INSERT INTO fact (id, title, content, created_at, keywords, level, importance, status, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, title, content, Date.now(), keywords, 'fact', 2, 'active', '记忆星图')
}
db.exec('COMMIT')
db.close()

// 发现层靠工作区注册表找库（$DSH_HOME/storages/workspace.json），没有登记就等于没有库
mkdirSync(join(HOME, 'storages'), { recursive: true })
writeFileSync(
  join(HOME, 'storages', 'workspace.json'),
  JSON.stringify({ tables: { workspaces: { 'ws-1': { path: WS, title: '记忆星图' } } } }),
  'utf8',
)

process.env.DSH_HOME = HOME
process.env.NEBULA_PREWARM_DELAY = '1000000'
process.env.NEBULA_HYGIENE_WARM = '0'
process.env.NEBULA_CACHE = '0'

const { apply } = await import('../lib/index.js')

const tools = new Map()
const cleanups = []
let promptHandler = null

const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
  effect: (fn) => {
    const off = fn()
    if (typeof off === 'function') cleanups.push(off)
    return () => {}
  },
  systemPrompt: { context: (def) => { promptHandler = def; return () => {} } },
  on: () => () => {},
  webServer: null,
  connection: null,
}

apply(ctx)

const call = async (name, args) => {
  const def = tools.get(name)
  assert.ok(def, '工具没注册：' + name)
  return def.execute(args, {})
}

/** 等图真的建好：第一次建图是后台跑的，等 `3 条记忆` 出现再问工具。 */
const waitReady = async () => {
  for (let i = 0; i < 120; i += 1) {
    const out = await call('nebula_stats', {})
    if (/3 条记忆/.test(out)) return out
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('等不到星图建好：' + (await call('nebula_stats', {})))
}
await waitReady()

/** 从检索结果里取出星图真实的 id（适配器给的 id 形态不该被测试写死）。 */
const idsFrom = async (query) => {
  const out = await call('nebula_recall', { query, limit: 5 })
  const ids = [...out.matchAll(/id: (\S+)/g)].map((m) => m[1])
  return [...new Set(ids)]
}

test.after(() => {
  for (const off of cleanups) {
    try {
      off()
    } catch {
      /* 清理失败不影响结论 */
    }
  }
  // Windows 上 sqlite 句柄可能还没放，重试几次就好
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
})

test('九个工具都注册上了', () => {
  const names = [...tools.keys()].sort()
  assert.deepEqual(names, [
    'nebula_bridge',
    'nebula_hygiene',
    'nebula_ingest',
    'nebula_inspect',
    'nebula_link',
    'nebula_path',
    'nebula_recall',
    'nebula_sources',
    'nebula_stats',
  ])
  for (const name of names) {
    assert.equal(tools.get(name).output.schema.type, 'string', name + ' 的输出类型不是字符串')
    assert.equal(typeof tools.get(name).execute, 'function', name + ' 没有 execute')
  }
})

test('nebula_recall：什么都不给要说清楚要什么', async () => {
  const out = await call('nebula_recall', {})
  assert.match(out, /需要 query 或 memory_ids/)
})

test('nebula_recall：查得到就说清条数与扫描量', async () => {
  const out = await call('nebula_recall', { query: '门禁 dev 依赖', limit: 5 })
  assert.match(out, /nebula_recall/)
  assert.match(out, /条（扫描 \d+ 条候选/)
  assert.match(out, /id: /)
})

test('nebula_recall：查不到也是一句人话，不是空白', async () => {
  const out = await call('nebula_recall', { query: '量子纠缠与奶酪火锅的相遇' })
  assert.match(out, /星图里没有匹配/)
})

test('nebula_recall：种子来自 memory_ids 时会注明', async () => {
  const out = await call('nebula_recall', { memory_ids: ['a1'] })
  assert.match(out, /种子来自你给的 1 条记忆 id/)
})

test('nebula_inspect：缺 id / id 不存在 / 正常三种都回得成句', async () => {
  assert.match(await call('nebula_inspect', {}), /需要 id/)
  assert.match(await call('nebula_inspect', { id: 'nope-404' }), /星图里没有 id=nope-404/)
  const [id] = await idsFrom('门禁 dev 依赖')
  assert.ok(id, '检索没带回任何 id，后面的断言没法做')
  const out = await call('nebula_inspect', { id })
  assert.match(out, /^# /)
  assert.match(out, /## 连接到的记忆/)
})

test('nebula_link：四种动作 + 两个错误分支', async () => {
  assert.match(await call('nebula_link', { action: 'link', a: '', b: 'x' }), /需要 a 和 b/)
  assert.match(await call('nebula_link', { action: '跳', a: 'x', b: 'y' }), /没做成|action 只能是/)
  assert.match(
    await call('nebula_link', { action: 'link', a: 'meow:no:fact:x', b: 'meow:no:fact:y' }),
    /没做成：/,
    'id 不存在时要回「nebula_link 没做成：…」，而不是把异常丢给宿主',
  )

  // 两条不同的 id：以前这里写的是 `ids[1] || ids[0]`，检索只带回一条时就成了「自己连自己」，
  // 而 1.11.64 起自己配对会被拒——那条 fallback 其实一直在掩盖夹具不够。
  const firstIds = await idsFrom('门禁 dev 依赖')
  const moreIds = await idsFrom('记忆')
  const a = firstIds[0] || moreIds[0]
  const b = [...firstIds, ...moreIds].find((id) => id && id !== a)
  assert.ok(a && b && a !== b, '需要两条不同的 id 才能验连边，实际拿到：' + JSON.stringify([...firstIds, ...moreIds]))
  assert.match(await call('nebula_link', { action: 'link', a, b, note: '同一条线索' }), /已固化连线/)
  assert.match(await call('nebula_link', { action: 'unlink', a, b }), /已断开/)
  assert.match(await call('nebula_link', { action: 'unlink', a, b }), /没有找到这条手工连线/)
  assert.match(await call('nebula_link', { action: 'mute', a, b }), /已屏蔽这条关联/)
  assert.match(await call('nebula_link', { action: 'unmute', a, b }), /已撤销屏蔽/)
  assert.match(await call('nebula_link', { action: 'unmute', a, b }), /本来就没有被屏蔽/)
})

test('nebula_path：缺 id / 连不上 / 同一条', async () => {
  assert.match(await call('nebula_path', { a: '', b: 'y' }), /需要 a 和 b 两个 id/)
  const ids = await idsFrom('端口 sidecar')
  assert.ok(ids.length > 0, '检索没带回 id')
  const out = await call('nebula_path', { a: ids[0], b: ids[ids.length - 1] })
  assert.match(out, /没有连上|跳|同一条记忆/)
  assert.match(await call('nebula_path', { a: ids[0], b: ids[0] }), /没有连上|同一条记忆/)
})

test('nebula_stats：说清规模、工作区、枢纽', async () => {
  const out = await call('nebula_stats', { hubs: 3 })
  assert.match(out, /记忆星图：\d+ 条记忆 \/ \d+ 条连接/)
  assert.match(out, /工作区：/)
  assert.match(out, /枢纽记忆：/)
})

test('nebula_hygiene：全量概览与单类都列得出来', async () => {
  const all = await call('nebula_hygiene', { limit: 2 })
  assert.match(all, /记忆体检：共 \d+ 项/)
  for (const name of ['疑似重复', '该更新了', '关系是凑的', '超重', '没人读过', '孤立']) {
    assert.ok(all.includes(name + '（'), '体检缺了「' + name + '」这一类')
  }
  const one = await call('nebula_hygiene', { kind: 'orphan' })
  assert.match(one, /孤立（/)
  assert.ok(!one.includes('疑似重复（'), '只要一类时不该列别的类')
})

test('nebula_bridge：没有种子要说要什么，有查询词要么给邻居要么说没有', async () => {
  assert.match(await call('nebula_bridge', {}), /需要 memory_ids 或 query/)
  const out = await call('nebula_bridge', { query: '记忆星图', limit: 2 })
  assert.match(out, /nebula_bridge/)
})

test('nebula_sources：来源、可用适配器、hint 都在', async () => {
  const out = await call('nebula_sources', {})
  assert.match(out, /已接入 \d+ 个来源/)
  assert.match(out, /可用适配器：/)
  assert.ok(out.length > 200, '来源报告太短，可能是空壳')
})

test('nebula_ingest：缺参数说清楚，推成功说出条数与图规模', async () => {
  assert.match(await call('nebula_ingest', { items: [] }), /需要 provider/)
  assert.match(await call('nebula_ingest', { provider: 'hindsight', items: [] }), /至少一条 items/)
  const out = await call('nebula_ingest', {
    provider: 'hindsight',
    items: [{ title: '外部一条', content: '从远端服务推过来的记忆，测试注入路径。', level: 'fact' }],
  })
  assert.match(out, /已推入 1 条/)
  assert.match(out, /hindsight\.jsonl/)
})

test('系统提示：不管有没有会话上下文，给的都是同一段常量', () => {
  assert.ok(promptHandler, 'systemPrompt.context 没注册')
  assert.equal(typeof promptHandler.text, 'string', 'system prompt 必须是常量（动态内容会废掉前缀缓存）')
  assert.ok(promptHandler.text.length > 200)
  assert.match(promptHandler.text, /记忆星图 memory-nebula/)
  // 常量就不再是「等长」而是「一字不差」：换上下文也不会多出任何东西
  const a = promptHandler.text
  const b = promptHandler.text
  assert.equal(a, b)
})
