# 记忆星图 · HTTP 接口

前缀固定为 `/api/memory-nebula`，只监听本机。JSON 响应带 `nosniff` 与
`referrer-policy: no-referrer`，默认 `cache-control: no-store`（`/graph` 与静态资源例外，见下）；
HTML 另带 CSP 与 `X-Frame-Options: SAMEORIGIN`。

## 约定

- 读接口：`GET`；写接口：`POST`（JSON body，上限 256KB）。
- 跨站规则见 `docs/security.md`：本机 Origin 回显 CORS；公网 Origin 读不到、写 403；
  无 `Origin` 的本机脚本可写（curl / 自动化）。
- **Host 必须是 `127.0.0.1[:port]` / `localhost[:port]` / `[::1][:port]`**；其它 Host 一律 403，
  用来挡 DNS rebinding。宿主内还会再过一遍 `ctx.connection.requestRejection(req)`（401/403）。
- **可选本机口令**：standalone 以 `--token <至少 12 字符>`（或 `NEBULA_TOKEN`）启动后，所有路由
  （含静态页、`/share`、`/export`、`/diagnostics`）都要求 `nb_token` cookie、`Authorization: Bearer`
  或首次 `?token=` 换取 cookie；否则 401。宿主模式不启用这个参数，继续用 `requestRejection`。
- 浏览器未带凭据打开 `/app` 时得到登录表单，不会只看到 JSON；表单提交到 `POST /unlock`
  （`application/x-www-form-urlencoded`，字段 `token`），正确时种 `HttpOnly` cookie 并 302 回
  `/app`，错误时留在表单上提示。API 与静态资源仍然返回 401 JSON，不参与表单流程。
- 错误体：`{ "error": "人话说明" }`；参数错误 400，找不到 404，请求体过大 413，未预期异常 500。
- 版本与构建：`/ping` 的 `version` 来自 `package.json`，`build` 是 `lib` 下全部 `.m?js` 的 mtime 最大值
  （改任何模块都会推进）。

## 传输：压缩、缓存与 HEAD（1.8.0 起）

- **压缩**：按 `Accept-Encoding` 协商 `br`（优先）/ `gzip` / `deflate`；只压文本类
  （JSON、HTML、JS、CSS、SVG、纯文本）且正文 ≥ **1024B**。压缩响应带
  `content-encoding` 与 `vary: accept-encoding`，`content-length` 是**压缩后**的长度。
  `q=0` 是明确拒绝，`*` 表示接受任意；都不接受时回 identity，不报错。
  涉及 `/graph`、`/share`、`/diagnostics`、`/export` 与静态资源；小响应不压。
- **缓存**：`/graph` 用弱 `ETag: W/"<sig>-<build>"` 与 `cache-control: no-cache`——
  浏览器可以存下来，刷新时带 `If-None-Match` 复验，命中回 **304**（无正文）；
  `sig` 变了自然换 ETag，不会拿到旧图。`/graph` 的 304 也带 `vary: accept-encoding`。
- **静态资源**：`cache-control: no-cache` + 强 `ETag`（mtime+size），复验命中 **304**；
  压缩结果按 `name:mtime:encoding` 在进程内缓存，改文件立刻失效。
- **HEAD**：按 GET 路由处理，返回同一组头与 `content-length`（压缩后长度），但**不写正文**；
  `HEAD /app`、`HEAD /graph`、`HEAD /style.css` 都可用。
- **超限请求体**：超过 256KB 回 **413** `{ "error": "请求体超过 256 KB" }` 并带
  `connection: close`；服务端先停读、把响应写完再断开，客户端拿到的是 413 而不是连接重置。
- **超长 URL / 请求头**：解析层（还没进路由）就判 >16KB 时回 **431**
  `{ "error": "请求头或 URL 太长" }` + `connection: close`；坏请求行/坏 chunk 回 400 同样带 JSON 原因。

## `GET /ping`

