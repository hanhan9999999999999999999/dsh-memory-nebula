# 记忆星图 · 发布手册

这一册是「把当前仓库交出去」的检查清单。目标是：任何人拿到 tarball，按 README 能装上、
能看到自己的星图、出问题能自己判断是哪一层。星图没有构建步骤，也没有运行时依赖。

## 一、支持面

| 项 | 范围 |
| --- | --- |
| Node | `>=22.13.0`（`node:sqlite` 的 `DatabaseSync` 需要） |
| DSH | 带 `webServer` / `tools` / `systemPrompt` 注入点的版本 |
| 系统 | Windows / macOS / Linux；`sidecar.ps1` 仅 Windows，其它系统用 `node lib/standalone.mjs` |
| 浏览器 | 支持 WebGL2 的现代浏览器（3D 视图需要；2D 不需要） |
| 运行时依赖 | 无（`dependencies` 为空） |

## 二、发布前检查（按顺序）

先跑一条命令看整体，红了再按下面逐项查：

```bash
npm run verify:all        # 单测 + 发行构件 + HTTP 冒烟 + 安全面 + 畸形参数（约 10 秒）
npm run verify:full       # 再加 5 万条库验收 + 浏览器翻页 + 无障碍八状态 + 键盘 Tab 序列（约 90 秒）
node scripts/verify-all.mjs --gpu        # 再加三维真 GPU 探针
```

`scripts/verify-all.mjs` 只做编排，每一步都是原本就单独跑得起来的那把尺子。它会把
「通过 / 失败 / 跳过」分开计数，`--json` 给 CI 用；**跳过不算通过**——没有 `dev/`、
没有测试库、没有 Edge、测试库条数不够时，那几步标「跳过」并写清原因。
`--root` 换测试库、`--nodes` 改期望条数（默认 50000）；翻页与八状态两把尺子的断言按
5 万条库写死，拿更小的库跑它们只会红，所以会被标成跳过。

逐项检查（`verify:all` 覆盖的就是这些）：

```bash
cd <plugin>

# 1. 语法与静态检查（版本一致、UTF-8、import、死文件、CORS、document.write…）
npm run check

# 2. 单元测试（191 项，纯函数 + 契约 + 结构门）
npm test

# 3. 起一个干净实例，跑接口契约（63 项）
node lib/standalone.mjs --port 7893 --root <一个包含记忆库的目录>
node scripts/smoke.mjs http://127.0.0.1:7893/api/memory-nebula
npm run verify          # 单测 + 静态发布检查；npm pack 会通过 prepack 自动再跑一遍

# 4. 安全边界（25 项）
node dev/security-probe.mjs http://127.0.0.1:7893

# 5. 打包清单：只带该带的
npm pack --dry-run
```

期望：1/2/3/4 全绿；5 的清单里没有 `test/`、`dev/`、`node_modules/`、`.edge-*`、截图。

## 三、版本号

语义化版本：

- **patch**：只修 bug、改文案、补测试；
- **minor**：新增接口/工具/适配器、UI 新能力，旧调用仍可用（0.4.0 新增 `/ping` 字段与 CLI、0.5.0 新增 `?demo=1` 与 `/share`、0.6.0 新增 `scope`/`hops`、0.7.0 新增 `hide` 与首访引导，都不改旧字段语义）；
- **major**：删字段、改语义、改存储格式导致旧缓存不可读。

一次发版要同时改：

1. `package.json` 的 `version`；
2. `CHANGELOG.md` 顶部新增同版本小节（`npm run check` 会比对）；
3. `docs/operations.md` 的「发布信息」；
4. README 里的版本徽章/说明（如果有）。

## 四、打包与安装

```bash
npm pack                       # 生成 dsh-memory-nebula-<version>.tgz
```

1.1.2 实测：**72 个文件**，包 2.3 MB、解开 2.9 MB（`docs/assets/` 的预览图与基准脚本占大头）。
干净目录安装后 `--version` = 1.1.2，导出 `apply,inject,name,version`；
安装包起 7896 实测 `/share?scope=ws:DSHLive2D&hide=level:lesson` → 200、601,177 字节。
1.1.3 起包内多了 `SECURITY.md` 与 `CONTRIBUTING.md`，`.github/` 不进包；文件数与体积以 `npm pack` 的输出为准（不要手写进文档，否则每次改文档都要重打包）。

1.1.8 实测：**75 个文件**，包约 2.3MB、解开约 3.0MB（精确字节以 `npm pack` 输出为准）。
1.2.0 实测：**75 个文件**，包约 2.3MB、解开约 3.0MB（精确字节以 `npm pack` 输出为准）；20k 基准 2.53s / heap 248MB，见 `benchmarks.md`。
1.2.1 实测：**77 个文件**，包约 2.4MB、解开约 3.0MB；新增排查文档与 20k 截图，另修英文空态兜底。
1.3.0 实测：**77 个文件**，包约 2.4MB、解开约 3.0MB；快照按列存使 20k 文件从约 23.1MB 降到 19,996,814B。
1.4.0 实测：**77 个文件**，包约 2.4MB、解开约 3.0MB；新增 `--share` 命令行快照，修掉 package.json 自我依赖。
1.4.1 实测：**81 个文件 / 2,917,431B**（新增 4 张英文截图），解开 3,626,628B；无代码行为变化。
1.5.0 实测：**81 个文件 / 约 2.9MB**（新增命令行导出与范围过滤，无新资源文件），精确字节以 `npm pack` 为准。
1.6.0 实测：新增可选本机口令（standalone `--token` / `NEBULA_TOKEN`），99 单测；81 文件 / 2,925,496B。
1.6.1 实测：口令门的 HTML 登录页与 `/unlock` 302，99 单测；81 文件 / 2,928,345B。
1.6.2 实测：`doctor --token` 把口令放进 Authorization，endpoint 不再被自己的 401 挡住；100 单测；81 文件 / 2,929,631B。
1.6.3 实测：修列存快照空白，102 单测；88 文件 / 3,066,023B（含 docs/demo.html）。
1.6.4 实测：`--demo` 服务器模式使用示例库，103 单测；88 文件 / 3,066,929B。
1.7.0 实测：键盘层与读屏索引（`nav.js` + 两个渲染器的 `centerOn`/`zoomBy`），**126 单测 / 63 项 smoke**；
**91 文件 / 3,229,329B**，sha256 `c6e9f8d50ca69da34c1d266ce3e8a0f5f26fd7bebf3a11bf2296c639a6be3d66`。
装进空目录（`npm i <tarball>`）后跑 demo 服务：smoke 63 项全过，键盘探针（CDP 真实按键）全通过，
`lib/web/nav.js` 与 `docs/accessibility.md` 都在包里；`test/`、`dev/` 不进包。
axe-core 4.10.2：离线快照 / HTTP / 英文界面与官网首页 **0 违例**（官网弱文字 `#8a94a6`、截图条可聚焦、星图页 `<main>` 与滑杆 aria）。
1.11.10 产物：`dsh-memory-nebula-1.11.10.tgz` · 93 文件 · 3,341,264 字节 · sha256 `db268d0d…`（包内记录的是上一刀的数字）。
## 1.11.49 实测

