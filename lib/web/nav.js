/* 记忆星图 —— 键盘导航的几何
   星图画在 canvas 上，读屏器和键盘都看不见节点。这一层只做纯计算：
   给一组屏幕坐标上的点，算「按下方向键之后该去哪一颗」。
   不碰 DOM、不读全局，所以能原样丢进 node --test 里跑。 */
;(function (root) {
  'use strict'

  /** 屏幕坐标系：x 向右，y 向下。 */
  const DIRS = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  }

  /** 方向分量小于这个值就当作「不在这条道上」，免得在两颗重合的星之间来回跳。 */
  const MIN_ALONG = 2
  /** 偏角惩罚：同样距离下，越正对方向越优先。 */
  const PERP_WEIGHT = 1.5

  function dirVector(dir) {
    if (Array.isArray(dir) && isFinite(dir[0]) && isFinite(dir[1])) return dir
    return DIRS[dir] || null
  }

  function finite(p) {
    return !!p && typeof p.id !== 'undefined' && isFinite(p.x) && isFinite(p.y)
  }

  function firstOf(points) {
    let best = null
    for (const p of points) {
      if (!finite(p)) continue
      if (!best || p.y < best.y || (p.y === best.y && p.x < best.x)) best = p
    }
    return best ? best.id : null
  }

  /**
   * 按方向找下一颗星。
   * 代价 = 距离 ×（1 + 1.5 × 偏角正切）：正前方优先，斜太远的会被近处但偏得少的压过去。
   * 找不到就返回 null —— 不跨屏硬跳，人不会莫名其妙丢位置。
   */
  function pick(points, fromId, dir) {
    const v = dirVector(dir)
    if (!v || !Array.isArray(points)) return null
    const [ux, uy] = v
    let from = null
    for (const p of points) if (finite(p) && p.id === fromId) from = p
    if (!from) return null
    let best = null
    let bestCost = Infinity
    for (const p of points) {
      if (!finite(p) || p.id === fromId) continue
      const dx = p.x - from.x
      const dy = p.y - from.y
      const along = dx * ux + dy * uy
      if (along < MIN_ALONG) continue
      const perp = Math.abs(dx * uy - dy * ux)
      const dist = Math.hypot(dx, dy)
      const cost = dist * (1 + PERP_WEIGHT * (perp / along))
      if (cost < bestCost - 1e-9) {
        best = p.id
        bestCost = cost
      } else if (Math.abs(cost - bestCost) <= 1e-9 && best !== null && String(p.id) < String(best)) {
        best = p.id
      }
    }
    return best
  }

  /** 离某颗最近的一颗（不带方向）：搜索跳过来之后要接住键盘时用。 */
  function nearest(points, fromId) {
    if (!Array.isArray(points)) return null
    let from = null
    for (const p of points) if (finite(p) && p.id === fromId) from = p
    if (!from) return firstOf(points)
    let best = null
    let bestD = Infinity
    for (const p of points) {
      if (!finite(p) || p.id === fromId) continue
      const d = Math.hypot(p.x - from.x, p.y - from.y)
      if (d < bestD - 1e-9) {
        best = p.id
        bestD = d
      } else if (Math.abs(d - bestD) <= 1e-9 && best !== null && String(p.id) < String(best)) {
        best = p.id
      }
    }
    return best
  }

  function degreeOf(degree, id) {
    if (!degree) return 0
    if (typeof degree === 'function') return +degree(id) || 0
    if (typeof degree.get === 'function') return +degree.get(id) || 0
    return +degree[id] || 0
  }

  /** 连接最多的那颗：Tab 进星图时的落点，先落在最有话可说的星星上。 */
  function hub(points, degree) {
    if (!Array.isArray(points) || !points.length) return null
    let best = null
    let bestD = -Infinity
    for (const p of points) {
      if (!finite(p)) continue
      const d = degreeOf(degree, p.id)
      if (d > bestD || (d === bestD && best !== null && String(p.id) < String(best))) {
        best = p.id
        bestD = d
      }
    }
    return best
  }

  /** 与某颗相连的节点，按连接强度从高到低（[ / ] 键在邻居之间走）。 */
  function neighbors(edges, id, minW) {
    const min = isFinite(minW) ? minW : 0
    const out = []
    if (!Array.isArray(edges) || !id) return out
    for (const e of edges) {
      if (!e || typeof e.w === 'number' && e.w < min) continue
      if (e.a === id && e.b) out.push({ id: e.b, w: typeof e.w === 'number' ? e.w : 0 })
      else if (e.b === id && e.a) out.push({ id: e.a, w: typeof e.w === 'number' ? e.w : 0 })
    }
    out.sort((x, y) => (y.w - x.w) || String(x.id).localeCompare(String(y.id)))
    return out
  }

  const api = { DIRS, pick, nearest, hub, neighbors }
  root.NebulaNav = api
})(typeof window !== 'undefined' ? window : globalThis)
