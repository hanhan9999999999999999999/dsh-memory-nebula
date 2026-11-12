# 测试与验收

> `dev/` 下的探针属于开发工作区（`D:\document\Memory Universe\dev\`），**不随 npm 包发布**；拿到插件的人跑第一～四节就够了。

三层自动检查 + 一层人工验收。前三层都能在干净仓库里跑，不依赖 DSH 正在运行。

## 一、单元测试：`test/`（100 项）

```bash
npm test
# 等价于
node --test "test/*.test.mjs"
```

用 Node 内置 `node:test`，无第三方依赖。覆盖纯函数与最容易回归的契约：

| 文件 | 断言 | 覆盖 |
| --- | --- | --- |
| `text.test.mjs` | 9 | 中文 bigram 分词、停用词、关键词归一化与解析、实体抽取（path/url/uuid/ref/file/email/ip/version/code/quote）、`clip`、`idf`、集合工具 |
| `graph.test.mjs` | 11 | 节点下标与边形状、相似度连边、孤岛、手工策展边权重 1、mute、空输入、`findNode`、体检六类、source 层不参与体检 |
| `path.test.mjs` | 6 | 同点 0 跳、优先高权重直连、绕行、跳数上限、不存在节点、无边图返回 `null` |
| `http.test.mjs` | 20 | loopback Origin 识别、公网/伪协议拒绝、CORS 回显与 `Vary`、`?demo=1` 只读与 ETag 304、`/share` 响应头与范围/隐藏参数、`/diagnostics` 纯文本与无路径、可选本机口令（cookie/Bearer/query）、前缀/版本/能力清单 |
| `demo.test.mjs` | 5 | 示例图规模与跨区桥、手工边/实体边、体检样本、Nebula 不读盘、详情/检索/证据链 |
| `share.test.mjs` | 14 | 单文件自包含、正文与 `</script>` 防护、尖括号转义、`$&` 保留、`<noscript>`/只读元信息、ws/project/focus 切片、hide 白名单与脱敏 |
| `i18n.test.mjs` | 7 | 字典非空、回退中文、语言优先级、applyDom、T/静态 key 全覆盖 |
| `diagnostics.test.mjs` | 3 | 报告结构、无 path/dbPath、文本不含盘符与库名、空图格式化 |
| `doctor.test.mjs` | 10 | 版本下界、包文件、profile 依赖/bundles/已安装、版本漂移提醒、口令 endpoint、warn 不阻断、文本/JSON 报告 |
| `market.test.mjs` | 3 | 市场索引版本/分类/标签、双语详情与图标存在、详情图片路径可解析 |
| `package.test.mjs` | 7 | 包身份与导出、`files` 不夹带测试、清单文件存在、死文件不再进包、CHANGELOG 与版本一致、Cordis patch、相对 import 可解析、运行时零依赖 |
| `standalone.test.mjs` | 4 | `--share` HTML 可打开且无外链脚本；非法 scope 退出 2；`--export` 按工作区输出 JSON；空范围退出 2 |

> 注意：`node --test test` 会把 `test` 当模块解析并报 `MODULE_NOT_FOUND`，要带 glob 或用 `npm test`。

## 二、接口契约：`scripts/smoke.mjs`（63 项）

随包发布，对**正在运行的实例**做只读断言 + 一次幂等探测（`POST /ingest {}` 只验证参数校验）。

```bash
node scripts/smoke.mjs
# 指向独立引擎或别的端口
node scripts/smoke.mjs http://127.0.0.1:7890/api/memory-nebula
# 不传参数时读 NEBULA_BASE，再退到 standalone 默认的 http://127.0.0.1:7891/api/memory-nebula
```

| 分组 | 断言 |
| --- | --- |
| `/ping` | 有 `stats`；有 `build` 指纹；`version` 与 `capabilities` 齐全 |
| `/graph` | `v=2`；`nodes>0`；`edges>0`；边是 `{s,d,w,t}` 下标形状；端点合法、权重 0–1；id 唯一；`stats` 与数组一致 |
| `/refresh` | 同样六项；与 `/graph` 规模差 ≤ 50（防止重算丢数据） |
| `/node` | `{node,neighbors,degree,cluster}`；挑 `degree>0` 的节点，邻居 > 0 |
| `/recall` | 有命中；每条约带 `why` |
| `/path` | 直接邻居能连上（`found`、`nodes≥2`、有 `hops/score`） |
| `/overview` | 带来源统计 |
| `/sources` | 适配器清单 ≥ 4；报配置文件位置；至少接一个来源；读过节点；**0 条读取错误** |
| 节点 `provider` | 每个节点都标了 `provider`；`byProvider` 计数与节点总数一致 |
| `/bridge` | `items/stats` 完整；每条带证据理由；不超条数预算；文本非空 |
| `/ledger` | 有 `stats` 与 `dir` |
| `/export` | `format=json` 结构完整；`format=md` 含 `# 记忆星图导出` 且有正文 |
| `/ingest` | 缺 `provider` 时返回 400 |

## 三、安全探针（25 项，开发机脚本，不进包）

`dev/security-probe.mjs`，对运行中的实例验证本机服务边界：

```bash
node dev/security-probe.mjs http://127.0.0.1:7890
```

