/**
 * 文本工具箱：分词、实体抽取、哈希、停用词。
 *
 * 这里的所有函数都是纯函数、无 IO，方便单独跑测试。
 * 设计目标：中文靠 bigram（不需要分词词典），英文/代码靠标识符，
 * 然后在「稀有度」上做加权 —— 越少的词，越能证明两条记忆真有关联。
 */

/** CJK 统一表意文字区间。 */
export const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 英文停用词：太常见的词没有区分度，进关联只会制造误连。 */
const EN_STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'were', 'been',
  'but', 'not', 'you', 'your', 'they', 'them', 'their', 'have', 'has', 'had', 'will',
  'would', 'could', 'should', 'can', 'may', 'might', 'must', 'shall', 'than', 'then',
  'there', 'here', 'when', 'where', 'what', 'which', 'who', 'why', 'how', 'all', 'any',
  'each', 'both', 'more', 'most', 'some', 'such', 'only', 'own', 'same', 'other',
  'into', 'over', 'under', 'about', 'after', 'before', 'between', 'during', 'through',
  'true', 'false', 'null', 'undefined', 'none', 'void', 'this.', 'that.',
  'function', 'return', 'const', 'let', 'var', 'import', 'export', 'default', 'class',
  'async', 'await', 'type', 'interface', 'extends', 'implements', 'typeof', 'instanceof',
  'string', 'number', 'boolean', 'object', 'array', 'error', 'value', 'values', 'data',
  'name', 'names', 'item', 'items', 'list', 'index', 'length', 'node', 'npm', 'http',
  'https', 'www', 'com', 'org', 'html', 'json', 'test', 'tests', 'spec', 'true', 'false',
  'like', 'just', 'also', 'even', 'still', 'very', 'much', 'many', 'one', 'two', 'new',
  'use', 'used', 'using', 'get', 'set', 'add', 'put', 'run', 'make', 'made', 'see',
  'now', 'out', 'off', 'per', 'via', 'etc', 'eg', 'ie', 'yes', 'no', 'ok', 'okay',
])

/** 中文停用 bigram / 短语：同理，命中了也不算关联证据。 */
const ZH_STOP = new Set([
  '这个', '那个', '一个', '一些', '我们', '你们', '他们', '她们', '它们', '什么', '怎么',
  '可以', '因为', '所以', '但是', '然后', '现在', '已经', '如果', '还是', '或者', '以及',
  '关于', '没有', '不是', '就是', '这样', '那样', '时候', '一直', '还有', '而且', '并且',
  '之后', '之前', '里面', '上面', '下面', '比较', '非常', '特别', '应该', '可能', '觉得',
  '知道', '看到', '一下', '一点', '自己', '大家', '东西', '事情', '问题', '地方', '需要',
  '进行', '使用', '通过', '对于', '由于', '不过', '其实', '当然', '虽然', '然而', '于是',
  '于是', '这是', '那是', '这些', '那些', '这里', '那里', '本次', '目前', '同时', '另外',
  '用户', '系统', '功能', '内容', '方式', '情况', '部分', '方面', '结果', '过程', '时候',
  '主人', '小代', '码酱', '助手', '模型', '项目', '工作', '文件', '数据',
])

/** 这些词太泛，就算出现在两条记忆里也不该单独成边。 */
export const WEAK_KEYWORDS = new Set([
  'dsh', 'deepseek', 'harness', 'plugin', '插件', '技能', '配置', '测试', '代码', '实现',
  '修复', '问题', '功能', '优化', '设计', '开发', '运行', '更新', '修改', '需求', '任务',
])

