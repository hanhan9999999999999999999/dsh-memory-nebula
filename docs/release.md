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

```bash
cd <plugin>

# 1. 语法与静态检查（版本一致、UTF-8、import、死文件、CORS、document.write…）
npm run check

# 2. 单元测试（84 项，纯函数 + 契约）
npm test

# 3. 起一个干净实例，跑接口契约（63 项）
node lib/standalone.mjs --port 7893 --root <一个包含记忆库的目录>
node scripts/smoke.mjs http://127.0.0.1:7893/api/memory-nebula
npm run verify          # 单测 + 静态发布检查；npm pack 会通过 prepack 自动再跑一遍

# 4. 安全边界（21 项）
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
清单里应含 `sidecar.ps1`、`scripts/`、`test/` 不含（单测只在仓库里跑）、`dev/` 与截图不含。

装进 DSH profile（与 `docs/operations.md` 的 junction 方式二选一）：

```powershell
# 方式 A：本地目录（开发）
New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-memory-nebula" -Target "<plugin>"

# 方式 B：tarball
npm install <path>\dsh-memory-nebula-1.1.2.tgz --prefix <profile>
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
- 界面文案目前只有中文（`README.en.md` 是英文入口），没有做 i18n 资源表。
- 单文件快照是**时间点副本**：生成后真实库再变它也不会更新，也没有增量合并；包含全部正文，
  真实库较大时文件也大（1800 节点约 2.6MB，因为带全部正文）。快照在 `file://` 下运行，浏览器对本地文件的安全策略
  各不相同，但不依赖网络。
- 示例星系是内置的虚构数据，只用于「先看看长什么样」；它不参与真实统计，也不能写入。
