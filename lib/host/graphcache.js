// 图缓存：把建好的图原样存到盘上，下次重启先问盘，省掉一整遍建图。
//
// 为什么存「原始记忆 + 邻居账本 + 投影」三样：
//   - 投影（graph）是界面直接要的；
//   - 原始记忆（nodes，带正文）与账本（ledgers）是检索、注入、策展要的；
//   - 体检、卡片、分页这些**派生物不存**：重算比读盘便宜，也免得盘上的结论过期。
//
// 为什么压缩：5 万条库的 JSON 是 164MB，brotli 后 4.6MB（实测 885ms），
// 盘上留 3 份也就是 14MB，而不是半 GB。
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompress, brotliDecompress, constants as zc } from 'node:zlib'
import { promisify } from 'node:util'
import { deserialize, serialize } from 'node:v8'

const brCompress = promisify(brotliCompress)
const brDecompress = promisify(brotliDecompress)

// 4 = v8 序列化（1.11.47 起）。3 = JSON + srcs；2 = 带 impl；1.11.30 及更早写的是 1。
// 为什么 4 用 v8 而不是 JSON：20 万条上同一份内容，JSON 读盘 4,118ms（解压 561 + parse 3,557），
// v8 读盘 3,683ms（解压 940 + deserialize 2,743），文件也从 17.33MB 降到 15.42MB。
// 旧格式不判死：readPacked 会先试 v8，失败再按 JSON 解析，v3 的老缓存照旧能读。
const VERSION = 4
const LEGACY_VERSION = 3
const KEEP = 3 // 盘上最多留几份；旧的多半只是「万一要回滚看」

// 建图算法的指纹：只认「输出会变的那些源码」。
//
// 为什么要有它：缓存只看来源签名（库的大小与时间戳）。来源没变、插件升了级、
// 边算法改了 —— 签名一模一样，盘上那份旧图会被一直当成正确答案，
// 用户永远看不到新算法算出来的关联。代价是一行 sha1，一次进程只算一次。
const IMPL_FILES = ['graph.js', 'text.js']
let implMemo = ''

export function implFingerprint() {
  if (implMemo) return implMemo
  try {
    const h = createHash('sha1')
    for (const name of IMPL_FILES) h.update(readFileSync(new URL('./' + name, import.meta.url)))
    implMemo = h.digest('hex').slice(0, 16)
  } catch {
    // 读不到自己的源码（被打包器换成别处）就说「不知道」，不因此把缓存判死。
    implMemo = 'unknown'
  }
  return implMemo
}

export function cacheName(signature) {
  const h = createHash('sha1').update(String(signature || '')).digest('hex').slice(0, 16)
  return 'graph-' + h + '.json'
}

/**
 * 来源集合的指纹：只回答「这份缓存是从哪些库里长出来的」。
 *
 * 为什么签名不够：签名里带着库的大小与时间戳，所以**别的库**永远对不上签名；
 * 1.11.30 的宽松路径（loadNewestGraphCache）就是借这一点把「盘上最新的一份」端出去。
 * 可是 DSH_HOME 只有一个缓存目录，本机好几个工作区共用它 —— 于是给一个临时库起服务时，
 * 端到端的却是**本机真实库**的图：条数不对、坏来源也不报错（1.11.33 修）。
 * 所以宽松路径必须再核一次「来源集合是不是同一批」。
 */
export function sourceSetKey(ids) {
  const list = (ids || []).map(String).sort()
  return createHash('sha1').update(list.join('\n')).digest('hex').slice(0, 16)
}

export function cacheDir(home) {
  return join(home, 'nebula-cache')
}

export function cacheEnabled() {
  return process.env.NEBULA_CACHE !== '0'
}

function cacheFile(dir, signature) {
  return join(dir, cacheName(signature) + '.br')
}

// 读盘：读不到、版本不对、签名不对、解压或解析失败，一律当「没有缓存」。
// 坏文件顺手删掉——留着只会在下次启动时再失败一遍。
export async function loadGraphCache(dir, signature) {
  const t0 = Date.now()
  const file = cacheFile(dir, signature)
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return null
  }
  const data = await readPacked(buf, file)
  if (!data) return null
  if (data.sig !== signature) {
    // 文件名是按签名取的，对不上说明这份文件不是这个签名的 —— 不能当它是对的。
    dropQuietly(file)
    return null
  }
  // 算法换过：这份图是旧逻辑算出来的，不能当成正确答案（但也不删：
  // loadNewestGraphCache 还可以先把它当「上一版」给你看，紧接着后台重建）。
  const impl = implFingerprint()
  if (impl !== 'unknown' && data.impl && data.impl !== impl) return null
  return finish(data, buf.length, t0)
}

/**
 * 1.11.30：读取「盘上最新的一份」，不在乎签名对不对。
 *
 * 签名一变（库里多了几条记忆）整份缓存就作废的话，重启又要白等五秒多重建——
 * 而盘上那份旧图对用户仍然是"上次看到的星图"，先给它、后台再重建，
 * 比一段空白等待好得多。调用方负责标出「这不是最新的」。
 */
