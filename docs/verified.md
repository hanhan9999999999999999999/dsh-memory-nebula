## 1.11.69（2026-11-17）

探针住在工作区（包的上一级）`dev/` 里，`verify-all` 只在包内 `dev/` 找，六个步骤全红、摘要各自写着「仓库里应当有它」。改成按名字在 `[包内 dev/, 上一层 dev/]` 里找，并在开跑前打印用的是哪一份。

| 场景 | 改前 | 改后 |
|---|---|---|
| `npm run verify:full`（12 步） | 6 通过 / **6 失败** / 0 跳过 · 85.5s | 12 通过 / 0 失败 / 0 跳过 · 234.4s ✔ |
| 有 `dev/`、探针被删 | 失败：「dev/verify-20k.mjs 不见了」 | 失败，并点名找过哪两处 ✔ |
| 装好的副本（没有 `dev/`） | 跳过 | 跳过（文案不变）✔ |
| 默认测试库 | 包内 `.tmp-50k`（这台机器上没有 → 5 万条那几步用错尺子） | 包内没有就用上一层，命中工作区的 `.tmp-50k` ✔ |
| 开跑输出 / `--json` | 只有末尾汇总 | 多两行「探针：…」「测试库：…」；JSON 多 `probes` / `root` ✔ |
| 单测 | 485 | 489（新增 4 项钉住探针解析与测试库位置）✔ |
| 构件门 | 通过 | 通过（1.11.66 那段改钉 `scripts/probes.mjs` 的语义，另加 1.11.69 一段）✔ |

`npm run verify:full` 一次实跑：**12 通过 / 0 失败 / 0 跳过 · 合计 234.4s**。明细：单测 489、构件门、冒烟、安全 26 / 26、畸形参数 34、大库 22 项（7.3s）、翻页（4.8s）、八状态 axe（17.5s）、Tab 序列（7.7s）、读错横幅（2.1s）、重建星图 5 项（40.0s）。

顺带说明一处旧账：1.11.66 那行「`verify:full` 6 通过 / 0 失败 · 113.3s」记的是 `--full` 只跑到 6 步的那个布局，和 12 步的口径不是一回事——这一版起，步数与用了哪份探针都写在输出开头。

产物：97 个文件；字节数与 sha256 见发布页的 SHA256SUMS.txt。

## 1.11.68（2026-11-16）

| 检查 | 结果 |
| --- | --- |
| 单元测试 | 485 / 485 通过（新增 `test/ingest-skips.test.mjs` 4 项） |
| 三条坏数据（字符串 / 42 / null） | 400，文案点名「3 条不是对象」，且不留下空文件 |
| 无标题无正文 / 只有空白 | 400，文案点名「既没有 title 也没有 content」 |
| 同批两条同 uid | `written:1, duplicates:1`，文件里只有 1 行，且是后写的那条 |
| 好坏混着来 | `written:1, skipped:2`，`note` 写清跳过原因 |
| 构件门 | 全部通过（新增「推送里的坏条目要说清」一段） |
产物：96 个文件；字节数与 sha256 见发布页的 SHA256SUMS.txt（不写进包里，避免自指）。

## 1.11.67（2026-11-16）

新加的默认扫描根测试只改了 `USERPROFILE`，在 Linux 上家目录读的是 `HOME`，于是 ubuntu 的 Unit tests 与 Pack 两个作业红。

| 场景 | 改前 | 改后 |
|---|---|---|
| ubuntu 跑 `test/meow-default-roots.test.mjs` | 5 项里「`~/Documents` 也认」失败 | 5 项全过 ✔ |
| windows 跑同一份 | 全过（读的是 `USERPROFILE`） | 全过 ✔ |
| 沙箱还原 | 只还原 `USERPROFILE` | `HOME` 一起还原，原本没有就删 ✔ |
| 单测 | — | 481 项全过 |

产物：96 个文件 / 3,556,333 字节 / sha256 7f83e2ee… / sha1 8f68cb26…（回填后重打，包内记录的是上一刀的数字）。


## 1.11.66（2026-11-16）

自动探测的根目录以前写死了 `D:\document` 与 `C:\Users\Administrator\Documents`，隔离 `DSH_HOME` 之后仍然去扫真实硬盘。

| 场景 | 改前 | 改后 |
|---|---|---|
| 隔离 `DSH_HOME` + `USERPROFILE` 启动，`/sources` 的 meow 探针 | 8 个（含 6 个真实工作区） | 0 个 ✔ |
| 同一隔离环境里 `detect({})` | 真实工作区也进来了 | 只有沙箱里那一个 ✔ |
| 真实 `DSH_HOME`（`D:\dsh-home`） | 9 个 | 9 个 ✔（不变） |
| 想多扫几处 | 只能改代码 | `NEBULA_DEFAULT_ROOTS` 或 `sources.json` 的 `extraRoots` |
| `verify:full` 跑的安全探针 / fuzz | 仓库**外面**那份积灰副本（11 月 11 日 / 14 日） | 包内 `dev/` 今天这份（26 项 / 34 项）✔ |
| 仓库里 `dev/` 在、某个探针被删了 | 记成「跳过」，报告照样绿 | 记成失败：「dev/fuzz-1.8.mjs 不见了（仓库里应当有它）」✔ |
| 单测 | — | 481 项全过（含新增 5 + 1 项） |

`npm run verify:full` 一次实跑：**6 通过 / 0 失败 / 0 跳过 · 合计 113.3s**（单测 481 / 构件门 / 冒烟 / 安全 26 / 畸形参数 34）。

产物：96 个文件 / 3,554,369 字节 / sha256 5fd1af6e… / sha1 9b78cbdb…（回填后重打，包内记录的是上一刀的数字）。

## 1.11.65（2026-11-16）

图例与导出报告里的「按类型」条数，以前会和总边数对不上（屏蔽一条边之后多一条、撤销屏蔽之后少一条）。

| 场景 | 改前 | 改后 |
|---|---|---|
| 建图后 | 15 / 15 ✔ | 15 / 15 ✔ |
| 屏蔽一条边 | 14 / **15** | 14 / 14 ✔ |
| 撤销屏蔽 | 15 / **14** | 15 / 15 ✔ |
| 读盘恢复按屏蔽摘边 | 已对齐 / **旧值** | 两边都对齐 ✔ |
| 单测 | — | 475 项全过（含新增 5 项） |

产物：第一刀：96 个文件 / 3,546,878 字节 / sha256 afa37ce75f620002448f31812609fe0542c27a29e7db6ef402d03e584c9c2cb2（回填后重打，包内记录的是上一刀的数字）。

## 1.11.64（2026-11-16）

| 项 | 结果 |
| --- | --- |
| `nebula.link` / `nebula.mute` 自己配自己 | 抛 400，库里不留记录 |
| `POST /link` a = b | 400「不能把一条记忆和它自己配成一对」 |
| `GET /path?...&maxHops=1`（链 0 → 链 3 要三跳） | 200，`found: false` |
| `GET /path?...&maxHops=8` | 200，`found: true`、`hops: 3` |
| `GET /path?...&hops=8`（老名字） | 200，`found: true` |
| `GET /path?...&maxHops=abc` | 400「maxHops 需要 1–8 的整数」 |
| `GET /path?...&hops=abc` | 400「hops 需要 1–8 的整数」 |
| 单测 | 470 / 470 |

产物：第一刀：96 个文件 / 3,544,159 字节 / sha256 0f2ec0be90e1dbd5a4eb7f9f62b3b7cff68618e01cd06e4451fadea6168ed77f（回填后重打，包内记录的是上一刀的数字）。

## 1.11.63（2026-11-16）

探针 `dev/probe-param-silent.mjs`（起一台 `--demo` 服务，逐个把参数拼错/写 0）：

| 调用 | 改前 | 改后 |
| --- | --- | --- |
| `/recall?q=…&hops=abc` | 200 hits=12 | 400 `hops 需要 0–3 的整数，收到的是「abc」` |
| `/recall?q=…&hops=0` | 200 hits=12（按 2 跳跑） | 200 hits=6（不扩散） |
| `/recall?limit=0` | 200 hits=12 | 400 `limit 需要 1–50 的整数` |
| `/path?a=…&b=…&hops=abc` | 200（按默认 6 跳） | 400 `hops 需要 1–8 的整数` |
| `/bridge?hops=abc` | 200 items=2 | 400 |
| `/bridge?hops=0` | 200 items=2（按 1 跳） | 200 items=0（只给直接邻居） |
| `/export?hops=abc` | 200 出报告 | 400 `hops 需要 0–5 的整数` |
| `/export?hops=0` | 200（按 2） | 200（按 0） |
| `/graph?limit=abc` | 400（本来就对） | 400（不变） |

单元测试 `test/param-args.test.mjs` 4 项：两个解析器的边界（0 有效、越界/小数/负号/科学计数法全部报错）、
`/recall` 的 400 与「hops=0 没有扩散分」、`/path` `/bridge` `/export` 的 400 与 `min_weight=0` 有效；全量 465 项。

产物：第一刀：96 个文件 / 3,541,682 字节 / sha256 727c83a9fe00f71e51ed41a97b08e0edbb90f990767ebb3f3fa40fd519b43d3a（回填后重打，包内记录的是上一刀的数字）。

## 1.11.62（2026-11-16）

用真实库（`D:/document`，1,888 节点 / 9,479 连接）与临时 `DSH_HOME` 验的：

| 检查 | 结果 |
| --- | --- |
| 建完图立刻删除进程（改前） | 缓存目录空；第二个进程 `rebuilt`，1,084ms |
| 建完图 `await flushCache()`（改后） | 盘上出现 `graph-*.json.br`；第二个进程 `cached`，105ms |
| 同一 home 连跑三次 --export | 1,287ms / 168ms / 162ms，三次 exit 0，输出字节完全一致 |
| 命中缓存那一次的报告 | 带 clusters（团）；以前这里崩在 `.map` 上 |
| `--share` 跑两次 | 两次 exit 0（2,270,723 / 2,242,883 字节，快照带时间戳） |
| `--diagnose --json` 跑两次 | 改前两次都 exit 1（JSON 却是好的）；改后两次 exit 0 |
| 老缓存（没有 clusters 字段） | `graph.clusters = undefined` 时导出报告不崩，团为空数组 |
| 单元测试 | `test/cache-flush.test.mjs` 5 项全过；全量 461 项 |

产物：第一刀：96 个文件 / 3,537,668 字节 / sha256 d7bd9b63280bc990b3b03155de2cdf6bcb48279a470c972c39124c4ad97c933d（回填后重打，包内记录的是上一刀的数字）。

## 1.11.61（2026-11-16）

用真实 meow 库（`D:/document/Remote Connect DSH/.dsh-meow/memory.db`，704,512 B，旁边 `-wal` 4,120,032 B）的副本验的：

| 检验 | 结果 |
| --- | --- |
| 写入连接开着时写一条 fact | 主库 size 不变、mtime 不变（这就是坑） |
| 改前签名 | 与写入前完全相同 → `refresh` 返回 false、`lastRefresh.why = unchanged` |
| 改前节点数 | 535 → 535（新记忆没进图） |
| 改后签名 | 变了（WAL 那一段） |
| 改后 `refresh` | `lastRefresh.why = rebuilt`，535 → 536，新记忆在图里 |
| 关库（checkpoint）后什么都没写 | 签名两次相同、`refresh` 返回 false（空的 `-wal` 不算变化） |
| 单元测试 | `test/wal-signature.test.mjs` 3 项全过 |

产物：第一刀：96 个文件 / 3,533,847 字节 / sha256 e027de8a326724dff0ea87805605d623d738d6699fec9f9e5543b6d9222f8376（回填后重打，包内记录的是上一刀的数字）。

# 记忆星图 · 验证过的事实

> 下面的数字都是**当时实测**的值，记录的是「这个结论被什么证据支撑过」，不是当前规模——记忆每天在长，规模类数字请以 `node scripts/smoke.mjs` 和界面顶栏为准。

## 1.11.60（2026-11-16）

| 项 | 结果 |
| --- | --- |
| 手动连上已有的一对：边升级成 `explicit`，原证据保留 | ✔ `test/curated-link.test.mjs` |
| 取消连线：系统原本那条关系回来，边数不变 | ✔ |
| 取消连线不需要重算（`takeRebuildFlag()` 为假） | ✔ |
| 本来没有这条边：连上多一条、取消少一条 | ✔ |
| 屏蔽优先：屏蔽着的对取消连线也不放回边 | ✔ |
| 撤销屏蔽后那条关联回来，`muteCount` 归零 | ✔ |
| 全量单测 | 453 通过 / 0 失败 |

产物：第一刀：96 个文件 / 3,531,143 字节 / sha256 3c47e21278b0198031ad045d0aba7388a7b191fd8d37fbc758febebcf336641a（回填后重打，包内记录的是上一刀的数字）。

## 1.11.59（2026-11-16）

| 项 | 结果 |
| --- | --- |
| 屏蔽后重启：那条边不再出现 | ✔ `test/mute-restore.test.mjs` |
| 屏蔽后重启：`muteCount` 与库里一致 | ✔ |
| 撤销屏蔽：说清「需要重算」，重算后边回来 | ✔ |
| 屏蔽一对本来就没有边的记忆：不崩、不多摘 | ✔ |
| 摘边之后 `stats.edges` 与真实条数一致 | ✔ |
| 同一进程里屏蔽：计数立刻变 | ✔ |
| 全量单测 | 449 通过 / 0 失败 |

产物：第一刀：96 个文件 / 3,528,461 字节 / sha256 c2af9d0c13bbc104c8dba0863227ba49c3faadf51373f7e2f778f9ca2f4b2978（回填后重打，包内记录的是上一刀的数字）。

## 1.11.58（2026-11-16）

| 项 | 结果 |
| --- | --- |
| 共激活在两次会话后成立 | ✔ `test/hebbian.test.mjs` |
| 只出现一次不算证据（哪怕一次点亮 42 条） | ✔ |
| 会话越大权重越低，但不归零 | ✔ |
| 账本只认活动键（`projectsQueried` 不算） | ✔ |
| 文本证据与共激活并存时，理由两句都在 | ✔ |
| 真实库共激活边 | 211 → 899（提到共激活 1,084 条） |
| 真实库会话账本 | 284 → 223 行，落空 id 95 → 5 |
| 全量单测 | 445 通过 / 0 失败 |
| demo 体检「只靠弱边」仍成立 | ✔（上限 0.44 < `STRONG_W` 0.45） |

产物：第一刀：96 个文件 / 3,525,663 字节 / sha256 d12bea6d2125bd519d9833b3186bf7fddfb6e6a6fa4da375b4f9503d0deb24ec（回填后重打，包内记录的是上一刀的数字）。

## 1.11.57（2026-11-16）

测试等的是条件，不是毫秒（全量 440 项）：

| 断言 | 证据 |
| --- | --- |
| 忙机器上不再假红 | `dev/probe-flaky-wait.mjs`：同样四条满核忙循环，老写法红、新写法绿 |
| 等不到会说清等的是什么 | `waitFor` 超时抛「等不到「词频表预热完成」：20000ms 内条件一直不成立」 |
| 端口不再抽奖 | `test/sidecar-script.test.mjs` 用 `freePortPair()` 现取一对「前缀关系」的空闲端口 |
| 工具文件不冒充测试 | `testkit/wait.mjs` 在 `test/` 之外，`node --test` 不会把它算成一条用例 |
| CI 自己说出失败用例 | `.github/workflows/ci.yml` 的 `Report failing tests` 把 `not ok` 写进摘要与注解 |

产物：第一刀：96 个文件 / 3,521,671 字节 / sha256 3b2647a42ec546d8fae1607ef78d641c31f2aab6316d3b338071802027d904fd（回填后重打，包内记录的是上一刀的数字）。

## 1.11.56（2026-11-16）

截断不劈字（`test/text-cut.test.mjs` 9 项，全量 437）：

| 场景 | 实测 |
| --- | --- |
| `cut` 短于上限 | 原样返回，不改写空白 |
| 切点落在代理对中间 | 少吃一个，返回 `A` 而不是 `A` + 半个 🌊 |
| ZWJ 连字 👨‍👩‍👧 | 0–9 任何切点都没有半个字符，也不以 ZWJ 收尾 |
| 变体选择符 ❤️ / 肤色修饰符 👋🏽 | 不以零件收尾；够长时整颗保留 |
| 数据自身带半个字符 | `A\ud83cB` → `AB` |
| 上限 0 / 负数 / NaN / null | 空串，不抛异常 |
| `clip` 写进 UTF-8 | 不再出现 `U+FFFD`（替换符） |
| 整条链路（ingest → 建图 → detail.preview） | 尾部 `AAA…`，无半个字符 |

代价：`clip` 5 万条 243ms → 330ms（`\s+` 归一化本身占 240ms，守卫只多 87ms）。

附带两处（都是本轮验收时抓到的）：

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 空库上跑 `scripts/smoke.mjs` | `TypeError ... reading 'id'`，退出码 `0xC0000409` | 明说「规模相关的检查跳过」，退出码 1（有真失败时）或 0 |
| `GET /sources` 的 live | stores=0 / nodes=0 / errors=1（`scanAll is not defined`） | stores=1 / nodes=2 / errors=0 |
| 还没建过图就调 `sourcesReport()` | `live.stores` 为空（面板只会说「0 个来源」） | 先算一次指纹，直接列出接了的来源（`test/sources-report.test.mjs` 3 项） |

产物：第一刀：96 个文件 / 3,518,680 字节 / sha256 6d7c935bd76b49fdee8d74ef91a5832475406caa75731c1d755b7ed1fe765c99（回填后重打，包内记录的是上一刀的数字）。

## 1.11.55（2026-11-16）

`lib/host/store.js` 的自愈路径（`test/store-recovery.test.mjs` 6 项）：

| 场景 | 断言 |
| --- | --- |
| 好库 | `storeRecovery() === null`，连边写读正常 |
| 文件不是 sqlite | 挪到 `nebula.db.broken-*`（文件确实存在）、原路径有新库、连边与屏蔽都能写读 |
| 同一进程再开一次 | 复用同一个句柄，不重复挪、不重复报 |
| 库路径是个目录 | 照样自愈并可用 |
| `closeStore()` | `recovery` 归零，不污染下一个 `DSH_HOME` |
| 坏库 + 正常工作区 | `refresh()` 不抛，记忆进图；概览 `warnings` 含 `store-recovered` |

全量单测 428 通过 / 0 失败；产物：第一刀：96 个文件 / 3,512,983 字节 / sha256 3546bbbd166510c7ec096c372064e8eccdfd4d53fb7ad127bf19298be247a06e（回填后重打，包内记录的是上一刀的数字）。

## 1.11.54（2026-11-16）

Node 下界只有一个来源（`lib/host/doctor.js`，读 `package.json` 的 `engines.node`）：