/**
 * 把一段文本切成 token 集合：英文/数字标识符 + 中文 bigram + 中文短词。
 * 全部小写；不做词形还原（收益小于风险）。
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  const out = new Set()
  if (text === null || text === undefined) return out
  const lower = String(text).toLowerCase()
  const len = lower.length
  if (len === 0) return out

  // 单次扫描代替三条 matchAll 正则：中文内容动辄几百字，regex 的匹配开销
  // 在 1 万条记忆上会被放大到秒级。这里按字符区间手动切，行为与旧实现一致：
  // 英文标识符（含 _+#.-）、连续数字 ≥3 位、中文 bigram 与 2–8 字短词。
  let i = 0
  while (i < len) {
    const c = lower.charCodeAt(i)

    // a-z
    if (c >= 97 && c <= 122) {
      let j = i + 1
      while (j < len) {
        const d = lower.charCodeAt(j)
        if ((d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 43 || d === 35 || d === 46 || d === 45) j++
        else break
      }
      let w = lower.slice(i, j)
      w = w.replace(/[.\-+#]+$/, '')
      if (w.length >= 2 && !EN_STOP.has(w)) out.add(w)
      i = j
      continue
    }

    // 0-9
    if (c >= 48 && c <= 57) {
      let j = i + 1
      while (j < len) {
        const d = lower.charCodeAt(j)
        if (d >= 48 && d <= 57) j++
        else break
      }
      if (j - i >= 3) out.add(lower.slice(i, j))
      i = j
      continue
    }

    // CJK：㐀-䶿 / 一-鿿 / 豈-﫿
    if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) {
      let j = i + 1
      while (j < len) {
        const d = lower.charCodeAt(j)
        if ((d >= 0x3400 && d <= 0x4dbf) || (d >= 0x4e00 && d <= 0x9fff) || (d >= 0xf900 && d <= 0xfaff)) j++
        else break
      }
      const run = lower.slice(i, j)
      for (let k = 0; k + 1 < run.length; k++) {
        const bg = run.slice(k, k + 2)
        if (!ZH_STOP.has(bg)) out.add(bg)
      }
      if (run.length >= 2 && run.length <= 8 && !ZH_STOP.has(run)) out.add('«' + run + '»')
      i = j
      continue
    }

    i++
  }
  return out
}

/**
 * 关键词集合归一化：去空、去停用弱词、小写、去重。
 * @param {Iterable<unknown>} list
 * @returns {Set<string>}
 */
export function normalizeKeywords(list) {
  const out = new Set()
  if (!list) return out
  for (const raw of list) {
    if (raw === null || raw === undefined) continue
    const k = String(raw).trim().toLowerCase().replace(/\s+/g, ' ')
    if (k.length < 2 || k.length > 40) continue
    if (WEAK_KEYWORDS.has(k)) continue
    if (EN_STOP.has(k)) continue
    out.add(k)
  }
  return out
}

/**
 * meow-memory 的 keywords 列是 JSON 数组文本，容错解析。
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseKeywords(value) {
  if (value === null || value === undefined || value === '') return []
  if (Array.isArray(value)) return value.map((x) => String(x))
  const s = String(value).trim()
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed)) return parsed.map((x) => String(x))
    } catch {
      /* 落回逗号分隔 */
    }
  }
  return s.split(/[,，;；\n]/).map((x) => x.trim()).filter((x) => x.length > 0)
}

/** 实体类型权重：越「硬」的标识越能证明关联。 */
const ENT_WEIGHT = {
  path: 1.0,
  url: 0.95,
  uuid: 1.0,
  hex: 0.95,
  ref: 0.95,
  file: 0.8,
  code: 0.7,
  quote: 0.65,
  email: 0.9,
  ip: 0.85,
  version: 0.35,
  number: 0.2,
}