```json
{
  "ok": true,
  "version": "1.6.4",
  "build": 1794143336695,
  "startedAt": 1794143336695,
  "mode": "host",
  "capabilities": ["ping", "graph", "node", "recall", "path", "overview", "mutes",
                   "link", "unlink", "mute", "unmute", "bridge", "sources", "ingest",
                   "ledger", "export", "refresh", "demo", "share", "diagnostics"],
  "sig": "1779:8043:…",
  "builtAt": 1794143336695,
  "stats": { "nodes": 1779, "edges": 8043, "workspaces": 9, "sessions": 66 },
  "buildMs": 1320,
  "error": "",
  "demo": false
}
```

`mode` 为 `host`（DSH 宿主内）或 `standalone`（独立引擎）。页面据此判断版本漂移：
缺 `sources/bridge/ledger/ingest` 就在顶部显示横幅。`demo` 为 `true` 时表示这次读的是内置示例库。

## `GET /diagnostics`

纯文本（`text/plain; charset=utf-8`，`no-store` / `nosniff` / `no-referrer`），
给支持用：报告版本、构建、启动时间、模式、Node/系统/架构、PID/运行时长/RSS、
图规模、建图耗时、来源身份（`key/title/adapter/provider/size/kind`）、能力清单与最近错误。

**不读记忆正文，也不输出 `path` / `dbPath`。** 支持 `?format=json`（`application/json`，
字段与纯文本同源，适合工单系统）与 `?lang=en`（英文说明，字段名不变）。响应示例：

```text
memory-nebula diagnostics
# 不含记忆正文；可以整段贴给支持
version: 1.6.4
build: 1794276294467
started: 2026-11-10T02:20:37.399Z
mode: standalone
runtime: node v24.17.0 / win32 x64 / pid 24132 / up 3s / rss 230MB
graph: 1935 memories / 9170 links / 9 workspaces / 71 sessions
build: 492ms at 2026-11-10T02:20:37.504Z
sources: 9
  - DSHLive2D | DSH Live2D | meow / meow-memory | 745472B
capabilities: ping,graph,node,recall,path,overview,mutes,link,unlink,mute,unmute,bridge,sources,ingest,ledger,export,refresh,demo,share,diagnostics
lastError: none
```

`?demo=1` 返回示例库的报告（`graph: 64 memories`、`mode: … (demo)`），同样只读。

### 示例模式 `?demo=1`

所有只读接口都接受 `?demo=1`：`/ping`、`/graph`、`/node`、`/recall`、`/path`、`/overview`、
`/mutes`、`/sources`、`/bridge`、`/ledger`、`/export`、`/share`。示例库是进程内惰性创建的
独立 `Nebula` 实例（`new Nebula({ demo: true })`），不读盘、不写盘、不监听文件，
非 GET/HEAD 请求返回 **403**：

```json
{ "error": "示例模式是只读的：不会被改动，也不会写进你的记忆库" }
```

示例图固定为 64 节点 / 78 连接 / 6 工作区，`build` 与 `sig` 都来自真实构建过程
（`sig` 固定为 `demo-v1`），因此 ETag / 304 的行为和真实库一致。

## `GET /graph`

查询参数：`refresh=1` **看看有没有新东西**（指纹没变就不重建，页面加载与轮询走这条）；
`force=1` **强制重建**（1.11.25 起与 `refresh=1` 分开）；`limit`、`offset`、`sig` 用于分页（1.9.0 起）。

响应头带 `ETag: "W/<sig>-<build>"`；请求带 `If-None-Match` 且命中时返回 **304**（无 body）。
**分页的 ETag 会追加上 `-p<offset>-<limit>`**，整图与某一页不会互相 304。
body：`{ v: 2, version, build, demo, nodes: [...], edges: [...], stats, builtAt, page? }`。

分页契约：

- `limit` 取值 1–50000，缺省时超过 10000 的库只回前 **10000** 条；`limit=0` 视同缺省。
- `offset` 为非负整数。非整数（`1.5`）、负数、超上限一律 **400**，错误文案说明是哪个参数。
- 带 `sig` 且与本机当前图签名不符 → **409** `{ error: "图已更新，请从第一页重新加载", sig }`。
  名次会随重建而变，跨签名接着取下页必然串页，所以宁可让前端从第一页重来。