| 断言 | 结果 |
| --- | --- |
| `MIN_NODE` 等于 `engines.node` 里那个版本 | ✔（现为 `24.0.0`） |
| 下界自己那一版判 `ok` | ✔ |
| 下界低一个补丁判 `fail` | ✔ |
| 低一个小版本判 `fail` | ✔ |
| `checkRuntime('20.0.0')` 的提示里出现真实下界 | ✔ |

四处文档同时收口：`docs/release.md` 支持面、`docs/troubleshooting.md`、`CONTRIBUTING.md`、
`docs/compatibility.md` 都改成 24（改前全停在 22.13）。

sources.json 写坏时（概览告示）：

| 断言 | 结果 |
| --- | --- |
| 坏配置 → 概览里出现 `config-unreadable` | ✔ |
| 告示里写出是 `sources.json` 与后果（来源没有接入） | ✔ |
| 配置正常时不出现这条告示 | ✔ |

发现层契约（`test/adapters-index.test.mjs`，6 项）：

| 断言 | 结果 |
| --- | --- |
| 配置：没有文件 / 正常 / 字段类型错 / 顶层不是对象 / 坏 JSON / 带 BOM | ✔ |
| 发现层：两个内置可禁用、重复 root 不重复产出、未知适配器报错、空目录留一句、`enabled:false` 跳过 | ✔ |
| 扫描层：`scanSteps` 与 `scan` 都在、账本两种形状、`storeId` 补全、不能扫描 / 返回 error / 抛异常三种失败 | ✔ |
| 截断：上限取自 `store.maxFiles` 或 `res.maxFiles`，消息里的数字跟着变 | ✔ |
| 同步与异步扫描结果一致；空输入给空结果 | ✔ |
| 体检：未知适配器说明、已知适配器真被问 | ✔ |

覆盖率：`lib/host/adapters/index.js` **81.23% 行 / 46.30% 分支 → 96.06% / 80.85%**；
全量 **422/422**。

产物：第一刀：96 个文件 / 3,507,874 字节 / sha256 f0aeaff23054623c3a795614b066ad8d64bb0e71571887c3b38470328057b3d5（回填后重打，包内记录的是上一刀的数字）。

## 1.11.53（2026-11-16）

工具层契约（`test/tools.test.mjs`，14 项）：

| 断言 | 结果 |
| --- | --- |
| 九个工具都注册且 `output.schema.type === 'string'` | ✔ |
| recall：无参数说清要什么 / 有结果报条数与扫描量 / 无结果一句话 | ✔ |
| link：id 不存在时回「nebula_link 没做成：…」而不是抛异常 | ✔ |
| path / stats / hygiene / bridge / sources / ingest / systemPrompt | ✔ |

覆盖率与规模：

| 项 | 改前 | 改后 |
| --- | --- | --- |
| `lib/index.js` 行 / 分支 | 81.23% / 46.30% | **87.44% / 61.84%** |
| 单测 | 402 | **416** |
| 全部文件（行） | 90.04% | 91.05% |

产物：第一刀：96 个文件 / 3,503,469 字节 / sha256 41391e34fd17eaaed4925e917aab63bdc8f9f1947fa43e5da1ae916590877977（回填后重打，包内记录的是上一刀的数字）。

## 1.11.52（2026-11-15）

主题：**写错一个键，注入就悄悄关了**。

### 单测

| 项 | 结果 |
| --- | --- |
| 全量 `node --test` | **402 通过 / 0 失败**（392 + 10） |
| `test/injectcfg.test.mjs` | 10 通过 |
| `scripts/release-check.mjs` | 全部通过 |

### 配置行为

| 写进 inject.json | 改前 | 改后 |
| --- | --- | --- |
| `{"maxRounds": null}` | 每轮都不注入，无提示 | 用默认值 2，日志记一条 |
| `{"maxRounds": "two"}` | 每轮都注入，无提示 | 用默认值 2，日志记一条 |
| `{"hops": 99}` | 传到注入桥，靠桥自己夹到 3 | 这里就夹到 3，并记一条 |
| `{"maxIitems": 9}` | 静默忽略 | 忽略 + 记「不认识的键」 |
| `{ "maxItems": 4, }`（坏 JSON） | 静默用默认值 | 默认值 + JSON 错误原因 |

产物：第一刀：96 个文件 / 3,500,949 字节 / sha256 d0c0f69d564b52ecf619efa29c64811b62e6381301efd71459628a76fa8faca6（回填后重打，包内记录的是上一刀的数字）。

## 1.11.51（2026-11-15）

主题：**停 6341，别把 63411 一起停了**。

### 单测

| 项 | 结果 |
| --- | --- |
| 全量 `node --test` | **392 通过 / 0 失败**（386 + 6） |
| `test/sidecar-script.test.mjs` | 6 通过（真起进程，Windows 专有，其它平台跳过） |
| `scripts/release-check.mjs` | 全部通过 |

### sidecar.ps1 行为

| 场景 | 结果 |
| --- | --- |
| `status -Port 63411`（空闲） | 未运行（端口 63411；页面会退回宿主自带的接口） |
| `start -Port 63411` | 已启动 · 端口 63411 · 记忆 2071 条 / 连接 10543 条 · v1.11.51 |
| `stop -Port 6341`（63411 的前缀） | 端口 6341 上没有独立引擎，63411 仍在跑 |
| `stop -Port 63411` | 已停止 pid … |
| 找不到 node | 提示里的版本 = `engines.node` 的值 |

产物：第一刀：95 个文件 / 3,496,495 字节 / sha256 8ce6a4c1616d296ec47f0980f7de6650530c8b6fa142f82a058b796c7904828f（回填后重打，包内记录的是上一刀的数字）。

## 1.11.50（2026-11-15）

| 项 | 结果 |
| --- | --- |
| 门禁（带 dev/） | 全部通过 |
| 门禁（`NEBULA_NO_DEV=1`） | 全部通过 |
| 干净克隆（163 文件、无 dev/） | `check ✔ · test ✔` · 17.4s |
| 单测 | **386/386** |

产物：第一刀：95 个文件 / 3,493,194 字节 / sha256 e2ab4fafa3cf0108a956212891532a588d67d1cc8482c01534b0f9f291454277（回填后重打，包内记录的是上一刀的数字）。

## 1.11.49（2026-11-15）

| 项 | 结果 |
| --- | --- |
| 门禁（带 dev/） | 全部通过 |
| 门禁（`NEBULA_NO_DEV=1`） | 全部通过 |
| 干净克隆（163 文件、无 dev/、无 node_modules） | `check ✔ · test ✔` · 16.0s |
| 单测 | **386/386** |

产物：第一刀：95 个文件 / 3,491,720 字节 / sha256 9f59ed5b1d34206bdc870cdf424256bf520a09881b651bd62f4e415811da03f6（回填后重打，包内记录的是上一刀的数字）。

## 1.11.48（2026-11-15）

| 项 | 结果 |
| --- | --- |
| `npm run verify:full` | **12 通过 / 0 失败 / 0 跳过 · 169.1s** |
| 大库验收 | 22 项全过（检索 1.3s 级，不再是 5,251ms） |
| 每步一个家 | `dev/probe-step-home.mjs` 通过：默认那套长出 5 个 `step-NN-…`，第 1 步没有图缓存 |
| 单测 | 386/386（本轮只动验收脚本与探针，不新增产品代码） |

产物：dsh-memory-nebula-1.11.48.tgz · 95 个文件 · 3490091 字节 · sha256 b0032b1aec162900d918a387ac1002a4459231e5f74b95a529441afab44b317e（包内记录的是上一刀的数字）。

## 1.11.47（2026-11-15）

| 项 | 结果 |
| --- | --- |
| 单测 | **386/386**（新增 `test/cache-v8.test.mjs` 4 项） |
| 缓存 | v4：20 万条 15,472,713 B（JSON 版 17,328,867 B）；读盘 3,683ms vs 4,118ms |
| 真机重启 | `/ping` 4,117ms、第一张图 253ms（1.11.34 记 5,238ms） |
| 兼容 | v2/v3 的 JSON 缓存仍读得出（`parseCacheBytes` 回退），坏文件照旧清掉 |
| 语义修正 | 读盘命中时 `buildMs = 0`，另给 `cacheAgeMs` |

产物：dsh-memory-nebula-1.11.47.tgz · 95 个文件 · 3487692 字节 · sha256 e89c0482dfbbad43c6f9ad7500f83bc39f59d592eefd5b713f84dbdaf23c0a89（包内记录的是上一刀的数字）。

## 1.11.46（2026-11-15）

| 项 | 结果 |
| --- | --- |
| 单测 | **382/382**（新增 `test/overview-hygiene-lazy.test.mjs` 4 项） |
| 接口 | `GET /overview` 20 万条 12,940ms → **111ms**；`GET /hygiene` 9,579ms，第二次 6ms |
| 浏览器 | `dev/verify-hygiene-lazy.mjs` **9/9**：概览 28ms、看板先「正在算」、算完自己填上 |
| 兼容 | `overview({ hygiene: false })`、`overviewAsync()`、`?hygiene=1` 三条老路照旧 |

产物：dsh-memory-nebula-1.11.46.tgz · 95 个文件 · 3483361 字节 · sha256 384d37c0cd3c409471232e17805faff7a546adb123f95bfcbf01b2924b120d3a（包内记录的是上一刀的数字）。

## 1.11.45（2026-11-15）

### CLI 入口的契约

`test/cli.test.mjs` 真 spawn `lib/standalone.mjs`，17 项全过（每条都在临时目录 + 独立 `DSH_HOME` 里跑）：

| 覆盖的东西 | 断言的是 |
|---|---|
| `--version` / `-v` | 打印的版本与 `package.json` 一致，退出码 0 |
| `--help` / `-h` | 帮助里列出 `--port` `--root` `--export` `--share` `--diagnose` `--demo` `--token` |
| 参数缺值 / 端口非数字 / 短口令 | 说清是哪一项、退出码 2 |
| 端口被占用 | 退出码 1、提示「端口 N 已被占用」，且在建图之前就报（< 20s） |
| `--export` | JSON 可被 `JSON.parse` 且带 `stats.nodes`；`report.md` 非空；`--format xml` 退出 2 |
| `--share` | 产出 `<!doctype html>`、> 50KB 的自包含快照；范围写错退出 2 并说明原因 |
| `--diagnose --json` | 输出可解析、带 `runtime.node`，不启动端口 |
| 服务运行中 | `/ping` 报出版本与 capabilities；`/app` 回 200 HTML；`--log` 里有一行 `standalone on …` |
| 安全面 | 本机 Origin 的 `OPTIONS` 回 204，外来 Origin 回 403；外来 Origin 的 POST 403 |
| `--token` | 不带口令读 `/ping` 回 401 且提示「需要本机口令」，带 `?token=` 回 200 并下发 `nb_token` cookie |
| 畸形请求 | 40KB 的 URL 回 **431** 与「请求头或 URL 太长」，不是连接错误 |
| 日志坏掉 | `--log` 指到目录时退回控制台，并只吵一次 |

### hops 解析的一致性

`test/share-hops.test.mjs` 4 项：不传/留空 → 2；`1`–`5` 原样；`0` `-1` `6` `9` `2.5` `abc` `2跳` `Infinity` `1e3` `NaN`
全部 `status === 400` 且消息含「hops 需要 1–5 的整数」；`" 3 "` 与 `"02"` 合法。

端到端：`--export --hops 9` 与 `--share --hops abc` 都退出 2，消息「hops 需要 1–5 的整数」（以前是静默按 5 / 按 2）。

产物：dsh-memory-nebula-1.11.45.tgz · 95 个文件 · 3479007 字节 · sha256 06893f42afc67fcbcada34dea7f76d24740f26a6a5bb657c821c0d86ba768cd6（包内记录的是上一刀的数字）。

## 1.11.44（2026-11-15）

CI 的 `verify` 作业从「只跑 ubuntu」改成 `ubuntu-latest` + `windows-latest` 两个系统。

| 项 | 改前 | 改后 |
|---|---|---|
| `verify` 作业的系统 | ubuntu-latest | **ubuntu-latest + windows-latest** |
| 作业名 | `Node 24` | `Node 24 on ubuntu-latest` / `Node 24 on windows-latest` |
| 本机模拟（autocrlf 克隆） | — | **check 通过 · 357/357** |

产物：dsh-memory-nebula-1.11.44.tgz · 95 个文件 · 3474236 字节 · sha256 b5b7d1b825099750e3864e39333ab19ddc4ff605363d9e02e223fd87389371c8（包内记录的是上一刀的数字）。
## 1.11.43（2026-11-15）

Node 22 上 `node:sqlite` 实验实现会让测试进程直接崩（`exitCode 3221225477` = `0xC0000005`）。下限提到 24。

| 项 | 改前 | 改后 |
|---|---|---|
| `engines.node` | >=22.15.0 | **>=24.0.0** |
| CI 矩阵 | `['22.15.0', '24']` | **`['24']`** |
| 22.15 上跑单测 | 进程崩（scan-steps / recall 两处） | 不再承诺支持 |
| 24 上跑单测 | 357/357 | **357/357** |

复现：`npx -y node@22.15.0 --test test/scan-steps.test.mjs`。

产物：dsh-memory-nebula-1.11.43.tgz · 95 个文件 · 3472689 字节 · sha256 312d3cc38c93010bdbedf852e33eb207ef0a687d375f328fe6d81f0cd16fd0c7（包内记录的是上一刀的数字）。
## 1.11.42（2026-11-15）

打标签即建 Release：`.github/workflows/release.yml` → `npm pack` → `SHA256SUMS.txt` → `gh release create --verify-tag`。

- 之前：Releases 停在 `v1.6.4`，1.11.x 没有可下的包。
- 现在：`v*` 标签推送后自动出现 Release，附件为 tgz 与校验和。

产物：dsh-memory-nebula-1.11.42.tgz · 95 个文件 · 3471277 字节 · sha256 fe044825dc7b30001c8c7be48177a56fefba2a9f99b8e26698d195bf9018fa62（包内记录的是上一刀的数字）。
## 1.11.41（2026-11-15）

CI 红了 1.11.39 / 1.11.40 两版，这一版修根因。

| 项 | 改前 | 改后 |
|---|---|---|
| 干净克隆（158 个跟踪文件、无 dev/）里的 `release-check` | 红 | **通过** |
| 干净克隆里的单测 | 22.13 崩 | **357/357 · 16.8s** |
| `engines.node` | >=22.13.0 | **>=22.15.0** |
| `npm test` | `node --test "test/*.test.mjs"` | **`node --test`** |
| CI | 三作业红 | 待复核 |

探针：`node dev/sim-clean-clone.mjs`（把 CI 的环境搬到本机）、`node scripts/release-check.mjs`。

产物：dsh-memory-nebula-1.11.41.tgz · 95 个文件 · 3469995 字节 · sha256 b9f33652a53ae8a0ce0837748cab4476ee02c84741e17f1a2352526ecc3718f1（包内记录的是上一刀的数字）。
## 1.11.40（2026-11-15）

被文件数上限截断的来源，现在会说出来。

| 项 | 改前 | 改后 |
|---|---|---|
| 上限 5 / 20 个文件的笔记来源 | 5 个节点、无提示 | 5 个节点 + 一条告示 |
| `graph.sources[].truncated` | 没有这个字段 | true / false |
| `overview().warnings` | 只有 `large-library` | 多一条 `source-truncated` |
| `adapters/util.js` 行 / 函数覆盖 | 47.56% / — | **95.24% / 95.83%** |
| 全部文件 行覆盖 | 89.46% | **89.95%** |
| 单测 | 340 | **357** |

探针：`node dev/probe-notes-cap.mjs`（截断与签名不变）、`node dev/probe-truncation-warning.mjs`（适配器 → 汇总 → overview 整条链）。

产物：dsh-memory-nebula-1.11.40.tgz · 95 个文件 · 3466420 字节 · sha256 62d3d1cbd0ef19dee7053ba683cb5d790a2994cf3277d8c8437c5af7b6468b88（包内记录的是上一刀的数字）。
## 1.11.39（2026-11-15）

发现层补测，删掉一份会误导人的重复实现，修掉 MCP 嗅探串条目。

| 项 | 改前 | 改后 |
|---|---|---|
| `sources.js` 行 / 函数覆盖 | 54.04% / 61.54% | **93.66% / 92.86%** |
| 全部文件 行覆盖 | 88.26% | **89.46%** |
| 单测 | 326 | **340** |
| 普通插件被误列成 MCP | 会 | 不会 |

产物：dsh-memory-nebula-1.11.39.tgz · 95 个文件 · 3462769 字节 · sha256 dcd781daf372c20bd416af85b770109f63ca002691d686595c4a0801c5f81949（包内记录的是上一刀的数字）。
## 1.11.38（2026-11-15）

外部推送不再长重影。

| 项 | 改前 | 改后 |
|---|---|---|
| 同样的两条推两次 | 2 → 4 条 | 2 → **2** 条 |
| 两次推送的 node id | 每次不同 | **相同**（内容哈希） |
| 传对象当 items | 抛 TypeError | `{ written: 0, error }` |
| `ingest.js` 行 / 函数覆盖 | 33.51% / — | **97.97% / 100%** |
| 全部文件 行覆盖 | 87.14% | **88.26%** |
| 单测 | 312 | **326** |

探针：`node dev/probe-ingest.mjs`（重复推送前后条数与 id 对比、非数组、BOM 与坏行、字段归一化）。

产物：dsh-memory-nebula-1.11.38.tgz · 95 个文件 · 3460675 字节 · sha256 80ec64fbbe13d4e846020b732b6f0672ef25e453ae6afacf469a659e7c7d938f（包内记录的是上一刀的数字）。
## 1.11.37（2026-11-15）

会话索引不再冻在开机那一刻。

| 项 | 改前 | 改后 |
|---|---|---|
| 新开会话后 `transcriptStats().sessions` | 1 → 1 | 1 → **2** |
| 新会话的 `originOfMemory` | null（永久缓存） | 正常返回那句话 |
| 真机 53 个会话重扫 | 不重扫 | **3–5ms** / 命中 0ms |
| `transcriptStats` 复杂度 | O(n²) | O(n) |
| `transcripts.js` 行 / 函数覆盖 | 25.41% / — | **94.79% / 100%** |
| 全部文件 行覆盖 | 84.72% | **87.14%** |
| 单测 | 293 | **312** |

探针：`node dev/probe-transcript-index.mjs`（TTL=0 时看得见新会话；TTL=30 秒窗口内不重扫）、`node dev/probe-index-cost.mjs`（真机重扫耗时）。

产物：dsh-memory-nebula-1.11.37.tgz · 95 个文件 · 3457776 字节 · sha256 582dc2c57967fd741362034237aa962366d172a0df86b9ef445671ce358c124c（包内记录的是上一刀的数字）。
## 1.11.36（2026-11-15）

注入桥的默认路径修好了，两支没人测过的模块补上了测试。

