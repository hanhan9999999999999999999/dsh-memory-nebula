# 记忆星图 · HTTP 接口

前缀固定为 `/api/memory-nebula`，只监听本机。所有响应 `no-store`，JSON 额外带 `nosniff` 与
`referrer-policy: no-referrer`；HTML 另带 CSP 与 `X-Frame-Options: SAMEORIGIN`。

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

## `GET /ping`

```json
{
  "ok": true,
  "version": "1.6.2",
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
version: 1.6.2
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

查询参数：`refresh=1` 强制重建（等价 `POST /refresh`）。

响应头带 `ETag: "<sig>-<build>"`；请求带 `If-None-Match` 且命中时返回 **304**（无 body）。
body：`{ v: 2, version, build, demo, nodes: [...], edges: [{s,d,w,t,curated}], stats, builtAt }`。
`edges` 用节点下标（不是 id）；节点只带绘制字段，正文/关键词/邻居按需走 `/node`。

## `GET /node?id=<id>`

`{ node, neighbors, degree, cluster, mentions?, provenance? }`。
`neighbors` 每条带 `why`（连接证据）与权重；`mentions`/`provenance` 可能缺省。

## `GET /recall?q=<词>&limit=<n>`

`{ hits: [{ id, score, why, label, level, ws }], stats }`。`why` 是命中理由，不省略。

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
| `POST /refresh` | 无 | 重建图；与 `/graph` 同构返回 |
| `POST /ingest` | `{ provider, items: [...] }` | 远端推送，落 `ingest/<provider>.jsonl` 后重建 |

`link`/`mute` 的端点不存在时返回 **404**（`missingNodes` 带 `status=404`）；`a`/`b` 缺失 400；
`ingest` 缺 `provider`、`items` 非数组 400，单次上限 5000 条。

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
- CLI 等价物：`node lib/standalone.mjs --export <file> --format md|json [--scope …] [--hops N]`。

## `GET /share`

把当前星图打包成一个自包含 HTML 文件（内联样式、渲染脚本、三维引擎与全部正文），
用于离线查看与分享。

- `content-type: text/html; charset=utf-8`
- `content-disposition: attachment; filename="memory-nebula-snapshot-[ws-|project-|focus-]YYYY-MM-DD-HH-mm.html"`
  （范围导出带 `-ws-` / `-project-` / `-focus-` 后缀；时间为本地时间）
- `no-store`、`nosniff`、`no-referrer`
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

快照里的 `window.__NEBULA_SNAPSHOT__` 含 `{version, build, builtAt, sig, graph, overview, inventory, scope}`，
`scope` 为 `{kind, value, label, hops, hidden, hide, nodes, edges}`。节点带全文（仅范围内的节点）。页面检测到该全局变量后进入只读快照模式：搜索、详情、证据链在浏览器本地完成，
写接口、轮询与重建全部关闭。真实库 1800 节点约 2.6MB（含全部正文），生成耗时 ~0.3s。

## 静态资源

`GET /`、`/app`、`/index.html` → 页面；`style.css / app.js / api.js / render.js / space3d.js` 白名单直出。
其它路径 404；`/../package.json` 之类不会穿越（白名单 + 前缀路由）。