- 门禁：带 `dev/` 全部通过；`NEBULA_NO_DEV=1` 也全部通过（修复前 1 个问题）。
- 干净克隆：163 个跟踪文件、无 `dev/`、无 `node_modules` → `check ✔ · test ✔`（16.0s）。
- 单测：**386/386**。

1.11.49 产物：第一刀：95 个文件 / 3,491,720 字节 / sha256 9f59ed5b1d34206bdc870cdf424256bf520a09881b651bd62f4e415811da03f6（回填后重打，包内记录的是上一刀的数字）。

## 1.11.48 实测

- `npm run verify:full`：**12 通过 / 0 失败 / 0 跳过 · 169.1s**（改前 11 通过 / 1 失败）。
- 大库验收 22 项全过，检索从「5,251ms 假红」回到 1.3s 级——那一趟读的是上一步留下的图缓存，后台重建在探针脚下抢 CPU。
- `dev/probe-step-home.mjs`：默认那套长出 5 个 `step-NN-…`，第 1 步（单测）没有图缓存。

1.11.48 产物：dsh-memory-nebula-1.11.48.tgz · 95 个文件 · 3490091 字节 · sha256 b0032b1aec162900d918a387ac1002a4459231e5f74b95a529441afab44b317e（包内记录的是上一刀的数字）。

## 1.11.47 实测

- 单测 **386/386**；缓存相关四个文件 15/15。
- 干净进程读盘（20 万条）：JSON 4,118ms、v8 **3,683ms**；文件 17,328,867 B → 15,472,713 B。
- 真机重启：`/ping` **4,117ms**、第一张图 253ms（1.11.34 记 5,238ms，本轮快 1,121ms）。
- 被否掉的三条：展示字段重算 10,977ms、分帧 8,488ms、bigram 池化 0.86x。

1.11.47 产物：dsh-memory-nebula-1.11.47.tgz · 95 个文件 · 3487692 字节 · sha256 e89c0482dfbbad43c6f9ad7500f83bc39f59d592eefd5b713f84dbdaf23c0a89（包内记录的是上一刀的数字）。

## 1.11.46 实测

- 接口：20 万条上 `GET /overview` **12,940ms → 111ms**；`GET /hygiene` 9,579ms（第二次 6ms）；体检已缓存时 `/overview` 49ms。
- 浏览器：`dev/verify-hygiene-lazy.mjs` **9/9**（12,500 条夹具 + 关掉体检预热）：概览 28ms、看板先说「正在算」、算完自动填上、之后概览带上体检。
- 单测：**382/382**。

1.11.46 产物：dsh-memory-nebula-1.11.46.tgz · 95 个文件 · 3483361 字节 · sha256 384d37c0cd3c409471232e17805faff7a546adb123f95bfcbf01b2924b120d3a（包内记录的是上一刀的数字）。

## 1.11.45 实测

- 单测：**378/378**（新增 `test/cli.test.mjs` 17 项、`test/share-hops.test.mjs` 4 项）。
- 覆盖率：`lib/standalone.mjs` 41.30% → **70.76%**（函数 25% → 47%）、`lib/host/share.js` 100% / 85.00 / 98.18、全部文件 **91.19%**。
- 端到端：`--export --hops 9` 与 `--share --hops abc` 都退出 2，提示「hops 需要 1–5 的整数」（以前静默按 5 / 按 2）。
- 干净克隆、demo 快照、smoke / security / fuzz 按惯例复跑。

1.11.45 产物：dsh-memory-nebula-1.11.45.tgz · 95 个文件 · 3479007 字节 · sha256 06893f42afc67fcbcada34dea7f76d24740f26a6a5bb657c821c0d86ba768cd6（包内记录的是上一刀的数字）。

## 1.11.44 实测

本机按 CI 的取文件方式模拟（`git clone`，`core.autocrlf=true`）：`release-check` 全部通过，单测 **357/357**。

CI 侧：`verify` 作业现在同时跑 `ubuntu-latest` 与 `windows-latest`。

1.11.44 产物：dsh-memory-nebula-1.11.44.tgz · 95 个文件 · 3474236 字节 · sha256 b5b7d1b825099750e3864e39333ab19ddc4ff605363d9e02e223fd87389371c8（包内记录的是上一刀的数字）。
## 1.11.43 实测

`npx -y node@22.15.0 --test test/scan-steps.test.mjs`：进程直接死，`exitCode 3221225477`（`0xC0000005`，访问违例），不是断言失败。Node 22 的 `node:sqlite` 仍是实验实现。

改后：`engines.node` = `>=24.0.0`，CI 只跑 Node 24；24 上 357/357 通过。

1.11.43 产物：dsh-memory-nebula-1.11.43.tgz · 95 个文件 · 3472689 字节 · sha256 312d3cc38c93010bdbedf852e33eb207ef0a687d375f328fe6d81f0cd16fd0c7（包内记录的是上一刀的数字）。
## 1.11.42 实测

GitHub Releases 之前停在 `v1.6.4`：1.11.x 全系列都没有附件，「从 GitHub 安装」无从下手。新增 `release.yml`，推 `v*` 标签自动打包并挂附件。

1.11.42 产物：dsh-memory-nebula-1.11.42.tgz · 95 个文件 · 3471277 字节 · sha256 fe044825dc7b30001c8c7be48177a56fefba2a9f99b8e26698d195bf9018fa62（包内记录的是上一刀的数字）。
## 1.11.41 实测

`node dev/sim-clean-clone.mjs`（只复制 git 跟踪的 158 个文件，没有 dev/、没有 node_modules）：

- 改前：`release-check` 报缺 27 个 `dev/…`；22.13 上单测因 `zstdDecompressSync` 导入失败整组挂。
- 改后：`check` 通过；单测 **357/357**，16.8 秒。

本机 `node scripts/release-check.mjs`：全部通过（1586 行）。

1.11.41 产物：dsh-memory-nebula-1.11.41.tgz · 95 个文件 · 3469995 字节 · sha256 b9f33652a53ae8a0ce0837748cab4476ee02c84741e17f1a2352526ecc3718f1（包内记录的是上一刀的数字）。
## 1.11.40 实测

`node dev/probe-notes-cap.mjs`（上限 5、磁盘上 20 个文件）：

- 改前：`detect` 只看见 5 个；改第 20 个文件后 size 仍 109、mtime 不变 → 签名不变、图不重建；界面无任何提示。
- 改后：`store.truncated = true`、`scan.truncated = true`、`scanAll.warnings` 一条、`overview.warnings` 里 `code = "source-truncated"`（文案「来源被文件数上限截断：只读了前 5 个文件，其余没有进图。」）。

覆盖：`adapters/util.js` 47.56% → **95.24%**（函数 95.83%）、全部文件 89.46% → **89.95%**；单测 340 → **357**。

1.11.40 产物：dsh-memory-nebula-1.11.40.tgz · 95 个文件 · 3466420 字节 · sha256 62d3d1cbd0ef19dee7053ba683cb5d790a2994cf3277d8c8437c5af7b6468b88（包内记录的是上一刀的数字）。
## 1.11.39 实测

