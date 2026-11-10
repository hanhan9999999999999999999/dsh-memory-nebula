# 记忆星图 · 验证过的事实

> 下面的数字都是**当时实测**的值，记录的是「这个结论被什么证据支撑过」，不是当前规模——记忆每天在长，规模类数字请以 `node scripts/smoke.mjs` 和界面顶栏为准。

## 1.1.5（2026-11-11）不碰盘

- **CI 抓到的真实并发问题**：1.1.4 的 `Node 24` run 42890664896 与 `Package install` run
  42888730783 上，`/share?demo=1` 偶发 500，响应体 `{"error":"database is locked"}`；
  根因是示例模式 `overview()` 仍调用 `getMeta('lastBuiltAt')`，打开了共享的
  `$DSH_HOME/memory-nebula/nebula.db`，并行测试进程互相抢锁。
- **修复**：示例下 `dbPath=''`、`lastBuiltAt=''`，不读 sqlite；新增示例 overview 断言
  「不带本机路径、不读构建元数据」。
- **回归**：本机连续跑 3 次 `npm test` 均 88/88；GitHub Actions run 42893079925 的
  `Node 22.13.0` / `Node 24` / `Package install` 三个 job 全部 success。
- **打包**：75 文件 / 约 2.3MB（解开约 2.9MB），实际 2,292,696B；sha256 见同目录 `.tgz.sha256`。
- **发布**：npm `latest=1.1.5`，registry shasum `8bff4822ae07af65b1d857263aecfef6085f316f`；
  registry 安装后 `--version`=1.1.5，doctor 对真实 profile 给出「9 通过 / 1 提醒 / 0 失败」。
- **远程索引**：`https://unpkg.com/dsh-memory-nebula@1.1.5/market/index.json` 200；
  `parseMarketIndex` 通过（format 1 / 1.1.5），`marketInstallTarget` 返回 `dsh-memory-nebula@1.1.5`。

## 1.1.4（2026-11-11）对齐

- **医生能说出「装的是新的、跑的是旧的」**：在真实 desktop profile 上，
  `node scripts/doctor.mjs --profile … --base http://127.0.0.1:60156/api/memory-nebula`
  得到 `[warn] version: installed 1.1.3, running host 1.1.0`，提示「重启 DSH 让宿主加载新代码」；
  汇总 `9 通过 / 1 提醒 / 0 失败`。此前同一场景会给出全绿，掩盖升级未生效。
- **真机页面**：headless Edge 打开 `http://127.0.0.1:60156/api/memory-nebula/`，
  页面标题「记忆星图 · Memory Nebula」，顶栏 `1980 记忆 / 9531 连接 / 9 工作区 / 73 会话`，
  `NebulaAPI.meta.version=1.1.0`（宿主未重启）、`mode=host`、无版本横幅、无 JS 异常；
  搜索「记忆」12 命中，点第一条详情正文 1995 字。截图 `dev/shot/live-host.png`（工作区探针，不进包）。
- **CI 安装门**：GitHub Actions run 42879133994 的 `Node 22.13.0` / `Node 24` /
  `Package install` 三个 job 全部 success；`Package install` 会从 `npm pack` 的 tgz 安装、
  比对 `--version`、跑 `doctor --help`，并检查包内带 `SECURITY.md` / `CONTRIBUTING.md`、不带 `dev/`。
- **回归**：88/88 单测；release-check v1.1.4 全绿（含 1.1.4 构件断言：`checkVersionDrift`、
  CI 安装门、doctor 版本漂移用例）。
- **打包**：`npm pack` 75 文件 / 约 2.3MB（解开约 2.9MB），实际 tgz 2,291,737B；
  sha256 见同目录 `.tgz.sha256`（不写进包内，避免重打包后自相矛盾）。
- **发布**：npm `latest=1.1.4`，registry shasum `97efe6cf600febe44270ef131aa28cf26fd65790`；
  registry 安装后 `--version`=1.1.4，doctor 对真实 profile 给出「9 通过 / 1 提醒 / 0 失败」。
- **远程索引**：`https://unpkg.com/dsh-memory-nebula@1.1.4/market/index.json` 200；
  `parseMarketIndex` 通过（format 1 / 1 条 / 1.1.4），`marketInstallTarget` 返回
  `dsh-memory-nebula@1.1.4`。