- 有分页时 `page = { total, offset, limit, next, order: 'importance' }`，`next` 为空表示到底了。
  排序是 `importance → degree → id`，同一份图内稳定。

边的编码：

- 两端都在本次响应里 → `{ s, d }`，`s`/`d` 是**本次 `nodes` 数组的下标**。
- 一端在本次响应、另一端在已加载的前页 → `{ a, b }`，用**节点 id**（前端合并时按 id 认）。
- 两端都不在 → 不发这条边；前端合并后按 `a|b|t` 去重，重复请求同一页不会长重边。

节点只带绘制字段，正文/关键词/邻居按需走 `/node`。

## `GET /node?id=<id>`

`{ node, neighbors, degree, cluster, mentions?, provenance? }`。
`neighbors` 每条带 `why`（连接证据）与权重；`mentions`/`provenance` 可能缺省。

## `GET /recall?q=<词>&limit=<n>`

`{ hits: [{ id, score, why, label, level, ws }], stats }`。`why` 是命中理由，不省略。

## 数字参数写错会回 400（1.11.63 起）

`limit` / `hops` / `chars` / `min_weight` 这类参数，以前是 `Number(raw) || 默认值`：
拼错静默按默认值跑，而 `Number('0') || 默认值` 会把 **0 也吞掉**（`/recall?hops=0` 其实一直按 2 跳跑）。
现在空值才用默认值，写错与越界一律 400，并说明期望范围：

| 路由 | 参数与范围 | 默认值 |
| --- | --- | --- |
| `/recall` | `limit` 1–50、`hops` 0–3（0 = 只要命中、不扩散） | 12 / 2 |
| `/path` | `hops` 1–8 | 6 |
| `/bridge` | `limit` 1–20、`chars` 1–4000、`min_weight` 0–1、`hops` 0–3 | 6 / 1600 / 0.45 / 1 |
| `/export` | `hops` 0–5 | 2 |
| `/graph` | `limit` 0–50000、`offset` 非负整数（这两个一直就是这么做的） | — |

错误体是 `{ error: "hops 需要 0–3 的整数，收到的是「abc」" }`。

## `GET /path?a=<id>&b=<id>&maxHops=<n>`

`{ found, nodes: [...], hops, score, edges: [...] }`；两点无边时 `found:false`。

## `GET /overview`

规模、工作区、层级、来源、会话数、体检计数等聚合数据，给左栏与看板用。

## `GET /mutes`

被屏蔽的关联对：`{ pairs: [{ a, b, at }], count }`。

## 写接口

| 路由 | body | 说明 |
| --- | --- | --- |
| `POST /link` | `{ a, b, weight? }` | 手工连一条边（策展，`curated: true`） |
| `POST /unlink` | `{ a, b }` | 删一条手工边 |
| `POST /mute` | `{ a, b }` | 屏蔽一对自动关联，重建也不再连 |
| `POST /unmute` | `{ a, b }` | 解除屏蔽 |
| `POST /refresh` | 无 | 先比指纹，变了才重建；与 `/graph` 同构返回，另带 `rebuilt` / `unchanged` / `why` / `refreshMs`（1.11.24 起）；`?force=1` 强制重建 |
| `POST /ingest` | `{ provider, items: [...] }` | 远端推送，落 `ingest/<provider>.jsonl` 后重建 |

`link`/`mute` 的端点不存在时返回 **404**（`missingNodes` 带 `status=404`）；`a`/`b` 缺失 400；
`ingest` 缺 `provider`、`items` 非数组 400，单次上限 5000 条。

### `GET /progress`（1.11.32 起）

建图期间的进度。**它不等待建图**——`/ping` 与 `/graph` 在冷启动时都要等图建完才应答，
所以页面不能用它们问进度，只能用这一条。