export async function loadNewestGraphCache(dir, srcs) {
  const t0 = Date.now()
  let files = []
  try {
    files = readdirSync(dir)
      .filter((n) => n.startsWith('graph-') && n.endsWith('.br'))
      .map((n) => ({ n, p: join(dir, n), t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
  } catch {
    return null
  }
  for (const item of files) {
    let buf
    try {
      buf = readFileSync(item.p)
    } catch {
      continue
    }
    const data = await readPacked(buf, item.p)
    if (!data) continue
    // 来源集合对不上 = 这是别的库的图，不能端给用户（宁可重建一次）。
    if (srcs && data.srcs !== srcs) continue
    return finish(data, buf.length, t0)
  }
  return null
}

/**
 * 解压后的字节 → payload。先按 v8 解，不是 v8 写的（v3 及更早是 JSON）再退回 JSON.parse。
 * 两条路都只解压一次 —— 老缓存不该为「兼容」多付一次解压。
 * 抽成公开函数是为了测试与探针：它们要检验盘上那份文件，必须用同一套解码。
 * @param {Buffer} raw 已解压的字节
 * @returns {{data: any, legacyJson: boolean}}
 */
export function parseCacheBytes(raw) {
  try {
    const obj = deserialize(raw)
    if (obj && obj.enc === 'v8') return { data: obj, legacyJson: false }
  } catch {
    /* 不是 v8 的字节流，下面按 JSON 解 */
  }
  return { data: JSON.parse(raw.toString('utf8')), legacyJson: true }
}

/** 解压 + 解析 + 结构检查：坏了就把这个文件删掉，返回 null。 */
async function readPacked(buf, file) {
  try {
    const raw = await brDecompress(buf)
    const { data, legacyJson } = parseCacheBytes(raw)
    const wanted = legacyJson ? LEGACY_VERSION : VERSION
    if (!data || data.v !== wanted) {
      dropQuietly(file)
      return null
    }
    if (!data.graph || !Array.isArray(data.graph.nodes) || !Array.isArray(data.graph.edges)) {
      dropQuietly(file)
      return null
    }
    return data
  } catch {
    dropQuietly(file)
    return null
  }
}

function finish(data, bytes, t0) {
  return {
    nodes: data.nodes || [],
    ledgers: data.ledgers || {},
    graph: data.graph,
    sig: data.sig || '',
    impl: data.impl || '',
    srcs: data.srcs || '',
    builtAt: data.builtAt || 0,
    ms: Date.now() - t0,
    bytes,
  }
}

// 写盘：先写 .tmp 再 rename，中途断电也不会留下半截文件被下次当真。
// 写失败只记一笔，绝不影响这次建图。
export async function saveGraphCache(dir, signature, { nodes, ledgers, graph, impl, srcs }) {
  const t0 = Date.now()
  mkdirSync(dir, { recursive: true })
  const payload = {
    v: VERSION,
    enc: 'v8',
    sig: signature,
    impl: impl || implFingerprint(),
    srcs: srcs || '',
    builtAt: graph.builtAt || Date.now(),
    nodes: (nodes || []).map((n) => ({
      id: n.id,
      title: n.title || '',
      content: n.content || '',
      keywords: n.keywords || [],
      ws: n.ws || '',
      project: n.project || '',
      importance: n.importance || 0,
      updatedAt: n.updatedAt || 0,
      createdAt: n.createdAt || 0,
      status: n.status || '',
    })),
    ledgers: ledgers || {},
    graph: {
      nodes: graph.nodes,
      edges: graph.edges,
      stats: graph.stats,
      builtAt: graph.builtAt,
      muteCount: graph.muteCount || 0,
      // 簇（工作区围成的团）也要一起存：读盘恢复端出的是「上次建图那一刻」的图，
      // 少了 clusters，导出报告时 `.map` 撞上 undefined 直接崩，快照里的团也全没了（1.11.62 修）。
      // members 是下标数组，v8 + brotli 压得住。
      clusters: (graph.clusters || []).map((c) => ({
        id: c.id,
        title: c.title || c.label || '',
        label: c.label || c.title || '',
        size: c.size || 0,
        hue: c.hue,
        color: c.color,
        members: c.members || [],
        workspaces: c.workspaces || [],
      })),
      // 来源清单要一起存：它带着「哪个库读不动」这句诊断。
      // 只存图的话，读盘恢复时只能按当前来源反过来拼，拼出来的 error 全是空 ——
      // 于是重启之后坏来源既不进图、也不告示（1.11.33 修）。
      sources: (graph.sources || []).map((s) => ({
        key: s.key,
        id: s.id,
        adapter: s.adapter,
        provider: s.provider,
        title: s.title,
        path: s.path,
        size: s.size,
        db: s.db,
        error: s.error || '',
      })),
    },
  }
  const blob = serialize(payload)
  const packed = await brCompress(blob, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } })
  const file = cacheFile(dir, signature)
  const tmp = file + '.tmp'
  writeFileSync(tmp, packed)
  renameSync(tmp, file)
  prune(dir, file)
  return { ms: Date.now() - t0, bytes: packed.length, raw: blob.length, enc: 'v8' }
}

function dropQuietly(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    /* 删不掉就算了，下次还会当它不存在 */
  }
}

// 只留最近 KEEP 份：按 mtime 从新到旧，别的删掉。
function prune(dir, keepFile) {
  try {
    const all = readdirSync(dir)
      .filter((n) => n.startsWith('graph-') && n.endsWith('.br'))
      .map((n) => ({ n, p: join(dir, n), t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const item of all.slice(KEEP)) if (item.p !== keepFile) dropQuietly(item.p)
    // 半截的 .tmp 也顺手清掉（进程被杀时留下的）
    for (const n of readdirSync(dir)) if (n.endsWith('.tmp')) dropQuietly(join(dir, n))
  } catch {
    /* 清理失败不影响主流程 */
  }
}
