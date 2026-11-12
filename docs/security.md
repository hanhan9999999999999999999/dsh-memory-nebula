# 记忆星图 · 安全边界

这一册写清楚「谁能读到这张图、谁能改它、出了问题怎么验证」。星图只在本机跑，
但它读的是**全部记忆原文**，所以边界比一般本地工具更重要。

## 一、资产与写入面

| 资产 | 位置 | 说明 |
| --- | --- | --- |
| 记忆原文 | 各记忆插件自己的库（只读） | meow-memory 的 SQLite、任意 md/jsonl 目录、外部 SQLite |
| 星图缓存 | `$DSH_HOME/memory-nebula/nebula.db` | 建图结果与 meta，可随时删掉重建 |
| 注入账本 | `$DSH_HOME/memory-nebula/injected/` | 记录「哪些记忆被读过」，供补充包去重 |
| 推送条目 | `$DSH_HOME/memory-nebula/ingest/<provider>.jsonl` | `POST /ingest` 落盘 |
| 配置 | `$DSH_HOME/memory-nebula/sources.json`、`inject.json` | 来源与注入预算 |
| 调试 | `$DSH_HOME/memory-nebula/nebula.log`、`engine/` | 日志与热载副本 |

- 记忆库一律 `new DatabaseSync(path, { readOnly: true })`；星图**从不**写入别人的库。
- 写入只发生在上面列出的 `$DSH_HOME/memory-nebula/` 目录内。
- `/export` 只读；`/refresh` 只重建内存图与缓存；`/mute`、`/link` 改的是星图自己的元数据。

## 二、监听与来源

- 独立引擎只 `listen(port, '127.0.0.1')`，局域网内其它设备连不上。
- 宿主插件挂在 DSH 的 `webServer` 上，继承 DSH 的监听地址；DSH 默认也只在本机。
- 页面与接口同源，因此不需要跨域；跨端口场景（宿主页面 → 独立引擎 7890）按下面的规则放行。

## 三、跨站请求（CORS / CSRF）

| 情况 | 行为 |
| --- | --- |
| 读接口 + 本机 `Origin` | 回显该 Origin，附 `Vary: Origin` |
| 读接口 + 公网 `Origin` | 不发 `Access-Control-Allow-Origin`，浏览器读不到响应体 |
| 写接口（POST）+ 本机 `Origin` | 放行 |
| 写接口 + 公网 `Origin` | **403** |
| 写接口 + `Sec-Fetch-Site: cross-site` | **403** |
| 写接口 + 没有 `Origin`（curl / 脚本） | 放行——这是本机自动化的正常用法，不是浏览器跨站 |
| 公网 `OPTIONS` | **403**；本机 `OPTIONS` 204 |

「本机」= `http://127.0.0.1[:port]`、`http://localhost[:port]`、`http://[::1][:port]`。
实现见 `lib/host/http.js` 的 `isLoopbackOrigin` / `corsHeaders` / `allowWrite`。

### 本机口令（1.6.0，可选）

独立引擎可以加 `--token <至少 12 字符>`（或环境变量 `NEBULA_TOKEN`）。启用后，页面、静态资源、
API、`/share`、`/export`、`/diagnostics` 全部要凭据：`nb_token` cookie、`Authorization: Bearer`，
或第一次用 `?token=` 换 cookie。cookie 是 `HttpOnly; SameSite=Strict`，页面加载后会把 `?token=`
从地址栏历史里删掉。比较用 `timingSafeEqual`；短于 12 字符拒绝启动。

不传 `--token` 时保持原来的本地即开即用模型；宿主模式不使用这个参数，继续走
`ctx.connection.requestRejection` 与 Host 围栏。

### Host 围栏（1.1.8）

读接口同样不能只靠 Origin：GET 通常不带 `Origin`，恶意域名解析到 `127.0.0.1` 后浏览器会把
请求发到本机端口，Host 仍是被攻击者控制的域名（DNS rebinding）。

- 所有请求先过 `isLoopbackHost(req.headers.host)`：只接受 `127.0.0.1[:port]`、`localhost[:port]`、
  `[::1][:port]`；其它 Host（包括 `127.0.0.1.evil.example`）一律 **403**，静态页也一样。
- 宿主挂载的那一份再调用 `ctx.connection.requestRejection(req)`：由 DSH 做 Host/Origin 与
  已认证 Peer 的围栏；被拒时返回 401/403。独立引擎没有这个服务，只走 Host 白名单。
- 因此把端口通过反向代理、内网穿透暴露出去不再等于「只读页面可用」：Host 不是回环名就会被拒，
  星图也不为该场景设计。

> 这条边界的前提是「浏览器按 Origin 隔离」。如果把端口通过反向代理、内网穿透暴露出去，
> 代理会改写或剥掉 `Origin`，这套判断就失效了——星图也不为该场景设计。

## 四、页面侧

