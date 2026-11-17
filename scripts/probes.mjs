/**
 * 验收探针与临时测试库住在哪里——一处算清，别在编排脚本里猜。
 *
 * 1.11.66 把 `REPO` 改回包目录是对的（以前指着包的上一层，跑的是别人的代码）。
 * 但同一次改动把「探针只在包内 dev/」也当成了事实：维护机上真正在用的那批
 * `verify-*.mjs` 住在工作区那一层（包的上一级）的 dev/ 里，于是包内 dev/ 虽然有
 * 385 个文件，却一个验收探针都没有，`npm run verify:full` 六步全红，摘要里写着
 * 「仓库里应当有它」——它其实在上一层躺着，好端端的。
 *
 * 这里的规则：
 *   - 候选目录默认是 [包内 dev/, 上一层 dev/]；`--dev <dir>` 可以指定唯一来源，
 *     维护机换布局时不用改代码。
 *   - 每一个探针**按名字**在这几个目录里找，不假设它们整批都在同一处。
 *   - 一个都找不到：有 dev/ 就算失败（探针被删了要红），连 dev/ 都没有才跳过
 *     （装好的副本没带开发探针，跳过是诚实的）。
 *   - 找到的那个文件路径就是最终要跑的东西，调用方把它打印出来——跑之前先说清
 *     用的是哪一份，别让人对着一个数字猜。
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const has = (p) => existsSync(p)
const isDir = (p) => has(p) && statSync(p).isDirectory()

/** 候选探针目录：`--dev` 优先，否则 [包内 dev, 上一层 dev]。 */
export function probeDirs(repo, opts = {}) {
  if (opts.dev) return [resolve(opts.dev)]
  return [join(repo, 'dev'), join(dirname(repo), 'dev')]
}

/** 真正存在的候选目录（保持顺序，去重）。 */
export function existingProbeDirs(repo, opts = {}) {
  const out = []
  for (const d of probeDirs(repo, opts)) if (isDir(d) && !out.includes(d)) out.push(d)
  return out
}

/** 某个探针的绝对路径；找不到返回 null。 */
export function findProbe(name, dirs) {
  for (const d of dirs) {
    const p = join(d, name)
    if (has(p)) return p
  }
  return null
}

/**
 * 一步的判定：`{ state, file, why }`
 *   state = 'ok'   → file 是要跑的那份
 *           'fail' → 有 dev/ 但没有这个探针（被删了）
 *           'skip' → 一个 dev/ 都没有（装好的副本）
 */
export function probePlan(name, dirs) {
  const file = findProbe(name, dirs)
  if (file) return { state: 'ok', file, why: '' }
  if (dirs.length) {
    return { state: 'fail', file: null, why: name + ' 不在 ' + dirs.join(' / ') + ' 里（仓库里应当有它）' }
  }
  return { state: 'skip', file: null, why: '没有 dev/' + name + '（这个副本没带开发探针）' }
}

/**
 * 默认测试库的位置：包内 `.tmp-50k` 优先，其次上一层（工作区）的同名目录。
 * 两处都没有时返回包内那个——报错信息里写的是一个用户真能去看的路径。
 */
export function pickFixtureRoot(repo, name = '.tmp-50k') {
  const local = join(repo, name)
  if (isDir(local)) return local
  const up = join(dirname(repo), name)
  if (isDir(up)) return up
  return local
}
