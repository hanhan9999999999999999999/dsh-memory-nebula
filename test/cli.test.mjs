// CLI 入口的契约测试：它是用户最先碰到的东西，之前一行都没被测过。
// 每个用例都在临时目录里跑，DSH_HOME 也另指，不碰真的记忆库。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(REPO, 'lib', 'standalone.mjs')
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version

const sandbox = mkdtempSync(join(tmpdir(), 'nebula-cli-'))
test.after(() => rmSync(sandbox, { recursive: true, force: true }))

function run(args, extra = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, DSH_HOME: join(sandbox, 'home'), ...extra },
  })
}

async function serveDemo(extra = [], token = '') {
  const home = join(sandbox, 'home-' + Math.random().toString(16).slice(2, 8))
  const logFile = join(sandbox, 'serve-' + Math.random().toString(16).slice(2, 8) + '.log')
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [CLI, '--demo', '--port', String(port), '--log', logFile, ...extra], {
    cwd: sandbox,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (b) => { out += b })
  child.stderr.on('data', (b) => { out += b })
  const base = `http://127.0.0.1:${port}/api/memory-nebula`
  const pingUrl = base + '/ping' + (token ? '?token=' + encodeURIComponent(token) : '')
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(pingUrl)
      if (r.ok) return { child, base, port, logFile, out: () => out }
    } catch {}
    await new Promise((r) => setTimeout(r, 150))
  }
  child.kill('SIGKILL')
  let log = ''
  try { log = readFileSync(logFile, 'utf8') } catch {}
  throw new Error('子进程没起来：' + out.slice(0, 400) + log.slice(0, 400))
}

test('--version 打印包里的版本，退出码 0', () => {
  const r = run(['--version'])
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), VERSION)
  const short = run(['-v'])
  assert.equal(short.stdout.trim(), VERSION)
})

test('--help 列出所有子命令，退出码 0', () => {
  const r = run(['--help'])
  assert.equal(r.status, 0)
  for (const needle of ['memory-nebula', '--port', '--root', '--export', '--share', '--diagnose', '--demo', '--token']) {
    assert.ok(r.stdout.includes(needle), '帮助里缺 ' + needle)
  }
})

