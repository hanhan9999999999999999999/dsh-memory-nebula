# 分发与支持

这份文档写给三种人：给自己装插件的人、给客户部署的人、在发布前做检查的人。
每一项都尽量给一条能复制执行的命令；没有仓库地址的地方不编造 URL。

## 包是什么

- npm 包名：`dsh-memory-nebula`
- 当前版本：`1.6.2`
- 形态：DSH 插件（`cordis.patch.yml` + `lib/client.js`）与独立引擎（`lib/standalone.mjs`）共用一套代码
- 许可：MIT；没有授权锁、没有遥测、不会把记忆上传到任何服务器
- 包内容：`lib/`、`scripts/`、`docs/`、`cordis.patch.yml`、`README.md` / `README.en.md`、
  `CHANGELOG.md`、`LICENSE`、`sidecar.ps1`、`locale/`、`market/`；`test/` 与 `dev/` 不进包

## 安装

### 从 DSH 插件市场

在「插件 → 发现」里添加索引：

```text
https://unpkg.com/dsh-memory-nebula@1.6.2/market/index.json
```

搜索「记忆星图」安装。索引与详情页都在 npm 包里，由 unpkg 提供；不需要第二个站点。
条目声明 `engines.dsh >= 0.2.2-rc.1`，更老的 DSH 会显示不兼容而不是装完才崩。

### 从 tgz（离线/客户机器）

```powershell
# Windows PowerShell
Get-FileHash .\dsh-memory-nebula-1.6.2.tgz -Algorithm SHA256
# 对照同目录的 .sha256 文件；不一致就停，不要装

npm install .\dsh-memory-nebula-1.6.2.tgz --prefix <profile>
```

```bash
# macOS / Linux
sha256sum -c dsh-memory-nebula-1.6.2.tgz.sha256
npm install ./dsh-memory-nebula-1.6.2.tgz --prefix <profile>
```

然后确认 `<profile>/package.json` 里两处都在：

```json
{
  "dependencies": { "dsh-memory-nebula": "file:../../plugins/dsh-memory-nebula" },
  "dsh": { "profile": { "bundles": ["dsh-memory-nebula"] } }
}
```

只加 `dependencies` 不会让 DSH 重组插件；`bundles` 才是加载开关。改完重启 DSH，
从侧栏打开「记忆星图」。

### 装完先体检

```bash
node <profile>/node_modules/dsh-memory-nebula/scripts/doctor.mjs --profile <profile>
```

只读检查 Node 下界、包内关键文件、依赖、`dsh.profile.bundles`、`node_modules`
里的实际版本与 `cordis.patch.yml`。全 `[ok]` 再重启；`[warn]` 不阻断，但按提示补；
出现 `[fail]` 时退出码为 1，先处理再启动。接已运行的实例可加
`--base http://127.0.0.1:7891/api/memory-nebula`，自动化用 `--json`。


### 从源码目录（开发）

```powershell
New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-memory-nebula" -Target "<plugin>"
```

### 不装进 DSH，只跑独立引擎

```bash
npx dsh-memory-nebula --port 7890
# 或
node lib/standalone.mjs --port 7890 --root "D:\document\Memory Universe"
# 这台机器不只你一个人用 / 端口会被别的程序碰到：加一道本机口令
node lib/standalone.mjs --port 7890 --token "至少-12-个字符的口令"
```

启用 `--token` 后，终端会打印一次带 `?token=` 的地址；打开一次换到 cookie，之后正常用。
宿主模式不支持这个参数，使用 DSH 自己的 Host/认证围栏。

只绑定 `127.0.0.1`；不要做端口转发到公网。

同一支独立引擎也能只写快照、不启端口，适合 CI 或每日归档：

```bash
node lib/standalone.mjs --share ./nebula-$(date +%F).html
node lib/standalone.mjs --share ./work.html --scope ws:星港 --hide level:lesson
node lib/standalone.mjs --demo --share ./demo.html   # 示例库，不碰真实库
```

## 升级