- **GitHub Release**：`v1.1.4`（id 440830109），附 tgz 与 `.sha256` 两个资产。

## 1.1.3（2026-11-11）门面

- **包元数据**：`package.json` 有 `repository` / `homepage` / `bugs`，描述中英双句，13 个关键词；`npm pack` 后从 tarball 解出的 manifest 同样带这些字段。
- **CI**：`.github/workflows/ci.yml` 矩阵 Node 22.13.0 / 24，跑 `npm test` 与 `npm run check`；首次运行 `aed5605` 在 GitHub 上 **completed / success**，本机等价命令 87/87。
- **政策文件**：`SECURITY.md`（只读边界、loopback/Origin/CSP、`/share` 是正文出口、private advisory）与 `CONTRIBUTING.md`（无依赖、测试命令、文案/测试/版本约定）已进包。
- **回归**：87/87 单测；release-check v1.1.3 全绿（143 文本 / 69 脚本 / 23 Markdown 链接，含 1.1.3 构件断言）。
- **发布**：`npm pack` 75 文件 / 2,289,894B，sha256 `e5aea7789b600ab49c3171dff72ecdd892f435fa61b8bb97ca2f0d1b823a7ce7`；`npm latest` = 1.1.3（registry shasum `23d31ddea801518bbc2ef20ff440b864534a8402`），registry 安装后 `--version` = 1.1.3、doctor 8 通过。
- **远程索引**：`https://unpkg.com/dsh-memory-nebula@1.1.3/market/index.json` 200，`parseMarketIndex` 通过（format 1 / 1.1.3），`marketInstallTarget` 返回 `dsh-memory-nebula@1.1.3`；icon/locale/详情/图片均 200。
- **GitHub Release**：`v1.1.3` 附 tgz 与 `.sha256` 两个资产。
- **README**：中英顶部都有 CI / npm / license badge，文档表补 SECURITY/CONTRIBUTING 两行。

## 1.1.2（2026-11-10）换个门牌

- **CDN 选择**：本机 `curl` 与 Node fetch 访问 jsDelivr 均为 `ECONNRESET`；unpkg 的 Node fetch 200。
- **远程索引**：`https://unpkg.com/dsh-memory-nebula@1.1.2/market/index.json` 经
  `parseMarketIndex` 解析通过，1 个插件、版本 1.1.2；`marketInstallTarget` 返回
  `dsh-memory-nebula@1.1.2`。
- **详情资产**：icon.svg（image/svg+xml）、locale/zh.json、docs/market.zh.md、
  docs/assets/demo.jpg 均 200。
- **本包**：87/87 单测；release-check 1.1.2 全绿；干净安装 `--version` = 1.1.2。
- **发布**：npm `latest` = 1.1.2；registry 安装 `dsh-memory-nebula@1.1.2` 后 doctor 通过。
- **市场端**：DSH 索引配置后可在发现页搜索「记忆星图」并安装；若宿主网络无法访问 unpkg，
  改用本机 `file://` 索引或 npm 直装，不影响包本身。

## 1.1.1（2026-11-10）上架

- **市场索引校验**：`market/index.json` 经 `@deepseek-ai/dsh-plugin-market-index` 的
  `parseMarketIndex` 校验通过；图标相对路径解析为
  `https://cdn.jsdelivr.net/npm/dsh-memory-nebula@1.1.1/market/assets/icon.svg`；
  `marketInstallTarget` 返回 `dsh-memory-nebula@1.1.1`。
- **双语详情**：`locale/zh.json`、`locale/en.json` 指向 `docs/market.zh.md` / `.en.md`；
  5 张详情图都存在于 `docs/assets/`，相对文档路径可解析。
- **单测**：87/87（新增 market 3 项）；包 **72 文件 / 2.3MB / 解开 2.9MB**。
- **索引地址**：`https://cdn.jsdelivr.net/npm/dsh-memory-nebula@1.1.1/market/index.json`。

## 1.1.0（2026-11-10）装得上

