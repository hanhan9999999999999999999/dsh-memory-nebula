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
const exists = (p) => existsSync(join(ROOT, p))
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
if (!ciSrc.includes("'22.13.0'") || !ciSrc.includes("'24'")) fail('CI 矩阵缺 Node 22.13/24')
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
for (const n of notes) console.log(`  ✔ ${n}`)
if (problems.length === 0) {
  console.log('\n全部通过。\n')
  process.exit(0)
}
console.log('')
for (const p of problems) console.log(`  ✖ ${p}`)
console.log(`\n${problems.length} 个问题。\n`)
process.exit(1)
