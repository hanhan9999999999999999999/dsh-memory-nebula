# 记忆星图 · 数据与连边

这一册讲「图里的点和线从哪来」。没耐心的可以直接看每节开头的表格。

## 数据从哪来

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| meow-memory | `<workspace>/.dsh-meow/memory.db` | 主数据源。表 `soul/user/project/fact/lesson/topic/rules`，共 7 层 |
| meow 会话账本 | `<workspace>/.dsh-meow/sessions/*.json` | `injected/searched/accessed/written` → 用来算「共激活」边（Hebbian） |
| 工作区注册表 | `$DSH_HOME/storages/workspace.json` | 发现所有工作区；再用「我的文档」与当前目录兜底扫一遍（`--root` 可追加） |

Hindsight（无 token）、OpenViking（只有上传队列）、seekmemory（只有日志）目前没有可读的本地记忆表，所以不进图。

## 边是怎么算的（精度优先）

每条边都带 `type` + `w`（0–1）+ 一句人能看懂的 `why`。权重是概率式 OR 叠加（`1-Π(1-w)`），不是相加。

| 类型 | 判据 | 权重 |
| --- | --- | --- |
| `explicit` | 主人手工 `nebula_link` 固化的连线 | 1.0，永不剪 |
| `entity` | 两边出现同一个「实体」：文件路径、URL、UUID、hash、`反引号代码`、文件名、邮箱、IP、版本号 | `0.26 + 0.68 × 稀有度`，上限 0.86 |
| `project` | 同一个 `project` 名，**且跨工作区**（同库同项目不连，避免刷屏） | 0.52 |
| `keyword` | 共享稀有 `keywords`（df ≤ 22% 且 ≤ 70 条）；共享 ≥2 且 Jaccard ≥ 0.16 | `0.3 + 0.4×min(1, jac×1.7)` |
| `semantic` | 稀有词签名（每节点最稀有的 26 个词）重叠系数 ≥ 0.18 且共同词 ≥ 4 | `0.12 + 0.6×sim`，上限 0.58 |
| `hebbian` | 同一会话里被一起注入/检索/访问（按会话长度做阻尼） | 共激活计数折算 |
| `mentions` | 记忆正文里**原样出现**了某个技能 / MCP / 插件的名字（边界匹配，`huashu-design` 不会被 `huashu-design-lite` 误判） | 0.92，不占记忆的度数配额 |

**来源节点**：技能（102）、MCP（7）、插件名字里真正被记忆提到过的，会各自变成一个 `level: 'source'` 的节点（当前 30 个），在 2D 里画成空心小菱形；同一个名字既是 MCP 又是插件时只做一个节点（按 MCP > 技能 > 插件认领）。**来源节点不另立工作区**，而是挂在「最常提到它的那个项目」下面——所以看某个项目里有哪些菱形，就知道这个项目在用什么技能。查这个名字（`nebula_recall("meow-memory")`）会先点亮来源节点，再由 `mentions` 边把「用过它的记忆」全带出来——这就是「记忆 ↔ 记忆源」的双向联动。没被任何记忆提到的来源不会出现在图里（宁缺勿滥）。

剪枝：全局贪心，按 `w + 跨工作区加成` 排序，**两端都还有额度**才收边；每个节点度 ≤ 16；`w < 0.3` 的边不进图。`mentions` 边和 `explicit` 边一样不受这条上限约束（来源是标签，不是记忆的邻居）。

**通用文件名的例外**：跨工作区时，`package.json` / `index.ts` / `app.html` / `server.mjs` / `README.md` 这类叶子名**不算实体证据**——两个项目各有一个 `package.json`，不代表讲的是同一件事。同一条记忆库内部仍然算（那是同一个文件）。这条规则单独救回 61 条「假的跨项目桥」。

实测（823 条真实记忆）：约 2800 条边，`entity 1980+ / keyword 780+ / project 77 / hebbian 9 / semantic 1`，平均度 6.8，孤立节点约 69，建图 ~250ms。