- **真实 desktop profile 体检**（`node scripts/doctor.mjs --profile C:\Users\Administrator\.dsh\profiles\desktop`）：
  8 项全过 —— runtime（Node 24.17.0）、package.json（1.1.0）、files（6 个关键文件）、
  profile、dependency（`file:../../plugins/dsh-memory-nebula`）、bundle（在
  `dsh.profile.bundles` 里）、installed（node_modules 1.1.0）、sources（9 个库）。
- **机器可读**：`--json` 输出 `{ok, counts:{ok,warn,fail,skip}, checks[]}`；
  空 profile / 只装依赖未进 bundles / 完全没声明三种情况各有测试覆盖。
- **只读**：不安装、不改 profile、不写记忆库；warn 退出 0，fail 退出 1。
- **单测**：84/84（doctor 8 项）；包 **66 文件 / 2.3MB**；校验和以同目录 `.tgz.sha256` 为准（不写进包内文档，避免重打包失效）。

## 1.0.1（2026-11-10）Node 22 LTS

- **Node v22.13.0**（`npx -y node@22.13.0`）：
  - `node --test "test/*.test.mjs"` → **76/76**，0 fail，1.26s；
  - `node scripts/release-check.mjs` → 全部通过（含 0.5–1.0 构件）；
  - standalone 起在 7898，`scripts/smoke.mjs` → **63/63**（含诊断、hide、快照）；
  - `lib/standalone.mjs --diagnose` → 1,945 记忆 / 9,229 连接 / 9 工作区 / 71 会话，
    建图 547ms，RSS 147MB，退出 0。
- 结论：`engines.node >=22.13.0` 的下界已实测，Node 22 从「预期可用」移到「已验证」。

## 1.0.0（2026-11-10）敢卖

- **`--diagnose`**（真实库 `D:/document/Memory Universe`）：1934 记忆 / 9164 连接 / 9 工作区 /
  71 会话，建图 500ms，9 个来源；输出不含 `path` / `dbPath` / 正文，`lastError:none`，退出码 0。
- **`GET /diagnostics`**（7896 standalone）：`text/plain; charset=utf-8`、`no-store`、
  `nosniff`、`no-referrer`；1935 记忆 / 9170 连接；`?demo=1` 返回 64 条示例并标 `(demo)`；
  响应中 `C:\` 与 `dbPath` 出现 0 次。
- **页面「复制诊断」**（`dev/cdp-diag.mjs`，headless Edge，覆盖剪贴板）：copiedLen 504，
  含 `memory-nebula diagnostics`、`graph`、`standalone`，不含 `C:\`；toast
  「诊断信息已复制（不含正文）」；`window.__nebulaErrors` 为空。
- **回归**：76 单测 / 63 冒烟 / 21 安全探针全过；release-check v1.0.0 全绿
  （132 个文本文件、65 个脚本、19 个 Markdown 相对链接）。

## 0.9.0（2026-11-10）说英文

- **字典**：`lib/web/i18n.js` 425 键；`dev/check-i18n.mjs` 扫描 4 个前端脚本与静态 HTML，
  missing 0；单测新增 7 项（字典非空/回退/语言来源/applyDom/全覆盖）+ 快照内联 i18n 1 项。
- **英文实机**（`dev/cdp-i18n.mjs`，headless Edge 1680×874，`?lang=en`）：
  `title=Memory Nebula`、`html.lang=en`、顶栏 Filters/Project/Boards/Rebuild/Export、
  搜索占位、左栏 Overview/Workspaces、看板 Source/Truth/Health/Muted、详情与快捷键全英文；
  `window.__nebulaErrors` 为空；`i18n.js` 200。
- **英文空态**（`dev/cdp-empty-en.mjs`）：No stars yet + 三条路 + See the demo / Rebuild map。
- **英文示例**（`dev/cdp-demo-en.mjs`）：Demo galaxy · 64 fictional memories · read-only；
  退出按钮 Leave demo；详情/证据链英文 UI、正文保持原文。
- **英文快照**（`dev/cdp-snapshot-en.mjs`，file:// + `?lang=en`）：Offline snapshot ·
  read-only · generated …；搜索/详情/看板本地可用；外部请求 0。
- **窄屏**（`dev/cdp-narrow-en.mjs`，820×900）：`scrollWidth=820`、无横向溢出、
  模式条不压搜索。
- **回归**：73 单测 / 56 冒烟 / 21 安全探针全过；release-check 全绿。

## 0.8.0（2026-11-10）一万条也敢开

- **10k 后端基准**（`node --expose-gc scripts/bench.mjs --nodes 10000 --json`）：
  建图 **1,298ms** / 10,000 节点 / 78,593 边；检索 **4.4ms**；体检 **726ms** / 4,248 项；
  证据链 **5.7ms** / 1 跳；单文件快照 **75ms** / 11.6MB；`heapUsed` **131MB**。
- **10k 首屏**（`dev/cdp-bench.mjs`，headless Edge `--disable-gpu` 1680×874，file://）：
  导航 → 统计条 **652–692ms**（多次运行）；`loadMs` 63–151ms、首次 `draw` 10–18ms；统计条
  「10000记忆78593连接20工作区900会话15.7平均连接」；外部资源请求 0；`window.__nebulaErrors` 为空；
  截图 `dev/shot/bench-10k.png`。0.8 之前同一脚本为 **16,960ms**。
- **回归**：65 单测 / 56 冒烟 / 21 安全探针全过；release-check 全绿。
- **发布包**：59 文件 / 2.1MB（解开 2.7MB），干净安装后 `--version` = 0.8.0。
- **边界**：3D 视图不在 10k 基准内；超过 3,000 条默认 2D。5 万条以上未给预算。

## 0.7.1（2026-11-10）把出口补上

- **搜索空态实机**（`dev/cdp-emptysearch.mjs`，headless Edge）：搜 `zzzz-not-a-word` 后命中卡片出现
  三个按钮「清空搜索 / 只看一个工作区 / 看看示例」；点「看看示例」进入 64 条示例星系，
  `NebulaAPI.demo=true`、顶栏「示例星系 · 64 条虚构记忆…」、`#onboard` 不存在；
  `window.__nebulaErrors` 为空。
