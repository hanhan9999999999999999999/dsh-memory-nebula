# 记忆来源适配器

星图不假设「记忆长什么样」。它只要求：**每个来源都能被读成同一种节点**。
把一种新的记忆存储接进来，就是写一个适配器；而大多数情况下，连代码都不用写。

---

## 1. 三条接入通道

| 通道 | 适合什么 | 要写代码吗 | 入口 |
| --- | --- | --- | --- |
| **pull（拉取）** | 记忆落在磁盘上：SQLite、目录里的 md/json/jsonl | 一般不用 | `sources.json` 里加一条 |
| **push（推送）** | 记忆在远端服务里，读不到磁盘（hindsight / openviking / 自建 API） | 不用 | `nebula_ingest` 工具 / `POST /ingest` |
| **bridge（桥接）** | 别人的记忆插件已经把记忆注入给模型了，你只想「补上关联的那几条」 | 不用 | `nebula_bridge` 工具 / `GET /bridge` |

三条通道的产物是同一张图：同一批节点、同一套边、同一份注入账本。
所以「meow 的记忆 + 笔记目录的记忆 + 远端推送的记忆」会互相连起来，而不是各算各的。

---

## 2. 节点：星图眼里的「一条记忆」

适配器读出来的每一条，都要变成这个形状（字段缺了有默认值，但 `id` 必须有）：

```js
{
  id: 'meow:memory-universe:lesson:abc123', // 全局唯一，稳定；相同 id 就是同一条记忆
  uid: 'abc123',                            // 可选：来源自己的 id（裸 id / 行 id）
  provider: 'meow-memory',                  // 来源插件名（展示、着色、筛选都按它）
  adapter: 'meow',                          // 哪个适配器读出来的
  ws: 'memory-universe',                    // 工作区键（聚类、筛选按它）
  wsTitle: 'Memory Universe',               // 工作区显示名
  level: 'lesson',                          // soul/user/project/fact/lesson/topic/rules/note
  title: '建图必须走 normalizeGraph',
  label: '建图必须走 normalizeGraph',        // 图上那行短标签，一般取 title 前 42 字
  content: '……正文……',
  importance: 3,
  status: 'active',                         // active / stale / archived
  project: 'memory-nebula',
  subcategory: '',                           // project 层专用：overview/structure/...
  goal: '',                                  // topic 层专用
  keywords: ['建图', '规范化'],
  sessionId: '',                             // 产生它的会话
  hits: 0,
  createdAt: 1762500000000,                  // 毫秒时间戳
  updatedAt: 1762500000000,
  accessedAt: 0,
}
```

`level` 决定它在图上的颜色与筛选分组。自造层级不是不行，但会掉到「其他」里；
拿不准就用 `note`。

可选再给一条 **账本**（`{sessionId, kind, ids[], ws}`），表示某个会话读过/写过哪些记忆——
星图用它来算「同会话共读」这种边，也用来做注入去重。没有也能跑。

---

## 3. `sources.json`：零代码接入

位置：`$DSH_HOME/memory-nebula/sources.json`（Windows 默认 `C:\Users\Administrator\.dsh\memory-nebula\sources.json`）。
不存在也能跑：默认只用 meow-memory + 自动探测。文件坏了只记日志，不会让星图挂掉。

```json
{
  "version": 1,
  "autoDetect": true,
  "extraRoots": ["D:\\document"],
  "disabled": {},
  "sources": [
    {
      "adapter": "sqlite",
      "path": "C:\\Users\\Administrator\\.my-memory\\store.db",
      "title": "我的记忆插件",
      "tables": { "fact": "facts", "lesson": "lessons" },
      "columns": { "title": "subject", "content": "body", "created": "created_at" }
    },
    {
      "adapter": "notes",
      "path": "~/.hindsight/knowledge",
      "title": "Hindsight 知识页",
      "level": "topic",
      "levelField": "type"
    }
  ]
}
```

- `autoDetect`：自动探测已知位置（`~/.hindsight/*`、`~/.openviking/*`、`~/.dsh/memories`、`~/.claude/memory`）。存在才接，不存在不吭声。
- `disabled`：按适配器或来源 id 关掉某一类，例如 `{ "meow": true }`。
- `sources[]`：每条至少给 `adapter` 和该适配器必需的字段；`enabled: false` 可临时停用。

改完不需要重启 DSH：下一次建图（`POST /refresh`、或星图自己检测到签名变化）就会生效。
配置读取有 60 秒缓存。

### 各适配器配置字段

| 适配器 | 必填 | 常用可选 |
| --- | --- | --- |
| `meow` | — | `extraRoots`（额外父目录数组）、`dirName`（默认 `.dsh-meow`） |
| `notes` | `path` | `title` `level` `levelField` `titleField` `keywordsField` `importanceField` `exts` `maxFiles` `maxDepth` |
| `sqlite` | `path` | `title` `tables` `table` `levelField` `defaultLevel` `columns` `where` |
| `ingest` | —（自动读 `$DSH_HOME/memory-nebula/ingest/*.jsonl`） | — |

`sqlite` 会自己猜列名：`title/subject/name/heading`、`content/body/text/memo`、
`keywords/tags`、`importance/weight/score`、`created/created_at/ctime`……
猜不到再写 `columns` 覆盖。

---

## 4. 写一个新适配器

目录：`lib/host/adapters/<name>.js`。它是热载范围，改完下一次建图就生效（不用重启 DSH）。