| 项 | 改前 | 改后 |
|---|---|---|
| `nebula_bridge` 不传 hops | 候选 0 条（永远空回复） | 候选按 1 跳扩散 |
| `budget.hops = NaN` | 0 条 | 1 跳（`num()` 兜底） |
| `bridge.js` 行 / 函数覆盖 | 27.25% / 0% | 95.44% / 100% |
| `ledger.js` 行 / 函数覆盖 | 52.57% / 41.67% | 98.86% / 100% |
| 全部文件 行覆盖 | 81.77% | 84.72% |
| 单测 | 268 | 293 |

探针：`node dev/probe-bridge-hops.mjs` 三种输入（默认 / NaN / 1）现在都给出同样的 2 条候选。

产物：dsh-memory-nebula-1.11.36.tgz · 95 个文件 · 3454456 字节 · sha256 b19c6a85ed35b3a92e0aad438fe78a6073357fb72db3c760cc472f45acb9433c（包内记录的是上一刀的数字）。
## 1.11.35（2026-11-15）

修两个「不报错，只是不给你东西」的洞，并把两支别人家适配器的测试补齐。

### 洞一：没配表名的 SQLite 库读不出任何记忆

| 步骤 | 现象 |
|---|---|
| 只配 `{ adapter: "sqlite", path }`（不写 table / tables） | 来源出现了，图里 0 条 |
| 直接调 `scanAll(stores)` | 该 store 0 条，且 `errors` 里什么都没有 |
| 根因 | `tableMap(db, config)` 把**已打开的库对象**传给了收路径的 `listTables`，抛错被 `catch` 吞掉返回 `[]` |
| 修法 | 拆出 `tablesOf(db)`，路径版 `listTables` 复用它；表名按单复数认层（`facts` → `fact`） |

| 端到端探针（`dev/probe-sqlite-source.mjs`，真起服务 + `sources.json`） | 结果 |
|---|---|
| 图里的节点数 | 5 / 5（夹具 5 条） |
| 层级 | `fact`（表名 `facts` → 单数） |
| `id` 前缀 | `sqlite:…` |
| 概览里的来源与 readErrors | 列得出来 / `[]` |

### 洞二：签名里带中文时 /graph 一个字节都不回

| 复现 | 结果 |
|---|---|
| `sources.json` 里给来源配中文标题 → 签名含中文 | `/graph` 无响应头、6 秒超时 |
| 服务日志 | `TypeError [ERR_INVALID_CHAR]: Invalid character in header content ["etag"]` |
| 修法 | ETag 签名段非 ASCII 就哈希（sha1 前 20 位）＋ `sendBody` 跳过非法头值 |

| 回归测试（`test/http-etag.test.mjs`） | 断言 |
|---|---|
| 中文签名下 `/graph` | 200，etag 纯 ASCII，载荷里 `sig` 仍是原文 |
| 两次同一签名 | etag 相同；`If-None-Match` 命中回 304 |
| 整图 vs 某一页 | etag 不同（不能互相 304） |

### 覆盖率（补测试前 / 后）

| 文件 | 行覆盖 | 函数覆盖 |
|---|---|---|
| `lib/host/adapters/notes.js` | 25.25% → 97.64% | 0% → 100% |
| `lib/host/adapters/sqlite.js` | 28.52% → 93.03% | 0% → 90.48% |
| `lib/host/adapters/util.js` | 47.56% → 77.78% | 42.11% → 72.73% |
| 全部文件 | 77.45% → 81.77% | 73.39% → 77.54% |

单测 **268 项全过**；新增 `test/adapters-notes.test.mjs`（6 项）、`test/adapters-sqlite.test.mjs`（7 项）、`test/http-etag.test.mjs`（3 项）。

产物：dsh-memory-nebula-1.11.35.tgz · 95 个文件 · 3451159 字节 · sha256 5fc32b94e96aafcedce2d1708c3237159edf71f3468a9f245e98dd90c5e0ddc0（包内记录的是上一刀的数字）。

## 1.11.34（2026-11-15）

| 项 | 结果 |
| --- | --- |
| `test/scale-warning.test.mjs` | 3/3（小库不吵人 / 过线说清条数与耗时 / 默认 15 万条且 `/ping` 带 scale） |
| 全量单测 | 252/252 |
| `dev/verify-scale-note.mjs`（headless Edge） | 10/10，含 axe 0 违例、默认门槛下不出现告示 |
| 20 万条实测 | 冷建图 24,450ms · 恢复 5,238ms · 首查 5,832ms · 概览 8,678ms · 整图 106.5MB · 堆约 1.2GB |
| 5 万条回归 | 未受影响（缓存恢复仍 1.03s 量级） |

产物：dsh-memory-nebula-1.11.34.tgz · 95 个文件 · 3445320 字节 · sha256 627553e94934fbf4338ea43308fb214ee9ab85e7a2763af1b3630b3a089e625c（包内记录的是上一刀的数字）

## 1.11.33（2026-11-15）

主题：别人的图，不该端给我。三处修复都在「重启之后先读盘」这条路上。

| 项目 | 结果 |
|---|---|
| 缓存里记来源集合（`sourceSetKey`） | 另一批库的缓存被拒绝，重建一次 |
| 读盘恢复之后坏来源 | 仍出现在 `overview().readErrors` 与横幅里 |
| 第一次检索（预热正在跑，五万条） | 3,495ms → **735ms** |
| 单测 | **249/249**（新增 5 项） |
| `npm run verify:full` | 12 步全绿（顺序跑，DSH_HOME 隔离） |

| 新增 / 修改的测试 | 盯的是 |
|---|---|
| `test/cache-sources.test.mjs`（3） | 指纹与顺序无关；宽松读盘只交同一批来源；换库不认上一份缓存 |
| `test/cache-readerrors.test.mjs`（1） | 读盘命中之后，坏的来源仍在告示里 |
| `test/recall-inflight.test.mjs`（1） | 两处同时要词频表，只算一趟、拿到同一个 promise |

产物：dsh-memory-nebula-1.11.33.tgz · 95 个文件 · 3440893 字节 · sha256 c5f8eaf87f7fdab21d3939bf85eb645155c61765ac10fa8cd94389b314608714（包内记录的是上一刀的数字）

## 1.11.32（2026-11-15）

| 项 | 结果 |
| --- | --- |
| 单测 | 244 通过 / 0 失败（新增 `test/build-progress.test.mjs` 3 项） |
| 浏览器验收 | `dev/verify-build-progress.mjs` 7 通过 / 0 失败（10 万条夹具、独立 DSH_HOME） |
| 服务端阶段 | 建图中 `/progress` 报出 读来源 → 整理节点 → … → 收尾 |
| 遮罩文案 | 「正在建图：整理节点 · 2 / 11 · 3.2s · 100000 条记忆」 |
| 结束后 | `building:false` / `progress:null` / 遮罩收起 |
| 构建期开销 | 每步一次函数调用与一个对象赋值，建图总时长无可测变化 |

产物：dsh-memory-nebula-1.11.32.tgz · 95 个文件 · 3435876 字节 · sha256 31a5d3c409e1d28c8c4e1617675ddd78e503dbbedf55ee30e367bc8c0c3dfbe1


## 1.11.31（2026-11-15）

缓存记着「这份图是谁算的」。验收分三块：单测、真机探针、全量回归。

| 单测 `test/cache-impl.test.mjs` | 断言 |
|---|---|
| 算法指纹 | 同进程两次一致、16 位十六进制 |
| 旧算法缓存（impl 改过） | `loadGraphCache` 返回 null；`loadNewestGraphCache` 仍能拿到 |
| 升级后第一次启动 | `why=stale-cache`、`implStale=true`、`builtAt` 是旧的、用时 <4s |
| 后台重建完成 | `staleGraph=false`、`why=rebuilt`、新缓存被严格命中 |

| 真机探针 `dev/probe-impl-upgrade.mjs`（5 万条） | 读数 |
|---|---|
| 建图并写盘 | 6,735ms / 1 份缓存 |
| 把缓存标成旧算法后重启 | 第一张图 2,494ms，`stale` + `refreshing` |
| 后台重建 | 7,016ms 换掉（builtAt 变） |
| 新缓存落盘 | 5,168ms，盘上不再有旧指纹 |
| 第三次启动 | 1,891ms，直接命中，不再重建 |

全量：**241/241** 单测通过（新增 3 项）；`node scripts/release-check.mjs` 全绿。

产物：dsh-memory-nebula-1.11.31.tgz · 95 个文件 · 3430228 字节 · sha256 e245d46d762f80dd274d64c516800308f034478700789e0fee2c0164dd0352e5

## 1.11.30（2026-11-15）

读盘恢复拆开（五万条库）：读文件 1ms · brotli 解压 172ms · JSON.parse 495ms · 合计 896ms。

| 场景 | 第一张图 | 说明 |
| --- | --- | --- |
| 冷启动（无缓存） | 6,155ms | 只能等建完 |
| 重启，签名对得上 | 1,043ms | 1.11.28 的读盘恢复 |
| 重启，签名对不上 | 1,043ms | 1.11.30：先给旧图（stale:true），后台 6.1–6.4s 换新 |

验收：单测 **238/238**（新增 `test/bg-refresh.test.mjs` 6 项）；`dev/verify-bg-refresh.mjs` **9/9**；
`dev/probe-stale-start.mjs` 通过（第一张图 261ms、stale=true、后台换成新图）；
`dev/probe-cache-restore.mjs` / `dev/probe-cache-format.mjs` / `dev/probe-cache-lazy.mjs` 记录上面三张表。

产物：dsh-memory-nebula-1.11.30.tgz · 95 个文件 · 3427050 字节 · sha256 cb8bbeba4c0ba93dbcd37dbea3eb57b8f6b6d7c25596e46bc4003dc76ad79b89

## 1.11.29（2026-11-15）

五万条库（52,073 节点 / 171,309 条关联），独立 DSH_HOME，图已就绪之后点开体检看板：

| 场景 | `GET /overview` |
| --- | --- |
| 后台预热过（等 6 秒再点） | **91ms** |
| 关掉预热（NEBULA_HYGIENE_WARM=0） | 2,057ms |
| 图刚出来就点（预热还没轮到） | 2,885ms，之后再点 14ms |

- 两条路算出的 `counts.dup` 都是 **400,386**（不是「差不多」，是同一个数）。
- 单测 **232/232**（新增 `test/hygiene-warm.test.mjs` 3 项：预热确实算了体检、关掉就不算、预热结果与当场算逐项相等）。
- 探针 `dev/probe-overview-warm.mjs` **6/6**。

产物：`dsh-memory-nebula-1.11.29.tgz` · **95 个文件 · 3,420,059 字节** · sha256 `584caab65efb1db8e1356e9a6bea27f28432cae3919b5f1285a32332a81f3bec`（包内记录的是上一刀的数字）。

## 1.11.28（2026-11-15）重启之后先问盘

同一份 5 万条库（52,073 节点 / 17.1 万条关联），独立 `DSH_HOME`，两次起服务：

| 场景 | 图就绪 | 日志 |
| --- | --- | --- |
| 第一次（无缓存） | 6,298ms | 没有「读盘恢复」 |
| 第二次（读盘恢复） | **1,033ms** | 有「读盘恢复」 |

缓存文件：`graph-e30ed3c48e0f0e71.json.br` · **4.3MB**（未压缩 163.9MB）· 落盘 +1,632ms（在响应之后，不占用户的等待）。

判据：`dev/probe-cache-start.mjs` **4/4**（第一次确实自建、第二次确实读盘、快 6.1x、条数一致）与 `dev/probe-cache-size.mjs`（体积与写盘耗时）。单测 **229/229**，其中 `test/graph-cache.test.mjs` 5 项：命中恢复、库改动后退化、坏文件当没有、`NEBULA_CACHE=0` 完全不碰盘、文件名即签名。

产物：`dsh-memory-nebula-1.11.28.tgz` · **95 个文件 · 3,417,408 字节** · sha256 `079817156e99ee7e5838515cd8762d7fb8585da4f2acbc8817964c6afbc0952a`（包内记录的是上一刀的数字）。

## 1.11.27（2026-11-15）第一次搜索不再现数词频

同一份 5 万条库（52,073 节点 / 178,398 边）起两次服务，唯一差别是 `NEBULA_PREWARM_DELAY`：

| 指标 | 不预热 | 预热过 |
|---|---|---|
| 第一次 `/recall` | 1,330ms | **100ms** |
| 第二次 `/recall` | 93ms | 84ms |

- 单测 **224/224**；新增 `test/prewarm.test.mjs` 3 项（后台真的算了、预热与现算结果逐 id 相同、强制重建后预热跟着换到新图）。
- `dev/probe-prewarm.mjs` 4/4（A 预热 / B 不预热，两组都验「命中 12 条」）。
- 预热是尽力而为：失败只写 `lastPrewarm.why = 'failed'`，检索照旧；进程退出不受影响（`unref()`）。

产物：dsh-memory-nebula-1.11.27.tgz · 94 文件 · 3,412,014 字节 ·
sha256 52af6d40f2a28ebc3aa55a8b6dcfc944c7efb8c4de965710c689535715d96faa（包内记录的是上一刀的数字）。

## 1.11.26（2026-11-15）策展一条关联，不该重建整张图

5 万条库（52,073 节点 / 178,262 边，`now` 冻结），真机 HTTP（`dev/probe-curate-speed.mjs`，sidecar 另指空目录）：

| 动作 | 改前 | 改后 |
| --- | --- | --- |
| `POST /link` | 39ms + 4,830ms 重建 | 47–64ms |
| `POST /mute` | 41ms + 5,829ms 重建 | 45–54ms |
| `POST /unmute` | 5,829ms 重建 | 42–53ms |
| `GET /graph?refresh=1`（策展之后） | 触发重建 | 164–177ms，`builtAt` 不变 |
| `GET /graph?force=1`（对照） | — | 4.4–5.4s（强制重建照旧） |

对账（`dev/probe-curate-recount.mjs`，`/graph?limit=50000`）：`stats.edges` 与数组长度始终相等，
link +1 / mute −1 / unmute +1，**全程没有重建**。

等价性（`dev/probe-curate-diff.mjs`，冻结 `now`）：策展一条 = 重建的「+1 / −0」；
否掉一条 = 重建的「−2 / +3」（剪枝空位被下一名候选顶上，就地删不会补位）。

单测 **221/221**（新增 `test/curate-incremental.test.mjs` 6 项，含 HTTP 层四条路径）。

产物：`dsh-memory-nebula-1.11.26.tgz` · 94 个文件 · 3,407,288 字节 ·
sha256 `986115c45adb2c00fd867718608e7acb23dd85f8068a5277454fc5b4c09df1d2`（包内记录的是上一刀的数字）。

## 1.11.25（2026-11-15）页面每开一次，就白建一次图

| 验证项 | 结果 | 怎么验的 |
|---|---|---|
| `GET /graph?refresh=1` 不变时不重建 | **13ms**，`builtAt` 与重建前相同 | `node dev/probe-refresh-skip.mjs …/.tmp-50k` 第 4、5 项 |
| `GET /graph?force=1` 仍强制重建 | 5,867ms，`builtAt` 变了 | 同上第 6 项 |
| `POST /refresh` 第二次 | **112ms**，`why=unchanged`、`refreshMs=4` | 同上第 2、3 项 |
| `POST /refresh?force=1` | 仍 `rebuilt: true` | 同上第 7 项 |
| 引擎层跳过 | 没变 → 不建；库文件动过 → 必建；并发 → 后到者 `joined` | `test/refresh-skip.test.mjs` 前 4 项 |
| HTTP 层是否给引擎机会 | 7/7 全过（含「路由把 force 写死」这条） | `test/refresh-skip.test.mjs` 后 3 项 |
| 界面提示 | 重建 / 没变 / 等别人，三种真话都验 | `node dev/verify-refresh-toast.mjs …/.tmp-50k` |
| 全量单测 | **215 / 215** | `node --test "test/*.test.mjs"` |
| 5 万条库整体 | 22/22 | `node dev/verify-50k.mjs` |

改前改后对照（同一份 52,073 条记忆、同一台机）：

| 请求 | 改前 | 改后 |
|---|---|---|
| `GET /graph?refresh=1` | 5,867ms，每次全量重建 | 13ms，不动图 |
| `POST /refresh`（第二次） | 6,901ms | 112ms |
| `GET /graph`（不带参数） | 18ms | 18ms |

产物：`dsh-memory-nebula-1.11.25.tgz` · 94 文件 · 3,401,809 字节 · sha256 `aca62d2f3f09b777f6bfbbcad29c4d11131cb7babe527863628fee1402699894`（包内记录的是上一刀的数字）。

## 1.11.24（2026-11-15）什么都没变，就别重建

按一次「重建星图」不该让磁盘没动的用户等五秒。

| 场景（52,073 条记忆 / 178,388 条连接） | 改前 | 改后 |
|---|---|---|
| 第二次 POST /refresh（指纹没变） | 6,901ms，且每次都全量重建 | **146ms**（`refreshMs: 4`，`why: unchanged`） |
| POST /refresh?force=1 | 6,232ms | 6,232ms（照建） |
| 界面提示 | 一律「已重建：N 条连接」 | 「什么都没变，没重建：52073 条记忆 · 5ms」 |
| 两次的 sig / 节点数 | — | 相同（跳过不会动图） |

三种状态都要能被单独验证：`rebuilt` / `unchanged` / `joined`（并发时后到的那次）。

| 尺子 | 结果 |
|---|---|
| `node --test test/refresh-skip.test.mjs` | **4/4**（首次建、没变不建、force 照建、动过 mtime 必建、并发 joined） |
| `node dev/probe-refresh-skip.mjs .tmp-50k` | 第二次 146ms / `unchanged=true` |
| `node dev/verify-refresh-toast.mjs .tmp-50k` | **5/5**（第二次点必须说「什么都没变」，且不许出现「已重建」） |
| 全量单测 | **212/212** |
| `verify-all --full` | 12 步全过（新增「重建星图：不变就不建」） |

产物：`dsh-memory-nebula-1.11.24.tgz` · 94 文件 · 3,398,127 字节 · sha256 `1bb1c0cc…`（包内记录的是上一刀的数字）。

## 1.11.23（2026-11-15）读不动的来源，得一直挂在界面上

| 检查 | 结果 |
|---|---|
| `/overview.readErrors` | `[{ key, title, path, error }]`，与 `sources[].error` 同源 |
| 常驻横幅 `#readerr` | 显示 / 点名来源 / 说明后果 / `role=status`+`aria-live=polite` 全 PASS |
| 概览标题计数 | `14573 条 · 1 个库读不动` |
| 来源面板 | 仍有 `src-bad` 红字行（明细） |
| 「看来源」按钮 | 焦点落到 `#sources` |
| axe（含横幅状态） | **0 违例** |
| 干净目录 | 横幅 `hidden`、标题不带计数 |
| 快照横幅 | 有错误时出现、干净时没有；**不含本机路径** |

`node dev/verify-readerr.mjs` **15/15**；单测 **208/208**（`test/read-errors.test.mjs` 3 项）。