- **种子扩散解释**：示例里搜「索引」打开详情，`.seed-note` 为
  「扩散不是搜索：从这条出发，沿已有连接看 2 跳内的邻居。」，按钮 `title` 同义。
- **回归**：65 单测 / 56 冒烟 / 21 安全探针全过；release-check 全绿。
- **发布包**：59 文件 / 2.1MB（解开 2.7MB），干净安装后 `--version` = 0.8.0。

## 0.7.0（2026-11-10）关灯与带路

- **单测 65 项全过**（http 14 / share 13）：hide 白名单与非法格式 400；`ws:日记` 整区剔除
  57 节点 / 7 条被隐去；起点被 hide 时 400、范围被清空时 404；快照里 `C:\Users` 与 `"dbPath"`
  出现次数均为 0；`/share?demo=1&hide=ws:日记` 200、`scope.hidden=7`、`scope.nodes=57`。
- **示例快照脱敏**：`/share?demo=1` 里不再出现「（内置演示数据，不写盘）」以外的本机路径；
  `graph.sources` 与 `overview.sources` 都只保留 `{key,title,size,kind,count}`。
- **首访三步实机**（`dev/cdp-onboard.mjs`，headless Edge 1680×1000，全新 profile）：首屏出现
  「第一次来？三步就够」，`localStorage` 标记为空；第 2 步打开真实记忆详情；第 3 步打开
  证据链「1 跳 · 链强度 0.942 · 2 个步骤」；点「跳过，直接逛」后卡片消失、标记写入 `1`；
  刷新不再出现；按 `?` 打开帮助后点「重看新手三步」可重现；`window.__nebulaErrors` 为空。
- **冒烟 56 项全过**：新增 hide 整区剔除（57/7、无内置路径文案）、空范围 404、非法 hide 400；
  7891 实机 `/share` 2,163,784 字。
- **发布检查**：v0.7.0，59 个文本文件 UTF-8、38 个脚本 `node --check`、16 个 Markdown 相对链接，
  0.5/0.6/0.7 构件检查全绿。
- **发布包**：56 文件 / 2.0MB（解开 2.5MB）；干净目录安装后 `--version` = 0.7.0，
  导出 `apply,inject,name,version`。安装包起 7896 实测
  `/share?scope=ws:DSHLive2D&hide=level:lesson` → 174 节点 / 398 边 / 588,197 字节，
  `scope.hidden=208`、文件名带 `-ws-`，正文里 `C:\Users` 出现 0 次。

