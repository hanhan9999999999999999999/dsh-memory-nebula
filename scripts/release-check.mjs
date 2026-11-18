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

// NEBULA_NO_DEV=1 时，读 dev/ 的文件直接给空串：干净克隆里它本来就不在，读会抛 ENOENT（1.11.50）
const read = (p) => (DEV_HIDDEN && (p === 'dev' || p.startsWith('dev/') || p.startsWith('../dev/')) ? '' : readFileSync(join(ROOT, p), 'utf8'))
const existsReal = (p) => (DEV_HIDDEN && isDev(p) ? false : existsSync(join(ROOT, p)))
// dev/ 是本地工作件：.gitignore 整目录忽略，干净克隆（CI、别人的机器）里没有。
// 证据脚本只在本机核对，缺失记一条备注，不当发布门禁（1.11.41 修：否则 CI 永远红）。
const isDev = (p) => p === 'dev' || p.startsWith('dev/') || p.startsWith('../dev/')
// NEBULA_NO_DEV=1：把 dev/ 当成不存在，本地就能复现 CI 的视野（1.11.49）
const DEV_HIDDEN = process.env.NEBULA_NO_DEV === '1'
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
//    dev/ 里是探查脚本，经常在字符串里引用别的文件（比如给探针生成的补丁脚本），
//    它们不进包，也不参与运行时，所以不在这里核对。
for (const f of codeFiles.filter((p) => !String(rel(p)).startsWith('dev/'))) {
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
if (!ciSrc.includes("'24'")) fail('CI 矩阵缺 Node 24（22 的 node:sqlite 是实验实现，会把测试进程打崩）')
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
// 1.11.63 起 hops 先过解析器（写错报 400），所以这里认「透传 hops」的两种写法
if (
  !read('lib/host/http.js').includes("src.exportReport({ format, scope, hops })") &&
  !read('lib/host/http.js').includes("src.exportReport({ format, scope, hops: hopsArg.value })")
) {
  fail('/export 未透传 scope/hops')
}
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
  // 1.11.46 起 cards 也跟着「体检要不要算」走：cached 且没算过时也不许顺手算。
  if (
    !read('lib/host/nebula.js').includes("cards: opts.hygiene === false ? null : this.cards()") &&
    !read('lib/host/nebula.js').includes("cards: cachedOnly ? (cachedHygiene ? this.cards() : null)")
  )
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
  if (!neb.includes('#applyCurated(kind, aId, bId, note)') && !neb.includes('#applyCurated(kind, aId, bId, note, opts = {})')) fail('nebula.js 没有 #applyCurated')
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
  if (!/const VERSION = [2-9]/.test(gc)) fail('缓存格式没升过（旧缓存要能被认出来）')
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
  if (!ing38.includes('if (!Array.isArray(items))') || !ing38.includes("error: 'items 必须是数组'")) {
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
  if (!/^>=\s*(22\.1[5-9]|2[3-9]|\d\d)/.test(pkg41.engines.node)) fail("engines.node 没提到可用版本：" + pkg41.engines.node)
  if (pkg41.scripts.test !== "node --test") fail("npm test 还依赖 glob 写法：" + pkg41.scripts.test)
  const ci41 = read(".github/workflows/ci.yml")
  if (!ci41.includes("'24'")) fail("CI 矩阵没跟上 Node 24")
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
  for (const needle of ["tags: ['v*']", 'contents: write', 'npm pack', 'SHA256SUMS.txt', 'gh release create', "node-version: '24'"]) {
    if (!rel42.includes(needle)) fail("release.yml 缺「" + needle + "」")
  }
  const docs42 = [
    ["CHANGELOG.md", "从 GitHub 装不上"],
    ["docs/verified.md", "## 1.11.42（2026-11-15）"],
    ["docs/release.md", "## 1.11.42 实测"],
  ]
  for (const [f, needle] of docs42) if (!read(f).includes(needle)) fail("1.11.42 文档缺 " + f + " 的「" + needle + "」")
  ok("` + MARK + ` / 标签触发 / contents: write / tgz + SHA256SUMS / 文档三处")

  // 1.11.44：CI 的 verify 作业必须同时跑 Windows（用户几乎都在 Windows）
  const ci44 = read(".github/workflows/ci.yml")
  if (!ci44.includes("os: [ubuntu-latest, windows-latest]")) fail("CI 没同时跑 ubuntu 与 windows")
  if (!ci44.includes("runs-on: ${{ matrix.os }}")) fail("CI 的 runs-on 没接矩阵的系统")
  if (!ci44.includes("name: Node ${{ matrix.node }} on ${{ matrix.os }}")) fail("CI 作业名没带系统")
  if (!ci44.includes("shell: bash")) fail("CI 没统一用 bash（跨系统一致）")
  const docs44 = [
    ["CHANGELOG.md", "用户全在 Windows，CI 只在 Linux 上跑"],
    ["docs/verified.md", "## 1.11.44（2026-11-15）"],
    ["docs/release.md", "## 1.11.44 实测"],
  ]
  for (const [f, needle] of docs44) if (!read(f).includes(needle)) fail("1.11.44 文档缺 " + f + " 的「" + needle + "」")
  ok("` + MARK + ` / ubuntu + windows / 作业名带系统 / 统一 bash / 文档三处")

  // 1.11.45：CLI 入口补契约测试，hops 解析不再静默回落
  if (!exists("test/cli.test.mjs")) fail("缺 test/cli.test.mjs（CLI 入口的契约测试）")
  if (exists("test/cli.test.mjs")) {
    const cliSrc = read("test/cli.test.mjs")
    for (const needle of ["--version", "已被占用", "请求头或 URL 太长", "--token 之后不带口令读不到数据", "日志写不进去"]) {
      if (!cliSrc.includes(needle)) fail("cli 单测缺 " + needle)
    }
  }
  if (!exists("test/share-hops.test.mjs")) fail("缺 test/share-hops.test.mjs")
  const hopsSrc = exists("test/share-hops.test.mjs") ? read("test/share-hops.test.mjs") : ""
  if (hopsSrc && !hopsSrc.includes("hops 需要 1–5 的整数")) fail("hops 单测没断言 400 的消息")
  const shareSrc = read("lib/host/share.js")
  if (!shareSrc.includes("if (!/^\\d+$/.test(text) || !Number.isFinite(n) || n < 1 || n > MAX_HOPS)")) {
    fail("parseShareHops 还在静默回落")
  }
  if (shareSrc.includes("if (!Number.isFinite(n)) return 2")) fail("parseShareHops 的旧实现还在")
  const standaloneSrc = read("lib/standalone.mjs")
  if (!standaloneSrc.includes("hops = parseShareHops(arg('hops', '2'))")) fail("CLI 的 --hops 没复用 parseShareHops")
  if (standaloneSrc.includes("Number(arg('hops', '2')) || 2")) fail("CLI 的 --hops 还在静默回落")
  const docs45 = [
    ["CHANGELOG.md", "用户最先碰到的那个文件"],
    ["docs/verified.md", "## 1.11.45（2026-11-15）"],
    ["docs/roadmap.md", "1.11.45 已交付"],
    ["docs/release.md", "## 1.11.45 实测"],
    ["docs/benchmarks.md", "用户敲的第一条命令"],
  ]
  for (const [f, needle] of docs45) if (!read(f).includes(needle)) fail("1.11.45 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.45 构件：CLI 契约测试 17 项 / hops 拼错即 400 / 五处文档")

  // 1.11.46 构件：概览不等体检
  const neb46 = read("lib/host/nebula.js")
  if (!neb46.includes("const cachedOnly = opts.hygiene === 'cached'")) fail("overview 没有 cachedOnly 这一档")
  if (!neb46.includes("hygienePending: cachedOnly && !cachedHygiene")) fail("overview 没标 hygienePending")
  const http46 = read("lib/host/http.js")
  if (!http46.includes("const wantHygiene = url.searchParams.get('hygiene') === '1'")) fail("/overview 没有 ?hygiene=1 这一档")
  if (!http46.includes("route === '/hygiene'")) fail("没有 GET /hygiene")
  if (!http46.includes("'hygiene',")) fail("CAPABILITIES 里没有 hygiene")
  const api46 = read("lib/web/api.js")
  if (!api46.includes("get('/hygiene')")) fail("界面没有 hygienic 取数路径")
  const app46 = read("lib/web/app.js")
  if (!app46.includes("function hydrateHygiene(ov)")) fail("界面没有 hydrateHygiene")
  if (!app46.includes("hydrateHygiene(ov)")) fail("hydrateHygiene 没被调用")
  if (!app46.includes("if (ov.hygienePending && !ov.hygiene)")) fail("看板会把空清单当干净（缺 hygienePending 分支）")
  if (!exists("test/overview-hygiene-lazy.test.mjs")) fail("缺 test/overview-hygiene-lazy.test.mjs")
  if (exists("test/overview-hygiene-lazy.test.mjs")) {
    const t46 = read("test/overview-hygiene-lazy.test.mjs")
    if (!t46.includes("hygienePending")) fail("懒体检单测没断言 hygienePending")
    if (!t46.includes("hygiene: 'cached'")) fail("懒体检单测没走 cached 这一档")
  }
  if (!exists("../dev/verify-hygiene-lazy.mjs")) fail("缺 ../dev/verify-hygiene-lazy.mjs")
  const docs46 = [
    ["CHANGELOG.md", "打开一个面板，不该先等体检"],
    ["docs/verified.md", "## 1.11.46（2026-11-15）"],
    ["docs/roadmap.md", "1.11.46 已交付"],
    ["docs/release.md", "## 1.11.46 实测"],
    ["docs/benchmarks.md", "打开面板别等体检（1.11.46 更新）"],
    ["docs/http-api.md", "GET /hygiene"],
  ]
  for (const [f, needle] of docs46) if (!read(f).includes(needle)) fail("1.11.46 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.46 构件：概览不等体检 / 体检单独一条路 / 空清单不冒充干净 / 六处文档")

  // 1.11.47 构件：缓存 v8 与 buildMs/cacheAgeMs 分家
  const gc47 = read("lib/host/graphcache.js")
  if (!gc47.includes("import { deserialize, serialize } from 'node:v8'")) fail('graphcache 没接 node:v8')
  if (!gc47.includes('const VERSION = 4')) fail('缓存格式没升到 4')
  if (!gc47.includes('const LEGACY_VERSION = 3')) fail('缺老格式的版本号（老缓存要能读）')
  if (!gc47.includes('export function parseCacheBytes(raw)')) fail('缺 parseCacheBytes（按内容认格式）')
  if (!gc47.includes("obj.enc === 'v8'")) fail('parseCacheBytes 没按 enc 认 v8')
  if (!gc47.includes('JSON.parse(raw.toString(\'utf8\'))')) fail('parseCacheBytes 没留 JSON 回退')
  if (!gc47.includes('legacyJson ? LEGACY_VERSION : VERSION')) fail('读盘校验没分新旧版本')
  if (!gc47.includes('serialize(payload)')) fail('写盘没走 v8.serialize')
  const neb47 = read("lib/host/nebula.js")
  if (!neb47.includes("enc: saved.enc || 'json'")) fail('lastCache 没记下这次用的编码')
  if (!neb47.includes('this.lastBuildMs = 0') || !neb47.includes('this.cacheAgeMs = hit.builtAt')) {
    fail('读盘恢复还是把年纪当成了建图耗时')
  }
  if (!neb47.includes('cacheAgeMs: this.cacheAgeMs || 0,')) fail('overview 没把 cacheAgeMs 给出去')
  const http47 = read("lib/host/http.js")
  if (!http47.includes('cacheAgeMs: src.cacheAgeMs || 0,')) fail('/ping 没把 cacheAgeMs 给出去')
  if (!exists("test/cache-v8.test.mjs")) fail('缺 test/cache-v8.test.mjs')
  if (exists("test/cache-v8.test.mjs")) {
    const t47 = read("test/cache-v8.test.mjs")
    if (!t47.includes('v3 的旧 JSON 缓存照旧读得出来')) fail('v8 单测没有「老缓存仍可读」的回归用例')
    if (!t47.includes('读盘命中时 buildMs 应该是 0')) fail('v8 单测没守住 buildMs 与 cacheAgeMs 的分家')
  }
  if (!exists("dev/probe-restore-v8.mjs")) fail('缺 dev/probe-restore-v8.mjs（真机读盘）')
  const docs47 = [
    ["CHANGELOG.md", "四条路量过三条，只有一条值得走"],
    ["docs/verified.md", "## 1.11.47（2026-11-15）"],
    ["docs/roadmap.md", "1.11.47 已交付"],
    ["docs/release.md", "## 1.11.47 实测"],
    ["docs/benchmarks.md", "读盘格式：v8 与 JSON 各量一次（1.11.47 更新）"],
    ["docs/http-api.md", "### `buildMs` 与 `cacheAgeMs`（1.11.47 起）"],
  ]
  for (const [f, needle] of docs47) if (!read(f).includes(needle)) fail('1.11.47 文档缺 ' + f + ' 的「' + needle + '」')
  ok('1.11.47 构件：缓存 v8 与 buildMs/cacheAgeMs 分家')

  // 1.11.48：验收的每一步用自己的 DSH_HOME；体检断言跟上 1.11.46 的新语义
  const va48 = read("scripts/verify-all.mjs")
  if (!va48.includes("const HOME_BASE = process.env.DSH_HOME || join(tmpdir(), 'nebula-verify-' + process.pid)")) fail("verify-all 没给每步单独的家")
  if (!va48.includes("function stepHome(label)")) fail("verify-all 缺 stepHome")
  if (!va48.includes("const home = opts.env && opts.env.DSH_HOME ? opts.env.DSH_HOME : stepHome(label)")) fail("verify-all 的 run() 没按步取家")
  if (!va48.includes("env: { ...process.env, ...(opts.env || {}), DSH_HOME: home }")) fail("verify-all 没把 DSH_HOME 注入子进程")
  const v20 = readDev("../dev/verify-20k.mjs")
  if (v20 && v20.includes("const ovh = await get('/overview?hygiene=1')") === false) fail("大库验收还在假设概览一定带体检")
  if (v20 && !v20.includes("概览说清了体检是否在算")) fail("大库验收缺 hygienePending 那条断言")
  noteDev("dev/probe-step-home.mjs")
  if (!exists("dev/probe-step-home.mjs")) fail("缺 dev/probe-step-home.mjs")
  if (existsReal("dev/probe-step-home.mjs") && !readDev("dev/probe-step-home.mjs").includes("每步一个家")) {
    fail("probe-step-home 没有「每步一个家」的结果行")
  }
  const docs48 = [
    ["CHANGELOG.md", "十二步验收，以前共用一个家"],
    ["docs/verified.md", "## 1.11.48（2026-11-15）"],
    ["docs/roadmap.md", "1.11.48 已交付"],
    ["docs/release.md", "## 1.11.48 实测"],
    ["docs/benchmarks.md", "以前共用一个家（1.11.48 更新）"],
  ]
  for (const [f, needle] of docs48) if (!read(f).includes(needle)) fail("1.11.48 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.48 构件：验收每步一个家 / 体检断言跟新语义 / 文档五处")

  // 1.11.49：CI 看不见 dev/，所以门禁要能被这样跑一遍；存在性断言不许用 existsReal
  const self49 = read("scripts/release-check.mjs")
  if (!self49.includes("const DEV_HIDDEN = process.env.NEBULA_NO_DEV === '1'")) fail("门禁缺 NEBULA_NO_DEV 开关")
  if (!self49.includes("const existsReal = (p) => (DEV_HIDDEN && isDev(p) ? false : existsSync(join(ROOT, p)))")) {
    fail("existsReal 没跟着 NEBULA_NO_DEV 一起装看不见")
  }
  if (!self49.includes("const exists = (p) => (isDev(p) ? true : existsReal(p))")) fail("exists() 没对 dev/ 放行")
  if (/(^|[^.\w])!existsReal\(\s*["'](?:\.\.\/)?dev\//.test(self49.replace("const existsReal = (p) => (DEV_HIDDEN && isDev(p) ? false : existsSync(join(ROOT, p)))", ""))) {
    fail("还有地方拿 existsReal 判断 dev/ 在不在（干净克隆里必红）")
  }
  const sim49 = readDev("dev/sim-clean-clone.mjs")
  if (sim49 && !sim49.includes("NEBULA_NO_DEV")) fail("sim-clean-clone 没有「看不见 dev/」那一趟")
  if (/(?:^|[^.\w])read\(\s*["'](?:\.\.\/)?dev\//.test(self49)) fail("还有地方直接 read dev/（干净克隆里会 ENOENT，要用 readDev）")
  const docs49 = [
    ["CHANGELOG.md", "本机看不见的那一半"],
    ["docs/verified.md", "## 1.11.49（2026-11-15）"],
    ["docs/roadmap.md", "1.11.49 已交付"],
    ["docs/release.md", "## 1.11.49 实测"],
    ["docs/benchmarks.md", "看不见 dev/ 的门禁（1.11.49 更新）"],
  ]
  for (const [f, needle] of docs49) if (!read(f).includes(needle)) fail("1.11.49 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.49 构件：门禁能在看不见 dev/ 的视野下跑 / 存在性断言不碰 existsReal / 文档五处")

  // 1.11.50：read 一个本机才有的路径，在干净克隆里是异常而不是 false
  const self50 = read("scripts/release-check.mjs")
  if (!self50.includes("const read = (p) => (DEV_HIDDEN && (p === 'dev'")) fail("read() 没认 NEBULA_NO_DEV")
  if (/(?:^|[^.\w])read\(\s*["'](?:\.\.\/)?dev\//.test(self50)) fail("还有地方直接 read dev/（干净克隆里会 ENOENT）")
  if (!self50.includes("const sim49 = readDev(")) fail("sim-clean-clone 那条断言没改成「在才核对」")
  const docs50 = [
    ["CHANGELOG.md", "读不到」和「是空的」不是一回事"],
    ["docs/verified.md", "## 1.11.50（2026-11-15）"],
    ["docs/roadmap.md", "1.11.50 已交付"],
    ["docs/release.md", "## 1.11.50 实测"],
    ["docs/benchmarks.md", "读不到的路径（1.11.50 更新）"],
  ]
  for (const [f, needle] of docs50) if (!read(f).includes(needle)) fail("1.11.50 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.50 构件：读不到的路径跳过而不是崩 / 门禁禁止直读 dev/ / 三种视野 / 文档五处")

  // 1.11.51：sidecar.ps1 的端口边界与版本提示
  const sc = read("sidecar.ps1")
  if (!sc.includes("[regex]::Escape([string]$Port)")) fail("sidecar.ps1 的端口匹配没有按边界比对")
  if (sc.includes('-like "*--port $Port*"')) fail("sidecar.ps1 还在用子串匹配端口（会杀错进程）")
  if (!sc.includes("$script:RequiredNode")) fail("sidecar.ps1 的版本提示没有读 engines")
  if (sc.includes("Node 22.13+")) fail("sidecar.ps1 的提示还写死 22.13+")
  if (!exists("test/sidecar-script.test.mjs")) fail("缺 test/sidecar-script.test.mjs")
  if (exists("test/sidecar-script.test.mjs")) {
    const st = read("test/sidecar-script.test.mjs")
    if (!st.includes("停前缀端口不许动长端口上的那个实例")) fail("sidecar 单测没有「停前缀端口不许杀掉别的实例」这一条")
        if (st.includes("const PORT = 63411")) fail("sidecar 单测还写死 63411（固定端口是抽奖）")
    if (!st.includes("0xef, 0xbb, 0xbf")) fail("sidecar 单测没有 BOM 断言")
    if (!st.includes("engines.node")) fail("sidecar 单测没有核对 engines 的值")
  }
  const docs51 = [
    ["CHANGELOG.md", "停 6341，别把 63411 一起停了"],
    ["docs/verified.md", "## 1.11.51（2026-11-15）"],
    ["docs/roadmap.md", "1.11.51 已交付"],
    ["docs/release.md", "## 1.11.51 实测"],
    ["docs/benchmarks.md", "脚本也要有测试（1.11.51 更新）"],
  ]
  for (const [f, needle] of docs51) if (!read(f).includes(needle)) fail("1.11.51 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.51 构件：端口按边界比对 / 版本提示读 engines / 脚本带 BOM / 六项契约测试 / 文档五处")

  // 1.11.52：inject.json 逐项校验
  if (!exists("lib/host/injectcfg.js")) fail("缺 lib/host/injectcfg.js")
  if (exists("lib/host/injectcfg.js")) {
    const ic = read("lib/host/injectcfg.js")
    if (!ic.includes("export const INJECT_LIMITS")) fail("injectcfg 里没有范围表")
    if (!ic.includes("export const INJECT_DEFAULTS")) fail("injectcfg 里没有默认值")
    if (!ic.includes("export function normalizeInjectConfig")) fail("injectcfg 没有 normalizeInjectConfig")
    if (!ic.includes("export function readInjectConfig")) fail("injectcfg 没有 readInjectConfig")
    if (!ic.includes("超出 ")) fail("超范围时没有说明")
    if (!ic.includes("不认识的键")) fail("拼错的键没有被指出")
  }
  const idx52 = read("lib/index.js")
  if (!idx52.includes("readInjectConfig(nebulaHome())")) fail("index.js 没走带校验的读取")
  if (!idx52.includes("inject.json：")) fail("写错配置时没有写日志")
  if (/value = \{ \.\.\.INJECT_DEFAULTS, \.\.\.raw \}/.test(idx52)) fail("index.js 还在原样合并 inject.json")
  if (!exists("test/injectcfg.test.mjs")) fail("缺 test/injectcfg.test.mjs")
  if (exists("test/injectcfg.test.mjs")) {
    const it52 = read("test/injectcfg.test.mjs")
    if (!it52.includes("拼错的")) fail("injectcfg 单测没有拼错键的用例")
    if (!it52.includes("不抱怨")) fail("injectcfg 单测没有「没配置不抱怨」的用例")
  }
  const docs52 = [
    ["CHANGELOG.md", "写错一个键，注入就悄悄关了"],
    ["docs/verified.md", "## 1.11.52（2026-11-15）"],
    ["docs/roadmap.md", "1.11.52 已交付"],
    ["docs/release.md", "## 1.11.52 实测"],
    ["docs/benchmarks.md", "手改的配置文件也是输入（1.11.52 更新）"],
  ]
  for (const [f, needle] of docs52) if (!read(f).includes(needle)) fail("1.11.52 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.52 构件：注入配置有范围校验 / 写错留痕 / 十项测试 / 文档五处")

  // 1.11.53：工具层那一半，第一次有人问它话
  if (!exists("test/tools.test.mjs")) fail("缺 test/tools.test.mjs")
  if (exists("test/tools.test.mjs")) {
    const t53 = read("test/tools.test.mjs")
    if (!t53.includes("九个工具都注册上了")) fail("工具层单测没覆盖九个工具注册")
    if (!t53.includes("nebula_link 没做成：")) fail("工具层单测没覆盖 link 的失败话术")
    if (!t53.includes("waitReady")) fail("工具层单测没等图建好就开始问")
  }
  const idx53 = read("lib/index.js")
  if (!idx53.includes("nebula_link 没做成：")) fail("nebula_link 失败时还是把异常丢给宿主")
  if (!idx53.includes("} catch (err) {")) fail("nebula_link 外面没有 try/catch")
  const docs53 = [
    ["CHANGELOG.md", "工具层没人管的那一半"],
    ["docs/verified.md", "## 1.11.53（2026-11-16）"],
    ["docs/roadmap.md", "1.11.53 已交付"],
    ["docs/release.md", "## 1.11.53 实测"],
    ["docs/benchmarks.md", "那一层没人问过它话（1.11.53 更新）"],
  ]
  for (const [f, needle] of docs53) if (!read(f).includes(needle)) fail("1.11.53 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.53 构件：工具层失败也要说话")

  // 1.11.54：Node 下界只有一个来源（engines）；sources.json 坏了要出声；不许有像测试的野脚本
  const doc54 = read("lib/host/doctor.js")
  if (!doc54.includes("function readEnginesFloor()")) fail("doctor 没有从 engines 读下界")
  if (!doc54.includes("export const MIN_NODE = readEnginesFloor() || '24.0.0'")) fail("MIN_NODE 没有接 engines")
  if (/MIN_NODE = '22\./.test(doc54)) fail("doctor 的下界还写死在 22.x")
  const rel54 = read("docs/release.md")
  if (!rel54.includes("`>=24.0.0`")) fail("docs/release.md 的 Node 下界没改成 24")
  const tro54 = read("docs/troubleshooting.md")
  if (!tro54.includes("`>=24.0.0`")) fail("docs/troubleshooting.md 的 Node 下界没改成 24")
  const con54 = read("CONTRIBUTING.md")
  if (!con54.includes("Node.js 24")) fail("CONTRIBUTING.md 还写着旧下界")
  const com54 = read("docs/compatibility.md")
  if (!com54.includes("Node < 24")) fail("docs/compatibility.md 还写着旧下界")
  const neb54 = read("lib/host/nebula.js")
  if (!neb54.includes("code: 'config-unreadable'")) fail("配置读不出来时没有告示")
  if (!neb54.includes("this.configError = found.config && found.config.error")) fail("nebula 没留住配置错误")
  const app54 = read("lib/web/app.js")
  if (!app54.includes("w.code === 'config-unreadable'")) fail("界面没渲染 config-unreadable")
  const ad54 = read("lib/host/adapters/index.js")
  if (!ad54.includes("Number(store.maxFiles) || Number(res.maxFiles)")) fail("截断上限没有回落到 res.maxFiles")
  if (!exists("test/adapters-index.test.mjs")) fail("缺 test/adapters-index.test.mjs")
  if (exists("test/adapters-index.test.mjs") && !read("test/adapters-index.test.mjs").includes("config-unreadable")) {
    fail("发现层单测没有覆盖 config-unreadable 告示")
  }
  const docT54 = read("test/doctor.test.mjs")
  if (!docT54.includes("MIN_NODE 必须等于 engines")) fail("doctor 单测还是把下界写死")
  // node --test 裸跑会执行 test/ 之外形如测试的文件；这种野脚本会让 CI 行为莫名其妙
  const wildTest = []
  const walk54 = (dir, depth) => {
    if (depth > 3) return
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      if (n === 'node_modules' || n === '.git' || n === 'test' || n === 'tmp') continue
      const full = join(dir, n)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk54(full, depth + 1)
        continue
      }
      if (/\.test\.mjs$/.test(n) || /-test\.mjs$/.test(n) || /^test-.+\.mjs$/.test(n)) wildTest.push(n)
    }
  }
  walk54(ROOT, 0)
  if (wildTest.length) fail("test/ 之外有像测试的文件（node --test 会当测试执行）：" + wildTest.join(", "))
  const docs54 = [
    ["CHANGELOG.md", "装不上时，第一个告诉你原因的工具说错了版本"],
    ["docs/verified.md", "## 1.11.54（2026-11-16）"],
    ["docs/roadmap.md", "1.11.54 已交付"],
    ["docs/release.md", "## 1.11.54 实测"],
    ["docs/benchmarks.md", "同一个数字写在五个地方（1.11.54 更新）"],
  ]
  for (const [f, needle] of docs54) if (!read(f).includes(needle)) fail("1.11.54 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.54 构件：Node 下界只读 engines / 四处文档跟着 24 / 配置坏有告示 / 发现层补测 / 无野测试脚本 / 文档五处")

  // 1.11.55：星图自己的小库（nebula.db）坏了要自愈，并且要说出来
  const store55 = read("lib/host/store.js")
  if (!store55.includes("function tryOpen(file)")) fail("openStore 没有拆出 tryOpen")
  if (!store55.includes("export function storeRecovery()")) fail("没有 storeRecovery()，坏库修好了没人知道")
  if (!store55.includes("function moveAside(file)")) fail("坏文件没有被挪开的路径")
  if (!store55.includes("db = tryOpen(':memory:')")) fail("连重建都失败时没有内存库兜底")
  if (!store55.includes("recovery = null\n}") && !store55.includes("recovery = null")) fail("closeStore 没有清掉 recovery")
  const neb55 = read("lib/host/nebula.js")
  if (!neb55.includes("code: 'store-recovered'")) fail("概览没有 store-recovered 告示")
  if (!neb55.includes("storeRecovery")) fail("nebula 没有读 storeRecovery()")
  const app55 = read("lib/web/app.js")
  if (!app55.includes("w.code === 'store-recovered'")) fail("界面没渲染 store-recovered")
  const i18n55 = read("lib/web/i18n.js")
  if (!i18n55.includes("星图自己的小库重建了：")) fail("i18n 缺「星图自己的小库重建了：」")
  if (!exists("test/store-recovery.test.mjs")) fail("缺 test/store-recovery.test.mjs")
  if (existsReal("test/store-recovery.test.mjs")) {
    const st55 = read("test/store-recovery.test.mjs")
    if (!st55.includes("坏库不该挡住建图")) fail("小库自愈单测没有「坏库不该挡住建图」这一项")
    if (!st55.includes("store-recovered")) fail("小库自愈单测没断言概览告示")
  }
  const docs55 = [
    ["CHANGELOG.md", "星图自己的小库坏了，整张图跟着起不来"],
    ["docs/verified.md", "自愈路径（"],
    ["docs/roadmap.md", "1.11.55「星图自己的小库坏了，整张图跟着起不来」"],
    ["docs/release.md", "1.11.55 实测"],
    ["docs/benchmarks.md", "自己的旁路库（1.11.55 更新）"],
    ["docs/troubleshooting.md", "星图自己的小库坏了（nebula.db）"],
  ]
  for (const [f, needle] of docs55) if (!read(f).includes(needle)) fail("1.11.55 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.55 构件：坏库挪开重建 / 内存兜底 / 概览告示 / 界面一行 / 单测 6 项 / 文档六处")

  // 1.11.56：截断不许把 emoji 劈成半个（半个字符写进 UTF-8 就是方块问号）
  const text56 = read("lib/host/text.js")
  if (!text56.includes("export function cut(text, max = 160)")) fail("text.js 没有 cut()")
  if (!text56.includes("if (last >= 0xd800 && last <= 0xdbff) end -= 1")) fail("cut 没有退开代理对（高代理在末尾要吃少一个）")
  if (!text56.includes("cp === 0x200d || cp === 0xfe0f")) fail("cut 没有处理 ZWJ / 变体选择符")
  if (!text56.includes("cp >= 0x1f3fb && cp <= 0x1f3ff")) fail("cut 没有处理肤色修饰符")
  if (!text56.includes("return cut(s, Math.max(0, width - 1)) + '…'")) fail("clip 没有走 cut()")
  if (text56.includes("return s.slice(0, Math.max(0, max - 1)) + '…'")) fail("clip 还在裸 slice，会把 emoji 劈开")
  const meow56 = read("lib/host/adapters/meow.js")
  if (meow56.includes("function clipText(text, max)")) fail("meow 适配器还留着自己那份截断实现")
  if (!meow56.includes("clip(") || meow56.includes("function clipText")) fail("meow 适配器没有并回 text.js 的 clip")
  const graph56 = read("lib/host/graph.js")
  if (!graph56.includes("const desc = cut(String((item && item.description) || ''), 200)")) fail("来源描述还在裸 slice")
  const index56 = read("lib/index.js")
  if (!index56.includes("cut(it.label || '', 50)")) fail("体检清单标签还在裸 slice（50）")
  if (!index56.includes("cut(it.a.label || '', 40)")) fail("重复项标签还在裸 slice（40）")
  if (!exists("test/text-cut.test.mjs")) fail("缺 test/text-cut.test.mjs")
  if (existsReal("test/text-cut.test.mjs")) {
    const t56 = read("test/text-cut.test.mjs")
    if (!t56.includes("代理对")) fail("截断单测没有代理对用例")
    if (!t56.includes("ZWJ")) fail("截断单测没有 ZWJ 连字用例")
    if (!t56.includes("替换符")) fail("截断单测没有断言 UTF-8 里不许出现替换符")
    if (!t56.includes("detail.preview")) fail("截断单测没有整条链路（ingest → 建图 → detail.preview）")
  }
  const docs56 = [
    ["CHANGELOG.md", "截断的时候，别把字劈成两半"],
    ["docs/verified.md", "截断不劈字"],
    ["docs/roadmap.md", "1.11.56「截断的时候，别把字劈成两半」"],
    ["docs/release.md", "1.11.56 实测"],
    ["docs/benchmarks.md", "截断也得按字来（1.11.56 更新）"],
  ]
  for (const [f, needle] of docs56) if (!read(f).includes(needle)) fail("1.11.56 文档缺 " + f + " 的「" + needle + "」")
  ok("1.11.56 构件：cut() 不劈代理对 / 零件整颗退 / clip 走 cut / meow 并回主链路 / 单测 9 项 / 文档五处")

  // 1.11.56 构件：验收脚本不许自己崩、不许报假警报
  {
    const smokeSrc = read('scripts/smoke.mjs')
    if (!smokeSrc.includes('const die = (err) =>')) fail('smoke.mjs：未捕获错误要先讲清楚再退出（缺 die）')
    if (!smokeSrc.includes("process.on('uncaughtException', die)")) fail('smoke.mjs：缺 uncaughtException 兜底')
    if (!smokeSrc.includes("process.on('unhandledRejection', die)")) fail('smoke.mjs：缺 unhandledRejection 兜底')
    if (!smokeSrc.includes('const empty = opts.allowEmpty === true')) fail('smoke.mjs：checkGraph 不认空库（缺 allowEmpty）')
    if (!smokeSrc.includes('const isEmpty = (rawGraph.nodes || []).length === 0')) fail('smoke.mjs：没有先判空就往下取节点')
    const nebSrc = read('lib/host/nebula.js')
    if (!nebSrc.includes('async sourcesReport() {')) fail('nebula.js：sourcesReport 必须是 async（要 await 异步扫）')
    if (!nebSrc.includes('await scanAllAsync(this.stores || [])')) fail('nebula.js：来源体检没走 scanAllAsync')
    if (nebSrc.includes(': scanAll(this.stores || [])')) fail('nebula.js：还在调不存在的同步 scanAll')
    if (!read('lib/host/http.js').includes('await src.sourcesReport()')) fail('http.js：/sources 没有 await sourcesReport')
    if (!read('lib/index.js').includes('await nebula.sourcesReport()')) fail('index.js：nebula_sources 工具没有 await sourcesReport')
    if (!read('CHANGELOG.md').includes('顺带修的两处')) fail('CHANGELOG 1.11.56 缺「顺带修的两处」')
    if (!read('docs/verified.md').includes('空库上跑')) fail('verified 1.11.56 缺空库那一行')
    if (!read('docs/release.md').includes('scanAll is not defined')) fail('release 1.11.56 缺 /sources live 的实测')
    noteDev('dev/probe-smoke-empty.mjs')
    if (existsReal('dev/probe-smoke-empty.mjs') && !readDev('dev/probe-smoke-empty.mjs').includes('空库上 smoke 干净退出')) fail('dev/probe-smoke-empty.mjs 缺「空库上 smoke 干净退出」')
  }

  // 1.11.57：测试不能把「本机有多快」写进断言
  const kit57 = read("testkit/wait.mjs")
  if (!kit57.includes("export async function waitFor(label, check")) fail("testkit/wait.mjs 没有 waitFor()")
  if (!kit57.includes("msg") && !kit57.includes("等不到")) fail("waitFor 超时的时候没有说清等的是什么")
  if (!kit57.includes("export function freePort()")) fail("testkit/wait.mjs 没有 freePort()")
  if (!kit57.includes("export async function freePortPair()")) fail("testkit/wait.mjs 没有 freePortPair()")
  const warm57 = read("test/hygiene-warm.test.mjs")
  if (!warm57.includes("testkit/wait.mjs")) fail("hygiene-warm 没有用 testkit 的等待工具")
  if (warm57.includes("await sleep(600)")) fail("hygiene-warm 还在用固定的 600 毫秒")
  if (!warm57.includes("词频表与体检都预热完")) fail("hygiene-warm 没有等「预热完」这个条件")
  const pre57 = read("test/prewarm.test.mjs")
  if (!pre57.includes("testkit/wait.mjs")) fail("prewarm 没有用 testkit 的等待工具")
  if (pre57.includes("await sleep(260)")) fail("prewarm 还在用固定的 260 毫秒")
  if (!pre57.includes("词频表预热完成")) fail("prewarm 没有等「预热完成」这个条件")
  const side57 = read("test/sidecar-script.test.mjs")
  if (side57.includes("const PORT = 63411")) fail("sidecar 测试还写死 63411（固定端口是抽奖）")
  if (!side57.includes("freePortPair()")) fail("sidecar 测试没有现取一对前缀端口")
  const ci57 = read(".github/workflows/ci.yml")
  if (!ci57.includes("tee unit-tests.log")) fail("CI 的 Unit tests 没有留 log（失败时看不到是谁）")
  if (!ci57.includes("Report failing tests")) fail("CI 没有「把失败用例说出来」这一步")
  if (!ci57.includes("::error::")) fail("CI 没有把失败的用例写成注解")
  const docs57 = [
    ["CHANGELOG.md", "测试里那些固定的等待和固定的端口"],
    ["docs/verified.md", "测试等的是条件，不是毫秒"],
    ["docs/roadmap.md", "1.11.57「测试里那些固定的等待和固定的端口」"],
    ["docs/release.md", "1.11.57 实测"],
    ["docs/benchmarks.md", "别人机器上的那 600 毫秒（1.11.57 更新）"],
  ]
  for (const [f, needle] of docs57) if (!read(f).includes(needle)) fail("1.11.57 文档缺 " + f + " 的「" + needle + "」")
  noteDev("dev/probe-flaky-wait.mjs")
  if (existsReal("dev/probe-flaky-wait.mjs") && !readDev("dev/probe-flaky-wait.mjs").includes("忙起来")) fail("dev/probe-flaky-wait.mjs 没有把机器压满的那一段")
  ok("1.11.57 构件：测试等条件 / 端口现取 / CI 自己报失败用例 / 文档五处")

  // 1.11.58：共激活的门槛与权重，必须按会话数算，且不许冒充实体级硬关系
  const graph58 = read("lib/host/graph.js")
  if (!graph58.includes("rec.n += 1")) fail("graph.js 的共激活没有按会话数累加（rec.n += 1）")
  if (!graph58.includes("if (rec.n < 2) continue")) fail("graph.js 的共激活门槛不是「≥2 次会话」")
  if (graph58.includes("if (co < " + "1.6)")) fail("graph.js 还在用 co < 1.6 那道与注释相反的门")
  if (!graph58.includes("const coRec = coAct.get(coKey(a, b))")) fail("graph.js 没有按 { n, d } 读共激活记录")
  if (!graph58.includes("0.44,")) fail("共激活权重没有封顶 0.44（不该越过 STRONG_W 0.45）")
  if (!graph58.includes("次会话里一起被点亮")) fail("共激活的理由文案没写清「在几次会话里」")
  if (graph58.includes("同会话共激活")) fail("graph.js 还在用「同会话共激活 N 次」那句旧文案（那说的是加权和）")
  const meow58 = read("lib/host/adapters/meow.js")
  if (!meow58.includes("export const LEDGER_KINDS")) fail("meow.js 没有 LEDGER_KINDS（账本只认活动键）")
  if (!meow58.includes("if (!LEDGER_KINDS.has(kind)) continue")) fail("meow.js 的账本没有按 LEDGER_KINDS 过滤")
  const hb58 = read("test/hebbian.test.mjs")
  if (!hb58.includes("2 次会话")) fail("test/hebbian.test.mjs 没有「2 次会话就够」的断言")
  if (!hb58.includes("projectsQueried")) fail("test/hebbian.test.mjs 没有 projectsQueried 不算点亮的断言")
  if (!hb58.includes("不归零")) fail("test/hebbian.test.mjs 没有「大会话权重低但不归零」的断言")
  const docs58 = [
    ["CHANGELOG.md", "共激活的门槛，两头互相否掉"],
    ["docs/verified.md", "共激活在两次会话后成立"],
    ["docs/roadmap.md", "1.11.58「共激活的门槛，两头互相否掉」"],
    ["docs/release.md", "1.11.58 实测"],
    ["docs/benchmarks.md", "共激活的门槛（1.11.58 更新）"],
  ]
  for (const [f, needle] of docs58) if (!read(f).includes(needle)) fail("1.11.58 文档缺 " + f + " 的「" + needle + "」")
  if (existsReal("dev/probe-hebbian-real.mjs") && !readDev("dev/probe-hebbian-real.mjs").includes("共激活")) fail("dev/probe-hebbian-real.mjs 没有在真实库上数共激活边")
  ok("1.11.58 构件：共激活按会话数算 / 权重封顶 0.44 / 账本只认活动键 / 文档五处")

  // 1.11.59：屏蔽记录不许被「建图那一刻的快照」盖过去
  const neb59 = read("lib/host/nebula.js")
  if (!neb59.includes("const muted = this.demo ? [] : listMutes()")) fail("读盘恢复没有再读一次屏蔽记录")
  if (!neb59.includes("droppedByMute")) fail("读盘恢复没有统计「按屏蔽摘掉了几条边」")
  if (!neb59.includes("this.graph.muteCount = muted.length")) fail("读盘恢复没有把 muteCount 对齐到库里的记录")
  if (!neb59.includes("if (this.graph.stats) this.graph.stats.edges = this.graph.edges.length")) fail("摘边之后 stats.edges 没有跟着改（会留一个旧数字）")
  if (!neb59.includes("按屏蔽记录摘边失败")) fail("屏蔽表读不出来时没有兜住（不该让整张图起不来）")
  const muteBody = neb59.slice(neb59.indexOf("  mute(a, b, note = '')"))
  if (!muteBody.slice(0, 600).includes("this.graph.muteCount = this.mutes().length")) fail("mute() 没有立刻更新 muteCount")
  const unmuteBody = neb59.slice(neb59.indexOf("  unmute(a, b)"))
  if (!unmuteBody.slice(0, 600).includes("this.graph.muteCount = this.mutes().length")) fail("unmute() 没有立刻更新 muteCount")
  const mr59 = read("test/mute-restore.test.mjs")
  if (!mr59.includes("重启读盘之后也不许回来")) fail("test/mute-restore.test.mjs 没有「重启之后不许回来」这条")
  if (!mr59.includes("需要重算")) fail("test/mute-restore.test.mjs 没有「撤销屏蔽要说清需要重算」这条")
  if (!mr59.includes("stats.edges")) fail("test/mute-restore.test.mjs 没有核对 stats.edges")
  const docs59 = [
    ["CHANGELOG.md", "屏蔽过的边，重启之后又长回来了"],
    ["docs/verified.md", "屏蔽后重启：那条边不再出现"],
    ["docs/roadmap.md", "1.11.59「屏蔽过的边，重启之后又长回来了」"],
    ["docs/release.md", "1.11.59 实测"],
    ["docs/benchmarks.md", "读盘恢复的代价（1.11.59 更新）"],
  ]
  for (const [f, needle] of docs59) if (!read(f).includes(needle)) fail("1.11.59 文档缺 " + f + " 的「" + needle + "」")
  if (existsReal("dev/probe-mute-restore.mjs") && !readDev("dev/probe-mute-restore.mjs").includes("屏蔽被重启吃掉")) fail("dev/probe-mute-restore.mjs 没有在数「屏蔽被重启吃掉」")
  ok("1.11.59 构件：读盘恢复按屏蔽记录摘边 / 计数跟着改动 / 文档五处")

  // 1.11.60：人工连线要看得见，取消连线不许把系统那条关系一起拿走
  const neb60 = read("lib/host/nebula.js")
  if (!neb60.includes("#applyCurated(kind, aId, bId, note, opts = {})")) fail("applyCurated 没有接住「这是取消连线还是屏蔽」")
  if (!neb60.includes("this._curatedAuto = this._curatedAuto || new Map()")) fail("没有记住「被人工顶掉的那条系统边」")
  if (!neb60.includes("this._curatedAuto.set(s + '|' + t, prev)")) fail("撞上已有边时没有把原来那份存起来")
  if (!neb60.includes("...keepWhy")) fail("升级成人工边时把原有证据丢了")
  if (!neb60.includes("if (opts.keepAuto)")) fail("drop 分支没有区分「取消连线」与「屏蔽」")
  if (!neb60.includes("g.edges[at] = auto")) fail("取消连线没有把系统原本那条边放回去")
  const unlinkBody = neb60.slice(neb60.indexOf("  unlink(a, b) {")).slice(0, 900)
  if (!unlinkBody.includes("keepAuto: true")) fail("unlink() 没有走「保留系统边」那条路")
  if (!unlinkBody.includes("listMutes()")) fail("unlink() 没有先看这一对是否被屏蔽（屏蔽优先）")
  const cl60 = read("test/curated-link.test.mjs")
  if (!cl60.includes("边升级成人工")) fail("test/curated-link.test.mjs 没有「升级成人工」这条")
  if (!cl60.includes("取消人工连线不该把系统那条一起摘掉")) fail("test/curated-link.test.mjs 没有「取消连线不许摘掉系统边」这条")
  if (!cl60.includes("屏蔽着的对，取消连线也不该把边放回来")) fail("test/curated-link.test.mjs 没有「屏蔽优先」这条")
  const docs60 = [
    ["CHANGELOG.md", "我取消的是自己那根线"],
    ["docs/verified.md", "取消连线：系统原本那条关系回来"],
    ["docs/roadmap.md", "1.11.60「我取消的是自己那根线」"],
    ["docs/release.md", "1.11.60 实测"],
    ["docs/benchmarks.md", "取消连线比重建便宜（1.11.60 更新）"],
  ]
  for (const [f, needle] of docs60) if (!read(f).includes(needle)) fail("1.11.60 文档缺 " + f + " 的「" + needle + "」")
  if (existsReal("dev/probe-unlink-auto.mjs") && !readDev("dev/probe-unlink-auto.mjs").includes("取消的是自己那根线")) fail("dev/probe-unlink-auto.mjs 没有在问「取消的是不是只有自己那根线」")
  ok("1.11.60 构件：人工连线看得见 / 取消连线保留系统边 / 文档五处")


// 1.11.61 构件：WAL 也要算进签名
{
  const neb61 = read("lib/host/nebula.js")
  if (!neb61.includes("const wal = statSync(store.dbPath + '-wal')")) fail("nebula 没在看 -wal")
  if (!neb61.includes("if (wal.size > 0) parts.push(")) fail("空的 -wal 不能算变化（否则读完必变）")
  if (!neb61.includes("WAL 模式是持久设置在库里")) fail("缺空 -wal 的说明注释")

  const walTest = "test/wal-signature.test.mjs"
  if (!existsReal(walTest)) fail("缺 " + walTest)
  const wt = read(walTest)
  if (!wt.includes("第二条记忆")) fail("WAL 测试没有真的写第二条记忆")
  if (!wt.includes("签名不该抖动")) fail("WAL 测试没有验「空的 -wal 不该算变化」")

  noteDev("dev/probe-wal-stale.mjs")
  if (existsReal("../dev/probe-wal-stale.mjs") && !readDev("../dev/probe-wal-stale.mjs").includes("结论")) {
    fail("探针没有给结论行")
  }

  for (const [p, needle] of [
    ["CHANGELOG.md", "新写的记忆，星图说「没有变化」"],
    ["docs/verified.md", "改后签名"],
    ["docs/roadmap.md", "1.11.61「新写的记忆"],
    ["docs/release.md", "1.11.61 实测"],
    ["docs/benchmarks.md", "文件没变，不等于数据没变"],
  ]) {
    if (!read(p).includes(needle)) fail("文档缺内容：" + p)
  }
}

// 1.11.62：一次性命令、缓存与盘上的团
if (true) {
  const neb = read("lib/host/nebula.js")
  if (!neb.includes("async flushCache(timeoutMs = 20000) {")) fail("nebula 没有 flushCache")
  if (!neb.includes("Promise.race([pending.catch(() => null), guard])")) fail("flushCache 没有等写盘那一半")
  if (!neb.includes("const allClusters = Array.isArray(g.clusters) ? g.clusters : []")) fail("导出报告没有兜住缺失的 clusters")
  if (!neb.includes("if (!Array.isArray(this.graph.clusters)) this.graph.clusters = []")) fail("读盘恢复没有补 clusters")

  const cache = read("lib/host/graphcache.js")
  if (!cache.includes("clusters: (graph.clusters || []).map((c) => ({")) fail("缓存里没存 clusters，恢复出来的图会少一团")

  const cli = read("lib/standalone.mjs")
  const readyCount = (cli.match(/const ready = ok \|\| \(probe\.graph && probe\.graph\.nodes\.length > 0\)/g) || []).length
  if (readyCount < 3) fail("三处一次性命令都要判「图里有内容」，现在只有 " + readyCount + " 处")
  if (!cli.includes("if (ready) await probe.flushCache()")) fail("一次性命令没等缓存落盘")
  if (!cli.includes("await nebula.flushCache(1200)")) fail("退出时没等缓存落盘")
  if (!cli.includes("process.exit(ready ? 0 : 1)")) fail("--diagnose 还是把「命中缓存」当成失败")
  if (cli.includes("process.exit(ok ? 0 : 1)")) fail("--diagnose 仍在用 ok 判退出码（命中缓存时会 exit 1）")

  const cf = "test/cache-flush.test.mjs"
  if (!existsReal(cf)) fail("缺 " + cf)
  const cft = read(cf)
  if (!cft.includes("flushCache 会把缓存真的写到盘上")) fail("缓存测试没有验 flushCache 真的落盘")
  if (!cft.includes("连跑两次 --export")) fail("缓存测试没有验「一次性命令跑第二次」")
  if (!cft.includes("旧缓存里没有 clusters")) fail("缓存测试没有验老缓存缺字段")

  for (const [p, needle] of [
    ["CHANGELOG.md", "一次性命令跑第二次，就说「建图失败」"],
    ["docs/verified.md", "同一 home 连跑三次 --export"],
    ["docs/roadmap.md", "1.11.62「一次性命令跑第二次"],
    ["docs/release.md", "1.11.62 实测"],
    ["docs/benchmarks.md", "一次性命令也要能重用缓存"],
  ]) {
    if (!read(p).includes(needle)) fail("文档缺内容：" + p)
  }
}

  // 1.11.63 构件：参数拼错要报错
  {
    const http63 = read('lib/host/http.js')
    const need63 = [
      ['readIntArg 存在', http63.includes('export function readIntArg(')],
      ['readNumArg 存在', http63.includes('export function readNumArg(')],
      ['整数字面量校验', http63.includes("if (!/^\\d+$/.test(text)) return bad")],
      ['小数字面量校验', http63.includes("if (!/^\\d+(\\.\\d+)?$/.test(text)) return bad")],
      ['越界也报错', http63.includes('value < spec.min || value > spec.max')],
      ['recall 用 readIntArg', http63.includes("readIntArg(url.searchParams, 'limit', { min: 1, max: 50, fallback: 12 })")],
      ['recall hops 允许 0', http63.includes("readIntArg(url.searchParams, 'hops', { min: 0, max: 3, fallback: 2 })")],
      ['path hops 用 readIntArg', http63.includes("readIntArg(url.searchParams, hopName, { min: 1, max: 8, fallback: 6 })") || http63.includes("readIntArg(url.searchParams, 'hops', { min: 1, max: 8, fallback: 6 })")],
      ['bridge min_weight 允许 0', http63.includes("readNumArg(url.searchParams, 'min_weight', { min: 0, max: 1, fallback: 0.45 })")],
      ['export hops 用 readIntArg', http63.includes("readIntArg(url.searchParams, 'hops', { min: 0, max: 5, fallback: 2 })")],
      ['recall 不再用 Number||默认值', !http63.includes("Math.min(50, Number(url.searchParams.get('limit')) || 12)")],
      ['export 不再用 Number||2', !http63.includes("Number(url.searchParams.get('hops')) || 2")],
      ['bridge 不再用 num() 兜底', !http63.includes("num('limit', 6)")],
    ]
    for (const [label, passed] of need63) {
      if (passed) ok('1.11.63 ' + label)
      else fail('1.11.63 ' + label)
    }

    const t63 = read('test/param-args.test.mjs')
    if (!t63) {
      fail('缺 test/param-args.test.mjs（参数契约没有测试）')
    } else {
      for (const [label, passed] of [
        ['测试覆盖 readIntArg', t63.includes('readIntArg')],
        ['测试覆盖 readNumArg', t63.includes('readNumArg')],
        ['测试钉住 0 有效', t63.includes('0 是合法值，不许被吞成默认值')],
        ['测试钉住 recall 的 400', t63.includes('hops 需要 0–3 的整数')],
        ['测试钉住 hops=0 不扩散', t63.includes('不许有任何扩散分')],
        ['测试钉住 min_weight=0', t63.includes('min_weight=0 是「不过滤」')],
      ]) {
        if (passed) ok('1.11.63 ' + label)
        else fail('1.11.63 ' + label)
      }
    }

    const changelog63 = read('CHANGELOG.md')
    if (!changelog63.includes('写错一个参数，服务照着默认值跑得很欢')) fail('CHANGELOG 缺 1.11.63 的说明')
    else ok('1.11.63 CHANGELOG 有说明')
    const ver63 = read('docs/verified.md')
    if (!ver63.includes('## 1.11.63（')) fail('verified 缺 1.11.63 实测')
    else ok('1.11.63 verified 有实测')
    const rel63 = read('docs/release.md')
    if (!rel63.includes('## 1.11.63 实测')) fail('release 缺 1.11.63 实测')
    else ok('1.11.63 release 有实测')
    const road63 = read('docs/roadmap.md')
    if (!road63.includes('## 1.11.63「')) fail('roadmap 缺 1.11.63')
    else ok('1.11.63 roadmap 有记录')
    const bench63 = read('docs/benchmarks.md')
    if (!bench63.includes('参数拼错时，服务该说什么')) fail('benchmarks 缺 1.11.63 段')
    else ok('1.11.63 benchmarks 有对照')
  }

  // 1.11.64 构件：自己配对与 maxHops
  {
    const neb64 = read('lib/host/nebula.js')
    const http64 = read('lib/host/http.js')
    const need64 = [
      ['selfPair 帮助函数存在', neb64.includes('function selfPair(id)')],
      ['自己配对带 400', neb64.includes('err.status = 400') && neb64.includes('不能把一条记忆和它自己配成一对：')],
      ['link 拦自己连自己', neb64.includes('if (n[0].id === n[1].id) throw selfPair(n[0].id)')],
      ['/path 优先认 maxHops', http64.includes("rawMaxHops !== '' ? 'maxHops' : 'hops'")],
      ['/path 按选中的名字解析', http64.includes('readIntArg(url.searchParams, hopName, { min: 1, max: 8, fallback: 6 })')],
      ['/path 不再写死 hops', !http64.includes("readIntArg(url.searchParams, 'hops', { min: 1, max: 8")],
    ]
    for (const [label, passed] of need64) {
      if (passed) ok('1.11.64 ' + label)
      else fail('1.11.64 ' + label)
    }
    let selfLinkGuards = 0
    for (const line of neb64.split('\n')) if (line.includes('throw selfPair(n[0].id)')) selfLinkGuards += 1
    if (selfLinkGuards >= 2) ok('1.11.64 link 与 mute 都拦自己配对')
    else fail('1.11.64 link 与 mute 都拦自己配对（只找到 ' + selfLinkGuards + ' 处）')

    const t64 = read('test/self-pair.test.mjs')
    if (!t64) {
      fail('缺 test/self-pair.test.mjs（自己配对与 maxHops 没有测试）')
    } else {
      for (const [label, passed] of [
        ['测试钉住自己配对', t64.includes('不能把一条记忆和它自己配成一对')],
        ['测试钉住 maxHops', t64.includes('maxHops')],
        ['测试钉住老名字 hops', t64.includes('hops=abc')],
        ['测试断言跳数真的变了', t64.includes('hops, 3')],
      ]) {
        if (passed) ok('1.11.64 ' + label)
        else fail('1.11.64 ' + label)
      }
    }

    const api64 = read('docs/http-api.md')
    if (!api64.includes('1.11.64 之前这里只认')) fail('http-api 缺 maxHops 的那条说明')
    else ok('1.11.64 http-api 写清了 maxHops')
    const changelog64 = read('CHANGELOG.md')
    if (!changelog64.includes('照文档写的参数，代码从来没读过')) fail('CHANGELOG 缺 1.11.64 的说明')
    else ok('1.11.64 CHANGELOG 有说明')
    const ver64 = read('docs/verified.md')
    if (!ver64.includes('## 1.11.64（')) fail('verified 缺 1.11.64 实测')
    else ok('1.11.64 verified 有实测')
    const rel64 = read('docs/release.md')
    if (!rel64.includes('## 1.11.64 实测')) fail('release 缺 1.11.64 实测')
    else ok('1.11.64 release 有实测')
    const road64 = read('docs/roadmap.md')
    if (!road64.includes('## 1.11.64「')) fail('roadmap 缺 1.11.64')
    else ok('1.11.64 roadmap 有记录')
    const bench64 = read('docs/benchmarks.md')
    if (!bench64.includes('（1.11.64 更新）')) fail('benchmarks 缺 1.11.64 段')
    else ok('1.11.64 benchmarks 有对照')

    noteDev('dev/probe-http-edges.mjs')
    if (existsReal('dev/probe-http-edges.mjs') && !readDev('dev/probe-http-edges.mjs').includes('自己连自己')) {
      fail('dev/probe-http-edges.mjs 缺自己连自己的那段')
    }
  }

}

  // 1.11.65：边的统计只有一个来源（屏蔽/撤销屏蔽/读盘之后 byType 不许停在建图那一刻）
  {
    const neb65 = read('lib/host/nebula.js')
    const need65 = [
      ['#syncEdgeStats() 存在', neb65.includes('#syncEdgeStats()')],
      ['重算 byType', neb65.includes('g.stats.byType = byType')],
      ['对齐 stats.edges', neb65.includes('if (this.graph.stats) this.graph.stats.edges = this.graph.edges.length')],
      ['重算 avgDegree', neb65.includes('g.stats.avgDegree = Math.round((g.edges.length * 2 * 100)')],
      ['没有浅拷贝改 stats', !neb65.includes('g.stats = { ...g.stats, edges: d')],
    ]
    for (const [label, passed] of need65) {
      if (passed) ok('1.11.65 ' + label)
      else fail('1.11.65 ' + label)
    }
    const syncCalls = (neb65.match(/#syncEdgeStats\(\)/g) || []).length
    if (syncCalls >= 4) ok('1.11.65 #syncEdgeStats 调用点 ' + syncCalls + ' 处')
    else fail('1.11.65 #syncEdgeStats 调用点太少（' + syncCalls + ' 处）')

    const ss65 = read('test/stats-sync.test.mjs')
    if (!ss65) {
      fail('缺 test/stats-sync.test.mjs（边的统计没有测试）')
    } else {
      for (const [label, passed] of [
        ['断言 byType 合计等于边数', ss65.includes('byType 合计')],
        ['覆盖撤销屏蔽', ss65.includes('撤销屏蔽后')],
        ['覆盖屏蔽一对没有边的', ss65.includes('屏蔽一对没有边的')],
      ]) {
        if (passed) ok('1.11.65 ' + label)
        else fail('1.11.65 ' + label)
      }
    }

    noteDev('dev/probe-stats-drift.mjs')
    if (existsReal('dev/probe-stats-drift.mjs') && !readDev('dev/probe-stats-drift.mjs').includes('byType 合计')) {
      fail('dev/probe-stats-drift.mjs 缺 byType 合计那段')
    }
    if (!read('CHANGELOG.md').includes('图例上那几个数字，加起来比总数多一条')) fail('CHANGELOG 缺 1.11.65 的主题')
    else ok('1.11.65 CHANGELOG 有说明')
    if (!read('docs/verified.md').includes('## 1.11.65（2026-11-16）')) fail('verified 缺 1.11.65')
    else ok('1.11.65 verified 有实测')
    if (!read('docs/roadmap.md').includes('## 1.11.65「图例上那几个数字')) fail('roadmap 缺 1.11.65')
    else ok('1.11.65 roadmap 有记录')
    if (!read('docs/release.md').includes('## 1.11.65 实测')) fail('release 缺 1.11.65 实测')
    else ok('1.11.65 release 有实测')
    if (!read('docs/benchmarks.md').includes('边缘统计只有一个来源（1.11.65 更新）')) fail('benchmarks 缺 1.11.65 那段')
    else ok('1.11.65 benchmarks 有对照')
  }

  // 1.11.66：探测根目录不写死盘符（隔离 DSH_HOME 之后不许再扫真实硬盘）
  {
    const meow66 = read('lib/host/adapters/meow.js')
    const src66 = read('lib/host/sources.js')
    const need66 = [
      ['认 NEBULA_DEFAULT_ROOTS', meow66.includes("String(process.env.NEBULA_DEFAULT_ROOTS || '')")],
      ['从 DSH_HOME 的兄弟目录推', meow66.includes("join(dshHome(), '..', 'document')")],
      ['从家目录 Documents 推', meow66.includes("join(homedir(), 'Documents')")],
      ['不再写死 D 盘 document', !meow66.includes("'D:\\\\document'")],
      ['不再写死 C 盘 Administrator', !meow66.includes('C:\\\\Users\\\\Administrator')],
      ['候选路径去重', meow66.includes('seen.has(key)')],
      ['sources.js 从 util 转出 dshHome', src66.includes('export { dshHome }') && src66.includes('./adapters/util.js')],
      ['sources.js 不再自己定义 dshHome', !src66.includes('process.env.DSH_HOME ||')],
    ]
    for (const [label, passed] of need66) {
      if (passed) ok('1.11.66 ' + label)
      else fail('1.11.66 ' + label)
    }

    const roots66 = read('test/meow-default-roots.test.mjs')
    if (!roots66) {
      fail('缺 test/meow-default-roots.test.mjs（默认扫描根没有测试）')
    } else {
      for (const [label, passed] of [
        ['钉住 NEBULA_DEFAULT_ROOTS', roots66.includes('NEBULA_DEFAULT_ROOTS')],
        ['钉住 detect 的隔离', roots66.includes('detect({})')],
        ['钉住「不许写死盘符」', roots66.includes('不许出现写死的盘符根目录')],
        ['钉住家目录只有一个定义', roots66.includes('sources.dshHome')],
      ]) {
        if (passed) ok('1.11.66 ' + label)
        else fail('1.11.66 ' + label)
      }
    }

    noteDev('dev/probe-sources-isolation.mjs')
    if (existsReal('dev/probe-sources-isolation.mjs') && !readDev('dev/probe-sources-isolation.mjs').includes('扫到了本机真实工作区吗')) {
      fail('dev/probe-sources-isolation.mjs 缺隔离核对那段')
    }
    if (!read('docs/adapters.md').includes('自动探测扫哪里（1.11.66 起）')) fail('adapters.md 缺「自动探测扫哪里」')
    else ok('1.11.66 adapters.md 有扫描范围说明')
    if (!read('docs/troubleshooting.md').includes('1.11.66 起不再写死盘符')) fail('troubleshooting 缺扫描范围那句')
    else ok('1.11.66 troubleshooting 有排错指引')
    if (!read('CHANGELOG.md').includes('隔离了 DSH_HOME，探针还是翻到了真实硬盘')) fail('CHANGELOG 缺 1.11.66 的主题')
    else ok('1.11.66 CHANGELOG 有说明')
    if (!read('docs/verified.md').includes('## 1.11.66（2026-11-16）')) fail('verified 缺 1.11.66')
    else ok('1.11.66 verified 有实测')
    if (!read('docs/roadmap.md').includes('## 1.11.66「')) fail('roadmap 缺 1.11.66')
    else ok('1.11.66 roadmap 有记录')
    if (!read('docs/release.md').includes('## 1.11.66 实测')) fail('release 缺 1.11.66 实测')
    else ok('1.11.66 release 有实测')
    if (!read('docs/benchmarks.md').includes('默认扫描根目录不写死盘符（1.11.66 更新）')) fail('benchmarks 缺 1.11.66 那段')
    else ok('1.11.66 benchmarks 有对照')

    // 第二段：验证脚本指错目录就会换掉被测对象——这件事必须钉住。
    // 1.11.69 起判定搬进 scripts/probes.mjs（包内 dev/ 与上一层 dev/ 都要找），
    // 所以这里钉的是那套语义，而不是编排脚本里某一行长什么样。
    const va66 = read('scripts/verify-all.mjs')
    const probes69 = exists('scripts/probes.mjs') ? read('scripts/probes.mjs') : ''
    for (const [label, passed] of [
      ['1.11.66 的验证脚本指着包内 dev', va66.includes('const REPO = PKG')],
      ['验证脚本不再指向上一层', !va66.includes("resolve(PKG, '..')")],
      ['缺探针分跳过与失败两种', probes69.includes("state: 'fail'") && probes69.includes("state: 'skip'")],
      ['缺探针时写明仓库里应当有它', probes69.includes('仓库里应当有它')],
    ]) {
      if (passed) ok(label)
      else fail(label)
    }

    noteDev('dev/security-probe.mjs')
    if (existsReal('dev/security-probe.mjs') && !readDev('dev/security-probe.mjs').includes("security-probe · ")) {
      fail('dev/security-probe.mjs 缺汇总那行（security-probe · N / M 通过）')
    }
    noteDev('dev/fuzz-1.8.mjs')
    if (existsReal('dev/fuzz-1.8.mjs') && !readDev('dev/fuzz-1.8.mjs').includes('fail = ')) {
      fail('dev/fuzz-1.8.mjs 缺汇总那行（fail = N / 34）')
    }

    const testing66 = read('docs/testing.md')
    if (!testing66.includes('安全探针（26 项')) fail('testing.md 还写着旧的安全探针项数')
    else ok('1.11.66 testing.md 安全探针 26 项')
    if (!testing66.includes('畸形参数（34 项')) fail('testing.md 缺畸形参数那一节')
    else ok('1.11.66 testing.md 畸形参数 34 项')

    const page66 = read('lib/host/http.js')
    if (!page66.includes("limit 需要 0–50000 的整数")) fail('分页的 limit 报错文案被改坏了（0 在这层是「交给服务端」）')
    else ok('1.11.66 分页仍认 limit=0')
    const pin66 = read('test/param-args.test.mjs')
    if (!pin66.includes('limit=0 与不传等价')) fail('缺一条钉住 limit=0 是约定的测试')
    else ok('1.11.66 有测试钉住 limit=0 的语义')
  }

  // 1.11.67：家目录在 Windows 读 USERPROFILE、在 Linux 读 HOME —— 只改一个等于只测了一台机器。
  {
    const roots67 = read('test/meow-default-roots.test.mjs')
    for (const [label, passed] of [
      ['1.11.67 的沙箱同时钉 HOME', roots67.includes("'HOME', NEBULA_DEFAULT_ROOTS'") || roots67.includes("'HOME'")],
      ['沙箱按原值还原 HOME', roots67.includes('for (const key of KEYS)')],
      ['测试里写明两个变量都要钉', roots67.includes('Linux/macOS')],
    ]) {
      if (passed) ok(label)
      else fail(label)
    }

    if (!read('docs/testing.md').includes('涉及家目录的测试要同时钉两个变量')) fail('testing.md 缺跨平台家目录那一节')
    else ok('1.11.67 testing.md 有跨平台说明')
    if (!read('CHANGELOG.md').includes('本机全绿，ubuntu 上那条测试连跑都没跑成')) fail('CHANGELOG 缺 1.11.67 主题')
    else ok('1.11.67 CHANGELOG 有说明')
    if (!read('docs/verified.md').includes('## 1.11.67（2026-11-16）')) fail('verified 缺 1.11.67')
    else ok('1.11.67 verified 有实测')
    if (!read('docs/roadmap.md').includes('## 1.11.67「')) fail('roadmap 缺 1.11.67')
    else ok('1.11.67 roadmap 有记录')
    if (!read('docs/release.md').includes('## 1.11.67 实测')) fail('release 缺 1.11.67 实测')
    else ok('1.11.67 release 有实测')
    if (!read('docs/benchmarks.md').includes('涉及家目录的测试要钉两个变量（1.11.67 更新）')) fail('benchmarks 缺 1.11.67 那段')
    else ok('1.11.67 benchmarks 有对照')
  }
// 1.11.68 构件：推送里的坏条目要说清，一条没写成要报错
{
  const ing68 = read("lib/host/adapters/ingest.js")
  const neb68 = read("lib/host/nebula.js")
  const http68 = read("lib/host/http.js")
  const idx68 = read("lib/index.js")
  if (!ing68.includes("export function describeSkips")) fail("ingest.js 没有 describeSkips（丢了几条要说清）")
  if (!ing68.includes("if (byUid.has(uid)) duplicates += 1")) fail("ingest.js 批内重复没有计数")
  if (!/written: lines\.length/.test(ing68)) fail("ingest.js 的 written 不是按去重后的条数算的")
  if (!ing68.includes("reasons.notObject += 1") || !ing68.includes("reasons.empty += 1")) {
    fail("ingest.js 没有分别统计「不是对象」与「没有正文」")
  }
  if (!neb68.includes("describeSkips(res.reasons || {})")) fail("nebula.js 的 ingest 没有把原因拼出来")
  if (!neb68.includes("res.written === 0")) fail("nebula.js 的 ingest 没有处理「一条也没写成」")
  if (!http68.includes("if (out.error)")) fail("http.js 的 /ingest 没有把 error 变成 400")
  if (!idx68.includes("if (res.error) return")) fail("nebula_ingest 工具没有报出「没有写成任何一条」")
  if (!exists("test/ingest-skips.test.mjs")) fail("缺 test/ingest-skips.test.mjs")
  const t68 = exists("test/ingest-skips.test.mjs") ? read("test/ingest-skips.test.mjs") : ""
  if (!t68.includes("duplicates") || !t68.includes("skipped")) fail("test/ingest-skips.test.mjs 没钉住跳过与重复")
  for (const [label, needle] of [
    ["CHANGELOG.md", "三条坏数据换来一句"],
    ["docs/verified.md", "## 1.11.68（2026-11-16）"],
    ["docs/roadmap.md", "## 1.11.68"],
    ["docs/release.md", "## 1.11.68 实测"],
    ["docs/benchmarks.md", "推送写入的计数（1.11.68 更新）"],
    ["docs/http-api.md", "1.11.68 起，写不成记忆的条目会如实回报"],
  ]) {
    if (!read(label).includes(needle)) fail(label + " 缺 1.11.68 的说明")
  }
}
// 1.11.69 构件：探针在包内 dev/ 还是上一层 dev/，跑之前要说清用的是哪一份
{
  const pv69 = read('scripts/probes.mjs')
  const va69 = read('scripts/verify-all.mjs')
  if (!pv69.includes('export function probeDirs')) fail('probes.mjs 没有 probeDirs')
  if (!pv69.includes('export function probePlan')) fail('probes.mjs 没有 probePlan')
  if (!pv69.includes('export function pickFixtureRoot')) fail('probes.mjs 没有 pickFixtureRoot')
  if (!pv69.includes("join(repo, 'dev'), join(dirname(repo), 'dev')")) fail('probes.mjs 的候选目录不是「包内 + 上一层」')
  if (!va69.includes("from './probes.mjs'")) fail('verify-all 没接 probes.mjs')
  if (!va69.includes("console.log('探针：'")) fail('verify-all 跑之前没打印用哪份探针')
  if (!va69.includes('pickFixtureRoot(REPO)')) fail('verify-all 的默认测试库没按候选目录探')
  if (!va69.includes('probes: PROBE_DIRS')) fail('verify-all 的 --json 里没写用了哪份探针')
  if (!read('test/verify-all.test.mjs').includes('探针判定')) fail('缺钉住探针判定的单测')
  for (const [label, needle] of [
    ['CHANGELOG.md', '探针在上一层，脚本只看包内'],
    ['docs/verified.md', '## 1.11.69（2026-11-17）'],
    ['docs/roadmap.md', '## 1.11.69「'],
    ['docs/release.md', '## 1.11.69 实测'],
    ['docs/benchmarks.md', '探针与测试库的位置（1.11.69 更新）'],
    ['docs/testing.md', '--dev'],
  ]) {
    if (!read(label).includes(needle)) fail(label + ' 缺 1.11.69 的说明')
  }
}
// 1.11.70 构件：发布正文从 CHANGELOG 取，别让 Release 页面只剩一行 compare 链接
{
  const rn70 = read('scripts/release-notes.mjs')
  const wf70 = read('.github/workflows/release.yml')
  if (!rn70.includes('export function extractSection')) fail('release-notes.mjs 没有 extractSection')
  if (!rn70.includes('export function buildNotes')) fail('release-notes.mjs 没有 buildNotes')
  if (!rn70.includes('export function repoSlug')) fail('release-notes.mjs 没有 repoSlug')
  if (!rn70.includes('CHANGELOG.md 里没有 ')) fail('release-notes.mjs 取不到这一版时没有报错文案')
  if (!wf70.includes('node scripts/release-notes.mjs --version "${GITHUB_REF_NAME#v}"')) {
    fail('release.yml 没按 tag 取这一版的正文')
  }
  if (!wf70.includes('--notes-file notes.md')) fail('release.yml 没把正文交给 gh release create')
  if (wf70.includes('--generate-notes')) fail('release.yml 又退回自动生成的一行 compare 链接了')
  if (!exists('test/release-notes.test.mjs')) fail('缺 test/release-notes.test.mjs')
  const t70 = exists('test/release-notes.test.mjs') ? read('test/release-notes.test.mjs') : ''
  if (!t70.includes('版本号按字面匹配')) fail('test/release-notes.test.mjs 没钉住版本号的边界')
  if (!t70.includes('--notes-file')) fail('test/release-notes.test.mjs 没钉住工作流用的是正文文件')
  for (const [label, needle] of [
    ['CHANGELOG.md', '发布页上只有一行链接'],
    ['docs/verified.md', '## 1.11.70（2026-11-17）'],
    ['docs/roadmap.md', '## 1.11.70「'],
    ['docs/release.md', '## 1.11.70 实测'],
    ['docs/release.md', 'scripts/release-notes.mjs --check'],
    ['docs/benchmarks.md', '发布正文从 CHANGELOG 取（1.11.70 更新）'],
  ]) {
    if (!read(label).includes(needle)) fail(label + ' 缺 1.11.70 的说明')
  }
}
// 1.11.71 构件：文档不许写死整套条数，条数由被测的脚本自己报
{
  const dn71 = exists('test/doc-numbers.test.mjs') ? read('test/doc-numbers.test.mjs') : ''
  if (!dn71) fail('缺 test/doc-numbers.test.mjs')
  if (dn71) {
    if (!dn71.includes('全量')) fail('doc-numbers 门没钉住「全量 N 项」这种写法')
    if (!dn71.includes('unit tests')) fail('doc-numbers 门没钉住英文的「N unit tests」')
    if (!dn71.includes('实测')) fail('doc-numbers 门没给 `## x.y.z 实测` 历史账本留豁免')
  }
  const sm71 = read('scripts/smoke.mjs')
  if (!sm71.includes('passed++')) fail('smoke.mjs 没有统计通过条数')
  if (!sm71.includes('全部通过（${passed} 项）')) fail('smoke.mjs 结尾没打印条数')
  if (read('README.md').includes('126 项单元测试')) fail('README.md 又写死单测总数了')
  if (read('docs/release.md').includes('单元测试（191 项')) fail('release.md 又写死单测总数了')
  if (read('docs/accessibility.md').includes('全量 163 项')) fail('accessibility.md 又写死单测总数了')
  if (!read('docs/testing.md').includes('全部通过（N 项）')) fail('testing.md 没告诉读者条数从哪看')
  if (!read('docs/release.md').includes('把整个文件里的旧版本号一律替换掉')) {
    fail('release.md 没写「bump 不许整文件替换版本号」这条规矩')
  }
  for (const [label, needle] of [
    ['CHANGELOG.md', '文档里的数字，是上一年的'],
    ['docs/verified.md', '## 1.11.71（2026-11-18）'],
    ['docs/roadmap.md', '## 1.11.71「'],
    ['docs/release.md', '## 1.11.71 实测'],
    ['docs/benchmarks.md', '文档里的条数（1.11.71 更新）'],
  ]) {
    if (!read(label).includes(needle)) fail(label + ' 缺 1.11.71 的说明')
  }
}
// 1.11.72 构件：发布手册让你改的那份文档，得真的被管住
{
  const ops72 = read('docs/operations.md')
  if (/版本\s*`\d+\.\d+\.\d+`/.test(ops72)) fail('operations.md 又开始抄死版本号了（版本以 package.json 为准）')
  if (!ops72.includes('以 `package.json` 为准')) fail('operations.md 没写版本从哪来')
  if (!ops72.includes('release-check.mjs` 会逐项比对')) fail('operations.md 没说 files 列表被门对过')
  for (const f of pkg.files || []) {
    const bare = f.replace(/\/$/, '')
    if (!ops72.includes('`' + bare + '`')) fail(`operations.md 的 files 列表少了 ${bare}`)
  }
  if (!read('README.md').includes('当前版本 `' + pkg.version + '`')) {
    fail(`README.md 的「当前版本」没跟上 ${pkg.version}`)
  }
  for (const [label, needle] of [
    ['CHANGELOG.md', '发布手册让你改的那份文档，六版没人改'],
    ['docs/verified.md', '## 1.11.72（2026-11-18）'],
    ['docs/roadmap.md', '## 1.11.72「'],
    ['docs/release.md', '## 1.11.72 实测'],
    ['docs/benchmarks.md', '发布信息那段（1.11.72 更新）'],
  ]) {
    if (!read(label).includes(needle)) fail(label + ' 缺 1.11.72 的说明')
  }
}
// 1.11.73 构件：发布包里不许带没填的占位符
{
  const TEXT = /\.(md|mdx|js|mjs|cjs|json|yml|yaml|css|html|txt|ps1|sh)$/
  // `__NEBULA_*` 是页面/快照读的全局变量名，属于正文的一部分；其余「双下划线 + 大写名 + 双下划线」是写文档时留下的占位符
  const isGlobal = (name) => /^NEBULA_[A-Z0-9_]+$/.test(name)
  const shipped = []
  for (const f of pkg.files || []) {
    const abs = join(ROOT, f)
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) shipped.push(...list(abs))
    else shipped.push(abs)
  }
  const hits = []
  for (const abs of shipped) {
    if (!TEXT.test(abs)) continue
    let src
    try {
      src = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    for (const m of src.matchAll(/__[A-Z][A-Z0-9_]{2,}__/g)) {
      const name = m[0].slice(2, -2)
      if (!isGlobal(name)) hits.push(rel(abs) + ' → ' + m[0])
    }
  }
  if (hits.length) fail('发布包里带着没填的占位符：' + hits.slice(0, 5).join('；') + (hits.length > 5 ? ` 等 ${hits.length} 处` : ''))
  else ok(`发布文件里没有未填的占位符（扫了 ${shipped.length} 个）`)
  for (const [label, needle] of [
    ['CHANGELOG.md', '文档还带着没填的占位符'],
    ['docs/verified.md', '## 1.11.73（2026-11-18）'],
    ['docs/roadmap.md', '## 1.11.73「'],
    ['docs/release.md', '## 1.11.73 实测'],
    ['docs/benchmarks.md', '占位符扫一遍（1.11.73 更新）'],
  ]) {
    if (!read(label).includes(needle)) fail(label + ' 缺 1.11.73 的说明')
  }
}
// 1.11.74 构件：连不上宿主时，冒烟要说人话
{
  const sm74 = read('scripts/smoke.mjs')
  if (!sm74.includes('connectHint')) fail('smoke.mjs 没有连接失败的专用文案')
  if (!sm74.includes('isConnectError')) fail('smoke.mjs 没有把连接失败单独归类')
  if (!sm74.includes('node lib/standalone.mjs --port 7890')) fail('smoke.mjs 没给「起个引擎」那条路')
  if (!sm74.includes('NEBULA_BASE')) fail('smoke.mjs 没提环境变量那条路')
  const basePrints = (sm74.match(/console\.log\('base =', base\)/g) || []).length
  if (basePrints !== 1) fail(`smoke.mjs 里 base 打印了 ${basePrints} 次（应当只有开头那一次）`)
  if (!exists('test/smoke-connect.test.mjs')) fail('缺 test/smoke-connect.test.mjs')
  else {
    const t = read('test/smoke-connect.test.mjs')
    if (!t.includes('smoke 自己出错了')) fail('smoke-connect 测试没钉住「不许把连接失败说成脚本 bug」')
    if (!t.includes('127.0.0.1:9')) fail('smoke-connect 测试没对着一个真连不上的地址跑')
  }
  for (const [label, needle] of [
    ['CHANGELOG.md', '连不上宿主时，它只说了'],
    ['docs/verified.md', '## 1.11.74（2026-11-18）'],
    ['docs/roadmap.md', '## 1.11.74「'],
    ['docs/release.md', '## 1.11.74 实测'],
    ['docs/benchmarks.md', '连不上时怎么说（1.11.74 更新）'],
  ]) {
    if (!read(label).includes(needle)) fail(label + ' 缺 1.11.74 的说明')
  }
}
// 1.11.75 构件：会变的东西不许进系统提示（那会把每轮的前缀缓存废掉）
{
  const idx75 = read('lib/index.js')
  // 系统提示只能是常量：注册项的 text 若写成函数，宿主每轮都会重算出一段新文本
  const reg = idx75.match(/ctx\.systemPrompt\.context\(\{([\s\S]*?)\n\s*\}\)/)
  if (!reg) fail('lib/index.js 里找不到 systemPrompt.context 注册')
  else {
    const body = reg[1]
    if (!/text:\s*RULE\b/.test(body)) fail('系统提示没有注册成常量 RULE（会打字面值以外的动态文本）')
    if (/text:\s*(\(|function|async)/.test(body)) fail('系统提示的 text 又被写成了函数——每轮变一次，前缀缓存全废')
    if (/res\.text|neighbor|neighbors/.test(body)) fail('系统提示里又拼了邻域补充')
  }
  if (idx75.includes("'memory-nebula:neighbors'")) fail('旧的 neighbors 段还注册着')
  if (!idx75.includes('tools/post-execute')) fail('没有把邻域补充改到工具结果的尾巴上')
  if (!idx75.includes('neighborTail')) fail('缺 neighborTail（邻域计算函数）')
  // 节流只认外部读入：injected 是插件自己写的，算进去会自己触发自己
  if (!/const GROWTH_KEYS = \['searched', 'accessed', 'written'\]/.test(idx75)) {
    fail('节流口径不对：增长只能数 searched/accessed/written')
  }
  if (!exists('test/inject-tail.test.mjs')) fail('缺 test/inject-tail.test.mjs')
  else {
    const t = read('test/inject-tail.test.mjs')
    if (!t.includes('这不是上面那个工具的输出')) fail('inject-tail 测试没钉住「补充要说明自己不是该工具的输出」')
    if (!t.includes("typeof promptHandler.text, 'string'")) fail('inject-tail 测试没钉住「系统提示必须是字符串常量」')
    if (!t.includes("'memory-nebula:neighbors'")) fail('inject-tail 测试没钉住「旧的双段注册不许回来」')
  }
  for (const [label, needle] of [
    ['CHANGELOG.md', '每轮都把整个前缀缓存废掉一遍'],
    ['docs/verified.md', '## 1.11.75（2026-11-18）'],
    ['docs/roadmap.md', '## 1.11.75「'],
    ['docs/release.md', '## 1.11.75 实测'],
    ['docs/benchmarks.md', '每轮换 system prompt 的代价（1.11.75 更新）'],
  ]) {
    if (!read(label).includes(needle)) fail(label + ' 缺 1.11.75 的说明')
  }
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