/** 实体抽取规则；顺序有意义：先抽长的，避免被短规则截断。 */
const ENT_RULES = [
  ['path', /[a-z]:[\\/][^\s"'`<>|,;，。；、）)\]】]+/gi],
  ['path', /(?:^|\s)(?:\.{1,2}\/|\/)(?:[\w.@-]+\/)+[\w.@-]+/g],
  ['url', /\bhttps?:\/\/[^\s"'`<>)\]]+/gi],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ['hex', /\b[0-9a-f]{12,64}\b/gi],
  ['ref', /\bm\d{5}\b/g],
  ['file', /\b[\w@.-]{1,64}\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|mdx|py|rs|go|java|kt|cs|cpp|cc|h|hpp|db|sqlite|sql|yml|yaml|toml|ini|cfg|sh|ps1|bat|cmd|exe|dll|so|dylib|zip|tar|gz|png|jpe?g|webp|gif|svg|css|scss|html|htm|txt|csv|tsv|xlsx|xls|docx|pptx|pdf|apk|ipa|dylib|uproject|uasset|unity|smali|dex|elf|bin|log)\b/gi],
  ['email', /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g],
  ['ip', /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/g],
  ['version', /\bv?\d+\.\d+\.\d+(?:-[0-9a-z.]+)?\b/gi],
]

/**
 * 从文本里抽「硬实体」。这些是记忆之间最可信的连接理由。
 * @param {unknown} text
 * @returns {Map<string,string>} entity -> type
 */
export function extractEntities(text) {
  const out = new Map()
  if (text === null || text === undefined) return out
  const s = String(text)
  if (s.length === 0) return out
  const lower = s.toLowerCase()

  for (const [type, re] of ENT_RULES) {
    re.lastIndex = 0
    for (const m of lower.matchAll(re)) {
      let v = String(m[0]).trim()
      if (v.length < 4) continue
      v = v.replace(/[.,;:)\]}"'`]+$/, '').replace(/\\+$/, '')
      if (v.length < 4) continue
      if (/^\d+\.\d+\.\d+$/.test(v) && type !== 'version') continue
      const key = type + '|' + v
      if (!out.has(key)) out.set(key, type)
    }
  }
  // 反引号里的代码片段：`xxx` —— 人写记忆时用来标「专有名词」
  for (const m of s.matchAll(/`([^`\n]{2,60})`/g)) {
    const v = m[1].trim().toLowerCase()
    if (v.length >= 2 && /[a-z\u4e00-\u9fff]/i.test(v)) out.set('code|' + v, 'code')
  }
  // 「」引号里的专名
  for (const m of s.matchAll(/[「『]([^」』\n]{2,24})[」』]/g)) {
    const v = m[1].trim().toLowerCase()
    if (v.length >= 2) out.set('quote|' + v, 'quote')
  }
  return out
}

/**
 * 拆出实体的类型（key 的前缀）与裸值。
 * @param {string} key
 */
export function splitEntity(key) {
  const i = key.indexOf('|')
  return i < 0 ? ['', key] : [key.slice(0, i), key.slice(i + 1)]
}

/**
 * 实体对关联的贡献权重：稀有 + 类型硬 = 强证据。
 * @param {string} key
 * @param {number} df 该实体在语料里出现过的记忆条数
 * @param {number} n 语料总量
 */
export function entityStrength(key, df, n) {
  const [type] = splitEntity(key)
  const base = ENT_WEIGHT[type] ?? 0.4
  const rarity = 1 / (1 + Math.log2(1 + Math.max(1, df)))
  const coverage = Math.max(0.05, 1 - Math.min(1, df / Math.max(8, n * 0.35)))
  return base * (0.55 + 0.45 * rarity) * (0.4 + 0.6 * coverage)
}

/** 32 位 FNV-1a：稳定哈希，用于配色与初始布局。 */
export function hash32(str) {
  let h = 0x811c9dc5
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 由字符串派生一个稳定的色相（0-360）。
 * @param {string} str
 */
export function hueOf(str) {
  return hash32(str) % 360
}

/**
 * 把哈希打成 [0,1) 的伪随机序列，用于稳定的布局种子。
 * @param {string} seed
 */
export function rngFrom(seed) {
  let a = hash32(seed) || 1
  return function next() {
    a ^= a << 13
    a >>>= 0
    a ^= a >> 17
    a ^= a << 5
    a >>>= 0
    return a / 4294967296
  }
}

/**
 * 截断长文本（按字符数），保留结尾。
 * @param {unknown} text
 * @param {number} max
 */
export function clip(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

/**
 * IDF 与余弦相似度用的小工具：给定文档频次表算 idf。
 * @param {number} df
 * @param {number} n
 */
export function idf(df, n) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5))
}

/**
 * 两集合的 Jaccard。
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const x of small) if (big.has(x)) inter++
  if (inter === 0) return 0
  return inter / (a.size + b.size - inter)
}

/**
 * 两个 Set 的交集大小。
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
export function overlapSize(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let n = 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const x of small) if (big.has(x)) n++
  return n
}

/**
 * 取交集。
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {string[]}
 */
export function intersect(a, b) {
  const out = []
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const x of small) if (big.has(x)) out.push(x)
  return out
}
