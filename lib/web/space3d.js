/* 记忆星图 · 星系视图（WebGL，零依赖，真三维）
 *
 * 两副「三维透镜」，共用一个渲染器：
 *   layout = 'cluster' —— 三维力导向星系。簇心给弱引力、边给弹簧、节点互相排斥，
 *                         结构由真实连接决定；重要度越高的记忆越贴簇核。
 *   layout = 'spiral'  —— 时间螺旋星系。半径 = 记忆年龄（新的从中心长出来），
 *                         每个工作区一条旋臂，越重要的越薄。
 *
 * 这一版是**真三维**：真正的投影矩阵、真正的深度缓冲、真正的球面着色。
 *   - 相机有位置和目标点，绕目标旋转；滚轮沿视线推进；中键/右键平移目标点。
 *   - 节点是面向相机的小球（billboard + 法线着色），开深度测试，近的挡住远的。
 *   - 连线是三维空间里的线段，同样吃深度，会在球后面被挡住。
 *   - 远处自动压暗（雾），近处亮 —— 靠几何而不是靠后期发光来表现纵深。
 *
 * 交互：左键点星=详情 / 左键拖=转视角 / 中键右键拖=平移 / 滚轮=推进 / 双击=复位
 */
(function () {
  'use strict'
  /** 中文即源文：英文模式查 i18n.js 的表，查不到就原样返回中文。 */
  const T = (zh, vars) => (window.NebulaI18n ? window.NebulaI18n.t(zh, vars) : zh)

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
    explicit: [1.0, 0.85, 0.54],
    project: [0.42, 0.78, 1.0],
    entity: [0.5, 0.94, 0.78],
    keyword: [0.76, 0.61, 1.0],
    semantic: [0.47, 0.88, 0.71],
    hebbian: [1.0, 0.64, 0.42],
    mentions: [0.55, 0.88, 1.0],
  }
  const TAU = Math.PI * 2
  const LAYOUT_VERSION = 'v7'

  function hexToRgb(hex) {
    const h = String(hex || '#9fb6cc').replace('#', '')
    const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    const n = parseInt(v, 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }

  function hashString(s) {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0) / 4294967295
  }

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v
  }

  // ---------- 4x4 矩阵（列主序，直接喂 GL）----------
  function mat4() {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  }

  function multiply(out, a, b) {
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3]
      }
    }
    return out
  }

  function perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2)
    out.fill(0)
    out[0] = f / aspect
    out[5] = f
    out[10] = (far + near) / (near - far)
    out[11] = -1
    out[14] = (2 * far * near) / (near - far)
    return out
  }

  /** 视图矩阵：相机在目标点外的球面上，看向目标点 */
  function lookAtTarget(out, yaw, pitch, dist, tx, ty, tz) {
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    // 相机位置（绕目标点的球面）
    const ex = tx + dist * cp * sy
    const ey = ty + dist * sp
    const ez = tz + dist * cp * cy
    // 手写 lookAt
    let zx = ex - tx, zy = ey - ty, zz = ez - tz
    let len = Math.hypot(zx, zy, zz) || 1
    zx /= len; zy /= len; zz /= len
    let xx = zz * 0 - zy * 0 + (0 * zz - 1 * zy) // 用 up=(0,1,0) 交叉
    xx = 1 * zz - 0 * zy
    let xy = 0 * zx - 0 * zz
    let xz = 0 * zy - 1 * zx
    len = Math.hypot(xx, xy, xz) || 1
    xx /= len; xy /= len; xz /= len
    const yx = zy * xz - zz * xy
    const yy = zz * xx - zx * xz
    const yz = zx * xy - zy * xx
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0
    out[12] = -(xx * ex + xy * ey + xz * ez)
    out[13] = -(yx * ex + yy * ey + yz * ez)
    out[14] = -(zx * ex + zy * ey + zz * ez)
    out[15] = 1
    return out
  }

  function create(canvas, labelCanvas, opts) {
    opts = opts || {}
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      depth: true,
    })
    if (!gl) throw new Error('WebGL context unavailable')
    const lctx = labelCanvas ? labelCanvas.getContext('2d') : null

    const listeners = { select: [], hover: [] }
    function emit(evt, payload) {
      for (const fn of listeners[evt] || []) fn(payload)
    }

    const state = {
      active: false,
      layout: 'cluster',
      nodes: [],
      edges: [],
      byId: new Map(),
      clusters: [],
      graph: null,
      hover: null,
      selected: null,
      highlightSet: null,
      pathIds: null,
      pathEdges: null,
      pulse: new Map(),
      filter: { ws: null, levels: null, types: null, minW: 0, minImp: 0 },
      timeCut: 0, // 时间回放：只显示 createdAt <= timeCut 的记忆（0 = 不过滤）
      pad: { left: 16, right: 16, top: 76, bottom: 48 },
      cam: { yaw: 0.62, pitch: 0.28, dist: 2400, tx: 0, ty: 0, tz: 0, panX: 0, panY: 0 },
      inertia: { yaw: 0, pitch: 0 },
      target: null,
      size: { w: 1, h: 1, dpr: 1 },
      drag: null,
      // 系统开了「减少动态效果」就不自动转：一直转的星空对前庭敏感的人是负担
      spin: !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
      autoFit: false,
      force: { running: false, alpha: 0, iter: 0, maxIter: 320 },
      spiral: { maxAge: 1, rings: [], arms: [] },
      proj: mat4(),
      view: mat4(),
    }

    // ---------- shaders ----------
    function compile(type, src) {
      const sh = gl.createShader(type)
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('shader: ' + gl.getShaderInfoLog(sh))
      }
      return sh
    }
    function program(vsSrc, fsSrc) {
      const p = gl.createProgram()
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc))
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc))
      gl.linkProgram(p)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error('program: ' + gl.getProgramInfoLog(p))
      }
      return p
    }

    // 球：三维世界坐标 → 点精灵。片元里用 gl_PointCoord 造球面法线，
    // 参与深度测试（近的挡住远的），但不引入四边形索引，稳。
    const ballProg = program(
      `attribute vec3 aCenter; attribute vec3 aColor;
       attribute float aSize; attribute float aAlpha; attribute float aShape;
       uniform mat4 uProj; uniform mat4 uView; uniform vec2 uPan; uniform float uPxScale;
       varying vec3 vColor; varying float vAlpha; varying float vFog; varying float vShape;
       void main() {
         vec4 mv = uView * vec4(aCenter, 1.0);
         vec4 clip = uProj * mv;
         clip.xy += uPan * clip.w;
         gl_Position = clip;
         float px = (aSize * uPxScale) / max(1.0, -mv.z);
         // 来源节点（菱形）给一个更高的最小像素，远远看也能认出它不是记忆
         gl_PointSize = clamp(px * (aShape > 0.5 ? 1.75 : 1.35), aShape > 0.5 ? 3.5 : 1.5, 18.0);
         vColor = aColor;
         vAlpha = aAlpha;
         vShape = aShape;
         vFog = clamp((-mv.z - 2200.0) / 6000.0, 0.0, 0.72);
       }`,
      `precision mediump float;
       varying vec3 vColor; varying float vAlpha; varying float vFog; varying float vShape;
       void main() {
         vec2 c = gl_PointCoord * 2.0 - 1.0;
         c.y = -c.y;
         // aShape = 1 时用 L1 距离造菱形（来源节点：技能 / MCP / 插件）
         float rc = length(c);
         float rd = (abs(c.x) + abs(c.y)) * 0.78;
         float r = mix(rc, rd, step(0.5, vShape));
         if (r > 1.0) discard;
         // 光点：核心一点白热，外面一圈很淡的晕；菱形核心更实，像个小宝石
         float core = exp(-r * r * 5.5);
         float halo = pow(max(0.0, 1.0 - r), 2.4) * 0.42;
         vec3 col = vColor * (1.0 + 0.45 * core);
         float a = (core * 0.92 + halo * 0.80) * vAlpha * (1.0 - vFog * 0.45);
         gl_FragColor = vec4(col, a);
       }`
    )
    const bLoc = {
      center: gl.getAttribLocation(ballProg, 'aCenter'),
      color: gl.getAttribLocation(ballProg, 'aColor'),
      size: gl.getAttribLocation(ballProg, 'aSize'),
      alpha: gl.getAttribLocation(ballProg, 'aAlpha'),
      shape: gl.getAttribLocation(ballProg, 'aShape'),
      proj: gl.getUniformLocation(ballProg, 'uProj'),
      view: gl.getUniformLocation(ballProg, 'uView'),
      pan: gl.getUniformLocation(ballProg, 'uPan'),
      pxScale: gl.getUniformLocation(ballProg, 'uPxScale'),
    }

    // 连线：三维线段，吃深度，远处淡
    const wireProg = program(
      `attribute vec3 aPos; attribute vec4 aColor;
       uniform mat4 uProj; uniform mat4 uView; uniform vec2 uPan;
       varying vec4 vColor;
       void main() {
         vec4 mv = uView * vec4(aPos, 1.0);
         vec4 clip = uProj * mv;
         clip.xy += uPan * clip.w;
         gl_Position = clip;
         float fog = clamp((-mv.z - 1400.0) / 6000.0, 0.0, 0.8);
         vColor = vec4(aColor.rgb, aColor.a * (1.0 - fog * 0.75));
       }`,
      `precision mediump float; varying vec4 vColor;
       void main() { gl_FragColor = vColor; }`
    )
    const wLoc = {
      pos: gl.getAttribLocation(wireProg, 'aPos'),
      color: gl.getAttribLocation(wireProg, 'aColor'),
      proj: gl.getUniformLocation(wireProg, 'uProj'),
      view: gl.getUniformLocation(wireProg, 'uView'),
      pan: gl.getUniformLocation(wireProg, 'uPan'),
    }

    const ballBuf = {
      center: gl.createBuffer(),
      corner: gl.createBuffer(),
      color: gl.createBuffer(),
      size: gl.createBuffer(),
      alpha: gl.createBuffer(),
      shape: gl.createBuffer(),
    }
    const wireBuf = { pos: gl.createBuffer(), color: gl.createBuffer() }
    const ballIdx = gl.createBuffer()

    // ---------- layout: cluster (force directed) ----------
    function seedClusterCenters() {
      const counts = new Map()
      for (const n of state.nodes) counts.set(n.cluster, (counts.get(n.cluster) || 0) + 1)
      for (const c of state.clusters) c._n = counts.get(c.id) || 1
      const order = state.clusters.slice().sort((a, b) => b._n - a._n)
      const golden = Math.PI * (3 - Math.sqrt(5))
      order.forEach((c, i) => {
        const y = 1 - (i / Math.max(1, order.length - 1)) * 2
        const ring = Math.sqrt(Math.max(0, 1 - y * y))
        const th = golden * i
        const shell = 780 + (i === 0 ? 0 : 110)
        c._rad = 62 + Math.sqrt(c._n) * 10.5
        c._cx = Math.cos(th) * ring * shell
        c._cy = y * shell * 0.78
        c._cz = Math.sin(th) * ring * shell
      })
    }

    function seedClusterNodes() {
      const byCluster = new Map(state.clusters.map((c) => [c.id, c]))
      for (const n of state.nodes) {
        const c = byCluster.get(n.cluster) || { _cx: 0, _cy: 0, _cz: 0, _rad: 220 }
        const r1 = hashString(n.id)
        const r2 = hashString(n.id + 'y')
        const r3 = hashString(n.id + 'z')
        const imp = clamp(n.importance || 1, 1, 4)
        const depth = 1 - (imp - 1) / 3
        const r = c._rad * (1.08 - 0.82 * depth) * (0.55 + 0.65 * Math.sqrt(r1))
        const phi = r2 * TAU
        const cosT = 2 * r3 - 1
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
        n.x3 = c._cx + Math.cos(phi) * sinT * r
        n.y3 = c._cy + cosT * r * 0.85
        n.z3 = c._cz + Math.sin(phi) * sinT * r
        n.vx = 0
        n.vy = 0
        n.vz = 0
      }
    }

    function buildOctree(nodes) {
      let minX = Infinity, minY = Infinity, minZ = Infinity
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      for (const n of nodes) {
        if (n.x3 < minX) minX = n.x3
        if (n.y3 < minY) minY = n.y3
        if (n.z3 < minZ) minZ = n.z3
        if (n.x3 > maxX) maxX = n.x3
        if (n.y3 > maxY) maxY = n.y3
        if (n.z3 > maxZ) maxZ = n.z3
      }
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      const cz = (minZ + maxZ) / 2
      const half = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1) / 2 + 1
      const root = { x: cx, y: cy, z: cz, half, mass: 0, comx: 0, comy: 0, comz: 0, kids: null, items: [] }

      function cellFor(node, n) {
        const h = node.half / 2
        const i = (n.x3 >= node.x ? 4 : 0) + (n.y3 >= node.y ? 2 : 0) + (n.z3 >= node.z ? 1 : 0)
        return {
          i,
          cell: {
            x: node.x + (n.x3 >= node.x ? h : -h),
            y: node.y + (n.y3 >= node.y ? h : -h),
            z: node.z + (n.z3 >= node.z ? h : -h),
            half: h,
            mass: 0,
            comx: 0,
            comy: 0,
            comz: 0,
            kids: null,
            items: [],
          },
        }
      }

      function insert(node, n, depth) {
        node.mass += 1
        node.comx += n.x3
        node.comy += n.y3
        node.comz += n.z3
        if (!node.kids) {
          node.items.push(n)
          if (node.items.length > 6 && depth < 14) {
            const bucket = node.items
            node.items = []
            node.kids = new Array(8).fill(null)
            for (const m of bucket) {
              const { i, cell } = cellFor(node, m)
              if (!node.kids[i]) node.kids[i] = cell
              insert(node.kids[i], m, depth + 1)
            }
          }
          return
        }
        const { i, cell } = cellFor(node, n)
        if (!node.kids[i]) node.kids[i] = cell
        insert(node.kids[i], n, depth + 1)
      }

      for (const n of nodes) insert(root, n, 0)
      return root
    }

    const FORCE = {
      theta: 0.9,
      repulse: 6200,
      spring: 0.02,
      springRest: 90,
      crossClusterSpring: 0.15,
      clusterPull: 0.02,
      centerPull: 0.0002,
      maxStep: 16,
      damping: 0.86,
    }

    function forceStep(nodes, root) {
      const theta2 = FORCE.theta * FORCE.theta
      for (const n of nodes) {
        let fx = 0, fy = 0, fz = 0
        const stack = [root]
        while (stack.length) {
          const cell = stack.pop()
          if (!cell.mass) continue
          const dx = n.x3 - cell.comx / cell.mass
          const dy = n.y3 - cell.comy / cell.mass
          const dz = n.z3 - cell.comz / cell.mass
          const d2 = dx * dx + dy * dy + dz * dz + 1
          const far = (cell.half * cell.half) / d2 < theta2
          if (far) {
            const f = (FORCE.repulse * cell.mass) / d2
            const inv = 1 / Math.sqrt(d2)
            fx += dx * inv * f
            fy += dy * inv * f
            fz += dz * inv * f
          } else {
            for (const m of cell.items) {
              if (m === n) continue
              const ax = n.x3 - m.x3
              const ay = n.y3 - m.y3
              const az = n.z3 - m.z3
              const a2 = ax * ax + ay * ay + az * az + 1
              const f = FORCE.repulse / a2
              const inv = 1 / Math.sqrt(a2)
              fx += ax * inv * f
              fy += ay * inv * f
              fz += az * inv * f
            }
            if (cell.kids) for (const k of cell.kids) if (k) stack.push(k)
          }
        }
        n._fx = fx
        n._fy = fy
        n._fz = fz
      }

      const byId = state.byId
      for (const e of state.edges) {
        const a = byId.get(e.a)
        const b = byId.get(e.b)
        if (!a || !b) continue
        const dx = b.x3 - a.x3
        const dy = b.y3 - a.y3
        const dz = b.z3 - a.z3
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-3
        const rest = FORCE.springRest * (1.35 - 0.55 * (e.w || 0.4))
        let k = (FORCE.spring * (0.35 + (e.w || 0.4)) * (d - rest)) / d
        if (a.cluster !== b.cluster) k *= FORCE.crossClusterSpring
        if (Math.abs(k) > 9) k = (k > 0 ? 1 : -1) * 9
        const fx = dx * k
        const fy = dy * k
        const fz = dz * k
        a._fx += fx
        a._fy += fy
        a._fz += fz
        b._fx -= fx
        b._fy -= fy
        b._fz -= fz
      }

      const centers = new Map(state.clusters.map((c) => [c.id, c]))
      for (const n of nodes) {
        const c = centers.get(n.cluster)
        if (c) {
          n._fx += (c._cx - n.x3) * FORCE.clusterPull
          n._fy += (c._cy - n.y3) * FORCE.clusterPull
          n._fz += (c._cz - n.z3) * FORCE.clusterPull
        }
        n._fx -= n.x3 * FORCE.centerPull
        n._fy -= n.y3 * FORCE.centerPull
        n._fz -= n.z3 * FORCE.centerPull
      }
    }

    function forceApply(nodes, alpha) {
      for (const n of nodes) {
        let dx = n._fx * alpha
        let dy = n._fy * alpha
        let dz = n._fz * alpha
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (len > FORCE.maxStep) {
          const s = FORCE.maxStep / len
          dx *= s
          dy *= s
          dz *= s
        }
        n.vx = (n.vx || 0) * FORCE.damping + dx
        n.vy = (n.vy || 0) * FORCE.damping + dy
        n.vz = (n.vz || 0) * FORCE.damping + dz
        n.x3 += n.vx
        n.y3 += n.vy
        n.z3 += n.vz
        if (!isFinite(n.x3) || !isFinite(n.y3) || !isFinite(n.z3)) {
          n.x3 = n.vx = 0
          n.y3 = n.vy = 0
          n.z3 = n.vz = 0
        }
      }
    }

    function cacheKey() {
      const g = state.graph || {}
      return 'nb3d:' + LAYOUT_VERSION + ':' + (g.sig || '') + ':' + state.layout + ':' + state.nodes.length
    }

    function saveLayout(nodes) {
      try {
        const arr = nodes.map((n) => [Math.round(n.x3), Math.round(n.y3), Math.round(n.z3)])
        localStorage.setItem(cacheKey(), JSON.stringify(arr))
      } catch (_) {}
    }

    function loadLayout(nodes) {
      try {
        const raw = localStorage.getItem(cacheKey())
        if (!raw) return false
        const arr = JSON.parse(raw)
        if (!Array.isArray(arr) || arr.length !== nodes.length) return false
        nodes.forEach((n, i) => {
          n.x3 = arr[i][0]
          n.y3 = arr[i][1]
          n.z3 = arr[i][2]
          n.vx = n.vy = n.vz = 0
        })
        return true
      } catch (_) {
        return false
      }
    }

    // ---------- layout: spiral (time) ----------
    function layoutSpiral() {
      const now = Date.now()
      let maxAge = 1
      for (const n of state.nodes) {
        const t = Number(n.createdAt) || now
        n._age = Math.max(0, now - t)
        if (n._age > maxAge) maxAge = n._age
      }
      const Rmax = 1000
      const R0 = 110
      const arms = state.clusters.length || 1
      const baseAngle = new Map()
      state.clusters.forEach((c, i) => baseAngle.set(c.id, (i / arms) * TAU))

      for (const n of state.nodes) {
        const t = Math.pow(clamp(n._age / maxAge, 0, 1), 0.75)
        const r = R0 + t * Rmax
        const swirl = 1.55 * Math.PI * (r / Rmax)
        const arm = baseAngle.get(n.cluster) || 0
        const jitter = (hashString(n.id) - 0.5) * 0.34 * (0.4 + t)
        const ang = arm + swirl + jitter
        const rr = r * (1 + (hashString(n.id + 'r') - 0.5) * 0.05)
        const imp = clamp(n.importance || 1, 1, 4)
        const thick = 18 + 58 * (1 - (imp - 1) / 3)
        n.x3 = Math.cos(ang) * rr
        n.z3 = Math.sin(ang) * rr
        n.y3 = (hashString(n.id + 'y') - 0.5) * 2 * thick
        n.vx = n.vy = n.vz = 0
      }

      // 年龄环：跨度小的时候按小时给（这个库里的记忆只横跨两三天，
      // 只画「1 天前」会让整张盘看起来没有时间信息）
      const hour = 3600000
      const day = 86400000
      const STEPS = [1, 3, 6, 12, 24, 48, 72, 168, 336, 720, 2160, 8760]
      const rings = []
      for (const h of STEPS) {
        const age = h * hour
        if (age > maxAge * 1.06) continue
        const t = Math.pow(clamp(age / maxAge, 0, 1), 0.75)
        rings.push({
          age,
          r: R0 + t * Rmax,
          text: h < 24 ? h + T(' 小时前') : h < 48 ? T('1 天前') : Math.round(h / 24) + T(' 天前'),
        })
      }
      rings.sort((a, b) => a.r - b.r)
      state.spiral = {
        maxAge,
        rings: rings.slice(-5),
        arms: state.clusters.map((c) => ({
          id: c.id,
          label: c.title || c.label || c.id,
          angle: baseAngle.get(c.id) || 0,
          color: c.color,
        })),
      }
    }

    function prepareNodes() {
      for (const n of state.nodes) {
        const imp = clamp(n.importance || 1, 1, 4)
        n.heat = clamp(n.heat || 0.4, 0.1, 1.4)
        n.rgb = hexToRgb(n.color || LEVEL_COLOR[n.level] || '#9fb6cc')
        // 世界单位半径：重要度是主项（heat 先夹住，否则个别节点会变成巨球）
        n.rWorld = 13 + imp * 5 + n.heat * 7
      }
    }

    function layout() {
      prepareNodes()
      if (state.layout === 'spiral') {
        state.force.running = false
        layoutSpiral()
        return
      }
      seedClusterCenters()
      if (loadLayout(state.nodes)) {
        state.force.running = false
        return
      }
      seedClusterNodes()
      state.force.running = true
      state.force.alpha = 0.9
      state.force.iter = 0
      state.autoFit = true
    }

    // ---------- 投影：JS 侧镜像同一套矩阵（给标签和拾取用）----------
    const tmp = [0, 0, 0, 0]
    function project(x, y, z, out) {
      const cam = state.cam
      const v = state.view
      const p = state.proj
      // 视图变换
      const vx = v[0] * x + v[4] * y + v[8] * z + v[12]
      const vy = v[1] * x + v[5] * y + v[9] * z + v[13]
      const vz = v[2] * x + v[6] * y + v[10] * z + v[14]
      // 投影变换
      const cx = p[0] * vx + p[8] * vz
      const cy2 = p[5] * vy + p[9] * vz
      const cw = -vz
      const ndcX = cx / (cw || 1)
      const ndcY = cy2 / (cw || 1)
      const pan = panNdc()
      out[0] = (ndcX + pan[0] * 1) * 0.5 * state.size.w + state.size.w * 0.5
      out[1] = state.size.h * 0.5 - (ndcY + pan[1] * 1) * 0.5 * state.size.h
      out[2] = -vz
      out[3] = p[5] * state.size.h * 0.5
      return out
    }

    function panNdc() {
      const cam = state.cam
      return [(cam.panX / state.size.w) * 2, (-cam.panY / state.size.h) * 2]
    }

    function visible(n) {
      const f = state.filter
      if (n.hidden || !n.rgb) return false
      if (state.timeCut && (Number(n.createdAt) || 0) > state.timeCut) return false
      // 工作区筛选的键是 chip 上的 ws 名（带空格，如 'Liberty Of Code'），
      // 而 n.cluster 是压掉空格的 id（'LibertyOfCode'）。早先只比 cluster，
      // 于是「只留一个工作区」在 3D 里会把整张图筛空。两个都认。
      if (f.ws && !f.ws.has(n.ws) && !f.ws.has(n.cluster)) return false
      if (f.levels && !f.levels.has(n.level)) return false
      if (f.providers && !f.providers.has(n.provider || 'meow-memory')) return false
      if (f.minImp && (n.importance || 0) < f.minImp) return false
      return true
    }

    function visibleEdge(e) {
      const f = state.filter
      if (f.types && !f.types.has(e.t)) return false
      if (f.minW && (e.w || 0) < f.minW) return false
      const a = state.byId.get(e.a)
      const b = state.byId.get(e.b)
      if (!a || !b) return false
      return visible(a) && visible(b)
    }

    // ---------- draw ----------
    function updateMatrices() {
      const { w, h } = state.size
      perspective(state.proj, (52 * Math.PI) / 180, Math.max(0.2, w / h), 1, 12000)
      lookAtTarget(state.view, state.cam.yaw, state.cam.pitch, state.cam.dist, state.cam.tx, state.cam.ty, state.cam.tz)
    }

    const cornerQuad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])

    function drawScene() {
      updateMatrices()
      const hl = state.highlightSet
      const pan = panNdc()

      // 顶点数据只在「布局/筛选/高亮/脉冲」变化时重建；相机怎么转都不用重传，
      // 这是把 3D 从 35fps 拉到接近 60fps 的关键。
      let pulseAlive = 0
      for (const v of state.pulse.values()) if (v > 0.002) pulseAlive += 1
      if (!state.cache || state.cacheDirty || state.force.running || pulseAlive) {
        const wp = []
        const wc = []
        for (const e of state.edges) {
          if (!visibleEdge(e)) continue
          const a = state.byId.get(e.a)
          const b = state.byId.get(e.b)
          const dim = hl ? (hl.has(e.a) && hl.has(e.b) ? 1 : 0.55) : 1
          const base = TYPE_COLOR[e.t] || [0.6, 0.7, 0.9]
          // 螺旋盘里 3000 条线横穿盘面会把中心糊成一片，压暗一点
          // （0.42 时几乎看不见连线，只剩光点；0.58 能看清"谁连着谁"，又不糊）
          const spiralDim = state.layout === 'spiral' ? 0.58 : 1
          const onPath =
            state.pathEdges &&
            state.pathEdges.has(e.a < e.b ? e.a + '|' + e.b : e.b + '|' + e.a)
          const alpha = onPath
            ? 0.95
            : clamp((0.06 + 0.30 * (e.w || 0.3)) * dim * spiralDim, 0.02, 0.62)
          // 区块点亮：两端都亮到 85% 才让这条线出现，否则会先有线后有点
          const rMin = Math.min(a.reveal == null ? 1 : a.reveal, b.reveal == null ? 1 : b.reveal)
          if (rMin < 0.85) continue
          const ea = alpha * Math.min(1, (rMin - 0.85) / 0.15)
          wp.push(a.x3, a.y3, a.z3, b.x3, b.y3, b.z3)
          if (onPath) wc.push(1.0, 0.85, 0.55, ea, 1.0, 0.85, 0.55, ea)
          else wc.push(base[0], base[1], base[2], ea, base[0], base[1], base[2], ea)
        }
        const ccx = []
        const ccol = []
        const csz = []
        const cal = []
        const csh = []
        for (const n of state.nodes) {
          if (!visible(n)) continue
          // 区块点亮：还没亮起来的不画，正在亮的从小长到正常大小
          const rev = n.reveal == null ? 1 : n.reveal
          if (rev <= 0.02) continue
          const pulse = state.pulse.get(n.id)
          const boost = pulse && pulse > 0 ? 1 + 0.5 * pulse : 1
          const onPath = state.pathIds && state.pathIds.has(n.id)
          const dim = hl ? (hl.has(n.id) ? 1 : 0.72) : 1
          const focusBoost = hl && hl.has(n.id) ? 1.25 : 1
          ccx.push(n.x3, n.y3, n.z3)
          // 证据链上的节点染成暖金色，和 2D 的编号圈对应
          if (onPath) ccol.push(1.0, 0.85, 0.55)
          else ccol.push(n.rgb[0], n.rgb[1], n.rgb[2])
          csz.push(
            n.rWorld * boost * focusBoost * (n.level === 'source' ? 1.15 : 1) * (onPath ? 2.2 : 1) * (0.55 + 0.45 * rev),
          )
          cal.push((onPath ? 1 : dim) * rev)
          csh.push(n.level === 'source' ? 1 : 0)
        }
        state.cache = {
          wp,
          wc,
          ccx,
          ccol,
          csz,
          cal,
          csh,
          ballCount: ccx.length / 3,
        }
        state.cacheDirty = false
      }
      const { wp, wc, ccx, ccol, csz, cal, csh, ballCount } = state.cache

      gl.useProgram(wireProg)
      gl.bindBuffer(gl.ARRAY_BUFFER, wireBuf.pos)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(wp), gl.DYNAMIC_DRAW)
      gl.enableVertexAttribArray(wLoc.pos)
      gl.vertexAttribPointer(wLoc.pos, 3, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, wireBuf.color)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(wc), gl.DYNAMIC_DRAW)
      gl.enableVertexAttribArray(wLoc.color)
      gl.vertexAttribPointer(wLoc.color, 4, gl.FLOAT, false, 0, 0)
      gl.uniformMatrix4fv(wLoc.proj, false, state.proj)
      gl.uniformMatrix4fv(wLoc.view, false, state.view)
      gl.uniform2f(wLoc.pan, pan[0], pan[1])
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
      gl.depthMask(false)
      gl.drawArrays(gl.LINES, 0, wp.length / 3)
      gl.depthMask(true)

      // 光点
      gl.useProgram(ballProg)
      gl.bindBuffer(gl.ARRAY_BUFFER, ballBuf.center)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ccx), gl.DYNAMIC_DRAW)
      gl.enableVertexAttribArray(bLoc.center)
      gl.vertexAttribPointer(bLoc.center, 3, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, ballBuf.color)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ccol), gl.DYNAMIC_DRAW)
      gl.enableVertexAttribArray(bLoc.color)
      gl.vertexAttribPointer(bLoc.color, 3, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, ballBuf.size)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(csz), gl.DYNAMIC_DRAW)
      gl.enableVertexAttribArray(bLoc.size)
      gl.vertexAttribPointer(bLoc.size, 1, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, ballBuf.alpha)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cal), gl.DYNAMIC_DRAW)
      gl.enableVertexAttribArray(bLoc.alpha)
      gl.vertexAttribPointer(bLoc.alpha, 1, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, ballBuf.shape)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(csh), gl.DYNAMIC_DRAW)
      gl.enableVertexAttribArray(bLoc.shape)
      gl.vertexAttribPointer(bLoc.shape, 1, gl.FLOAT, false, 0, 0)
      gl.uniformMatrix4fv(bLoc.proj, false, state.proj)
      gl.uniformMatrix4fv(bLoc.view, false, state.view)
      gl.uniform2f(bLoc.pan, pan[0], pan[1])
      gl.uniform1f(bLoc.pxScale, state.proj[5] * state.size.h * 0.5)
      // 光点用普通混合（不是加色）：加色在密集区会把所有颜色叠成一片白，
      // 层级色就白给了。普通混合下核心仍是亮的，边缘保留色相，区块看得出是「哪一层」。
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      gl.depthMask(false)
      gl.drawArrays(gl.POINTS, 0, ballCount)
      state.lastDraw = {
        balls: ballCount,
        verts: ccx.length / 3,
        err: gl.getError(),
        sample: ccx.length ? [ccx[0], ccx[1], ccx[2], csz[0]] : null,
      }
      state.drawCount = (state.drawCount || 0) + 1

      gl.disableVertexAttribArray(bLoc.size)
      gl.disableVertexAttribArray(bLoc.alpha)
      gl.disableVertexAttribArray(bLoc.shape)
    }

    function draw() {
      const cw = canvas.width
      const ch = canvas.height
      if (!cw || !ch) return
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, cw, ch)
      gl.clearColor(0, 0, 0, 0)
      gl.clearDepth(1)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      if (/(\?|&)flat=1/.test(location.search)) gl.disable(gl.DEPTH_TEST)
      else gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(gl.LEQUAL)
      drawScene()
      gl.disable(gl.BLEND)
      drawLabels()
    }

    // ---------- labels ----------
    function roundRect(c, x, y, w, h, r) {
      c.beginPath()
      c.moveTo(x + r, y)
      c.arcTo(x + w, y, x + w, y + h, r)
      c.arcTo(x + w, y + h, x, y + h, r)
      c.arcTo(x, y + h, x, y, r)
      c.arcTo(x, y, x + w, y, r)
      c.closePath()
    }

    function drawLabels() {
      if (!lctx) return
      const { w, h, dpr } = state.size
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      lctx.clearRect(0, 0, w, h)
      if (state.layout === 'spiral') drawSpiralLabels()
      else drawClusterLabels()
      drawFocusLabel()
    }

    function drawClusterLabels() {
      const { w, h } = state.size
      lctx.textAlign = 'center'
      lctx.font = '500 11px Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
      const box = new Map()
      for (const n of state.nodes) {
        // 走 visible()，不要只看 n.hidden——3D 的筛选状态在 state.filter 里，
        // 全筛掉时还画簇名，画面就会「没有记忆」却挂着一圈名字。
        if (!visible(n)) continue
        project(n.x3, n.y3, n.z3, tmp)
        if (tmp[2] <= 1) continue
        const b = box.get(n.cluster) || { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, n: 0 }
        b.minX = Math.min(b.minX, tmp[0])
        b.maxX = Math.max(b.maxX, tmp[0])
        b.minY = Math.min(b.minY, tmp[1])
        b.maxY = Math.max(b.maxY, tmp[1])
        b.n += 1
        box.set(n.cluster, b)
      }
      const taken = []
      const cx0 = w / 2
      const cy0 = h / 2
      const R = Math.min(w, h) * 0.42
      const items = []
      for (const c of state.clusters) {
        const b = box.get(c.id)
        if (!b || b.n < 3) continue
        items.push({
          c,
          mx: (b.minX + b.maxX) / 2,
          my: (b.minY + b.maxY) / 2,
          text: String(c.title || c.label || c.id).toUpperCase(),
        })
      }
      // 标签不压在星团里：从画面中心朝星团方向推到外圈，再用一条细引导线连回去
      for (const it of items) {
        const tw = lctx.measureText(it.text).width
        let dx = it.mx - cx0
        let dy = it.my - cy0
        const len = Math.hypot(dx, dy) || 1
        dx /= len
        dy /= len
        let lx = cx0 + dx * R
        let ly = cy0 + dy * R
        lx = clamp(lx, tw / 2 + 18, w - tw / 2 - 18)
        ly = clamp(ly, 74, h - 34)
        let guard = 0
        while (taken.some((t) => Math.abs(t.x - lx) < (t.w + tw) / 2 + 10 && Math.abs(t.y - ly) < 22) && guard < 14) {
          ly += 24
          if (ly > h - 34) ly = 74
          guard += 1
        }
        taken.push({ x: lx, y: ly, w: tw })

        lctx.strokeStyle = 'rgba(140,170,215,0.16)'
        lctx.lineWidth = 1
        lctx.beginPath()
        lctx.moveTo(it.mx, it.my)
        lctx.lineTo(lx, ly)
        lctx.stroke()

        lctx.fillStyle = 'rgba(4,6,12,0.6)'
        roundRect(lctx, lx - tw / 2 - 8, ly - 13, tw + 16, 19, 9)
        lctx.fill()
        lctx.fillStyle = it.c.color || '#6cc8ff'
        lctx.globalAlpha = 0.92
        lctx.fillText(it.text, lx, ly)
        lctx.globalAlpha = 1
      }
    }

    function drawSpiralLabels() {
      const { w, h } = state.size
      const sp = state.spiral
      if (!sp) return
      lctx.font = '500 10.5px Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
      const labelAngle = 2.35
      let ringIdx = 0
      for (const ring of sp.rings || []) {
        const steps = 120
        lctx.beginPath()
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * TAU
          project(Math.cos(a) * ring.r, 0, Math.sin(a) * ring.r, tmp)
          if (i === 0) lctx.moveTo(tmp[0], tmp[1])
          else lctx.lineTo(tmp[0], tmp[1])
        }
        lctx.strokeStyle = 'rgba(120,160,210,0.16)'
        lctx.lineWidth = 1
        lctx.stroke()

        // 标签错开摆，别全挤在同一条半径上被星盘盖住
        const ang = labelAngle + (ringIdx % 3) * 2.1
        project(Math.cos(ang) * ring.r, 0, Math.sin(ang) * ring.r, tmp)
        ringIdx += 1
        const label = ring.text || ring.d + T(' 天前')
        lctx.textAlign = 'left'
        const tw = lctx.measureText(label).width
        // 标签不丢：贴边就夹回视口，别因为投影出界整条都不画
        const lx = clamp(tmp[0], 24, w - tw - 20)
        const ly = clamp(tmp[1], 56, h - 24)
        lctx.fillStyle = 'rgba(4,6,12,0.62)'
        roundRect(lctx, lx - 5, ly - 12, tw + 10, 16, 7)
        lctx.fill()
        lctx.fillStyle = 'rgba(178,206,236,0.9)'
        lctx.fillText(label, lx, ly)
      }

      project(0, 0, 0, tmp)
      lctx.textAlign = 'center'
      lctx.fillStyle = 'rgba(255,236,190,0.9)'
      lctx.fillText(T('最近'), tmp[0], tmp[1] + 4)

      lctx.textAlign = 'center'
      const taken = []
      const swirl = 1.4 * Math.PI
      for (const arm of sp.arms || []) {
        const r = 1085
        const a = arm.angle + swirl
        project(Math.cos(a) * r, 0, Math.sin(a) * r, tmp)
        const text = String(arm.label || '').toUpperCase()
        if (!text) continue
        const tw = lctx.measureText(text).width
        const x = clamp(tmp[0], tw / 2 + 16, w - tw / 2 - 16)
        const y = clamp(tmp[1], 62, h - 30)
        if (taken.some((t) => Math.abs(t.x - x) < (t.w + tw) / 2 + 10 && Math.abs(t.y - y) < 22)) continue
        taken.push({ x, y, w: tw })
        lctx.fillStyle = 'rgba(4,6,12,0.55)'
        roundRect(lctx, x - tw / 2 - 7, y - 12, tw + 14, 17, 8)
        lctx.fill()
        lctx.fillStyle = arm.color || '#6cc8ff'
        lctx.globalAlpha = 0.9
        lctx.fillText(text, x, y)
        lctx.globalAlpha = 1
      }
    }

    function drawFocusLabel() {
      const { w, h } = state.size
      for (const [id, strong] of [
        [state.selected, true],
        [state.hover, false],
      ]) {
        if (!id) continue
        const n = state.byId.get(id)
        if (!n || n.hidden) continue
        project(n.x3, n.y3, n.z3, tmp)
        if (tmp[2] <= 1) continue
        const rad = clamp((n.rWorld * tmp[3]) / tmp[2], 6, 30)
        lctx.beginPath()
        lctx.arc(tmp[0], tmp[1], rad + 5, 0, TAU)
        lctx.strokeStyle = strong ? 'rgba(255,224,150,0.95)' : 'rgba(220,235,255,0.55)'
        lctx.lineWidth = strong ? 1.6 : 1
        lctx.stroke()

        const text = String(n.title || n.label || n.id).slice(0, 40)
        lctx.font = '500 11.5px Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
        const tw = lctx.measureText(text).width
        const x = clamp(tmp[0], tw / 2 + 16, w - tw / 2 - 16)
        const y = clamp(tmp[1] - rad - 12, 60, h - 24)
        lctx.fillStyle = 'rgba(4,6,12,0.72)'
        roundRect(lctx, x - tw / 2 - 8, y - 13, tw + 16, 19, 9)
        lctx.fill()
        lctx.fillStyle = strong ? '#ffe6a8' : '#dfeaff'
        lctx.textAlign = 'center'
        lctx.fillText(text, x, y)
      }
    }

    // ---------- loop ----------
    let raf = 0
    // ---------- 区块点亮（3D 版） ----------
    // 2D 是「按空间网格逐格亮」，3D 没有网格可切，改成按簇分波：
    // 大簇先亮、簇内重要的先亮，后面的簇错开 110ms，整体 1.6 秒长出来。
    function startReveal() {
      const order = state.clusters
        .slice()
        .sort((a, b) => (b.size || 0) - (a.size || 0))
        .map((c) => c.id)
      const idxOf = new Map(order.map((id, i) => [id, i]))
      const delay = new Map()
      for (const n of state.nodes) {
        const ci = idxOf.has(n.cluster) ? idxOf.get(n.cluster) : order.length
        n.reveal = 0
        delay.set(n.id, ci * 110 + Math.min(220, (4 - Math.min(4, n.importance || 1)) * 40))
      }
      state.reveal = { t0: performance.now(), delay, duration: 240, done: false }
      state.cacheDirty = true
      state.needDraw = true
      return true
    }

    function pumpReveal(now) {
      const rv = state.reveal
      if (!rv || rv.done) return
      let shown = 0
      let total = 0
      const t = now - rv.t0
      for (const n of state.nodes) {
        if (!visible(n)) continue
        total += 1
        const d = rv.delay.get(n.id) || 0
        const v = Math.max(0, Math.min(1, (t - d) / rv.duration))
        if (v !== n.reveal) {
          n.reveal = v
          state.cacheDirty = true
        }
        if (v >= 0.98) shown += 1
      }
      state.needDraw = true
      if (total && shown >= total) rv.done = true
      state.growth = { done: rv.done, shown, total }
    }

    function tick() {
      raf = requestAnimationFrame(tick)
      if (!state.active) return
      const now = performance.now()
      pumpReveal(now)
      const cam = state.cam
      if (state.target) {
        cam.yaw += (state.target.yaw - cam.yaw) * 0.14
        cam.pitch += (state.target.pitch - cam.pitch) * 0.14
        cam.dist += (state.target.dist - cam.dist) * 0.14
        cam.tx += (state.target.tx - cam.tx) * 0.14
        cam.ty += (state.target.ty - cam.ty) * 0.14
        cam.tz += (state.target.tz - cam.tz) * 0.14
        if (Math.abs(state.target.dist - cam.dist) < 0.5) state.target = null
      } else if (state.drag ? false : state.inertia && (state.inertia.yaw || state.inertia.pitch)) {
        // 松手后的惯性：拖一下会顺着刚才的方向再滑一小段
        cam.yaw += state.inertia.yaw
        cam.pitch = clamp(cam.pitch + state.inertia.pitch, -1.35, 1.35)
        state.inertia.yaw *= 0.92
        state.inertia.pitch *= 0.92
        if (Math.abs(state.inertia.yaw) < 0.0004 && Math.abs(state.inertia.pitch) < 0.0004) {
          state.inertia.yaw = 0
          state.inertia.pitch = 0
        }
      } else if (state.spin && !state.drag) {
        cam.yaw += 0.0004
      }

      if (state.force.running) {
        const f = state.force
        const root = buildOctree(state.nodes)
        for (let i = 0; i < 6 && f.iter < f.maxIter; i++) {
          forceStep(state.nodes, root)
          forceApply(state.nodes, f.alpha)
          f.alpha *= 0.986
          f.iter += 1
        }
        if (f.iter >= f.maxIter || f.alpha < 0.02) {
          state.force.running = false
          saveLayout(state.nodes)
          if (state.autoFit) {
            state.autoFit = false
            api.fit()
          }
        }
      }

      for (const [id, v] of state.pulse) {
        const nv = v - 0.035
        if (nv <= 0) state.pulse.delete(id)
        else state.pulse.set(id, nv)
      }

      // 只在「真的会变」的时候重画：静止时不再 60fps 空转（省电、也让风扇安静）
      const inertiaOn = !state.drag && state.inertia && (state.inertia.yaw || state.inertia.pitch)
      const moving =
        !!state.target || !!inertiaOn || (state.spin && !state.drag) || state.force.running || !!state.drag || state.pulse.size > 0
      if (moving || state.cacheDirty || state.needDraw) {
        state.needDraw = false
        draw()
      }
    }

    function start() {
      if (!raf) raf = requestAnimationFrame(tick)
    }

    function resize() {
      const rect = canvas.getBoundingClientRect()
      // 和 2D 一样：隐藏时 rect 是 0，别把 WebGL 画布写成 0×0（激活时会再量一次）
      if (rect.width < 2 || rect.height < 2) return false
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      state.size = { w: rect.width, h: rect.height, dpr }
      canvas.width = Math.round(state.size.w * dpr)
      canvas.height = Math.round(state.size.h * dpr)
      if (labelCanvas) {
        labelCanvas.width = canvas.width
        labelCanvas.height = canvas.height
      }
      state.needDraw = true
    }

    // ---------- picking & pointer ----------
    function pick(sx, sy) {
      let best = null
      let bestScore = Infinity
      for (const n of state.nodes) {
        if (!visible(n)) continue
        project(n.x3, n.y3, n.z3, tmp)
        if (tmp[2] <= 1) continue
        const d = Math.hypot(tmp[0] - sx, tmp[1] - sy)
        const rpx = (n.rWorld * tmp[3]) / tmp[2]
        const tol = clamp(rpx + 7, 8, 26)
        if (d > tol) continue
        const score = d + tmp[2] * 0.02
        if (score < bestScore) {
          bestScore = score
          best = n
        }
      }
      return best
    }

    function pos(ev) {
      const rect = canvas.getBoundingClientRect()
      return [ev.clientX - rect.left, ev.clientY - rect.top]
    }

    canvas.addEventListener('pointerdown', (ev) => {
      const [sx, sy] = pos(ev)
      const panOnly = ev.button !== 0
      if (panOnly) ev.preventDefault()
      try {
        canvas.setPointerCapture(ev.pointerId)
      } catch (_) {}
      const n = panOnly ? null : pick(sx, sy)
      state.drag = {
        type: n ? 'node' : panOnly ? 'pan' : 'orbit',
        sx,
        sy,
        button: ev.button,
        moved: false,
        yaw: state.cam.yaw,
        pitch: state.cam.pitch,
        panX: state.cam.panX,
        panY: state.cam.panY,
      }
      canvas.style.cursor = 'grabbing'
    })

    // 中键的默认动作是「自动滚动」，不挡住的话画面会跟着方向键图标乱跑
    canvas.addEventListener(
      'mousedown',
      (ev) => {
        if (ev.button === 1 || ev.button === 2) ev.preventDefault()
      },
      { passive: false }
    )
    canvas.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) ev.preventDefault()
    })
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault())

    canvas.addEventListener('pointermove', (ev) => {
      const [sx, sy] = pos(ev)
      const drag = state.drag
      if (drag) {
        const dx = sx - drag.sx
        const dy = sy - drag.sy
        if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true
        state.target = null
        if (drag.type === 'pan') {
          // 平移用「上一帧位置」算增量：拿按下点到当前的累计位移去 += 会指数放大，
          // 手一抖画面就飞出去了（之前就是这个问题）。
          const px = sx - (drag.lx === undefined ? drag.sx : drag.lx)
          const py = sy - (drag.ly === undefined ? drag.sy : drag.ly)
          drag.lx = sx
          drag.ly = sy
          const cam = state.cam
          const cy = Math.cos(cam.yaw)
          const sy2 = Math.sin(cam.yaw)
          const cp = Math.cos(cam.pitch)
          const sp = Math.sin(cam.pitch)
          const right = [cy, 0, -sy2]
          const up = [-sp * sy2, cp, -sp * cy]
          const s = (2 * cam.dist * Math.tan((26 * Math.PI) / 180)) / Math.max(1, state.size.h)
          cam.tx += (-px * right[0] + py * up[0]) * s
          cam.ty += (-px * right[1] + py * up[1]) * s
          cam.tz += (-px * right[2] + py * up[2]) * s
        } else {
          const ny = drag.yaw - dx * 0.0055
          const np = clamp(drag.pitch + dy * 0.0045, -1.35, 1.35)
          // 记录这一帧转了多少，松手后当惯性用（阻尼在 tick 里衰减）
          state.inertia.yaw = ny - state.cam.yaw
          state.inertia.pitch = np - state.cam.pitch
          state.cam.yaw = ny
          state.cam.pitch = np
        }
        return
      }
      const n = pick(sx, sy)
      canvas.style.cursor = n ? 'pointer' : 'grab'
      const id = n ? n.id : null
      if (id !== state.hover) {
        state.hover = id
        // 悬停即预览这条记忆的邻居：边提亮、无关的压暗（和 2D 一致）
        if (!state.pinnedHighlight) api.highlight(id)
        emit('hover', n ? { id, x: sx, y: sy } : null)
      }
    })

    canvas.addEventListener('pointerup', (ev) => {
      const drag = state.drag
      const [sx, sy] = pos(ev)
      const moved = drag && (drag.moved || Math.hypot(sx - drag.sx, sy - drag.sy) > 4)
      const button = drag ? drag.button : ev.button
      state.drag = null
      canvas.style.cursor = 'grab'
      if (!drag || button !== 0 || moved) return
      const n = pick(sx, sy)
      if (n && ev.shiftKey && state.selected && state.selected !== n.id) {
        emit('path', { from: state.selected, to: n.id })
        return
      }
      api.select(n ? n.id : null)
      emit('select', n ? n.id : null)
    })

    canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault()
        state.cam.dist = clamp(state.cam.dist * Math.exp(ev.deltaY * 0.0012), 180, 9000)
      },
      { passive: false }
    )

    canvas.addEventListener('dblclick', () => api.fit())

    // ---------- API ----------
    const api = {
      load(graph, keepView) {
        state.graph = graph
        state.clusters = (graph.clusters || []).map((c) => ({ ...c }))
        state.nodes = (graph.nodes || []).map((n) => ({ ...n }))
        state.edges = graph.edges || []
        state.byId = new Map(state.nodes.map((n) => [n.id, n]))
        state.highlightSet = null
        state.cacheDirty = true
        layout()
        startReveal()
        if (!keepView) api.fit()
        return api
      },

      setLayout(mode) {
        const next = mode === 'spiral' ? 'spiral' : 'cluster'
        if (next === state.layout && state.nodes.length) return api
        state.layout = next
        state.cacheDirty = true
        layout()
        api.fit()
        return api
      },

      setFilter(f) {
        const next = { ws: null, levels: null, types: null, providers: null, minW: 0, minImp: 0 }
        if (f && f.ws && f.ws.size) next.ws = f.ws
        if (f && f.levels && f.levels.size) next.levels = f.levels
        if (f && f.types && f.types.size) next.types = f.types
        if (f && f.providers && f.providers.size) next.providers = f.providers
        next.minW = (f && f.minW) || 0
        next.minImp = (f && f.minImp) || 0
        state.filter = next
        state.cacheDirty = true
        return api
      },

      /**
       * 立刻画一帧。导出 PNG 用：WebGL 的绘制缓冲默认不保留，
       * 等 rAF 之后再去 drawImage 只会拿到一张空画布——必须在同一个同步任务里画完就取。
       */
      paintNow() {
        draw()
        return api
      },

      /** 和 2D 同名：筛完还剩多少条。左栏那句「隐藏 N 条」在 3D 里也要说真话。 */
      visibleNodes() {
        return state.nodes.filter(visible)
      },

      visibleEdges() {
        return state.edges.filter(visibleEdge)
      },

      /** 时间回放：传 0 或 null 表示解除时间闸门。 */
      setTimeCut(ms) {
        const v = Number(ms) || 0
        if (state.timeCut === v) return api
        state.timeCut = v
        state.cacheDirty = true
        state.needDraw = true
        return api
      },

      /** pinned=true 表示这次高亮来自搜索/选中，鼠标移开也不该被清掉 */
      highlight(id, pinned) {
        state.pinnedHighlight = !!pinned
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
        state.cacheDirty = true
        return api
      },

      /** 高亮一条证据链；传 null 清掉。与 2D 的 setPath 同构。 */
      setPath(ids) {
        if (!ids || ids.length < 2) {
          state.pathIds = null
          state.pathEdges = null
        } else {
          state.pathIds = new Set(ids)
          const edges = new Set()
          for (let i = 0; i + 1 < ids.length; i += 1) {
            const a = ids[i]
            const b = ids[i + 1]
            edges.add(a < b ? a + '|' + b : b + '|' + a)
          }
          state.pathEdges = edges
        }
        state.cacheDirty = true
        return api
      },

      select(id) {
        state.selected = id
        state.needDraw = true
        return api
      },

      open(id) {
        api.select(id)
        emit('select', id)
        return api
      },

      focusNode(id, zoom) {
        const n = state.byId.get(id)
        if (!n) return api
        state.target = {
          yaw: state.cam.yaw,
          pitch: state.cam.pitch,
          dist: zoom ? Math.max(420, 2200 / zoom) : 1400,
          tx: n.x3,
          ty: n.y3,
          tz: n.z3,
        }
        return api
      },

      /** 键盘行走用：把镜头平移到这颗星，距离（缩放）不动。 */
      centerOn(id) {
        const n = state.byId.get(id)
        if (!n) return api
        state.target = {
          yaw: state.cam.yaw,
          pitch: state.cam.pitch,
          dist: state.cam.dist,
          tx: n.x3,
          ty: n.y3,
          tz: n.z3,
        }
        return api
      },

      /**
       * 键盘加号/减号用：推近/拉远一档。
       * 限位跟滚轮同一套（180–9000），并且要清掉补间目标，否则下一帧会被拉回去。
       */
      zoomBy(factor) {
        const f = Number(factor)
        if (!f || !isFinite(f) || f <= 0) return api
        const next = clamp(state.cam.dist / f, 180, 9000)
        if (next === state.cam.dist) return api
        state.target = null
        state.cam.dist = next
        state.needDraw = true
        return api
      },

      fit() {
        state.target = null
        let maxR = 0
        for (const n of state.nodes) {
          if (n.hidden) continue
          const d = Math.sqrt(n.x3 * n.x3 + n.y3 * n.y3 + n.z3 * n.z3) + (n.rWorld || 4) * 2
          if (d > maxR) maxR = d
        }
        const pad = state.pad || {}
        const usableH = Math.max(200, state.size.h - (pad.top || 0) - (pad.bottom || 0))
        const usableW = Math.max(240, state.size.w - (pad.left || 0) - (pad.right || 0))
        const fovy = (52 * Math.PI) / 180
        const halfH = Math.tan(fovy / 2)
        const needH = maxR / (halfH * 0.86)
        const needW = maxR / (halfH * (usableW / usableH) * 0.86)
        const need = Math.max(needH, needW, 600)
        state.cam.tx = 0
        state.cam.ty = 0
        state.cam.tz = 0
        state.cam.panX = 0
        state.cam.panY = 0
        state.cam.dist = clamp(need, 600, 9000)
        state.cam.yaw = state.layout === 'spiral' ? 0.9 : 0.62
        state.cam.pitch = state.layout === 'spiral' ? 0.56 : 0.28
        state.needDraw = true
        return api
      },

      pulseFrom(ids, spread) {
        const list = Array.isArray(ids) ? ids : [ids]
        for (const id of list.slice(0, 24)) state.pulse.set(id, spread ? 0.9 : 1.2)
        return api
      },

      setPadding(p) {
        state.pad = Object.assign({ left: 16, right: 16, top: 76, bottom: 48 }, p || {})
        state.needDraw = true
        return api
      },

      setSpin(flag) {
        state.spin = !!flag
        return api
      },

      setActive(flag) {
        state.active = !!flag
        if (flag) {
          resize()
          start()
        }
        return api
      },

      resize,

      on(evt, fn) {
        ;(listeners[evt] || (listeners[evt] = [])).push(fn)
        return api
      },

      get mode() {
        return 'space'
      },

      screenOf(id) {
        const n = state.byId.get(id)
        if (!n || !visible(n)) return null
        project(n.x3, n.y3, n.z3, tmp)
        return { x: tmp[0], y: tmp[1], r: (n.rWorld * tmp[3]) / tmp[2] }
      },

      /** 与 2D 同名的进度口：顶部「正在生长…」进度条在 3D 里也走它 */
      progress() {
        return state.growth || { done: true, shown: 0, total: 0 }
      },

      debug() {
        let sampleId = null
        for (const n of state.nodes) {
          if (!visible(n)) continue
          const p = api.screenOf(n.id)
          if (!p) continue
          if (p.x > 380 && p.x < state.size.w - 120 && p.y > 120 && p.y < state.size.h - 90) {
            sampleId = n.id
            break
          }
        }
        const rs = []
        for (const n of state.nodes) {
          if (!visible(n)) continue
          project(n.x3, n.y3, n.z3, tmp)
          if (tmp[2] <= 1) continue
          rs.push((n.rWorld * tmp[3]) / tmp[2])
        }
        rs.sort((a, b) => a - b)
        return {
          mode: 'space',
          layout: state.layout,
          nodes: state.nodes.length,
          edges: state.edges.length,
          cam: { ...state.cam },
          size: { ...state.size },
          selected: state.selected,
          sampleId,
          rpx: rs.length ? { min: +rs[0].toFixed(2), med: +rs[Math.floor(rs.length / 2)].toFixed(2), max: +rs[rs.length - 1].toFixed(2) } : null,
          lastDraw: state.lastDraw || null,
          drawCount: state.drawCount || 0,
          force: { running: state.force.running, iter: state.force.iter, alpha: +state.force.alpha.toFixed(3) },
          spin: !!state.spin,
          // 诊断用：当前真正「可见」的点/线数——时间回放、筛选、隐藏都只改这一层，
          // 探针量这里就能确认闸门有没有生效，不必去数像素。
          visible: (() => {
            let vn = 0
            for (const n of state.nodes) if (visible(n)) vn++
            let ve = 0
            for (const e of state.edges) if (visibleEdge(e)) ve++
            return { nodes: vn, edges: ve }
          })(),
          spiral:
            state.layout === 'spiral'
              ? { maxAgeDays: Math.round(state.spiral.maxAge / 86400000), rings: state.spiral.rings.length, arms: state.spiral.arms.length }
              : null,
        }
      },
    }

    window.addEventListener('resize', () => {
      if (state.active) resize()
    })

    window.__nebula3d = api
    return api
  }

  window.NebulaSpace = { create, LEVEL_COLOR, TYPE_COLOR }
})()
