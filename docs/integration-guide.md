# 接入指南（给 AI 看的）

> 这份文档的读者不是人，是**拿到插件的那个 AI**。
> 人只要说一句「把这个记忆插件和星图连起来」，你照着下面做完就行。不用问他要设计文档。

---

## 0. 先做三件事，别急着改代码

```
1) nebula_sources({ verbose: true })
   → 看清星图现在接了谁、各读到多少条、配置文件在哪、有哪些适配器。

2) 看对方插件的记忆存在哪里（三个问题）：
   a. 它有没有在磁盘上留数据库/文件？（去它的插件目录找 *.db / *.sqlite / *.json / *.md）
   b. 它是不是有 REST/HTTP 接口？（看它的插件入口有没有 fetch / server 路由）
   c. 它只是把记忆塞进 prompt？（看它有没有 systemPrompt.context / 注入类钩子）

3) 按 a/b/c 选通道：
   a 有落盘      → pull：在 sources.json 里加一条（多半零代码）
   b 有接口      → push：用 nebula_ingest 把它的条目推进来
   c 只进 prompt → bridge：让星图在它注入之后补上「相关联但没讲」的那几条
```

判断依据是**证据**，不是名字。判断完再动手。

---

## 1. 剧本 A：对方有落盘（最常见）

**先探清楚形状**：路径、表名/文件、有没有层级、有没有关键词、时间戳是什么格式。

SQLite：

```
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('PATH',{readOnly:true});console.log(d.prepare(\"select name,sql from sqlite_master where type='table'\").all())"
```

目录：

```
ls -R PATH | head -50
```

然后往 `$DSH_HOME/memory-nebula/sources.json` 里加一条并**保留已有内容**（这个文件是共享的，别覆盖别人的配置）：

```json
{
  "sources": [
    { "adapter": "sqlite", "path": "PATH", "title": "对方插件名",
      "tables": { "fact": "facts", "lesson": "lessons" },
      "columns": { "title": "subject", "content": "body" } }
  ]
}
```

文件笔记目录：

```json
{ "sources": [ { "adapter": "notes", "path": "PATH", "title": "对方插件名", "level": "note" } ] }
```

**验收**：

```bash
curl -X POST http://127.0.0.1:<port>/api/memory-nebula/refresh
curl "http://127.0.0.1:<port>/api/memory-nebula/graph" | jq '[.nodes[].provider] | group_by(.) | map({p:.[0],n:length})'
```

新 provider 出现且条数合理 → 成了。如果条数是 0，看 `/sources` 里的 errors，
多半是路径/列名不对，改 `columns` 再试。

---

## 2. 剧本 B：对方只有远端接口

不要试图去爬它的私有存储，直接用推送通道。

**一次性导入**（把它的条目读出来，批量推）：

```js
nebula_ingest({
  provider: 'hindsight',
  items: [{ uid, title, content, level: 'topic', keywords: [...], createdAt }]
})
```

**持续同步**：让对方插件的代码在写完记忆后调一次

```js
import { appendIngest } from '<插件目录>/lib/host/adapters/ingest.js'
appendIngest('hindsight', [{ uid, title, content, level, keywords }])
```

或者 HTTP：`POST /api/memory-nebula/ingest`，body `{ provider, items: [...] }`。

要点：
- `uid` 必须稳定（对方的主键），**同 uid 后写覆盖**，所以重复推是安全的。
- 别一次推几万条：先推最近 500 条，确认边长出来了再补历史。星图重建一次约 1.3 秒 / 1700 节点，推太多会让每次重建变慢。

**验收**：`nebula_bridge({ memory_ids: ['<对方的一条 id>'] })` 返回的 items 里
出现 meow 那侧的记忆 → 两个来源已经连上了。

---

## 3. 剧本 C：对方只会往 prompt 里注入

这种情况不用「接数据」，要做的是**注入协同**：它注入它的，星图补星图的，互相不重复。

机制（已经内置，通常不用改代码）：

