/* REV_20261107_A */
/* 记忆星图 —— 渲染层
   一个 canvas 干完所有事：力导向布局、发光节点、曲线连边、脉冲扩散。
   没有依赖，没有构建步骤。 */
(function () {
  'use strict'
  /** 中文即源文：英文模式查 i18n.js 的表，查不到就原样返回中文。 */
  const T = (zh, vars) => (window.NebulaI18n ? window.NebulaI18n.t(zh, vars) : zh)
  const N = (window.Nebula = window.Nebula || {})

  /** 每层记忆的颜色（与 CSS 强调色一致）。 */
  const LEVEL_COLOR = {
    soul: '#ffd88a',
    user: '#7ff0c8',
    project: '#6cc8ff',
    lesson: '#ff9f7a',
    topic: '#c39bff',
    fact: '#9fb6cc',
    rules: '#ff8fb0',
    source: '#8ce0ff',
  }

  const TYPE_COLOR = {
    explicit: '#ffd88a',
    project: '#6cc8ff',
    entity: '#7ff0c8',
    keyword: '#c39bff',
    semantic: '#79e0b6',
    hebbian: '#ffa26b',
    mentions: '#8ce0ff',
  }

  function hexToRgb(hex) {
    const h = String(hex || '#ffffff').replace('#', '')
    const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    const n = parseInt(v, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  function rgba(hex, a) {
    const [r, g, b] = hexToRgb(hex)
    return `rgba(${r},${g},${b},${a})`
  }

  // 光点贴图缓存：同一个层级色只渲染一次发光球，之后靠 drawImage 缩放复用。
  // 900+ 节点每帧各建两个径向渐变太贵，这是缩放卡顿的主因。
  const SPRITE_CACHE = new Map()
  const SPRITE_SIZE = 128
  // 交互期用的整帧快照按半分辨率抓，贴回去时放大 —— 软件渲染下省一半像素填充
  const NODE_MIN_R = 1.3
  function nodeSprite(color) {
    const key = color || '#9fb6cc'
    const hit = SPRITE_CACHE.get(key)
    if (hit) return hit
    const cv = document.createElement('canvas')
    cv.width = SPRITE_SIZE
    cv.height = SPRITE_SIZE
    const g2 = cv.getContext('2d')
    const [r, g, b] = hexToRgb(key)
    const mid = SPRITE_SIZE / 2
    // 外发光（占满整张图）
    const gr = g2.createRadialGradient(mid, mid, 0, mid, mid, mid)
    gr.addColorStop(0, `rgba(${r},${g},${b},0.5)`)
    gr.addColorStop(0.22, `rgba(${r},${g},${b},0.2)`)
    gr.addColorStop(0.6, `rgba(${r},${g},${b},0.045)`)
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`)
    g2.fillStyle = gr
    g2.beginPath()
    g2.arc(mid, mid, mid, 0, 6.2832)
    g2.fill()
    // 核心用「本色」不加白：一堆光点叠在一起时才不会被叠成一片白
    const core = mid * 0.2
    const gc = g2.createRadialGradient(mid, mid, 0, mid, mid, core)
    gc.addColorStop(0, `rgba(${r},${g},${b},0.98)`)
    gc.addColorStop(0.6, `rgba(${r},${g},${b},0.7)`)
    gc.addColorStop(1, `rgba(${r},${g},${b},0)`)
    g2.fillStyle = gc
    g2.beginPath()
    g2.arc(mid, mid, core, 0, 6.2832)
    g2.fill()
    SPRITE_CACHE.set(key, cv)
    return cv
  }

  /** 32 位整数哈希，用来做确定性抖动。 */
  function h32(str) {
    let h = 2166136261 >>> 0
    const s = String(str)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
    return h >>> 0
  }

  N.stage = function createStage(canvas, opts) {
    const state = {
      graph: null,
      nodes: [],
      edges: [],
      byId: new Map(),
      clusters: [],
      cam: { x: 0, y: 0, k: 1 },
      target: null,
      hover: null,
      selected: null,
      highlight: null,
      pathSeq: null,
      pathIds: null,
      pathEdges: null,
      filter: null,
      mode: 'nebula',
      pulses: [],
      labels: true,
      dpr: 1,
      w: 0,
      h: 0,
      listeners: {},
      moving: false,
      alpha: 1,
      drag: null,
      pointer: { x: 0, y: 0 },
      stars: [],
      lastFrame: 0,
      fps: 0,
    }

    const ctx = canvas.getContext('2d')
    const emit = (name, arg) => {
      const fn = state.listeners[name]
      if (fn) fn(arg)
    }
    const api = { on: (n, f) => ((state.listeners[n] = f), api), get state() { return state } }

    // ---------------- 尺寸 ----------------
    function resize() {
      const rect = canvas.getBoundingClientRect()
      // 画布被 display:none（切到 3D）时 rect 是 0×0。这时如果照常写后备缓冲，
      // 会把它改成 1×1；等切回 2D 就只剩一张空画布。隐藏时直接跳过，可见时再量。
      if (rect.width < 2 || rect.height < 2) return false
      state.dpr = Math.min(2, window.devicePixelRatio || 1)
      state.w = rect.width
      state.h = rect.height
      canvas.width = Math.round(state.w * state.dpr)
      canvas.height = Math.round(state.h * state.dpr)
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0)
      buildStars()
      draw()
      return true
    }

    /** 背景星尘：屏幕坐标，跟着镜头做极慢视差。 */
    function buildStars() {
      const count = Math.round((state.w * state.h) / 9000)
      const out = []
      for (let i = 0; i < count; i++) {
        const r = Math.random()
        out.push({
          x: Math.random() * state.w,
          y: Math.random() * state.h,
          r: r < 0.86 ? 0.6 : r < 0.97 ? 1.1 : 1.7,
          a: 0.12 + Math.random() * 0.5,
          p: 0.15 + Math.random() * 0.85,
          tw: Math.random() * Math.PI * 2,
        })
      }
      state.stars = out
    }

    // ---------------- 布局 ----------------
    function initLayout() {
      const nodes = state.nodes
      const clusters = state.clusters
      if (!clusters.length) return
      // 每个簇按记忆条数估半径（面积 ∝ 条数）；最大的簇坐中心，其余围一圈，
      // 圈半径 = 中心簇半径 ×0.9 + 自己半径 + 间距，保证互不吞并。
      const counts = new Map()
      for (const n of nodes) counts.set(n.cluster, (counts.get(n.cluster) || 0) + 1)
      for (const c of clusters) c._n = counts.get(c.id) || 1
      const radiusOf = (c) => 50 + Math.sqrt(c._n) * 19
      for (const c of clusters) c._rad = radiusOf(c)
      const order = clusters.slice().sort((a, b) => b._n - a._n)
      const hub = order[0]
      const satellites = order.slice(1)
      hub._cx = 0
      hub._cy = 0
      satellites.forEach((c, i) => {
        const ang = (i / Math.max(1, satellites.length)) * Math.PI * 2 - Math.PI / 2
        // 圆心距 = 两团半径之和 + 间距，保证边缘不打架
        const r = hub._rad + c._rad + 200
        c._cx = Math.cos(ang) * r * 1.06
        c._cy = Math.sin(ang) * r
      })
      const cIndex = new Map(clusters.map((c, i) => [c.id, i]))
      for (const node of nodes) {
        const ci = cIndex.get(node.cluster) || 0
        const c = clusters[ci] || { _cx: 0, _cy: 0, _rad: 120 }
        const rnd = h32(node.id) >>> 0
        const a = ((rnd % 1000) / 1000) * Math.PI * 2
        // 注意：h32 是无符号 32 位，右移必须用 >>>，用 >> 会移出负数 → sqrt(负) = NaN
        // （曾因此让一半节点成为 NaN 坐标，抽取时整屏只剩一团）
        let rad = Math.sqrt(((rnd >>> 10) % 1000) / 1000) * (c._rad || 120)
        if (!isFinite(rad)) rad = (c._rad || 120) * 0.5
        node.x = c._cx + Math.cos(a) * rad
        node.y = c._cy + Math.sin(a) * rad
        if (!isFinite(node.x) || !isFinite(node.y)) {
          node.x = c._cx || 0
          node.y = c._cy || 0
        }
        node.vx = 0
        node.vy = 0
        node.r = nodeRadius(node)
        node.color = LEVEL_COLOR[node.level] || '#9fb6cc'
        node.rgb = hexToRgb(node.color)
      }
    }

    function nodeRadius(node) {
      const base = 1.35 + (node.heat || 0.4) * 3.4 + (node.importance || 1) * 0.5
      return Math.min(7.2, base)
    }

    /** 力导向：网格加速的斥力 + 弹簧 + 簇心引力。 */
    function simulate(ticks, decay) {
      const nodes = state.nodes
      if (!nodes.length) return
      const edges = state.edges
      const clusters = state.clusters
      const cMap = new Map()
      for (const c of clusters) cMap.set(c.id, c)
      const degree = new Map()
      const pairW = new Map()
      for (const e of edges) {
        degree.set(e.a, (degree.get(e.a) || 0) + 1)
        degree.set(e.b, (degree.get(e.b) || 0) + 1)
        // 记住每对节点之间最强的证据权重：关系越铁，两个点就该挨得越近
        const key = e.a < e.b ? e.a + '|' + e.b : e.b + '|' + e.a
        const w = e.w || 0.3
        if (!pairW.has(key) || pairW.get(key) < w) pairW.set(key, w)
      }

      for (let t = 0; t < ticks; t++) {
        const alpha = state.alpha
        // 1) 斥力（网格）
        const cell = 110
        const grid = new Map()
        for (const n of nodes) {
          const gx = Math.floor(n.x / cell)
          const gy = Math.floor(n.y / cell)
          const key = gx + ',' + gy
          let bucket = grid.get(key)
          if (!bucket) grid.set(key, (bucket = []))
          bucket.push(n)
        }
        for (const n of nodes) {
          const gx = Math.floor(n.x / cell)
          const gy = Math.floor(n.y / cell)
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const bucket = grid.get(gx + dx + ',' + (gy + dy))
              if (!bucket) continue
              for (const m of bucket) {
                if (m === n) continue
                let ddx = n.x - m.x
                let ddy = n.y - m.y
                let d2 = ddx * ddx + ddy * ddy
                if (d2 > 40000 || d2 <= 0.0001) continue
                const d = Math.sqrt(d2)
                const rep = (900 * alpha) / d2
                const f = Math.min(4.2, rep)
                n.vx += (ddx / d) * f
                n.vy += (ddy / d) * f
              }
            }
          }
        }
        // 2) 弹簧（跨簇的拉得更软，避免把两个簇拽到一起）
        for (const e of edges) {
          const a = e._a
          const b = e._b
          if (!a || !b) continue
          const cross = a.cluster !== b.cluster
          let ddx = b.x - a.x
          let ddy = b.y - a.y
          const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.001
          // 静止长度也按权重来：证据越强，弹簧越短（关系越近）
          const ww = e.w || 0.4
          const target = (cross ? 46 : 26) + (cross ? 130 : 96) * Math.pow(1 - ww, 1.35)
          const k = ((cross ? 0.004 : 0.012) + 0.05 * ww) * alpha
          const f = (d - target) * k
          ddx /= d
          ddy /= d
          a.vx += ddx * f
          a.vy += ddy * f
          b.vx -= ddx * f
          b.vy -= ddy * f
        }
        // 3) 簇锚点引力 + 越界回拉 + 阻尼
        for (const n of nodes) {
          const c = cMap.get(n.cluster)
          if (c) {
            const ax = c._cx || 0
            const ay = c._cy || 0
            n.vx += (ax - n.x) * 0.034 * alpha
            n.vy += (ay - n.y) * 0.034 * alpha
            const dist = Math.hypot(n.x - ax, n.y - ay)
            const limit = (c._rad || 140) * 1.0
            if (isFinite(dist) && dist > limit) {
              // 硬边界：超出簇半径就把节点往回按（^1.6 的力，越界越多越强）
              const over = dist - limit
              const pull = Math.min(58, over * 0.16 + over * over * 0.0009) * alpha
              n.vx -= ((n.x - ax) / dist) * pull
              n.vy -= ((n.y - ay) / dist) * pull
            }
          }
          const damp = 0.86
          n.vx *= damp
          n.vy *= damp
          const max = 14
          if (!isFinite(n.vx)) n.vx = 0
          if (!isFinite(n.vy)) n.vy = 0
          if (n.vx > max) n.vx = max
          if (n.vx < -max) n.vx = -max
          if (n.vy > max) n.vy = max
          if (n.vy < -max) n.vy = -max
          if (n.pinned) continue
          n.x += n.vx + (Math.random() - 0.5) * 0.6
          n.y += n.vy + (Math.random() - 0.5) * 0.6
          if (!isFinite(n.x) || !isFinite(n.y)) {
            const bx = (c && c._cx) || 0
            const by = (c && c._cy) || 0
            const rr = (c && c._rad ? c._rad : 120) * 0.6
            n.x = bx + (Math.random() - 0.5) * rr
            n.y = by + (Math.random() - 0.5) * rr
            n.vx = 0
            n.vy = 0
          }
        }
        // 4) 硬分离：每对节点留一个最小间距，别挤成密密麻麻一坨
        for (let pass = 0; pass < 2; pass++) {
          const cell2 = 42
          const grid2 = new Map()
          for (const n of nodes) {
            const gx = Math.floor(n.x / cell2)
            const gy = Math.floor(n.y / cell2)
            const key = gx + ',' + gy
            let bucket = grid2.get(key)
            if (!bucket) grid2.set(key, (bucket = []))
            bucket.push(n)
          }
          for (const n of nodes) {
            if (n.pinned) continue
            const gx = Math.floor(n.x / cell2)
            const gy = Math.floor(n.y / cell2)
            for (let dx = -1; dx <= 1; dx++) {
              for (let dy = -1; dy <= 1; dy++) {
                const bucket = grid2.get(gx + dx + ',' + (gy + dy))
                if (!bucket) continue
                for (const m of bucket) {
                  if (m === n) continue
                  let ddx = n.x - m.x
                  let ddy = n.y - m.y
                  let d2 = ddx * ddx + ddy * ddy
                  // 间距由「关系有多紧」决定：铁关系挨着，没关系的才疏开
                  const pk = n.id < m.id ? n.id + '|' + m.id : m.id + '|' + n.id
                  const pw = pairW.get(pk)
                  const minSep = (pw == null ? 52 : 26 + 44 * (1 - pw)) + (n.r || 2) + (m.r || 2)
                  if (d2 >= minSep * minSep) continue
                  if (d2 <= 0.0001) {
                    ddx = Math.random() - 0.5
                    ddy = Math.random() - 0.5
                    d2 = ddx * ddx + ddy * ddy || 0.01
                  }
                  const d = Math.sqrt(d2)
                  const push = (minSep - d) * 0.5
                  const ux = ddx / d
                  const uy = ddy / d
                  n.x += ux * push
                  n.y += uy * push
                  if (!m.pinned) {
                    m.x -= ux * push
                    m.y -= uy * push
                  }
                }
              }
            }
          }
        }
        state.alpha = Math.max(0.02, state.alpha * decay)
      }
      // 坐标变了：告诉绘制层「上一帧的边路径缓存失效了」。
      // 静止时（绝大多数时间）这份缓存让每帧省掉几千条曲线的重建。
      state.geoVersion = (state.geoVersion || 0) + 1
    }

    /** 时间轴布局：横轴＝记忆时间，纵轴＝工作区。 */
    function layoutTime() {
      const nodes = state.nodes
      if (!nodes.length) return
      const times = nodes.map((n) => n.createdAt || 0).filter((x) => x > 0)
      const min = Math.min(...times)
      const maxs = Math.max(...times)
      const span = Math.max(1, maxs - min)
      const clusters = state.clusters
      const idx = new Map(clusters.map((c, i) => [c.id, i]))
      const rowH = Math.min(120, (state.h * 0.62) / Math.max(1, clusters.length))
      state.timeRange = { min, max: maxs }
      state.timeRows = clusters.map((c, i) => ({ id: c.id, title: c.title || c.label || '', y: -state.h * 0.3 + i * rowH, color: c.color }))
      for (const n of nodes) {
        const t = n.createdAt || min
        n.tx = state.w * 0.12 + ((t - min) / span) * state.w * 0.76 - state.w / 2
        n.ty = -state.h * 0.3 + (idx.get(n.cluster) || 0) * rowH
      }
    }

    // ---------------- 数据 ----------------
    /**
     * 区块加载（MC 那一套的骨架）：把世界切成格子，按「离视口中心远近」排队，
     * 每帧只点亮一点点，同时把力导向按帧推进——星云是长出来的，不是蹦出来的。
     */
    function startReveal() {
      // 系统里选了「减少动态效果」的人，不要看二十秒的生长动画：直接全亮。
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (const n of state.nodes) n.reveal = 1
        state.pump = null
        state.alpha = 1
        return
      }
      const CELL = 900
      const cells = new Map()
      for (const n of state.nodes) {
        const k = Math.floor(n.x / CELL) + ',' + Math.floor(n.y / CELL)
        let arr = cells.get(k)
        if (!arr) cells.set(k, (arr = []))
        arr.push(n)
      }
      const cx = state.cam.x
      const cy = state.cam.y
      const dist = (arr) => {
        let sx = 0, sy = 0
        for (const n of arr) { sx += n.x; sy += n.y }
        return Math.hypot(sx / arr.length - cx, sy / arr.length - cy)
      }
      const order = [...cells.values()].sort((A, B) => dist(A) - dist(B))
      const t0 = performance.now()
      let t = 0
      for (const arr of order) {
        // 同一格里重要度高的先长出来（主人打开页面通常在找重要的东西）
        arr.sort((a, b) => (b.importance || 0) - (a.importance || 0))
        for (let i = 0; i < arr.length; i++) {
          arr[i].reveal = 0
          arr[i].delay = t + Math.min(220, i * 8)
        }
        t += 62 // 每格错开一点，形成"扫过去"的波
      }
      // 万条图：420 轮力导向要十几秒，首屏等不起。格子初始位置已经分好簇，
      // 少量轮次足以把同一格的节点拉开；细节交给用户缩放/拖动后的按需推进。
      const ticksTarget = state.nodes.length > 3000 ? 48 : state.nodes.length > 1000 ? 180 : 420
      state.pump = { t0, done: false, total: state.nodes.length, ticks: 0, ticksTarget }
      state.alpha = 1
    }

    /** 加载进度（给界面显示"正在生长 42%"）。 */
    api.progress = function progress() {
      if (!state.pump) return { done: true, shown: state.nodes.length, total: state.nodes.length }
      let shown = 0
      for (const n of state.nodes) if ((n.reveal || 0) >= 0.98) shown++
      return { done: state.pump.done, shown, total: state.nodes.length }
    }

    function pumpReveal(now) {
      const p = state.pump
      if (!p) return false
      const t = now - p.t0
      let shown = 0
      for (const n of state.nodes) {
        if ((n.reveal || 0) >= 1) { shown++; continue }
        const el = t - (n.delay || 0)
        n.reveal = el <= 0 ? 0 : Math.min(1, el / 240)
      }
      // 边生根之后力导向还在找位置：每帧按 8ms 预算推进，直到走完目标轮次
      // （注意：不能"点全亮就停"，否则布局只跑了几十轮，星团会挤成一坨）
      const ticksTarget = p.ticksTarget || 420
      if (p.ticks < ticksTarget) {
        const budget = 8
        const s0 = performance.now()
        while (performance.now() - s0 < budget && p.ticks < ticksTarget) {
          simulate(1, 0.994)
          p.ticks++
        }
        if (shown < p.total) return true
      }
      p.done = true
      state.pump = null
      return false
    }

    api.load = function load(graph, keepView) {
      const loadT0 = performance.now()
      const first = !state.graph
      state.graph = graph
      state.edgeCache = null // 换了一批数据，上一帧的边路径一律作废
      state.boxesDirty = true
      state.nodes = graph.nodes.map((n) => ({ ...n }))
      state.byId = new Map(state.nodes.map((n) => [n.id, n]))
      state.edges = graph.edges
        .map((e) => ({ ...e, _a: state.byId.get(e.a), _b: state.byId.get(e.b) }))
        .filter((e) => e._a && e._b)
      state.clusters = (graph.clusters || []).map((c) => ({ ...c }))
      initLayout()
      if (!keepView || first) api.fit(true)
      if (graph.v >= 2) {
        if (state.nodes.length > 3000 || window.__NEBULA_SNAPSHOT__) {
          // 快照没有后端、也没有第二次机会：直接出图，不依赖 rAF 的生长动画。
          // 万条图更是如此：生长动画 + 每帧重绘会把首屏拖到十几秒。
          // 先同步走少量轮次把格子里的点拉开，一次画完；细节交给缩放后的重绘。
          state.alpha = 1
          // 初始位置已经按簇排好；万条图不再跑力导向，直接出图。
          for (const n of state.nodes) n.reveal = 1
          state.pump = null
        } else {
          // 精简图：先按格子排队做"区块加载"，布局靠后续每帧推进
          for (const n of state.nodes) n.reveal = 0
          startReveal()
        }
      } else {
        state.alpha = 1
        simulate(420, 0.988)
        for (const n of state.nodes) n.reveal = 1
      }
      draw()
      api.timings = { loadMs: Math.round(performance.now() - loadT0), nodes: state.nodes.length, edges: state.edges.length, pump: state.pump ? state.pump.ticksTarget : 0 }
    }

    api.fit = function fit(instant) {
      const nodes = api.visibleNodes()
      if (!nodes.length) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of nodes) {
        if (n.x < minX) minX = n.x
        if (n.x > maxX) maxX = n.x
        if (n.y < minY) minY = n.y
        if (n.y > maxY) maxY = n.y
      }
      const pad = 62
      const P = state.pad || { left: 0, right: 0, top: 0, bottom: 0 }
      const availW = Math.max(220, state.w - P.left - P.right)
      const availH = Math.max(220, state.h - P.top - P.bottom)
      const bw = maxX - minX + pad * 2
      const bh = maxY - minY + pad * 2
      const k = Math.min(availW / bw, availH / bh, 1.35)
      // 让内容落在「可用区域」的中心，而不是画布中心（左侧有筛选面板时要往右挪）
      const cx = P.left + availW / 2 - state.w / 2
      const cy = P.top + availH / 2 - state.h / 2
      state.target = {
        k,
        x: (minX + maxX) / 2 - cx / k,
        y: (minY + maxY) / 2 - cy / k,
      }
      if (instant) {
        state.cam.k = k
        state.cam.x = state.target.x
        state.cam.y = state.target.y
        state.target = null
      }
    }

    /** 给界面留出面板位置。 */
    api.setPadding = function setPadding(p) {
      state.pad = { left: 0, right: 0, top: 0, bottom: 0, ...(p || {}) }
    }

    /** 拉远时点的聚合光斑：返回那个工作区 id（不是个体节点，所以没点到就退化成 null）。 */
    api.lodAt = function lodAt(sx, sy) {
      const agg = state.lodAgg
      if (!agg || !agg.size) return null
      let best = null
      let bestD = Infinity
      for (const [ws, a] of agg) {
        const d = Math.hypot(sx - a.cx, sy - a.cy)
        if (d <= a.rad * 0.95 && d < bestD) {
          bestD = d
          best = ws
        }
      }
      return best
    }

    /** LOD 当前状态（调试/自动化用）：哪些簇被聚合成光斑、缩放多少。 */
    api.lodInfo = function lodInfo() {
      const agg = state.lodAgg || new Map()
      return {
        k: Number(state.cam.k.toFixed(3)),
        clusters: [...agg.entries()].map(([ws, a]) => ({ ws, n: a.n, r: Math.round(a.rad), x: Math.round(a.cx), y: Math.round(a.cy) })),
      }
    }

    /** 下钻一个项目：把镜头推到这一簇的范围（不筛掉别人，保留上下文）。 */    api.focusCluster = function focusCluster(ws) {
      const list = state.nodes.filter((n) => !n.hidden && n.cluster === ws)
      if (!list.length) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of list) {
        if (n.x < minX) minX = n.x
        if (n.x > maxX) maxX = n.x
        if (n.y < minY) minY = n.y
        if (n.y > maxY) maxY = n.y
      }
      const pad = 90
      const P = state.pad || { left: 0, right: 0, top: 0, bottom: 0 }
      const availW = Math.max(220, state.w - P.left - P.right)
      const availH = Math.max(220, state.h - P.top - P.bottom)
      const k = Math.min(availW / (maxX - minX + pad * 2), availH / (maxY - minY + pad * 2), 3.2)
      const cx = P.left + availW / 2 - state.w / 2
      const cy = P.top + availH / 2 - state.h / 2
      state.target = { k, x: (minX + maxX) / 2 - cx / k, y: (minY + maxY) / 2 - cy / k }
    }

    /** 世界坐标 → 屏幕坐标。 */
    function toScreen(x, y) {
      return [
        (x - state.cam.x) * state.cam.k + state.w / 2,
        (y - state.cam.y) * state.cam.k + state.h / 2,
      ]
    }
    function toWorld(sx, sy) {
      return [
        (sx - state.w / 2) / state.cam.k + state.cam.x,
        (sy - state.h / 2) / state.cam.k + state.cam.y,
      ]
    }
    api.toScreen = toScreen
    api.toWorld = toWorld

    // ---------------- 绘制 ----------------
    function drawStars() {
      const t = performance.now() / 1000
      for (const s of state.stars) {
        const px = (s.x + state.cam.x * -0.012 * s.p) % state.w
        const py = (s.y + state.cam.y * -0.012 * s.p) % state.h
        const a = s.a * (0.72 + 0.28 * Math.sin(t * 0.7 + s.tw))
        ctx.fillStyle = `rgba(190,215,245,${a})`
        ctx.beginPath()
        ctx.arc(px < 0 ? px + state.w : px, py < 0 ? py + state.h : py, s.r, 0, 6.2832)
        ctx.fill()
      }
    }

    function visibleEdge(e) {
      const f = state.filter
      if (!f) return true
      if (f.types && !f.types.has(e.t)) return false
      if (f.minW && e.w < f.minW) return false
      if (f.ws && e._a && !f.ws.has(e._a.ws)) return false
      return true
    }

    function draw() {
      const k = state.cam.k
      ctx.clearRect(0, 0, state.w, state.h)
      ctx.fillStyle = '#04060c'
      ctx.fillRect(0, 0, state.w, state.h)

      drawStars()

      // 世界坐标包围盒只算一次：平移/缩放下每帧只把 4 个角投到屏幕
      // （原来每帧遍历 1400+ 个节点算簇包围盒，拖动时白烧 CPU；顺带让"拖到哪都不断帧"）
      if (state.boxesDirty !== false || !state.boxes) {
        const boxes = new Map()
        for (const n of state.nodes) {
          if (n.hidden) continue
          let b = boxes.get(n.cluster)
          if (!b) {
            b = { minX: n.x, maxX: n.x, minY: n.y, maxY: n.y, n: 0 }
            boxes.set(n.cluster, b)
          }
          if (n.x < b.minX) b.minX = n.x
          if (n.x > b.maxX) b.maxX = n.x
          if (n.y < b.minY) b.minY = n.y
          if (n.y > b.maxY) b.maxY = n.y
          b.n++
        }
        state.boxes = boxes
        state.boxesDirty = false
        // 包围盒变了 → LOD 聚合范围可能变 → 边路径缓存跟着失效
        state.boxVersion = (state.boxVersion || 0) + 1
      }
      const clusterLabels = []
      // LOD：拉远时，屏幕半径过小的簇整团并成一个聚合光斑（旁边写条数），点它可下钻。
      // 判据是"这团在屏幕上有多大"，不是写死的缩放级别——所以和窗口大小、缩放都自洽。
      const agg = new Map()
      const LOD_MIN_R = 96
      state.lodAgg = agg
      // 每个簇里「还被筛选留下」的节点数。全被筛掉的簇不该再画光斑——
      // 否则画面说「这一屏没有记忆」，旁边还挂着 131 个光斑，人只会以为界面在骗他。
      const visByCluster = new Map()
      for (const n of state.nodes) if (!n.hidden) visByCluster.set(n.cluster, (visByCluster.get(n.cluster) || 0) + 1)
      if (state.mode === 'nebula') {
        for (const c of state.clusters) {
          const wb = state.boxes.get(c.id)
          if (!wb || wb.n < 3) continue
          const visN = visByCluster.get(c.id) || 0
          if (!visN) continue
          // 世界包围盒 → 屏幕（只投 4 个角，恒定的 4 次乘法）
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
          for (const [wx, wy] of [
            [wb.minX, wb.minY],
            [wb.maxX, wb.minY],
            [wb.minX, wb.maxY],
            [wb.maxX, wb.maxY],
          ]) {
            const sx = (wx - state.cam.x) * state.cam.k + state.w / 2
            const sy = (wy - state.cam.y) * state.cam.k + state.h / 2
            if (sx < minX) minX = sx
            if (sx > maxX) maxX = sx
            if (sy < minY) minY = sy
            if (sy > maxY) maxY = sy
          }
          const cx = (minX + maxX) / 2
          const cy = (minY + maxY) / 2
          const rad = Math.max(52, Math.max(maxX - minX, maxY - minY) * 0.66)
          if (rad < 26) continue
          if (rad < LOD_MIN_R) {
            agg.set(c.id, { cx, cy, rad: Math.max(24, rad * 1.15), n: visN, color: c.color || '#6cc8ff', title: c.title })
            continue
          }
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad)
          const col = c.color || '#6cc8ff'
          g.addColorStop(0, rgba(col, 0.06))
          g.addColorStop(0.55, rgba(col, 0.024))
          g.addColorStop(1, rgba(col, 0))
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(cx, cy, rad, 0, 6.2832)
          ctx.fill()
          // 早先 k<0.18 就不画簇名，于是「再缩小一点」会把还没并成光斑的大簇名字弄丢；
          // 真正的门槛应该是「这团还画得出轮廓」（rad≥LOD_MIN_R），不是写死一个缩放级别。
          if (k > 0.10) {
            clusterLabels.push({
              x: cx,
              y: minY - 14,
              ax: cx,
              ay: cy,
              rad,
              text: String(c.title || c.id).toUpperCase(),
              col,
            })
          }
        }
      }

      const hl = state.highlight
      const hset = state.highlightSet
      const sel = state.selected

      // 连边：按「颜色 + 透明度档」归并成少量路径，一次 stroke 一批
      // （原来是每条边一个 beginPath/stroke，3000+ 边时光栅化开销全在这上面）
      //
      // 再加一层：静止时路径根本不用重建。镜头、坐标版本、聚类包围盒、筛选、高亮
      // 都没变，就直接复用上一帧那几批 Path2D —— 绝大多数时间画面是静的。
      const f = state.filter || {}
      const edgeKey = [
        state.cam.x,
        state.cam.y,
        state.cam.k,
        state.geoVersion || 0,
        state.boxVersion || 0,
        state.pump ? 'p' + state.pump.ticks : 'idle',
        hl || '',
        hset ? hset.size + ':' + (hset.size ? Array.from(hset).slice(0, 3).join(',') : '') : '',
        sel || '',
        f.minW || 0,
        f.minImp || 0,
        f.ws ? 'w' + f.ws.size : 'wa',
        f.levels ? 'l' + f.levels.size : 'la',
        f.types ? 't' + f.types.size : 'ta',
        // 换一组同数量的工作区时 size 不变，但藏起来的节点变了——必须有版本号，
        // 否则边会沿用上一次筛选的路径，看着像筛选没生效。
        state.hiddenVersion || 0,
        state.w,
        state.h,
      ].join('|')

      let edgeBuckets
      if (state.edgeCache && state.edgeCache.key === edgeKey) {
        edgeBuckets = state.edgeCache.buckets
      } else {
        edgeBuckets = new Map()
        const edgePath = (bucket, ax, ay, bx, by) => {
          let p = edgeBuckets.get(bucket)
          if (!p) edgeBuckets.set(bucket, (p = new Path2D()))
          const mx = (ax + bx) / 2
          const my = (ay + by) / 2
          const dl = Math.hypot(bx - ax, by - ay) || 1
          const nx = -(by - ay) / dl
          const ny = (bx - ax) / dl
          const bend = Math.min(26, dl * 0.16)
          p.moveTo(ax, ay)
          p.quadraticCurveTo(mx + nx * bend, my + ny * bend, bx, by)
        }
        for (const e of state.edges) {
          if (!visibleEdge(e)) continue
          const a = e._a
          const b = e._b
          // 端点被筛掉了，这条线就没有归属：留着会变成画面中央的「孤儿细线」
          if (a.hidden || b.hidden) continue
          // 区块加载：两端都点亮到 85% 才画这条边，否则会先有线后有点
          const ra = a.reveal == null ? 1 : a.reveal
          const rb = b.reveal == null ? 1 : b.reveal
          const rMin = ra < rb ? ra : rb
          if (rMin < 0.85) continue
          // LOD：两端都被聚合成光斑时，这条边没有个体可连，跳过
          if (agg.size && agg.has(a.cluster) && agg.has(b.cluster)) continue
          const [ax, ay] = toScreen(a.x, a.y)
          const [bx, by] = toScreen(b.x, b.y)
          if (ax < -200 || ay < -200 || bx < -200 || by < -200) continue
          if (ax > state.w + 200 || bx > state.w + 200) continue
          let alpha = 0.1 + 0.32 * (e.w || 0.4)
          if (hset) alpha = hset.has(e.a) && hset.has(e.b) ? 0.12 + 0.5 * (e.w || 0.4) : 0.28
          if (e.dim) alpha *= 0.4
          // 万条图的边是主要亮度来源：几万条半透明线叠在一起会变成一整片白。
          if (state.nodes.length > 3000) alpha *= 0.16
          alpha *= Math.min(1, (rMin - 0.85) / 0.15)
          const col = TYPE_COLOR[e.t] || '#8fb8d8'
          const q = Math.round(Math.min(0.72, alpha) * 50) / 50
          edgePath(col + '|' + q, ax, ay, bx, by)
        }
        state.edgeCache = { key: edgeKey, buckets: edgeBuckets }
      }
      ctx.lineWidth = Math.max(0.5, k)
      for (const [bucket, p] of edgeBuckets) {
        const cut = bucket.lastIndexOf('|')
        const col = bucket.slice(0, cut)
        const a = Number(bucket.slice(cut + 1))
        ctx.strokeStyle = rgba(col, a)
        ctx.stroke(p)
      }

      // LOD 聚合光斑：一团一个，亮度和大小按条数走，旁边写条数
      if (agg.size) {
        for (const [, a] of agg) {
          const g = ctx.createRadialGradient(a.cx, a.cy, 0, a.cx, a.cy, a.rad)
          g.addColorStop(0, rgba(a.color, 0.5))
          g.addColorStop(0.35, rgba(a.color, 0.16))
          g.addColorStop(1, rgba(a.color, 0))
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(a.cx, a.cy, a.rad, 0, 6.2832)
          ctx.fill()
          ctx.strokeStyle = rgba(a.color, 0.34)
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(a.cx, a.cy, a.rad * 0.62, 0, 6.2832)
          ctx.stroke()
          const fs = Math.max(10, Math.min(13, a.rad * 0.34))
          ctx.font = `600 ${Math.round(fs)}px ui-monospace, Menlo, Consolas, monospace`
          ctx.textAlign = 'center'
          ctx.fillStyle = rgba(a.color, 0.95)
          ctx.fillText(String(a.n), a.cx, a.cy + fs * 0.36)
          ctx.font = `500 ${Math.round(fs * 0.82)}px system-ui, "Noto Sans SC", sans-serif`
          ctx.fillStyle = 'rgba(214, 232, 248, 0.82)'
          ctx.fillText(String(a.title || '').slice(0, 18), a.cx, a.cy + a.rad * 0.62 + fs + 4)
          ctx.textAlign = 'left'
        }
      }

      // 证据链：压在普通边上面重画一次，用暖金色，一眼能顺着走
      if (state.pathEdges && state.pathEdges.size) {
        ctx.save()
        ctx.lineCap = 'round'
        ctx.strokeStyle = 'rgba(255, 216, 138, 0.92)'
        ctx.lineWidth = Math.max(1.6, 2.6 * k)
        ctx.shadowColor = 'rgba(255, 200, 62, 0.55)'
        ctx.shadowBlur = 10 * Math.min(1.4, k)
        for (const e of state.edges) {
          const key = e.a < e.b ? e.a + '|' + e.b : e.b + '|' + e.a
          if (!state.pathEdges.has(key)) continue
          const a = e._a
          const b = e._b
          if (!a || !b) continue
          const [ax, ay] = toScreen(a.x, a.y)
          const [bx, by] = toScreen(b.x, b.y)
          const mx = (ax + bx) / 2
          const my = (ay + by) / 2
          const dl = Math.hypot(bx - ax, by - ay) || 1
          const nx = -(by - ay) / dl
          const ny = (bx - ax) / dl
          const bend = Math.min(26, dl * 0.16)
          ctx.beginPath()
          ctx.moveTo(ax, ay)
          ctx.quadraticCurveTo(mx + nx * bend, my + ny * bend, bx, by)
          ctx.stroke()
        }
        ctx.restore()
      }

      // 节点
      const labelQueue = []
      for (const n of state.nodes) {
        if (n.hidden) continue
        // LOD 聚合掉的簇，个体不再画（整团由一个光斑代表）
        if (agg.size && agg.has(n.cluster)) continue
        const [px, py] = toScreen(n.x, n.y)
        if (px < -60 || py < -60 || px > state.w + 60 || py > state.h + 60) continue
        const isSel = sel === n.id
        const isHl = hl === n.id
        const nearHl = hset ? hset.has(n.id) : false
        const dim = hset && !nearHl
        // 区块加载：还没点亮的节点不画；正在点亮的按 reveal 淡入 + 从 0.55 倍大小长到 1 倍
        const rev = n.reveal == null ? 1 : n.reveal
        if (rev <= 0.02) continue
        const grow = 0.55 + 0.45 * rev
        const r = Math.max(1.4, (n.r || nodeRadius(n)) * Math.min(1.6, 0.55 + k * 0.75) * grow)
        const colKey = n.color || LEVEL_COLOR[n.level] || '#9fb6cc'
        // 万条图：一万个光点叠在一起会把整片烧成白色。按密度压低单点亮度，
        // 让「一团」看起来是颗粒，而不是一块发光的墙。
        const dense = state.nodes.length > 3000 ? 0.085 : 1
        const intensity = (dim ? 0.62 : isSel || isHl ? 1 : nearHl ? 0.9 : 0.82) * rev * (0.72 + 0.28 * Math.min(1, k)) * dense
        // 光晕别随 k 无限放大：拉远时一堆光晕叠起来会把整片烧成白的
        const glow = r * (1.35 + 1.65 * Math.min(1, k)) * (isSel || isHl ? 1.5 : nearHl ? 1.25 : 1) * (state.nodes.length > 3000 ? 0.62 : 1)
        // 光点贴图缓存：同一层级色的发光小球只画一次，之后全是 drawImage
        // （原来每帧给 900+ 个节点各建两个径向渐变，缩放时明显卡）
        const bigGraph = state.nodes.length > 3000
        const prevAlpha = ctx.globalAlpha
        if (bigGraph && n.level !== 'source' && !isSel && !isHl) {
          // 一万条时不要一万个发光贴图：它们叠起来是一堵白墙。
          // 画成小颗粒，颜色还在，密度也还在，但不会把整片烧掉。
          ctx.globalAlpha = dim ? 0.16 : 0.62
          ctx.fillStyle = colKey
          ctx.beginPath()
          ctx.arc(px, py, Math.max(0.9, r * 0.3), 0, Math.PI * 2)
          ctx.fill()
        } else {
          const sprite = nodeSprite(colKey)
          ctx.globalAlpha = intensity
          ctx.drawImage(sprite, px - glow, py - glow, glow * 2, glow * 2)
        }
        ctx.globalAlpha = prevAlpha
        // 来源节点（技能 / MCP / 插件）用空心小菱标记，和记忆光点区分开
        if (n.level === 'source') {
          const s2 = Math.max(3.2, r + 1.6)
          ctx.strokeStyle = rgba(colKey, dim ? 0.3 : 0.95)
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.moveTo(px, py - s2)
          ctx.lineTo(px + s2, py)
          ctx.lineTo(px, py + s2)
          ctx.lineTo(px - s2, py)
          ctx.closePath()
          ctx.stroke()
          ctx.lineWidth = Math.max(0.5, k)
        }
        // 高重要性的环
        if ((n.importance || 0) >= 4 && !dim && k > 0.55) {
          ctx.strokeStyle = rgba('#ffd88a', 0.55)
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(px, py, r + 3.2, 0, 6.2832)
          ctx.stroke()
          ctx.lineWidth = Math.max(0.5, k)
        }
        // 证据链上的节点：编号 + 金环，方便和右侧的步骤一一对上
        if (state.pathIds && state.pathIds.has(n.id)) {
          const step = state.pathSeq ? state.pathSeq.indexOf(n.id) + 1 : 0
          ctx.strokeStyle = 'rgba(255, 216, 138, 0.95)'
          ctx.lineWidth = 1.6
          ctx.beginPath()
          ctx.arc(px, py, r + 5.4, 0, 6.2832)
          ctx.stroke()
          if (step) {
            const fs = Math.round(10 + Math.min(4, k))
            ctx.font = `600 ${fs}px "JetBrains Mono", ui-monospace, monospace`
            ctx.textAlign = 'center'
            const tx = px
            const ty = py - r - 9
            const txt = String(step)
            const w2 = ctx.measureText(txt).width + 8
            ctx.fillStyle = 'rgba(255, 216, 138, 0.92)'
            ctx.beginPath()
            ctx.roundRect ? ctx.roundRect(tx - w2 / 2, ty - fs, w2, fs + 5, 3) : ctx.rect(tx - w2 / 2, ty - fs, w2, fs + 5)
            ctx.fill()
            ctx.fillStyle = '#1a1206'
            ctx.fillText(txt, tx, ty - 3)
            ctx.textAlign = 'left'
          }
          ctx.lineWidth = Math.max(0.5, k)
        }
        if (isSel) {
          ctx.strokeStyle = rgba('#ffffff', 0.85)
          ctx.lineWidth = 1.4
          ctx.beginPath()
          ctx.arc(px, py, r + 6.5 + 2 * Math.sin(performance.now() / 320), 0, 6.2832)
          ctx.stroke()
          ctx.lineWidth = Math.max(0.5, k)
        }
        const wantLabel =
          rev > 0.7 &&
          (isSel || isHl || nearHl || (k > 1.05 && (n.importance || 0) >= 3) || (k > 1.6 && (n.degree || 0) >= 8))
        if (wantLabel && state.labels) labelQueue.push({ n, px, py, r, dim, strong: isSel || isHl })
      }

      // 标签（后画，避免被节点盖住）。按「选中 > 悬停 > 重要度 > 度数」排序后限量，
      // 否则放大时几百个标签一起铺满画面，什么都看不清。
      ctx.textAlign = 'left'
      labelQueue.sort(
        (p, q) =>
          (q.strong ? 1 : 0) - (p.strong ? 1 : 0) ||
          (q.n.importance || 0) - (p.n.importance || 0) ||
          (q.n.degree || 0) - (p.n.degree || 0),
      )
      const labelTaken = []
      for (const item of labelQueue.slice(0, 64)) {
        const { n, px, py, r, dim } = item
        const text = String(n.label || n.title || '')
        if (!text) continue
        const fs = Math.min(13, 10.5 + k * 0.6)
        ctx.font = `${item.strong ? 600 : 400} ${fs}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`
        const tw = ctx.measureText(text).width
        const maxW = 190
        const shown = tw > maxW ? text.slice(0, Math.max(4, Math.floor((maxW / tw) * text.length))) + '…' : text
        const w2 = ctx.measureText(shown).width
        const box = { x: px + r + 5, y: py - fs * 0.72, w: w2 + 8, h: fs * 1.42 }
        if (labelTaken.some((b) => Math.abs(b.x - box.x) < (b.w + box.w) / 2 + 4 && Math.abs(b.y - box.y) < (b.h + box.h) / 2 + 2)) continue
        labelTaken.push(box)
        ctx.fillStyle = `rgba(4,6,12,${dim ? 0.5 : 0.66})`
        ctx.fillRect(box.x, box.y, box.w, box.h)
        ctx.fillStyle = dim ? 'rgba(150,175,200,0.35)' : item.strong ? '#f2fbff' : 'rgba(200,220,240,0.82)'
        ctx.fillText(shown, px + r + 9, py + fs * 0.36)
      }

      // 簇名最后画：不压在星团里——从画面中心朝星团方向推到簇外，用细引导线牵回去
      const taken = []
      const midX = state.w / 2
      const midY = state.h / 2
      for (const label of clusterLabels) {
        const fs = Math.min(15, 10 + 3 * k)
        ctx.save()
        ctx.font = `500 ${fs}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`
        ctx.textAlign = 'center'
        const w = ctx.measureText(label.text).width
        let dx = label.ax - midX
        let dy = label.ay - midY
        const len = Math.hypot(dx, dy) || 1
        dx /= len
        dy /= len
        const push = Math.min(len + label.rad * 0.55 + 26, Math.min(state.w, state.h) * 0.5)
        let lx = label.ax + dx * (label.rad * 0.9 + 30)
        let ly = label.ay + dy * (label.rad * 0.9 + 30)
        lx = Math.min(Math.max(lx, w / 2 + 16), state.w - w / 2 - 16)
        ly = Math.min(Math.max(ly, fs + 52), state.h - 32)
        // 撞了别直接丢：先上下让一让（最多三次），让不开才放弃。
        // 以前一撞就 continue，缩小时总有一两个簇名静默消失，看着像漏渲染。
        const hitAt = (tx, ty) => taken.some((t) => Math.abs(t.x - tx) < (t.w + w) / 2 + 12 && Math.abs(t.y - ty) < 26)
        const minY = fs + 52
        const maxY = state.h - 32
        let placed = false
        for (const dy2 of [0, -(fs + 16), fs + 16, -(fs * 2 + 26), fs * 2 + 26]) {
          const ty = Math.min(Math.max(ly + dy2, minY), maxY)
          if (!hitAt(lx, ty)) {
            ly = ty
            placed = true
            break
          }
        }
        if (!placed) {
          ctx.restore()
          continue
        }
        taken.push({ x: lx, y: ly, w })
        // 引导线：从簇边到标签
        ctx.strokeStyle = rgba(label.col, 0.16)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(label.ax + dx * label.rad * 0.35, label.ay + dy * label.rad * 0.35)
        ctx.lineTo(lx, ly)
        ctx.stroke()
        ctx.fillStyle = 'rgba(4,6,12,0.55)'
        ctx.beginPath()
        const rx = lx - w / 2 - 9
        const ry = ly - fs * 1.05
        const rw = w + 18
        const rh = fs * 1.5
        const rr = rh / 2
        ctx.moveTo(rx + rr, ry)
        ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, rr)
        ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, rr)
        ctx.arcTo(rx, ry + rh, rx, ry, rr)
        ctx.arcTo(rx, ry, rx + rw, ry, rr)
        ctx.fill()
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '1.5px'
        ctx.fillStyle = rgba(label.col, 0.86)
        ctx.fillText(label.text, lx, ly)
        ctx.restore()
      }

      // 时间模式：左侧行名 + 底部时间刻度
      if (state.mode === 'time' && state.timeRange && state.timeRows) {
        const { min, max } = state.timeRange
        const leftX = Math.max(300, toScreen(-0.38 * state.w, 0)[0])
        const rightX = toScreen(0.38 * state.w, 0)[0]
        const avail = Math.max(46, leftX - 14 - 272)
        ctx.save()
        ctx.font = '500 11px Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
        ctx.textAlign = 'right'
        for (const row of state.timeRows) {
          const sy = toScreen(0, row.y)[1]
          if (sy < 40 || sy > state.h - 6) continue
          ctx.fillStyle = rgba(row.color || '#6cc8ff', 0.92)
          let label = String(row.title).toUpperCase()
          while (label.length > 3 && ctx.measureText(label).width > avail) label = label.slice(0, -1)
          if (label !== String(row.title).toUpperCase()) {
            while (label.length > 3 && ctx.measureText(label + '…').width > avail) label = label.slice(0, -1)
            label += '…'
          }
          ctx.fillText(label, leftX - 12, sy + 4)
          ctx.strokeStyle = rgba(row.color || '#6cc8ff', 0.12)
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(leftX - 6, sy)
          ctx.lineTo(rightX, sy)
          ctx.stroke()
        }
        // 时间刻度：按跨度自适应（小时/天/月）
        const HOUR = 3600000
        const DAY = 86400000
        const span = Math.max(1, max - min)
        const steps = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 365 * DAY]
        const stepMs = steps.find((s) => span / s <= 8) || 365 * DAY
        const shortSpan = span <= 3 * DAY
        const fmt = (d) => {
          const p = (v) => String(v).padStart(2, '0')
          if (stepMs < DAY) return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
          return `${d.getMonth() + 1}/${d.getDate()}`
        }
        const start = new Date(min)
        if (stepMs >= DAY) {
          start.setHours(0, 0, 0, 0)
          if (stepMs >= 30 * DAY) start.setDate(1)
        } else {
          start.setMinutes(0, 0, 0)
          start.setHours(Math.floor(start.getHours() / (stepMs / HOUR)) * (stepMs / HOUR))
        }
        const t = new Date(start.getTime() + stepMs)
        ctx.textAlign = 'center'
        ctx.font = '500 10.5px Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
        ctx.fillStyle = 'rgba(170,200,230,0.82)'
        while (t.getTime() < max) {
          const worldX = state.w * 0.12 + ((t.getTime() - min) / Math.max(1, max - min)) * state.w * 0.76 - state.w / 2
          const x = toScreen(worldX, 0)[0]
          if (x > leftX && x < rightX + 40) {
            ctx.fillText(fmt(t), x, state.h - 34)
            ctx.strokeStyle = 'rgba(150,180,210,0.12)'
            ctx.beginPath()
            ctx.moveTo(x, 46)
            ctx.lineTo(x, state.h - 44)
            ctx.stroke()
          }
          t.setTime(t.getTime() + stepMs)
        }
        if (shortSpan) {
          ctx.textAlign = 'left'
          ctx.fillStyle = 'rgba(150,180,210,0.55)'
          ctx.fillText(T('最近 ') + Math.round(span / HOUR) + T(' 小时'), leftX, state.h - 16)
        }
        ctx.restore()
      }

      // 脉冲：沿边的激活传播
      const now = performance.now()
      state.pulses = state.pulses.filter((p) => now - p.t0 < p.life)
      for (const p of state.pulses) {
        const prog = (now - p.t0) / p.life
        const ease = 1 - Math.pow(1 - prog, 2.2)
        const a = p._a
        const b = p._b
        if (!a || !b) continue
        const [ax, ay] = toScreen(a.x, a.y)
        const [bx, by] = toScreen(b.x, b.y)
        const x = ax + (bx - ax) * ease
        const y = ay + (by - ay) * ease
        const rad = 6 + 4 * Math.sin(prog * Math.PI)
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad * 2.4)
        g.addColorStop(0, `rgba(150,240,255,${0.85 * (1 - prog * 0.6)})`)
        g.addColorStop(1, 'rgba(150,240,255,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, rad * 2.4, 0, 6.2832)
        ctx.fill()
      }

      // 正在被「点亮」的节点呼吸圈
      for (const id of state.pulseNodes || []) {
        const n = state.byId.get(id)
        if (!n) continue
        const [px, py] = toScreen(n.x, n.y)
        const tt = (now % 1600) / 1600
        ctx.strokeStyle = `rgba(150,240,255,${0.55 * (1 - tt)})`
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(px, py, n.r + 6 + tt * 26, 0, 6.2832)
        ctx.stroke()
      }
      ctx.lineWidth = Math.max(0.5, k)
    }

    function frame(ts) {
      if (state.pump) {
        pumpReveal(ts || performance.now())
        draw()
      }
      if (state.moving) {
        simulate(1, 0.994)
        draw()
        state.moving = false
      }
      if (state.target) {
        const t = state.target
        const s = 0.14
        state.cam.k += (t.k - state.cam.k) * s
        state.cam.x += (t.x - state.cam.x) * s
        state.cam.y += (t.y - state.cam.y) * s
        if (Math.abs(t.k - state.cam.k) < 0.002 && Math.abs(t.x - state.cam.x) < 0.6 && Math.abs(t.y - state.cam.y) < 0.6) {
          state.cam.k = t.k
          state.cam.x = t.x
          state.cam.y = t.y
          state.target = null
        }
        draw()
      }
      if (state.pulses.length || (state.pulseNodes && state.pulseNodes.length)) draw()
      requestAnimationFrame(frame)
    }

    // ---------------- 交互 ----------------
    let rafId = 0
    api.redraw = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        draw()
      })
    }
    // 调试用：同步画一帧并返回耗时
    api.drawNow = () => {
      const t0 = performance.now()
      draw()
      return performance.now() - t0
    }
    // 调试用：看一眼内部状态（NaN 排查 + 「边到底去哪了」三段闸门）
    api.debugState = () => {
      let passFilter = 0
      let passReveal = 0
      for (const e of state.edges) {
        if (!visibleEdge(e)) continue
        passFilter++
        const ra = e._a && e._a.reveal != null ? e._a.reveal : 1
        const rb = e._b && e._b.reveal != null ? e._b.reveal : 1
        if ((ra < rb ? ra : rb) >= 0.85) passReveal++
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of state.nodes) {
        if (!isFinite(n.x) || !isFinite(n.y)) continue
        if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x
        if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y
      }
      return {
        cam: { ...state.cam },
        bounds: { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY },
        farNodes: state.nodes.filter((n) => Math.abs(n.x) > 3000 || Math.abs(n.y) > 3000).length,
        size: { w: state.w, h: state.h },
        clusters: state.clusters.length,
        sample: state.nodes.slice(0, 3).map((n) => ({ id: n.id, x: n.x, y: n.y, r: n.r, cluster: n.cluster })),
        bad: state.nodes.filter((n) => !isFinite(n.x) || !isFinite(n.y)).length,
        // 「连接消失」排查三件套
        edges: state.edges.length,
        edgesPassFilter: passFilter,
        edgesPassReveal: passReveal,
        nodesRevealed: state.nodes.filter((n) => (n.reveal == null ? 1 : n.reveal) >= 0.85).length,
        pump: state.pump ? { done: state.pump.done, ticks: state.pump.ticks } : null,
        alpha: state.alpha,
        mode: state.mode,
        // 边路径缓存是否命中：perf 探针靠这两个数判断「每帧重建 6382 条曲线」有没有发生
        edgeCache: state.edgeCache ? state.edgeCache.buckets.size : 0,
        geoVersion: state.geoVersion || 0,
        filter: state.filter
          ? {
              ws: state.filter.ws ? state.filter.ws.size : null,
              levels: state.filter.levels ? state.filter.levels.size : null,
              types: state.filter.types ? state.filter.types.size : null,
              providers: state.filter.providers ? state.filter.providers.size : null,
              minW: state.filter.minW || 0,
              minImp: state.filter.minImp || 0,
            }
          : null,
      }
    }
    // 切回 2D 时补量一次：canvas 在 3D 模式下是隐藏的，window.resize 不会因切模式而触发
    api.resize = resize

    // 导出前把「还在长」的那一屏直接点亮：否则刚点完重建就导出，会拿到一张只长了一半的图
    api.finishReveal = () => {
      if (state.pump) {
        for (const n of state.nodes) n.reveal = 1
        state.pump = null
        state.alpha = 1
        draw()
        return true
      }
      return false
    }

    api.wake = (ticks) => {
      state.alpha = Math.max(state.alpha, 0.55)
      simulate(ticks || 40, 0.985)
      api.redraw()
    }

    api.visibleNodes = function visibleNodes() {
      const f = state.filter
      if (!f) return state.nodes
      return state.nodes.filter((n) => n.visible !== false)
    }

    api.setFilter = function setFilter(filter) {
      state.filter = filter
      const f = filter
      for (const n of state.nodes) {
        let vis = true
        if (f.ws && !f.ws.has(n.ws)) vis = false
        if (f.levels && !f.levels.has(n.level)) vis = false
        if (f.providers && !f.providers.has(n.provider || 'meow-memory')) vis = false
        if (f.minImp && (n.importance || 0) < f.minImp) vis = false
        n.hidden = !vis
        n.visible = vis
      }
      state.hiddenVersion = (state.hiddenVersion || 0) + 1
      api.redraw()
    }

    api.highlight = function highlight(id) {
      state.highlight = id
      if (!id) {
        state.highlightSet = null
      } else {
        const set = new Set([id])
        for (const e of state.edges) {
          if (e.a === id) set.add(e.b)
          else if (e.b === id) set.add(e.a)
        }
        state.highlightSet = set
      }
      api.redraw()
    }

    api.select = function select(id) {
      state.selected = id
      api.redraw()
    }

    /** 高亮一条证据链（按顺序的节点 id）；传 null 清掉。 */
    api.setPath = function setPath(ids) {
      if (!ids || ids.length < 2) {
        state.pathSeq = null
        state.pathIds = null
        state.pathEdges = null
        api.redraw()
        return
      }
      state.pathSeq = ids.slice()
      state.pathIds = new Set(ids)
      const edges = new Set()
      for (let i = 0; i + 1 < ids.length; i += 1) {
        const a = ids[i]
        const b = ids[i + 1]
        edges.add(a < b ? a + '|' + b : b + '|' + a)
      }
      state.pathEdges = edges
      api.redraw()
    }

    /** 程序化打开某条记忆（调试与「从搜索直接定位」共用）。 */
    api.open = function open(id) {
      api.select(id)
      emit('select', id)
    }

    /** 某条记忆在屏幕上的坐标（调试、自动化测试用）。 */
    api.screenOf = function screenOf(id) {
      const n = state.byId.get(id)
      if (!n || n.hidden) return null
      const [x, y] = toScreen(n.x, n.y)
      return { x, y, r: (n.r || nodeRadius(n)) * state.cam.k }
    }

    api.focusNode = function focusNode(id, zoom) {
      const n = state.byId.get(id)
      if (!n) return
      const k = zoom || Math.max(1.5, state.cam.k)
      // 让节点落在「可用区域」的正中（左侧筛选栏、右侧详情栏都是空的），
      // 不然打开详情后焦点会被面板压住半边。
      const P = state.pad || { left: 0, right: 0, top: 0, bottom: 0 }
      const availW = Math.max(220, state.w - P.left - P.right)
      const availH = Math.max(220, state.h - P.top - P.bottom)
      const cx = P.left + availW / 2 - state.w / 2
      const cy = P.top + availH / 2 - state.h / 2
      state.target = { k, x: n.x - cx / k, y: n.y - cy / k }
    }

    /**
     * 键盘行走用：只把镜头平移到这颗星，缩放不动。
     * 方向键是「走过去看」，不是每次重新构图——每按一下都变焦会晕。
     */
    api.centerOn = function centerOn(id) {
      const n = state.byId.get(id)
      if (!n) return
      const P = state.pad || { left: 0, right: 0, top: 0, bottom: 0 }
      const availW = Math.max(220, state.w - P.left - P.right)
      const availH = Math.max(220, state.h - P.top - P.bottom)
      const cx = P.left + availW / 2 - state.w / 2
      const cy = P.top + availH / 2 - state.h / 2
      state.target = { k: state.cam.k, x: n.x - cx / state.cam.k, y: n.y - cy / state.cam.k }
    }

    /**
     * 键盘加号/减号用：以当前视口中心为轴缩一档。
     * 上下限和滚轮完全一致（0.18–5.5），否则键盘能把视图推进滚轮到不了的死角。
     */
    api.zoomBy = function zoomBy(factor) {
      const f = Number(factor)
      if (!f || !isFinite(f) || f <= 0) return state.cam.k
      const k = Math.min(5.5, Math.max(0.18, state.cam.k * f))
      if (k === state.cam.k) return k
      state.target = null
      state.cam.k = k
      api.redraw()
      return k
    }

    /** 从一组种子沿边打出脉冲。 */
    api.pulseFrom = function pulseFrom(ids, spread) {
      const now = performance.now()
      const set = new Set(ids || [])
      const out = []
      let budget = 220
      for (const e of state.edges) {
        if (budget <= 0) break
        if (!set.has(e.a) && !set.has(e.b)) continue
        if (e.w < (spread ? 0.25 : 0.4)) continue
        out.push({ ...e, t0: now + Math.random() * 260, life: 900 + Math.random() * 700 })
        budget--
      }
      state.pulses.push(...out)
      state.pulseNodes = ids || []
      setTimeout(() => {
        state.pulseNodes = []
        api.redraw()
      }, 2400)
      api.redraw()
    }

    api.debug = function debug() {
      return {
        mode: state.mode,
        timeRange: state.timeRange,
        rows: (state.timeRows || []).length,
        w: state.w, h: state.h, k: state.k,
      }
    }

    api.setMode = function setMode(mode) {
      if (mode === state.mode) return
      state.mode = mode
      if (mode === 'time') {
        layoutTime()
        for (const n of state.nodes) {
          n.x = n.tx
          n.y = n.ty
          n.vx = 0
          n.vy = 0
        }
        api.fit()
        api.redraw()
      } else {
        state.alpha = 0.9
        simulate(120, 0.985)
        api.fit()
        api.redraw()
      }
    }

    // 指针
    function pos(ev) {
      const rect = canvas.getBoundingClientRect()
      return [ev.clientX - rect.left, ev.clientY - rect.top]
    }
    function pick(sx, sy) {
      const [wx, wy] = toWorld(sx, sy)
      let best = null
      let bestD = Infinity
      const tol = Math.max(10, 14 / state.cam.k)
      for (const n of state.nodes) {
        if (n.hidden) continue
        const d = Math.hypot(n.x - wx, n.y - wy)
        if (d < tol && d < bestD) {
          bestD = d
          best = n
        }
      }
      return best
    }

    // 双击空白 = 回全视图（双击节点＝聚焦它，别抢）
    canvas.addEventListener('dblclick', (ev) => {
      if (pick(ev.offsetX, ev.offsetY)) return
      api.fit()
    })

    canvas.addEventListener('pointerdown', (ev) => {
      // 中键/右键只负责拖视角，永远不选中节点；左键才点选与拖节点。
      const [sx, sy] = pos(ev)
      const panOnly = ev.button !== 0
      if (panOnly) ev.preventDefault()
      canvas.setPointerCapture(ev.pointerId)
      const n = panOnly ? null : pick(sx, sy)
      if (n) {
        state.drag = { type: 'node', node: n, sx, sy, button: ev.button, moved: false }
        n.pinned = true
      } else {
        state.drag = { type: 'pan', sx, sy, camX: state.cam.x, camY: state.cam.y, button: ev.button }
        canvas.classList.add('dragging')
      }
    })

    canvas.addEventListener('auxclick', (ev) => { if (ev.button === 1) ev.preventDefault() })
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault())

    canvas.addEventListener('pointermove', (ev) => {
      const [sx, sy] = pos(ev)
      state.pointer.x = sx
      state.pointer.y = sy
      if (state.drag) {
        if (state.drag.type === 'pan') {
          state.cam.x = state.drag.camX - (sx - state.drag.sx) / state.cam.k
          state.cam.y = state.drag.camY - (sy - state.drag.sy) / state.cam.k
          state.target = null
          if (!state.drag.moved && Math.hypot(sx - state.drag.sx, sy - state.drag.sy) > 4) state.drag.moved = true
        } else {
          const [wx, wy] = toWorld(sx, sy)
          const n = state.drag.node
          n.x = wx
          n.y = wy
          n.vx = 0
          n.vy = 0
          if (!state.drag.moved && Math.hypot(sx - state.drag.sx, sy - state.drag.sy) > 4) state.drag.moved = true
          state.moving = true
        }
        api.redraw()
        return
      }
      const n = pick(sx, sy)
      canvas.classList.toggle('pointing', !!n)
      if ((n && n.id) !== state.hover) {
        state.hover = n ? n.id : null
        api.highlight(state.hover)
        emit('hover', n ? { id: n.id, x: sx, y: sy } : null)
      }
    })

    function endDrag(ev) {
      if (state.drag) {
        if (state.drag.type === 'node') {
          state.drag.node.pinned = false
          state.moving = true
        }
        if (state.drag.type === 'pan') canvas.classList.remove('dragging')
        state.drag = null
      }
    }
    canvas.addEventListener('pointerup', (ev) => {
      const drag = state.drag
      const [sx, sy] = pos(ev)
      const moved = drag && (drag.moved || Math.hypot(sx - drag.sx, sy - drag.sy) > 4)
      endDrag(ev)
      // 只有「左键 + 没拖动」才算一次点选
      if (!drag || drag.button !== 0 || moved) return
      // 拉远到「光斑」这一档时，人在光斑上点的意思几乎总是「进去看看」，
      // 而不是「选中光斑底下恰好压着的那一个点」——所以先判 LOD，再判单点。
      const wsAt = api.lodAt(sx, sy)
      if (wsAt) {
        api.focusCluster(wsAt)
        emit('lod', wsAt)
        return
      }
      const n = pick(sx, sy)
      if (n && ev.shiftKey && state.selected && state.selected !== n.id) {
        // Shift + 点：不是换选中，而是问「选中的那条和这条，中间怎么连上的」
        emit('path', { from: state.selected, to: n.id })
        return
      }
      if (n) {
        api.select(n.id)
        emit('select', n.id)
      } else {
        // 点空处：如果落在 LOD 聚合光斑上，等于「下钻进这个项目」
        const ws = api.lodAt(sx, sy)
        if (ws) {
          api.focusCluster(ws)
          emit('lod', ws)
          return
        }
        api.select(null)
        emit('select', null)
      }
    })
    canvas.addEventListener('pointerleave', () => {
      if (!state.drag) api.highlight(null)
    })

    canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault()
        const [sx, sy] = pos(ev)
        const [wx, wy] = toWorld(sx, sy)
        const factor = Math.exp(-ev.deltaY * 0.0016)
        const k = Math.min(5.5, Math.max(0.18, state.cam.k * factor))
        state.cam.k = k
        // 保持鼠标下的世界点不动
        state.cam.x = wx - (sx - state.w / 2) / k
        state.cam.y = wy - (sy - state.h / 2) / k
        state.target = null
        api.redraw()
      },
      { passive: false },
    )

    window.addEventListener('resize', resize)
    resize()
    requestAnimationFrame(frame)
    window.__nebulaStage = api
    return api
  }

  N.LEVEL_COLOR = LEVEL_COLOR
  N.TYPE_COLOR = TYPE_COLOR
  N.rgba = rgba
})()

/* 顶部导航的悬停提示 */