- `sources.js` 行覆盖 54.04% → **93.66%**、函数 61.54% → **92.86%**；全部文件 88.26% → **89.46%**；单测 326 → **340**。
- MCP 嗅探：同一份 patch 里 `unrelated-plugin`（普通插件，紧跟在一个 MCP 条目后面）改前被列进 MCP 清单，改后不再出现；真正的两个（`dsh-memory-nebula` stdio、`drawio` streamable-http）照旧。
- 删掉 `readStoreNodes` 后 `graph.js` 仍 1,642 行、`sources.js` 由 322 行降到 264 行，`node --check` 与 340 项单测全过。

1.11.39 产物：dsh-memory-nebula-1.11.39.tgz · 95 个文件 · 3462769 字节 · sha256 dcd781daf372c20bd416af85b770109f63ca002691d686595c4a0801c5f81949（包内记录的是上一刀的数字）。
## 1.11.38 实测

`node dev/probe-ingest.mjs`（临时 DSH_HOME，同一批两条推送两次）：

- 改前：第一次 2 条，再推一次 **4** 条，两次的 node id 不一样；传对象当 items 抛 `TypeError: (items || []) is not iterable`。
- 改后：2 条 → **2** 条，id 一致；传对象回 `{ written: 0, error: 提示 }`；带 uid 的对照仍是「后写覆盖」（3 → 3）。

手工文件（BOM + 注释 + 坏行 + 非对象行）照旧只留好行；level 归一化成小写、importance 夹到 0..4、keywords 认字符串与数组。

覆盖：`ingest.js` 33.51% → **97.97%**（函数 100%）、全部文件 87.14% → **88.26%**；单测 312 → **326**。

1.11.38 产物：dsh-memory-nebula-1.11.38.tgz · 95 个文件 · 3460675 字节 · sha256 80ec64fbbe13d4e846020b732b6f0672ef25e453ae6afacf469a659e7c7d938f（包内记录的是上一刀的数字）。
## 1.11.37 实测

`node dev/probe-transcript-index.mjs`（临时 DSH_HOME，两层 sessions 布局）：

- 改前：先建一个会话 → `sessions 1`；再建一个会话 → 仍然 `sessions 1`（看不见）；`originOfMemory` 对新会话 null。
- 改后：`sessions 1 → 2`；`originOfMemory` 返回那句话、`gapMs 500`；`TTL=30000` 时窗口内不重扫（`2 → 2`）。

`node dev/probe-index-cost.mjs`（真机 `Dsh-home`，53 个会话）：强制重扫 **3–5ms**，命中缓存 **0ms**。

覆盖：`transcripts.js` 25.41% → **94.79%**（函数 100%）、全部文件 84.72% → **87.14%**；单测 293 → **312**。

1.11.37 产物：dsh-memory-nebula-1.11.37.tgz · 95 个文件 · 3457776 字节 · sha256 582dc2c57967fd741362034237aa962366d172a0df86b9ef445671ce358c124c（包内记录的是上一刀的数字）。
## 1.11.36 实测

`node dev/probe-bridge-hops.mjs`（同一张 4 节点 3 边的小图，种子 1 条）：

- 改前：默认 budget → 候选 **0** 条；`hops: NaN` → 候选 **0** 条；`hops: 1` → 候选 2 条。
- 改后：三种输入都是候选 **2** 条，`spread` 能量表从 1 条变成 3 条。

覆盖：`bridge.js` 27.25% → **95.44%**（函数 0% → **100%**）、`ledger.js` 52.57% → **98.86%**（函数 41.67% → **100%**）、全部文件 81.77% → **84.72%**；单测 268 → **293**。

安装副本与烟雾：见发布产物行。

1.11.36 产物：dsh-memory-nebula-1.11.36.tgz · 95 个文件 · 3454456 字节 · sha256 b19c6a85ed35b3a92e0aad438fe78a6073357fb72db3c760cc472f45acb9433c（包内记录的是上一刀的数字）。
## 1.11.35 实测

| 项 | 结果 |
|---|---|
| 端到端探针（别人的 SQLite 库） | 8/8 通过：节点 5/5、层级 `fact`、`id` 前缀 `sqlite:`、概览列出该来源、`readErrors` 为空 |
| 中文签名下的 `/graph`（修前） | 无响应头，6 秒超时；日志 `ERR_INVALID_CHAR: Invalid character in header content ["etag"]` |
| 中文签名下的 `/graph`（修后） | 200，etag 为 sha1 前 20 位，`If-None-Match` 仍走 304 |
| 覆盖率 | 全部文件 77.45% → 81.77%；`adapters/notes.js` 25.25% → 97.64%；`adapters/sqlite.js` 28.52% → 93.03% |
| 单测 | 252 → 268 项全过 |

1.11.35 产物：dsh-memory-nebula-1.11.35.tgz · 95 个文件 · 3451159 字节 · sha256 5fc32b94e96aafcedce2d1708c3237159edf71f3468a9f245e98dd90c5e0ddc0（包内记录的是上一刀的数字）。

## 1.11.34 实测

尺子对着 20 万条（`.tmp-200k`，复用 9 个真实库的语料、只换 id）：冷建图 24,450ms、写缓存 7,656ms / 17.3MB（未压 614MB）、读盘恢复 5,238ms、第一次检索 5,832ms、第二次 465ms、概览含体检 8,678ms、整图 JSON 106.5MB / 1,266ms、GC 后堆约 1.2GB、RSS 峰值约 4.6GB。

5 万条未受影响。告示门槛默认 150,000 条，`NEBULA_LARGE_LIBRARY` 可调；`dev/verify-scale-note.mjs` 10/10（把门槛压到 1000 条演这场戏）。

1.11.34 产物：dsh-memory-nebula-1.11.34.tgz · 95 个文件 · 3445320 字节 · sha256 627553e94934fbf4338ea43308fb214ee9ab85e7a2763af1b3630b3a089e625c（包内记录的是上一刀的数字）

## 1.11.33 实测

- 第一次检索（后台预热正在算，五万条库）：3,495ms → **735ms**（`dev/verify-20k.mjs` 那条断言从红转绿）。
- 另一批来源的缓存：`.tmp-goodsource` / `.tmp-badsource` 起服务时不再端上本机真实库的图，条数从 2,073 回到夹具的 12,500。
- 坏来源横幅：`dev/verify-readerr.mjs` 连跑两趟都是 15/15（第二趟走的是读盘命中这条路）。
- `dev/verify-refresh-toast.mjs` 5/5、`dev/verify-axe-states.mjs` 8/8（0 违例）、`dev/verify-20k.mjs` 22/22。
- `npm run verify:full`：12 步全绿，合计约 2 分钟。

1.11.33 产物：dsh-memory-nebula-1.11.33.tgz · 95 个文件 · 3440893 字节 · sha256 c5f8eaf87f7fdab21d3939bf85eb645155c61765ac10fa8cd94389b314608714（包内记录的是上一刀的数字）

## 1.11.32 实测

10 万条夹具（独立 DSH_HOME，宿主式服务先 listen 再 `refreshInBackground()`）：

