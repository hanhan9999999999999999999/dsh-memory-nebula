// 发布正文也要有契约：Release 页面是别人第一次看见这一版的地方。
// 1.11.68 / 1.11.69 的正文都只有一行 --generate-notes 生成的 compare 链接，
// 而 CHANGELOG 里明明写着改了什么。这里钉住取段落的规则，免得哪天又静默贴空。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNotes, extractSection, normalizeVersion, repoSlug } from '../scripts/release-notes.mjs'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = resolve(PKG, 'scripts/release-notes.mjs')

const SAMPLE = [
  '# 变更记录',
  '',
  '## 1.2.0 — 2026-01-02',
  '',
  '**这版做了 B**',
  '',
  '- 第二段正文',
  '',
  '## 1.1.0 — 2026-01-01',
  '',
  '**这版做了 A**',
  '',
].join('\n')

test('取到的那一段到下一个 ## 为止，不把下一版带进来', () => {
  const s = extractSection(SAMPLE, '1.2.0')
  assert.equal(s.heading, '## 1.2.0 — 2026-01-02')
  assert.match(s.body, /这版做了 B/)
  assert.match(s.body, /第二段正文/)
  assert.ok(!s.body.includes('这版做了 A'))
  assert.ok(!s.body.includes('## 1.1.0'))
})

test('版本号按字面匹配：1.1 不会命中 1.1.0，1.1.0 也不会被 1.1.01 抢走', () => {
  assert.equal(extractSection(SAMPLE, '1.1'), null)
  assert.match(extractSection(SAMPLE, '1.1.0').body, /这版做了 A/)
  const tricky = '## 1.1.01 — x\n\nA\n\n## 1.1.0 — y\n\nB\n'
  assert.match(extractSection(tricky, '1.1.0').body, /^B$/)
})

test('v 前缀与空白会被归一，CRLF 也能取', () => {
  assert.equal(normalizeVersion(' v1.2.0 \n'), '1.2.0')
  const crlf = SAMPLE.replace(/\n/g, '\r\n')
  assert.match(extractSection(crlf, 'v1.2.0').body, /第二段正文/)
  assert.ok(!extractSection(crlf, '1.2.0').body.includes('\r'))
})

test('找不到这一版返回 null，buildNotes 直接抛错而不是贴一段空正文', () => {
  assert.equal(extractSection(SAMPLE, '9.9.9'), null)
  assert.throws(
    () => buildNotes({ changelog: SAMPLE, version: '9.9.9', repo: 'o/n' }),
    /CHANGELOG\.md 里没有 9\.9\.9/
  )
})

test('正文标题归一成 ## <version>，结尾给安装行与 CHANGELOG 入口', () => {
  const notes = buildNotes({ changelog: SAMPLE, version: '1.2.0', repo: 'owner/name' })
  assert.match(notes, /^## 1\.2\.0\n\n\*\*这版做了 B\*\*/)
  assert.match(notes, /npm i dsh-memory-nebula@1\.2\.0/)
  assert.match(notes, /https:\/\/github\.com\/owner\/name\/blob\/main\/CHANGELOG\.md/)
  assert.ok(!notes.includes('1.2.0 — 2026-01-02'), '标题里的日期不该被带进正文')
  assert.ok(notes.endsWith('\n'))
  const noRepo = buildNotes({ changelog: SAMPLE, version: '1.2.0' })
  assert.ok(!noRepo.includes('blob/main'))
})

test('仓库短名从 package.json 的 repository.url 里取', () => {
  assert.equal(repoSlug({ repository: { url: 'git+https://github.com/o/n.git' } }), 'o/n')
  assert.equal(repoSlug({ repository: { url: 'https://github.com/o/n' } }), 'o/n')
  assert.equal(repoSlug({ repository: 'github:o/n' }), 'o/n')
  assert.equal(repoSlug({}), '')
})

test('CLI：--check 认当前版本，缺版本以 1 退出并说明标题该怎么写', () => {
  const ok = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: PKG, encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /的正文 \d+ 字符/)

  const bad = spawnSync(process.execPath, [SCRIPT, '--version', '0.0.0'], { cwd: PKG, encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /## 0\.0\.0 — 日期/)
})

test('CLI：--out 写文件，内容与 stdout 一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-'))
  try {
    const out = join(dir, 'notes.md')
    const r = spawnSync(process.execPath, [SCRIPT, '--out', out], { cwd: PKG, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(out))
    const text = readFileSync(out, 'utf8')
    const stdout = spawnSync(process.execPath, [SCRIPT], { cwd: PKG, encoding: 'utf8' })
    assert.equal(text, stdout.stdout)
    assert.match(text, /^## \d+\.\d+\.\d+/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('发布流程用的是 CHANGELOG 正文，不是 --generate-notes', () => {
  const wf = readFileSync(resolve(PKG, '.github/workflows/release.yml'), 'utf8')
  assert.match(wf, /node scripts\/release-notes\.mjs --version "\$\{GITHUB_REF_NAME#v\}"/)
  assert.match(wf, /--notes-file notes\.md/)
  assert.ok(!wf.includes('--generate-notes'), 'Release 正文不该退回自动生成的 compare 链接')
})

test('CHANGELOG 顶部这一版有正文（不是只有标题的分隔线）', () => {
  const changelog = readFileSync(resolve(PKG, 'CHANGELOG.md'), 'utf8')
  const pkg = JSON.parse(readFileSync(resolve(PKG, 'package.json'), 'utf8'))
  const s = extractSection(changelog, pkg.version)
  assert.ok(s, 'CHANGELOG 里没有当前版本 ' + pkg.version + ' 的段落')
  assert.ok(s.body.length > 200, '这一版的正文只有 ' + s.body.length + ' 字符，太像占位')
})