```js
import { readJsonSafe, slugKey, hashShort, toMs } from './util.js'

export const meta = {
  id: 'myplugin',
  name: '我的记忆插件',
  kind: 'file',                       // sqlite / files / api / file
  description: '一句话说清楚它接什么。',
  config: { path: '必填。数据文件绝对路径。' }, // 会显示在 nebula_sources 里
}

/** 按配置找出所有可读来源。必须返回数组；找不到就返回 []。 */
export function detect(config = {}) {
  const path = String(config.path || '')
  if (!path) return []
  return [{
    id: `myplugin:${slugKey(path, 'store')}`,
    provider: 'myplugin',
    adapter: 'myplugin',
    title: config.title || '我的记忆插件',
    path,
    key: slugKey(config.title || 'myplugin', 'store'),
    size: 0,
    mtimeMs: 0,
  }]
}

/** 把一个来源读成节点。永远不要抛：坏一条就少一条，不能让整张图挂掉。 */
export function scan(store) {
  const nodes = []
  try {
    const rows = readJsonSafe(store.path, []) || []
    for (const row of Array.isArray(rows) ? rows : []) {
      const title = String(row.title || '').trim()
      const content = String(row.content || '').trim()
      if (!title && !content) continue
      const uid = String(row.id || hashShort(title + content))
      nodes.push({
        id: `myplugin:${store.key}:note:${uid}`,
        uid,
        provider: 'myplugin',
        adapter: 'myplugin',
        ws: store.key,
        wsTitle: store.title,
        level: 'note',
        title,
        label: (title || content).slice(0, 42),
        content,
        importance: Number(row.importance) || 0,
        status: 'active',
        keywords: Array.isArray(row.tags) ? row.tags.map(String) : [],
        createdAt: toMs(row.createdAt),
        updatedAt: toMs(row.updatedAt),
      })
    }
  } catch {
    return { nodes, ledgers: [], error: '读 ' + store.path + ' 失败' }
  }
  return { nodes, ledgers: [] }
}

/** 体检：给 nebula_sources 用。不写盘、不抛错。 */
export function probe(config = {}) {
  const stores = detect(config)
  return { ok: stores.length > 0, stores: stores.length, note: stores.length ? '' : '按配置没找到数据' }
}
```

注册：在 `lib/host/adapters/index.js` 里 `import * as myplugin from './myplugin.js'`，
并加进 `ADAPTERS`。**这一步必须重启一次 DSH**（`index.js` 是静态加载）。

### 铁律

1. **只读**。所有记忆库以只读方式打开（`new DatabaseSync(path, { readOnly: true })`）。星图只写 `$DSH_HOME/memory-nebula/`。
2. **不抛**。`detect/scan/probe` 里任何失败都要吞掉并降级（返回 `[]` 或 `{nodes:[], error}`）。
3. **稳定 id**。同一条记忆每次跑出来的 `id` 必须一样，否则人工连线、屏蔽、注入账本全都会漂。
4. **别扫全盘**。`detect` 只探配置给的位置和已知默认位置；不要遍历 `C:\`。

---

## 5. 推送通道（远端记忆）

```js
nebula_ingest({
  provider: 'hindsight',
  items: [
    { uid: 'page-123', title: '记忆星图的注入策略', content: '……', level: 'topic', keywords: ['注入', '预算'], createdAt: 1762500000000 }
  ]
})
```

写进 `$DSH_HOME/memory-nebula/ingest/hindsight.jsonl`，**同 uid 后写覆盖**（重复推不会长重影）。
也可以用 HTTP：`POST /api/memory-nebula/ingest`，body 同上。

`appendIngest` 是给「别人的代码」用的入口：

```js
import { appendIngest } from '.../lib/host/adapters/ingest.js'
appendIngest('hindsight', items)
```

---

## 6. 验证

```bash
# 1) 来源体检（人看）/ 接口（AI 看）
nebula_sources({ verbose: true })
curl http://127.0.0.1:<port>/api/memory-nebula/sources

# 2) 强建一次图，看节点数有没有涨
curl -X POST http://127.0.0.1:<port>/api/memory-nebula/refresh

# 3) 确认新来源的节点进图了
curl "http://127.0.0.1:<port>/api/memory-nebula/graph" | jq '.nodes | group_by(.provider) | map({p: .[0].provider, n: length})'

# 4) 确认它和已有记忆连上了（这才是「接进来」而不是「堆进去」）
curl "http://127.0.0.1:<port>/api/memory-nebula/recall?q=<新来源里的一条标题>"
```

第 4 步返回的 `hits` 里如果出现别的来源的记忆，说明边已经长出来了。

---

## 7. 常见坑

- **Windows 路径**：JSON 里反斜杠要写两个（`C:\\Users\\...`）；`~` 可用，会自动展开成用户目录。
- **BOM**：`readJsonSafe` / `readTextSafe`（`adapters/util.js`）已经去 BOM，自己读文件记得也去。
- **层级名**：不认识 `level` 的节点照样进图，只是会落到「其他」筛选组；用 `note` 最稳。
- **超大库**：`notes` 默认最多 4000 个文件、深度 4；`sqlite` 单表默认全读，表超过十万行建议加 `where` 或先在 SQL 里聚合。
- **id 冲突**：不同来源的 id 必须带来源前缀（`meow:` / `sqlite:` / `ingest:`），否则会被当成同一条记忆合并。
- **改了 `adapters/index.js`**：这不属于热载范围，要重启 DSH。