- 建图期间 `/progress` 依次报出 `读来源 → 整理节点 → 统计词频 → 挑签名 → 建倒排 → 找候选对 → 给关联打分 → 剪掉弱连接 → 收尾`；
- 页面遮罩采样到 4 个不同阶段，最长一句是「正在建图：整理节点 · 2 / 11 · 3.2s · 100000 条记忆」；
- 建完 `building:false`、`progress:null`、遮罩收起、页面拿到图。

1.11.32 产物：dsh-memory-nebula-1.11.32.tgz · 95 个文件 · 3435876 字节 · sha256 31a5d3c409e1d28c8c4e1617675ddd78e503dbbedf55ee30e367bc8c0c3dfbe1


## 1.11.31 实测

- 单测：241/241（新增 `test/cache-impl.test.mjs` 3 项）。
- 真机探针 `dev/probe-impl-upgrade.mjs`（5 万条 / 52,073 节点）：建图 6,735ms；把缓存标成旧算法后重启，第一张图 2,494ms 并标 `stale`；后台 7,016ms 换成新算法结果；新缓存 5,168ms 落盘；第三次启动 1,891ms 直接命中。
- 12 项断言全过，日志里写明「上一份是别的版本算的」。

1.11.31 产物：dsh-memory-nebula-1.11.31.tgz · 95 个文件 · 3430228 字节 · sha256 e245d46d762f80dd274d64c516800308f034478700789e0fee2c0164dd0352e5

## 1.11.30 实测

五万条库（52,073 节点 / 17.1 万条关联），独立 `DSH_HOME`，`node dev/probe-stale-start.mjs`：

- 冷启动（无缓存）：第一张图 **6,155ms**。
- 重启 + 签名对不上：第一张图 **1,043ms**（`stale:true`、`refreshing:true`），后台 **6.1–6.4s** 换成新图。
- 页面侧 `dev/verify-bg-refresh.mjs` **9/9**：首帧 122–284ms 有图、标着后台在建、自己换成新图、提示带条数。

1.11.30 产物：dsh-memory-nebula-1.11.30.tgz · 95 个文件 · 3427050 字节 · sha256 cb8bbeba4c0ba93dbcd37dbea3eb57b8f6b6d7c25596e46bc4003dc76ad79b89

## 1.11.29 实测

五万条库（52,073 节点 / 171,309 条关联），重启后图就绪 **1.03 秒**（1.11.28 的读盘缓存），随后点开「体检」看板：

- 后台预热过：**91ms**
- 关掉预热（`NEBULA_HYGIENE_WARM=0`）：2,057–2,102ms
- 图刚出来就点（预热还没轮到）：2,885ms，那一下算完后续 14ms

两条路算出的 `counts.dup` 都是 400,386 —— 预热提前算的是同一份结果，不是近似值。
单测 232/232，探针 `dev/probe-overview-warm.mjs` 6/6。

1.11.29 产物：`dsh-memory-nebula-1.11.29.tgz` · **95 个文件 · 3,420,059 字节** · sha256 `584caab65efb1db8e1356e9a6bea27f28432cae3919b5f1285a32332a81f3bec`（包内记录的是上一刀的数字）。

## 1.11.28 实测

同一份 5 万条库（52,073 节点 / 17.1 万条关联），独立 `DSH_HOME`：

- 第一次（无缓存）：图就绪 **6,298ms**；缓存落盘 +1,632ms（在响应之后）。
- 第二次（读盘恢复）：图就绪 **1,033ms**（**6.1x**），日志「读盘恢复：50000 条记忆 / …（磁盘缓存，未重建）」。
- 缓存文件 `graph-<sha1 前16>.json.br`：**4.3MB**（未压 163.9MB），盘上最多 3 份。
- 探针 `node dev/probe-cache-start.mjs <库目录>` **4/4**；单测 **229/229**。
- `NEBULA_CACHE=0` 既不读也不写；坏缓存自动删掉并重建。

1.11.28 产物：`dsh-memory-nebula-1.11.28.tgz` · **95 个文件 · 3,417,408 字节** ·
sha256 `079817156e99ee7e5838515cd8762d7fb8585da4f2acbc8817964c6afbc0952a`（包内记录的是上一刀的数字）。

1.11.27 实测：**第一次检索 1,330ms → 100ms**（52,073 节点，`NEBULA_PREWARM_DELAY` 对照）。建完图后台算词频表，`unref()` 不拖进程，图换了就放弃。224 单测全过。

1.11.27 产物：dsh-memory-nebula-1.11.27.tgz · 94 文件 · 3,412,014 字节 ·
sha256 52af6d40f2a28ebc3aa55a8b6dcfc944c7efb8c4de965710c689535715d96faa（包内记录的是上一刀的数字）。

1.11.26 实测：5 万条库上 `POST /link` **47–64ms**（改前 39ms + 一次 4,830ms 重建）、
`POST /mute` **45–54ms**（改前 41ms + 5,829ms）、`POST /unmute` **42–53ms**；
策展之后 `GET /graph?refresh=1` **164–177ms 且 `builtAt` 不变**，`GET /graph?force=1` 仍 4.4–5.4s。
冻结 `now` 的等价性：策展一条 = 重建的 +1 / −0；否掉一条 = 重建的 −2 / +3（就地不补位，如实记）。
1.11.26 产物：`dsh-memory-nebula-1.11.26.tgz` · **94 个文件 · 3,407,288 字节** · sha256 `986115c45adb2c00fd867718608e7acb23dd85f8068a5277454fc5b4c09df1d2`（包内记录的是上一刀的数字）。

1.11.25 实测：`GET /graph?refresh=1`（页面每次加载都走这条）**5,867ms → 13ms**，`builtAt` 不变；
`?force=1` 仍 5,867ms；`POST /refresh` 第二次 112ms；215 单测；`dev/probe-refresh-skip.mjs` 8/8。
1.11.25 产物：`dsh-memory-nebula-1.11.25.tgz` · **94 个文件 · 3,401,809 字节** · sha256 `aca62d2f3f09b777f6bfbbcad29c4d11131cb7babe527863628fee1402699894`（包内记录的是上一刀的数字）。

1.11.24 实测：5 万条库上第二次 POST /refresh **146ms**（改前 6,901ms，每次都全量重建），
`?force=1` 仍 6,232ms；界面提示从「已重建」改成「什么都没变，没重建：52073 条记忆 · 5ms」。
证据：`node dev/probe-refresh-skip.mjs .tmp-50k` 与 `node dev/verify-refresh-toast.mjs .tmp-50k`（5/5）。

1.11.24 产物：`dsh-memory-nebula-1.11.24.tgz` · **94 个文件 · 3,398,127 字节** · sha256 `1bb1c0cccf6257bbdacf87b03d935c1c79013c3327ec9844190d16ba16f0af50`（包内记录的是上一刀的数字）。

## 1.11.23 实测

一好一坏两个来源目录（好的 12,500 条 + 一个「看起来像 SQLite 其实不是」的 `memory.db`）：

