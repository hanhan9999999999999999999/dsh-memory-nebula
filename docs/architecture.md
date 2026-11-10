# 架构与不变量

这一册讲「东西放在哪、谁调谁、哪些规矩不能破」。想改代码之前先读这一页，比读 README 快。

## 一句话

宿主里的一个插件，把**所有能读到的记忆来源**（meow-memory 的 SQLite、任意笔记目录、任意 SQLite 表、远端推来的 JSONL）
算成一张带证据的图，用两个渲染器（2D 星云 / 3D 星系与时间）画出来；AI 侧通过九个工具查这张图，
并在别的插件完成注入之后，把「强相关但还没读」的邻居补进去。

## 进程与文件

```
DSH 宿主进程
└─ dsh-memory-nebula
   ├─ lib/index.js            入口：注册客户端、挂 HTTP 前缀、起 LiveEngine、注册 9 个工具、每轮注入
   ├─ lib/client.js           客户端注册（web 平台）
   ├─ lib/host/live.js        引擎热载（递归枚举 lib/host） + 12s 巡检
   ├─ lib/host/nebula.js      门面：发现来源 → 扫描 → buildGraph → 索引 / publicGraph / detail / bridge
   ├─ lib/host/adapters/      来源适配器（唯一需要为新记忆库改的地方）
   │   ├─ index.js            注册表 + 发现 + sources.json + scanAll + probeAll
   │   ├─ meow.js             <ws>/.dsh-meow/memory.db（7 层）+ sessions/*.json 活动账本
   │   ├─ notes.js            任意 .md/.jsonl/.json/.txt 目录（frontmatter → 字段）
   │   ├─ sqlite.js           任意 SQLite（列名自动猜，写操作直接拒）
   │   ├─ ingest.js           $DSH_HOME/memory-nebula/ingest/<provider>.jsonl
   │   └─ util.js             安全读盘、frontmatter、遍历、哈希
   ├─ lib/host/demo.js        内置示例星系（61 条虚构记忆 + 会话脉络 + 手工人边）
   ├─ lib/host/graph.js       建图、打分、剪枝、记忆体检（auditHygiene）
   ├─ lib/host/recall.js      扩散激活检索
   ├─ lib/host/bridge.js      补充包：种子 → 扩散 → 排除已读 → 配额 / 字符预算内挑选
   ├─ lib/host/ledger.js      注入账本（跨插件共用的「谁注入过什么」）
   ├─ lib/host/path.js        两点之间最短证据链
   ├─ lib/host/sources.js     环境清单（库 / 插件 / 技能 / MCP）
   ├─ lib/host/transcripts.js 会话台账（谁写了哪条）
   ├─ lib/host/text.js        分词、相似度
   ├─ lib/host/store.js       SQLite 只读打开 + 人工边 / 屏蔽 / 证据缓存
   ├─ lib/host/share.js       单文件快照：内联 web/ 资源 + 整张图（含正文）
   └─ lib/host/http.js        /api/memory-nebula/* 路由 + 静态文件（含 ?demo=1 与 /share）
```

数据目录（唯一可写的地方）：

```
$DSH_HOME/memory-nebula/
├─ sources.json      来源配置（自动探测 + 手工加来源都用它）
├─ inject.json       注入预算（不写就全用默认值）
├─ ingest/           远端推送的 <provider>.jsonl
├─ injected/         注入账本 <session>.json + _global.json（冷却表）
├─ nebula.db         人工连边 / 屏蔽 / 证据缓存 / 事件
├─ nebula.log        运行日志
└─ engine/<stamp>/   热载用的引擎副本
```

## 请求路径

```
浏览器 ── /api/memory-nebula/graph ──► http.js ──► nebula.publicGraph()
                                              └─►（需要重算时）refresh → adapters.scanAll → buildGraph → #buildIndex

会话 AI ── 每轮 systemPrompt ──► nebula.bridge({ ids: seen, sessionId })
                             └─► bridge.js 扩散 + 预算裁剪 ──► ledger.markSeen + markCooldown
```

