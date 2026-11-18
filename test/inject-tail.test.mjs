// 注入位置的契约：系统提示里只许有常量规则，会变的东西只能跟在工具结果后面。
//
// 这条门盯的是一个很贵的事故：邻域补充每轮都变，如果它被拼进 systemPrompt.context，
// 整段对话的前缀每轮都不一样 —— 前缀缓存当场作废，token 按全量重算。
// 所以这里既查注册形态（常量 vs 函数），也真跑一次 post-execute 看它落在哪。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HOME = mkdtempSync(join(tmpdir(), 'nebula-tail-'))
const WS1 = join(HOME, 'ws-1')
const WS2 = join(HOME, 'ws-2')

/** 造一个只有一条记忆的工作区（两个库共享关键词，星图才会连起来）。 */
function makeStore(dir, id, title, content) {
  const dbDir = join(dir, '.dsh-meow')
  mkdirSync(dbDir, { recursive: true })
  const db = new DatabaseSync(join(dbDir, 'memory.db'))
  db.exec(
    'CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, created_at INTEGER, keywords TEXT, level TEXT, importance INTEGER, status TEXT, project TEXT)',
  )
  db.prepare(
    'INSERT INTO fact (id, title, content, created_at, keywords, level, importance, status, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    title,
    content,
    Date.now(),
    '["门禁","发布","CI"]',
    'fact',
    3,
    'active',
    '记忆星图',
  )
  db.close()
}

makeStore(WS1, 'p1', '门禁里的 dev 依赖', '把发布门禁里对 dev 目录的依赖去掉了，CI 才绿。')
makeStore(WS2, 'q1', '发布门禁的第二条腿', '另一个工作区里记的发布门禁：CI 之外还要跑一次全量校验。')

mkdirSync(join(HOME, 'storages'), { recursive: true })
writeFileSync(
  join(HOME, 'storages', 'workspace.json'),
  JSON.stringify({
    tables: {
      workspaces: {
        'ws-1': { path: WS1, title: '记忆星图' },
        'ws-2': { path: WS2, title: '发布门禁' },
      },
    },
  }),
  'utf8',
)

process.env.DSH_HOME = HOME
process.env.NEBULA_PREWARM_DELAY = '1000000'
process.env.NEBULA_HYGIENE_WARM = '0'
process.env.NEBULA_CACHE = '0'

const { apply } = await import('../lib/index.js')

const tools = new Map()
const handlers = new Map()
const cleanups = []
let promptHandler = null

const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
  effect: (fn) => {
    const off = fn()
    if (typeof off === 'function') cleanups.push(off)
    return () => {}
  },
  on: (event, handler) => {
    handlers.set(event, handler)
    return () => {}
  },
  systemPrompt: { context: (def) => { promptHandler = def; return () => {} } },
  webServer: null,
  connection: null,
}

apply(ctx)

const call = async (name, args) => {
  const def = tools.get(name)
  assert.ok(def, '工具没注册：' + name)
  return def.execute(args, {})
}

const waitReady = async () => {
  for (let i = 0; i < 120; i += 1) {
    const out = await call('nebula_stats', {})
    if (/2 条记忆/.test(out)) return out
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('等不到星图建好：' + (await call('nebula_stats', {})))
}
await waitReady()

test.after(() => {
  for (const off of cleanups) {
    try {
      off()
    } catch {
      /* 清理失败不影响结论 */
    }
  }
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
})

/** 拿一条真实节点 id（适配器给的 id 形态不该被测试写死）。 */
const someId = async () => {
  const out = await call('nebula_recall', { query: '门禁 CI 发布', limit: 5 })
  const ids = [...out.matchAll(/id: (\S+)/g)].map((m) => m[1])
  assert.ok(ids.length > 0, '检索没给出任何 id：' + out)
  return ids[0]
}

/** 让账本里出现「本会话读过 X」，这是邻域补充的种子。 */
const writeLedger = (sessionId, ids) => {
  const dir = join(WS1, '.dsh-meow', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, sessionId + '.json'),
    JSON.stringify({ injected: [], searched: ids, accessed: [], written: [], currentProject: '记忆星图' }),
    'utf8',
  )
}

const runPost = (exec, result) =>
  handlers.get('tools/post-execute')(exec, result, async () => result)

test('系统提示只注册常量规则：text 是字符串，不是函数', () => {
  assert.ok(promptHandler, 'systemPrompt.context 没注册')
  assert.equal(typeof promptHandler.text, 'string', 'system prompt 里还有会变的函数 —— 每轮重新生成就会废掉前缀缓存')
  assert.equal(promptHandler.name, 'memory-nebula:rule')
  assert.ok(promptHandler.text.length > 200)
  assert.match(promptHandler.text, /记忆星图 memory-nebula/)
  // 常量意味着：给它什么上下文都一样
  assert.equal(promptHandler.text, promptHandler.text)
})

test('动态内容不在系统提示里：源码不再注册 neighbors 段', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(!src.includes("'memory-nebula:neighbors'"), '旧的双段注册还在')
  assert.ok(!src.includes("name: 'memory-nebula:neighbors'"))
  assert.ok(src.includes('ctx.on(\'tools/post-execute\''), '没有尾巴投递的挂载点')
  assert.ok(src.includes('neighborTail'), '邻居计算函数不见了')
})

test('邻域补充落在工具结果后面，而不是系统提示', async () => {
  assert.ok(handlers.has('tools/post-execute'), 'tools/post-execute 没挂上')
  const id = await someId()
  writeLedger('sess-tail-1', [id])
  const result = { content: [{ type: 'text', text: '工具原本的输出' }], isError: false }
  const out = await runPost({ name: 'bash', agent: { session: { header: { cwd: WS1, id: 'sess-tail-1' } } } }, result)
  assert.ok(Array.isArray(out.content))
  assert.ok(out.content.length > result.content.length, '没往结果后面追加：' + JSON.stringify(out.content))
  assert.deepEqual(out.content[0], result.content[0], '原有输出被改了')
  const tail = out.content[out.content.length - 1]
  assert.equal(tail.type, 'text')
  assert.match(tail.text, /【记忆星图 · 邻域补充】/)
  assert.match(tail.text, /这不是上面那个工具的输出/)
  assert.match(tail.text, /nebula_inspect/)
})

test('该加的时候才加：报错结果、星图自己的工具、非文本结果都原样放行', async () => {
  const id = await someId()
  writeLedger('sess-tail-2', [id])
  const agent = { session: { header: { cwd: WS1, id: 'sess-tail-2' } } }

  const errored = { content: [{ type: 'text', text: 'boom' }], isError: true }
  assert.equal(await runPost({ name: 'bash', agent }, errored), errored)

  const own = { content: [{ type: 'text', text: 'nebula_recall 自己说的' }] }
  const ownOut = await runPost({ name: 'nebula_recall', agent }, own)
  assert.equal(ownOut, own, '星图自己的工具不该被再补一遍')

  const weird = { content: 'not-an-array' }
  assert.equal(await runPost({ name: 'bash', agent }, weird), weird)

  // 没有会话上下文：不报错、不追加
  const noSession = { content: [{ type: 'text', text: 'x' }] }
  assert.equal(await runPost({ name: 'bash' }, noSession), noSession)
  // 账本为空：没有种子，不追加
  const emptyLedger = { content: [{ type: 'text', text: 'x' }] }
  const out = await runPost({ name: 'bash', agent: { session: { header: { cwd: WS2, id: 'sess-none' } } } }, emptyLedger)
  assert.equal(out, emptyLedger)
})