1. 保留旧包：把当前 `dsh-memory-nebula-<旧版本>.tgz` 与 `.sha256` 放进 `releases/`。
2. 装新包：重复上面的 `npm install <新 tgz> --prefix <profile>`。
3. 重启 DSH（`lib/index.js`、`lib/host/http.js`、`lib/host/live.js` 是静态加载，不能热换）。
4. 打开页面，右上角 `?` →「复制诊断」，确认 `version` 是新版本、`build` 变了。
5. 如果页面顶部出现「宿主代码比页面旧」的横幅，说明宿主还在跑旧模块，重启或先用独立引擎。

## 回滚

```powershell
npm install .\releases\dsh-memory-nebula-<旧版本>.tgz --prefix <profile>
# 重启 DSH
```

回滚不改数据：`$DSH_HOME/memory-nebula/` 里的 `nebula.db`、`nebula.log`、
`engine/<stamp>/`、`injected/` 都是向后兼容的；新版写的 sidecar 旧版读不懂时会忽略，
不会删。若确实要清空插件自己的缓存（不碰记忆库）：

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\memory-nebula"
```

## 卸载

1. 从 `<profile>/package.json` 的 `dsh.profile.bundles` 去掉 `dsh-memory-nebula`；
2. `npm uninstall dsh-memory-nebula --prefix <profile>`（或用 junction 时删链接）；
3. 可选：删 `$DSH_HOME/memory-nebula/`。**不要删各工作区的 `.dsh-meow/memory.db`**，
   那是记忆本体，不归这个插件管。

## 支持流程

用户说「图打不开 / 少了很多记忆 / 3D 很卡」时，先要三样东西：

1. **诊断文本**：页面 `?` →「复制诊断」，或命令行 `node lib/standalone.mjs --diagnose`。
   里面有版本、构建、Node、系统、图规模、来源身份、最近错误；**没有正文，也没有本机路径**。
2. **日志尾**：`$DSH_HOME/memory-nebula/nebula.log` 最后 50 行。
3. **操作步骤**：宿主还是独立引擎、哪个工作区、是否刚升级、是否开了筛选/时间回放。

不要向用户索要 `memory.db` 或截图里的日记正文；诊断足够判断版本漂移、来源读失败、
空图与规模问题。

## 发布检查（维护者）

```bash
npm run verify          # 单测 + release-check；prepack 也会跑
node scripts/smoke.mjs http://127.0.0.1:7891/api/memory-nebula
npm pack                # 生成 tgz
sha256sum dsh-memory-nebula-1.6.2.tgz > dsh-memory-nebula-1.6.2.tgz.sha256
npm publish             # 需要维护者账号；本仓库不自动发布
```

发布前确认：

- `package.json`、`lib/web/app.js` 的 `APP_VERSION`、README 安装名、CHANGELOG 顶部版本一致；
- `docs/verified.md` 有这一版的实测数字；
- 包里没有 `test/`、`dev/`、`.tgz`、临时截图；
- `.sha256` 不写进包内文档（重打包会变），只放在发布目录。

## 市场文案（可直接用）

**一句话**：把 DSH 里散在各工作区的记忆只读抽成一张可交互的神经元星云，
支持扩散检索、证据链、范围快照与中英双语。

**三条卖点**：

- 不是搜索框：从一条记忆出发，沿已有连接看 2 跳内的邻居，每条边都能说出「凭什么」。
- 不是截图：整张图或一个工作区可以导出成单文件 HTML，双击就能看，断网也能查。
- 不是黑盒：9 个工具、HTTP 契约、安全边界、性能基准和每版实测都写在 docs 里。

**边界**（销售/支持必须一起说）：

- 只读查看器，不替用户改记忆；写操作只发生在插件自己的屏蔽/连线 sidecar。
- 本机单用户，没有账号系统；不要部署到公网。
- 3D 需要 WebGL2；超过 3,000 节点主动留在 2D。
- 未验证的平台见 `compatibility.md`，不要承诺「全平台」。