- 所有来自记忆的文本先 `esc()` 再进 DOM；正文高亮用「一遍 alternation」替换，
  不会把后插入的 `<mark>` 再当关键词匹配，也不会因为关键词里带 `mark` 生成嵌套标签。
- `index.html` 带 CSP：`default-src 'self'`，脚本/样式只允许同源与 `127.0.0.1:*`，
  图片允许 `data:`/`blob:`（导出画布），`frame-ancestors 'self'`、`base-uri 'none'`、`form-action 'none'`；
  另发 `X-Frame-Options: SAMEORIGIN`。
- 页面不使用 `eval` / `new Function`；静态资源只认 6 个白名单文件名，`/../package.json` 返回 404。

### 单文件快照与示例模式（0.5.0 / 0.6.0 / 0.7.0）

- `GET /share` 会把**当前星图的全部正文**内联进一个 HTML。它和 `/export` 一样是数据出口：
  独立引擎默认没有账号鉴权（能访问本机端口的人就能拿到），可用 1.6.0 的 `--token` 加一道本机口令；
  宿主挂载时则要过 1.1.8 的 `requestRejection`（Host/Origin + 已认证 Peer）。下载后的文件不再受本机服务保护，按「明文备份」对待。
- 快照里的数据经 `JSON.stringify` 后把 `<` 转义成 `<`，内联脚本里的 `</script` 也会被拆开，
  记忆正文无法提前闭合 `<script>`；快照页面同样先 `esc()` 再进 DOM。
- 示例模式（`?demo=1`）只读：所有非 GET/HEAD 请求在路由入口返回 403；示例实例不读盘、不写盘、
  不监听文件，也不会写注入账本。
- 0.6.0 起快照可以按范围切：`ws` / `project` / `focus` 只把范围内的节点正文写进 HTML，
  范围外的节点、边与体检结论不会进入文件。0.7.0 起 `graph.sources` 与 `overview.sources`
  只保留 `{key,title,size,kind,count}`，本机路径与 `dbPath` 不再写入；插件/技能/MCP 的**名称清单**
  仍会随 `overview.inventory` 带出，若项目名本身敏感，用 `scope` 收紧范围或加 `hide=project:<名>`。

### 诊断报告（1.0.0）

- 安装体检也按只读处理：doctor 只读 profile 的 `package.json`、`node_modules` 元数据与记忆库路径，
  不上传、不修改；`--base` 只 ping 本机端口。

- `GET /diagnostics` 与 `standalone --diagnose` 只汇总运行信息：版本/构建、系统/Node、
  PID/运行时/RSS、图规模、建图耗时、来源身份（key/title/adapter/provider/size）与最近错误。
- **不读记忆正文，不输出 `path` / `dbPath`**；`sources` 只有标题与体积，没有本机路径。
- 来源标题、插件/技能名称仍可能出现，贴给外部支持前先扫一眼；页面「复制诊断」也不会带正文。
- 独立引擎默认没有账号鉴权：能访问本机端口的人就能读；可加 `--token` 开本机口令，
  或在宿主内过已认证 Peer 的 `requestRejection`。
  它只降低泄漏面，不替代访问控制。

## 五、请求体与导入

- `readBody` 上限 256KB，超限 413；JSON 解析失败 400，不会退化成空对象继续执行。
- `/ingest` 单次最多 5000 条；`provider` 经 `slugKey` 与 `[^a-z0-9_-]` 清洗后才落成文件名。
- 缺 `provider`、`items` 不是数组 → 400。

## 六、威胁模型

| 攻击者 | 能否得手 | 说明 |
| --- | --- | --- |
| 恶意网页（同浏览器） | 读：不能（无 CORS + Host 围栏）；写：不能（Origin/写保护 403） | DNS rebinding 的 Host 不是回环名，1.1.8 起直接 403 |
| 局域网其它设备 | 不能 | 只绑 127.0.0.1 |
| 本机其它进程 / 同一用户 | **默认能；加 `--token` 后要口令** | 本机单用户模型；不传 token 时没有鉴权，能读文件就能读记忆库；token 只降低「本机端口被别人直接打开」的风险，不替代文件权限 |
| 记忆内容里的 HTML/脚本 | 不能执行 | 文本一律转义 + CSP；但仍会被当作普通文字显示 |
| 通过反向代理暴露端口 | **边界失效** | 见上文，不要这么做 |

## 七、怎么验证

```bash
npm test                      # 含 loopback/CORS 单测
npm run check                 # 静态检查（通配 CORS、document.write、UTF-8、语法）
node dev/security-probe.mjs http://127.0.0.1:7890
```

安全探针的 21 项断言见 `docs/testing.md` 第三节。改完 `lib/host/http.js` 必须重启宿主或独立引擎——
它是启动时静态加载的，热载不覆盖路由。

## 八、报告问题

发现绕过方式，请附：请求方法、路径、`Origin`/`Sec-Fetch-Site` 头、响应状态与头、复现脚本。
不要贴真实记忆原文；用 `docs/` 里的示例数据复现即可。