- `/overview` 的 `readErrors` 给出 `[{ key: 'bad', title: 'bad', path: …, error: '读不动 memory.db：file is not a database' }]`。
- 界面：横幅 `有 1 个来源读不动：bad，这些记忆不在图里 看来源`；概览标题 `14573 条 · 1 个库读不动`；来源面板一行红字保留。
- 快照：`id="snapshot-readerr"` 静态横幅出现，文案含来源名与原因，**不含本机路径**（`publicOverview` 里脱敏）。
- `node dev/verify-readerr.mjs` **15/15**（含 axe 0 违例）；单测 **208/208**。

发布产物：`dsh-memory-nebula-1.11.23.tgz` · **94 个文件 · 3,393,122 字节** ·sha256 `a9be59b6e3308c36a31c580215563d23234a4c8ca794cac5707162c71ec537e2`（包内记录的是上一刀的数字）。

## 1.11.22 实测

5 万条库（52,049 条 / 178,262 边）：

- score 段 **581ms → 448ms**。
- A/B **交错**五轮中位 **4,888ms → 4,711ms（−177ms，1.04x）**；每轮差值 +129 / −279 / −334 / −20（首轮冷启动剔除）。
- 真机 `/refresh` **5,718 / 5,550ms → 5,461 / 5,409ms**，ping p50 4ms / p90 8–9ms / max 167–199ms，慢过 500ms 的 0。
- `dev/verify-50k.mjs` **22/22**（/share 38.42MB / 3,304ms、检索 1,350ms、最长卡顿 57ms）；单测 205/205。
- 被量倒：11 条实体规则合成 1 条正则 → 7,009/52,049 条不一致且更慢（1.45s vs 1.28s）。

1.11.22 产物：`dsh-memory-nebula-1.11.22.tgz` · **94 个文件 · 3,388,157 字节** ·sha256 `cfdb29d05936ae74d23c12d2c9371bb00e405229755b02b83bc6ec30f317c088`（包内记录的是上一刀的数字）。

## 1.11.21 实测

5 万条库（52,049 条 / 178,262 边）：

- sig 段 **261ms → 139ms**；postings **380ms → 253ms**；score **581ms → 518ms**；逐片合计约 4,800ms → 4,580ms。
- A/B 各 5 次中位 **4,931ms → 4,603ms（−328ms）**，edgeSha 两次都是 `b32595a7`。
- 真机 `/refresh` **6,156 / 5,886ms → 5,718 / 5,550ms**，ping p50 4ms / p90 8–9ms / max 160–212ms，慢过 500ms 的 0。
- `dev/verify-50k.mjs` **22/22**（/share 38.42MB / 3,028ms、检索 1,319ms、最长卡顿 51ms）；单测 205/205。
- 内存：`--expose-gc` 量两版建图后 heapUsed 都是 335MB（**没省**），rss 1199MB → 1175MB。

1.11.21 产物：dsh-memory-nebula-1.11.21.tgz · 94 文件 · 3,385,690 字节 · sha256 e3c87ef8…（包内记录的是上一刀的数字）。

## 1.11.20 实测

5 万条库（52,049 条 / 178,262 边）：

- 建图 sig 段 **824ms → 261ms**；建图逐片合计约 5,615ms → 4,800ms。
- A/B 各 5 次中位 **5,756ms → 5,100ms（−656ms）**，edgeSha 两次都是 `b32595a7`。
- 真机 `/refresh` **6,341 / 6,649ms → 6,156 / 5,886ms**，ping p50 4ms / p90 8–9ms / max 156–198ms，
  慢过 500ms 的 0 次。
- `dev/verify-50k.mjs` **22/22**：/share 50000 条 38.42MB / 3,014ms、检索 1,303ms、最长卡顿 56ms。
- 单测 205/205。

1.11.20 产物：dsh-memory-nebula-1.11.20.tgz · 94 文件 · 3,383,221 字节 · sha256 2e4f60c4…（包内记录的是上一刀的数字）。

## 1.11.19 实测

5 万条库（52,073 节点 / 178,262 边）：扫描 12 个来源 **450ms / 最长空档 23ms**（修前 532ms / 532ms）；
真机 `/refresh` **6,341 / 6,649ms**（修前 6,950–7,109ms），ping p90 8–9ms、max 179–186ms、慢过 500ms 的 0；
`/share?limit=50000` 38.42MB / **3,248ms**；检索 **1,399ms**；建图期间最长卡顿 62ms；
三个指纹与 1.11.16–1.11.18 逐位相同；单测 **205/205**；`dev/verify-50k.mjs` **22/22**。

1.11.19 产物：dsh-memory-nebula-1.11.19.tgz · 94 文件 · 3,379,999 字节 · sha256 0f3680dd…（包内记录的是上一刀的数字）。
## 1.11.18 实测

建图的候选对键从字符串 `a + ':' + b` 换成数字 `a * PAIR_BASE + b`（`PAIR_BASE = 1 << 20`）：
建图中位 6,399 → 5,765ms（A/B 各 5 次），真机 `/refresh` 7,341–7,558 → 6,950–7,109ms，
`/refresh` 期间 ping max 184–216ms、慢过 500ms 的 0 次；冻结 `now` 后三个指纹逐位相同。
大库验收 `dev/verify-50k.mjs` 22/22，单测 202 项全过。

1.11.18 产物：dsh-memory-nebula-1.11.18.tgz · 94 文件 · 3,376,347 字节 · sha256 254414cd…（包内记录的是上一刀的数字）。

## 1.11.17 实测

同一份 5 万条库（52,049 条记忆 / 2,777 万字），抽实体 1.16s → **0.90s**、节点准备 2.17s → **1.84s**、
df 段 573ms → **390ms**；建图 A/B 各 5 次取中位 **6,979ms → 6,431ms**；真机 `/refresh` 8,322–8,325ms →
**7,341–7,558ms**（ping 最长 186–203ms、慢过 500ms 的 0/243）；`/share?limit=50000` 38.42MB / 3,288ms；
`/overview` 89KB / 2,468ms；`dev/verify-20k.mjs` **22/22**；单测 **202/202**。
等价性靠冻结 `now` 的三个指纹逐位相同 + 实体 Map 逐条比对 0 不同。
1.11.17 产物：dsh-memory-nebula-1.11.17.tgz · 94 文件 · 3,371,815 字节 · sha256 7053c378…（包内记录的是上一刀的数字）。