发布产物：`dsh-memory-nebula-1.11.23.tgz` · **94 个文件 · 3,393,122 字节** ·
sha256 `a9be59b6e3308c36a31c580215563d23234a4c8ca794cac5707162c71ec537e2`（包内记录的是上一刀的数字）。

## 1.11.22（2026-11-15）只跟 key 有关的分，不该算几十万遍

| 指标 | 改前 | 改后 |
|---|---|---|
| score 段 | 581ms | **448ms** |
| A/B 交错五轮中位 | 4,888ms | **4,711ms（−177ms）** |
| 每轮「改后 − 改前」 | — | +129 / −279 / −334 / −20（首轮冷启动剔除） |
| 真机 /refresh | 5,718 / 5,550ms | **5,461 / 5,409ms** |
| 真机 ping | — | p50 4ms / p90 8–9ms / max 167–199ms，慢过 500ms 的 0 |

等价性：`nodeSha` / `edgeSha` / `statsSha` 与 1.11.21 逐位相同。

被量倒的两个想法：

| 想法 | 结果 |
|---|---|
| 11 条实体规则合成 1 条正则 | **7,009 / 52,049 条结果不同**，且更慢（1.45s vs 1.28s） |
| A/B 先跑完改前再跑改后 | 同一份代码差值在 31ms–965ms 之间漂；改成交错跑才稳定 |

单测 205/205；`dev/verify-50k.mjs` 5 万条库 **22/22**（/share 38.42MB / 3,304ms、检索 1,350ms、最长卡顿 57ms）。

发布产物：`dsh-memory-nebula-1.11.22.tgz` · **94 个文件 · 3,388,157 字节** ·
sha256 `cfdb29d05936ae74d23c12d2c9371bb00e405229755b02b83bc6ec30f317c088`（包内记录的是上一刀的数字）。

## 1.11.21（2026-11-15）签名换成升序编号数组

| 指标 | 改前 | 改后 |
|---|---|---|
| sig 段 | 261ms | **139ms** |
| postings 段 | 380ms | **253ms** |
| score 段 | 581ms | **518ms** |
| 建图逐片合计 | 约 4,800ms | 约 4,580ms |
| A/B 中位（各 5 次） | 4,931ms | **4,603ms（−328ms）** |
| 真机 /refresh | 6,156 / 5,886ms | **5,718 / 5,550ms** |
| 真机 ping | — | p50 4ms / p90 8–9ms / max 160–212ms，慢过 500ms 的 0 |

等价性（冻结 `now = 1763164800000`）：`nodeSha` / `edgeSha` / `statsSha` 与 1.11.20 逐位相同。

内存假设被量倒：`--expose-gc` 子进程量两版建图后 heapUsed **335MB / 335MB**（rss 1199MB → 1175MB），
**没有省内存**；省的是时间。单测 205/205；`dev/verify-50k.mjs` 5 万条库 **22/22**
（/share 50000 条 38.42MB / 3,028ms、检索 1,319ms、建图期间最长卡顿 51ms）。

1.11.21 产物：dsh-memory-nebula-1.11.21.tgz · 94 文件 · 3,385,690 字节 · sha256 e3c87ef8…（包内记录的是上一刀的数字）。

## 1.11.20（2026-11-15）挑最稀有的词，不再拼字符串

| 指标 | 改前 | 改后 |
|---|---|---|
| sig 段（52,049 条记忆 / 3,672,659 词次） | 824ms | **261ms** |
| 建图逐片合计 | 约 5,615ms | 约 4,800ms |
| A/B 中位（各 5 次） | 5,756ms | **5,100ms（−656ms）** |
| 真机 /refresh | 6,341 / 6,649ms | **6,156 / 5,886ms** |
| 真机 ping（独立连接） | — | p50 4ms / p90 8–9ms / max 156–198ms，慢过 500ms 的 0 |

等价性（冻结 `now = 1763164800000`）：

| 指纹 | 1.11.19 | 1.11.20 |
|---|---|---|
| nodeSha | 4b3bc84f… | 4b3bc84f…（相同） |
| edgeSha | b32595a7… | b32595a7…（相同） |
| statsSha | 4fe8ba09… | 4fe8ba09…（相同） |

一次性对照：两版挑出的 26 个词映射到 id 后逐位比对，**52,049 条一致、顺序一致**。
单测 205/205；`dev/verify-50k.mjs` 5 万条库 **22/22**（/share 50000 条 38.42MB / 3,014ms、
检索 1,303ms、建图期间最长卡顿 56ms）。

1.11.20 产物：dsh-memory-nebula-1.11.20.tgz · 94 文件 · 3,383,221 字节 · sha256 2e4f60c4…（包内记录的是上一刀的数字）。

## 1.11.19（2026-11-15）读一个库的那 110ms 里，事件循环一次都没让

| 指标 | 1.11.18 | 1.11.19 | 口径 |
| --- | --- | --- | --- |
| 扫描 12 个来源 | 532ms / 空档 532ms | **450ms / 空档 23ms** | `node dev/probe-scan-gap.mjs`（10ms 定时器） |
| 真机 `/refresh` | 6,950–7,109ms | **6,341 / 6,649ms** | `node dev/probe-loop-lag.mjs`，独立连接 ping |
| ping p90 / max | 10–11 / 184–216ms | **8–9 / 179–186ms** | 同上 |
| 慢过 500ms 的 ping | 0/203、0/213 | **0/203、0/213** | 同上 |
| `/share?limit=50000` | 3,288ms | **3,248ms** | `node dev/verify-50k.mjs` |
| 检索 | 1,743ms | **1,399ms** | 同上 |
| 建图期间最长卡顿 | 55ms | **62ms** | 同上（并行 ping 间隔上限） |

等价性（冻结 `now = 1763164800000`，52,073 节点 / 178,262 边）：

| 指纹 | 1.11.16 / 1.11.17 / 1.11.18 / 1.11.19 |
| --- | --- |
| `nodeSha` | `4b3bc84f333e9057bb8b3e5f9294774f26acc045e43622d31c3bfbdc2ac16c0f` |
| `edgeSha` | `b32595a7de6cc95942e1e9e7a7d970bac4a264b71afda7ecefc2252a1e3ef815` |
| `statsSha` | `4fe8ba09750e328310ef5e5b732c4f712e313d7edb0518b9a10090da80ee3e85` |

验收：单测 **205/205**；`dev/verify-50k.mjs` 5 万条库 **22/22**；`node scripts/release-check.mjs` 全绿；
`npm run verify:all` 6/6；安装副本自检 2 通过 / 0 失败 / 4 跳过。

未修：`/refresh` 的 ping max 仍 179–186ms，那是 27.4MB 响应体的 `publicGraph + JSON.stringify`（进程内 183ms），
要再压只能改流式发送。

1.11.19 产物：dsh-memory-nebula-1.11.19.tgz · 94 文件 · 3,379,999 字节 · sha256 0f3680dd…（包内记录的是上一刀的数字）。
## 1.11.18（2026-11-15）两个节点之间那一对字符串

候选对的键从字符串 `a + ':' + b` 换成数字 `a * PAIR_BASE + b`（`PAIR_BASE = 1 << 20`）。

| 指标 | 1.11.17 | 1.11.18 |
|---|---|---|
| 建图中位（`dev/ab-1118.mjs`，各 5 次） | 6,399ms | **5,765ms** |
| 真机 `/refresh`（`dev/probe-loop-lag.mjs`） | 7,341–7,558ms | **6,950–7,109ms** |
| `/refresh` 期间 ping max | 186–203ms | 184–216ms |
| 慢过 500ms 的 ping | 0/236–243 | 0/222–227 |
| 冷 `/share?limit=20000` | 182–194ms | 1,379ms（同一次测量里排在 `/refresh` 之前） |

等价性（`dev/probe-graph-sig.mjs`，冻结 `now = 1763164800000`）：

| 指纹 | 1.11.16 / 1.11.17 / 1.11.18 |
|---|---|
| `nodeSha` | `4b3bc84f333e9057…` |
| `edgeSha` | `b32595a7de6cc959…` |
| `statsSha` | `4fe8ba09750e3283…` |
| 规模 | 52,073 节点 / 178,262 边 |

分片（`NEBULA_GRAPH_TIMING=1 node dev/probe-build-steps.mjs`）：`nodes 2,236（407 片）·
sig 824 · score 638 · postings 495 · df 429 · cand 403 · sources 338 · output 252`，合计约 5.6 秒。

大库验收 `dev/verify-50k.mjs`：**22/22**（`/share?limit=50000` 38.42MB / 3,440ms、
检索 1,695ms、证据链 144ms、单条 17ms、建图期间最长卡顿 56ms）。

稳定性如实记：同一条 `verify-50k` 连跑三次拿到过 `/share` 3,275 / 3,440 / 6,483ms、
检索 1,511 / 1,695 / 3,941ms。查下来是 `.tmp-50k` 上凌晨 1:35 起的一个探针服务
（端口 62820）还在每 30 秒重建图；收掉之后数字回到 3,4xx / 1,5xx–1,6xx。
后来又把 `.tmp-corrupt-db`（端口 62621）也收了。

1.11.18 产物：dsh-memory-nebula-1.11.18.tgz · 94 文件 · 3,376,347 字节 · sha256 254414cd…（包内记录的是上一刀的数字）。

## 1.11.17（2026-11-15）

主题：先问一句，再扫一遍。抽实体按字符判据跳规则、尾部标点改手写扫描、词频换成编号 + Int32Array。

| 项 | 改前 | 改后 | 量法 |
| --- | --- | --- | --- |
| 抽实体 | 1.16s | **0.90s** | `node dev/probe-nodes-prep.mjs …` |
| 节点准备合计 | 2.17s | **1.84s** | 同上 |
| df 段 | 573ms | **390ms** | `NEBULA_GRAPH_TIMING=1 node dev/probe-build-steps.mjs …` |
| 整次建图 | 6,979ms | **6,431ms** | `node dev/ab-1117.mjs`（各 5 次取中位） |
| 真机 /refresh | 8,322–8,325ms | **7,341–7,558ms** | `node dev/probe-loop-lag.mjs …` |

等价性：冻结 `now` 后 `nodeSha` / `edgeSha` / `statsSha` 与 1.11.16 逐位相同（52,073 节点 / 178,262 边）；
`dev/probe-entities-fast.mjs` 逐条比对实体 Map **52,049 条不一致 0**；单测 **202/202**；
`dev/verify-20k.mjs` 5 万条库 **22/22**（`/share?limit=50000` 38.42MB / 3,288ms、`/overview` 89KB / 2,468ms、
建图期间最长卡顿 55ms、`stale` 计数 41,664）。

1.11.17 产物：dsh-memory-nebula-1.11.17.tgz · 94 文件 · 3,371,815 字节 · sha256 7053c378…（包内记录的是上一刀的数字）。
抖动如实记：这台机单次建图有 ±0.6s 的噪声，第一次单跑量到「改后 6,024ms 比改前 5,946ms 慢」，
换成各 5 次取中位才是 −548ms。A/B 脚本 `dev/ab-1117.mjs` 自己把改前改后的文件换回去，避免手抄。

## 1.11.16（2026-11-15）建图里那两秒半，是把整张词表排了一遍

| 项目 | 改前 | 改后 | 口径 |
| --- | --- | --- | --- |
| 建图签名段 | 2,419–2,655ms | **859–1,055ms** | `dev/probe-build-steps.mjs`，5 万条库逐片计时 |
| 整次建图 | 8.7s | **6.9–7.3s** | 同上，逐片合计（本机抖动 ±0.6s） |
| 真机 `/refresh` | 9,304–9,476ms | **8,322–8,325ms** | `dev/probe-loop-lag.mjs`，独立连接 ping |
| `/refresh` 期间 ping 最长 | 184ms | 217 / 184ms | 同上；慢过 500ms 的 0/268 |
| `/overview`（5 万条） | 89KB / 2,319ms | 89KB / 2,336ms | `dev/verify-20k.mjs`，22/22 |

等价性（这次是可复算的）：

| 检查 | 做法 | 结果 |
| --- | --- | --- |
| 签名逐节点 | `dev/probe-sig-graph-equiv.mjs`：参考实现（整表排序 + slice）vs `topRareTokens` | 52,049 条，不一致 **0** |
| 整图指纹 | 冻结 `input.now`，改前改后各跑一次 `buildGraph`，比 `nodeSha`/`edgeSha`/`statsSha` | 三个指纹**逐位相同** |
| 单测 | `test/graph-sig.test.mjs`（400 组随机用例 × 5 个 top 值 + 冻结时间确定性） | 5/5 通过 |

顺带确认的事实：建图**本来就不是逐次确定**的（`now` 影响热度与取样顺序，同一份库两次跑边数会差几条：
178,318 / 178,323 / 178,262）。这不是 bug，但让「拿两次结果对比」这类验证失效，
所以 `buildGraph` 现在接受 `input.now`，单测里钉住「同一份输入两次建图必须完全一致」。

单测 **202/202**；`dev/verify-20k.mjs` 5 万条库 **22/22**（建图期间最长卡顿 57ms、检索 1,468ms）。
1.11.16 产物：dsh-memory-nebula-1.11.16.tgz · 94 文件 · 3,367,873 字节 · sha256 c6157d84…（包内记录的是上一刀的数字）。

## 1.11.15（2026-11-15）比的是编号，不是字符串

上一轮把 `stale` 压到 328ms 后，体检里最贵的一段变成签名挑选（`sig` 775–867ms）：
每个词要 `wordId.get(t)` 查一次字符串哈希，5 万条库上 367 万个词次。

| 口径 | 修前 | 修后 |
|---|---|---|
| 参考实现（整表排序 + slice） | 2,052ms | 873ms |
| 签名不一致 / 词频不一致 | — | **0 / 52,049 · 0 / 82,639 个词** |
| 体检合计（`.tmp-50k`） | 2,899ms | **2,039ms（−30%）** |
| 分段 `tok / df / sig` | 587 / 227 / 775 | 572 / 311 / **236** |
| `/overview` 5 万条 | 3,861ms | **2,319ms（−40%）**，89KB |
| `/share?limit=20000` 冷 | 1,940ms | **1,263ms**，15.70MB |
| 同一请求的 ping 最长 | 233ms | 172ms |
| `/refresh` | 9,476ms | 9,494–11,338ms（体检不在这条路径上） |

- 等价性用 `node dev/probe-sig-equivil.mjs "D:/document/Memory Universe/.tmp-50k"` 逐节点比对，
  **不是抽样**；词表条数与词次总和也一并比（82,639 / 3,672,659）。
- 代价如实记：df 段 230ms → 311ms（多了一次 `Int32Array` 分配），sig 段降 540–630ms，净赚约 460ms。
- 单测 **197/197**；`dev/verify-20k.mjs "…/.tmp-50k" 62821 50000` **22/22**。
1.11.15 产物：dsh-memory-nebula-1.11.15.tgz · 94 文件 · 3,364,190 字节 · sha256 25b5d2d9…（包内记录的是上一刀的数字）。

## 1.11.14（2026-11-15）装在别人机器上，也得能自己验一遍

`npm run verify:all` 之前只在仓库里跑过。装进空目录后第一次运行直接崩：

```
Error: ENOENT: no such file or directory, scandir '…/node_modules/dsh-memory-nebula/test'
```

修好之后的两种场地：

| 场地 | 结果 | 说明 |
|---|---|---|
| 仓库（`dsh-memory-nebula/`） | **6 通过 / 0 失败 / 0 跳过 · 7.6s** | 单测 197、构件门、冒烟、安全面、畸形参数全跑 |
| 已安装副本（`.tmp-1.11-install/node_modules/dsh-memory-nebula`） | **2 通过 / 0 失败 / 4 跳过 · 0.5s**，退出码 0 | 四条跳过分别写明「这个副本没带 test/（单测只在仓库里跑）」「这个副本没带 test（构件门只在仓库里跑）」「没有 dev/security-probe.mjs（这个副本没带开发探针）」「没有 dev/fuzz-1.8.mjs（这个副本没带开发探针）」 |

跳过判定写在脚本里：单测看 `test/` 在不在；构件门看 `docs/roadmap.md`、`docs/verified.md`、
`market/index.json`、`test` 这一组「只有仓库才有」的文件；缺哪个就在原因里点名。
`test/verify-all.test.mjs` 多了 4 条断言，把这件事钉成契约。

产物：`dsh-memory-nebula-1.11.14.tgz` · 94 文件 · 3,360,683 字节 · sha256 `74d551c7…`（包内记录的是上一刀的数字）。

## 1.11.13（2026-11-15）该更新了，只问该问的那几个词

`stale` 的判定是「同工作区里有没有一条更新、更重要、且共享 ≥3 个关键词的记忆」。
旧写法对每条记忆把每个关键词的倒排链从头走一遍；新写法先按链长（≈ 稀有度）排序，
**只在前 `|kws| − 2` 个词里找候选**——共享 ≥3 个词的话，那 3 个词不可能全在最后 2 位。

| 项（`.tmp-50k`，52,049 条记忆 / 12 个工作区） | 修前 | 修后 |
|---|---|---|
| `stale` 段 | 910ms | **328ms** |
| 同步体检（进程内） | 3,142–3,474ms（1.11.10 是 5,321ms） | **2,899ms** |
| 候选 / 重叠检查 | 几十万条 | **42,075 / 130,666** |
| `counts.stale` | 41,643 | 41,643–41,644（随「现在」浮动） |
| `by` 与旧写法不同 | — | **23 / 41,643（0.06%）**，仍满足全部条件 |

等价性两道证据：

```bash
node dev/probe-stale-equiv.mjs "…/.tmp-50k"   # 新旧算法同一份数据逐条比对：漏 0 / 多 0
node --test "test/stale-equivalence.test.mjs" # 逐条全扫的参考实现交叉校验（3 项）
```

端到端（同一份库）：

| 项 | 数字 |
|---|---|
| 冷 `/overview` | **3,861ms · 89KB**；同进程第二次 **12ms** |
| `/share?limit=50000` | 38.42MB · **3,825ms** |
| `/refresh` | 9,476ms，期间并行 `/ping` 最长 **56ms** |
| 单测 | **197 / 197** |
| `dev/verify-20k.mjs … 50000` | **22 / 22** |

产物：`dsh-memory-nebula-1.11.13.tgz` · 94 文件 · 3,358,263 字节 · sha256 `32ab4c4c…`（包内记录的是上一刀的数字）。

## 1.11.12（2026-11-15）一条命令跑完，跳过不算通过

`scripts/verify-all.mjs` 把散落的二十多把尺子串成一条命令。默认（`npm run verify:all`）：

| 步骤 | 用时 | 结果 |
|---|---|---|
| 单测（27 个文件） | 1.4–4.9s | 191 项通过 / 0 失败 |
| 发行构件（每个版本的门） | 4.2–5.2s | 全部通过 |
| HTTP 冒烟（demo 1.11.11） | 0.5s | 全部通过 |
| 冒烟（接口契约） | 0.5s | 全部通过 |
| 安全面（CORS / CSRF / 路径穿越） | 0.2–0.3s | 全部通过 |
| 畸形参数 | 0.4s | fail = 0 / 34 |
| **合计** | **7.1s** | **6 通过 / 0 失败 / 0 跳过** |