| 字段 | 含义 |
| --- | --- |
| `building` | 现在是不是在建图 |
| `progress` | `{ stage, label, step, total, nodes, ms, at }`，不在建图时是 `null` |
| `nodes` | 手上这张图有多少条（建完才有意义） |
| `stale` | 现在给的这张图是不是上一版（见 1.11.30 的 `stale`） |

阶段名固定为 `scan`、`nodes`、`df`、`sig`、`postings`、`cand`、`score`、`prune`、`sources`、`cluster`、`output` 之一。


### `GET /ping` 的 scale 与 `/overview` 的 warnings（1.11.34 起）

| 字段 | 在哪 | 含义 |
| --- | --- | --- |
| `scale.nodes` / `scale.edges` | `/ping`、`/progress`、`/overview` | 当前图的规模 |
| `scale.level` | 同上 | `ok` 或 `large`（默认 ≥150,000 节点算 large） |
| `scale.buildMs` | 同上 | 最近一次建图耗时 |
| `warnings[].code` | `/overview` | 现在只有 `large-library`，`message` 里写清条数与耗时，可直接展示 |

门槛可用环境变量 `NEBULA_LARGE_LIBRARY` 调整；探针靠它在一个小库上演出「库很大」这场戏。

### `GET /graph` 的 refreshing 与 stale（1.11.30 起）

| 字段 | 含义 |
| --- | --- |
| `refreshing` | 后端正在重建图；这一份是旧图，建完会换 |
| `stale` | 这一份来自过期缓存（签名对不上），后台已经排了一轮重建 |

两条都是「先给你这张，新的马上到」的说法，页面据此自己轮询 `/graph` 直到两者都为 false。

### `buildMs` 与 `cacheAgeMs`（1.11.47 起）

读盘恢复不是重建：`buildMs` 是**这一轮真建了多久**（恢复时为 0），
`cacheAgeMs` 是**手上这张图多大年纪**。两个字段都出现在 `GET /ping` 与 `GET /overview` 里。

```
GET /api/memory-nebula/ping     → { ..., buildMs: 0, cacheAgeMs: 43780, builtAt, stats }
```

以前恢复会把年纪写进 `buildMs`（20 万条上显示 43780ms，像刚建了 43 秒），
现在分开给，任何按 `buildMs` 判断「要不要等」的客户端都不会再被骗。

### `GET /overview` 的 hygiene / hygienePending 与 `GET /hygiene`（1.11.46 起）

`GET /overview` 默认**不再等体检**：有缓存就带上，没算过就给 `hygiene: null`、
`cards: null`，并加 `hygienePending: true`。要「算完再给」加 `?hygiene=1`（老行为）。

```
GET /api/memory-nebula/overview            → { stats, sources, ..., hygiene: null, cards: null, hygienePending: true }
GET /api/memory-nebula/overview?hygiene=1  → { ..., hygiene: {...}, cards: {...}, hygienePending: false }
GET /api/memory-nebula/hygiene             → { ok: true, hygiene: {...}, cards: {...}, at }
```

`/hygiene` 会分片算（20 万条约 9.6 秒），同一份图上并发调用共用一次计算，算完进缓存；
第二次是毫秒级。界面在 `hygienePending` 时会自己去取这一份。

### `GET /graph` 的两档刷新（1.11.25 起）

| 请求 | 语义 | 没变时的成本 |
|---|---|---|
| `GET /graph` | 不碰来源，直接给当前图 | 18ms |
| `GET /graph?refresh=1` | 比一次指纹，变了才重建 | **13ms**（5 万条库） |
| `GET /graph?force=1` | 不看指纹，重建 | 5.8 秒（该建就得建） |

前端首屏（`reload(false)`）与 12 秒轮询都用 `refresh=1`，所以「打开页面」不再等于「重建一次图」。

### 建完图会先热一次检索缓存（1.11.27 起）

`refresh()` / `POST /refresh` 成功之后，引擎会在 `NEBULA_PREWARM_DELAY`（默认 `1200` 毫秒）后，在后台把检索用的词频表算好；这张表只跟图对象有关，图一换就作废重算。

