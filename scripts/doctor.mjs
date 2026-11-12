#!/usr/bin/env node
/**
 * 安装体检 CLI：`node scripts/doctor.mjs [--profile DIR] [--root DIR] [--base URL] [--json]`。
 *
 * 只读；退出码 1 只在出现 fail 时返回，warn 不影响安装流程。
 */

import { runDoctor, formatDoctor } from '../lib/host/doctor.js'

function usage() {
  return [
    'usage: node scripts/doctor.mjs [options]',
    '',
    '  --profile DIR   DSH profile 目录（含 package.json），检查依赖与 bundles',
    '  --root DIR      额外的记忆库根目录，可重复',
    '  --base URL      已运行实例的 API 根，如 http://127.0.0.1:7891/api/memory-nebula',
    '  --token TOKEN   standalone 的本机口令；也可用 NEBULA_TOKEN 环境变量',
    '  --json          输出机器可读 JSON',
    '  --lang en       英文提示',
    '  --help          显示本页',
  ].join('\n')
}

function parseArgs(argv) {
  const opts = { roots: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--json') opts.json = true
    else if (a === '--profile') opts.profile = argv[++i]
    else if (a === '--root') opts.roots.push(argv[++i])
    else if (a === '--base') opts.base = argv[++i]
    else if (a === '--token') opts.token = argv[++i]
    else if (a === '--lang') opts.lang = argv[++i]
    else if (!a.startsWith('-') && !opts.profile) opts.profile = a
    else {
      console.error('unknown option: ' + a)
      opts.help = true
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log(usage())
  process.exit(0)
}
const report = await runDoctor({ ...opts, token: opts.token || process.env.NEBULA_TOKEN || '' })
if (opts.json) console.log(JSON.stringify(report, null, 2))
else console.log(formatDoctor(report, { lang: opts.lang }))
process.exit(report.ok ? 0 : 1)