## 0.6.0（2026-11-10）切片

- **单测 59 项全过**（share 9 / http 12）：ws、project、focus 三种范围；边重编号后下标自洽；
  范围外正文不进入 HTML；非法 scope 400、未知节点 404；下载文件名带范围后缀。
- **示例范围快照**：`/share?demo=1&scope=ws:xingang` → 200、330,659 字节、文件名 `-ws-`、
  scope `{kind:"ws",nodes:32,edges:31}`、`dy-locker` 不在文件里；`focus:xg-weekly&hops=1` → 12 节点 / 12 边。
- **切片快照离线**：headless Edge 以 `file://` 打开工作区快照，顶部「离线快照 · 工作区 · 星港产品」、
  stats「32 记忆 / 31 连接 / 1 工作区 / 0 会话」、搜索「记忆」1 条命中、详情正文 231 字、
  `performance` 无任何 `http(s)` 资源请求、无 JS 异常。
- **真实库 UI 下载**：搜索「记忆」→ 点第一条 → 导出「选中节点 2 跳」，得到
  `memory-nebula-snapshot-focus-2026-11-10-02-59.html`（461,663 字节），
  scope focus 73 节点 / 193 边，范围外的 `dy-locker` 不在文件里，`window.__nebulaErrors` 为空。
- **冒烟 53 项全过**：新增「范围 share 只导出工作区（32/31、无范围外正文）」与「非法范围 400」。
- **发布检查**：v0.6.0，59 个文本文件 UTF-8、38 个脚本 `node --check`、16 个 Markdown 相对链接，
  0.5/0.6 构件与三档导出菜单齐全；`npm pack` 55 文件 / 1.8MB（解开 2.4MB），
  干净目录安装后 `--version` = 0.6.0，`/share?scope=ws:DSHLive2D` → 375 节点 / 1011 边 / 797KB。
  tarball 的 sha256 见发布目录同名 `.sha256` 文件（文件内容一变，哈希就会变，所以不抄进包内文档）。

- 0.4.0 发布验收（2026-11-09 01:36，独立引擎 7892）：1800 记忆 / 8185 连接 / 9 工作区 / 67 会话；38 项契约、34 项单测、14 项安全探针全过；headless Edge 控制台 0 条异常/警告/CSP 违规；`/app` 带 CSP 与 `x-frame-options` 时页面完整；820×900 窄屏无溢出；sidecar `start` 6.1s 返回（PS 5.1 不再挂起），`stop` 只作用于指定端口；`npm pack --dry-run` 49 文件 / 1.4 MB（解开 1.9 MB）。