- 已经被检索算过的图直接命中，不重复劳动。
- 到点时若图已经被换掉、或正在建图，这次预热直接放弃（不阻塞、不重算旧图）。
- 预热失败不影响 `/recall`，只是下一次检索自己现算（5 万条约 1.3 秒）。

### 策展接口是就地的（1.11.26 起）

`POST /link`、`POST /unlink`、`POST /mute` 只改这一条边，**不再跟着做一次全量重建**（5 万条库上从 6 秒降到几十毫秒）。
`POST /unmute` 把当初删掉的那条原样放回；只有「放不回去」时才会退化成一次重建。
策展之后 `GET /graph?refresh=1` 不会重建（签名里的人工连线用「条数 + 排序后的 id 对哈希」，不再用时间戳）。

### `POST /refresh` 的三种结果（1.11.24 起）

`refresh()` 里本来就有「来源指纹没变就跳过」的分支，但路由以前一律传 `force: true`，
等于每次点击都全量重建。5 万条库上那是白付 5.5 秒。现在默认先比指纹：

| 响应字段 | 含义 |
| --- | --- |
| `rebuilt: true` / `why: "rebuilt"` | 真的重建了，`refreshMs` 是这次重建耗时 |
| `rebuilt: false` / `why: "unchanged"` | 来源一个字节都没变，直接把现有图还回去（实测 146ms，指纹比对本身 4ms） |
| `rebuilt: false` / `why: "joined"` | 刚好有一轮重建在进行，这一次等它的结果 |

`?force=1` 跳过指纹检查，永远重建（改过插件、怀疑缓存坏了时用）。
三种情况都带上完整的图，所以调用方可以照旧原地替换，不用分叉处理。
判定「没变」的指纹是：每个来源库的 size + mtime、会话账本目录的条目数与最新时间、
人工边与屏蔽的数量 —— 任何一项变了就会重建。

## `GET /sources`

`{ adapters: [...], sources: [...], byProvider, byAdapter, configPath, errors, stats }`。
`errors` 是读取失败清单；冒烟断言要求它为 0。

## `GET /bridge?...`

补充包：`memory_ids`（逗号分隔）、`query`、`limit`、`chars`、`min_weight`、`hops`。
返回 `{ items, stats }`，每条带证据与预览。

## `GET /ledger`

`{ dir, stats, sessions: [...] }`；账本目录在 `$DSH_HOME/memory-nebula/injected/`。

## `GET /export?format=md|json`

- `md`：给人看的报告（范围、规模、工作区表、层级表、枢纽、最强关联、孤岛）；
- `json`：给 AI 看的结构（`scope`、`stats`、`clusters`、节点按 degree 截断、边为 `[idA, idB, w, type]`、孤岛）。
- **范围**（1.5.1 起真正生效）：`scope=all`（默认）/ `ws:<工作区>` / `project:<项目>` /
  `focus:<节点 id>`；`hops=1..5` 只用于 focus，默认 2。切片后节点、边、度数、孤岛、
  `stats` 与 `clusters` 都按切片重算，不是把全图数字原样带出。
- 工作区/项目名大小写敏感，`scope` 不会整体转小写；空范围返回 **400**
  `{ "error": "这个范围里没有记忆：…" }`，未知节点同理。
- **参数拼错一律 400，不再静默按 `all` 导出**（1.8.0）：`format` 只认 `md` / `json`；
  `scope` 只认 `all`、`ws:<值>`、`project:<值>`、`focus:<值>`。`scope=zzz:nope`、`scope=xingang`
  （缺 `kind:`）、`scope=ws:`（缺取值）都是 400，避免「以为导了一个工作区、实际写了整库」。
- CLI 等价物：`node lib/standalone.mjs --export <file> --format md|json [--scope …] [--hops N]`，
  同一套校验，非法参数以 2 退出。

## `GET /share`

把当前星图打包成一个自包含 HTML 文件（内联样式、渲染脚本、三维引擎与全部正文），
用于离线查看与分享。

