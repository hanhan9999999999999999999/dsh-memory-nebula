// 大图分页：把一张图按「重要度 → 度数 → id」的稳定顺序切片。
//
// 为什么需要它：5 万条时 /graph 一次性序列化整张图约 44MB（压缩后仍有数 MB），
// 浏览器要等整包到齐才能出第一帧。分页把「第一屏」压到 2 万条以内，
// 剩下的按需追加 —— 顺序必须稳定，否则两次请求之间节点会跳页。
//
// 这个模块只做纯计算，不碰 IO，方便单测。

/** 单页最多返回多少条（超过按 50000 截断，防止一次请求把内存打满）。 */
export const PAGE_MAX = 50000

/**
 * 没显式给 limit 时，大图第一页的上限；小于等于它的库行为不变。
 *
 * 为什么是 10000 而不是 20000：5 万条的整图 JSON 约 22MB，两万条的第一页仍有
 * 8.7MB（压缩后 ~1MB）；一万条约 4.4MB，首帧明显更早，而 1 万颗点已经足够
 * 看出整片星云的形状。剩下的按需点「继续加载」。
 */
export const FIRST_PAGE_MAX = 10000

/**
 * 稳定分页顺序：重要度高的先出现，其次度数高的，最后按 id 兜底。
 * @param {{nodes: {importance?:number, degree?:number, id:string}[]}} graph
 * @returns {Int32Array} order[rank] = 节点下标
 */
export function pageOrder(graph) {
  const nodes = graph.nodes || []
  const arr = new Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) arr[i] = i
  arr.sort((a, b) => {
    const A = nodes[a]
    const B = nodes[b]
    const imp = (B.importance || 0) - (A.importance || 0)
    if (imp) return imp
    const deg = (B.degree || 0) - (A.degree || 0)
    if (deg) return deg
    const ai = String(A.id)
    const bi = String(B.id)
    return ai < bi ? -1 : ai > bi ? 1 : 0
  })
  return Int32Array.from(arr)
}

/**
 * 决定这一页要哪些节点。
 * @param {{nodes: unknown[]}} graph
 * @param {{limit?: number, offset?: number, order?: Int32Array}} opts
 * @returns {{indices: number[], page: {total:number, offset:number, limit:number, next:number|null, order:string}}}
 */
export function selectPage(graph, opts = {}) {
  const total = (graph.nodes || []).length
  const order = opts.order || pageOrder(graph)
  const rawLimit = Number(opts.limit)
  const wanted =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(PAGE_MAX, Math.floor(rawLimit))
      : total > FIRST_PAGE_MAX
        ? FIRST_PAGE_MAX
        : total
  const rawOffset = Number(opts.offset)
  const start = Math.min(Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0), total)
  const end = Math.min(total, start + wanted)
  const indices = new Array(Math.max(0, end - start))
  for (let k = start; k < end; k++) indices[k - start] = order[k]
  return {
    indices,
    page: {
      total,
      offset: start,
      limit: indices.length,
      next: end < total ? end : null,
      order: 'importance',
    },
  }
}