- 7 个工作区 / 1016 条记忆 / 30 个来源节点 / 3638 条边 / 40 个会话账本；建图 ~400ms。（来源节点按「最常提到它的项目」归入各工作区，所以工作区数字里含菱形节点。）
- 边类型分布：同一实体 2258 · 共同关键词 1121 · 提到来源 117 · 同项目 88 · 共激活 11 · 语义相似 1。
- 每节点度数上限 16（全局贪心，不会出现度 87 的枢纽）。
- 跨工作区桥：560+ 条，`nebula_recall` 保证结果里至少 2 条来自别的工作区，并标 `across`。
- **通用文件名不再当跨工作区证据**：改规则前有 61 条「跨工作区但只靠 package.json / index.ts / app.html 连起来」的边，改规则后为 0。
- 实体演示：Definitely Unity 的一条「GitHub 直连不通」记忆 → 扩散到 Remote Connect DSH 的「gh-proxy 下载源」记忆（跨工作区，`why` 写明经由哪条 keyword 关联）。
- 真机验证：DSH 桌面版左侧栏「记忆星图」条目可点开，主区渲染完整星云（819 记忆 / 2784 连接 / 6 工作区）。
- 界面：点击选中、搜索（含扩散）、筛选（工作区/层级/边类型/强度/重要度）、详情面板邻居带「为什么连」、悬停提示、时间模式（含自适应刻度）、12s 轮询自动长新星星。
- 三维「星系」：874 节点 / 3022 边一次绘制；CDP 真事件实测 —— 点节点弹详情（标题正确）、中键拖拽只平移不选中（140px 右 + 60px 下 → 目标点位移约 440 世界单位，与 `2*dist*tan(26°)/h` 换算一致）、滚轮 `dist 3161→2370`、三档按钮循环（星云→星系→时间→星云）无报错。
- 记忆体检（2026-11-06 首次上线，1420 条记忆）：共 121 项 —— 疑似重复 1 · 超重 40（本库 p97，最长 988 字）· 没人读过 40 · 孤立 40；`关系是凑的`与`该更新了`当时为 0（连接平均强度都够、也没有「更新更全」的记忆压着旧条目）。诊断耗时 ~170-250ms，只读不改。
- 三档视图帧率（无头 Edge + `--disable-gpu`，即软件 GL 的下限）：星云 60.2fps / 星系 34.8fps / 时间 34.5fps。3D 顶点只在布局或高亮变化时重传，相机转动不重传。
- 配色教训：WebGL 加色混合下，几百个重叠小点会叠成纯白；改用 `gl.POINTS` + `gl_PointCoord` 造「光点」（核心 `exp(-r²*5.5)` + 外晕），既保住层级色彩又不会糊成一团白。
- 中键「诡异」的根因：平移用「按下点到当前的累计位移」做 `+=`，每个 pointermove 都会把整段距离再加一遍 → 位移按事件数平方放大，手一抖画面就飞走。改成用「上一帧位置」算增量后，1:1 跟手。
- 抽样审计脚本 `dev/edge-audit.mjs`（在 `D:\document\Memory Universe\dev\`）：按类型各抽若干条边，把人能读懂的证据（A 摘要 / B 摘要 / why）写成 `dev/edge-audit.md`，逐条可复核。
- 来源节点自检脚本 `dev/source-check.mjs`：打印来源节点数（30）、`mentions` 边数（117）、连接最多的来源（meow-memory ×21）、证据样例，并断言「每条 mentions 边一端必为来源节点、另一端必为记忆」（实测 0 条非法）。
- 来源检索：`nebula_recall("meow-memory")` 的 `seeds` 里出现 `src:mcp:meow-memory`，随后带出 4 条提到过它的记忆。
- 会话转写：141 个 `.zstd`（合计 173MB，最大单个 27.5MB → 解出 81MB / 14489 帧 / 约 600ms）；手写帧头解析解决「只解出第一帧」的问题。
- 时间闸门一致性（2026-11-08，1607 条记忆）：螺旋视图拖到 40% → 标签「≤ 11-03 · 1180 条」、3D `visible {nodes:1180, edges:4113}`；同一次导出 JSON `stats {nodes:1180, edges:4113}`、`filter.until=2026-11-02T20:32:31Z`，最大 `createdAt` 不越界；把标签改成哨兵 `STALE` 再点重建，标签被重算、`buildMs=1993ms` 不再 `undefined`。
- 规模与帧成本基线（2026-11-08 03:45）：1630 记忆 / 6482 连接 / 9 工作区 / 60 会话；`/graph` 0.96MB、解析 9ms、`graphMs` 42–67ms；2D 边路径缓存命中后单帧 1.8–4.2ms，3D 稳定 16.7ms/帧；首屏点亮 1.33s。
- 失败态与原地恢复（2026-11-08）：用 CDP 拦掉 `/graph` 与 `/ping` 后首屏显示「连不上记忆库」+ 重试/复制诊断，无原始报错裸露；解封后点「重试」5 秒内 `#boot` 隐藏、统计回到 1610 记忆 / 6382 连接、`doneMs=1373`，全程未刷新页面。
- 记忆出处实测：`GET /node?id=meow:RemoteConnectDSH:user:0mvv3avfe-…` 返回 `origin.text="先更新手机端的东西吧 然后手机端的语音功能 我手机上点不开朗读…"`，`gapMs=775000`（13 分钟后写下）；详情面板顶部能看到这段引用与出处标注。
- 证据链实测：Definitely Unity 的「GitHub 直连不通」→ 数学网站的「上传要分清两个目的地」，4 跳 / 链强度 0.046，路径 `用户在中国大陆网络环境… →D→ 这台机器 github.com 直连不可达… →>→ 本机往 GitHub 推送的可用路径… →>→ YG 让我把「数境」传上 GitHub… →>→ YG 的「上传」要分清两个目的地…`，每跳都带证据；CDP 真事件（Shift+点）验证面板 `steps:5`、标题「证据链 · 4 跳 · 链强度 0.046」。
- 本地回退实测（宿主未带 `/path` 路由时）：`dev/cdp-path-local.mjs` 用 CDP 真事件做一次 1 跳 Shift+点，标题 `证据链 · 1 跳 · 链强度 0.871（本地计算）`、`steps:2`；再跨项目测一次 6 跳（Definitely Unity → 数学网站），标题 `6 跳 · 链强度 0.007（本地计算）`、`steps:7`、`errors: []`。
- 屏蔽可撤销（2026-11-08）：详情里点邻居行的 ×（自动推断边）→ `GET /mutes` 由 0 变 1、提示条出现「撤销」；点撤销后 `/mutes` 回到 0、提示条改说「已撤销」。修复过程中还证实了一件真事：12 秒一次的 `星云已更新` 会把带按钮的提示条顶掉，所以带动作的提示条现在会把背景提示挡在外面（8 秒）。
- 筛选跨视图一致（2026-11-08，1638–1641 条记忆）：2D 只留 `Liberty Of Code` → 12 条可见；3D（星系）同一筛选修复后同样 12 条、左栏提示「已筛选：隐藏 1626 条记忆（共 6518 条连接）」（修复前 3D 是 0，因为只比 `cluster` 不比 `ws`）。把最低重要度拉满后 2D/3D 都只剩 0 条并出现「这一屏没有记忆」，按 Shift+F 回到 1641 条、提示消失；同一帧里 LOD 光斑、孤儿细线与 3D 簇名都不再残留。
- 3D 导出修复（2026-11-08）：星系视图直接导出 PNG 曾只有标题栏 + 9 个工作区名字（69KB 空图）；加 `paintNow()` 同步补画后导出 493KB、中心点云与连线完整，与屏幕一致；同一轮 2D 导出 954KB 正常。
- 独立引擎 sidecar（2026-11-08）：`node lib/standalone.mjs --port 7891 --root D:/document` 1 秒内 ready，`/ping` 200、`/graph` 1659 节点 / 6646 连接（v2）、`/app` 200（5191 字节）；测完 `taskkill /PID <pid> /T /F`，端口已释放。
- 窄屏抽屉与筛选跨视图（2026-11-08，1659 条记忆）：880×760 下左列隐藏、顶栏「筛选」可见；点开后 22 个 chip 可用，筛掉 Remote Connect DSH 后 3D 可见 1144 条、提示「隐藏 515 条」；按 1 切回星云仍为 1144 条、提示一致；Esc 收回抽屉。
- 主线补全（2026-11-08）：搜索 Rustfare → 详情按 `L`，标题「…·10 条」，行数 10（含当前那条），日期分隔 10月31日 / 11月1日，当前行带 `here` 与「当前」字样。
- 断线提示与恢复（2026-11-08）：CDP 拦掉 `*/memory-nebula/ping*`、`*/memory-nebula/graph*`、`127.0.0.1:7890` 后第 14 秒 `#netbar` 出现「接口断开了 · 正在重试…」；解除拦截后下一次轮询自动隐藏，并提示「连接已恢复」。
- 跨视图改窗口（2026-11-08）：在「星系」下把视口从 1500×950 改到 1100×760，2D canvas 后备缓冲保持 1476×824 不被写坏；切回「星云」后为 1100×760，画面完整（修复前是 1×1 空画布）。
- 记忆消失后的详情（2026-11-08）：把 `/node?id=` 劫持成 404 再点命中，右侧面板收起（`#detail` 无 `show`、body 无 `has-detail`），提示「这条记忆已经不在了」，无异常。
- 快速切档与连点重建（2026-11-08）：1/2/3 交替按 12 次（间隔 120ms）后仍停在正确渲染器，canvas 1476×824、边 6773；连点重建第二次点击被 disabled 挡住（一次「已重建：6773 条连接 · 1169ms」）；揭示动画中途改窗口到 1180×780，canvas 同步、`pump=false`、revealed 1684，无异常。
- 键盘焦点（2026-11-08）：Tab 依次落在顶栏按钮，`:focus-visible` 计算值 `1px rgba(108,224,255,.75)`，截图为可见细光环。
- 轮询换图后的左栏（2026-11-08）：先点掉 2 个工作区 chip（22 个里 19 个亮），再劫持 `/ping` 返回不同 sig 触发一次真实轮询：筛选面板被重建（预埋的 `data-mark` 消失）、19/22 仍亮、提示「星云已更新」、边 6773，无异常。
- 空库提示自动收起（2026-11-08）：手工给 `#hint` 加上 `show` 与 `data-empty=1` 后点一次重建，提示隐藏、属性清空（`show:false / empty:''`）。
- 动画中导出（2026-11-08）：重建后 1.45s（pump 运行中、revealed 0）点导出，得到 1125932B 完整图；导出后 revealed 立刻补到 1684，画面无需等待。
- 对比度与键盘（2026-11-08）：`--text-faint` #6b7f96 对 #0b1019 为 4.63:1（原 3.06）；搜索命中列表高亮第一条，↓ 走第二条、回车打开的就是高亮那条，↑ 在第一条上绕到末条。
- 请求超时（2026-11-08）：对着一个只接受连接、永不回包的本地服务打开页面，6 秒时仍是「正在点亮」，14 秒时出现「连不上记忆库 · 等了 12 秒还没有回包」，重试按钮可用。

