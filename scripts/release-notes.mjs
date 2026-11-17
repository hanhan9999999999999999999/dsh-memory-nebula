/**
 * 发布正文：从 CHANGELOG 里取这一版那一段，别让 Release 页面只剩一行 compare 链接。
 *
 * 1.11.68 与 1.11.69 的 GitHub Release 正文都是 `gh release create --generate-notes`
 * 自动生成的一行 `**Full Changelog**: …/compare/v1.11.67...v1.11.68`。写给人看的内容
 * 其实早就写好了——CHANGELOG.md 里每一版都是一整段（改了什么、为什么改、什么教训），
 * 只是发布流程没去取它。于是「这一版修了什么」在仓库里有、在发布页没有，装包的人
 * 打开 Release 只看见一个链接。
 *
 * 这里的规则：
 *   - 版本段落只认标题行 `## <version>`（后面可以跟 ` — 日期`），不做语义猜测。
 *   - 版本号按字面匹配：`1.11.7` 不会吃掉 `1.11.70`。
 *   - 取到下一个 `## ` 之前；找不到这一段就报错退出，不退化成一次「空白发布」。
 *   - 结尾补一行安装入口与 CHANGELOG 链接——读者不用回仓库里翻。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 版本号去掉前缀 v，便于 tag（v1.11.70）与 package.json（1.11.70）两处通用。 */
export function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/, '')
}

/**
 * 从 CHANGELOG 里取出某一版的段落：`{ heading, body }`；没有这一版返回 null。
 * heading 是原始标题行（含日期），body 是去掉标题后、到下一个 `## ` 之前的正文。
 */
export function extractSection(changelog, version) {
  const want = normalizeVersion(version)
  if (!want) return null
  const lines = String(changelog).replace(/\r\n/g, '\n').split('\n')
  const head = new RegExp('^##\\s+' + escapeRe(want) + '(?=\\s|$)')
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (head.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return {
    heading: lines[start].trim(),
    body: lines
      .slice(start + 1, end)
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, ''),
  }
}

/** 仓库短名 owner/name，从 package.json 的 repository.url 里取。 */
export function repoSlug(pkg) {
  const raw = typeof pkg === 'string' ? pkg : (pkg && pkg.repository && (pkg.repository.url || pkg.repository)) || ''
  const s = String(raw).trim()
  const short = s.match(/^(?:github:|npm:)([^/]+\/[^/#]+)$/)
  if (short) return short[1].replace(/\.git$/, '')
  if (/^[^/:]+\/[^/]+$/.test(s)) return s
  const m = s.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/)
  return m ? m[1] + '/' + m[2] : ''
}

/**
 * 拼出要写进 Release 的正文。取不到段落直接抛错——发布页宁可红一次，
 * 也不要静默地贴一段空正文。
 */
export function buildNotes({ changelog, version, repo }) {
  const want = normalizeVersion(version)
  const section = extractSection(changelog, want)
  if (!section) {
    throw new Error(
      'CHANGELOG.md 里没有 ' + want + ' 那一段（标题要写成「## ' + want + ' — 日期」）'
    )
  }
  const parts = ['## ' + want, '', section.body]
  const links = []
  if (repo) {
    links.push('[全部版本与逐版说明](https://github.com/' + repo + '/blob/main/CHANGELOG.md)')
  }
  parts.push('', '---', '')
  parts.push('安装：`npm i dsh-memory-nebula@' + want + '`' + (links.length ? ' · ' + links.join(' · ') : ''))
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n'
}

const readMe = [
  '用法：node scripts/release-notes.mjs [选项]',
  '',
  '  从 CHANGELOG.md 取当前版本（或 --version 指定的版本）那一段，',
  '  打印成 GitHub Release 的正文；发布流程用 --out 写成文件后交给 gh。',
  '',
  '选项：',
  '  --version <v>   取哪一版，默认读 package.json 的 version（v 前缀可有可无）',
  '  --repo <o/n>    仓库短名，默认从 package.json 的 repository 里取',
  '  --out <file>    写到文件，不打印',
  '  --check         只检查这一版的段落在不在，打印字符数',
  '  --help          显示这段说明',
].join('\n')

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf('--' + name)
    return i >= 0 ? argv[i + 1] : ''
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(readMe)
    return 0
  }
  const pkg = JSON.parse(readFileSync(resolve(PKG, 'package.json'), 'utf8'))
  const version = normalizeVersion(opt('version') || pkg.version)
  const repo = opt('repo') || repoSlug(pkg)
  const changelog = readFileSync(resolve(PKG, 'CHANGELOG.md'), 'utf8')
  let notes
  try {
    notes = buildNotes({ changelog, version, repo })
  } catch (err) {
    console.error(err.message)
    return 1
  }
  if (argv.includes('--check')) {
    const section = extractSection(changelog, version)
    console.log('✔ ' + version + ' 的正文 ' + notes.length + ' 字符（CHANGELOG 段 ' + section.body.length + ' 字符）')
    return 0
  }
  const out = opt('out')
  if (out) {
    writeFileSync(resolve(out), notes, 'utf8')
    console.log('✔ ' + notes.length + ' 字符 → ' + resolve(out))
    return 0
  }
  process.stdout.write(notes)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