`publicGraph()` 返回 **v2 形状**：`nodes` 是全量节点，`edges` 用**下标**指向节点
（`{s,d,w,t,curated}`），只为少传几十万个字符。客户端 `normalizeGraph()` 再还原成
`{a,b,w,t,curated}`，两种形状在客户端只留这一个入口。

## 前端模块

```
index.html
├─ space3d.js   3D：星系（力导）/ 时间（螺旋），WebGL 点云 + 标签层
├─ api.js       取图与形状归一；主/备两个 base 自动选新的
├─ render.js    2D：力导布局、LOD 聚合、生长动画、相机、边路径缓存
└─ app.js       状态与交互：applyGraph、筛选、详情、看板、搜索、导出、键盘
```

`index.html` 按普通 `<script src>` 顺序加载，静态文件由服务端 `no-store` 发出，改完刷新就生效；没有构建步骤。

## 不变量（改代码前先确认不会破）

1. **一种图形状**：所有取图路径（首屏 / 重建 / 轮询 / 换腿）都必须过 `normalizeGraph()`。
   曾经 `refresh()` 漏了这一步，结果点「重建」后一条边都不画。
2. **可见性只有一个真源**：筛选 `{ws,levels,types,providers,minW,minImp}` + 时间闸门 `timeCut` + 生长动画
   `reveal`。画面、计数、导出、标签都从 `visible()/visibleNodes()/visibleEdges()` 推，
   不许各自再写一套判断。
3. **两个渲染器同名能力**：`load / setFilter / visibleNodes / visibleEdges / highlight / select /
   fit / setPadding / resize`。切视图要重放筛选（两边的 hidden 是各自的）。
4. **缓存 key 覆盖所有影响输出的状态**：2D 边路径缓存用
   `cam + geoVersion + boxVersion + hiddenVersion + pump.ticks + highlight + selected + filter + w/h`。
   少一项就会出现「筛选换了、线还是旧的」。
5. **只读**：所有记忆库 `new DatabaseSync(path, { readOnly: true })`；自己的写入只落在
   `$DSH_HOME/memory-nebula/`。适配器拿到的 `where` 里出现 `insert|update|delete|drop|alter|…` 直接拒。
6. **热载边界**：`lib/host/` 下**所有** `.js`（含 `adapters/` 子目录）改完由 `LiveEngine` 自动换掉；
   `http.js / index.js / live.js` 是启动时静态加载，改它们必须重启 DSH。
   判断方法：看 `GET /ping` 的 `build` 指纹变没变。
7. **隐藏的东西不要量尺寸**：`display:none` 的 canvas 的 `getBoundingClientRect()` 是 0，
   量到 0 要直接返回，等它可见时再量（否则后备缓冲被钉成 1×1）。
8. **注入账本是公共事实**：`seen` 一旦写进 `ledger`，本会话不再重复注入；`_global.json` 的 7 天冷却
   跨会话生效。任何插件都可以写同一份账本，因此「别的插件已经喂过的」不需要靠猜。
9. **来源失败不致命**：任何一个 store 读失败只记进 `errors[]`，图照建、页面照开；
   `/sources` 必须能报出「哪个来源、哪条错误」。

## 静态资源

`http.js` 只放行 6 个白名单文件（`index.html / style.css / app.js / api.js / render.js / space3d.js`），
每次都从磁盘读，所以前端改动不需要重启；新增前端文件要同时改这个白名单。

## 独立引擎（过渡期）

`lib/standalone.mjs` 用同一套 `lib/host` 起一个独立 HTTP 服务（默认 7890，只绑 127.0.0.1），
`api.js` 先探宿主的 `/ping`，若同源已经是独立引擎就直接用；否则再探独立引擎，取 `build` 较新的一条。
两边一样新时优先宿主。两条腿的图与接口完全一致，所以前端只认 `/api/memory-nebula` 前缀，不关心后面是谁。
