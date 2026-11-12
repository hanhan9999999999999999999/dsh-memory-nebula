# 支持 / Support

## 先自查

1. 跑 `node scripts/doctor.mjs`（装了包就用包内路径）；它只读，不改 profile。
2. 看 [docs/troubleshooting.md](docs/troubleshooting.md) 的对应症状。
3. 搜一下现有 issue，避免重复。

## 提 issue 时带上

- `dsh-memory-nebula` 版本、DSH 版本、操作系统、Node 版本；
- 安装方式：精选目录 / tgz / 源码；
- `doctor` 的完整输出（它不含记忆正文和路径）；
- 复现步骤、期望结果、实际结果；
- 页面问题附截图；控制台错误附原文。

**不要贴**：记忆正文、`.npmrc`、token、私有路径。需要正文才能复现时，先用示例模式
（`?demo=1`）或自己造一条最小假数据。

## 安全漏洞

不要开公开 issue，走 [SECURITY.md](SECURITY.md) 里的 GitHub private advisory。

## 响应

这是 MIT 开源项目，按尽力而为处理，不承诺 SLA。需要商业支持/定制适配器，请在 issue 里
说明场景与时间要求，再单独约定。

---

For English: run `doctor`, read `docs/troubleshooting.md`, then open an issue with version,
OS/Node, install method, full `doctor` output, steps and expected/actual. Never paste memory
text, tokens, `.npmrc`, or private paths. Security reports go through `SECURITY.md`.
