// sidecar.ps1 的契约测试：它是 Windows 用户最先碰到的那个文件（start / stop / status）。
// 只在 Windows 上跑：Linux CI 上脚本本身没有意义。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'sidecar.ps1')
const PS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const it = process.platform === 'win32' && existsSync(PS)
  ? test
  : (name) => test(name, { skip: 'sidecar.ps1 是 Windows 脚本，这里不跑' }, () => {})

function run(args, timeout = 120000) {
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
  })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

const PORT = 63411
const PREFIX_PORT = 6341

it('脚本带 BOM：Windows PowerShell 5.1 会把没有 BOM 的 UTF-8 当成本地代码页', () => {
  const buf = readFileSync(SCRIPT)
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'sidecar.ps1 开头没有 UTF-8 BOM，中文提示会变乱码')
})

it('status：端口上什么都没有时说未运行，并且给出退回宿主那句话', () => {
  const r = run(['status', '-Port', String(PORT)])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /未运行/, '空闲端口应该报未运行')
  assert.match(r.out, /页面会退回宿主自带的接口/, '要告诉用户这时页面用的是宿主接口')
})

it('start → status → stop：真的起得来、认得出、停得掉', () => {
  try {
    const started = run(['start', '-Port', String(PORT)])
    assert.equal(started.code, 0, started.out)
    assert.match(started.out, new RegExp(`已启动 · 端口 ${PORT}`), started.out)
    assert.match(started.out, /记忆 \d+ 条/, '启动后应当报出记忆条数')

    const st = run(['status', '-Port', String(PORT)])
    assert.match(st.out, /运行中：pid \d+/, st.out)
    assert.match(st.out, /v\d+\.\d+\.\d+/, '状态里应当带版本号')

    const stopped = run(['stop', '-Port', String(PORT)])
    assert.match(stopped.out, /已停止 pid \d+/, stopped.out)

    const after = run(['status', '-Port', String(PORT)])
    assert.match(after.out, /未运行/, '停掉之后应当报未运行')
  } finally {
    run(['stop', '-Port', String(PORT)])
  }
})

it('端口按完整一段比对：停 6341 不许动 63411 上的那个实例', () => {
  try {
    const started = run(['start', '-Port', String(PORT)])
    assert.match(started.out, new RegExp(`已启动 · 端口 ${PORT}`), started.out)

    const wrong = run(['stop', '-Port', String(PREFIX_PORT)])
    assert.match(wrong.out, /没有独立引擎/, `停 ${PREFIX_PORT} 时不该找到 ${PORT} 的实例：${wrong.out}`)

    const still = run(['status', '-Port', String(PORT)])
    assert.match(still.out, /运行中：pid \d+/, `前缀端口不该把别人停掉：${still.out}`)
  } finally {
    run(['stop', '-Port', String(PORT)])
  }
})

it('找不到 node 时，提示里的版本要求和 package.json 的 engines 一致', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const wanted = pkg.engines.node
  // 把 PATH 与几个候选目录都指到空处，让 Resolve-Node 走到最后那句 throw
  const empty = mkdtempSync(join(tmpdir(), 'nebula-sidecar-'))
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, 'start', '-Port', String(PORT)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'),
      USERPROFILE: empty,
      LOCALAPPDATA: empty,
      DSH_HOME: empty,
      ProgramFiles: join(empty, 'nope'),
      'ProgramFiles(x86)': join(empty, 'nope'),
    },
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  rmSync(empty, { recursive: true, force: true })
  assert.notEqual(r.status, 0, '找不到 node 时应当失败')
  assert.match(out, /找不到 node/, out)
  assert.ok(out.includes(wanted), `提示里应当写 engines 的值 ${wanted}：${out}`)
  assert.ok(!out.includes('22.13'), '提示里不该再出现旧的 22.13+')
})

it('指定一个不存在的 node 路径时，报的是那个路径，不是版本号', () => {
  const r = run(['start', '-Port', String(PORT), '-Node', join(ROOT, 'no-such-node.exe')])
  assert.notEqual(r.code, 0, '指到不存在的 node 时应当失败')
  assert.match(r.out, /指定的 node 不存在/, r.out)
  assert.match(r.out, /no-such-node\.exe/, '错误信息里要带上用户给的那个路径')
})