test('参数缺值时说不清哪一项，退出码 2', () => {
  const r = run(['--port'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--port 后面需要一个值/)
})

test('端口不是数字时拒绝启动，退出码 2', () => {
  const r = run(['--port', 'abc'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /端口无效：abc/)
})

test('端口被占用时说清怎么办，退出码 1（不是先扫一遍全盘）', async () => {
  const blocker = http.createServer(() => {})
  const port = 30000 + Math.floor(Math.random() * 20000)
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve))
  try {
    const t0 = Date.now()
    const r = run(['--demo', '--port', String(port)])
    const ms = Date.now() - t0
    assert.equal(r.status, 1)
    assert.match(r.stdout + r.stderr, /端口 \d+ 已被占用/)
    assert.ok(ms < 20000, '端口冲突应当在建图之前就报（用了 ' + ms + 'ms）')
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('口令太短时拒绝启动，退出码 2', () => {
  const r = run(['--demo', '--port', '21999', '--token', 'short'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /至少 12 个字符/)
})

test('--export 写出可解析的 JSON 报告', () => {
  const out = join(sandbox, 'report.json')
  const r = run(['--export', out, '--demo'])
  assert.equal(r.status, 0, r.stderr)
  const parsed = JSON.parse(readFileSync(out, 'utf8'))
  assert.ok(parsed.stats && parsed.stats.nodes > 0, '报告里应当带 stats.nodes')
  assert.match(r.stdout, /已写出/)
})

test('--export 按扩展名推断 md，并按 --format 报错', () => {
  const md = join(sandbox, 'report.md')
  const ok = run(['--export', md, '--demo'])
  assert.equal(ok.status, 0, ok.stderr)
  assert.ok(readFileSync(md, 'utf8').length > 200, 'md 报告不该是空文件')

  const bad = run(['--export', join(sandbox, 'x.md'), '--format', 'xml', '--demo'])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /只支持 md 或 json/)
})

test('--share 写出自包含 HTML 快照', () => {
  const out = join(sandbox, 'snap.html')
  const r = run(['--share', out, '--demo'])
  assert.equal(r.status, 0, r.stderr)
  const html = readFileSync(out, 'utf8')
  assert.match(html.slice(0, 200).toLowerCase(), /^<!doctype html/)
  assert.ok(html.length > 50000, '快照应当把数据一起装进去（实际 ' + html.length + ' 字节）')
  assert.match(r.stdout, /已写出/)
})

test('--hops 写错时两个子命令都说清，退出码 2', () => {
  const bad = run(['--export', join(sandbox, 'bad-hops.json'), '--demo', '--hops', '9'])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /hops 需要 1–5 的整数/)

  const badShare = run(['--share', join(sandbox, 'bad-hops.html'), '--demo', '--hops', 'abc'])
  assert.equal(badShare.status, 2)
  assert.match(badShare.stderr, /hops 需要 1–5 的整数/)
})

test('--share 的快照范围写错时说清原因，退出码 2', () => {
  const r = run(['--share', join(sandbox, 'bad.html'), '--demo', '--scope', 'nope:1'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /快照没有写出/)
})

test('--diagnose --json 输出机器可读诊断，不启动端口', () => {
  const r = run(['--diagnose', '--json', '--demo', '--root', sandbox])
  assert.ok(r.status === 0 || r.status === 1, '诊断可以是「有问题」，但不该崩：' + r.stderr)
  const parsed = JSON.parse(r.stdout)
  assert.equal(parsed.version, VERSION)
  assert.ok(parsed.runtime && parsed.runtime.node, '诊断里应当带 runtime.node')
})

test('服务起来后 /ping 报出版本，SIGTERM 时安静退出并留一行日志', async () => {
  const s = await serveDemo()
  try {
    const ping = await (await fetch(s.base + '/ping')).json()
    assert.equal(ping.version, VERSION)
    assert.ok(ping.capabilities.includes('graph'))

    // 首页与静态资源走同一个端口
    const home = await fetch('http://127.0.0.1:' + s.port + '/app')
    assert.equal(home.status, 200)
    assert.match(await home.text(), /<html/i)

    const log = readFileSync(s.logFile, 'utf8')
    assert.match(log, /standalone on http:\/\/127\.0\.0\.1:/)
  } finally {
    const { code, signal } = await new Promise((resolve) => {
      s.child.once('exit', (c, sig) => resolve({ code: c, signal: sig }))
      s.child.kill('SIGTERM')
      setTimeout(() => resolve({ code: 'timeout', signal: null }), 8000)
    })
    // Windows 上没有真的信号投递：kill 会直接结束进程（code null + signal），
    // 这时只要求它按时走人；POSIX 上跑的是 standalone 里那个 bye()，退出码 0。
    assert.notEqual(code, 'timeout', 'SIGTERM 之后进程应当自己退出')
    if (process.platform !== 'win32') assert.equal(code, 0)
  }
})

test('跨端口的本机页面能读，非本机 Origin 的写请求被挡', async () => {
  const s = await serveDemo()
  try {
    const pre = await fetch(s.base + '/ping', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:1' } })
    assert.equal(pre.status, 204)
    const blocked = await fetch(s.base + '/ping', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
    assert.equal(blocked.status, 403)
    const write = await fetch(s.base + '/refresh', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
    assert.ok(write.status === 403, '外来 Origin 的写请求应当 403（实际 ' + write.status + '）')
  } finally {
    s.child.kill('SIGTERM')
    await new Promise((r) => s.child.once('exit', r))
  }
})

test('--token 之后不带口令读不到数据，带口令才放行', async () => {
  const token = 'nebula-test-token-01'
  const s = await serveDemo(['--token', token], token)
  try {
    const bare = await fetch(s.base + '/ping')
    assert.equal(bare.status, 401)
    const body = await bare.json()
    assert.match(body.error, /需要本机口令/)

    const withToken = await fetch(s.base + '/ping?token=' + encodeURIComponent(token))
    assert.equal(withToken.status, 200)
    assert.equal((await withToken.json()).version, VERSION)
    assert.match(withToken.headers.get('set-cookie') || '', /nb_token=/)
  } finally {
    s.child.kill('SIGTERM')
    await new Promise((r) => s.child.once('exit', r))
  }
})

test('请求行太长时回一个能读懂的状态码，而不是连接错误', async () => {
  const s = await serveDemo()
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: s.port, path: '/' + 'x'.repeat(40000), method: 'GET' },
        (r) => { let text = ''; r.setEncoding('utf8'); r.on('data', (c) => { text += c }); r.on('end', () => resolve({ status: r.statusCode, text })) },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(res.status, 431)
    assert.match(res.text, /请求头或 URL 太长/)
  } finally {
    s.child.kill('SIGTERM')
    await new Promise((r) => s.child.once('exit', r))
  }
})

test('--log 写不进去时退回控制台，并且只吵一次', async () => {
  const dirAsLog = mkdtempSync(join(sandbox, 'logdir-'))
  const port = 40000 + Math.floor(Math.random() * 15000)
  const child = spawn(process.execPath, [CLI, '--demo', '--port', String(port), '--log', dirAsLog], {
    cwd: sandbox,
    env: { ...process.env, DSH_HOME: join(sandbox, 'home-log') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let text = ''
  child.stdout.on('data', (b) => { text += b })
  child.stderr.on('data', (b) => { text += b })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && !/standalone on /.test(text)) {
    await new Promise((r) => setTimeout(r, 150))
  }
  child.kill('SIGTERM')
  await new Promise((r) => child.once('exit', r))
  assert.match(text, /日志写不进去/)
  const hits = text.match(/日志写不进去/g) || []
  assert.equal(hits.length, 1, '只该吵一次（实际 ' + hits.length + '）')
})