1. 对方注入过的记忆会进「已见」集合（meow 账本 + 星图自己的注入账本 `injected/<session>.json`）。
2. 每轮对话，星图从「本会话已见」里挑最近的 40 条当种子，沿关联扩散一跳，
   去掉已见和冷却期内的，按预算挑 2~4 条，作为独立的一段注入。
3. 注入过的东西进冷却表，7 天内不再重复塞。

想让对方也参与去重，两种做法：

- **它写账本**：往 `$DSH_HOME/memory-nebula/injected/<sessionId>.json` 里
  写 `{ "seen": { "<uid>": <ts> }, "external": { "<uid>": <ts> } }`（合并写，别整个覆盖）。
- **它调 bridge**：注入前调 `GET /bridge?ids=<它准备注入的 id>&session=<会话 id>&mark=1`，
  拿到补充条目，一起注入。这就是「一同有选择地注入」。

调预算（`$DSH_HOME/memory-nebula/inject.json`，60 秒缓存）：

```json
{ "maxRounds": 2, "maxItems": 4, "maxChars": 900, "minWeight": 0.5, "hops": 1, "perWorkspace": 2, "perLevel": 2 }
```

- `maxRounds`：同一会话最多补几轮（防止一直塞）。
- `maxItems` / `maxChars`：条数与字符预算。
- `minWeight`：关联强度下限，低于它的不补。
- `hops`：扩散跳数，1 是「直接邻居」，2 更远更散。
- `perWorkspace` / `perLevel`：多样性配额，避免一口气全是同一个项目的教训。

---

## 4. 验收清单（照抄）

```bash
BASE=http://127.0.0.1:<port>/api/memory-nebula

curl -s $BASE/sources | jq '{stores: (.live.stores|length), providers: .live.byProvider, errors: .live.errors}'
curl -s -X POST $BASE/refresh | jq '.stats'
curl -s "$BASE/bridge?query=记忆&limit=3" | jq '.items | length'
curl -s "$BASE/export?format=json&limit=20" | jq '.nodes | length'
curl -s $BASE/ping | jq '{build, nodes: .stats.nodes}'
```

四条都通，说明：来源读到了、图建起来了、补充包能出条目、导出能给外部用。

再补一条**语义**验收（这条最重要，别跳）：

```
nebula_recall({ query: '<新来源里最独特的一句话>' })
```
返回的 `hits` 里，除了新来源自己，还应该有 meow 那侧的记忆。
**只有新来源自己 = 堆进去了但没连上**，回去检查关键词/实体是否能对上（两条记忆要有共同的关键词或标识才会连边）。

---

## 5. 排错

| 现象 | 多半是 | 怎么办 |
| --- | --- | --- |
| `/sources` 里 store 数为 0 | 路径写错 / JSON 反斜杠没转义 | 用绝对路径 + 双反斜杠；先 `ls` 确认文件在 |
| 条数对但全是「其他」层级 | `level` 不在白名单 | 加 `level` 或 `levelField`；拿不准写 `note` |
| 新来源的节点一条边都没有 | 文本里没有可匹配的关键词/标识 | 补 `keywords` 字段；或给它一个 `project` |
| `bridge` 永远返回 0 条 | 种子记忆本身没有邻居 / 全在冷却期 | 用 `query` 而不是 `ids`；或清 `$DSH_HOME/memory-nebula/injected/_global.json` |
| 改了代码没反应 | 碰到了静态加载的文件 | `index.js` / `http.js` / `live.js` / `adapters/index.js` 需要重启 DSH；其余是热载 |
| 重建很慢 | 节点太多（>5000）或某个来源读了巨量文件 | 给 notes 设 `maxFiles`；给 sqlite 加 `where` |

---

## 6. 你要交付给人的东西

做完别只说「好了」。给他三句话：

1. 接了哪些来源、各多少条（数字）。
2. 现在星图多大（节点/边/工作区），和接入前比涨了多少。
3. 一句提醒：**改过 `index.js` / `http.js` / `live.js` / `adapters/index.js` 的话，要重启一次 DSH 才生效**。

细节参考：`docs/adapters.md`（适配器契约与写新适配器）。