1.11.16 实测：建图的「挑最稀有 26 个词」从整表排序改成有界插入（`topRareTokens`）。
签名段 2,419-2,655ms -> 859-1,055ms；整次建图 8.7s -> 6.9-7.3s；真机 /refresh 9,304-9,476ms -> 8,322-8,325ms，
请求期间 ping 最长 217ms、慢过 500ms 的 0/268；/overview 89KB / 2,336ms；202 单测、5 万条库 22/22。
等价性：冻结 input.now 后改前改后的 nodeSha/edgeSha/statsSha 逐位相同；逐节点签名比对 52,049 条不一致 0。
顺带确认：建图本来就依赖 Date.now()，同一份库两次跑边数会差几条，所以给 buildGraph 加了可冻结的 now。
1.11.16 产物：dsh-memory-nebula-1.11.16.tgz · 94 文件 · 3,367,873 字节 · sha256 c6157d84…（包内记录的是上一刀的数字）。
1.11.15 实测：签名挑选改成「比编号不比字符串」，每个节点的词表存成 Int32Array。
体检 2,899ms -> 2,039ms（sig 段 775-867ms -> 236ms）；/overview 5 万条 3,861ms -> 2,319ms、89KB；
/share?limit=20000 冷 1,940ms -> 1,263ms，同一请求 ping 最长 233ms -> 172ms；
逐节点比对参考实现：52,049 条记忆签名不一致 0、词频不一致 0；197 单测、verify-20k 22/22。
1.11.15 产物：dsh-memory-nebula-1.11.15.tgz · 94 文件 · 3,364,190 字节 · sha256 25b5d2d9…（包内记录的是上一刀的数字）。
1.11.14 实测：验收脚本在**已安装副本**里不再崩（缺 test/ 时标跳过）。仓库里 6/6 · 7.6s；
.tmp-1.11-install 的已安装副本里 2 通过 / 0 失败 / 4 跳过 · 0.5s、退出码 0，四条跳过各自写明缺什么。
教训：验过仓库不等于验过交付物。
1.11.14 产物：dsh-memory-nebula-1.11.14.tgz · 94 文件 · 3,360,683 字节 · sha256 74d551c7…（包内记录的是上一刀的数字）。
1.11.13 实测：该更新了（stale）改前缀过滤，只在前 |kws|-2 个稀有词里找候选。2 万条库 stale 段 910ms -> 328ms；
同步体检 3,142-3,474ms -> 2,899ms（对比 1.11.10 的 5,321ms 是 -45%）；冷 /overview 3,861ms / 89KB；
/share?limit=50000 38.42MB / 3,825ms；/refresh 9,476ms 且最长卡顿 56ms；197 单测；5 万条库 22 项全过。
等价性：probe-stale-equiv 新旧逐对 漏 0 / 多 0，by 有 23/41,643 不同（仍合法）。
1.11.13 产物：dsh-memory-nebula-1.11.13.tgz · 94 文件 · 3,358,263 字节 · sha256 32ab4c4c…（包内记录的是上一刀的数字）。
1.11.12 实测：一条命令跑完整套验收。`npm run verify:all` **6/6 · 7.1s**；
`npm run verify:full` 在 5 万条库上 **10/10 · 84.2s**（大库 22 项 20.7s、翻页 15.2s、
八状态 axe 27.0s、Tab 10.7s）；`--gpu` 三维 15.9s。2 万条库上 `--full --nodes 20000` →
**7 通过 / 0 失败 / 3 跳过 · 16.7s**，跳过原因逐条写明（跳过不算通过）。
1.11.12 产物：dsh-memory-nebula-1.11.12.tgz · 94 文件 · 3,354,522 字节 · sha256 59abf5e9…（包内记录的是上一刀的数字）。
1.11.11 实测：体检 5,321ms → **3,159 / 3,229 / 3,474ms（中位 3,229ms，−39%）**。
`sig` 段（挑最稀有的 24 词，1.11.10 占 3.3 秒）改成 24 个位置的有界插入 → 775–867ms；
`df` 改「词 → 内部编号 + Int32Array」→ 973 → 227–250ms；stale 倒排先按 `updatedAt` 排序再建表。
`/overview` 5 万条 4,240–4,495ms → **3,326ms / 89KB**；`/share?limit=50000` 7,782 → **4,428ms / 38.42MB**；
冷 `/share 20000` 1,940ms、ping max 233ms、慢过 500ms 的 0。等价性：52,049 条 / 82,639 词 /
3,672,659 词次上签名**不一致 0**，`counts` 一字不变（dup 400,869 / stale 41,631）。
`dev/verify-20k.mjs` 5 万条库 **22/22**、**191 单测**。
1.11.11 产物：`dsh-memory-nebula-1.11.11.tgz` · 93 文件 · 3,345,876 字节 · sha256 `9acd9592…`（包内记录的是上一刀的数字）。
1.11.10 实测：axe 审 5 万条库的八个状态（首屏 / 全图 / 体检看板 / 三维 / 搜索结果 / 详情 / 证据链 / 命令面板），
修掉两条 `scrollable-region-focusable`（`#hits`、`#boards-body`），九个滚动容器补 `tabindex="0"` + `role="region"`；
8/8 状态 **0 违例**、Tab 序列 **5/5**、离线快照 0 违例（passes 40）、**189 单测**。
1.11.9 实测：第一次在真 GPU 上量三维（`WEBGL_debug_renderer_info` 报 NVIDIA D3D11）。
5 万条 → 18,000 光点冷布局：收敛期中位帧间隔 **230ms → 6.1ms**、p90 18.2ms、
慢帧 13 → **8–10**（全在开头）、收敛 3s → **约 2.4s**、稳态 `drawMs 2.7–3.1ms`；
瓶颈不在显卡（GPU 与 SwiftShader 帧数几乎一致），
CPU profile 里力场占 44.8%。20k 库：中位 6.1ms、p90 12.2、收敛 2.0s。**189 单测**、
`dev/verify-20k.mjs` 5 万条库 **22/22**。
产物：`dsh-memory-nebula-1.11.9.tgz` · 93 文件 · 3,336,904 字节 ·
sha256 `47d300cd939387801e5a10108221dca96c5dd52d89f1db3d8095d470d01bbbc2`
（包内记录的是上一刀的数字）。
1.11.8 实测：5 万条库在浏览器里一页页点到头。`dev/verify-page2.mjs` **9/9**；
首屏可交互 553–980ms / 第一帧 23ms；点一次「继续加载」冷 1,323ms、热 212–253ms
（布局 + 首帧只占 25–35ms）；五页全点完 287/361/421/450ms，全图 52,061 节点 / 157MB 堆，
方向键中位 34ms（预算 120ms）；**189 单测**。
产物：`dsh-memory-nebula-1.11.8.tgz` · 93 文件 · 3,329,161 字节 ·
sha256 `9781428057824843fa05538151f72f1084d1b8553b38f550ae26fc8e7552f70e`
（包内记录的是上一刀的数字）。
1.11.7 实测：建图逐片计时定位「最慢的一片」。5 万条库上最慢一片 **322ms → 76ms**
（来源节点对 52,049 条正文跑正则、中间不让路）；进程内最长静默 **324 → 121ms**；
真机 `/refresh` ping 最长 **792/841 → 186/173ms**，慢过 500ms 的 **10/284、7/301 → 0**。
`dev/verify-20k.mjs` 50k 模式 22/22、建图期间 `/ping` 最长 57ms、**189 单测**。
产物：`dsh-memory-nebula-1.11.7.tgz` · 93 文件 · 3,326,302 字节 ·
sha256 `d43a44eb340a7c28eea6ca728ec5c5a84412c2ab0449e49807967d31adefc3dc`
（包内记录的是上一刀的数字）。
1.11.6 实测：重复检测两段式（正文分桶 + 稀有词倒排、下标数值键）。5 万条库上旧算法
2,966ms / 400,869 对 → 新算法 **965ms / 400,869 对（漏 0 多 0）**；体检 6.5s → 3,819ms；
`/overview` 6,740ms → **4,240ms / 89KB**；`/share` 冷 3,546ms → **2,206ms**、ping 最长 194ms
且无一慢过 500ms。`dev/verify-20k.mjs` 50k 模式 22/22、**189 单测**。
产物：`dsh-memory-nebula-1.11.6.tgz` · 93 文件 · 3,321,978 字节 ·
sha256 `e0a3d6a285e261af7703eb3778c6fb5bb7f5b266f22cabff9acc3dd0dfcfa318`
（包内记录的是上一刀的数字）。
1.11.5 实测：5 万条库（52,073 节点 / 178,410 边）。`/share` 冷 **10,679ms / ping 最长 7,121ms
→ 3,546ms / 187ms**；`/recall` 冷 1,334ms → **65ms**（总时长 1,807ms，分片代价）；
`/share?limit=50000` 38.42MB 且 `scope.trimmed.shown = 50000`（修前只写 1 万条还自称整图）。
`dev/verify-20k.mjs` 在 5 万条库上 22/22、**186 单测**、`dev/probe-loop-lag.mjs` 为尺子。
产物：`dsh-memory-nebula-1.11.5.tgz` · 93 文件 · 3,317,319 字节 · sha256 `38591c15…`
（包内记录的是上一刀的数字）。
1.11.4 实测：长活分片（生成器 + 同步壳 + 异步壳），建图 / 体检 / 扫描都按时间让出事件循环。
2 万条库上 `refresh` 3,791ms 而最长空档 **59ms**（原来整段 3.6 秒按住）；
体检 3,624ms → 2,961ms / 空档 79ms；异步建图比同步慢约 10%（调度开销）。
真机独立连接：`/refresh` 3,822ms 期间 `/ping` 最长 **37ms**，`/overview` 7ms、`/graph` 96ms / 508KB。
`dev/verify-20k.mjs` 22/22、`dev/probe-blocking.mjs` 判定「还能回声」、**180 单测**。
产物：`dsh-memory-nebula-1.11.4.tgz` · 93 文件 · 3,312,293 字节 · sha256 `4e6b924f…`
（包内记录的是上一刀的数字）。
1.11.3 实测：2 万条真实形状的库（22,073 节点 / 75,227 边）。`/overview` 3.6MB → **83KB**，
体检列表每类 ≤ 40 条而 `counts.stale = 16,243`（新增 `shown` / `totalShown`）；
快照 12.67MB → 8.42MB；`/graph` 默认页 br 0.50MB / 65ms；建图期间并行 `/ping` 最长 55ms。
`dev/verify-20k.mjs` **22/22**、`dev/verify-hygiene-ui.mjs` **9/9**、`dev/verify-budget.mjs`
同一份库全部预算达标、**175 单测**。产物：`dsh-memory-nebula-1.11.3.tgz` · 93 文件 ·
3,304,142 字节 · sha256 `93163e21…`（包内记录的是上一刀的数字）。
1.11.2 实测：筛选命中在后面页里时自动往后翻（最多 3 页）。`dev/verify-filter-page.mjs` **17/17**
（翻一页即停 / 合并后 20 条 / 筛出 10 条 / 最多 3 页、40 条封顶 / 全部加载完回到「重置筛选」）；
`fetchGraph()` 成为取图唯一入口，`loadNextPage()` 同源。**173 单测**、`release-check` 全绿。
产物 `dsh-memory-nebula-1.11.2.tgz`：93 文件 / 3,300,189B /
sha256 `909beaa5cdf1d8bb388c74211cf70577b5781567d0cc382fb571429b0a42e5bb`（包内为上一刀的数字）。
1.11.1 实测：分页没加载完时，筛选空屏提示不再叫人去「重置筛选」。还有下一页 →
「当前已加载 10 / 250 条里没有匹配 · 可能还在后面的页里：点底部「继续加载」，或用搜索直接找」；
全部加载完才回落到「重置筛选」。`dev/verify-filter-page.mjs` **8/8**；
真实库浏览器预算（2,222 条 / 11,128 条连接）：导航→第一帧 **449ms**、第一帧绘制 **1.1ms**、
方向键中位 **0.5ms**、切三维 **129ms**、`/graph` **61ms / 235KB**（br）、JS 堆 **15MB**，
写入 `docs/benchmarks.md` 作为绘制路径的回归门。**173 单测**、`release-check` 全绿。
发布产物 93 文件 / 3,295,207B（sha256 `304a5ea0…`，包内记录的是上一刀的数字）。
1.11.0 实测：快照坏没坏，开之前就知道。载荷进
`<script type="application/json" id="nebula-snapshot-data">`，同页记 `sha256` 与字节数；
打开先对账，一致 toast「校验通过 · sha256 …」，不一致顶部红横幅给出期望/实际摘要，
解析失败直接报「读不出来（文件损坏或没下载完整）」——不再渲染一半白屏。
单测 `test/share-integrity.test.mjs` **5/5**、真机 `dev/verify-snapshot-integrity.mjs` **7/7**
（含数据块内改一字、截断到 12,972 字节两例）、**173 单测**、`release-check` 全绿。
发布产物 93 文件 / 3,291,385B（sha256 `63f395ca…`，包内记录的是上一刀的数字）。
1.10.1 实测：坏库不再假装是空的。适配器先探 `sqlite_master`，读不动就报
「读不动 <库名>：<原因>」；`Nebula.storeErrors` 保留坏来源，`lastError` 不再被无条件清空；
诊断新增 `sourceErrors: N` 与脱敏（路径 → `[路径]`、库名 → `[数据库]`）；doctor 对每个带
`dbPath` 的来源真探一次；来源面板与 toast 点名坏库。`dev/verify-corrupt-ui.mjs` **11/11**、
`test/corrupt-source.test.mjs` **5/5**、**168 单测**、`release-check` 全绿。
1.10.0 实测：三维不再对大库关门。`BALL_LIMIT = 18000`（按重要度 → 度数 → id 取样），
取样外节点与边不打包、不参与受力、不参与拾取，界面写明「只画重要度前 18000 条」；
力导向迭代 320 → 90，边预筛后 50k / 150k 只剩 53,848 条进气。`dev/verify-3d.mjs` **11/11**
（headless Edge + SwiftShader）：5 万条一帧 **47.1–50.8ms**、23 帧中位数 66.8–84.8ms；
1 万条 `sampled:false`、光点正好 10,000。**163 单测**、`release-check` 全绿。
发布产物：93 文件 / 3,278,233B，sha256 `4bc5a571665971be2de39feac09ccf5d0c738328aed1930161245c438ee44fef`
（包内记录的是上一刀的数字）。
1.9.2 实测：分页条无障碍。`dev/verify-1.9-ui.mjs` **17/17**（状态 `role="status"` +
`aria-live="polite"` + `aria-atomic`、按钮 `aria-describedby`、`aria-busy`、`<button>` 可键盘聚焦、
`:focus-visible` 亮边框、末页提示「已经加载全部 N 条」），**axe-core 在分页条可见时零 WCAG A/AA 违例**；
**163 单测**、`release-check` 全绿。
93 文件 / 3,271,647B，sha256 `758d4c74d18dea9c8d181e152eb321952053ae2598d568f82a9cd0dcf820428b`
（包内本文记录的是上一刀的数字，包无法包含自身哈希）。
1.9.1 实测：无行为改动，交付证据。市场端到端 `dev/market-e2e.mjs` **26/26**（dshmarket 1.73.19 的
`check.js` 判兼容性；真实 npm 路径 1.6.4 → 1.9.0 就地升级约 1.3s；升级后 `/ping` 回 1.9.0；
loader 行 id 前后一致）；引擎口径三处一致（宿主 `2.0.22-next`，严格 semver 判不满足，
市场发现 / 市场安装门 / DSH 启动门均带 `includePrerelease: true`）。真实库
`dev/verify-real-library.mjs` **12/12**：2,220 节点 / 11,118 边，建图 552ms，
`/graph` 1.51MB → gzip 0.30MB，快照 2.49MB → `limit=300` 时 0.65MB。**163 单测**。
93 文件 / 3,268,173B，sha256 `b40c7be9ffa81ab587b2a2da8119c7a3da0027ce7d8b7d8f66cd494c963dc4e7`
（包内本文记录的是上一刀的数字，包无法包含自身哈希）。
1.8.0 实测：传输层（br / gzip / deflate 协商、`/graph` 弱 ETag + 304、静态 ETag + 304、HEAD、
超限 413 + `connection: close`）与 `/export` 参数白名单；**137 单测 / 63 项 smoke / 25 项安全探针**，
另有 `dev/verify-1.8.mjs` 字节级复验 **16/16**。压缩实测：`/graph` 24,384B → gzip 5,066B（79.2%）→ br 4,412B（81.9%）；
`app.js` 139,815B → gzip 44,261B（68.3%）；`/share` 420,399B → br 113,285B（73.1%）。
92 文件 / 3,239,424B，sha256 `ee97102dbe80131453dfbcd7937d36e32441cb6a35033f8f2b9d1fb800240508`；装进空目录后 smoke 63 项全过。
1.9.0 实测：大库三层——分页（`/graph?limit=&offset=&sig=`、默认首屏 10,000 条、409 重载）、
视口裁剪与边 LOD（`lib/web/render.js` 网格 + 簇间聚合线）、快照分片（`/share?limit=` 默认 20,000、上限 50,000）。
**163 单测 / 63 项 smoke / 25 项安全探针**；四个真机探针：分页数据 16/16、分页 UI 12/12、
视口裁剪 11/11、快照分片 15/15。5 万条实测：建图 197,569 边 / 0 孤岛（改前 280 边 / 99.1% 孤岛）、
整图 22.30MB → 首屏 4.26MB（−80.9%）、一帧 477.8ms → 11.5ms、单文件快照 43.8MB → 16.6MB。
93 文件 / 3,264,889B，sha256 `da4e2176afdec26b4e0ae102a46858e3dde69a535674ab282b81ad917e5f238f`
（包内本文记录的是上一刀 sha，包无法包含自身哈希）；
装进空目录后起 demo 服务，`scripts/smoke.mjs` 全过。
1.5.2 实测：只改 README 与精选目录入口，无代码变更；81 文件 / 2,922,704B，精确字节以 `npm pack` 输出为准。
清单里应含 `sidecar.ps1`、`scripts/`、`test/` 不含（单测只在仓库里跑）、`dev/` 与截图不含。

