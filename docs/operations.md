# 记忆星图 · 运维

这一册讲边界、装卸、热载、过渡期的独立引擎，以及版本与发布信息。

## 只读与边界

- 记忆库全部 `new DatabaseSync(path, { readOnly: true })`，从不写入。
- 自己的写入只有 `$DSH_HOME/memory-nebula/`：`nebula.db`（缓存）、`nebula.log`、
  `engine/`（热载副本）、`injected/`（注入账本）、`ingest/<provider>.jsonl`（推送条目）、`sources.json` / `inject.json`。
- 接口层只回显本机 Origin，写接口校验 `Origin` 与 `Sec-Fetch-Site`；细节见 `docs/security.md`。

## 热载

`LiveEngine` 递归枚举 `lib/host/**/*.js`（跳过 `node_modules`、`.` 开头目录、`live.js` 自身），
按 mtime 生成构建戳；一变就把这批文件复制到 `engine/<stamp>/` 再从新路径 `import`，等于换一套引擎，不用重启 DSH。
每次热载后只保留最近 3 个版本；import 失败按 2 的幂退避，上限 60 秒。

**热载不覆盖**：`lib/index.js`（入口）、`lib/host/http.js`（路由）、`lib/host/live.js`（热载本身）——
这三者是启动时静态加载的，改完必须重启 DSH 或改用独立引擎。判断方法：看 `GET /ping` 的 `build` 变没变。
`lib/web/*` 每次请求从磁盘读，刷新页面即生效。

## 装 / 卸

安装（示例：`profiles/desktop`）：

1. `New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-memory-nebula" -Target "<plugin dir>"`
2. profile `package.json`：`dependencies` 加 `"dsh-memory-nebula": "file:../../plugins/dsh-memory-nebula"`，
   `dsh.profile.bundles` 加 `"dsh-memory-nebula"`。
3. 卸载就反过来：移除两条声明 + 删 junction（记忆库不受影响）。

> `dsh.profile.bundles` 是关键触发点，只改 `dependencies` 不会让 DSH 重新组合 profile。

## 已知限制

- **宿主模块首次加载后不能热替换**（entry 级重载试过四条路都不行：删 bundles、改 config patch、
  改插件 patch id、加第二个 insert）。所以改 `lib/index.js` / `lib/host/http.js` / `lib/host/live.js` 仍需重启一次 DSH。
- **独立引擎不是热载的**：它是独立进程，`import` 一次就固定。改完引擎文件若还开着独立引擎，
  会出现「页面挑了较新构建、跑的却是旧代码」的错觉——改引擎后重启它，或 `sidecar.ps1 stop` 让页面回宿主。
- **会话转写**（`.jsonl.zstd`）尽力解析（多帧 zstd 手写帧头拆分），未知帧会跳过；结果在进程内缓存 5 分钟。

## 过渡期的独立引擎（sidecar）

宿主进程里那版 `index.js` 是插件刚装进来时加载的，之后对 `lib/host/*` 的改进它拿不到，而 DSH 又不能随意重启。
于是有一条独立通道：

```
node <plugin>/lib/standalone.mjs --port 7890            # 默认扫当前目录
node <plugin>/lib/standalone.mjs --port 7890 --root D:\work --log D:\logs\nebula.log
node <plugin>/lib/standalone.mjs --share D:\backup\nebula.html --scope ws:星港 --hide level:lesson
node <plugin>/lib/standalone.mjs --demo --share D:\backup\demo.html   # 示例库，不碰真实库
memory-nebula --help          # 装成 bin 之后
```

开关脚本（Windows 推荐）：`powershell -ExecutionPolicy Bypass -File <plugin>\sidecar.ps1 start|stop|status`。
`-Port` 默认 7890；`-Root` 默认当前目录；`-Node` 可指定 node.exe，否则依次找 PATH、常见安装位置、`$DSH_HOME/dsh-runtimes`。
`status` / `stop` 只认命令行里带同一个 `--port` 的进程，不会误杀别的实例。
引擎用 `--log` 自己写日志（`sidecar.ps1` 写到 `$DSH_HOME/memory-nebula/standalone.log`）。
不要用 PowerShell 的 `Start-Process -RedirectStandardOutput` 启它——Windows PowerShell 5.1 会挂住调用方直到进程退出。

- 与宿主插件同一套 `host/*`（同一个 `Nebula`、同一套路由），但进程独立、加载磁盘上最新代码。
- 只监听 `127.0.0.1`；端口越界、`--root` 缺值会明确报错并非零退出；`EADDRINUSE` 会提示换端口。
- `/ping` 带 `version / build / startedAt / mode / capabilities`；`mode` 为 `host` 或 `standalone`。
- 页面启动时先探宿主、再探独立引擎的 `/ping`，**取 `build` 较新的那条**，并把它写进 `NebulaAPI.base`；两边一样新时优先宿主；独立引擎自己的页面不再去探宿主。
- 宿主缺 `sources/bridge/ledger/ingest` 时页面顶部显示琥珀色横幅，给出「重启 DSH」或「启动独立引擎后刷新」两条路。
- 手工指定：`/api/memory-nebula/app?api=http://127.0.0.1:7890`。
- 停掉（Windows）：
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -like '*standalone.mjs*' } | % { Stop-Process -Id $_.ProcessId -Force }`
- 重启过一次 DSH 之后，宿主自己就是新代码（`build` 与 `capabilities` 齐全），独立引擎可以不用了。
- 跨端口调用按 loopback Origin 放行；公网 Origin 读不到（无 CORS）、写不进（403）。见 `docs/security.md`。

## 发布信息

- 版本 `1.4.1`，`license: MIT`，无运行时依赖。
- `files`：`lib/`、`cordis.patch.yml`、`README.md`、`README.en.md`、`docs/`、`CHANGELOG.md`、
  `LICENSE`、`scripts/`、`sidecar.ps1`。
- 装完先体检：`node scripts/doctor.mjs --profile <profile> [--root DIR] [--base URL] [--json]`；
  只读，warn 退出 0、fail 退出 1。
- 发布前跑 `npm run check && npm test`，再按 `docs/release.md` 的清单验一遍独立引擎与冒烟。
- 打包校验：以当次 `npm pack --dry-run` 输出为准（文件数、体积、shasum 记在发布记录里）。