`npm run verify:full`（5 万条库 `.tmp-50k`）：

| 步骤 | 用时 | 结果 |
|---|---|---|
| 大库验收（22 项） | 20.7s | 全部通过 |
| 浏览器：翻一页 | 15.2s | 全部通过 |
| 无障碍：八状态 axe | 27.0s | 全部通过 |
| 键盘：Tab 序列 | 10.7s | 全部通过 |
| **合计（含前 6 步）** | **84.2s** | **10 通过 / 0 失败 / 0 跳过** |

`--gpu` 三维真 GPU：15.9s，收敛后 165fps / 中位帧间隔 6.1ms / `drawMs 2.7ms` / 18,000 光点。

「拿错尺子」的处理（在 2 万条库上 `--full --nodes 20000` 实测 **7 通过 / 0 失败 / 3 跳过 · 16.7s**）：

| 情形 | 行为 |
|---|---|
| 测试库条数 < `--nodes` | 先 `countNodes()` 起只读服务问真实条数，不够就标跳过，原因写「这里 22,073 条，期望 ≥ 50,000」 |
| 翻页 / 八状态 axe（断言按 52,073 写死） | 只在测试库 ≥ 50,000 时跑，否则跳过并说明 |
| 没有 `dev/`、没有 Edge | 对应步骤跳过并写明缺什么 |

新命令第一次 `--full` 就抓到一条**假红线**，值得记下来：

| 断言（修前） | 结果 | 修后 |
|---|---|---|
| `measured.nodes === before.nodes * 2`「正好翻了一页」 | 10,000 → 19,991 判红；首屏被视图过滤掉 9 条，翻倍判据必然对不上（前几次首屏恰好整 10,000 条，蒙对了好几轮） | `page.next === 20,000`「下一页游标正好两页」+ `added ∈ (9,500, 10,000]`「新增节点数接近一页」 |

修后 `dev/verify-page2.mjs` **14 项全过**（第二页 722ms、布局+首帧 181ms、逐页最慢 879ms、
两页方向键 16.7ms、全图 51.5ms、全图 52,064 节点）。

稳定性如实写：`--full` 连跑 4 趟，其中 1 趟「大库验收」红了 1 条（当时表格只写「1 项未通过」，
没留到是哪条），单独复跑与随后两趟都全过。现在表格会直接写「哪一条红了」，同样的抖动下次能定位。

产物：dsh-memory-nebula-1.11.12.tgz · 94 文件 · 3,354,522 字节 ·
sha256 59abf5e9…（包内记录的是上一刀的数字）。

## 1.11.11（2026-11-15）体检里那三秒，一半在排序上

`.tmp-50k`（52,049 条记忆 / 178,410 边）上的同步体检，同一台机、同一天：

| 指标 | 修前（1.11.10） | 修后 | 变化 |
|---|---|---|---|
| 体检总时长 | 5,321ms | 3,159 / 3,229 / 3,474ms（中位 3,229ms） | −39% |
| `sig` 段（挑最稀有的 24 词） | 1,684ms（累计 3,309ms） | 775–867ms | −55% |
| `df` 段（词频表） | 973ms | 227–250ms | −75% |
| `stale` 段 | 819–1,210ms | 953–1,210ms | 基本持平（倒排改有序，收益被噪声盖住） |
| `counts` | dup 400,869 / stale 41,631 | 完全相同 | 等价 |

端到端（`dev/verify-20k.mjs`，5 万条库 **22/22**）：

| 接口 | 修前 | 修后 |
|---|---|---|
| `/overview` | 4,240–4,495ms / 89KB | **3,326ms / 89KB** |
| `/share?limit=50000` | 7,782ms / 38.42MB | **4,428ms / 38.42MB** |
| `/share?limit=20000`（冷） | 2,206ms / max 192ms | 1,940ms / ping p50 21ms · p90 115ms · max 233ms · 慢过 500ms 的 0 |
| `/refresh`（强制重建） | 9,304ms / max 184ms | 9,304–9,678ms / max 184ms |

等价性证据：`dev/probe-sig-equivil.mjs` 在 82,639 个词 / 3,672,659 个词次上逐节点比对
新旧签名，**不一致 0 / 52,049**，词频表不一致 0；单测 `test/hygiene-sig.test.mjs` 2 项
（参考实现交叉校验 + 倒序输入同样结果），全量 **191/191**。

产物：`dsh-memory-nebula-1.11.11.tgz` · 93 文件 · 3,345,876 字节 ·
sha256 `9acd9592…`（包内记录的是上一刀的数字）。

## 1.11.10（2026-11-15）会滚动的面板，也得能被 Tab 到

5 万条真实形状库（52,073 条 / 178,391 边）上的八个 UI 状态各审一次 axe（axe-core 4.10.2，WCAG A/AA）：

| 状态 | 状态断言 | 违例 |
|---|---|---|
| 首屏 | 10,000 条 · 分页条可见 | 0 |
| 全图 | 52,073 条 · 分页条已收起 | 0 |
| 体检看板 | 看板打开 · 体检页签选中 · 2,616 字 | 0（修前 1：`scrollable-region-focusable #boards-body`） |
| 三维 | 18,000 个光点 | 0 |
| 搜索结果 | 12 条命中 | 0（修前 1：`scrollable-region-focusable #hits`） |
| 详情面板 | 2,224 字 | 0 |
| 证据链 | 98 字 | 0 |
| 命令面板 | 已打开 | 0 |

Tab 序列（连按 60 次）：`A → skykeys → btn-cards → btn-boards → btn-mode → btn-refresh → btn-fit →
btn-keys → btn-lang → btn-export → q → sources → filters → detail → d-body`，
`#q` / `#sources` / `#filters` / `#detail` / `#d-body` 全部可达。离线快照 `docs/demo.html` 0 违例（passes 40）。
单测 **189/189**。产物：`dsh-memory-nebula-1.11.10.tgz` · 93 文件 · 3,341,264 字节 ·
sha256 `db268d0d…`（包内记录的是上一刀的数字）。复跑：`node dev/verify-axe-states.mjs "<repo>/.tmp-50k" 62842`、
`node dev/verify-taborder.mjs "<repo>/.tmp-50k" 62851`。
## 1.11.9（2026-11-15）五万条切三维，前两秒不再抖

- 库：`.tmp-50k`（真实形状，52,073 条 / 178,397 边），headless Edge（`--headless=new`）。
- 渲染器证明是真卡：`WEBGL_debug_renderer_info` 报
  `ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)`
  （本机是 RTX 4060，ANGLE 报的是它认到的 D3D11 适配器）；软件模式
  `ANGLE (Microsoft, Microsoft Basic Render Driver …, D3D11)`。
- `BALL_LIMIT` 取样 18,000 光点；冷布局（先 `localStorage.clear()` 再 `load(graph, true)`）。
  切三维 6 秒窗口（`dev/probe-3d-gpu.mjs --all --settle --cold`）：
  - 改前：13 帧、每帧 **230ms**（≈19fps）、收敛约 3s；
  - 改后：**575–660 帧**、中位 **6.1ms**、p90 18.2ms、最长 **121–140ms**（落在切换后第一帧）、
    慢帧（>33ms）**8–10 个**、收敛 **约 2.4s**；收敛后稳态 160–165fps、`drawMs 2.7–3.1ms`。
  - 中间态（说明每一步各自值多少）：8ms 预算但每帧都画 = 中位 30.4ms、收敛 6.3s；
    8ms + 每 3 帧画一次 = 中位 12.2ms；10ms + 每 4 帧 + 只画光点 = 上面的最终值。
- 20,000 条库（`.tmp-20k`）：中位 6.1ms、p90 12.2ms、最长 67ms（第一帧）、慢帧 1 个、收敛约 2.0s。
- 软件渲染（`--software`）：33.3ms/帧、收敛约 7.5s——是 SwiftShader 的合成器下限，
  与本次改动无关；GPU 与软件渲染的帧数几乎一致，正好证明瓶颈在 JS（profile：`forceStep` 44.8%）。
- `dev/verify-20k.mjs "…/.tmp-50k" 62793 50000` **22/22**（建图期间 `/ping` 最长 55ms、
  `/overview` 89KB、体检每类 ≤40、`counts.stale` 41,618）。
- 目检：`dev/shot-3d.mjs` 在 0.6s / 1.5s / 收敛后各截一张，收敛期的球阵与收敛后形态一致
  （收敛期不画连线，收完那一帧补回）。
- 单测 **189/189**（零行为改动：位移结果与收敛轮数都没变，只改了「什么时候算、什么时候画」）。
- 产物：`dsh-memory-nebula-1.11.9.tgz` · 93 文件 · 3,336,904 字节 ·
  sha256 `47d300cd939387801e5a10108221dca96c5dd52d89f1db3d8095d470d01bbbc2`
  （包内记录的是上一刀的数字）。

## 1.11.8（2026-11-15）五万条，在浏览器里一页页点到头

- 库：`.tmp-50k`（真实形状，52,073 条 / 178,358 边），headless Edge、软件渲染 1440×900。
- `dev/verify-page2.mjs` **9/9**：首屏起来了 / 还有下一页 / 第二页合并进来 / 正好翻一页 /
  点一次到出帧在 4 秒内 / 取完之后布局与首帧在 1.5 秒内 / 翻到底之后分页条自己收起 /
  收起时 toast 说「已经加载全部」/ 全图方向键中位在 120ms 内。
- 首屏：导航 → 可交互 **553–980ms**，第一帧绘制 **23ms**，`/graph` 216ms · 458KB（br，
  10,000 节点 / 32,167 边），JS 堆 61MB。
- 第二页：第一次点（服务刚建完图）合计 **1,323–1,358ms**；热态 **212–253ms**，
  其中布局 + 首帧 **25–35ms**。
- 一路翻到底：逐页 287 / 361 / 421 / 450ms；全图 52,061 节点 / 178,358 边 / **157MB** 堆；
  方向键中位 **34ms**（10k 时 0.7ms、20k 时 16.7ms）。
- 收尾行为：`page.next == null` → 分页条 `hidden` + toast「已经加载全部 52073 条」；
  探针第一版读隐藏条的旧文案，误报过一次「还有 2073 条」（不是产品 bug，是尺子读错了元素）。
- 单测 **189/189**（本轮零代码改动，只加验收与文档）。
- 产物：`dsh-memory-nebula-1.11.8.tgz` · 93 文件 · 3,329,161 字节 ·
  sha256 `9781428057824843fa05538151f72f1084d1b8553b38f550ae26fc8e7552f70e`
  （包内记录的是上一刀的数字）。

## 1.11.7（2026-11-15）最慢的那一片，藏在来源节点那个正则里

- 库：`.tmp-50k`，52,049 条记忆 / 52,073 节点 / 178,411 边。
- 逐片计时（`dev/probe-build-steps.mjs`，直接驱动 `buildGraphSteps` 并给每个 `next()` 计时）：
  切片总数 **1,500** 左右，最慢一片 **322ms → 76ms**（修前那一片是「来源节点」的正则扫描，
  每个技能/MCP/插件名都要在 5 万条正文上跑一次边界正则，中间不让路）。
- 进程内事件循环（`dev/probe-elmax.mjs`，`monitorEventLoopDelay`）：`refresh()` 最长静默
  **324ms → 121ms**；GC 104 次 / 单次最长 16.5ms——**不是 GC 的锅**。
- 真机（`dev/probe-loop-lag.mjs`，独立连接、不 await）：`/refresh` ping 最长
  **792 / 841ms → 186 / 173ms**；慢过 500ms 的 ping **10/284 → 0/307**、**7/301 → 0/316**；
  p90 从 66 / 40ms 降到 13 / 11ms。
- `/refresh` 总时长 8.4–9.8 秒（切片更细，机器抖动更明显）；底线是「总时长不显著变差、
  最长静默降一个数量级」，两条都满足。
- `dev/verify-20k.mjs` 50,000 模式 **22/22**；建图期间并行 `/ping` 最长 **57ms**；
  `/overview` 4,495ms / 89KB；体检 `counts.stale = 41,601` / 列表 40 条（口径未变）。
- 单测 **189/189**（切片不改变任何结果，所以没有新增用例；等价性由 `verify-20k` 与
  `test/async-longop.test.mjs` 的同步/异步全等断言守着）。
- 产物：`dsh-memory-nebula-1.11.7.tgz` · 93 文件 · 3,326,302 字节 ·
  sha256 `d43a44eb340a7c28eea6ca728ec5c5a84412c2ab0449e49807967d31adefc3dc`
  （包内记录的是上一刀的数字）。

## 1.11.6（2026-11-15）重复检测快了 3 倍，一对都没少

- 库：`.tmp-50k`，**52,049 条记忆 / 52,073 节点 / 178,410 边**（与 1.11.5 同一份）。
- 等价性（`dev/probe-dup-equivil.mjs`，同一份签名、同一套 24 稀有词规则）：
  旧算法 **2,966ms / 400,869 对**，新算法 **965ms / 400,869 对**，
  **漏 0 对、多 0 对**。这个脚本是这一轮唯一说得清「没少找」的证据。
- 全套体检：**6.5s → 3,819ms**（`dev/probe-hygiene-time.mjs`；分段
  `tokens+df+sig 2.7s · postings 0.4s · dup-exact 0.05s · dup-count 0.2s · dup-pairs 0.3s · stale 0.9s`）。
- 端到端（`dev/verify-20k.mjs` 50,000 模式）：**22/22 全过**；
  `/overview` **6,740ms → 4,240ms / 89KB**；`counts.stale = 41,593`、列表每类 ≤40 条。
- 真机卡顿（`dev/probe-loop-lag.mjs`）：`/share?limit=20000` 冷 **2,206ms / ping 最长 194ms /
  慢过 500ms 的 0 个（共 71 次）**，热 2,059ms / 159ms。`/refresh` 仍是 8,781ms、
  最长 **782ms**（10/281 个 ping 慢过 500ms）——这一块下一轮修。
- 单测 **189/189**（新增 `test/dup-equivalence.test.mjs` 3 项）。
- 产物：`dsh-memory-nebula-1.11.6.tgz` · 93 文件 · 3,321,978 字节 ·
  sha256 `e0a3d6a285e261af7703eb3778c6fb5bb7f5b266f22cabff9acc3dd0dfcfa318`
  （包内记录的是上一刀的数字）。

## 1.11.5（2026-11-15）五万条的库，导一份快照不该把界面按死

- 库：`.tmp-50k`（4 个工作区 × 12,500，语料取自 9 个真实 meow 库的 227 条真实记忆形状），
  实测 **52,073 节点 / 178,410 边 / avgDegree 6.85 / 首屏孤岛 0.4%**。
- 尺子：`dev/probe-loop-lag.mjs` —— 每 25ms 发一个**独立连接、不 await** 的 `/ping`，
  记 p50/p90/max 与「慢过 500ms 的个数」。这是第三次修尺子：复用连接池量到的是排队，
  串行 await 量到的是极端样本，只有并发独立连接量到的才是「事件循环有没有被按住」。
- `/share`（limit 20000，12MB HTML）：
  - 修前：冷 10,679ms · ping p50 1,991 / p90 6,100 / **max 7,121ms**（346 个 ping 里 222 个慢过 500ms）。
  - 修 `publicGraph({all:true})` + 异步体检后：冷 11,104ms / **7,525ms**（热路径已解决：3,504ms / 156ms）。
  - 修 `overview({hygiene:false})` 里偷偷同步算的 `cards()` 之后：冷 **3,546ms / max 187ms**，
    热 3,514ms / 173ms；分段 `publicGraph 73ms · nodes 27ms · edges 9ms · clusters 9ms ·
    overview base 38ms · slice(体检) 3,172ms · pack 13ms · safeJson 70ms`。
- `/recall`（冷，首次查）：1,368ms / **1,334ms** → 1,807ms / **65ms**（分片让路，总时长变长）；
  热 58ms / 37ms。
- `/refresh`（强制重建）：首次 9,551ms / **921ms**，第二次 8,482ms / 750ms；
  进程内 10ms 定时器量的最长空档 104ms，剩下那块在响应体（5.2MB）前后，留到下一轮。
- `/overview`（5 万条）：89KB / 6,740ms（分片后总时长），`counts.stale = 41,587`、列表仍每类 ≤ 40。
- `/share?limit=50000`：38.42MB · 7,782ms · `scope.trimmed.shown = 50000`（修前只写 10,000 条且
  `trimmed` 为 null）。
- `dev/verify-20k.mjs` 在 5 万条库上 **22/22**（检索预算从 800ms 放到 3 秒，卡顿由 probe 单独盯）。
- 单测 **186/186**（+6：`test/async-recall.test.mjs` 3 项、`test/share-hygiene.test.mjs` 3 项）。
- 发布产物：`dsh-memory-nebula-1.11.5.tgz` · 93 个文件 · **3,317,319 字节** ·
  sha256 `38591c15…`（包内记录的是上一刀的数字）。

## 1.11.4（2026-11-14）长活分片，事件循环不让路

- 前情：1.11.3 把 `/overview` 的体量砍到 83KB，但**算它的那 2.9 秒**还在。2 万条库上
  重建一次 3.7 秒、体检 2.9 秒，两条路径都同步跑在宿主 web server 的事件循环上——
  症状不是「星图页慢」，而是整个 DSH 在这几秒里不回声。
- 拆耗时（`NEBULA_HY_PROFILE=1` / `NEBULA_GRAPH_TIMING=1`）：
  体检 `tokens+df+sig 1,072ms · postings 46ms · dup-pairs 1,551ms · stale 202ms · 其余 30ms`；
  建图 `nodes 2,503ms · postings 193ms · candidates 275ms · score+prune 544ms`。
  **节点准备（分词 + 抽实体 + 热度）占建图七成**，重新切片的重点就在这里。
- 改法：`buildGraph` / `auditHygiene` / `scanAll` 各拆成「生成器 + 同步壳 + 异步壳」，
  异步壳每次 `yield` 后 `setImmediate`。切片按**时间**（每 6ms）不按条数：
  按 1024 条切时实测有一片 **1,767ms**（超长记忆两两比对），等于没让。
- 实测（22,049 条 / 74,880 边）：
  - `buildGraph` 同步 **3,651ms**（最长空档 3,651ms = 整段按住）；
  - `buildGraphAsync` **4,006ms**（最长空档 **144ms**，单片最长 **37ms**）；
  - `auditHygiene` 同步 **3,624ms** → `auditHygieneAsync` **2,961ms**（最长空档 **79ms**）；
  - `Nebula#refresh` 全程 **3,791ms**、最长空档 **59ms**（接入 `scanAllAsync` 之前是 302ms）。
- 代价照实记：异步建图比同步慢约 **10%**（600+ 次 `setImmediate` 的调度开销）。
  拿 0.35 秒换掉 3.6 秒的整段静默，这笔账是划算的。