装进 DSH profile（与 `docs/operations.md` 的 junction 方式二选一）：

```powershell
# 方式 A：本地目录（开发）
New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-memory-nebula" -Target "<plugin>"

# 方式 B：tarball
npm install <path>\dsh-memory-nebula-1.11.49.tgz --prefix <profile>
```

然后确认 profile `package.json` 里：

- `dependencies` 有 `"dsh-memory-nebula"`；
- `dsh.profile.bundles` 有 `"dsh-memory-nebula"`（只加 dependencies 不会触发重组）。

重启 DSH 后打开侧栏「记忆星图」。`GET /api/memory-nebula/ping` 的 `version` 应与包版本一致。

### 不重启的过渡

宿主进程里可能还跑着装进来那一刻的旧模块。页面会自动比较宿主与独立引擎的 `build`，选较新的一条；
宿主缺 `sources/bridge/ledger/ingest` 时顶部会显示横幅。两种处理：

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File sidecar.ps1 start
# 其它系统（默认扫当前目录；需要额外目录就加 --root）
node lib/standalone.mjs --port 7890
```

横幅会提示「刷新本页就会自动切到独立引擎」。

## 五、回滚

1. `npm install <上一个版本的 tgz>` 或把 junction 指回旧目录；
2. 删 `$DSH_HOME/memory-nebula/nebula.db`（缓存格式若变过，旧代码读新缓存会重建，不会崩）；
3. 重启 DSH。

星图从不写别人的记忆库，回滚不会丢原始数据；丢的只有屏蔽/手工连线这类元数据（在 `nebula.db` 里）。

## 六、发布说明模板

```markdown
## <version> — <date>

