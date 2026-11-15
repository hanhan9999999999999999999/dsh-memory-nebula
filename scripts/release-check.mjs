#!/usr/bin/env node
// 发布前静态体检：不联网、不启服务，只读仓库。
// 用法：node scripts/release-check.mjs
// 退出码 0 = 全过；1 = 有问题（逐条打印）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []
const fail = (m) => problems.push(m)
const ok = (m) => notes.push(m)

const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const existsReal = (p) => existsSync(join(ROOT, p))
// dev/ 是本地工作件：.gitignore 整目录忽略，干净克隆（CI、别人的机器）里没有。
// 证据脚本只在本机核对，缺失记一条备注，不当发布门禁（1.11.41 修：否则 CI 永远红）。
const isDev = (p) => p === 'dev' || p.startsWith('dev/') || p.startsWith('../dev/')
const exists = (p) => (isDev(p) ? true : existsReal(p))
const readDev = (p) => (existsReal(p) ? readFileSync(join(ROOT, p), 'utf8') : '')
const noteDev = (p) => { if (!existsReal(p)) notes.push('（本地证据脚本不在干净克隆里：' + p + '）') }
const list = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      list(p, out)
    } else out.push(p)
  }
  return out
}
const rel = (p) => relative(ROOT, p).replaceAll('\\', '/')

// 1. package.json
let pkg
try {
  pkg = JSON.parse(read('package.json'))
} catch (err) {
  console.error('package.json 不是合法 JSON：' + err.message)
  process.exit(1)
}
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) fail(`版本号不合规：${pkg.version}`)
if (pkg.license !== 'MIT') fail('license 应为 MIT')
if (!pkg.engines?.node) fail('engines.node 缺失')
for (const p of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', 'scripts/smoke.mjs', 'sidecar.ps1', 'docs/testing.md', 'docs/security.md', 'docs/release.md']) {
  if (!exists(p)) fail(`必需文件缺失：${p}`)
}
for (const p of pkg.files || []) {
  if (!exists(p) && !exists(p.replace(/\/$/, ''))) fail(`files 里列了不存在的路径：${p}`)
}
for (const p of ['lib', 'docs', 'scripts']) {
  if (!(pkg.files || []).includes(p)) fail(`files 缺 ${p}`)
}
if ((pkg.files || []).includes('test')) fail('files 不应包含 test（单测不进包）')
if (!pkg.scripts?.test || !pkg.scripts?.smoke || !pkg.scripts?.check) fail('scripts 缺 test/smoke/check')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch 配置不对')
ok(`package.json v${pkg.version}`)

// 2. 版本一致性
const changelog = read('CHANGELOG.md')
const top = changelog.match(/^## (\d+\.\d+\.\d+)/m)
if (!top) fail('CHANGELOG 没有版本标题')
else if (top[1] !== pkg.version) fail(`CHANGELOG 顶部 ${top[1]} ≠ package.json ${pkg.version}`)
else ok(`CHANGELOG ${top[1]}`)

// 页脚也报版本：写死的那份必须跟包一致，否则用户报 bug 时说的是错版本。
const appJs = read('lib/web/app.js')
const appVer = appJs.match(/const APP_VERSION = '([^']+)'/)
if (!appVer) fail('lib/web/app.js 里找不到 APP_VERSION')
else if (appVer[1] !== pkg.version) fail(`APP_VERSION ${appVer[1]} ≠ package.json ${pkg.version}`)
else ok(`APP_VERSION ${appVer[1]}`)

// 3. UTF-8 完整性（不要出现替换符，常见于 GBK 误读后回写）
const textExt = /\.(m?js|json|md|yml|yaml|html|css|ps1|txt)$/i
const files = list(ROOT).filter((p) => textExt.test(p) && !p.includes('node_modules'))
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  if (src.includes('\uFFFD')) fail(`UTF-8 里有替换符（\uFFFD）：${rel(f)}`)
}
ok(`UTF-8 扫描 ${files.length} 个文本文件`)

// Windows PowerShell 5.1 没有 BOM 就按 ANSI 读 .ps1，中文会变成乱码并直接语法错误。
const psBytes = readFileSync(resolve(ROOT, 'sidecar.ps1'))
if (!(psBytes[0] === 0xef && psBytes[1] === 0xbb && psBytes[2] === 0xbf)) {
  fail('sidecar.ps1 缺 UTF-8 BOM：Windows PowerShell 5.1 会读坏中文')
} else ok('sidecar.ps1 带 UTF-8 BOM')

// 4. node --check
const codeFiles = files.filter((p) => /\.(m?js)$/i.test(p) && !p.includes('node_modules'))
for (const f of codeFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  if (r.status !== 0) fail(`语法错误：${rel(f)}\n${(r.stderr || '').trim().split('\n').slice(0, 4).join('\n')}`)
}
ok(`node --check ${codeFiles.length} 个脚本`)

// 5. 相对 import 可解析
for (const f of codeFiles) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(f), m[1])
    if (!existsSync(target)) fail(`import 指向不存在的文件：${rel(f)} → ${m[1]}`)
  }
}

// 6. lib 里不留调试痕迹
for (const f of codeFiles.filter((p) => p.includes(`${'lib'}`))) {
  const src = readFileSync(f, 'utf8')
  const name = rel(f)
  if (name.endsWith('standalone.mjs')) continue // CLI 输出本来就走 stdout
  const noisy = src
    .split('\n')
    .filter((line) => /\bconsole\.(log|debug|warn)\s*\(/.test(line) && !line.includes('__NEBULA_DEBUG__'))
  if (noisy.length) fail(`lib 里残留 console 输出：${name}（${noisy.length} 处）`)
  if (/\b(TODO|FIXME|XXX)\b/.test(src)) fail(`lib 里残留 TODO/FIXME：${name}`)
}
for (const f of files.filter((p) => /\.(m?js|html|css)$/i.test(p) && rel(p).startsWith('lib/'))) {
  const src = readFileSync(f, 'utf8')
  if (/Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]/i.test(src)) fail(`通配 CORS：${rel(f)}`)
  if (src.includes('document.write')) fail(`还在用 document.write：${rel(f)}`)
}

// 7. 死文件
for (const p of ['lib/host/graph.debug.js', 'lib/host/hygiene.js']) {
  if (exists(p)) fail(`死文件仍在：${p}`)
}

// 8. Markdown 相对链接
const mdFiles = files.filter((p) => p.endsWith('.md'))
for (const f of mdFiles) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = m[1]
    if (/^(https?:|mailto:|#|<)/i.test(href)) continue
    const path = href.split('#')[0]
    if (!path) continue
    const target = resolve(dirname(f), decodeURI(path))
    if (!existsSync(target)) fail(`Markdown 链接指向不存在的路径：${rel(f)} → ${href}`)
  }
}
ok(`Markdown 相对链接检查 ${mdFiles.length} 个文件`)

