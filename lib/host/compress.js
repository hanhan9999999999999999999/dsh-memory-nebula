/**
 * 响应压缩：1.8.0 开始，星图的大响应（/graph、/share、静态脚本）按 Accept-Encoding 压缩。
 *
 * 为什么值得单开一个模块：
 * - 真实库 2000+ 条记忆时 /graph 约 1MB，每换一次图整包重传；20k 时是 20MB。
 *   gzip 一般能到原大小的 15–25%，这是首屏最便宜的一刀。
 * - 快照是拿出去分发的文件（360KB+），服务端直接回压缩体，下载也快。
 * - 协商规则（q 值、`*`、`q=0`）容易被写错成「有头就压」，所以单独放一处、单独测。
 *
 * 只用 node:zlib，不引入运行时依赖（包一直是零依赖）。
 */
import { brotliCompress, gzip, deflate, constants as zlibConstants } from 'node:zlib'
import { promisify } from 'node:util'

const brotli = promisify(brotliCompress)
const gzipAsync = promisify(gzip)
const deflateAsync = promisify(deflate)

/** 小于这个字节数不压：压缩头和 CPU 都不划算，也免得小响应多出一次协商差异。 */
export const MIN_COMPRESS_BYTES = 1024

/** 偏好顺序：br 体积最小，其次 gzip（兼容性最好），deflate 兜底。 */
const ORDER = ['br', 'gzip', 'deflate']

/**
 * 解析 Accept-Encoding，返回该用哪种编码，或 null（不压缩）。
 * 规则按 RFC 9110：显式项优先于 `*`，q=0 表示明确拒绝。
 * @param {string|undefined|null} header
 * @returns {'br'|'gzip'|'deflate'|null}
 */
export function pickEncoding(header) {
  const raw = String(header || '').trim().toLowerCase()
  if (!raw) return null
  const quality = new Map()
  for (const part of raw.split(',')) {
    const fields = part.split(';')
    const name = fields[0].trim()
    if (!name) continue
    let q = 1
    for (const field of fields.slice(1)) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(field)
      if (m) {
        const n = Number(m[1])
        q = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
      }
    }
    // 同一个名字重复出现时取第一次（浏览器不会这么发，但代理可能拼出怪头）
    if (!quality.has(name)) quality.set(name, q)
  }
  const score = (enc) => (quality.has(enc) ? quality.get(enc) : quality.has('*') ? quality.get('*') : 0)
  let best = null
  let bestQ = 0
  for (const enc of ORDER) {
    const q = score(enc)
    if (q > bestQ) {
      best = enc
      bestQ = q
    }
  }
  return best
}

/** 这个响应类型值不值得压。JSON / HTML / 文本 / 脚本 / 样式 / SVG 都是文本。 */
export function isCompressibleType(contentType) {
  const type = String(contentType || '').toLowerCase()
  if (!type) return false
  if (type.startsWith('image/svg')) return true
  return /^text\//.test(type) || /(json|javascript|ecmascript|xml|wasm)/.test(type)
}

/**
 * 按编码压缩。encoding 为 null 时原样返回（调用方据此决定是否加 content-encoding）。
 * brotli 用质量 5：这台机器上 1MB JSON 约 12ms，质量 9 要 30ms+，体积只差几个百分点，
 * 交互式页面等不起。
 * @param {Buffer|string} body
 * @param {'br'|'gzip'|'deflate'|null} encoding
 * @returns {Promise<Buffer>}
 */
export async function compressBuffer(body, encoding) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  if (encoding === 'br') return brotli(buffer, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
  if (encoding === 'gzip') return gzipAsync(buffer, { level: 6 })
  if (encoding === 'deflate') return deflateAsync(buffer, { level: 6 })
  return buffer
}

/** 把已有 Vary 头和 accept-encoding 合并，不重复、不覆盖别人写的 Origin。 */
export function mergeVary(existing, extra = 'accept-encoding') {
  const set = new Set(
    String(existing || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  set.add(extra)
  return [...set].join(', ')
}
