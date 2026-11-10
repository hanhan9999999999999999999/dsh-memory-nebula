# 兼容矩阵

最后更新：2026-11-11（1.1.4 医生版本漂移；1.1.5 示例不碰盘；1.1.6 诊断 JSON/英文；1.1.7 README 图片改绝对地址；运行前提未变）

这张表只写**真的跑过**的东西。「预期可用」是依据运行前提做的判断，不是实测；
没有出现的组合就是没有验证，不应当作支持承诺。

## 已验证

| 项目 | 实测 | 证据 |
| --- | --- | --- |
| 操作系统 | Windows 11 x64 | 本机全部开发与 0.5–0.9 验收 |
| Node.js | v24.17.0 | `node --version`；单测、冒烟、standalone、`--diagnose` |
| Node.js 22 LTS | v22.13.0 | 76/76 单测、release-check、63/63 冒烟、`--diagnose`（547ms） |
| DSH 桌面运行时 | `@deepseek-ai/dsh-desktop-runtime 0.2.2-rc.1` | 宿主内嵌页面、`/api/memory-nebula` 路由、热载 |
| 浏览器 | Microsoft Edge 157（headless，Chromium） | 0.5–0.9 的 CDP 截图与交互验收 |
| 2D 星云 | 1,945 条 / 9,229 条连接（真实库）；10,000 条 / 78,593 条连接（合成库） | 首屏 0.65–0.69s、draw 10–18ms，见 `benchmarks.md` |
| 3D 星系 | WebGL2（ANGLE / D3D11） | 三视图验收；>3000 节点主动留在 2D |
| 离线快照 | `file://`，无网络请求 | 0.6–0.9 快照验收，`performance` 资源请求为 0 |
| 窄屏 | 820×900、700×900，无横向溢出 | `dev/shot/narrow-*.png` 与 0.9 英文窄屏 |
| 数据来源 | meow-memory（`.dsh-meow/memory.db`） | 真实库 9 个工作区、71 个会话 |
| 适配器 | meow / notes / sqlite / ingest | 单测 + `sources`/`ingest` 冒烟 |
| 独立引擎 | `lib/standalone.mjs`，127.0.0.1:7890/7891 | 0.5–0.9 的 `smoke` 与 `--diagnose` |
| 安装体检 | 真实 desktop profile + 运行中实例 | 1.1.0：9 项全过（含 endpoint ping） |
| 市场索引 | `@deepseek-ai/dsh-plugin-market-index` format 1 校验 | 1.1.4：unpkg 索引 200，`parseMarketIndex` 通过，图标/详情/图片可解析 |

## 预期可用，但未实测

| 项目 | 依据 | 风险 |
| --- | --- | --- |
| macOS / Linux | 纯 Node + 浏览器，没有平台专属调用；路径处理用 `node:path` | 文件监听、junction/符号链接、sidecar 的 PowerShell 部分未验证 |
| Chrome / Edge ≥120 | 与 Edge 157 同源 Chromium；只用标准 Canvas/WebGL/DOM | 老版本可能缺 `:has()`、`structuredClone` 等；未逐个版本测 |
| 1440×900 – 2560×1440 | 布局用弹性尺寸，700px 已验证无溢出 | 超宽屏与系统缩放 150% 未逐档截图 |
| DSH 运行时更新版本 | 路由与 bundle 契约未变 | 宿主若改 `webServer.register` 或 bundle patch 格式，需要适配 |

## 明确不支持

- Node < 22.13（`engines` 会拒绝；语法与 API 也不保证）。
- 把端口暴露到局域网/公网：服务只绑 `127.0.0.1`，写接口只接受本机 Origin。
- 没有 WebGL2 的设备使用 3D 星系：会回落 2D；这是设计，不是缺陷。
- 超过 3,000 节点的 3D：会提示留在 2D，避免软件渲染卡死。
- 在 `file://` 快照里做写操作（连线、屏蔽、重建）：快照是只读副本。
- Safari / Firefox：未验证；`WEBGL_debug_renderer_info` 等诊断字段可能为空。
- 5 万条以上：未测；10k 的目标不自动外推到 50k。

## 判定方法

支持同学拿到用户环境时，先要一段诊断：

```bash
node lib/standalone.mjs --diagnose
# 或页面右上角 ? → 复制诊断
```

报告里没有记忆正文，只有版本、Node/系统、图规模、来源身份与最近错误。
把 `version`、`runtime`、`graph`、`sources`、`lastError` 对照上表，就能判断
是「组合没验证」还是「真的回归」。