- `content-type: text/html; charset=utf-8`
- `content-disposition: attachment; filename="memory-nebula-snapshot-[ws-|project-|focus-]YYYY-MM-DD-HH-mm.html"`
  （范围导出带 `-ws-` / `-project-` / `-focus-` 后缀；时间为本地时间）
- `no-store`、`nosniff`、`no-referrer`；接受 `Accept-Encoding`，快照会压缩传输
  （示例库 420KB → br 约 113KB），下载后的文件仍是完整的 HTML。
- 支持 `?demo=1`（导出示例星图）
- **范围**：`scope=ws:<工作区>`、`scope=project:<项目>`、`scope=focus:<节点 id>`；
  `hops` 只对 focus 生效，默认 2，夹在 1–5。格式错误 400，范围为空 404。
  切片会重新编号节点与边，`stats` / `degree` / `clusters` / 体检按切片重算，
  `cards` / `truth` / `externals` 留空（它们描述整库，不属于这一片）。
- **隐藏**：`hide=level:<层级>`、`hide=ws:<工作区>`、`hide=project:<项目>`、
  `hide=status:<状态>`；可重复传，也可逗号分隔。白名单之外 400；隐藏后范围为空 404；
  焦点起点被隐藏 400。隐藏发生在范围切片之后，统计与体检只算剩余节点。
- **脱敏**：`graph.sources` / `overview.sources` 只保留名字与规模，不带本机 `path` / `dbPath`；
  `overview` 顶层也不含 `dbPath` 与 `lastError`。分享文件里没有本机路径。
- **切片上限**（1.9.0 起）：`limit` 默认 **20000**、上限 **50000**。超出时按
  `importance → hits → createdAt → id` 取前 N 条，`scope.trimmed = {cap, total, shown, by:'importance'}`，
  `scope.label` 追加「· 已裁剪 shown / total 条」，快照页面底部另有一条静态提示
  「这是一份裁剪过的离线快照：已写入 X / Y 条…」。拼错的 `limit`（`abc` / `0` / `60000`）一律 400。
  五万条的库实测：43.8MB → **16.6MB**（裁剪到 20000 条）。

快照里的 `window.__NEBULA_SNAPSHOT__` 含 `{version, build, builtAt, sig, graph, overview, inventory, scope}`，
`scope` 为 `{kind, value, label, hops, hidden, hide, nodes, edges, trimmed}`。节点带全文（仅范围内的节点）。页面检测到该全局变量后进入只读快照模式：搜索、详情、证据链在浏览器本地完成，
写接口、轮询与重建全部关闭。真实库 1800 节点约 2.6MB（含全部正文），生成耗时 ~0.3s。

- **完整性（1.11.0 起）**：载荷不再直接赋值，而是写在
  `<script type="application/json" id="nebula-snapshot-data">…</script>` 里，旁边的启动脚本
  把它解析成 `window.__NEBULA_SNAPSHOT__`，并记
  `window.__NEBULA_SNAPSHOT_INTEGRITY__ = {algo:'sha256', bytes, sha256}`。
  `sha256` 算的是**这段原始文本**（不是重新序列化的对象），所以键序与数字写法不会造成假报警。
  解析失败写入 `window.__NEBULA_SNAPSHOT_BROKEN__`，页面据此显示「读不出来，请重新导出」；
  摘要不符显示「文件被改动过或没下载完整 · 期望 … 实际 …」。`bytes` 与 `sha256` 都是服务端算的，
  客户端只做核对（`crypto.subtle`；不可用时退化为长度核对）。

## 静态资源

`GET`（或 `HEAD`）`/`、`/app`、`/index.html` → 页面；`style.css / app.js / api.js / render.js / space3d.js / i18n.js / nav.js` 白名单直出。
带 `ETag` 与 `cache-control: no-cache`，支持 304 与压缩（1.8.0）。
其它路径 404；`/../package.json` 之类不会穿越（白名单 + 前缀路由）。