一句话：这一版解决什么。

### 安全        （有则写，没有删掉本节）
### 新增 / 变更
### 修复
### 性能
### 测试        （单测/冒烟/安全探针数量）
### 已知限制
```

`CHANGELOG.md` 的 0.4.0 小节可作为样例。

## 七、已知限制（发布时如实写）

- 宿主模块（`index.js` / `http.js` / `live.js`）首次加载后不能热替换，改这三者要重启 DSH；
  其余 `lib/host/**` 由 `LiveEngine` 热载。前端 `lib/web/*` 每次请求从磁盘读，刷新即生效。
- 独立引擎是独立进程，`import` 一次就固定；改引擎文件后要重启它，否则会出现「页面挑了新构建、
  跑的却是旧代码」。
- 本机单用户模型，没有鉴权；能读本机文件的进程本来就能读记忆库。不要把端口经反向代理暴露出去。
- 会话转写解析（`.jsonl.zstd`）是尽力而为：未知帧类型会跳过，不保证每个会话都能解出。
- 3D 视图依赖 WebGL2；不支持时自动留在 2D，不报错。超过 3,000 条时主动留在 2D，
  手动切 3D 会提示先筛选，避免软件渲染下长时间卡住。
- 界面中英双语（0.9.0 起）：中文是源文，英文查 `lib/web/i18n.js`；首次按浏览器语言，顶栏可切换并记住。
  服务端错误与日志仍以中文为主，属于面向开发者的诊断边界，不是界面漏翻。
- 单文件快照是**时间点副本**：生成后真实库再变它也不会更新，也没有增量合并；包含全部正文，
  真实库较大时文件也大（1800 节点约 2.6MB，因为带全部正文）。快照在 `file://` 下运行，浏览器对本地文件的安全策略
  各不相同，但不依赖网络。
- 示例星系是内置的虚构数据，只用于「先看看长什么样」；它不参与真实统计，也不能写入。
