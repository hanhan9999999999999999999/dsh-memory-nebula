# 记忆星图 · 检索与工具出口

这一册讲「怎么用这张图」：扩散激活的规则、九个工具的边界，以及每轮注入到底注什么。

## 一、检索：不是 top-k，是扩散激活

`nebula_recall` / `GET /recall`：

1. **种子**：查询词按覆盖率打分（`coverage^1.35`，语料里不存在的词不进分母，避免新词把命中率压成 0）。短查询门槛更高（0.5 / 0.34 / 0.2 三档递降）。
2. **扩散**：沿边传播，每跳 ×0.58，最多 2 跳，前沿宽度 110。
3. **跨工作区**：结果里**保证至少 2 条来自别的项目**（`across` 标记 + `why` 里写明），这样「项目 A 记住的 A」能把「项目 B 记住的 B」带出来。
4. **证据**：每条 hit 都带 `why`（直接命中 / 经由哪条记忆的哪种关联）和 `chain`。

`memory_ids` 参数接受别的记忆工具（meow / hindsight / openviking）刚返回的 id —— 这就是「检索 A 连带读出 B」的接口。id 可以是完整 id（`meow:MemoryUniverse:lesson:abc`），也可以是裸 uid（`abc`）。

## 二、补充包：`nebula_bridge`

`nebula_recall` 是「我说个词，你去找」；`nebula_bridge` 是「我已经有这几条了，还缺什么」。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `memory_ids` | `[]` | 刚注入/刚检索到的 id（别的插件给的也行） |
| `query` | — | 没有 id 时用它起种子 |
| `limit` | 4 | 最多给几条（上限受 `chars` 约束） |
| `chars` | 900 | 输出文本的字符预算，超了从尾部砍 |
| `min_weight` | 0.5 | 边权低于此值不算「强相关」 |
| `hops` | 1 | 扩散跳数（1 或 2；2 更远也更杂） |

打分（`lib/host/bridge.js`）：`能量 × (1 + importance×0.15) × (1 + min(heat,3)×0.08) × 状态系数 × 超连接惩罚 × 同工作区 1.08 × 久未访问 1.06`。

排除掉三类：**已经出现过的**（完整 id 与裸 uid 都查）、**冷却中的**（7 天内被别的会话注入过）、**边权低于阈值的**。

配额：每个工作区最多 2 条、每个层级最多 2 条（先紧后松 —— 候选不够时才放宽），避免四条全是同一个项目的同一种记忆。

每条输出长这样：

```
- 【教训·Memory Universe】手机端「不破禁」是四层叠加 —— 共享关键词："dsh"
```

返回体里还有 `stats`：`{seedCount, considered, picked, chars, hops}`。**`considered` 为 0 通常不是没数据，而是种子本身孤立**（新接进来的来源还没建边）。

## 三、九个工具

| 工具 | 作用 | 会不会写 |
| --- | --- | --- |
| `nebula_recall(query?, memory_ids?, limit?, hops?)` | 扩散检索，带证据 | 只读 |
| `nebula_bridge(memory_ids?, query?, limit?, chars?, min_weight?, hops?)` | 补充包：强相关但还没读过的邻居 | 写注入账本 |
| `nebula_inspect(id, neighbors?)` | 一条记忆的全文 + 每个邻居的「为什么相连」 | 只读 |
| `nebula_path(a, b, max_hops?)` | 两条记忆之间的最短证据链 | 只读 |
| `nebula_link(action, a, b, note?)` | `link` 固化 / `unlink` 斩断 / `mute` 屏蔽（重建也不再连）/ `unmute` 撤销 | 写星图库 |
| `nebula_stats(hubs?)` | 规模、分布、枢纽记忆 | 只读 |
| `nebula_hygiene(kind?)` | 六类体检：重复、该更新、关系凑数、超重、没人读、孤立 | 只读 |
| `nebula_sources(verbose?)` | 接了哪些来源、各自读到多少、哪条报错、怎么再接一个 | 只读 |
| `nebula_ingest(provider, items[])` | 远端记忆服务把条目推进来（写 JSONL 后自动重建） | 写 ingest/ |

`nebula_link` 的写只落在 `$DSH_HOME/memory-nebula/nebula.db` 的 `mutes`/`links` 表，**不会动任何记忆原文**。

## 四、每轮注入：注的是「还没读过的邻居」

`lib/index.js` 注册了一个 `systemPrompt.context`（name `memory-nebula:neighbors`，order 960）。

**第一段是稳定的用法说明**（那 7 行 RULE），每轮都在 —— 它不占多少字，但保证模型永远知道有哪些工具。

**第二段才是动态的**，条件是：

1. 本会话已经读过记忆（meow 账本 + 星图账本合并出的 `seen` 非空）；
2. 本轮数 `< maxRounds`（默认 2）；
3. 自上次注入以来，新增已读 ≥ 3 条（否则不打扰）。

满足时调 `nebula.bridge({ids: 最近 40 条已读, sessionId, ws: cwd})`，把挑出来的 1–4 条渲染成：

```
【与本会话已读记忆相连、但还没读过的】
- 【教训·Memory Universe】… —— 共享关键词："…"
```

### 账本

- `$DSH_HOME/memory-nebula/injected/<sessionId>.json`：本会话的 `seen`（谁、什么时候、被谁注入的）。
- `$DSH_HOME/memory-nebula/injected/_global.json`：跨会话冷却表，7 天。一条记忆被 A 会话注入过，B 会话一周内不会再被推。
- meow-memory 自己的 `sessions/*.json` 也会被读进来 —— 两边合起来才是「这个会话读过什么」。

### 调参

`$DSH_HOME/memory-nebula/inject.json`（可选，60 秒缓存）：

```json
{
  "maxRounds": 2,
  "maxItems": 4,
  "maxChars": 900,
  "minWeight": 0.5,
  "hops": 1,
  "perWorkspace": 2,
  "perLevel": 2
}
```

设 `maxRounds: 0` 就等于关掉动态注入，只留用法说明。

## 五、和其他记忆插件的关系

星图**不替代**任何记忆插件，它只做三件事：

1. **看得见**：把各家的记忆画在同一张图上（只读）；
2. **连得上**：算出跨工作区、跨来源的关联，且每条边带证据；
3. **补得准**：别的插件注入完，星图补「与这些相关的、还没读的」。

所以正确的用法是「一起用」：meow / hindsight / openviking 负责存取，星图负责关联与补充。接入新来源看 [`adapters.md`](adapters.md)，让别人的 AI 帮忙接入看 [`integration-guide.md`](integration-guide.md)。