## 0.5.0（2026-11-10）第一束光

- **单测 53 项全过**：原有 37 项 + 示例图结构 5 项 + 快照生成 5 项 + HTTP 新增 6 项
  （`node --test "test/*.test.mjs"`）。
- **示例图**：64 节点 / 78 连接 / 6 工作区 / 43 会话；`byType` 含 keyword / entity / hebbian /
  explicit / semantic / mentions；体检样本 `dup=1, oversize=1, stale=1, unread=17, thin=1, orphan=0`；
  `?demo=1` 下 `/graph`、`/node`（xg-weekly degree=11）、`/recall`（星港 12 条）、
  `/path`（vc-quote→dy-touched hops=1）全部可用；`POST /link?demo=1` 返回 403。
- **真实库快照**：1853 节点 / 8595 连接 → 约 2.6MB HTML（含全部正文），生成 0.3s；headless Edge 以 `file://` 打开，
  `NebulaAPI.snapshot=true`、无 JS 异常、stats 正确、重建按钮隐藏；搜索「记忆」12 条命中，
  点第一条正文 560 字正常显示；1816/1853 个节点带正文（其余是来源节点）；
  四个看板页签都能在离线数据上打开，导出菜单提示「这已经是一份离线快照了」，
  关系行不出现「屏蔽」按钮；`performance` 里没有任何 `http(s)` 资源请求（真正离线）。截图 `dev/shot/snapshot.png`。
- **示例实机**：`?demo=1` 顶栏与统计正确；搜索「星港」12 条；详情正文 228 字；
  点重建出现只读提示；退出后回到 1853 条真实库。截图 `dev/shot/demo.png`。
- **空态实机**：CDP 拦截 `/graph` 返回空图，卡片三路说明与两个按钮完整；
  点「看示例」进入 64 条示例。截图 `dev/shot/empty.png`。
- **窄屏**：820×900 与 700×900 的示例模式，模式条不压搜索框、`scrollWidth` 等于视口宽、
  无横向溢出；820 下首次发现重叠并修好（1180px 以下让位）。截图 `dev/shot/narrow-demo.png`、`narrow-700.png`。
- **冒烟 51 项全过**（真实库 1853 节点）：新增示例与快照 13 项；**安全探针 21 项全过**（新增 `/share` 头与示例只读）。
- **发布检查**：v0.5.0，58 个文本文件 UTF-8、38 个脚本 `node --check`、15 个 Markdown 相对链接、
  0.5.0 构件（demo.js / share.js / http 路由 / 前端模式）齐全；`npm pack --dry-run` 55 文件 / 1.8MB（解开 2.4MB，含三张 0.5.0 界面图）。