// 9. index.html 引用的本地脚本/样式都在
const html = read('lib/web/index.html')
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const href = m[1]
  if (/^(https?:|data:|#|mailto:)/i.test(href)) continue
  if (!existsSync(join(ROOT, 'lib/web', href.split('?')[0]))) fail(`index.html 引用了不存在的资源：${href}`)
}

// 10. 三条腿都能自报版本
for (const p of ['lib/index.js', 'lib/standalone.mjs']) {
  const src = read(p)
  if (!src.includes('VERSION') && !src.includes('version')) fail(`${p} 没有暴露版本`)
}

// 11. 「第一束光」的三个构件：示例、空态、单文件快照
for (const p of ['lib/host/demo.js', 'lib/host/share.js']) {
  if (!exists(p)) fail(`0.5.0 构件缺失：${p}`)
}
if (exists('lib/host/demo.js')) {
  const demo = read('lib/host/demo.js')
  for (const name of ['DEMO_MEMORIES', 'DEMO_LEDGERS', 'DEMO_INVENTORY', 'DEMO_SIGNATURE']) {
    if (!demo.includes(`export const ${name}`)) fail(`demo.js 缺导出：${name}`)
  }
}
if (exists('lib/host/share.js')) {
  const share = read('lib/host/share.js')
  if (!share.includes('export async function buildShareHtml')) fail('share.js 没导出 buildShareHtml')
  if (!share.includes('__NEBULA_SNAPSHOT__')) fail('share.js 没注入快照数据')
  if (!share.includes('u003c')) fail('share.js 没做 JSON 尖括号转义')
  for (const name of ['parseShareScope', 'parseShareHops', 'sliceShareGraph']) {
    if (!share.includes(`export function ${name}`)) fail(`share.js 缺导出：${name}`)
  }
  if (!share.includes("kind: 'all'")) fail('share.js 没处理整图范围')
}
const httpSrc = read('lib/host/http.js')
if (!httpSrc.includes("'/share'") && !httpSrc.includes('"/share"')) fail('http.js 没有 /share 路由')
if (!httpSrc.includes('demoInstance')) fail('http.js 没有示例实例入口')
if (!httpSrc.includes('parseShareScope')) fail('http.js 没有接 /share 的 scope 参数')
const webApp = read('lib/web/app.js')
if (!webApp.includes('API.snapshot')) fail('app.js 没有识别快照模式')
if (!webApp.includes('enterDemo')) fail('app.js 没有示例入口')
if (!read('lib/web/index.html').includes('id="demobar"')) fail('index.html 缺模式条 #demobar')
const appSrc = read('lib/web/app.js')
if (!appSrc.includes('html-ws') || !appSrc.includes('html-focus')) fail('app.js 缺范围导出菜单项')
const shareSrc = read('lib/host/share.js')
if (!shareSrc.includes('export function parseShareHide')) fail('share.js 缺 hide 解析')
if (!shareSrc.includes('publicSources') || !shareSrc.includes('publicOverview')) fail('share.js 没脱敏来源/概览')
if (!httpSrc.includes('parseShareHide')) fail('http.js 没接 hide 参数')
if (!webApp.includes('showOnboard') || !webApp.includes('ONBOARD_KEY')) fail('app.js 缺新手三步')
if (!read('lib/web/index.html').includes('hide-diary')) fail('index.html 缺「隐去日记」开关')
ok('0.5.0 构件：示例 / 空态 / 快照')
ok('0.6.0 构件：范围快照 / 三档导出')
if (!appSrc.includes('function clearSearch')) fail('app.js 缺搜索清空')
if (!appSrc.includes('nebula:enter-demo')) fail('app.js 缺搜索空态示例入口')
if (!appSrc.includes('seed-note')) fail('app.js 缺扩散解释')
if (!read('lib/web/style.css').includes('.seed-note')) fail('style.css 缺扩散解释样式')
ok('0.7.0 构件：隐藏规则 / 新手三步')
ok('0.7.1 构件：搜索空态出口 / 扩散解释')
const renderSrc = read('lib/web/render.js')
if (!renderSrc.includes('state.nodes.length > 3000')) fail('render.js 缺大图跳过力导向')
if (!renderSrc.includes('ticksTarget')) fail('render.js 缺按规模缩放的生长轮次')
if (!read('scripts/bench.mjs').includes('--share-out')) fail('bench.mjs 缺快照输出')
if (!/\*\*\d{3}[–-]\d{3}ms\*\*/.test(read('docs/benchmarks.md'))) fail('benchmarks.md 缺首屏实测')
if (!JSON.parse(read('package.json')).scripts.bench) fail('package.json 缺 bench 脚本')
ok('0.8.0 构件：万条基准 / 大图直出')
const webIndex = read('lib/web/index.html')
if (!read('lib/web/i18n.js').includes('window.NebulaI18n')) fail('i18n.js 缺 NebulaI18n')
if (!webIndex.includes('i18n.js')) fail('index.html 没加载 i18n.js')
if (!webIndex.includes('data-zh="退出示例"')) fail('index.html 缺模式条中文源文')
if (!appSrc.includes("T('示例星系')")) fail('app.js 模式条没走翻译')
if (!read('lib/host/share.js').includes('i18n.js')) fail('share.js 没内联 i18n.js')
if (!read('lib/web/style.css').includes('html.lang-en')) fail('style.css 缺英文排版')
ok('0.9.0 构件：中英双语 / 快照内联')
const diagSrc = read('lib/host/diagnostics.js')
if (!diagSrc.includes('export function buildDiagnostics')) fail('diagnostics.js 缺 buildDiagnostics')
if (!diagSrc.includes('export function formatDiagnostics')) fail('diagnostics.js 缺 formatDiagnostics')
if (!httpSrc.includes("'/diagnostics'")) fail('http.js 没接 /diagnostics')
if (!httpSrc.includes('buildDiagnostics')) fail('http.js 没用 buildDiagnostics')
if (!read('lib/standalone.mjs').includes('--diagnose')) fail('standalone.mjs 缺 --diagnose')
if (!appSrc.includes('diagnosticsText') || !appSrc.includes('copyDiagnostics')) fail('app.js 缺复制诊断')
if (!read('docs/compatibility.md').includes('已验证')) fail('docs/compatibility.md 缺实测矩阵')
if (!read('docs/distribution.md').includes('发布检查')) fail('docs/distribution.md 缺发布检查')
if (!read('README.md').includes('docs/compatibility.md')) fail('README.md 没链接兼容矩阵')
ok('1.0.0 构件：诊断 / 兼容矩阵 / 分发文档')
const doctorSrc = read('lib/host/doctor.js')
if (!doctorSrc.includes('export async function runDoctor')) fail('doctor.js 缺 runDoctor')
if (!doctorSrc.includes('export function checkProfile')) fail('doctor.js 缺 checkProfile')
if (!read('scripts/doctor.mjs').includes('runDoctor')) fail('doctor.mjs 没调用 runDoctor')
if (!pkg.scripts?.doctor) fail('package.json 缺 doctor 脚本')
if (!pkg.bin?.['memory-nebula-doctor']) fail('package.json 缺 doctor bin')
if (!read('docs/distribution.md').includes('装完先体检')) fail('distribution.md 缺 doctor 体检段')
if (!read('README.md').includes('doctor.mjs')) fail('README.md 没提 doctor')
ok('1.1.0 构件：安装体检 / doctor CLI / 文档')
const market = JSON.parse(read('market/index.json'))
if (market.format !== 1) fail('market/index.json 不是 format 1')
if (!market.title?.en) fail('market/index.json 缺英文标题')
const marketEntry = market.plugins?.find((entry) => entry.name === pkg.name)
if (!marketEntry) fail('market/index.json 没有本包条目')
if (!marketEntry.versions?.some((version) => version.version === pkg.version)) {
  fail(`market/index.json 没声明当前版本 ${pkg.version}`)
}
if (!read('market/assets/icon.svg').includes('<svg')) fail('market 图标缺失或不是 SVG')
if (!read('locale/zh.json').includes('docs/market.zh.md')) fail('locale/zh.json 没指向中文详情')
if (!read('locale/en.json').includes('docs/market.en.md')) fail('locale/en.json 没指向英文详情')
if (!read('docs/market.zh.md').includes(`dsh-memory-nebula@${pkg.version}`)) fail('中文详情缺市场索引步骤')
if (!read('docs/market.zh.md').includes('https://unpkg.com/')) fail('中文详情没走 unpkg 索引')
if (!read('docs/market.en.md').includes('https://unpkg.com/')) fail('英文详情没走 unpkg 索引')
if (!pkg.files?.includes('market') || !pkg.files?.includes('locale')) fail('package.json files 没带 market/locale')
ok('1.1.2 构件：市场索引 / unpkg / 双语详情 / 图标')

const ciSrc = read('.github/workflows/ci.yml')
// 1.11.41：下限提到 22.15（node:zlib 的 zstd、node:sqlite 都在这一版可用）
if (!ciSrc.includes("'22.15.0'") || !ciSrc.includes("'24'")) fail('CI 矩阵缺 Node 22.15/24')
if (!ciSrc.includes('npm run check')) fail('CI 没跑 release-check')
if (!pkg.repository?.url?.includes('github.com/hanhan9999999999999999999/dsh-memory-nebula')) fail('package.json 缺 repository')
if (!pkg.homepage?.includes('github.com/hanhan9999999999999999999/dsh-memory-nebula')) fail('package.json 缺 homepage')
if (!pkg.bugs?.url?.endsWith('/issues')) fail('package.json 缺 bugs.url')
if (!read('SECURITY.md').includes('private vulnerability reporting')) fail('SECURITY.md 缺报告入口')
if (!read('CONTRIBUTING.md').includes('npm run check')) fail('CONTRIBUTING.md 缺检查命令')
if (!read('README.md').includes('actions/workflows/ci.yml/badge.svg')) fail('README.md 缺 CI badge')
if (!pkg.files?.includes('SECURITY.md') || !pkg.files?.includes('CONTRIBUTING.md')) fail('package.json files 没带政策文档')
ok('1.1.3 构件：仓库元数据 / CI / 安全与贡献文档')

if (!read('lib/host/doctor.js').includes('checkVersionDrift')) fail('doctor 缺版本漂移检查')
if (!ciSrc.includes('Package install')) fail('CI 缺打包安装 job')
if (!read('test/doctor.test.mjs').includes('running host')) fail('doctor 测试缺版本漂移用例')
if (!read('lib/host/nebula.js').includes("dbPath: this.demo ? ''")) fail('示例 overview 仍会读本机数据库')
ok('1.1.5 构件：示例不碰盘 / 医生版本漂移 / CI 安装门')

if (!read('lib/host/diagnostics.js').includes('formatDiagnostics(d, opts = {})')) fail('diagnostics 不支持语言选项')
if (!read('lib/host/diagnostics.js').includes('contains no memory text')) fail('diagnostics 缺英文说明')
if (!read('lib/host/http.js').includes("url.searchParams.get('format') === 'json'")) fail('/diagnostics 缺 JSON 输出')
if (!read('lib/standalone.mjs').includes("process.argv.includes('--json')")) fail('standalone 缺 --diagnose --json')
if (!read('test/diagnostics.test.mjs').includes('英文说明可切换')) fail('缺诊断英文测试')
ok('1.1.6 构件：诊断 JSON / 英文说明 / CLI 机器可读')

const readZh = read('README.md')
const readEn = read('README.en.md')
if (!readZh.includes('raw.githubusercontent.com') || !readEn.includes('raw.githubusercontent.com')) {
  fail('README 图片必须用绝对地址，否则 npm 页面裂图')
}
if (readZh.includes('](./docs/assets/') || readEn.includes('](./docs/assets/')) {
  fail('README 仍含相对图片路径')
}
if (!readZh.includes('/blob/main/README.en.md') || !readZh.includes('/blob/main/LICENSE')) {
  fail('README 的英文入口 / license 链接不是绝对地址')
}
if (!read('CHANGELOG.md').includes('## 1.1.7')) fail('CHANGELOG 缺 1.1.7')
ok('1.1.7 构件：README 绝对图片 / 外链 / 变更记录')

if (!read('lib/host/http.js').includes('export function isLoopbackHost')) fail('缺 Host 围栏')
if (!read('lib/host/http.js').includes('connection.requestRejection(req)')) fail('宿主路由没接 requestRejection')
if (!read('lib/index.js').includes("'connection'")) fail('index.js inject 缺 connection')
if (!read('test/http.test.mjs').includes('DNS rebinding')) fail('缺 Host 围栏测试')
if (!read('docs/security.md').includes('Host 围栏')) fail('安全文档缺 Host 围栏')
ok('1.1.8 构件：Host 围栏 / 宿主 requestRejection / 测试与文档')

if (!read('lib/host/graph.js').includes('const entityPairCap = n > 12000 ? 60 : 120')) {
  fail('缺 2 万条实体配对上限')
}
if (!read('lib/host/graph.js').includes('kwCount')) fail('关键词候选仍保存字符串数组')
if (!read('docs/benchmarks.md').includes('2.53s')) fail('基准文档缺 20k 实测')
if (!read('CHANGELOG.md').includes('## 1.2.0')) fail('CHANGELOG 缺 1.2.0')
ok('1.2.0 构件：2 万条实体配对上限 / 关键词候选瘦身 / 基准与变更记录')

if (!read('lib/web/index.html').includes('data-zh="这里还没有星星"')) {
  fail('空库兜底缺 data-zh')
}
if (!read('lib/web/i18n.js').includes('"这里还没有星星": "No stars here yet"')) {
  fail('i18n 缺空库兜底英文')
}
if (!read('CHANGELOG.md').includes('## 1.2.1')) fail('CHANGELOG 缺 1.2.1')
ok('1.2.1 构件：英文空态兜底 / i18n 文案 / 变更记录')

for (const f of ['SUPPORT.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/PULL_REQUEST_TEMPLATE.md']) {
  if (!exists(f)) fail(`缺少支持入口：${f}`)
}
if (!read('README.md').includes('SUPPORT.md') || !read('README.en.md').includes('SUPPORT.md')) {
  fail('README 没链到 SUPPORT.md')
}
ok('支持入口：SUPPORT / issue 表单 / PR 模板 / README 链接')

if (!exists('docs/index.html') || !exists('docs/.nojekyll')) fail('缺少官网首页或 .nojekyll')
if (!read('docs/index.html').includes('assets/preview-en.jpg')) fail('官网首页没引用英文主图')
if (!exists('docs/demo.html')) fail('缺示例页 docs/demo.html')
if (!read('docs/demo.html').includes('__NEBULA_SNAPSHOT__')) fail('示例页不是离线快照')
if (!read('docs/index.html').includes('demo.html?lang=en')) fail('官网没链到示例页')
if (!read('docs/index.html').includes('Your memories,')) fail('官网首页标题缺失')
if (!read('docs/index.html').includes('rel="canonical"')) fail('官网缺 canonical')
if (!read('docs/index.html').includes('application/ld+json')) fail('官网缺结构化数据')
if (!exists('docs/robots.txt') || !exists('docs/sitemap.xml')) fail('官网缺 robots/sitemap')
if (!read('docs/sitemap.xml').includes('hanhan9999999999999999999.github.io/dsh-memory-nebula')) fail('sitemap URL 不对')
if (!exists('docs/assets/icon.svg') || !read('docs/index.html').includes('assets/icon.svg')) fail('官网图标缺失')
if (!read('README.md').includes('hanhan9999999999999999999.github.io/dsh-memory-nebula') || !read('README.en.md').includes('hanhan9999999999999999999.github.io/dsh-memory-nebula')) {
  fail('README 没链到官网')
}
ok('官网：docs/index.html / .nojekyll / README 入口')

if (!read('lib/host/share.js').includes('function packNodeRows')) fail('share.js 缺节点列压缩')
if (!read('lib/web/api.js').includes('function expandSnapshotNodes')) fail('api.js 缺快照节点展开')
if (!read('CHANGELOG.md').includes('## 1.3.0')) fail('CHANGELOG 缺 1.3.0')
ok('1.3.0 构件：紧凑快照 / 列展开 / 变更记录')

if (!read('lib/standalone.mjs').includes('--share <file>')) fail('standalone 缺 --share')
if (!read('lib/standalone.mjs').includes('parseShareScope')) fail('standalone 没接 scope')
if (!exists('test/standalone.test.mjs')) fail('缺 standalone CLI 测试')
if (!read('CHANGELOG.md').includes('## 1.4.0')) fail('CHANGELOG 缺 1.4.0')
{
  const pkg = JSON.parse(read('package.json'))
  if (pkg.dependencies !== undefined) fail('package.json 不应有运行时依赖')
}
ok('1.4.0 构件：命令行快照 / 零依赖 / CLI 测试 / 变更记录')

for (const f of ['preview-en.jpg', 'demo-en.jpg', 'empty-en.jpg', 'snapshot-en.jpg']) {
  if (!existsSync(join(ROOT, 'docs/assets', f))) fail(`缺英文截图 ${f}`)
}
if (!read('README.en.md').includes('docs/assets/preview-en.jpg')) fail('英文 README 未用英文预览图')
if (!read('docs/market.en.md').includes('assets/snapshot-en.jpg')) fail('英文市场详情未用英文快照图')
if (!read('CHANGELOG.md').includes('## 1.4.1')) fail('CHANGELOG 缺 1.4.1')
ok('1.4.1 构件：英文截图 / 英文 README / 市场详情 / 变更记录')

if (!read('lib/standalone.mjs').includes('--export <file>')) fail('standalone 缺 --export')
if (!read('lib/standalone.mjs').includes("format !== 'md' && format !== 'json'")) fail('--export 没有格式校验')
if (!read('lib/host/nebula.js').includes('exportReport(opts = {})')) fail('缺 exportReport')
if (!read('lib/host/nebula.js').includes("scopeKind === 'focus'")) fail('exportReport 缺 focus 范围')
if (!read('lib/host/http.js').includes("src.exportReport({ format, scope, hops })")) fail('/export 未透传 scope/hops')
if (!read('README.md').includes('--export')) fail('README 未写 --export')
if (!read('CHANGELOG.md').includes('## 1.5.0')) fail('CHANGELOG 缺 1.5.0')
ok('1.5.0 构件：命令行导出 / 范围过滤 / HTTP 400 / 变更记录')

if (!read('lib/host/nebula.js').includes('c.members || []')) fail('范围导出没按 members 重算簇')
if (!read('CHANGELOG.md').includes('## 1.5.1')) fail('CHANGELOG 缺 1.5.1')
ok('1.5.1 构件：切片簇 / 变更记录')

if (!read('lib/host/http.js').includes('sendUnlockPage')) fail('缺少口令登录页')
if (!read('lib/host/http.js').includes("route === '/unlock'")) fail('缺少 /unlock 路由')
if (!read('test/http.test.mjs').includes('/unlock')) fail('缺少口令登录页测试')
if (!read('CHANGELOG.md').includes('## 1.6.1')) fail('CHANGELOG 缺 1.6.1')
ok('1.6.1 构件：口令登录页 / 302 路由 / 变更记录')

if (!read('lib/host/doctor.js').includes("opts.token || ''")) fail('doctor 没把 token 传进 endpoint')
if (!read('scripts/doctor.mjs').includes("'--token'")) fail('doctor CLI 缺 --token')
if (!read('test/doctor.test.mjs').includes('Bearer secret-token-123')) fail('doctor token 测试缺失')
if (!read('CHANGELOG.md').includes('## 1.6.2')) fail('CHANGELOG 缺 1.6.2')
ok('1.6.2 构件：doctor 口令 / 测试 / 变更记录')

if (!read('lib/web/api.js').includes('Promise.resolve(snapData().graph)')) fail('快照 graph 没走展开路径')
if (!read('lib/web/render.js').includes('window.__NEBULA_SNAPSHOT__')) fail('快照没有立即显示节点')
if (!exists('test/snapshot.test.mjs')) fail('缺快照展开回归测试')
if (!read('CHANGELOG.md').includes('## 1.6.3')) fail('CHANGELOG 缺 1.6.3')
ok('1.6.3 构件：快照展开 / 立即出图 / 回归测试')

if (!read('lib/standalone.mjs').includes("const demo = process.argv.includes('--demo')")) fail('standalone 服务器没接 demo')
if (!read('lib/host/http.js').includes('Boolean(src.demo)')) fail('ping/graph 没报告引擎 demo')
if (!read('test/standalone.test.mjs').includes('reports the demo graph')) fail('缺 demo 服务器回归')
if (!read('CHANGELOG.md').includes('## 1.6.4')) fail('CHANGELOG 缺 1.6.4')
ok('1.6.4 构件：demo 服务器 / demo 标记 / 回归测试')

// 1.7.0：键盘与读屏。门要盯住「以后有人删了键盘层，测试还得红」，
// 所以断言的是结构 + 测试文件同时在位，而不是只查 CHANGELOG 有没有写。
if (!exists('lib/web/nav.js')) fail('1.7.0 缺 lib/web/nav.js')
if (!exists('test/nav.test.mjs')) fail('1.7.0 缺导航几何单测')
if (!exists('test/a11y.test.mjs')) fail('1.7.0 缺可访问性结构门')
if (!exists('docs/accessibility.md')) fail('1.7.0 缺 docs/accessibility.md')
if (!read('lib/web/index.html').includes('id="skykeys"')) fail('键盘层 #skykeys 丢了')
if (!read('lib/web/index.html').includes('id="a11y-live"')) fail('aria-live 播报区丢了')
if (!read('lib/web/index.html').includes('id="a11y-index"')) fail('纯文本索引丢了')
if (!read('lib/web/style.css').includes('.sr-only')) fail('style.css 缺 .sr-only')
if (!read('lib/web/index.html').includes('class="skip-link"')) fail('1.7.0 缺跳过链接 .skip-link')
if (!read('lib/web/style.css').includes('.skip-link:focus')) fail('跳过链接没有可见的焦点样式')
if (!read('lib/web/app.js').includes('function bindKeyboardNav')) fail('键盘没接线')
if (!read('lib/web/app.js').includes('function renderA11yIndex')) fail('索引没接线')
if (!read('lib/web/render.js').includes('api.zoomBy')) fail('2D 缺 zoomBy')
if (!read('lib/web/space3d.js').includes('zoomBy(factor)')) fail('3D 缺 zoomBy')
if (!read('lib/host/share.js').includes("'nav.js'")) fail('单文件快照没内联 nav.js')
if (!read('lib/host/http.js').includes("'nav.js'")) fail('独立引擎静态白名单漏了 nav.js')
if (!read('README.md').includes('docs/accessibility.md')) fail('README 没链到可访问性文档')
if (!read('docs/index.html').includes('Keyboard / screen reader')) fail('官网没有键盘/读屏卡片')
if (!read('docs/interface.md').includes('accessibility.md')) fail('interface 文档没链到可访问性说明')
if (!read('CHANGELOG.md').includes('## 1.7.0')) fail('CHANGELOG 缺 1.7.0')
if (!read('docs/release.md').includes('1.7.0 实测')) fail('release.md 缺 1.7.0 实测记录')
if (!read('docs/verified.md').includes('c6e9f8d50ca69da34c1d266ce3e8a0f5f26fd7bebf3a11bf2296c639a6be3d66')) fail('verified.md 缺 1.7.0 产物 sha256')
if (!read('lib/web/index.html').includes('<main id="app">')) fail('1.7.0 缺 main 地标')
if (!read('lib/web/app.js').includes("setAttribute('data-zh-aria', '最小连接强度')")) fail('连接强度滑杆缺可翻译的 aria 标签')
if (!read('lib/web/app.js').includes("setAttribute('aria-label', T('最低重要度'))")) fail('重要度滑杆缺 aria-label')
if (!read('docs/index.html').includes('--faint:#8a94a6')) fail('官网弱文字对比度没提到 4.5:1 以上')
if (!read('docs/index.html').includes('class="shots reveal" role="region" tabindex="0"')) fail('官网截图条键盘不可达')
if (!read('docs/verified.md').includes('axe-core 4.10.2')) fail('verified.md 缺 axe 审计记录')
ok('1.7.0 构件：键盘层 / 读屏索引 / 两个渲染器 / 快照内联 / 文档与测试')

// 1.8.0：传输契约。门要盯住「以后有人把压缩/304 拆了、把 413 退回裸 destroy、
// 把 /export 的校验放宽成静默全库」，测试还得红。
const compressSrc = read('lib/host/compress.js')
if (!compressSrc.includes('export function pickEncoding')) fail('1.8.0 缺压缩协商 pickEncoding')
if (!compressSrc.includes('export async function compressBuffer')) fail('1.8.0 缺 compressBuffer')
if (!compressSrc.includes('MIN_COMPRESS_BYTES = 1024')) fail('1.8.0 压缩阈值不是 1024B')
if (!httpSrc.includes('async function sendBody')) fail('1.8.0 缺统一发送层 sendBody')
if (!httpSrc.includes('pickEncoding')) fail('sendBody 没用协商结果')
if (!httpSrc.includes('STATIC_CACHE')) fail('1.8.0 缺静态压缩缓存')
if (!httpSrc.includes("connection: 'close'")) fail('1.8.0 超限响应没带 connection: close')
if (!httpSrc.includes("error: 'too_large'")) fail('1.8.0 超限请求体没走 too_large 分支')
if (!httpSrc.includes("W/\"'")) fail('1.8.0 /graph 没用弱 ETag')
if (!read('lib/host/nebula.js').includes('format 只支持 md 或 json')) fail('1.8.0 /export 没校验 format')
if (!read('lib/host/nebula.js').includes('未知的范围类型')) fail('1.8.0 /export 没校验 scope 类型')
if (!exists('test/http-transport.test.mjs')) fail('1.8.0 缺传输契约单测')
if (!read('CHANGELOG.md').includes('## 1.8.0')) fail('CHANGELOG 缺 1.8.0')
if (!read('docs/http-api.md').includes('传输：压缩')) fail('http-api.md 缺传输段')
if (!read('docs/release.md').includes('1.8.0 实测')) fail('release.md 缺 1.8.0 实测记录')
if (!read('docs/roadmap.md').includes('## 1.9 「五万条也不糊成一片」')) fail('roadmap 缺 1.9 交付段')
if (!read('docs/verified.md').includes('dev/verify-1.8.mjs')) fail('verified.md 缺 1.8.0 字节级复验')
ok('1.8.0 构件：压缩 / 弱 ETag / 静态 304 / HEAD / 413 / 导出白名单 / 文档与测试')

// 1.9.0：大库三层（分页 / 视口裁剪 / 快照分片）。门要盯住「以后谁把分页拆了、
// 把裁剪关掉、让快照重新一次吐四万条、或者把小库的排序也一起改了」。
if (!exists('lib/host/page.js')) fail('1.9.0 缺 lib/host/page.js')
const pageSrc9 = read('lib/host/page.js')
if (!pageSrc9.includes('export function pageOrder')) fail('1.9.0 缺 pageOrder')
if (!pageSrc9.includes('export function selectPage')) fail('1.9.0 缺 selectPage')
if (!pageSrc9.includes('FIRST_PAGE_MAX = 10000')) fail('1.9.0 首屏上限不是 10000 条')
if (!pageSrc9.includes('PAGE_MAX = 50000')) fail('1.9.0 分页硬上限不是 50000')
const renderSrc9 = read('lib/web/render.js')
if (!renderSrc9.includes('NODE_CELL')) fail('1.9.0 缺节点空间网格')
if (!renderSrc9.includes('BIG_EDGE_LOD')) fail('1.9.0 缺边 LOD 阈值')
if (!renderSrc9.includes('visibleEdgeIndices')) fail('1.9.0 缺视口裁剪')
if (!renderSrc9.includes('drawClusterLinks')) fail('1.9.0 缺簇间聚合线')
const shareSrc9 = read('lib/host/share.js')
if (!shareSrc9.includes('export function parseShareLimit')) fail('1.9.0 缺快照 limit 解析')
if (!shareSrc9.includes('SHARE_NODE_CAP = 20000')) fail('1.9.0 快照默认上限不是 20000 条')
if (!shareSrc9.includes('snapshot-trim')) fail('1.9.0 快照页缺「已裁剪」提示')
if (!httpSrc.includes('图已更新，请从第一页重新加载')) fail('1.9.0 缺分页 409 契约')
if (!httpSrc.includes('readPageArgs')) fail('1.9.0 /graph 没校验 limit / offset')
if (!read('lib/web/app.js').includes('renderPageBar')) fail('1.9.0 前端缺分页条')
if (!read('lib/web/app.js').includes('mergePage')) fail('1.9.0 前端缺合并下一页')
if (!read('lib/web/api.js').includes("typeof e.s !== 'number'")) fail('1.9.0 normalizeGraph 没改成逐条判断')
for (const t of ['test/page.test.mjs', 'test/graph-page-http.test.mjs', 'test/share-limit.test.mjs']) {
  if (!exists(t)) fail('1.9.0 缺 ' + t)
}
if (!read('CHANGELOG.md').includes('## 1.9.0')) fail('CHANGELOG 缺 1.9.0')
if (!read('docs/http-api.md').includes('分页契约')) fail('http-api.md 缺分页契约')
if (!read('docs/http-api.md').includes('切片上限')) fail('http-api.md 缺快照上限')
if (!read('docs/release.md').includes('1.9.0 实测')) fail('release.md 缺 1.9.0 实测记录')
if (!read('docs/verified.md').includes('dev/verify-1.9-cull.mjs')) fail('verified.md 缺 1.9.0 视口裁剪复验')
if (!read('docs/roadmap.md').includes('1.9.0 已交付')) fail('roadmap 缺 1.9.0 已交付')
if (!read('docs/benchmarks.md').includes('1.9.0（改后）')) fail('benchmarks.md 缺 5 万条前后对比')
ok('1.9.0 构件：分页 / 视口裁剪 / 边 LOD / 快照分片 / 409 / 文档与测试')

// ---- 1.9.1：市场端到端与真实库复核（交付的是证据，不是新行为） ----
if (!read('CHANGELOG.md').includes('## 1.9.1')) fail('CHANGELOG 缺 1.9.1')
if (!read('docs/verified.md').includes('dev/market-e2e.mjs')) fail('verified.md 缺市场端到端演练')
if (!read('docs/verified.md').includes('dev/verify-real-library.mjs')) fail('verified.md 缺真实库复核')
if (!read('docs/verified.md').includes('includePrerelease')) fail('verified.md 没记引擎口径（includePrerelease）')
if (!read('docs/release.md').includes('1.9.1 实测')) fail('release.md 缺 1.9.1 实测记录')
if (!read('docs/roadmap.md').includes('1.9.1 已交付')) fail('roadmap 缺 1.9.1 已交付')
{
  // 分页默认截断是一万条：注释里写成两万就是给下一个人挖坑
  const nebulaSrc = read('lib/host/nebula.js')
  if (!nebulaSrc.includes('超过一万条自动截第一页')) fail('nebula.js 的分页注释没写对默认截断（一万条）')
  if (nebulaSrc.includes('超过两万条自动截第一页')) fail('nebula.js 仍留着「两万条」的旧注释')
}
ok('1.9.1 构件：市场端到端 / 真实库复核 / 引擎口径 / 注释校正')

// ---- 1.9.2：分页条的无障碍（新交互元素必须能被读屏和键盘用） ----
{
  const appSrc92 = read('lib/web/app.js')
  if (!appSrc92.includes('pagebar-status')) fail('分页条缺 pagebar-status')
  if (!appSrc92.includes("setAttribute('aria-live', 'polite')")) fail('分页条状态不是 polite live region')
  if (!appSrc92.includes("setAttribute('aria-atomic', 'true')")) fail('分页条状态缺 aria-atomic')
  if (!appSrc92.includes('aria-describedby')) fail('分页按钮没关联状态文字')
  if (!appSrc92.includes("bar.setAttribute('aria-busy'")) fail('分页条没有 aria-busy')
  if (!appSrc92.includes('已经加载全部 {n} 条')) fail('加载完没有收尾提示')
  if (!read('lib/web/i18n.js').includes('All {n} memories are loaded')) fail('i18n 缺「已经加载全部」')
  if (!read('lib/web/style.css').includes('.pagebar .pbbtn:focus-visible')) fail('分页按钮缺 focus-visible 样式')
}
ok('1.9.2 构件：分页条 live region / aria-describedby / aria-busy / 键盘焦点 / 完成提示')

// ---- 1.10.0：三维的绘制预算（大库不再被挡在门外，但要说清楚画了多少） ----
{
  const space3dSrc = read('lib/web/space3d.js')
  if (!space3dSrc.includes('const BALL_LIMIT = 18000')) fail('三维缺 BALL_LIMIT')
  if (!space3dSrc.includes('const FORCE_ITER_BIG = 90')) fail('三维大图缺迭代上限')
  if (!space3dSrc.includes('function computeDrawBudget')) fail('三维缺 computeDrawBudget')
  if (!space3dSrc.includes('state.drawSet')) fail('三维没有取样集合')
  if (!space3dSrc.includes('state.drawEdges')) fail('三维没有先筛边')
  if (!space3dSrc.includes('state.lastDrawMs')) fail('三维缺 drawMs 测量')
  const appSrc10 = read('lib/web/app.js')
  if (appSrc10.includes('超过三千条先在二维星云里看')) fail('三维还留着三千条的硬闸门')
  if (!appSrc10.includes('state.space3dGraph')) fail('三维换图仍只比签名（sig 缺失时会停在旧图）')
  if (!appSrc10.includes('三维只画重要度前 {n} 条')) fail('取样后没有在界面上说明')
  if (!read('lib/web/i18n.js').includes('3D draws the top {n} memories')) fail('i18n 缺三维取样说明')
  if (!read('docs/verified.md').includes('dev/verify-3d.mjs')) fail('verified 缺三维实测')
  if (!read('docs/roadmap.md').includes('1.10.0 已交付')) fail('roadmap 缺 1.10.0 交付记录')
  if (!read('docs/release.md').includes('1.10.0 实测')) fail('release.md 缺 1.10.0 实测')
  if (!read('docs/compatibility.md').includes('BALL_LIMIT')) fail('兼容性矩阵还写着三千条拦人')
}
ok('1.10.0 构件：三维取样预算 / 边预筛 / 迭代上限 / 取样说明 / 硬闸门已移除 / 文档与实测')

// ---- 1.10.1：坏库不能假装是空的（读不动的来源必须点名，且诊断不漏路径） ----
{
  const meowSrc = read('lib/host/adapters/meow.js')
  if (!meowSrc.includes("SELECT count(*) AS n FROM sqlite_master")) fail('适配器没有探 sqlite_master（坏库会被当成空库）')
  if (!meowSrc.includes('读不动')) fail('适配器不报「读不动」')
  if (/打不开 ' \+ store\.dbPath/.test(meowSrc)) fail('适配器把绝对路径塞进错误里')
  const nebulaSrc10 = read('lib/host/nebula.js')
  if (!nebulaSrc10.includes('this.storeErrors')) fail('Nebula 没记来源错误')
  if (!/if \(this\.storeErrors\.length === 0\) this\.lastError = ''/.test(nebulaSrc10)) fail('lastError 仍会被无条件清空')
  const diagSrc = read('lib/host/diagnostics.js')
  if (!diagSrc.includes('function redact')) fail('诊断缺脱敏')
  if (!diagSrc.includes('sourceErrors')) fail('诊断文本不报 sourceErrors')
  if (!read('lib/host/doctor.js').includes('读不动')) fail('doctor 不点名坏库')
  if (!read('lib/web/app.js').includes('src-bad')) fail('来源面板没有坏库行')
  if (!read('lib/web/app.js').includes('warnedSourceError')) fail('坏库提示没有「只说一次」')
  if (!read('lib/web/i18n.js').includes("Some sources can't be read")) fail('i18n 缺坏库提示')
  if (!read('test/corrupt-source.test.mjs').includes('读不动')) fail('缺坏库单测')
  if (!read('docs/verified.md').includes('dev/verify-corrupt-ui.mjs')) fail('verified 缺坏库真机验证')
  if (!read('docs/roadmap.md').includes('1.10.1 已交付')) fail('roadmap 缺 1.10.1 交付记录')
  if (!read('docs/release.md').includes('1.10.1 实测')) fail('release.md 缺 1.10.1 实测')
  if (!read('docs/troubleshooting.md').includes('sourceErrors')) fail('troubleshooting 没写「0 条」怎么查')
}
ok('1.10.1 构件：坏库点名 / 脱敏诊断 / doctor 探针 / 界面红色行 / 只说一次 / 单测与实测')

// ---- 1.11.0：快照带校验和（改过、截断过都要说清楚，而不是白屏） ----
{
  const shareSrc11 = read('lib/host/share.js')
  if (!shareSrc11.includes("createHash('sha256')")) fail('快照没有算 sha256')
  if (!shareSrc11.includes('nebula-snapshot-data')) fail('快照数据没放进 JSON 数据块')
  if (!shareSrc11.includes('__NEBULA_SNAPSHOT_INTEGRITY__')) fail('快照没带完整性元信息')
  if (!shareSrc11.includes('__NEBULA_SNAPSHOT_BROKEN__')) fail('解析失败没有记录变量')
  const appSrc11 = read('lib/web/app.js')
  if (!appSrc11.includes('verifySnapshotIntegrity')) fail('前端没有校验入口')
  if (!appSrc11.includes('snapshotBanner')) fail('前端没有校验横幅')
  if (!appSrc11.includes('快照校验失败')) fail('前端没有失败文案')
  if (!read('lib/web/i18n.js').includes('Snapshot checksum')) fail('i18n 缺校验提示')
  if (!read('lib/web/style.css').includes('#snapshot-integrity')) fail('样式缺校验横幅')
  if (!read('test/share-integrity.test.mjs').includes('sha256')) fail('缺快照校验和单测')
  if (!read('docs/verified.md').includes('dev/verify-snapshot-integrity.mjs')) fail('verified 缺快照真机验证')
  if (!read('docs/roadmap.md').includes('1.11.0 已交付')) fail('roadmap 缺 1.11.0 交付记录')
  if (!read('docs/release.md').includes('1.11.0 实测')) fail('release.md 缺 1.11.0 实测')
  if (!read('docs/http-api.md').includes('sha256')) fail('http-api 没写快照校验和')
}
ok('1.11.0 构件：原始文本哈希 / JSON 数据块 / 损坏可见 / 校验横幅 / 单测与实测')

// ---- 1.11.1：分页没加载完时，别叫人去重置筛选（旧文案在分页下是错的建议） ----
{
  const appSrc111 = read('lib/web/app.js')
  if (!appSrc111.includes("state.page.next != null")) fail('筛选空屏提示没看还有没有下一页')
  if (!appSrc111.includes('当前已加载 ')) fail('筛选空屏提示没写「已加载多少」')
  if (!appSrc111.includes('条里没有匹配')) fail('筛选空屏提示没解释「可能还在后面的页里」')
  if (!appSrc111.includes('继续加载')) fail('筛选空屏提示没给「继续加载」这条出口')
  if (!appSrc111.includes('applyFilter, updateFilterHint')) fail('调试钩子没暴露筛选函数（真机测不了）')
  if (!read('lib/web/i18n.js').includes('the match may be on a later page')) fail('i18n 缺分页筛选提示')
  if (!read('docs/benchmarks.md').includes('真实库的浏览器预算')) fail('benchmarks 缺真实库预算段')
  if (!read('docs/verified.md').includes('dev/verify-filter-page.mjs')) fail('verified 缺分页筛选真机验证')
  if (!read('docs/roadmap.md').includes('1.11.1 已交付')) fail('roadmap 缺 1.11.1 交付记录')
  if (!read('docs/release.md').includes('1.11.1 实测')) fail('release.md 缺 1.11.1 实测')
}
ok('1.11.1 构件：分页空屏提示 / 继续加载出口 / 调试钩子 / 真实库预算 / 单测与实测')

// ---- 1.11.2：命中在后面的页里就自己往后翻（最多 3 页） ----
{
  const appSrc112 = read('lib/web/app.js')
  if (!appSrc112.includes('AUTO_FILL_PAGES = 3')) fail('没有自动翻页上限（会读进整个库）')
  if (!appSrc112.includes('async function autoFillForFilter')) fail('没实现自动翻页')
  if (!appSrc112.includes('筛选命中在后面的页里')) fail('自动翻页成功没有提示')
  if (!appSrc112.includes('仍没找到匹配')) fail('自动翻页失败没有结论')
  if (!appSrc112.includes('const fetchGraph =')) fail('取图没有单一入口')
  if (!read('lib/web/i18n.js').includes('were on later pages')) fail('i18n 缺自动翻页提示')
  if (!read('docs/interface.md').includes('自动往后翻最多 3 页')) fail('interface 没写自动翻页')
  if (!read('docs/verified.md').includes('1.11.2（2026-11-14）')) fail('verified 缺 1.11.2 段')
  if (!read('docs/roadmap.md').includes('1.11.2 已交付')) fail('roadmap 缺 1.11.2 交付记录')
  if (!read('docs/release.md').includes('1.11.2 实测')) fail('release.md 缺 1.11.2 实测')
}
ok('1.11.2 构件：自动翻页 / 3 页上限 / 成功与失败文案 / 取图入口 / 单测与实测')

// ---- 1.11.3：体检清单有上限，计数仍是全量 ----
{
  const graphSrc113 = read('lib/host/graph.js')
  if (!graphSrc113.includes('const staleTotal = stale.length')) fail('stale 没有全量计数')
  if (!graphSrc113.includes('if (stale.length > HY_MAX) stale.length = HY_MAX')) fail('stale 没有截断')
  if (!graphSrc113.includes('if (thin.length > HY_MAX) thin.length = HY_MAX')) fail('thin 没有截断')
  if (!graphSrc113.includes('const shown = {}')) fail('没有 shown（列了几条）')
  if (!graphSrc113.includes('totalShown')) fail('没有 totalShown')
  if (!read('lib/index.js').includes('这里只列前')) fail('工具没说清被截断')
  if (!read('lib/web/app.js').includes('只列前 ')) fail('界面没说清被截断')
  if (!read('lib/web/i18n.js').includes(' · 只列前 ')) fail('i18n 缺截断提示')
  if (!exists('test/hygiene-cap.test.mjs')) fail('缺体检上限单测')
  if (!read('docs/verified.md').includes('1.11.3（2026-11-14）')) fail('verified 缺 1.11.3 段')
  if (!read('docs/roadmap.md').includes('1.11.3 已交付')) fail('roadmap 缺 1.11.3 交付记录')
  if (!read('docs/release.md').includes('1.11.3 实测')) fail('release.md 缺 1.11.3 实测')
}
ok('1.11.3 构件：清单上限 / 全量计数 / 截断提示 / 单测与实测')

// ---- 1.11.4：长活分片，事件循环不让路 ----
{
  const g = read('lib/host/graph.js')
  if (!g.includes('export function* buildGraphSteps')) fail('缺 buildGraphSteps 生成器')
  if (!g.includes('export async function buildGraphAsync')) fail('缺 buildGraphAsync')
  if (!g.includes('export function* auditHygieneSteps')) fail('缺 auditHygieneSteps 生成器')
  if (!g.includes('export async function auditHygieneAsync')) fail('缺 auditHygieneAsync')
  if (!g.includes('const budgetSpent')) fail('缺按时间切片预算（budgetSpent）')
  const a = read('lib/host/adapters/index.js')
  if (!a.includes('export function* scanAllSteps')) fail('缺 scanAllSteps 生成器')
  if (!a.includes('export async function scanAllAsync')) fail('缺 scanAllAsync')
  const n = read('lib/host/nebula.js')
  if (!n.includes('await buildGraphAsync')) fail('refresh 没走异步建图')
  if (!n.includes('await scanAllAsync')) fail('refresh 没走异步扫描')
  if (!n.includes('async overviewAsync')) fail('缺 overviewAsync')
  if (!read('lib/host/http.js').includes('overviewAsync')) fail('/overview 没走异步版')
  const idx = read('lib/index.js')
  if (!idx.includes('await nebula.overviewAsync()')) fail('工具 overview 没走异步版')
  if (!idx.includes('await nebula.hygieneAsync()')) fail('工具 hygiene 没走异步版')
  if (!exists('test/async-longop.test.mjs')) fail('缺异步长活单测')
  if (!read('docs/verified.md').includes('1.11.4（2026-11-14）')) fail('verified 缺 1.11.4 段')
  if (!read('docs/roadmap.md').includes('1.11.4 已交付')) fail('roadmap 缺 1.11.4 交付记录')
  if (!read('docs/release.md').includes('1.11.4 实测')) fail('release.md 缺 1.11.4 实测')
  if (!read('docs/benchmarks.md').includes('长活有多长')) fail('benchmarks 缺长活一节')
}
ok('1.11.4 构件：生成器三件套 / 按时间切片 / 接线到路由与工具 / 单测与实测')

// ---- 1.11.5：5 万条的库，快照不裁剪也不按住界面 ----
{
  if (!read('lib/host/nebula.js').includes('opts.all')) fail('/share 没有整图取全的开关')
  if (!read('lib/host/share.js').includes('nebula.publicGraph({ all: true })')) fail('切片没走整图取全')
  if (!read('lib/host/nebula.js').includes("cards: opts.hygiene === false ? null : this.cards()"))
    fail('overview({hygiene:false}) 仍会顺手算 cards')
  if (!read('lib/host/share.js').includes('function buildShareSlice')) fail('切片没拆出主体')
  if (!read('lib/host/recall.js').includes('export async function recallAsync')) fail('缺 recallAsync')
  if (!read('lib/host/recall.js').includes('function* tokenCacheSteps')) fail('词频表没有分片')
  if (!read('lib/host/http.js').includes('await src.recallAsync')) fail('/recall 没走异步版')
  if (!read('lib/index.js').includes('await nebula.recallAsync')) fail('nebula_recall 没走异步版')
  if (!exists('test/async-recall.test.mjs')) fail('缺异步检索单测')
  if (!exists('test/share-hygiene.test.mjs')) fail('缺快照体检单测')
  if (!read('docs/verified.md').includes('1.11.5（2026-11-15）')) fail('verified 缺 1.11.5 段')
  if (!read('docs/roadmap.md').includes('1.11.5 已交付')) fail('roadmap 缺 1.11.5 交付记录')
  if (!read('docs/release.md').includes('1.11.5 实测')) fail('release.md 缺 1.11.5 实测')
  if (!read('docs/benchmarks.md').includes('5 万条：事件循环上还剩多少空档')) fail('benchmarks 缺 5 万条一节')
}
ok('1.11.5 构件：整图取全 / 不算多余体检 / 检索分片 / 单测与实测')

// ---- 1.11.6：重复检测两段式，一对都没少 ----
{
  const g = read('lib/host/graph.js')
  if (!g.includes('const BUCKET_MAX = 60')) fail('重复检测没有正文分桶')
  if (!g.includes('const POST_CAP = 60')) fail('倒排没有抽样上限')
  if (!g.includes('const exact = new Set()')) fail('缺一字不差那一通道')
  if (!g.includes('Math.floor(key / base)')) fail('候选对没有还原成下标')
  if (!g.includes('hyJaccardAtLeast')) fail('缺少相似度判定')
  if (!exists('test/dup-equivalence.test.mjs')) fail('缺重复检测等价性单测')
  if (!read('docs/verified.md').includes('1.11.6（2026-11-15）')) fail('verified 缺 1.11.6 段')
  if (!read('docs/roadmap.md').includes('1.11.6 已交付')) fail('roadmap 缺 1.11.6 交付记录')
  if (!read('docs/release.md').includes('1.11.6 实测')) fail('release.md 缺 1.11.6 实测')
  if (!read('CHANGELOG.md').includes('## 1.11.6')) fail('CHANGELOG 缺 1.11.6 段')
}
ok('1.11.6 构件：正文分桶 / 稀有词倒排 / 数值键 / 等价性单测与实测')

// ---- 1.11.7：最慢的一片不再是一整块 ----
{
  const g = read('lib/host/graph.js')
  if (!g.includes('yield \'sources\'')) fail('来源节点扫描没有让路')
  if (!g.includes('node.blob.includes(needle)')) fail('来源节点扫描缺 includes 预筛')
  if (!g.includes('yield \'cluster\'')) fail('聚类段没有让路')
  if (!g.includes('yield \'output\'')) fail('输出投影没有让路')
  if (!g.includes('yield \'prune\'')) fail('剪枝段没有让路')
  if (!read('lib/host/nebula.js').includes('NEBULA_REFRESH_PROFILE')) fail('缺重建分段计时开关')
  if (!read('docs/verified.md').includes('1.11.7（2026-11-15）')) fail('verified 缺 1.11.7 段')
  if (!read('docs/roadmap.md').includes('1.11.7 已交付')) fail('roadmap 缺 1.11.7 交付记录')
  if (!read('docs/release.md').includes('1.11.7 实测')) fail('release.md 缺 1.11.7 实测')
  if (!read('docs/benchmarks.md').includes('5 万条：事件循环上还剩多少空档')) fail('benchmarks 缺 5 万条空档一节')
  if (!read('CHANGELOG.md').includes('## 1.11.7')) fail('CHANGELOG 缺 1.11.7 段')
}
ok('1.11.7 构件：来源预筛 / 聚类与输出切片 / 重建分段计时 / 实测')

let shots = null
try {
  shots = JSON.parse(read('screenshots.json')).screenshots
} catch {
  fail('screenshots.json 缺失或不是合法 JSON')
}
if (!Array.isArray(shots) || shots.length < 1 || shots.length > 8) {
  fail('screenshots.json 需要 1–8 张截图')
} else {
  for (const relPath of shots) {
    if (!exists(relPath)) fail('市场截图不存在：' + relPath)
  }
}
ok(`市场截图：${Array.isArray(shots) ? shots.length : 0} 张，路径已验证`)

if (!read('lib/standalone.mjs').includes("--token")) fail('standalone 缺 --token')
if (!read('lib/host/http.js').includes('timingSafeEqual')) fail('HTTP 口令门缺常量时间比较')
if (!read('lib/host/http.js').includes('nb_token')) fail('HTTP 口令门缺 cookie')
if (!read('CHANGELOG.md').includes('## 1.6.0')) fail('CHANGELOG 缺 1.6.0')
ok('1.6.0 构件：本机口令 / cookie / 变更记录')

if (!read('README.md').includes('awesome-dsh-plugin.com/p/hanhan9999999999999999999/dsh-memory-nebula')) {
  fail('README 未写精选目录入口')
}
if (!read('README.en.md').includes('dsh plugin --profile web add dsh-memory-nebula')) {
  fail('README.en 未写目录安装命令')
}
if (!read('market/index.json').includes(`"version": "${pkg.version}"`)) fail(`market 索引未到 ${pkg.version}`)
if (!read('CHANGELOG.md').includes('## 1.5.2')) fail('CHANGELOG 缺 1.5.2')
ok('1.5.2 构件：精选目录入口 / 安装命令 / 索引版本 / 变更记录')




console.log(`\n发布检查：${pkg.name} v${pkg.version}\n`)
// ---- 1.11.8：5 万条在浏览器里一页页点到头 ----
{
  const bench118 = read('docs/benchmarks.md')
  if (!bench118.includes('5 万条：在浏览器里一页页点到头（1.11.8）')) fail('benchmarks 缺 1.11.8 一节')
  if (!bench118.includes('node dev/verify-page2.mjs')) fail('benchmarks 缺 1.11.8 的复跑命令')
  noteDev('../dev/verify-page2.mjs'); if (!exists('../dev/verify-page2.mjs')) fail('缺 5 万条浏览器验收脚本')
  const roadmap118 = read('docs/roadmap.md')
  if (!roadmap118.includes('1.11.8 已交付')) fail('roadmap 缺 1.11.8 交付记录')
  if (!roadmap118.includes('~~5 万条的浏览器验收目前跑在合成基准上~~')) fail('roadmap 的待做项没划掉浏览器验收')
  if (!read('docs/verified.md').includes('1.11.8（2026-11-15）')) fail('verified 缺 1.11.8 段')
  if (!read('docs/release.md').includes('1.11.8 实测')) fail('release.md 缺 1.11.8 实测')
  if (!read('CHANGELOG.md').includes('## 1.11.8')) fail('CHANGELOG 缺 1.11.8')
}
ok('1.11.8 构件：5 万条浏览器验收 / 第二页与全图预算 / 收尾行为 / 文档三处')

// ---- 1.11.9：五万条切三维，前两秒不再抖 ----
{
  const s3d = read('lib/web/space3d.js')
  if (!s3d.includes('function forceRepel(')) fail('力场没拆成 forceRepel')
  if (!s3d.includes('function forceSprings(')) fail('力场没拆成 forceSprings')
  if (!s3d.includes('function forcePull(')) fail('力场没拆成 forcePull')
  if (!s3d.includes('const deadline = performance.now() + 10')) fail('力场没有每帧 10ms 预算')
  if (!s3d.includes('state.settleTick % 4 !== 0')) fail('收敛期没有拉开绘制间隔')
  if (!s3d.includes('state.force.running ? [] : state.drawEdges')) fail('收敛期没有省掉连线重传')
  if (!s3d.includes('glCheck ? gl.getError() : 0')) fail('gl.getError 没有改成按需')
  if (!s3d.includes('state.needDraw = true')) fail('收敛结束没有补一次重画')
  noteDev('../dev/probe-3d-gpu.mjs'); if (!exists('../dev/probe-3d-gpu.mjs')) fail('缺三维真 GPU 探针')
  noteDev('../dev/shot-3d.mjs'); if (!exists('../dev/shot-3d.mjs')) fail('缺三维收敛期截图脚本')
  const bench119 = read('docs/benchmarks.md')
  if (!bench119.includes('三维：真 GPU 与软件渲染（1.11.9）')) fail('benchmarks 缺 1.11.9 一节')
  if (!bench119.includes('node dev/probe-3d-gpu.mjs')) fail('benchmarks 缺 1.11.9 的复跑命令')
  const roadmap119 = read('docs/roadmap.md')
  if (!roadmap119.includes('1.11.9 已交付')) fail('roadmap 缺 1.11.9 交付记录')
  if (!roadmap119.includes('~~三维在真 GPU 上还没量过~~')) fail('roadmap 的待做项没划掉三维 GPU')
  if (!read('docs/verified.md').includes('1.11.9（2026-11-15）')) fail('verified 缺 1.11.9 段')
  if (!read('docs/release.md').includes('1.11.9 实测')) fail('release.md 缺 1.11.9 实测')
  if (!read('CHANGELOG.md').includes('## 1.11.9')) fail('CHANGELOG 缺 1.11.9')
}
ok('1.11.9 构件：力场分片 / 收敛期算画解耦 / 真 GPU 探针 / 文档四处')

// ---- 1.11.10：会滚动的面板也得能被 Tab 到 ----
{
  const html110 = read('lib/web/index.html')
  for (const [sel, label] of [
    ['id="hits" tabindex="0" role="region"', '#hits'],
    ['id="filters" tabindex="0" role="region"', '#filters'],
    ['id="sources" tabindex="0" role="region"', '#sources'],
    ['id="detail" tabindex="0" role="region"', '#detail'],
    ['id="d-body" tabindex="0" role="region"', '#d-body'],
    ['id="pb-body" tabindex="0" role="region"', '#pb-body'],
    ['id="boards-body" tabindex="0" role="region"', '#boards-body'],
    ['id="cmdk-list" tabindex="0" role="region"', '#cmdk-list'],
    ['id="lb-body" tabindex="0" role="region"', '#lb-body'],
    ['id="cards-grid" tabindex="0" role="region"', '#cards-grid'],
  ]) {
    if (!html110.includes(sel)) fail(label + ' 不是可聚焦的滚动区域')
  }
  if (!read('lib/web/style.css').includes(':where(#hits, #filters, #sources, #detail, #d-body, #pb-body, #boards-body, #cmdk-list, #lb-body, #cards-grid):focus-visible')) fail('滚动区域缺 focus-visible 描边')
  if (!read('lib/web/app.js').includes('showDetail, showPath, renderHits')) fail('调试钩子没补 showDetail / showPath / renderHits')
  noteDev('../dev/verify-axe-states.mjs'); if (!exists('../dev/verify-axe-states.mjs')) fail('缺多状态 axe 审计脚本')
  noteDev('../dev/verify-taborder.mjs'); if (!exists('../dev/verify-taborder.mjs')) fail('缺 Tab 序列脚本')
  const axeSrc = readDev('../dev/verify-axe-states.mjs')
if (axeSrc && !axeSrc.includes('没有状态断言，不敢审')) fail('axe 审计缺状态断言')
  if (!read('docs/accessibility.md').includes('scrollable-region-focusable')) fail('accessibility 文档没写这条违例')
  if (!read('docs/verified.md').includes('1.11.10（2026-11-15）')) fail('verified 缺 1.11.10 段')
  if (!read('docs/roadmap.md').includes('1.11.10 已交付')) fail('roadmap 缺 1.11.10 交付记录')
  if (!read('docs/release.md').includes('1.11.10 实测')) fail('release.md 缺 1.11.10 实测')
  if (!read('CHANGELOG.md').includes('## 1.11.10')) fail('CHANGELOG 缺 1.11.10')
}
ok('1.11.10 构件：十个可聚焦滚动区域 / 焦点描边 / 两把验收尺子 / 文档四处')

// ---- 1.11.11：体检里那三秒，一半在排序上 ----
{
  const graph111 = read('lib/host/graph.js')
  if (!graph111.includes('const wordId = new Map()')) fail('词频表没换成 内部编号 + Int32Array')
  if (!graph111.includes('const SIG_N = 24')) fail('签名没有 24 个位置的上限')
  if (!graph111.includes('pickC') || !graph111.includes('pickI')) fail('签名没改成有界插入')
  if (graph111.includes('words.slice(0, 24)')) fail('签名还在整表排序 + slice')
  if (!graph111.includes('const ordered = [...list].sort')) fail('stale 倒排没先按 updatedAt 排序')
  if (!graph111.includes("mark('sig')")) fail('缺签名段计时')
  if (!exists('test/hygiene-sig.test.mjs')) fail('缺签名等价性单测')
  noteDev('../dev/probe-sig-equivil.mjs'); if (!exists('../dev/probe-sig-equivil.mjs')) fail('缺新旧签名逐节点比对的探针')
  if (!read('docs/verified.md').includes('1.11.11（2026-11-15）')) fail('verified 缺 1.11.11 段')
  if (!read('docs/roadmap.md').includes('1.11.11 已交付')) fail('roadmap 缺 1.11.11 交付记录')
  if (!read('docs/release.md').includes('1.11.11 实测')) fail('release.md 缺 1.11.11 实测')
  if (!read('CHANGELOG.md').includes('## 1.11.11')) fail('CHANGELOG 缺 1.11.11')
  if (!/1\.11\.(11|1[2-9]) 更新/.test(read('docs/benchmarks.md'))) fail('benchmarks 没更新到 1.11.11 之后')
}
ok('1.11.11 构件：编号词频表 / 有界签名 / 有序倒排 / 等价性单测 / 文档五处')

// ---- 1.11.12：一条命令跑完，跳过不算通过 ----
{
  if (!exists('scripts/verify-all.mjs')) fail('缺验收集合脚本')
  const va = read('scripts/verify-all.mjs')
  for (const [needle, label] of [
    ['async function countNodes', '没有「先问测试库真实条数」的预检'],
    ['fixtureNodes >= EXPECT_NODES', '没有按 --nodes 判定测试库够不够'],
    ['跳过不是通过', '汇总没说清跳过不算通过'],
    ['process.exit(fail === 0 ? 0 : 1)', '退出码没挂到失败计数上'],
    ['--json', '没有给 CI 用的 --json'],
  ]) if (!va.includes(needle)) fail(label)
  const pkgScripts = JSON.parse(read('package.json')).scripts
  if (pkgScripts['verify:all'] !== 'node scripts/verify-all.mjs') fail('package.json 缺 verify:all')
  if (pkgScripts['verify:full'] !== 'node scripts/verify-all.mjs --full') fail('package.json 缺 verify:full')
  if (!exists('test/verify-all.test.mjs')) fail('缺验收集合的单测')
  if (!read('docs/release.md').includes('npm run verify:full')) fail('release.md 没写这条命令')
  if (!read('docs/verified.md').includes('1.11.12（2026-11-15）')) fail('verified 缺 1.11.12 段')
  if (!read('docs/roadmap.md').includes('1.11.12 已交付')) fail('roadmap 缺 1.11.12 交付记录')
  if (!read('docs/release.md').includes('1.11.12 实测')) fail('release.md 缺 1.11.12 实测')
  if (!read('CHANGELOG.md').includes('## 1.11.12')) fail('CHANGELOG 缺 1.11.12')
}
ok('1.11.12 构件：验收集合 / 条数预检 / 跳过口径 / 两个 npm 入口 / 文档四处')

// ---- 1.11.13：该更新了，只问该问的那几个词 ----
{
  const g = read('lib/host/graph.js')
  if (!g.includes('function kwOf(m)')) fail('缺 kwOf()（词表去重 + 小写）')
  if (!g.includes('function overlapAtLeast(set, list, t)')) fail('缺 overlapAtLeast()（命中 t 个就早退）')
  if (!g.includes('const kwSets = new Map()')) fail('倒排建表时没留 kwSets')
  if (!g.includes('.slice(0, kws.length - 2)')) fail('前缀过滤没按 |kws|-2 截断')
  if (!g.includes('if (kws.length < 3) continue')) fail('不足 3 个关键词的记忆没有被跳过')
  if (!exists('test/stale-equivalence.test.mjs')) fail('缺陈旧检测等价性单测')
  if (!read('docs/verified.md').includes('1.11.13（2026-11-15）')) fail('verified 缺 1.11.13 段')
  if (!read('docs/roadmap.md').includes('1.11.13 已交付')) fail('roadmap 缺 1.11.13 交付记录')
  if (!read('docs/release.md').includes('1.11.13 实测')) fail('release.md 缺 1.11.13 实测')
  if (!read('docs/benchmarks.md').includes('2,899ms')) fail('benchmarks 缺 1.11.13 的体检总时长')
  if (!read('CHANGELOG.md').includes('## 1.11.13')) fail('CHANGELOG 缺 1.11.13')
}
ok('1.11.13 构件：前缀过滤 / kwSets / 早退重叠 / 等价性单测 / 文档五处')
// ---- 1.11.14：装在别人机器上，也得能自己验一遍 ----
{
  const v = read('scripts/verify-all.mjs')
  if (!v.includes("const TEST_DIR = join(PKG, 'test')")) fail('单测没有先看 test/ 在不在')
  if (!v.includes('这个副本没带 test/（单测只在仓库里跑）')) fail('缺 test/ 时没说清原因')
  if (!v.includes('const REPO_ONLY = ')) fail('构件门没有仓库专属文件清单')
  if (!v.includes('missingRepoOnly.length')) fail('缺仓库专属文件时没有标跳过')
  if (!read('test/verify-all.test.mjs').includes('单测只在仓库里跑')) fail('单测契约没覆盖安装态')
  if (!read('docs/verified.md').includes('1.11.14（2026-11-15）')) fail('verified 缺 1.11.14 段')
  if (!read('docs/roadmap.md').includes('1.11.14 已交付')) fail('roadmap 缺 1.11.14 交付记录')
  if (!read('docs/release.md').includes('1.11.14 实测')) fail('release.md 缺 1.11.14 实测')
  if (!read('CHANGELOG.md').includes('## 1.11.14')) fail('CHANGELOG 缺 1.11.14')
}
ok('1.11.14 构件：安装态跳过 / 仓库专属清单 / 单测契约 / 文档四处')
// ---- 1.11.15：比的是编号，不是字符串 ----
{
  const g = read('lib/host/graph.js')
  if (!g.includes('const words = []')) fail('没有留下「编号 → 词」的对照表')
  if (!g.includes('const idsOf = new Map()')) fail('没有为每个节点存编号表')
  if (!g.includes('ids[k++] = id')) fail('词频那一遍没有顺手记编号')
  if (!g.includes('pickI.push(id)')) fail('签名挑选还在按字符串比')
  if (!g.includes('words[id].charCodeAt(0) === 171')) fail('签名没有滤掉 «短语»')
  if (!read('docs/verified.md').includes('1.11.15（2026-11-15）')) fail('verified 缺 1.11.15 段')
  if (!read('docs/roadmap.md').includes('1.11.15 已交付')) fail('roadmap 缺 1.11.15 交付记录')
  if (!read('docs/release.md').includes('1.11.15 实测')) fail('release.md 缺 1.11.15 实测')
  if (!/1\.11\.(15|1[6-9]) 更新/.test(read('docs/benchmarks.md'))) fail('benchmarks 缺 1.11.15 之后的表')
  if (!read('CHANGELOG.md').includes('## 1.11.15')) fail('CHANGELOG 缺 1.11.15')
}
ok('1.11.15 构件：编号表 / 按编号比 / «短语» 过滤 / 文档五处')
// ---- 历史不能被版本脚本改写：产物文件名必须和它自己那版的版本号一致 ----
{
  const rel = read('docs/release.md').split(/\r?\n/)
  let bad = 0
  for (const line of rel) {
    const m = line.match(/^(1\.\d+\.\d+) 产物：.*?dsh-memory-nebula-(1\.\d+\.\d+)\.tgz/)
    if (m && m[1] !== m[2]) {
      bad++
      if (bad === 1) fail('release.md 历史产物文件名被改写：' + m[1] + ' 那行写着 ' + m[2] + '.tgz')
    }
  }
  if (bad > 1) fail('release.md 有 ' + bad + ' 行历史产物文件名对不上自己的版本')
}
ok('历史产物文件名与版本号一致（版本脚本只该改当前那一行）')
// ---- 1.11.16：建图里那两秒半，是把整张词表排了一遍 ----
{
  const g = read('lib/host/graph.js')
  if (!g.includes('export function topRareTokens(')) fail('稀有词挑选没有抽成纯函数')
  // 1.11.20 起建图改成「按编号挑签名」，不再调用 topRareTokens；两条路都认
  if (!g.includes('topRareTokens(node.tokens, tokenWeight, SIG_TOP)') && !g.includes('for (let i = 0; i < tids.length; i++)')) fail('建图既没调 topRareTokens 也没走编号挑签名')
  if (!g.includes('Number.isFinite(input.now)')) fail('建图的时间仍然无法冻结')
  if (!exists('test/graph-sig.test.mjs')) fail('缺签名等价性单测')
  if (!read('test/graph-sig.test.mjs').includes('冻结时间')) fail('单测没钉住建图的确定性')
  if (!read('docs/verified.md').includes('1.11.16（2026-11-15）')) fail('verified 缺 1.11.16 段')
  if (!read('docs/roadmap.md').includes('1.11.16 已交付')) fail('roadmap 缺 1.11.16 交付记录')
  if (!read('docs/release.md').includes('1.11.16 实测')) fail('release.md 缺 1.11.16 实测')
  if (!read('docs/benchmarks.md').includes('1.11.16 更新')) fail('benchmarks 没更新到 1.11.16')
  if (!read('CHANGELOG.md').includes('## 1.11.16')) fail('CHANGELOG 缺 1.11.16')
}
ok('1.11.16 构件：topRareTokens / 可冻结时间 / 确定性单测 / 文档五处')
// ---- 1.11.17：先问一句，再扫一遍 ----
{
  const t = read('lib/host/text.js')
  if (!t.includes('function stripEntityTail(v)')) fail('实体尾部清理没有改成手写扫描')
  if (!t.includes('stripEntityTail(String(m[0]).trim())')) fail('抽实体没有走 stripEntityTail')
  if (!t.includes('if (gate && !gate(lower)) continue')) fail('抽实体没有按字符判据跳规则')
  if (!t.includes("s.includes(':')")) fail('路径规则没有字符判据')
  if (!t.includes("s.includes('@')")) fail('邮箱规则没有字符判据')
  const g = read('lib/host/graph.js')
  if (!g.includes('const tokenId = new Map()')) fail('词频没有换成编号')
  if (!g.includes('new Int32Array(dfCap)')) fail('词频计数没有换成 Int32Array')
  if (!g.includes('const dfOfToken = (t) =>')) fail('缺 dfOfToken 取值函数')
  // 1.11.20 起 idf 预算成 Float64Array，df 只在建表时读一次；两种写法都认
  if (!g.includes('idf(dfOfToken(t) || 1, n)') && !g.includes('idfById[id] = idf(tokenDF[id] || 1, n)')) fail('词权重既没走 Map 取 df 也没走 idfById')
  if (!read('docs/verified.md').includes('1.11.17（2026-11-15）')) fail('verified 缺 1.11.17 段')
  if (!read('docs/roadmap.md').includes('1.11.17 已交付')) fail('roadmap 缺 1.11.17 交付记录')
  if (!read('docs/release.md').includes('1.11.17 实测')) fail('release.md 缺 1.11.17 实测')
  if (!read('docs/benchmarks.md').includes('1.11.17 更新')) fail('benchmarks 没更新到 1.11.17')
  if (!read('CHANGELOG.md').includes('## 1.11.17')) fail('CHANGELOG 缺 1.11.17')
}
ok('1.11.17 构件：字符判据 / 手写尾部清理 / 词频编号 / 文档五处')
// ---- 历史产物一个个点名：只要有一个被版本脚本改写掉就会漏出来 ----
{
  const rel = read('docs/release.md')
  const HIST = [
    '1.11.2', '1.11.3', '1.11.4', '1.11.5', '1.11.6', '1.11.7', '1.11.8', '1.11.9', '1.11.10',
    '1.11.11', '1.11.12', '1.11.13', '1.11.14', '1.11.15', '1.11.16', '1.11.17', '1.11.18',
    '1.11.19', '1.11.20', '1.11.21', '1.11.22', '1.11.23',
  ]
  const gone = HIST.filter((v) => !rel.includes('dsh-memory-nebula-' + v + '.tgz'))
  if (gone.length) fail('release.md 里这些历史产物名不见了（被改写过？）：' + gone.join(' / '))

  // 1.11.24 起：光「名字还在」不够。1.11.23 那版就出过两件：
  //   ① 1.11.22 段的产物行被整行替换成了 1.11.23.tgz（于是 1.11.23 出现两次、1.11.22 消失）；
  //   ② 因此上面的「点名」在 1.11.22 上会红，但当时还没把它列进名单。
  // 现在两条都查：产物行不许重名，且行首写了版本号就必须与文件名一致。
  const prodLines = rel.split('\n').filter((l) => l.includes('产物') && l.includes('dsh-memory-nebula-'))
  const seen = new Map()
  for (const line of prodLines) {
    const m = line.match(/dsh-memory-nebula-(\d+\.\d+\.\d+)\.tgz/)
    if (!m) continue
    const v = m[1]
    seen.set(v, (seen.get(v) || 0) + 1)
    const lead = line.match(/(\d+\.\d+\.\d+)\s*产物[：:]/)
    if (lead && lead[1] !== v) fail('release.md 里 ' + lead[1] + ' 段的产物行写的是 ' + v + '.tgz')
  }
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([v, n]) => v + '×' + n)
  if (dup.length) fail('release.md 里同一个产物名出现多次（历史被覆盖？）：' + dup.join(' / '))
}
ok('历史产物 ' + 22 + ' 个版本名都在，且没有重名 / 错段')

// ---- 1.11.18：两个节点之间那一对字符串，换成两个数字 ----
{
  const g = read('lib/host/graph.js')
  if (!g.includes('const PAIR_BASE = 1 << 20')) fail('候选对键没换数字基数')
  if (!g.includes('const pairKey = (a, b) =>')) fail('缺 pairKey')
  if (!g.includes('const pairA = (key) => Math.floor(key / PAIR_BASE)')) fail('缺 pairA 解码')
  if (!g.includes('const pairB = (key, a) => key - a * PAIR_BASE')) fail('缺 pairB 解码')
  if (!g.includes('const coKey = pairKey')) fail('coKey 还在另写一套键协议')
  if (g.includes("key.indexOf(':')")) fail('还有地方用字符串键解码')
  if (!read('docs/verified.md').includes('1.11.18（2026-11-15）')) fail('verified 缺 1.11.18 段')
  if (!read('docs/roadmap.md').includes('1.11.18 已交付')) fail('roadmap 缺 1.11.18 交付记录')
  if (!read('docs/release.md').includes('1.11.18 实测')) fail('release.md 缺 1.11.18 实测')
  if (!read('docs/benchmarks.md').includes('1.11.18 更新')) fail('benchmarks 没更新到 1.11.18')
  if (!read('CHANGELOG.md').includes('## 1.11.18')) fail('CHANGELOG 缺 1.11.18')
}
ok('1.11.18 构件：数字键 / 两处解码都换 / 不留字符串协议 / 文档五处')

// ---- 1.11.19：读库也要让路（逐行 iterate + 每 512 行 yield） ----
{
  const meow = read('lib/host/adapters/meow.js')
  const sqlite = read('lib/host/adapters/sqlite.js')
  const ingest = read('lib/host/adapters/ingest.js')
  const idx = read('lib/host/adapters/index.js')
  if (!meow.includes('export function* scanSteps(store)')) fail('meow 适配器缺 scanSteps 生成器')
  if (!sqlite.includes('export function* scanSteps(store)')) fail('sqlite 适配器缺 scanSteps 生成器')
  if (!ingest.includes('export function* scanSteps(store)')) fail('ingest 适配器缺 scanSteps 生成器')
  if (!meow.includes('(++batch & 511) === 0')) fail('meow 扫描没按 512 行让路')
  if (!idx.includes("typeof adapter.scanSteps === 'function'")) fail('扫描调度没优先走 scanSteps')
  if (!exists('test/scan-steps.test.mjs')) fail('缺读库让路的单测')
  if (!read('docs/verified.md').includes('1.11.19（2026-11-15）')) fail('verified 缺 1.11.19 段')
  if (!read('docs/roadmap.md').includes('1.11.19 已交付')) fail('roadmap 缺 1.11.19 交付记录')
  if (!read('docs/release.md').includes('1.11.19 实测')) fail('release.md 缺 1.11.19 实测')
  if (!read('docs/benchmarks.md').includes('1.11.19 更新')) fail('benchmarks 没更新到 1.11.19')
  if (!read('CHANGELOG.md').includes('## 1.11.19')) fail('CHANGELOG 缺 1.11.19')
}
ok('1.11.19 构件：三个适配器都逐行让路 / 调度优先走 scanSteps / 单测在 / 文档五处')

// ---- 1.11.20：挑最稀有的词，不再拼字符串（编号 + Float64Array 权重） ----
{
  const g = read('lib/host/graph.js')
  if (!g.includes('const idTokens = []')) fail('没有 id -> 词 的反查表')
  if (!g.includes('node.tids = tids')) fail('节点没存自己的词编号表')
  if (!g.includes('const idfById = new Float64Array(tokenId.size)')) fail('idf 没预算成按编号索引的数组')
  if (!g.includes('const w = idfById[id]')) fail('挑签名没按编号取权重')
  if (!g.includes('const pickI = new Int32Array(SIG_TOP)')) fail('签名槽位不是定长数组')
  noteDev('../dev/ab-1120.mjs'); if (!exists('../dev/ab-1120.mjs')) fail('缺 1.11.20 的 A/B 脚本')
  if (!read('docs/verified.md').includes('1.11.20（2026-11-15）')) fail('verified 缺 1.11.20 段')
  if (!read('docs/roadmap.md').includes('1.11.20 已交付')) fail('roadmap 缺 1.11.20 交付记录')
  if (!read('docs/release.md').includes('## 1.11.20 实测')) fail('release.md 缺 1.11.20 实测')
  if (!read('docs/benchmarks.md').includes('1.11.20 更新')) fail('benchmarks 没更新到 1.11.20')
  if (!read('CHANGELOG.md').includes('## 1.11.20')) fail('CHANGELOG 缺 1.11.20')
}
ok('1.11.20 构件：编号表 / idfById / 定长槽位 / A-B 脚本 / 文档五处')

// ---- 1.11.21：签名换成升序编号数组（双指针合并、df 读数组、不哈希字符串） ----
{
  const g = read('lib/host/graph.js')
  if (!g.includes('const EMPTY_IDS = new Int32Array(0)')) fail('没有空签名常量')
  if (!g.includes('node.sigIds = ids')) fail('节点签名没换成编号数组')
  if (!g.includes('while (xa < aIds.length && yb < bIds.length)')) fail('打分没改成双指针合并')
  if (!g.includes('if (tokenDF[id] > tokenLimit) continue')) fail('候选倒排没直接读 df 数组')
  noteDev('../dev/ab-1121.mjs'); if (!exists('../dev/ab-1121.mjs')) fail('缺 1.11.21 的 A/B 脚本')
  noteDev('../dev/probe-heap-1121.mjs'); if (!exists('../dev/probe-heap-1121.mjs')) fail('缺 1.11.21 的堆测量脚本')
  if (!read('docs/verified.md').includes('1.11.21（2026-11-15）')) fail('verified 缺 1.11.21 段')
  if (!read('docs/roadmap.md').includes('1.11.21 已交付')) fail('roadmap 缺 1.11.21 交付记录')
  if (!read('docs/release.md').includes('## 1.11.21 实测')) fail('release.md 缺 1.11.21 实测')
  if (!read('docs/benchmarks.md').includes('1.11.21 更新')) fail('benchmarks 没更新到 1.11.21')
  if (!read('CHANGELOG.md').includes('## 1.11.21')) fail('CHANGELOG 缺 1.11.21')
}
ok('1.11.21 构件：编号签名 / 双指针 / df 读数组 / 两个脚本 / 文档五处')

// ---- 1.11.22：只在 key 上的分只算一次；倒排键换编号 ----
{
  const g = read('lib/host/graph.js')
  if (!g.includes('const entScoreCache = new Map()')) fail('实体分没有缓存表')
  if (!g.includes('const entScoreOf = (key) =>')) fail('缺 entScoreOf')
  if (!g.includes('const rec = entScoreOf(s.ent[i])')) fail('实体循环没走缓存')
  if (!g.includes('push(tokenPost, id, node.i)')) fail('倒排键没换成词编号')
  noteDev('../dev/ab-1122.mjs'); if (!exists('../dev/ab-1122.mjs')) fail('缺 1.11.22 的 A/B 脚本')
  noteDev('../dev/probe-entities-combined.mjs'); if (!exists('../dev/probe-entities-combined.mjs')) fail('缺合成正则的反例探针')
  if (!read('docs/verified.md').includes('1.11.22（2026-11-15）')) fail('verified 缺 1.11.22 段')
  if (!read('docs/roadmap.md').includes('1.11.22 已交付')) fail('roadmap 缺 1.11.22 交付记录')
  if (!read('docs/release.md').includes('## 1.11.22 实测')) fail('release.md 缺 1.11.22 实测')
  if (!read('docs/benchmarks.md').includes('1.11.22 更新')) fail('benchmarks 没更新到 1.11.22')
  if (!read('CHANGELOG.md').includes('## 1.11.22')) fail('CHANGELOG 缺 1.11.22')
}
ok('1.11.22 构件：实体分缓存 / 倒排编号键 / 交错 A-B / 合成正则反例 / 文档五处')

// ---- 1.11.23：读不动的来源要一直挂在界面上 ----
{
  if (!read('lib/host/nebula.js').includes('readErrors: (this.graph.sources || [])')) fail('overview 没有 readErrors')
  if (!read('lib/host/share.js').includes('const safeReadErrors = (readErrors || []).map')) fail('快照没给 readErrors 脱敏')
  if (!read('lib/host/share.js').includes('id="snapshot-readerr"')) fail('快照缺读不动横幅')
  if (!read('lib/web/app.js').includes('function renderReadErrors(ov)')) fail('界面缺常驻横幅')
  if (!read('lib/web/app.js').includes("T(' 个库读不动')")) fail('概览标题没带计数')
  if (!read('lib/web/index.html').includes('id="readerr" role="status" aria-live="polite"')) fail('横幅缺 status/aria-live')
  if (!exists('test/read-errors.test.mjs')) fail('缺读不动的单测')
  noteDev('../dev/verify-readerr.mjs'); if (!exists('../dev/verify-readerr.mjs')) fail('缺读不动的浏览器验收脚本')
  if (!read('docs/verified.md').includes('1.11.23（2026-11-15）')) fail('verified 缺 1.11.23 段')
  if (!read('docs/roadmap.md').includes('1.11.23 已交付')) fail('roadmap 缺 1.11.23')
  if (!read('docs/release.md').includes('## 1.11.23 实测')) fail('release.md 缺 1.11.23 实测')
  if (!read('docs/accessibility.md').includes('## 三、少了一整块')) fail('accessibility 缺这一节')
  if (!read('CHANGELOG.md').includes('## 1.11.23')) fail('CHANGELOG 缺 1.11.23')
}
ok('1.11.23 构件：readErrors / 常驻横幅 / 快照脱敏横幅 / 单测与探针 / 文档四处')

// ---- 1.11.24：什么都没变，就别重建 ----
{
  const h = read('lib/host/http.js')
  if (!h.includes("const force = url.searchParams.get('force') === '1'")) fail('http 的 /refresh 没读 force')
  if (!h.includes("unchanged: Boolean(last.rebuilt) === false && last.why === 'unchanged'")) fail('http 没按三态算 unchanged')
  if (!h.includes('why: last.why || ')) fail('http 没回报 why')
  const n = read('lib/host/nebula.js')
  if (!n.includes("this.lastRefresh = { rebuilt: false, why: 'unchanged'")) fail('nebula 没记 unchanged')
  if (!n.includes("this.lastRefresh = { rebuilt: false, why: 'joined'")) fail('nebula 没记 joined')
  if (!n.includes("this.lastRefresh = { rebuilt: true, why: 'rebuilt'")) fail('nebula 没记 rebuilt')
  const a = read('lib/web/app.js')
  if (!a.includes("if (graph.why === 'unchanged')")) fail('界面没按 unchanged 分支说话')
  if (!a.includes("T('什么都没变，没重建：')")) fail('界面没这句文案')
  if (!read('lib/web/i18n.js').includes('"什么都没变，没重建："')) fail('i18n 缺「什么都没变」')
  if (!exists('test/refresh-skip.test.mjs')) fail('缺 test/refresh-skip.test.mjs')
  noteDev('../dev/probe-refresh-skip.mjs'); if (!exists('../dev/probe-refresh-skip.mjs')) fail('缺 dev/probe-refresh-skip.mjs')
  noteDev('../dev/verify-refresh-toast.mjs'); if (!exists('../dev/verify-refresh-toast.mjs')) fail('缺 dev/verify-refresh-toast.mjs')
  if (!read('docs/verified.md').includes('1.11.24（2026-11-15）什么都没变，就别重建')) fail('verified 缺 1.11.24 段')
  if (!read('docs/roadmap.md').includes('1.11.24 已交付')) fail('roadmap 缺 1.11.24')
  if (!read('docs/release.md').includes('1.11.24 实测')) fail('release.md 缺 1.11.24 实测')
  if (!/重建星图：什么时候该重建（1\.11\.(24|2[5-9]) 更新）/.test(read('docs/benchmarks.md'))) fail('benchmarks 缺 1.11.24 节')
  if (!read('CHANGELOG.md').includes('## 1.11.24')) fail('CHANGELOG 缺 1.11.24')
  if (!read('docs/http-api.md').includes('### `POST /refresh` 的三种结果（1.11.24 起）')) fail('http-api.md 没写 /refresh 的三态契约')
  if (!read('docs/http-api.md').includes('?force=1` 跳过指纹检查')) fail('http-api.md 没写 force 的语义')
  if (!read('scripts/verify-all.mjs').includes("['重建星图：不变就不建'")) fail('verify-all 没接这把尺子')
}
ok('1.11.24 构件：指纹跳过 / 三态回报 / 界面照实说 / 两把新尺子 / 文档五处')

// ---- 1.11.25：页面每开一次，就白建一次图 ----
{
  const http = read('lib/host/http.js')
  if (!http.includes("const wantRefresh = url.searchParams.get('refresh') === '1'")) fail('http.js 没有把 refresh=1 与 force 分开')
  if (!http.includes("const forceRebuild = url.searchParams.get('force') === '1'")) fail('http.js 没有读 force=1')
  if (!http.includes('await src.refresh({ force: forceRebuild })')) fail('http.js 的 /graph 仍可能把 force 写死')
  if (http.includes("wait src.refresh({ force: url.searchParams.get('refresh') === '1' })")) fail('http.js 还在把 refresh=1 当强制重建')
  const t = read('test/refresh-skip.test.mjs')
  if (!t.includes('HTTP：/graph?refresh=1 没变时不动图')) fail('单测没有覆盖 /graph?refresh=1')
  if (!t.includes('HTTP：POST /refresh 第二次说 unchanged')) fail('单测没有覆盖 HTTP 层的 unchanged')
  noteDev('../dev/probe-refresh-skip.mjs'); if (!exists('../dev/probe-refresh-skip.mjs')) fail('缺 dev/probe-refresh-skip.mjs')
  if (!read('docs/verified.md').includes('1.11.25（2026-11-15）页面每开一次，就白建一次图')) fail('verified 缺 1.11.25 段')
  if (!read('docs/roadmap.md').includes('1.11.25 已交付')) fail('roadmap 缺 1.11.25')
  if (!read('docs/release.md').includes('1.11.25 实测')) fail('release.md 缺 1.11.25 实测')
  if (!read('docs/benchmarks.md').includes('重建星图：什么时候该重建（1.11.25 更新）')) fail('benchmarks 没更新到 1.11.25')
  if (!read('CHANGELOG.md').includes('## 1.11.25')) fail('CHANGELOG 缺 1.11.25')
  if (!read('docs/http-api.md').includes('### `GET /graph` 的两档刷新（1.11.25 起）')) fail('http-api.md 没写 /graph 的两档刷新')
}
ok('1.11.25 构件：refresh=1 与 force=1 分开 / HTTP 层单测 / 文档六处')

// --- 1.11.26：策展一条关联就地生效，不再重建整张图 ---
{
  const neb = read('lib/host/nebula.js')
  if (!neb.includes('#applyCurated(kind, aId, bId, note)')) fail('nebula.js 没有 #applyCurated')
  if (!neb.includes('#restoreCurated(aId, bId)')) fail('nebula.js 没有 #restoreCurated')
  if (!neb.includes('takeRebuildFlag()')) fail('nebula.js 没有 takeRebuildFlag')
  if (!neb.includes("const pair = l.a < l.b ? l.a + '>' + l.b : l.b + '>' + l.a")) fail('签名还在用 updatedAt，没换成 id 对')
  if (neb.includes('links[0]?.updatedAt')) fail('签名里还留着 links[0].updatedAt')
  if (!neb.includes('if (at >= 0) {')) fail('#applyCurated 在「边已存在」时没有 restamp')
  const store = read('lib/host/store.js')
  if (!store.includes('export function closeStore()')) fail('store.js 没有 closeStore()')
  const http = read('lib/host/http.js')
  if (http.includes("src.link(body.a, body.b, body.note || '')\n        await src.refresh({ force: true })")) fail('http.js 的 /link 还在重建')
  const t = read('test/curate-incremental.test.mjs')
  if (!t.includes('HTTP：POST /link 就地生效')) fail('单测没有覆盖 HTTP 层 /link')
  if (!t.includes('closeStore()')) fail('策展单测没有关 sidecar 库，会互相污染')
  noteDev('../dev/probe-curate-speed.mjs'); if (!exists('../dev/probe-curate-speed.mjs')) fail('缺 dev/probe-curate-speed.mjs')
  noteDev('../dev/probe-curate-recount.mjs'); if (!exists('../dev/probe-curate-recount.mjs')) fail('缺 dev/probe-curate-recount.mjs')
  noteDev('../dev/probe-curate-diff.mjs'); if (!exists('../dev/probe-curate-diff.mjs')) fail('缺 dev/probe-curate-diff.mjs')
  if (!read('CHANGELOG.md').includes('## 1.11.26')) fail('CHANGELOG 缺 1.11.26')
  if (!read('docs/verified.md').includes('## 1.11.26（2026-11-15）')) fail('verified 缺 1.11.26 段')
  if (!read('docs/roadmap.md').includes('1.11.26 已交付')) fail('roadmap 缺 1.11.26')
  if (!read('docs/release.md').includes('1.11.26 实测')) fail('release.md 缺 1.11.26 实测')
  if (!read('docs/benchmarks.md').includes('（1.11.26 更新）')) fail('benchmarks 没更新到 1.11.26')
  if (!read('docs/http-api.md').includes('1.11.26 起')) fail('http-api.md 没写策展接口的就地语义')
}
ok('1.11.26 构件：就地策展 / 稳定签名 / closeStore / 探针与单测 / 文档六处')

// --- 1.11.27：建完图在后台把检索缓存算好 ---
{
  const rec = read('lib/host/recall.js')
  if (!rec.includes('export function tokenCacheReady(graph)')) fail('recall.js 没有 tokenCacheReady()')
  if (!rec.includes('const TOKEN_CACHE = new WeakMap()')) fail('recall.js 的 TOKEN_CACHE 不是 WeakMap')
  const neb = read('lib/host/nebula.js')
  if (!neb.includes('#schedulePrewarm(graph)')) fail('nebula.js 没有 #schedulePrewarm')
  if (!neb.includes('ensureTokenCacheAsync(graph)')) fail('nebula.js 没调 ensureTokenCacheAsync')
  if (!neb.includes('NEBULA_PREWARM_DELAY')) fail('nebula.js 没读 NEBULA_PREWARM_DELAY')
  if (!neb.includes("why: 'skipped'")) fail('预热到点没检查「图还是那张图」')
  const api = read('lib/web/api.js')
  if (!api.includes('const REFRESH_TIMEOUT_MS = 60000')) fail('api.js 没给 /refresh 单独的超时')
  if (!api.includes("post('/refresh', {}, REFRESH_TIMEOUT_MS)")) fail('api.js 的 refresh 没用 REFRESH_TIMEOUT_MS')
  if (!read('CHANGELOG.md').includes('附带修复：重建的请求不该被自己的慢判成失败')) fail('CHANGELOG 没写附带修复')
  if (!exists('test/prewarm.test.mjs')) fail('缺 test/prewarm.test.mjs')
  noteDev('../dev/probe-prewarm.mjs'); if (!exists('../dev/probe-prewarm.mjs')) fail('缺 dev/probe-prewarm.mjs')
  if (!read('CHANGELOG.md').includes('## 1.11.27')) fail('CHANGELOG 缺 1.11.27')
  if (!read('docs/verified.md').includes('## 1.11.27')) fail('verified 缺 1.11.27 段')
  if (!read('docs/roadmap.md').includes('1.11.27 已交付')) fail('roadmap 缺 1.11.27')
  if (!read('docs/release.md').includes('1.11.27 实测')) fail('release.md 缺 1.11.27 实测')
  if (!read('docs/benchmarks.md').includes('（1.11.27 更新）')) fail('benchmarks 没更新到 1.11.27')
  if (!read('docs/http-api.md').includes('1.11.27 起')) fail('http-api.md 没写后台预热')
}
ok('1.11.27 构件：后台预热 / 可关可让位 / 单测与探针 / 文档六处')

{
  const gc = read('lib/host/graphcache.js')
  if (!gc.includes('export function cacheName(signature)')) fail('图缓存没定义文件名')
  if (!gc.includes('export function cacheEnabled()')) fail('图缓存没有开关')
  if (!gc.includes('export async function loadGraphCache(')) fail('图缓存没有读盘')
  if (!gc.includes('export async function saveGraphCache(')) fail('图缓存没有写盘')
  if (!gc.includes('renameSync(tmp, file)')) fail('写盘不是原子的（先 tmp 再 rename）')
  if (!gc.includes('BROTLI_PARAM_QUALITY')) fail('缓存没压缩')
  if (!gc.includes('const KEEP = 3')) fail('缓存没限制保留份数')
  const neb = read('lib/host/nebula.js')
  if (!neb.includes('loadGraphCache(this.cacheDir, signature)')) fail('refresh 没先问盘')
  if (!neb.includes("why: 'cached'") && !neb.includes("why: stale ? 'stale-cache' : 'cached'")) fail('读盘命中没标成 cached')
  if (!neb.includes('cacheWriteDone()')) fail('写盘没给出等待入口')
  if (!neb.includes('saveGraphCache(this.cacheDir, signature')) fail('建完图没写盘')
  if (!exists('test/graph-cache.test.mjs')) fail('缺 test/graph-cache.test.mjs')
  noteDev('../dev/probe-cache-start.mjs'); if (!exists('../dev/probe-cache-start.mjs')) fail('缺 dev/probe-cache-start.mjs')
  noteDev('../dev/probe-cache-size.mjs'); if (!exists('../dev/probe-cache-size.mjs')) fail('缺 dev/probe-cache-size.mjs')
  if (!read('CHANGELOG.md').includes('## 1.11.28')) fail('CHANGELOG 缺 1.11.28')
  if (!read('docs/verified.md').includes('## 1.11.28')) fail('verified 缺 1.11.28 段')
  if (!read('docs/roadmap.md').includes('1.11.28 已交付')) fail('roadmap 缺 1.11.28')
  if (!read('docs/release.md').includes('1.11.28 实测')) fail('release.md 缺 1.11.28 实测')
  if (!read('docs/benchmarks.md').includes('读盘还是重建')) fail('benchmarks 缺读盘 vs 重建')
  if (!read('README.md').includes('NEBULA_CACHE=0')) fail('README 没写缓存开关')
}
ok('1.11.28 构件：读盘缓存 / 原子写 / 压缩 / 单测与探针 / 文档六处')


// ── 1.11.29：体检预热 ─────────────────────────────────────────────
{
  const neb = read('lib/host/nebula.js')
  if (!neb.includes('this.hygieneWarm = ')) fail('缺 hygieneWarm 开关')
  if (!neb.includes("NEBULA_HYGIENE_WARM")) fail('缺 NEBULA_HYGIENE_WARM 环境变量')
  if (!neb.includes('this.lastHygieneWarm = null')) fail('缺 lastHygieneWarm 记录')
  if (!neb.includes('await this.hygieneAsync()')) fail('预热没去算体检')
  if (!exists('test/hygiene-warm.test.mjs')) fail('缺体检预热单测')
  else if (!read('test/hygiene-warm.test.mjs').includes('也不该留下体检缓存')) fail('体检预热单测缺「关掉就不算」那条')
  noteDev('../dev/probe-overview-warm.mjs'); if (!exists('../dev/probe-overview-warm.mjs')) fail('缺 dev/probe-overview-warm.mjs')
  const docs29 = [
    ['CHANGELOG.md', '## 1.11.29 — 2026-11-15'],
    ['docs/verified.md', '## 1.11.29（2026-11-15）'],
    ['docs/roadmap.md', '1.11.29 已交付'],
    ['docs/release.md', '## 1.11.29 实测'],
    ['docs/benchmarks.md', '点开体检之前'],
    ['README.md', 'NEBULA_HYGIENE_WARM'],
  ]
  for (const [f, needle] of docs29) if (!read(f).includes(needle)) fail('1.11.29 文档缺 ' + f + ' 的「' + needle + '」')
  ok('1.11.29 构件：体检预热 / 环境变量 / 单测与探针 / 文档六处')
}

// ── 1.11.30：先给手上这张图，新的建完再换 ────────────────────────
{
  const neb = read('lib/host/nebula.js')
  // 1.11.33 起宽松读盘多带一个「来源集合」参数，两种写法都认
  if (!neb.includes('loadNewestGraphCache(this.cacheDir)') && !neb.includes('loadNewestGraphCache(this.cacheDir, srcKey)')) {
    fail('签名对不上时没去读最新那份缓存')
  }
  if (!neb.includes("why: stale ? 'stale-cache' : 'cached'")) fail('过期缓存没标成 stale-cache')
  if (!neb.includes('this.signature = hit.sig || signature')) fail('恢复旧图后没写回旧签名（下次会以为没变）')
  if (!neb.includes('refreshInBackground(opts = {})')) fail('缺 refreshInBackground')
  if (!neb.includes('if (this._bgRefreshPending)')) fail('过期缓存之后没排后台重建')
  const gc = read('lib/host/graphcache.js')
  if (!gc.includes('export async function loadNewestGraphCache(dir)') && !gc.includes('export async function loadNewestGraphCache(dir, srcs)')) {
    fail('graphcache 缺 loadNewestGraphCache')
  }
  const http = read('lib/host/http.js')
  if (!http.includes('src.refreshInBackground({})')) fail('/graph 有图时还在等重建')
  if (!http.includes('stale: Boolean(src.staleGraph)')) fail('/graph 没说清这份图是旧的')
  const app = read('lib/web/app.js')
  if (!app.includes('function watchBackgroundRefresh()')) fail('页面没有「等后台建完再换图」的那条路')
  if (!app.includes('if (g.refreshing || g.stale) watchBackgroundRefresh()')) fail('applyGraph 里没挂后台换图')
  if (!app.includes('API.graph({ refresh: 1 })')) fail('首屏没顺手问一句有没有新东西')
  if (!exists('test/bg-refresh.test.mjs')) fail('缺 test/bg-refresh.test.mjs')
  else if (!read('test/bg-refresh.test.mjs').includes('先把上一份图给出来')) fail('缺「先给旧图」那条单测')
  noteDev('../dev/verify-bg-refresh.mjs'); if (!exists('../dev/verify-bg-refresh.mjs')) fail('缺 dev/verify-bg-refresh.mjs')
  noteDev('dev/probe-stale-start.mjs'); if (!exists('dev/probe-stale-start.mjs')) fail('缺 dev/probe-stale-start.mjs')
  noteDev('../dev/probe-cache-restore.mjs'); if (!exists('../dev/probe-cache-restore.mjs')) fail('缺 dev/probe-cache-restore.mjs')
  const docs30 = [
    ['CHANGELOG.md', '## 1.11.30 — 2026-11-15'],
    ['docs/verified.md', '## 1.11.30（2026-11-15）'],
    ['docs/roadmap.md', '1.11.30 已交付'],
    ['docs/release.md', '## 1.11.30 实测'],
    ['docs/benchmarks.md', '新的建完再换（1.11.30 更新）'],
    ['docs/http-api.md', 'refreshing 与 stale（1.11.30 起）'],
  ]
  for (const [f, needle] of docs30) if (!read(f).includes(needle)) fail('1.11.30 文档缺 ' + f + ' 的「' + needle + '」')
  ok('1.11.30 构件：过期缓存先给 / 后台重建 / 页面自己换图 / 单测与探针 / 文档六处')
}

// ── 1.11.31：换了算法，别拿旧图糊弄我 ────────────────────────────
{
  const gc = read('lib/host/graphcache.js')
  // 1.11.33 起格式升到 3（文件里多记一个来源集合指纹），2 与 3 都算「升过」
  if (!gc.includes('const VERSION = 2') && !gc.includes('const VERSION = 3')) fail('缓存格式没升过（旧缓存要能被认出来）')
  if (!gc.includes('const IMPL_FILES = ')) fail('缺算法指纹的文件清单')
  if (!gc.includes('export function implFingerprint()')) fail('缺 implFingerprint')
  if (!gc.includes('impl: impl || implFingerprint()')) fail('写盘没记下算法指纹')
  if (!gc.includes('data.impl !== impl')) fail('严格读盘没比对算法指纹')
  const neb = read('lib/host/nebula.js')
  if (!neb.includes('implFingerprint')) fail('nebula 没用上算法指纹')
  if (!neb.includes('let implStale = false')) fail('缺 implStale 判定')
  if (!neb.includes('stale, implStale }')) fail('lastCache 没记下「这是旧算法算的」')
  if (!neb.includes('if (implStale) this._bgForce = true')) fail('旧算法缓存没排强制重建（签名没变会被跳过）')
  if (!neb.includes('refreshInBackground(forceBg ? { force: true } : {})')) fail('后台那一轮没带 force')
  if (!exists('test/cache-impl.test.mjs')) fail('缺 test/cache-impl.test.mjs')
  else if (!read('test/cache-impl.test.mjs').includes('旧算法写的缓存')) fail('缺「旧算法缓存不被当成答案」那条单测')
  noteDev('dev/probe-impl-upgrade.mjs'); if (!exists('dev/probe-impl-upgrade.mjs')) fail('缺 dev/probe-impl-upgrade.mjs')
  const docs31 = [
    ['CHANGELOG.md', '## 1.11.31 — 2026-11-15'],
    ['docs/verified.md', '## 1.11.31（2026-11-15）'],
    ['docs/roadmap.md', '1.11.31 已交付'],
    ['docs/release.md', '## 1.11.31 实测'],
    ['docs/benchmarks.md', '（1.11.31 更新）'],
  ]
  for (const [f, needle] of docs31) if (!read(f).includes(needle)) fail('1.11.31 文档缺 ' + f + ' 的「' + needle + '」')
  ok('1.11.31 构件：算法指纹 / 严格读盘拒绝 / 强制后台重建 / 单测与探针 / 文档五处')
}


// ── 1.11.32：建图那七秒，让界面说清走到哪了 ──────────────────────────
{
  const neb = read('lib/host/nebula.js')
  const graph = read('lib/host/graph.js')
  const http = read('lib/host/http.js')
  const app = read('lib/web/app.js')
  if (!neb.includes('export const BUILD_STAGES')) fail('缺 BUILD_STAGES 阶段表')
  if (!neb.includes('const STAGE_LABELS = {')) fail('缺阶段中文名')
  if (!neb.includes('this.buildProgress = null')) fail('缺 buildProgress 字段')
  if (!neb.includes('onStep: (stage) => setStage(stage)')) fail('建图没挂着进度回调')
  if (!neb.includes("setStage('scan')")) fail('读来源那一步没标进度')
  if (!graph.includes('if (onStep) onStep(step.value)')) fail('buildGraphAsync 没把阶段透出来')
  if (!http.includes("route === '/progress'")) fail('缺 GET /progress')
  if (!http.includes('progress: src.buildProgress || null')) fail('/progress 没带上阶段')
  if (!http.includes("'progress',")) fail('CAPABILITIES 里没登记 progress')
  if (!app.includes('function watchBuildProgress()')) fail('首屏没在建图时轮询进度')
  if (!app.includes('const stopProgress = watchBuildProgress()')) fail('首屏取图前后没收尾进度轮询')
  if (!exists('test/build-progress.test.mjs')) fail('缺 test/build-progress.test.mjs')
  else if (!read('test/build-progress.test.mjs').includes('BUILD_STAGES')) fail('单测没断言阶段名')
  noteDev('../dev/verify-build-progress.mjs'); if (!exists('../dev/verify-build-progress.mjs')) fail('缺 ../dev/verify-build-progress.mjs')
  const docs32 = [
    ['CHANGELOG.md', '## 1.11.32 — 2026-11-15'],
    ['docs/verified.md', '## 1.11.32（2026-11-15）'],
    ['docs/roadmap.md', '1.11.32 已交付'],
    ['docs/release.md', '## 1.11.32 实测'],
    ['docs/benchmarks.md', '（1.11.32 更新）'],
    ['docs/http-api.md', 'GET /progress'],
  ]
  for (const [f, needle] of docs32) if (!read(f).includes(needle)) fail('1.11.32 文档缺 ' + f + ' 的「' + needle + '」')
  ok('1.11.32 构件：阶段表 / 进度回调 / GET /progress / 遮罩进度 / 单测与探针 / 文档六处')
}{
  // 1.11.33：缓存要认门（来源集合）、告示不能丢、词频表单飞
  const gc33 = read("lib/host/graphcache.js")
  if (!gc33.includes("export function sourceSetKey(ids)")) fail("缺来源集合指纹 sourceSetKey")
  if (!gc33.includes("if (srcs && data.srcs !== srcs) continue")) fail("宽松读盘没核对来源集合")
  if (!gc33.includes("srcs: srcs || ")) fail("写盘没记来源集合")
  if (!gc33.includes("sources: (graph.sources || []).map")) fail("缓存没存来源清单（坏来源的告示会丢）")
  const neb33 = read("lib/host/nebula.js")
  if (!neb33.includes("const srcKey = sourceSetKey(")) fail("nebula 没算来源集合指纹")
  if (!neb33.includes("loadNewestGraphCache(this.cacheDir, srcKey)")) fail("宽松读盘没把来源集合传进去")
  if (!neb33.includes("srcs: srcKey")) fail("写盘没带上来源集合")
  if (!neb33.includes("const errById = new Map()")) fail("读盘恢复没把坏来源的错误接回来")
  const recall33 = read("lib/host/recall.js")
  if (!recall33.includes("const TOKEN_INFLIGHT = new WeakMap()")) fail("词频表没有单飞登记")
  if (!recall33.includes("const running = TOKEN_INFLIGHT.get(graph)")) fail("词频表没有复用正在算的那一趟")
  const tests33 = ["test/cache-sources.test.mjs", "test/cache-readerrors.test.mjs", "test/recall-inflight.test.mjs"]
  for (const t of tests33) if (!exists(t)) fail("缺 " + t)
  if (exists("test/cache-sources.test.mjs") && !read("test/cache-sources.test.mjs").includes("不认上一份缓存")) {
    fail("cache-sources 单测没断言「换了库不认上一份缓存」")
  }
  if (exists("test/recall-inflight.test.mjs") && !read("test/recall-inflight.test.mjs").includes("只算一趟")) {
    fail("recall-inflight 单测没断言「只算一趟」")
  }
  const docs33 = [
    ["CHANGELOG.md", "主题：别人的图，不该端给我"],
    ["docs/verified.md", "## 1.11.33（2026-11-15）"],
    ["docs/roadmap.md", "1.11.33 已交付"],
    ["docs/release.md", "## 1.11.33 实测"],
    ["docs/benchmarks.md", "缓存也要认门（1.11.33 更新）"],
  ]
  for (const [f, needle] of docs33) if (!read(f).includes(needle)) fail("1.11.33 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.33 构件：来源集合指纹 / 告示随缓存回来 / 词频表单飞 / 单测三项 / 文档五处")
}
{
  // 1.11.34：库大到什么程度，就该有人说一声
  const neb34 = read("lib/host/nebula.js")
  if (!neb34.includes("export const LARGE_LIBRARY_NODES = 150000")) fail("缺大库门槛常量")
  if (!neb34.includes("this.scale = this.#scaleOf(graph)")) fail("建图之后没记规模")
  if (!neb34.includes("#scaleOf(graph)")) fail("没有 #scaleOf")
  if (!neb34.includes("#warnings()")) fail("没有 #warnings")
  if (!neb34.includes("NEBULA_LARGE_LIBRARY")) fail("门槛不能用环境变量调")
  const http34 = read("lib/host/http.js")
  if (!http34.includes("scale: src.scale || null")) fail("/ping 与 /progress 没带 scale")
  const app34 = read("lib/web/app.js")
  if (!app34.includes("if (w.code !== 'large-library') continue")) fail("界面没渲染大库告示")
  if (!exists("test/scale-warning.test.mjs")) fail("缺 test/scale-warning.test.mjs")
  else if (!read("test/scale-warning.test.mjs").includes("large-library")) fail("大库单测没断言告示码")
  for (const p of ["../dev/verify-scale-note.mjs", "dev/probe-scale-200k.mjs"]) {
    if (!exists(p)) fail("缺 " + p)
  }
  const docs34 = [
    ["CHANGELOG.md", "库大到什么程度，就该有人说一声"],
    ["docs/verified.md", "## 1.11.34（2026-11-15）"],
    ["docs/roadmap.md", "1.11.34 已交付"],
    ["docs/release.md", "## 1.11.34 实测"],
    ["docs/benchmarks.md", "库大到什么程度会开始难用（1.11.34 更新）"],
    ["docs/http-api.md", "的 scale 与"],
    ["README.md", "NEBULA_LARGE_LIBRARY"],
  ]
  for (const [f, needle] of docs34) if (!read(f).includes(needle)) fail("1.11.34 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.34 构件：大库门槛 / scale 上报 / 界面那句实话 / 单测与探针 / 文档七处")
  // 1.11.35：别人的库第一次真的读得出来 + ETag 里的中文
  const sqlite35 = read("lib/host/adapters/sqlite.js")
  for (const needle of [
    "function tablesOf(db)",
    "const all = tablesOf(db)",
    "if (KNOWN.includes(low)) return low",
    "low.slice(0, -3) + 'y'",
  ]) {
    if (!sqlite35.includes(needle)) fail("sqlite 适配器缺：" + needle)
  }
  const http35 = read("lib/host/http.js")
  for (const needle of [
    "function etagSafe(text)",
    "etagSafe(src.signature)",
    'if (!/^[\\x20-\\x7e]*$/.test(String(value))) delete headers[key]',
  ]) {
    if (!http35.includes(needle)) fail("http 缺：" + needle)
  }
  for (const p of ["test/adapters-notes.test.mjs", "test/adapters-sqlite.test.mjs", "test/http-etag.test.mjs", "dev/probe-sqlite-source.mjs"]) {
    if (!exists(p)) fail("缺 " + p)
  }
  if (exists("test/http-etag.test.mjs") && !read("test/http-etag.test.mjs").includes("etag 必须是纯 ASCII")) {
    fail("ETag 回归测试没断言 ASCII")
  }
  const docs35 = [
    ["CHANGELOG.md", "别人的库，第一次真的读得出来"],
    ["docs/verified.md", "## 1.11.35（2026-11-15）"],
    ["docs/roadmap.md", "1.11.35 已交付"],
    ["docs/release.md", "## 1.11.35 实测"],
    ["docs/benchmarks.md", "单测覆盖到哪儿了（1.11.35 更新）"],
  ]
  for (const [f, needle] of docs35) if (!read(f).includes(needle)) fail("1.11.35 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.35 构件：别人家适配器读得出来 / 表名单复数 / ETag 的 ASCII / 三份新单测与探针 / 文档五处")

  // 1.11.36：注入桥的默认路径（hops 不能是 NaN）+ 两支补测
  const bridge36 = read("lib/host/bridge.js")
  for (const needle of [
    "function num(value, fallback)",
    "const hops = Math.max(0, Math.min(3, num(opts.hops, 1)))",
    "hops: num(raw.hops, DEFAULT_BUDGET.hops)",
    "默认不要：0.7 降权只在明确允许时生效",
  ]) {
    if (!bridge36.includes(needle)) fail("bridge.js 缺：" + needle)
  }
  const index36 = read("lib/index.js")
  if (index36.includes("Number(args.hops) ??")) fail("lib/index.js 里还留着 Number(args.hops) ?? 1（NaN 会过去）")
  if (!index36.includes("Number.isFinite(Number(args.hops))")) fail("lib/index.js 的 hops 没用 Number.isFinite 判定")
  for (const p of ["test/bridge.test.mjs", "test/ledger.test.mjs", "dev/probe-bridge-hops.mjs"]) {
    if (!exists(p)) fail("缺 " + p)
  }
  if (exists("test/bridge.test.mjs") && !read("test/bridge.test.mjs").includes("hops 是 NaN 时按 1 跳算")) {
    fail("bridge 单测没有 NaN 的回归用例")
  }
  const docs36 = [
    ["CHANGELOG.md", "默认那一档，从来没跑过"],
    ["docs/verified.md", "## 1.11.36（2026-11-15）"],
    ["docs/roadmap.md", "1.11.36 已交付"],
    ["docs/release.md", "## 1.11.36 实测"],
    ["docs/benchmarks.md", "那一档没人走过（1.11.36 更新）"],
  ]
  for (const [f, needle] of docs36) if (!read(f).includes(needle)) fail("1.11.36 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.36 构件：默认 hops 不再是 NaN / 预算数字兜底 / stale 注释如实 / 两支补测 / 文档五处")

  // 1.11.37：会话索引要有保质期（NEBULA_TRANSCRIPT_INDEX_TTL）+ null 不进缓存 + 统计 O(n)
  const tr37 = read("lib/host/transcripts.js")
  for (const needle of [
    "const INDEX_TTL_DEFAULT = 30 * 1000",
    "export function resetTranscriptIndex()",
    "if (transcriptIndex && Date.now() - transcriptIndexAt < indexTtlMs()) return transcriptIndex",
    "transcriptIndexAt = Date.now()",
    "NEBULA_TRANSCRIPT_INDEX_TTL",
    "// 不缓存 null：会话可能刚刚才有转写，索引下一轮重扫就能找到它",
  ]) {
    if (!tr37.includes(needle)) fail("transcripts.js 缺：" + needle)
  }
  if (tr37.includes("if (transcriptIndex) return transcriptIndex")) fail("transcripts.js 的索引还是建完就冻结")
  if (tr37.includes("originCache.set(key, null)")) fail("transcripts.js 还在缓存 null 的 origin")
  if (/for \(const f of files\) \{\s*for \(const v of idx\.values\(\)\)/.test(tr37)) fail("transcriptStats 还是 O(n²)")
  for (const p of ["test/transcripts.test.mjs", "test/transcripts-usage.test.mjs", "dev/probe-transcript-index.mjs", "dev/probe-index-cost.mjs"]) {
    if (!exists(p)) fail("缺 " + p)
  }
  if (exists("test/transcripts.test.mjs") && !read("test/transcripts.test.mjs").includes("新开的会话会在下一轮扫描里出现")) {
    fail("transcripts 单测没有「新会话要看得见」这一条")
  }
  const docs37 = [
    ["CHANGELOG.md", "会话一直在开，索引却停在开机那一刻"],
    ["docs/verified.md", "## 1.11.37（2026-11-15）"],
    ["docs/roadmap.md", "1.11.37 已交付"],
    ["docs/release.md", "## 1.11.37 实测"],
    ["docs/benchmarks.md", "缓存也要有保质期（1.11.37 更新）"],
  ]
  for (const [f, needle] of docs37) if (!read(f).includes(needle)) fail("1.11.37 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.37 构件：会话索引有保质期 / null 不进缓存 / 统计 O(n) / 两支补测 / 文档五处")

  // 1.11.38：外部推送的 uid 按内容哈希（不许随机数），items 非数组要给 0 条
  const ing38 = read("lib/host/adapters/ingest.js")
  if (!ing38.includes("hashShort(String(title) + ")) fail("ingest.js 的 uid 回落不是按内容哈希")
  if (/hashShort\([^)]*Math\.random\(\)/.test(ing38)) fail("ingest.js 的 uid 里还有 Math.random()")
  if (!ing38.includes("if (!Array.isArray(items)) return { written: 0, file: '', error: 'items 必须是数组' }")) {
    fail("ingest.js 没挡住非数组的 items")
  }
  for (const p of ["test/adapters-ingest.test.mjs", "dev/probe-ingest.mjs"]) {
    if (!exists(p)) fail("缺 " + p)
  }
  if (exists("test/adapters-ingest.test.mjs") && !read("test/adapters-ingest.test.mjs").includes("不该长重影")) {
    fail("ingest 单测没有「重复推送不长重影」这一条")
  }
  const docs38 = [
    ["CHANGELOG.md", "推两次，就长成两条"],
    ["docs/verified.md", "## 1.11.38（2026-11-15）"],
    ["docs/roadmap.md", "1.11.38 已交付"],
    ["docs/release.md", "## 1.11.38 实测"],
    ["docs/benchmarks.md", "uid 里不该有随机数（1.11.38 更新）"],
  ]
  for (const [f, needle] of docs38) if (!read(f).includes(needle)) fail("1.11.38 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.38 构件：推送 uid 按内容哈希 / 非数组有护栏 / 十四项补测 / 文档五处")

  // 1.11.39：删掉重复的 readStoreNodes；MCP 嗅探看到下一个条目就停；发现层补测
  const src39 = read("lib/host/sources.js")
  if (src39.includes("export function readStoreNodes")) fail("sources.js 里还留着没人调用的 readStoreNodes")
  if (!src39.includes("const nextId = lines.findIndex(")) fail("sources.js 的 MCP 嗅探还是固定窗口")
  if (!src39.includes("const stop = nextId < 0 ? Math.min(lines.length, i + 24) : nextId")) {
    fail("sources.js 的 MCP 嗅探没在下一个条目处停下")
  }
  const g39 = read("lib/host/graph.js")
  if (g39.includes("来自 sources.readStoreNodes")) fail("graph.js 的注释还指着已删除的 readStoreNodes")
  if (!g39.includes("来自适配器层（lib/host/adapters/*）扫描出的所有节点")) fail("graph.js 的注释没指向适配器层")
  if (!exists("test/sources.test.mjs")) fail("缺 test/sources.test.mjs")
  if (exists("test/sources.test.mjs") && !read("test/sources.test.mjs").includes("普通插件被误列成 MCP")) {
    fail("sources 单测没有 MCP 串条目的回归用例")
  }
  const docs39 = [
    ["CHANGELOG.md", "没人调用的那份，已经和真的那份不一样了"],
    ["docs/verified.md", "## 1.11.39（2026-11-15）"],
    ["docs/roadmap.md", "1.11.39 已交付"],
    ["docs/release.md", "## 1.11.39 实测"],
    ["docs/benchmarks.md", "删掉那份重复实现（1.11.39 更新）"],
  ]
  for (const [f, needle] of docs39) if (!read(f).includes(needle)) fail("1.11.39 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.39 构件：重复实现已删 / MCP 不串条目 / 发现层十四项补测 / 文档五处")

  // 1.11.40：文件数上限截断要说出来（walkFiles stats → notes → scanAll.warnings → overview）
  const util40 = read("lib/host/adapters/util.js")
  if (!util40.includes("opts.stats.truncated = out.length >= maxFiles")) fail("util.js 的 walkFiles 没报 truncated")
  const notes40 = read("lib/host/adapters/notes.js")
  if (!notes40.includes("truncated: Boolean(stats.truncated),")) fail("notes.js 的 detect 没记 truncated")
  if (!notes40.includes("return { nodes, ledgers: [], truncated: Boolean(stats.truncated) }")) fail("notes.js 的 scan 没回传 truncated")
  const idx40 = read("lib/host/adapters/index.js")
  if (!idx40.includes("if (res.truncated) {")) fail("adapters/index.js 没把截断汇成告警")
  if (!idx40.includes("return { nodes, ledgers, errors, warnings }")) fail("scanAllSteps 的返回值没带 warnings")
  const neb40 = read("lib/host/nebula.js")
  if (!neb40.includes("this.storeWarnings = Array.isArray(scanned.warnings)")) fail("nebula.js 没接住 warnings")
  if (!neb40.includes("truncated: Boolean(s.truncated),")) fail("graph.sources 没带 truncated")
  if (!neb40.includes('code: "source-truncated",')) fail("overview 告示里没有 source-truncated")
  const app40 = read("lib/web/app.js")
  if (!app40.includes("if (w.code === 'source-truncated')")) fail("界面没渲染 source-truncated 告示")
  for (const p of ["test/adapters-util.test.mjs", "test/truncation-warning.test.mjs", "dev/probe-notes-cap.mjs", "dev/probe-truncation-warning.mjs"]) {
    if (!exists(p)) fail("缺 " + p)
  }
  if (exists("test/truncation-warning.test.mjs") && !read("test/truncation-warning.test.mjs").includes("source-truncated")) {
    fail("截断单测没有 overview 告示那一条")
  }
  const docs40 = [
    ["CHANGELOG.md", "只读了前四千个，剩下的没进图，也没人说"],
    ["docs/verified.md", "## 1.11.40（2026-11-15）"],
    ["docs/roadmap.md", "1.11.40 已交付"],
    ["docs/release.md", "## 1.11.40 实测"],
    ["docs/benchmarks.md", "被上限截断的来源（1.11.40 更新）"],
  ]
  for (const [f, needle] of docs40) if (!read(f).includes(needle)) fail("1.11.40 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.40 构件：截断一路到界面 / 两个探针 / 十七项补测 / 文档五处")

  // 1.11.41：干净克隆里也要能过——门禁不许依赖 dev/，node 下限要写实
  const self41 = read("scripts/release-check.mjs")
  if (!self41.includes("const isDev = (p) => p === 'dev'")) fail("release-check 没把 dev/ 当本地工作件放行")
  if (!self41.includes("const exists = (p) => (isDev(p) ? true : existsReal(p))")) fail("exists() 没对 dev/ 放行")
  if (!self41.includes("const readDev = (p) =>")) fail("缺 readDev() 这个「有才核对」的读法")
  if (!self41.includes("if (axeSrc && !axeSrc.includes('没有状态断言，不敢审'))")) fail("axe 断言还是硬读 dev 文件")
  const tr41 = read("lib/host/transcripts.js")
  if (tr41.includes("import { zstdDecompressSync } from 'node:zlib'")) fail("transcripts.js 还在具名导入 zstd（老 node 会崩）")
  if (!tr41.includes("typeof zlib.zstdDecompressSync === 'function'")) fail("transcripts.js 没有特性探测 zstd")
  if (!tr41.includes("这个 node 没有 zstd 解码")) fail("transcripts.js 缺 zstd 的人话错误")
  if (exists("test/transcripts.test.mjs") && !read("test/transcripts.test.mjs").includes("const it = hasZstd")) {
    fail("transcripts 测试没有「没有 zstd 就跳过」的开关")
  }
  const pkg41 = JSON.parse(read("package.json"))
  if (!/^>=\s*22\.1[5-9]/.test(pkg41.engines.node)) fail("engines.node 没提到 22.15 以上：" + pkg41.engines.node)
  if (pkg41.scripts.test !== "node --test") fail("npm test 还依赖 glob 写法：" + pkg41.scripts.test)
  const ci41 = read(".github/workflows/ci.yml")
  if (!ci41.includes("'22.15.0'")) fail("CI 矩阵没跟上 22.15")
  if (!ci41.includes("name: Environment")) fail("CI 缺 Environment 步骤（node / zstd / sqlite）")
  if (!exists("dev/sim-clean-clone.mjs")) fail("缺干净克隆模拟探针")
  const docs41 = [
    ["CHANGELOG.md", "CI 红了两版，因为没人看 Actions"],
    ["docs/verified.md", "## 1.11.41（2026-11-15）"],
    ["docs/roadmap.md", "1.11.41 已交付"],
    ["docs/release.md", "## 1.11.41 实测"],
    ["docs/benchmarks.md", "干净的机器才是发布条件（1.11.41 更新）"],
  ]
  for (const [f, needle] of docs41) if (!read(f).includes(needle)) fail("1.11.41 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.41 构件：门禁不依赖 dev/ / zstd 特性探测 / engines 22.15 / CI 环境步骤 / 干净克隆探针 / 文档五处")

  // 1.11.42：打标签就自动建 Release 并挂附件
  const rel42 = read(".github/workflows/release.yml")
  for (const needle of ["tags: ['v*']", 'contents: write', 'npm pack', 'SHA256SUMS.txt', 'gh release create']) {
    if (!rel42.includes(needle)) fail("release.yml 缺「" + needle + "」")
  }
  const docs42 = [
    ["CHANGELOG.md", "从 GitHub 装不上"],
    ["docs/verified.md", "## 1.11.42（2026-11-15）"],
    ["docs/release.md", "## 1.11.42 实测"],
  ]
  for (const [f, needle] of docs42) if (!read(f).includes(needle)) fail("1.11.42 文档缺 " + f + " 的「" + needle + "」")
  ok("` + MARK + ` / 标签触发 / contents: write / tgz + SHA256SUMS / 文档三处")

}
for (const n of notes) console.log(`  ✔ ${n}`)
if (problems.length === 0) {
  console.log('\n全部通过。\n')
  process.exit(0)
}
console.log('')
for (const p of problems) console.log(`  ✖ ${p}`)
console.log(`\n${problems.length} 个问题。\n`)
process.exit(1)