- 真机（`dev/probe-blocking.mjs`，**独立连接**）：2 万条库上 `/overview` **7ms**、
  `/graph` **96ms / 508KB**（br）、`/share` **211ms / 0.93MB**（br）、`/recall` **633ms**，
  `/refresh` **3,822ms** 期间 `/ping` 最长间隔 **37ms**（判定线 150ms）。
- 尺子的教训：同一个 `refresh`，用 `fetch` 复用连接池测是「静默 **4,237ms**」，
  改成每次新连接（`agent: false`）测是「静默 **37ms**」。前者量的是 HTTP 排队，
  后者才是事件循环。**745ms 的 `/recall` 被报成 738ms 静默**，就是这把坏尺子的签名。
- 真机二次（`dev/verify-20k.mjs` **22/22**）：`/graph` 默认页 5.09MB → br 0.50MB / 77ms、
  `/overview` 82KB / 6ms、`/share?limit=20000` 8.42MB / 140ms、`/recall` 49ms、
  体检每类 ≤ 40 条而 `counts.stale = 16,246`、**建图期间并行 `/ping` 最长 55ms**。
- 自动：**180/180 单测**（+5：同步/异步逐项相等、异步期间 10ms 定时器不被饿住、
  `scanAllAsync` 与同步版的坏来源报错一致）、`release-check` 全绿（新增 1.11.4 构件门）。
- 发布产物：`dsh-memory-nebula-1.11.4.tgz` · 93 个文件 · **3,312,293 字节** ·
  sha256 `4e6b924f532ae70d3f516450c73cc33bfe384c9a0e6c10dd8336f8050b3c8b3b`
  （包内记录的是上一刀的数字）。

## 1.11.3（2026-11-14）体检清单有上限，数字还得是真的

- 前情：本机真实库只有 2,220 条，5 万条那条路一直跑在合成数据上。这一轮先造了一份
  **2 万条真实形状**的库：从本机 9 个真实 meow 库读标题/正文/关键词/重要度，复制到
  20,000 条（4 个工作区 × 5,000），只有 id 是新的。`dev/make-20k-fixture.mjs`。
- 实测规模：**22,073 节点 / 75,227 边 / avgDegree 6.82 / 首屏孤立 0.4%**
  （多出的 2,073 条是服务顺带扫到的真实工作区）。
- 发现：`/overview` **3,650,834 字节**，拆开看 `hygiene` 占 4.5MB 的 JSON 体量，
  其中 `items.stale` **16,243 条**——五类截过 40 条，唯独「该更新了」和「关系是凑的」没截。
- 改法：`stale` / `thin` 截到 `HY_MAX = 40`；`counts` / `total` 保持全量，
  新增 `shown` / `totalShown` 说明「列了几条」。工具与界面在截断时明写「只列前 N 条」，
  且 **N 是屏幕上真画出来的行数（5），不是接口的 40**——两个数字必须自洽。
- 实测（`dev/verify-20k.mjs` **22/22**）：`/overview` **3.6MB → 83KB（−97.7%）**、6ms；
  体检每类 ≤ 40 条、`counts.stale = 16,243`、`shown.stale = 40`；
  `/graph` 默认页 5.09MB → br **0.50MB**、65ms；两页零重叠；`/recall` 654ms；
  `/path` 79ms；`/node` 14ms；`/share?limit=20000` **12.67MB → 8.42MB**、3.7s；
  建图期间并行 `/ping` 的最长间隔 **55ms**（没有把事件循环按住不放）。
- 浏览器预算（`dev/verify-budget.mjs` 跑同一份 2 万条库，只加载默认页 10,000 节点 /
  30,398 边）：导航 → 第一帧 **797ms**、`/graph` 131ms / 509KB、第一帧绘制 **17.6ms**、
  方向键中位 **0.8ms**、三维第一帧 **13ms** / 单帧 20.8ms（9,222 个光点）、JS 堆 37MB。
- 真机（`dev/verify-hygiene-ui.mjs` **9/9**，headless Edge 1440×900）：体检面板标题
  「该更新了 · 16244 · 只列前 5 条」，屏幕上 5 行，底下「还有 16239 条（用 nebula_stats
  看全量）」；接口 `shown.stale = 40`、`counts.stale = 16244`（比第一跑多 1 条，是真实
  工作区在这几分钟里又长出来的一条）。
- 自动：**175/175 单测**（+2 体检上限）、`release-check` 全绿（新增 1.11.3 构件门）。
- 发布产物：`dsh-memory-nebula-1.11.3.tgz` · 93 个文件 · **3,304,142 字节** ·
  sha256 `93163e218aeffa04c24db3b1f556551a4e223331bc433d7f1450c08ce935b50e`
  （包内记录的是上一刀的数字）。

## 1.11.2（2026-11-14）命中在后面的页里，就自己往后翻

- 前情：1.11.1 把提示改准了，但确认「到底有没有」还得用户自己点几十次「继续加载」。
- 改法：`applyFilter()` 在「筛选是活的 + 屏上 0 条 + `page.next != null`」时自动往后翻，
  上限 `AUTO_FILL_PAGES = 3`；取图收口到 `fetchGraph()`（默认为 `API.graph`，
  测试可换 `state.fetchGraph`），`loadNextPage()` 同源。
- 实测（`dev/verify-filter-page.mjs` **17/17**，headless Edge + demo 服务）：
  - 命中在下一页：只调用 1 次取图、合并后 20 条、`visibleCount()` 10，
    toast「筛选命中在后面的页里：已往后加载 1 页，找到 10 条」，空屏提示自动收起；
  - 连翻不命中：调用正好 **3** 次、节点停在 40 条（没有无限加载），
    toast「已往后加载 3 页，仍没找到匹配；可以再点底部「继续加载」」，
    提示里更新为「当前已加载 40 / 250 条里没有匹配」；
  - 全部加载完（`next === null`）：回到「当前筛选把整张图都藏起来了 · …」；
  - 清空筛选：提示收起（`shown:false`、文本为空）。
- 自动：**173/173 单测**、`release-check` 全绿（新增 1.11.2 构件门）。
- 发布产物：`dsh-memory-nebula-1.11.2.tgz`，93 个文件 / 3,300,189 字节 /
  sha256 `909beaa5cdf1d8bb388c74211cf70577b5781567d0cc382fb571429b0a42e5bb`
  （包内记录的是上一刀的数字）。`docs/demo.html` 453,882 字节（64 节点 / 78 连接）。

## 1.11.1（2026-11-14）分页没加载完，就别叫人重置筛选

- 前情：1.9.0 的分页让「整张图」不再等于「全部记忆」。筛选没命中时 `#hint` 却还在说
  「当前筛选把整张图都藏起来了 · 用「重置筛选」回到全视图」——命中可能就在下一页，
  这条建议会让人白扔条件。
- 改法：`updateFilterHint()` 按 `state.page.next != null` 分岔。还有下一页 → 「当前已加载
  10 / 250 条里没有匹配 · 可能还在后面的页里：点底部「继续加载」，或用搜索直接找」；
  全部加载完 → 保留原来的「重置筛选」说法。
- 实测（`dev/verify-filter-page.mjs` **8/8**，headless Edge + demo 服务）：
  - 分页未加载完、筛 `ws=zzz`：`#hint` 文本「这一屏没有记忆 / 当前已加载 10 / 250 条里没有匹配
    · 可能还在后面的页里：点底部「继续加载」，或用搜索直接找」，且**不含**「重置筛选」；
  - `#filter-hint` 仍正常：「已筛选：隐藏 10 条记忆（共 9 条连接）」；
  - `page.next = null` → 回到「当前筛选把整张图都藏起来了 · …」；
  - 清空筛选 → `#hint` 收起（`shown:false`、文本为空）。
- 真实库浏览器预算（`dev/verify-budget.mjs`，2,222 条 / 11,128 条连接，1440×900，软件渲染）：
  导航 → 第一帧 **449ms**、DCL/load 45/115ms、`/graph` **61ms · 235KB**、
  第一帧绘制 **1.1ms**、方向键 24 次中位 **0.5ms**（p90 1.4ms、最大 3ms）、
  切三维 → 第一帧 **129ms**（单帧 12.2ms、屏上 299 个光点）、JS 堆 **15MB**。
- 自动：**173/173 单测**、`release-check` 全绿（新增 1.11.1 构件门）。
- 发布产物：`npm pack` **93 文件 / 3,295,207B**，sha256
  `304a5ea0e963d64a30e4a9e5f9519e54a8e8e8c71aaa76e5fd55a50e7ea0e832`
  （包内记录的是上一刀的数字）。

## 1.11.0（2026-11-14）快照坏没坏，开之前就知道

- 前情：单文件快照被聊天软件改一个字、或被截断半截，打开就是渲染一半的白屏，
  没有任何提示；示例语料里自己挂着 `op-checksum` 的 TODO。
- 结构：载荷进 `<script type="application/json" id="nebula-snapshot-data">`，
  启动脚本记 `__NEBULA_SNAPSHOT_INTEGRITY__ = {algo:'sha256', bytes, sha256}`；
  解析失败写 `__NEBULA_SNAPSHOT_BROKEN__`。**哈希对象是原始文本**，不重新序列化。
- 实测（`dev/verify-snapshot-integrity.mjs` **7/7**，headless Edge + `file://`）：
  - 好快照：64 条上屏、toast「快照校验通过 · sha256 1825f501…」、无红横幅；
  - 数据块内改「星图→星国」：红横幅「期望 1825f501… 实际 597df83d…」，
    `hidden:false`、`cls:"bad"`；
  - 截断到 12,972 字节：报「快照数据读不出来（…）：Expected ',' or ']' after array element
    in JSON at position 12971 …。请重新导出。」——不是白屏。
- `test/share-integrity.test.mjs` **5/5**：摘要与数据文本一致、bytes 按 UTF-8、
  改一个字摘要不同、截断后 `JSON.parse` 抛 `SyntaxError`、启动脚本形态。
- 自动：**173/173 单测**、`release-check` 全绿（新增 1.11.0 构件门）。
- 发布产物：`npm pack` **93 文件 / 3,291,385B**，sha256
  `63f395ca8d324e9bd8f2bf9a3fc28e97e135fe9fad9f9cdbee3c6c3b8b133cf6`
  （包内记录的是上一刀的数字）。
- 注意：`file://` 下 Chromium 的 `isSecureContext` 为真，`crypto.subtle` 可用；
  没有 WebCrypto 的环境退化为长度核对，仍能抓截断。

## 1.10.1（2026-11-14）坏库不再假装是空的

- 前情：把一个 256 字节的垃圾文件当成 `proj/.dsh-meow/memory.db`，服务照样起来，
  `proj` 显示 0 条，`/diagnostics` 里 `lastError: none`——用户只能猜「记忆被删了」。
- 修后实测（`dev/verify-corrupt-ui.mjs` **11/11**，headless Edge + 真实 HTTP）：
  - 图数据里 `sources` 恰好一条带 `error`：`{"key":"proj","error":"读不动 memory.db：file is not a database"}`；
  - 界面弹一次「有来源读不动：proj（细节在「来源」里）」，来源面板多一行红色 `proj 读不动`；
  - `/diagnostics` 文本含 `sourceErrors: 1` 与 `! proj：读不动`；
  - **不含** `memory.db`、**不含**绝对路径（`redact()` 把路径抹成 `[路径]`、库名抹成 `[数据库]`）。
- `test/corrupt-source.test.mjs` **5/5**：坏库被点名 → 诊断脱敏 → doctor 判 fail →
  换成好库后 `storeErrors` 清空、`lastError === ''`、节点恢复。
- 自动：**168/168 单测**、`release-check` 全绿（新增 1.10.1 构件门）。
- 发布产物：`npm pack` **93 文件 / 3,284,457B**，sha256
  `c37b4c0fbed487830913ba588a6c2188dadca8a9bd53f84447c9e8171cdad4cc`
  （包内记录的是上一刀的数字）。

## 1.10.0（2026-11-14）三维的绘制预算

- 前情：1.2 起超过 3,000 条切三维会被退回星云（力导向要过全部节点与边，软件渲染扛不住）。
  1.10.0 改成带预算画，`dev/verify-3d.mjs` **11/11**（headless Edge + SwiftShader 软件渲染，
  也就是最差的渲染路径）：
  - 50,000 节点 / 150,000 边：`budget {limit:18000,total:50000,shown:18000,sampled:true,edges:53848}`，
    真正上屏的光点 **7,203**（区块点亮是随时间铺开的，读的是稳定后的一帧），
    一帧主线程耗时 **47.1–50.8ms**（两次运行），23 帧间隔中位数 **66.8–84.8ms** /
    p90 最高 151.4ms。软件渲染是这条路径的下限，真 GPU 未单独测量，如实记在此。
  - 10,000 节点：`sampled:false`，上屏光点正好 **10,000**（不取样时行为与旧版一致）。
  - 界面上确实写着「三维只画重要度前 18000 条（共 50000 条）；要全量请留在星云视图」。
- 顺带修掉一个只在「宿主回包没有 `sig`」时出现的 bug：三维只在 `sig` 变化时重载，
  `undefined !== undefined` 为 false，换图后三维会一直停在旧图上；现在同时比较 graph 对象身份。
- 自动：**163/163 单测**、`release-check` 全绿（新增 1.10.0 构件门：预算常量 / 取样 / 边预筛 /
  调试字段 / 硬闸门已移除 / i18n 文案）。
- 发布产物：`npm pack` **93 文件 / 3,278,233B**，sha256
  `4bc5a571665971be2de39feac09ccf5d0c738328aed1930161245c438ee44fef`
  （包内记录的是上一刀的数字）。

## 1.9.2（2026-11-14）分页条的无障碍

- 分页条是 1.9.0 新加的交互元素，1.9.2 补上读屏与键盘这一层；验证脚本 `dev/verify-1.9-ui.mjs`
  扩到 **17/17**（原 12 项 + 4 项无障碍 + 1 项收尾提示）：
  - 状态文字：`role="status"` / `aria-live="polite"` / `aria-atomic="true"`，`id="pagebar-status"`；
    按钮 `aria-describedby="pagebar-status"`；分页条 `aria-busy` 空闲时 `"false"`。
  - 键盘：「继续加载」是真正的 `<button>`，`focus()` 后 `document.activeElement` 就是它；
    `.pagebar .pbbtn:focus-visible` 有 2px 亮边框 + 2px 偏移。
  - **axe-core 在分页条可见时零违例**（`runOnly: wcag2a/wcag2aa/wcag21a/wcag21aa`，
    结果 `violations: []`）。
  - 末页收起前提示「已经加载全部 25 条」，`document.body.innerText` 里确实读得到；
    英文文案 `All {n} memories are loaded` 已进 `lib/web/i18n.js`。
- 自动：**163/163 单测**、`release-check` 全绿（新增 1.9.2 构件门）。
- 发布产物：`npm pack` **93 文件 / 3,271,647B**，sha256
  `758d4c74d18dea9c8d181e152eb321952053ae2598d568f82a9cd0dcf820428b`
  （包内本文记录的是上一刀的数字，包无法包含自身哈希）。

## 1.9.1（2026-11-14）市场端到端与真实库复核

- 市场端到端（`dev/market-e2e.mjs`）**26/26**，用的是 dshmarket **1.73.19** 自己的
  `lib/check.js`（`satisfiesRange` / `compareSemver` / `isSemver`），不是另写一套 semver：
  - 索引这一条：名字可检索、`versions.length === 1`、版本号是合法 semver、等于 `package.json`
    版本、`engines.dsh` 有声明、来源 `npm`、中文介绍可展示、1.9.0 相对已发布 1.6.4 是升级。
  - 真安装 → 真升级：`npm install dsh-memory-nebula@1.6.4`（真实 registry）后
    **就地升级到 tarball 里的 1.9.0**（1.6.4 → 1.9.0，约 1.3s）；新版带上 `lib/host/page.js`
    与 `lib/host/compress.js`，没有套娃 `node_modules`，`test/`、`dev/` 不进包。
  - 升级后能启动：从安装目录起 `lib/standalone.mjs --demo`，`/ping` 回 `1.9.0`。
  - loader 行 id 升级前后一致（`memory-nebula` → `memory-nebula`），不会多出一条重复插件行。
- 引擎口径三处一致（这条会「市场说能装、启动说不能」，所以单独验）：
  宿主是 `dsh 2.0.22-next`，严格 semver 判 `>=0.2.2-rc.1` **不满足**（`strict=false`），
  而 dshmarket 的 `discovery-compatibility.js`、`verify.js` 与 DSH 的
  `@deepseek-ai/dsh-app-boot/lib/index.js` 都带 `includePrerelease: true`，三处一致放行
  （`market=true`）。演练脚本直接读这三份源码来钉这条口径。
- 真实库复核（`dev/verify-real-library.mjs`，本机 meow 库只读，`--root D:\document`）**12/12**：
  - 2,220 节点 / 11,118 边 / 10 工作区 / 81 会话，建图 **552ms**。
  - `/graph` **1.51MB** → gzip **0.30MB**，58ms；`page.next === null`（一页装得下，整页语义不变）。
  - `limit=500` 切出 500 条、1,515 条页内边、`page.total=2220`、`page.next=500`，
    页内每条边的另一端都在已加载集合里。
  - 默认快照 **2.49MB**；`limit=300` 的快照 **0.65MB**，元信息
    `trimmed {cap:300,total:2220,shown:300,by:'importance'}`，文件里带
    「这是一份裁剪过的离线快照」的静态提示（脚本没跑起来也在）。
- 自动：**163/163 单测**不变（本版没有行为改动，只修了 `lib/host/nebula.js:398` 一句
  写错阈值的注释：分页默认截断是 **一万**条，不是两万）。
- 发布产物：`npm pack` **93 文件 / 3,268,173B**，sha256
  `b40c7be9ffa81ab587b2a2da8119c7a3da0027ce7d8b7d8f66cd494c963dc4e7`（包内本文记录的是上一刀的
  字节数与 sha，包无法包含自身哈希；以 npm 页面与本行上面的值为准）；装进空目录后起 demo，
  `scripts/smoke.mjs` 全过；同一份 tarball 也被市场演练当成「升级目标」装过一遍。

## 1.9.0（2026-11-14）五万条也不糊成一片

- 缺口来源：`node --expose-gc scripts/bench.mjs --nodes 50000` 的改前基线——**280 边 / 49,567 孤岛（99.1%）**、
  建图 5,115ms、整图 JSON 由 `/graph` 实测 **22.30MB**、单文件快照 **43.8MB**；
  headless Edge 上 5 万节点 / 15 万边一帧 **477.8ms**。
- 大图取样配对（`lib/host/graph.js`，`n > 20000`）：50,000 条实测 **5,799.7ms / 197,569 边 / 0 孤岛 /
  avgDegree 7.9**；检索 32.1ms、体检 3,518.5ms（25,024 项）、证据链 26.1ms；
  `NEBULA_GRAPH_TIMING=1` 阶段：nodes 2,069ms、postings 202ms、candidates 1,039ms、score+prune 1,643ms
  （cand=465,007、raw edges=366,112、kept=197,574）。**10k 仍 78,593 边、20k 仍 156,993 边**，与改动前逐条一致。