断言：公网 Origin 读 `/ping` 不拿 `ACAO`；本机 Origin 回显并带 `Vary`；公网 Origin 写 `/refresh` 403；
`Sec-Fetch-Site: cross-site` 写 403；公网 `OPTIONS` 403；本机 `OPTIONS` 204；本机 Origin 写 200；
无 Origin 的脚本写 200；`/../package.json` 404；`nosniff / no-store / referrer-policy` 齐全。

## 四、发布静态检查：`scripts/release-check.mjs`

```bash
npm run check
```

不启服务、不联网：版本一致、UTF-8 无替换符、全部脚本 `node --check`、相对 import 可解析、
`lib` 无 `console`/`TODO`、无通配 CORS、无 `document.write`、死文件与必需文件齐全、
Markdown 相对链接存在、`index.html` 引用的资源存在。

## 五、万条性能基准：`scripts/bench.mjs`

```bash
npm run bench
# 或：node --expose-gc scripts/bench.mjs --nodes 10000 --json
```

确定性合成 10,000 节点 / 78,593 边，测建图、检索、体检、证据链、单文件快照与内存；
`--share-out <path>` 会写出一份 10k 快照，交给 `dev/cdp-bench.mjs` 测首屏。
目标线与实测见 `docs/benchmarks.md`——首屏 1.5s、建图 3s、检索 80ms、快照 2s、堆 300MB。

## 六、零代码接入的端到端验证（开发机）

`dev/adapters-e2e.mjs` 真的造两个新来源（2 个 md 笔记 + 1 个 SQLite 三行），写临时 `sources.json`，
断言：读得到、层级映射对、5/5 有边、`bridge` 能从新节点扩散出老记忆、`sourcesReport` 认出它们且 0 错误。
跑完自动删数据、恢复配置。

```bash
node dev/adapters-e2e.mjs
```

它比 smoke 更严格：smoke 验证「接口没坏」，它验证「别人拿到插件、只改 JSON 就能接进一个新记忆库」。

`dev/ingest-probe.mjs` 走成功路径：POST 两条 → 重建 → 来源出现 → 召回命中 → 删除临时 JSONL → 重建 → 来源消失，跑完自动清理。

## 七、真浏览器探针（`dev/`，不进包）

每个探针自己起一个 headless Edge、用独立 profile、跑完只杀自己那棵进程树
（`taskkill /pid <自己 spawn 的 pid> /t /f`）。**绝不要**按进程名杀 msedge——那会关掉人正在用的标签页。

共同约定：端口不重复；`--user-data-dir` 用独立目录；收集 `Runtime.exceptionThrown`，结束打印 `--- errors ---`。

| 探针 | 看什么 |
| --- | --- |
| `probe-muteboard.mjs` | 预置一条屏蔽 → 看板「屏蔽」页点恢复 → 列表清空 |
| `probe-timeout.mjs` | 只接受连接、永不回包：验证 12 秒超时与失败态文案 |
| `probe-rebuild2d.mjs` | 点重建后 `edges/passFilter/passReveal` 三关（曾经全变 0） |
| `probe-rebuild.mjs` | 3D 下重建，边数与 drawCount |
| `probe-spiral.mjs` | 时间螺旋下重建前后 |
| `probe-filter.mjs` | 筛选面板与画面是否同一口径；重建后筛选是否保留 |
| `probe-fold.mjs` | 左栏折叠与 localStorage 持久化 |
| `probe-export.mjs` / `probe-export3d.mjs` | 导出 PNG/JSON 的文件与结构；3D 下是否空图 |
| `probe-export-early.mjs` | 生长动画中途导出是否完整（`finishReveal`） |
| `probe-time*.mjs` | 时间条拖动、重建后重算、导出是否认 `filter.until` |
| `probe-health.mjs` | 体检列表、点行定位、搜索命中定位 |
| `probe-ui.mjs` / `probe-help.mjs` | 三档切换、搜索、命令面板、卡片、看板、主线、证据链、说明面板 |
| `probe-focus.mjs` / `probe-mouse.mjs` | Tab 焦点光环；中键不选中、右键纯平移、左键开详情 |
| `probe-lod.mjs` / `probe-responsive.mjs` | 拉远后点光斑下钻；1680→880 各宽度溢出与抽屉 |
| `probe-stress.mjs` / `probe-rm.mjs` / `probe-net.mjs` | 连切三档、`prefers-reduced-motion`、断网提示条 |
| `probe-copy.mjs` / `probe-search.mjs` | 复制 id/会话；搜索抬头、词标亮、空结果解释、Esc 还焦点 |
| `probe-draw.mjs` / `probe-perf.mjs` | 帧成本与首屏基线 |
| `console-probe.mjs` | 打开页面后收异常、error/warning 与 CSP 违规；干净时打印「控制台干净」 |
| `eval-probe.mjs` | 在真实页面里执行一段表达式并回读（验收 aria、版本号、内部状态） |

## 八、手工验收的最小清单

改完一轮，至少亲手点这七下：

1. 点「重建」——线还在，生长动画会重播一遍；
2. 切 `2`（星系）再切回 `1`——筛选还生效，画布不是空的；
3. 拉远到点变成光斑，点一个光斑——镜头飞进去，提示「已放大…」；
4. 拉右栏滑杆到 1000（时间）——图退回那天之前，计数跟着变；
5. 点「导出」→ PNG / JSON——图完整，JSON 的 `stats` 与画面一致；
6. 把窗口拖窄到 900 以下——顶栏还在、左栏变抽屉、详情不压搜索；
7. 刷新页面——视图、折叠、时间位置都还在。