- 分页真机（`dev/verify-1.9-page.mjs`，50,000 节点）**16/16**：
  - 整图（`limit=1e9`）：50,000 节点 / 166,390 边 / JSON **22.30MB**（节点 12.79 + 边 9.51），
    gzip 2.07MB、br 1.84MB，`publicGraph` 57ms。
  - 首屏（默认 10,000）：10,000 节点 / 30,762 边 / JSON **4.26MB**，gzip 0.38MB、br 0.35MB，46ms。
  - 第二页：10,000 节点 / 33,038 边 / 4.47MB；跨页边 **6,560** 条；两页节点重叠 **0**。
  - 首屏 vs 整图：JSON **−80.9%**、gzip −81.6%、br −80.8%；`page` 头
    `{"total":50000,"offset":0,"limit":10000,"next":10000,"order":"importance"}`。
- 分页 UI 真机（`dev/verify-1.9-ui.mjs`，CDP + headless Edge，`?debug=1`）**12/12**：
  分页条「分页：已加载 10 / 25 条，还有 15 条」；合并第二页新增 10 条、总数 20 且无重复；
  **合并前后相机完全一致** `{"k":1.35,"x":-86.36989248026117,"y":9.381044034045008}`；
  重复合并同一页 0 新增；末页后分页条自动收起；一页装得下的小图不显示分页条。
- 视口裁剪真机（`dev/verify-1.9-cull.mjs`，50,000 节点 / 150,000 边）**11/11**：
  整图 `mode:'cluster'`、簇间线 12 条、**drawMs 11.5ms**（改前同一 fixture 477.8ms）；
  zoom×4（k=0.323）仍 cluster、**8.1ms**（改前 313.6ms）；zoom×60（k=4.84）走 `mode:'edges'`、
  候选 **1,785 / 150,000 = 1.19%**；`pick` 精确命中 n25000、空处 null、**2,000 次 6.5ms**。
- 快照分片：`test/share-limit.test.mjs` **7 项全过**；`dev/verify-1.9-share.mjs` **15/15**
  （limit=abc/0/60000/−3 全 400；demo 64 条默认不裁剪；`limit=12` → `trimmed {cap:12,total:64,shown:12,by:'importance'}`、
  label「整张星图 · 已裁剪 12 / 64 条」、快照 382,692B → 365,534B；浏览器打开页面底部出现
  「这是一份裁剪过的离线快照：已写入 12 / 64 条…」，画布 3 个、无报错）。
  `scripts/bench.mjs --nodes 50000`：单文件快照 **1,572.7ms / 16.6MB / 20,000 节点**（改前 43.8MB）。
- 自动：**163/163 单测**（+11 `test/page.test.mjs`、+8 `test/graph-page-http.test.mjs`、
  +7 `test/share-limit.test.mjs`）；`release-check` 全绿并新增 1.9.0 构件门。
- 过程教训：视口裁剪的第一版 fixture 让边跨簇（`b = a + 1 + i % 97`），长边 bbox 横穿整图，
  放大后候选仍 **99.86%**；改成同簇邻居 `b = a + 12 * (1 + i % 9)` 才得到真实的 **1.19%**。
  基准数据的分布错了，指标会骗人。
- 发布产物：`npm pack` **93 文件 / 3,264,889B**，sha256
  `da4e2176afdec26b4e0ae102a46858e3dde69a535674ab282b81ad917e5f238f`（包里的本文记录的是上一刀的 sha，
  包无法包含自身哈希；以 npm 页面与本行上面的值为准）；装进空目录后起 demo 服务，
  `scripts/smoke.mjs` 全过；包里含 `lib/host/page.js`，`test/` 与 `dev/` 不进包。

## 1.8.0（2026-11-14）大响应不再整包重传

- 缺口来源：`dev/fuzz-1.8.mjs`（34 项畸形/契约探针）对 demo 服务的实测——`/graph` 带
  `accept-encoding: gzip, br` 仍返回 `content-encoding=(none)`；`/export?format=exe` 200 且发 markdown；
  `scope=zzz:nope` 200 且按 `all` 导出整库；300KB 的 `/link` 请求体只拿到 `fetch failed`（status 0，连接被重置）；
  `HEAD /app` 404。
- 真机字节级复验 `dev/verify-1.8.mjs`（子进程 `node lib/standalone.mjs --demo --port 62123`，用 `node:http`
  取原始字节，避开 `fetch` 自动解压）**16/16 PASS**：
  - `/graph` 24,384B → gzip **5,066B**（省 79.2%）→ br **4,412B**（省 81.9%）；两者解压后与原文逐字节一致，
    `content-length` 等于实际正文长度；`vary: accept-encoding` 在场。
  - `/graph` 复验：带 `If-None-Match` 得 **304**（body 0B，`etag: W/"demo-v1-1794660621397"`，带 `vary`）。
  - `app.js` 139,815B → gzip **44,261B**（省 68.3%），静态 `etag` 例 `"mwg33txd-2zvr"`，
    复验 **304**，`cache-control: no-cache`。
  - `HEAD /app`：200、`content-length: 11588`、body 0B；`HEAD /graph`、`HEAD /style.css` 同样只回头。
  - 超限请求体：**413** `{"error":"请求体超过 256 KB"}` + `connection: close`，不再是 ECONNRESET。
  - `/export`：`format=exe`、`scope=zzz:nope`、`scope=ws:`、`scope=xingang` 全 **400**；
    `format=json&scope=ws:xingang`、`format=md` 均 200。
  - `/share` 420,399B → br **113,285B**（省 73.1%），解压后以 `<!doctype html` 开头且含 `__NEBULA_SNAPSHOT__`。
- 自动：137/137 单测（新增 `test/http-transport.test.mjs` 11 项：q 值协商、`*` 通配、`q=0` 拒绝、
  类型白名单、Vary 合并、gzip/br 解压一致、identity 回退、压缩下 304、静态 ETag+304、HEAD 三条、
  export 400 四例、413 带 `connection: close`）；`release-check` 全绿并新增 1.8.0 构件门。
- 真机安全探针抓到的两处：修前 `/ping` 带 `Origin` 时 `Vary` 只剩 `accept-encoding`
  （`res.setHeader('vary','Origin')` 被 `writeHead` 的同名头盖掉），修后为 `Origin, accept-encoding`，
  25 项探针全过；超长 URL（20,000 字符）修前是「一行 431 后拆 socket」，`fetch` 报 status 0，
  修后 `clientError` 回完整 **431** + `connection: close` + `{"error":"请求头或 URL 太长"}`，
  `dev/fuzz-1.8.mjs` **34/34**（连跑两次稳定），回归进 `test/standalone.test.mjs` 第 5 项。
- 期间踩的坑：用一次性脚本正则改 `http.js` 时吃掉一个右括号（`http.js:607` 报
  `SyntaxError: missing ) after argument list`，子进程 exit 1），补回后 137 测试恢复全绿——
  这类批量改动用 `node --check` 过一遍再跑测试。
- 发布产物：`npm pack` **92 文件 / 3,239,424B**，sha256 `ee97102dbe80131453dfbcd7937d36e32441cb6a35033f8f2b9d1fb800240508`；
  装进空目录（`npm i <tarball>`）后起 demo 服务，`scripts/smoke.mjs` **63 项全过**、`dev/verify-1.8.mjs` **16/16**；
  包里含 `lib/host/compress.js`，`test/` 与 `dev/` 不进包。

## 1.7.0（2026-11-14）键盘也能游

- 键盘层实测：headless Edge（`--headless=new`，1440×900）打开重新生成的 `docs/demo.html`
  （64 节点 / 78 连接 / 420,455B），`#skykeys` 拿到焦点后：
  `→` 播报「当前位置：字体：思源黑体 + 霞鹜文楷 · 设计系统」，`↓` 换到「当前位置：配色方案 v2：夜航蓝 + 暖沙 · 设计系统」，
  `]` 沿连接走到「当前位置：星港的界面配色直接复用设计系统 · 星港产品」，`+` 播「已放大」，
  `Enter` 打开详情（`#detail` 为 `show`，标题与当前位置一致），`Esc` 收起并播「已离开星图」、焦点落回 `#btn-keys`。
  全程 `window.__errs` 与控制台异常均为空。
- 读屏：`#a11y-summary` 输出「记忆星图：64 条记忆，78 条连接。按 Tab 进入星图后，用方向键在星星之间移动，回车打开。」；
  `#a11y-index` 生成 64 条（`A11Y_INDEX_MAX = 300`）；三张画布仍是 `aria-hidden`，不再挂无效的 `role="img"`。
- 自动：126/126 单测（新增 `test/nav.test.mjs` 10 项几何、`test/a11y.test.mjs` 11 项结构门）；
  `release-check` 全绿，并新增 1.7.0 构件门（键盘层 / 读屏索引 / 两个渲染器 / 快照内联 / 白名单 / 文档与测试）。
- 真机抓到的发行缺口：独立引擎的 `STATIC` 白名单漏了 `nav.js`，HTTP 页面里 `window.NebulaNav === undefined`，
  修前方向键只会播「这个方向没有别的记忆」、`]` 只会播「这颗星没有连出去的线」（离线快照因为内联，反而正常）。
  补齐白名单后，同一探针在 `http://127.0.0.1:62117/` 上通过：`→`「深夜调试 · 日记」、`↓`「储物柜密码改了 · 日记」、
  `]`「被一句「先别动」戳到 · 日记」、`Enter` 标题一致、`Esc` 焦点回 `#btn-keys`；回归进 `test/http.test.mjs`（21 项）。
- 发布产物：`npm pack` **91 文件 / 3,229,329B**，sha256 `c6e9f8d50ca69da34c1d266ce3e8a0f5f26fd7bebf3a11bf2296c639a6be3d66`；
  装进空目录（`npm i <tarball>`）后同一套检查仍过（smoke 63/63、CDP 键盘探针全通过），
  包里含 `lib/web/nav.js`、`docs/accessibility.md`、`docs/assets/keys-en.jpg`。
- 示例库的来源面板不再假报警：同一台 demo 服务上 `scripts/smoke.mjs` 曾报
  「sources 读过节点 0 条 / 1 条错误」（`适配器 demo 不能扫描`）；`sourcesReport()` 现在在 demo 下直接统计内置数据，
  重新跑 smoke **63 项全过、0 失败**。回归进 `test/demo.test.mjs`（第 6 项）。
- 快照：`node lib/standalone.mjs --demo --share docs/demo.html` 重新生成，页内已含
  `root.NebulaNav = api`、`nav.js` 内联与 `const APP_VERSION = '1.7.0'`。
- 跳过链接：页面第一个 `Tab` 停在「跳到记忆星图」（`a.getBoundingClientRect().top === 10`，已滑入视野），
  `Enter` 后 `document.activeElement.id === "skykeys"`，接着方向键即可走位——整条路径只用真实按键。
- 3D（Galaxy）视图同样走通：按 `3` 切换后 `#sky3d` 可见，方向键播报「当前位置：星港的图标是一架纸飞机 · 星港产品」、
  `]`「主人原话：「先别动我的声线」 · 语音实验室」、`+`「已放大」、`Enter` 详情标题一致、`Esc` 焦点回 `#btn-keys`，零异常。
- axe-core 4.10.2 审计（`dev/axe.min.js` + `dev/cdp-axe.mjs`，headless Edge 注入后跑 `axe.run`）：
  离线快照 **0 违例 / 40 passes**；HTTP 中文 **0 / 41**；`?lang=en` **0 / 42**；官网 `docs/index.html` **0 / 38**。
  修前官网有 color-contrast 10 处（`#5f6878` on `#050608` = 3.6:1）、`.shots` 横向滚动条键盘不可达 1 处；
  现在弱文字 `--faint:#8a94a6`（6.6:1）、截图条 `tabindex="0" role="region"`，星图页补 `<main id="app">` 与两个滑杆的 `aria-label`。
  唯一 incomplete 项是画布渐变背景上的 color-contrast，axe 判不了，需人眼复核。
- 未做真机屏幕阅读器验收（NVDA / VoiceOver 未跑）；键盘链路走的是 CDP 真实按键事件，不是页面内合成事件。

## 1.6.4（2026-11-13）demo 真的是 demo

- 子进程回归：`node lib/standalone.mjs --demo --port <随机端口>` 启动后 `/ping` 返回
  `demo=true`、64 记忆 / 78 连接；`/graph` 也带 demo 标记。
- `--demo` 之前只对 `--share/--export` 生效，服务器分支漏传 demo；已修，单测 **103/103**。
- `npx -y -p dsh-memory-nebula memory-nebula --demo` 现在真的只读示例库。
- Node 22.13.0 下复跑：103/103 单测、`release-check` 全绿（1.6.4 代码）；兼容矩阵的下界仍然成立。
- 发布：88 文件 / 3,066,929B，sha256 `bad3f598874be5b988ad9dd0e6615ae48c3ca1bcfd8d2d28fb0852802cfbd760`；
  npm latest 1.6.4，`dist.shasum=9ddbdf650237b3b2157c49b775773dbaa5e057a5`；GitHub commit `bf94d55…`，Release `v1.6.4`（id 443451341）。

## 1.6.3（2026-11-13）点得亮

- 回归：用最小 window 运行浏览器版 `api.js`，列存快照的 `graph()` 现在返回对象节点与 `{a,b}` 边；
  详情与检索共用同一张展开图。两项测试进 `test/snapshot.test.mjs`，总 **102/102**。
- `docs/demo.html`（64 节点 / 78 连接）在 headless Edge 打开：画布出节点、搜索命中、详情正文正常，无 JS 错误。
- 同一修复覆盖所有按列存快照；旧对象型快照不受影响；快照不再依赖 rAF 才显示节点。
- 发布：88 文件 / 3,066,023B，sha256 `03db4f968283e437789c441f0c0a5758183635c72d9e58d6ef90f89baca76afa`；npm latest 1.6.3，
  `dist.shasum=6c2eefeec3468b794ca48909e2db4a5beb58865a`；GitHub commit `bbf1474…`，Release `v1.6.3`（id 443394582）。
- `docs/demo.html` 线上 200（399,418B），页内已是 `Promise.resolve(snapData().graph)` 与 `1.6.3`；headless Edge 出节点、搜索与详情正常。

## 1.6.2（2026-11-12）医生也带钥匙

- `doctor --token <token>` / `NEBULA_TOKEN` 会以 `Authorization: Bearer` 请求 `/ping`；
  本地 HTTP fixture 断言收到的正是该头，且报告 detail 不含口令。
- 100/100 单测；`npm run check` 全绿。
- 发布：81 文件 / 2,929,631B，sha256 `795b66985e5d5637975a27cf3e75e6972e5e457cf32749ed5c7e054f5af48040`；
  npm `dsh-memory-nebula@1.6.2`（dist.shasum `3bb5a7dff2089b8a35448ae3f4db027d79abb627`），
  registry 安装 `--version`=1.6.2；unpkg `@1.6.2/market/index.json` 为 format 1 / 1.6.2。
  GitHub commit `fc9b533…`，CI 三 job 全 success；Release v1.6.2（id `443155981`）附 tgz 与 `.sha256`。
- 发布后补支持入口：`SUPPORT.md`、三份 issue 表单/配置、PR 模板、README 中英「支持与反馈」段；
  commit `2ed89eb4…`，CI 三 job success。`SUPPORT.md` 已加入下次打包的 `files` 白名单。
- 官网：GitHub Pages 以 `main` + `/docs` 启用，`https://hanhan9999999999999999999.github.io/dsh-memory-nebula/` 200；
  桌面 1401px / 移动 414px 均无横向溢出，6 张图与 icon 全 200；commit `7facf6f…`、`c5b8230…`、`2da58c9…`。

## 1.6.1（2026-11-12）口令门把手

- 7909 standalone `--token unlock-test-123456`：无凭据 `GET /app` 返回 401 HTML 登录页，
  标题「记忆星图 · 需要口令」；页面不加载脚本，表单指向 `/api/memory-nebula/unlock`。
- headless Edge 填入口令并提交：302 回 `/app`，cookie 生效，页面加载 2152 记忆 / 10602 连接，
  `window.__nebulaErrors` 为空；错误口令留在表单并提示「口令不对，再试一次」。
- API 仍保持 JSON 401（`/graph` 无凭据），静态资源也要凭据。
- 99/99 单测；`npm run check` 全绿。
- 发布：81 文件 / 2,928,345B，sha256 `c75bade28992b964ac1a1a43b49bcd6bb2a6377813b0ee34e6e0bddccf2c54a1`；
  npm `dsh-memory-nebula@1.6.1`（dist.shasum `aa72e23d22a2f435d187f358b9b77992aaf2c486`），
  registry 安装 `--version`=1.6.1，doctor 8/0/0；unpkg `@1.6.1/market/index.json` 为 format 1 / 1.6.1。
  GitHub commit `41b2d9d…`，Release v1.6.1（id `443021780`）附 tgz 与 `.sha256`；
  test suite 同步 commit `22f57bf…` 后 CI 三 job（Node 22.13 / 24 / Package install）全 success。

## 1.6.0（2026-11-12）本机口令

- 99 单测：新增「无凭据 401 / cookie 200 / Bearer 200 / `?token=` 200 且带 cookie / 错口令 401」。
- standalone 实测：`--token test-token-123456` 启动 7906，`/graph?demo=1` 无凭据 401、
  Bearer 200、`/app?token=` 200 并返回
  `set-cookie: nb_token=…; Path=/api/memory-nebula; HttpOnly; SameSite=Strict`。
- 浏览器实测（headless Edge，`dev/cdp-token.mjs`）：打开 `/app?demo=1&token=…` 后地址栏变成
  `/app?demo=1`（token 已从历史移除），64 记忆 / 78 连接正常加载，`document.cookie` 为空
  （HttpOnly 生效），无 JS 错误；截图 `dev/shot/token.png`。
- 短于 12 字符的口令拒绝启动；不传 `--token` 时行为与 1.5.2 完全一致。
- 发布：npm `dsh-memory-nebula@1.6.0`（dist.shasum `83cb628db66db8a0eb4039c798023fc14943295c`，
  81 文件 / 2,925,496B，sha256 `12b89260b1f90037ae5a09ea4fa6ab40d2c308adb2845fac3f2210317457662f`）；
  registry 安装 `--version`=1.6.0，doctor 8 通过 / 0 提醒 / 0 失败；unpkg
  `@1.6.0/market/index.json` 为 format 1 / 1.6.0。GitHub 源码 commit `007a167…`，
  CI 三 job success；Release v1.6.0（id `442911770`）附 tgz 与 `.sha256`。
- 发布后回归：7908 standalone（真实库）smoke 63/63、安全探针 25/25、doctor 9 通过 / 0 提醒 / 0 失败
  （endpoint 1.6.0 / 2134 memories）。

## 1.5.2（2026-11-12）精选目录收录

- awesome-dsh-plugin PR #14065 已合并（merge commit `aaa81f3…`）。
- 目录页 `https://awesome-dsh-plugin.com/p/hanhan9999999999999999999/dsh-memory-nebula/`
  返回 200，页面 title 为 `hanhan9999999999999999999/dsh-memory-nebula — dsh plugin · Memory`，
  安装命令为 `dsh plugin --profile web add dsh-memory-nebula`。
- 本版只改 README 安装入口与版本号，无代码变更；98 单测 / 63 冒烟 / 25 探针沿用 1.5.1。
- 发布：npm `dsh-memory-nebula@1.5.2`（dist.shasum `a4504c0441f29b4eb7e7573e515c5e049eacf2df`，81 文件 / 2,922,704B，sha256 `5ae708cbe94e1e9ffae187406df8d120fcef084d4f02ff558a91d4eb5ac9a1ca`）；
  registry 安装 `--version`=1.5.2，doctor 8 通过 / 0 提醒 / 0 失败；unpkg
  `@1.5.2/market/index.json` 为 format 1 / 1.5.2。GitHub 源码 commit `de9c74b…`，
  Release v1.5.2（id `442827970`）附 tgz 与 `.sha256`。

## 1.5.1（2026-11-11）切片簇

- 1.5.0 的 `scope` 已按节点重算，但 `clusters` 仍按节点上不存在的 `cluster` 字段过滤，
  范围导出里的簇为空。改为按 `clusters[].members` 与切片集合求交，重算 `size` /
  `workspaces` / `title`。
- 实测 demo `scope=ws:xingang`：2 个簇，size `[3,1]`；全图仍 2 个簇 `[3,3]`。
- 测试 **98/98**，`GET /export?scope` 断言簇非空且 size>0；`npm run check` 全绿。
- 发布：npm `dsh-memory-nebula@1.5.1`（dist.shasum `8dabdf5d69e641fba8a8ed6c88b0d8e1bd21b4ce`）；
  registry 安装 `--version`=1.5.1，doctor 8 通过 / 0 提醒 / 0 失败；unpkg
  `@1.5.1/market/index.json` 返回 format 1 / 1.5.1，icon/locale/详情/图片均 200；
  GitHub Release v1.5.1（id 441883424）附 tgz 与 `.sha256`；源同步 commit `ddc82c6…`。

## 1.5.0（2026-11-11）命令行导出

- `node lib/standalone.mjs --demo --export <file> --scope ws:星港产品`
  写出 JSON：`scope.kind=ws`、32 节点 / 31 连接 / 1 工作区，退出 0。
- `--scope focus:xg-weekly --hops 1`：12 节点 / 12 连接，`scope.kind=focus`；
  未知范围退出 2，stderr「这个范围里没有记忆」。
- `GET /export?demo=1&format=json&scope=ws:xingang`：200，32/31；
  `scope=ws:nope`：400 `{error:"这个范围里没有记忆…"}`，不再把错误包在 200 里。
- 测试 **98/98**（`standalone.test.mjs` 4 项、`http.test.mjs` 19 项）；
  `npm run check` 全绿。
- 真实库：`GET /export?scope=ws:DSHLive2D` → 463 节点 / 1,344 连接 / 1 工作区；
  `scope=ws:nope` → 400。CLI `--export --scope project:memory-nebula` → 235 节点 /
  557 连接 / 93,871 字节。
- 打包 **81 个文件 / 2,921,242B**，sha256 `579e34fd6679e7f514feb9c18b8ce6df9ac95225103a40866e898bdf7ffdcad9`；
  干净安装 `--version`=1.5.0，`--demo --export --scope ws:xingang` 输出 32/31。
- npm publish 后 latest=1.5.0，`dist.shasum=b914ecf1b7e4c2abb0d25cc90184f014208b9afe`，
  unpacked 3,638,299B；registry 安装 1.5.0，doctor 8/0/0，focus 导出 21 节点。
- GitHub commit `b5200bb27ba5e12c507cfde30ed3507c64fba4b7` 的 CI 三 job
  （Node 22.13 / Node 24 / Package install）全 success；Release `v1.5.0`
  id **441843361**，tgz 与 `.sha256` 上传成功。
- unpkg `@1.5.0/market/index.json` 经 `parseMarketIndex` 通过（1 插件 / 1.5.0）。
- 兼容：`--export` 不传 `--format` 时按 `.json` / 其它扩展名推断；不传 `--scope`
  与旧 `/export` 全图行为一致。

## 1.4.1（2026-11-11）英文门面

- `README.en.md` 与 `docs/market.en.md` 的截图改为英文界面：
  `preview-en.jpg`（真实库 2062 记忆 / 10027 连接）、`demo-en.jpg`（示例 64/78）、
  `snapshot-en.jpg`（离线快照）、`empty-en.jpg`（空态三出口）。
- 英文截图由 headless Edge 在 `http://127.0.0.1:7905/?lang=en` 实拍；跳过新手引导与
  快捷键面板后截图，`window.__nebulaErrors` 为空。
- 仍 95/95 单测；`npm run check` 全绿。没有代码行为变化，仅 README/市场素材。
- 打包 **81 个文件 / 2,917,431B**，sha256 `f984fb191f09d2e9336e7c397964a5f74e70a4a78871212e83c82051eff64d53`；
  干净安装 `--version`=1.4.1，doctor 8/0/0。
- npm publish 后 `dist.shasum=d46b70cf8e513188e3eaa86c805b70922d5f9bba`，
  unpacked 3,626,628B / 81 文件。
- GitHub commit `ee3ea1ba13fd3686dd7115967d1c21179b35470a` 的 CI 三 job 全 success；
  Release `v1.4.1` id **441735408**，tgz 与 `.sha256` 上传成功；unpkg 索引 200，
  `marketInstallTarget`=1.4.1。

## 1.4.0（2026-11-11）命令行快照

- `node lib/standalone.mjs --demo --share <file>`：64 节点 / 78 连接 / 398,897B，
  title「记忆星图 · 离线快照」，无外部 `<script src>`。
- `--scope ws:xingang --hide level:fact`：10 节点 / 3 连接 / 372,521B；非法 scope
  退出码 2，stderr 为「scope 要写成 ws:<工作区>…」。
- `package.json` 删除误留的自我依赖；`package.test.mjs` 断言 `dependencies` 为空。
- 单测 **95/95**（新增 `standalone.test.mjs` 2 项）；`npm run check` 全绿。
- 打包 **77 个文件 / 2,461,678B**，sha256 `e74e2b038119aa4ee3783f6ea4c4e432060b34dd02332af9e7b55dc67216d710`；
  干净安装 `--version`=1.4.0，示例快照写出成功，`dependencies` 仍为空。
- npm publish 后 `dist.shasum=bf921545577d5076536a7c290f84f777e65b3a42`，
  unpacked 3,149,662B / 77 文件；unpkg 索引 200，`marketInstallTarget`=1.4.0。
- GitHub commit `56ca2be1b2da4bc8f17055160f85c59c655ab276` 的三 job（Node 22.13 / 24 / Package install）
  全 success；Release `v1.4.0` id **441284269**，tgz 与 `.sha256` 均上传成功。

## 1.3.0（2026-11-11）紧凑快照

- 20k 快照从旧对象格式约 23.1MB 降到 **19,996,814B**，生成 174.2ms；
  节点/边改为 `nodeColumns`/`edgeColumns` + 行数组，客户端 `expandSnapshotNodes`/
  `expandSnapshotEdges` 展开后再建索引。
- 同一份 20k 快照（headless Edge，1680×1000，`?` 不适用）：
  - 新浏览器 profile（`dev/edge-bench20k-cold`）首屏 **762ms**；
  - 热 profile（`dev/edge-bench20k`）首屏 **572ms**；
  - 检索 52ms / 12 命中，搜索 704ms / 12 命中，详情 116ms / 731 字，
    证据链 1 跳 <1ms，体检看板 1.9s / 824 字，`window.__nebulaErrors` 为空。
- 单测 **93/93**（新增列顺序与核心字段逐项还原）；`npm run check` 全绿。
- 打包 **77 个文件 / 2,459,108B**，sha256 `53c5feefcea3707b53b3d9d2f8a613749fb7dc49ac3edaa5abea2c6cb1546483`；
  干净安装 `--version`=1.3.0；npm publish 后 `dist.shasum=8534682a0a95ae16701951bc26bbd9fc490a76b5`，
  unpacked 3,143,396B / 77 文件。
- 旧快照兼容：无 `nodeColumns`/`edgeColumns` 的对象格式原样返回，不展开。
- GitHub commit `f094ff9093fc6a3d9a1f68a6833ca238986dcfe9` 的三 job（Node 22.13 / 24 / Package install）全 success；
  Release `v1.3.0` id **441254549**，tgz 与 `.sha256` 均上传成功。
- unpkg `https://unpkg.com/dsh-memory-nebula@1.3.0/market/index.json` 200；
  `parseMarketIndex` 返回 format 1 / 1 插件 / 1.3.0，`marketInstallTarget` = `dsh-memory-nebula@1.3.0`。

## 1.2.1（2026-11-11）英文空态兜底

- 英文静态巡检 `dev/audit-en.mjs`（headless Edge，`?lang=en`，排除记忆正文/标题/来源名）
  首次扫出 `#hint` 的中文兜底「这里还没有星星 / 记忆库是空的，或者还没建立连接」；
  补 `data-zh` 与英文后复跑，只剩语言切换按钮的「中」（这是切回中文的标签，不是漏翻）。
- `dev/check-i18n.mjs`：430 键 / 437 处使用 / missing 0。
- `npm test` 92/92；`npm run check` 全绿；7903 冒烟 63/63、安全探针 25/25、
  doctor 8/0/0；包 77 文件 / 约 2.4MB。
- Node `22.13.0` 下复跑 92/92、release-check 全绿；npm 1.2.1 tarball 反查含
  `docs/troubleshooting.md`、`docs/assets/bench-20k.jpg`，README 中英均有故障排查入口。
- **发布**：npm latest 1.2.1，`dist.shasum` `8cc8487a486efe5aebb66eb4642168ee048d4078`；
  registry 干净安装 `--version`=1.2.1、doctor 8/0/0；unpkg `@1.2.1/market/index.json`
  200，`parseMarketIndex` 通过，`marketInstallTarget`=`dsh-memory-nebula@1.2.1`。
- GitHub commit `74c7e903…`（CI 三 job success）；Release v1.2.1（id 441218432）
  已上传 tgz 与 `.sha256`。

## 1.2.0（2026-11-11）两万条

- **20k 建图**：`node --expose-gc scripts/bench.mjs --nodes 20000 --json` →
  **2.53s**、20,000 节点 / **156,993 边**、0 孤立、平均度 15.70；
  检索 8.8ms、体检 1.47s、快照 158ms / 23.1MB；**heap 248MB**、RSS 2.3GB。
- **首屏**：`dev/bench-20k.html`（23.1MB）用 headless Edge `file://` 打开，
  从导航到统计条出现 **947ms（热缓存）/ 1.1s（热 profile 复测）**；
  全新 profile 首次打开（24MB 解析 + 磁盘读）**4.7s**；两种情况下 `performance`
  外部请求 0、`window.__nebulaErrors` 空。
- **20k 交互**：本地 recall 32ms（12 命中）；搜索框到 12 条结果 <150ms（不含测试等待）；
  首条详情 376ms / 731 字；证据链 1 跳 <1ms；体检看板 824 字、无异常。
- **10k 不回退**：1.23s / 78,593 边 / heap 131MB。
- **3D 守卫**：20k 点“星系”提示「超过三千条先在二维星云里看」，按钮回到星云，`#sky3d` 保持隐藏。
- **边界**：50k 仍是 280 边 / 49,567 孤立，**不支持**；20k 可以开 2D，不建议 3D。
- **实现**：`entityPairCap = n > 12000 ? 60 : 120`；关键词候选只累计 `kwCount`，
  `parts/why` 只在确定产出边时分配。
- **测试**：92/92 单测；release-check 全绿（含 1.2.0 构件）；smoke 63/63；安全探针 25/25。
- **包**：75 文件 / 2,300,396B，sha256 `da47b3675482473779ee1d3ed5b2d1c763beb1a3974bf8c15c528702bcb60a60`；
  干净安装 `--version`=1.2.0、`doctor --help`、`import` 导出正常。
- **registry 反查**：直接下载 npm 上的 1.2.0 tgz，sha256 与本地产物**逐字节一致**；
  75 文件，含 `market/`、`locale/`、`SECURITY.md`、`CONTRIBUTING.md`，不含 `test/` 或 `dev/`；
  manifest 有 `dsh.bundle`、`bin`、`exports`、`engines`，`dependencies` 为空。
- **published artifact E2E**：从 registry 装 1.2.0 后直接跑 `lib/standalone.mjs`（真实库，端口 7902）：
  `/ping` 2048 记忆 / 9931 连接；`/graph` v2 同规模；`/diagnostics` version 1.2.0；
  `/share` 200 / 2,973,207B，含 `__NEBULA_SNAPSHOT__`、无外部 script。
- **发布**：npm `latest=1.2.0`，dist.shasum `28229ac76e5dea3efcc8bdee26d6be0941eda6de`；
  fresh-cache 安装 1.2.0、doctor 8/0/0。
- **索引**：`https://unpkg.com/dsh-memory-nebula@1.2.0/market/index.json` 200，
  `parseMarketIndex` 通过（1 条 / 1.2.0），install target `dsh-memory-nebula@1.2.0`；
  icon / locale / 详情 / demo 图均 200。
- **GitHub**：commit `77a2ff53922b06a52b4a24a13539db3d1db2f72e`（88 文件），CI 三 job 全 success；
  Release `v1.2.0`（id 441159340）附 tgz 与 `.sha256`。

## 1.1.8（2026-11-11）钉住 Host

- **Host 围栏**：`isLoopbackHost` 接受 `127.0.0.1[:port]` / `localhost[:port]` / `[::1][:port]`；
  `evil.example`、`127.0.0.1.evil.example`、空 Host 均 403，且响应不含 `"ok":true`。
- **宿主围栏**：`registerRoutes(..., {connection})` 在读写入口调用
  `ctx.connection.requestRejection(req)`；401 提示「需要从 DSH 里打开」，403 提示 Host/Origin 不在可信范围。
  `lib/index.js` 的 `inject` 增加 `connection`，宿主版本拿得到这个服务。
- **测试**：92/92 单测（新增 Host 3 项 + 宿主 401 1 项）；
  `release-check` 全绿（含 1.1.8 构件断言）；`dev/security-probe.mjs` **25/25** 全过
  （新增非回环 Host / 伪造回环前缀 / localhost 可用）。
- **包**：75 文件 / 2,298,856B，sha256 `deddf7a569ab7251e3a077fa83354ad0122cd4d603d2d58dd822a27578ef29cc`；
  干净安装 `--version`=1.1.8、`doctor --help` 正常；包内文档不写自身哈希。
- **发布**：npm `latest=1.1.8`，dist.shasum `5a2228d72c092c599788dcedbbcbf1bd0faa607b`；
  registry 安装 1.1.8。
- **边界变化**：把端口通过反向代理/内网穿透暴露出去时，Host 不是回环名会被 403；
  这是有意收紧，星图不为该场景设计。

## 1.1.7（2026-11-11）看得见

- **README 图片**：`README.md` / `README.en.md` 的 6 / 5 张截图全部改为
  `https://raw.githubusercontent.com/.../main/docs/assets/...` 绝对地址；
  `release-check` 新增 1.1.7 构件断言（绝对图片、英文入口、license 链接）。
- **测试**：90/90 单测；`release-check` 全绿（含 1.1.7 构件）。
- **打包**：75 文件；字节数与 sha256 以同目录 `npm pack` 产物与 `.sha256` 为准
  （包内文档不写自身哈希，避免重打包后自相矛盾）。
- **干净安装**：`--version`=1.1.7，`import` 导出 `memory-nebula 1.1.7 function`，
  `doctor.mjs --help` 正常。
- **发布**：npm `latest=1.1.7`，dist.shasum `9352688f3ef648740a6e375f2dd3bdf18864d217`；
  registry 安装 `--version`=1.1.7，doctor 对真实 profile 8 通过 / 0 提醒 / 0 失败。
- **远程索引**：`https://unpkg.com/dsh-memory-nebula@1.1.7/market/index.json` 200；
  `parseMarketIndex` 通过（format 1 / 1.1.7），`marketInstallTarget` 返回
  `dsh-memory-nebula@1.1.7`；图标、locale、市场详情、demo 图均 200。
- **GitHub Release**：`v1.1.7`（id 441002370），附 tgz 与 `.sha256`；
  源码 commit `33717ce`，CI 三 job（run 42915230687）全 success。
- **包**：75 文件 / 2,295,102B，sha256 `9b17991d7fe4c832641c4e650a7fb0f304a7feb207950bbce0f7e4bc761510aa`。

## 1.1.6（2026-11-11）支持接口

- **诊断 JSON**：`GET /diagnostics?format=json&demo=1` 返回 `application/json`，
  `product=memory-nebula`、`demo=true`、`graph.nodes=64`、`content=none`，无 `dbPath`。
- **英文说明**：`GET /diagnostics?demo=1&lang=en` 含 `contains no memory text`，
  `mode: standalone (demo)`；字段名保持英文，便于脚本。
- **CLI**：`node lib/standalone.mjs --diagnose --json --lang en` 输出单行 JSON；
  本次实测 2005 记忆 / 9667 连接 / 9 工作区 / 73 会话，建图 513ms，退出 0。
- **回归**：90/90 单测；`release-check` 含 1.1.6 构件断言。
- **发布后回归**：1.1.6 从源码起 7899，doctor（desktop profile + endpoint）9 通过 / 0 提醒 / 0 失败；
  `scripts/smoke.mjs` 63/63；`dev/security-probe.mjs` 21/21。
- **网页**：诊断说明行走 `T()`，英文界面复制出的报告不再混中文说明。
- **打包**：75 文件 / 2,294,090B；sha256 `55b41bae92a8a0806e1dda4ffe2ded5e83da0b3d8551b1b7ddd50acc2851a6c8`。
- **发布**：npm `latest=1.1.6`，registry shasum `863e524d8fa71791b963378c512930185d90b575`；
  registry 安装 `--version`=1.1.6，doctor 对真实 profile 8 通过 / 0 提醒 / 0 失败。
- **远程索引**：`https://unpkg.com/dsh-memory-nebula@1.1.6/market/index.json` 200；
  `parseMarketIndex` 通过（1 条 / 1.1.6），`marketInstallTarget` 返回 `dsh-memory-nebula@1.1.6`。
- **GitHub Release**：`v1.1.6`（id 440941512），附 tgz 与 `.sha256` 两个资产。

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
- **GitHub Release**：`v1.1.5`（id 440874892），附 tgz 与 `.sha256` 两个资产。

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
