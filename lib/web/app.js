/* 记忆星图 —— 界面逻辑
   数据：/api/memory-nebula/*（同源）。渲染交给 render.js。 */
;(function () {
  const APP_VERSION = '1.4.1'  // 和 package.json 同步（release-check 会核对）
  'use strict'
  /** 中文即源文：英文模式查 i18n.js 的表，查不到就原样返回中文。 */
  const T = (zh, vars) => (window.NebulaI18n ? window.NebulaI18n.t(zh, vars) : zh)
  /** 服务端生成的解释句是中文：在英文模式里做一层有限翻译，翻不了就保留原文。 */
  function localizeWhy(s) {
    if (Array.isArray(s)) return s.map(localizeWhy).join(' · ')
    if (!s || typeof s !== 'string' || !window.NebulaI18n || window.NebulaI18n.lang !== 'en') return s
    const exact = {
      '直接命中查询词': 'Direct query hit',
      '直接命中查询词（跨工作区）': 'Direct query hit (cross-workspace)',
    }
    if (exact[s]) return exact[s]
    let m = s.match(/^被读过 (\d+) 次$/)
    if (m) return 'read ' + m[1] + (m[1] === '1' ? ' time' : ' times')
    m = s.match(/^经由「(.*)」的(.+?)关联(跨工作区)?扩散而来$/)
    if (m) return 'via “' + m[1] + '” · ' + m[2] + ' link' + (m[3] ? ' · cross-workspace' : '')
    return s
  }

  const API = window.NebulaAPI
  const LEVEL_COLOR = window.Nebula.LEVEL_COLOR
  const TYPE_COLOR = window.Nebula.TYPE_COLOR
  const LEVEL_LABEL = {
    soul: T('灵魂'),
    user: T('主人'),
    project: T('项目'),
    lesson: T('教训'),
    topic: T('话题'),
    fact: T('事实'),
    rules: T('准则'),
    source: T('来源'),
  }
  /** 记忆来源（provider）的显示名与配色：meow 是主来源，其他插件各给一个色。 */
  const PROVIDER_LABEL = {
    'meow-memory': 'meow-memory',
    inventory: T('环境 · 插件/技能/MCP'),
  }
  const PROVIDER_COLOR = {
    'meow-memory': '#6ce0ff',
    inventory: '#8b93b8',
  }
  function providerColor(p) {
    if (PROVIDER_COLOR[p]) return PROVIDER_COLOR[p]
    let h = 0
    for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) % 360
    return 'hsl(' + h + ' 72% 62%)'
  }
  function providerLabel(p) {
    return PROVIDER_LABEL[p] || p
  }

  const TYPE_LABEL = {
    explicit: T('手工'),
    project: T('同项目'),
    entity: T('同一实体'),
    keyword: T('同关键词'),
    semantic: T('语义相似'),
    hebbian: T('共激活'),
    mentions: T('提到来源'),
  }

  const $ = (s) => document.querySelector(s)
  const el = (tag, cls, text) => {
    const d = document.createElement(tag)
    if (cls) d.className = cls
    if (text !== undefined) d.textContent = text
    return d
  }
  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  const state = {
    graph: null,
    stage: null,
    filter: { ws: null, levels: null, types: null, providers: null, minW: 0, minImp: 0 },
    selected: null,
    detail: null,
    query: '',
    hits: [],
    timer: 0,
    lastError: '',
  }

  let toastTimer = 0
  let toastPinned = false
  // 提示条可以带一个动作（「撤销」）。屏蔽关联 / 断开连边都是即时生效、没有确认框的，
  // 所以误点之后必须留一条退路——退路就挂在提示条上，不另开弹窗。
  let toastSeq = 0
  function toast(msg, action) {
    const t = $('#toast')
    const hasAct = !!(action && action.label && typeof action.run === 'function')
    // 带动作的提示条是「还没做完的一件事」，不能被轮询那种背景提示顶掉——
    // 否则 12 秒一次的「星云已更新」会把「撤销」按钮冲走，人就再也点不到了。
    if (toastPinned && !hasAct) return
    const mySeq = ++toastSeq
    t.innerHTML = ''
    t.appendChild(el('span', 't-msg', msg))
    if (hasAct) {
      const btn = el('button', 't-act', action.label)
      btn.onclick = async () => {
        btn.disabled = true
        const msgEl = t.querySelector('.t-msg')
        if (msgEl) msgEl.textContent = T('正在处理…')
        toastPinned = false
        try {
          await action.run()
        } catch (e) {
          toast(T('撤销失败：') + (e && e.message ? e.message : e))
        }
        // 动作里往往自己又 toast 了一句「已撤销」：那是新的一条，别在这里把它关掉。
        if (toastSeq !== mySeq) return
        toastPinned = false
        clearTimeout(toastTimer)
        t.classList.remove('show')
        t.classList.remove('act')
      }
      t.appendChild(btn)
    }
    toastPinned = hasAct
    t.classList.toggle('act', hasAct)
    t.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      if (toastSeq !== mySeq) return
      toastPinned = false
      t.classList.remove('show')
      t.classList.remove('act')
    }, hasAct ? 8000 : 2600)
  }

  // ---------------- 顶栏统计 ----------------
  function renderStats(graph) {
    const box = $('#stats')
    box.innerHTML = ''
    const stats = graph.stats || {}
    const items = [
      [T('记忆'), stats.nodes ?? 0],
      [T('连接'), stats.edges ?? 0],
      [T('工作区'), stats.workspaces ?? 0],
      [T('会话'), stats.sessions ?? 0],
      [T('平均连接'), (stats.avgDegree ?? 0).toFixed(1)],
    ]
    const tips = {
      记忆: T('跨工作区收集到的记忆条目总数'),
      连接: T('图里画出来的边：同一实体 / 同关键词 / 语义近邻 / 人工连的'),
      工作区: T('这些记忆来自几个工作区'),
      会话: T('写这些记忆时所在的会话数'),
      平均连接: T('平均每条记忆连了几条边'),
    }
    for (const [label, value] of items) {
      const s = el('div', 'stat')
      s.title = tips[label] || label
      s.appendChild(el('b', null, String(value)))
      s.appendChild(el('span', null, label))
      box.appendChild(s)
    }
  }

  // ---------------- 筛选面板 ----------------
  /* 左栏折叠：记住上次收起的分组（小屏上把「连接类型」收起来就能看见图） */
  const FOLD_KEY = 'nebula.fold'
  function foldSet() {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'))
    } catch {
      return new Set()
    }
  }
  function saveFold(set) {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify([...set]))
    } catch {}
  }
  /* 静默失败的出口：不弹 toast 打断人，但第一次出问题时留一行可查的日志。
     同一种失败只记一次，避免 12 秒轮询把控制台刷满。 */
  const _softSeen = new Set()
  /** 接口长时间连不上时，在画面顶部留一条细提示（不挡操作，恢复后自己消失）。 */
  function setOffline(on) {
    const bar = $('#netbar')
    if (!bar) return
    const was = state.offline
    state.offline = !!on
    bar.hidden = !on
    if (was && !on) toast(T('连接已恢复'))
  }

  function softWarn(tag, err) {
    if (_softSeen.has(tag)) return
    _softSeen.add(tag)
    try {
      // 降级路径默认安静；排查时在控制台执行 window.__NEBULA_DEBUG__ = true 再刷新。
      if (window.__NEBULA_DEBUG__) console.debug('[nebula] ' + tag + T(' 降级：') + ((err && err.message) || err))
    } catch {}
  }

  function attachFold(box, key) {
    if (foldSet().has(key)) box.classList.add('folded')
    const b = el('button', 'fold')
    b.type = 'button'
    b.title = T('收起 / 展开')
    b.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>'
    b.onclick = (ev) => {
      ev.stopPropagation()
      box.classList.toggle('folded')
      const now = foldSet()
      if (box.classList.contains('folded')) now.add(key)
      else now.delete(key)
      saveFold(now)
    }
    return b
  }

  function buildFilters(graph) {
    const root = $('#filters')
    root.innerHTML = ''
    const stats = graph.stats || {}
    const wsCounts = stats.byWorkspace || {}
    const lvCounts = stats.byLevel || {}
    const typeCounts = stats.byType || {}

    // 重建后工作区/层级/类型可能增减：先把筛选键收敛到现有集合。
    // 否则某个工作区改名后，键还留在 state.filter 里，画面上就会「一条都看不见」，
    // 而左侧 chip 却全是亮的 —— 最难查的那种不一致。
    const prune = (set, valid) => {
      if (!set) return null
      const next = new Set()
      for (const k of set) if (valid.has(k)) next.add(k)
      return next.size === valid.size ? null : next
    }
    state.filter.ws = prune(state.filter.ws, new Set(Object.keys(wsCounts)))
    state.filter.levels = prune(state.filter.levels, new Set(Object.keys(lvCounts)))
    state.filter.types = prune(state.filter.types, new Set(Object.keys(typeCounts)))
    const provCounts = {}
    for (const n of graph.nodes || []) {
      const key = n.provider || 'meow-memory'
      provCounts[key] = (provCounts[key] || 0) + 1
    }
    state.filter.providers = prune(state.filter.providers, new Set(Object.keys(provCounts)))
    const chipClass = (set, key) => (set && !set.has(key) ? 'chip' : 'chip on')

    // 记忆来源：接了多个记忆插件之后，这一栏回答「这条记忆是谁给的」。
    // 只有一种来源时整节省略——一颗 chip 的筛选器只是噪音。
    const provChips = []
    const provKeys = Object.keys(provCounts).sort((a, b) => provCounts[b] - provCounts[a])
    if (provKeys.length > 1) {
      for (const prov of provKeys) {
        const chip = el('button', chipClass(state.filter.providers, prov))
        const sw = el('i', 'sw')
        sw.style.background = providerColor(prov)
        chip.appendChild(sw)
        chip.appendChild(el('span', null, providerLabel(prov)))
        chip.appendChild(el('span', 'n', String(provCounts[prov])))
        chip.dataset.provider = prov
        chip.title = T('只画「') + providerLabel(prov) + T('」给的记忆')
        chip.onclick = () => {
          chip.classList.toggle('on')
          syncProviderFilter()
        }
        provChips.push(chip)
      }
      root.appendChild(section(T('记忆来源'), provChips, () => provChips.forEach((c) => c.classList.add('on'))))
    }

    const wsChips = []
    for (const [ws, count] of Object.entries(wsCounts).sort((a, b) => b[1] - a[1])) {
      const chip = el('button', chipClass(state.filter.ws, ws))
      const sw = el('i', 'sw')
      sw.style.background = clusterColor(graph, ws)
      chip.appendChild(sw)
      chip.appendChild(el('span', null, ws))
      chip.appendChild(el('span', 'n', String(count)))
      chip.dataset.ws = ws
      chip.onclick = () => {
        chip.classList.toggle('on')
        syncWsFilter()
      }
      wsChips.push(chip)
    }
    root.appendChild(section(T('工作区'), wsChips, () => wsChips.forEach((c) => c.classList.add('on'))) )

    // 顶部常驻的「回全视图」＋ 当前筛选代价提示：
    // 防止筛到只剩几条时以为图坏了（连接看不见 / 回不到全视图）
    const resetBar = el('div', 'sect reset-bar')
    const resetBtn = el('button', 'chip reset', T('重置筛选 · 回全视图'))
    resetBtn.title = T('清掉所有筛选，并把镜头拉回能看见全部记忆的位置（F）')
    resetBtn.onclick = () => resetFilters()
    resetBar.appendChild(resetBtn)
    const hint = el('div', 'filter-hint', '')
    hint.id = 'filter-hint'
    resetBar.appendChild(hint)
    root.appendChild(resetBar)

    const lvChips = []
    for (const key of ['project', 'lesson', 'topic', 'fact', 'user', 'rules', 'soul']) {
      if (!lvCounts[key]) continue
      const chip = el('button', chipClass(state.filter.levels, key))
      const sw = el('i', 'sw')
      sw.style.background = LEVEL_COLOR[key]
      chip.appendChild(sw)
      chip.appendChild(el('span', null, LEVEL_LABEL[key] || key))
      chip.appendChild(el('span', 'n', String(lvCounts[key])))
      chip.dataset.level = key
      chip.onclick = () => {
        chip.classList.toggle('on')
        syncLevelFilter()
      }
      lvChips.push(chip)
    }
    root.appendChild(section(T('记忆层级'), lvChips, () => lvChips.forEach((c) => c.classList.add('on'))))

    const typeChips = []
    for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      const chip = el('button', chipClass(state.filter.types, type))
      const sw = el('i', 'sw')
      sw.style.background = TYPE_COLOR[type] || '#8fb8d8'
      chip.appendChild(sw)
      chip.appendChild(el('span', null, TYPE_LABEL[type] || type))
      chip.appendChild(el('span', 'n', String(count)))
      chip.dataset.type = type
      chip.onclick = () => {
        chip.classList.toggle('on')
        syncTypeFilter()
      }
      typeChips.push(chip)
    }
    root.appendChild(section(T('连接类型'), typeChips, () => typeChips.forEach((c) => c.classList.add('on'))))

    // 强度滑杆
    const sect = el('div', 'sect')
    const h4a = el('h4', null, T('最小连接强度'))
    h4a.appendChild(attachFold(sect, 'f:minW'))
    sect.appendChild(h4a)
    const slider = el('div', 'slider')
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0'
    range.max = '90'
    range.value = String(Math.round((state.filter.minW || 0) * 100))
    const val = el('span', 'val', (state.filter.minW || 0).toFixed(2))
    range.oninput = () => {
      state.filter.minW = Number(range.value) / 100
      val.textContent = (Number(range.value) / 100).toFixed(2)
      applyFilter()
    }
    slider.appendChild(range)
    slider.appendChild(val)
    sect.appendChild(slider)
    root.appendChild(sect)

    // 重要度滑杆
    const sect2 = el('div', 'sect')
    const h4b = el('h4', null, T('最低重要度'))
    h4b.appendChild(attachFold(sect2, 'f:minImp'))
    sect2.appendChild(h4b)
    const slider2 = el('div', 'slider')
    const range2 = document.createElement('input')
    range2.type = 'range'
    range2.min = '0'
    range2.max = '4'
    range2.value = String(state.filter.minImp || 0)
    const val2 = el('span', 'val', String(state.filter.minImp || 0))
    range2.oninput = () => {
      state.filter.minImp = Number(range2.value)
      val2.textContent = range2.value
      applyFilter()
    }
    slider2.appendChild(range2)
    slider2.appendChild(val2)
    sect2.appendChild(slider2)
    root.appendChild(sect2)

    function syncWsFilter() {
      const on = wsChips.filter((c) => c.classList.contains('on')).map((c) => c.dataset.ws)
      state.filter.ws = on.length === wsChips.length ? null : new Set(on)
      applyFilter()
    }
    function syncLevelFilter() {
      const on = lvChips.filter((c) => c.classList.contains('on')).map((c) => c.dataset.level)
      state.filter.levels = on.length === lvChips.length ? null : new Set(on)
      applyFilter()
    }
    function syncProviderFilter() {
      const on = provChips.filter((c) => c.classList.contains('on')).map((c) => c.dataset.provider)
      state.filter.providers = on.length === provChips.length ? null : new Set(on)
      applyFilter()
    }
    function syncTypeFilter() {
      const on = typeChips.filter((c) => c.classList.contains('on')).map((c) => c.dataset.type)
      state.filter.types = on.length === typeChips.length ? null : new Set(on)
      applyFilter()
    }

    // 新的一批节点刚被 load 进来，hidden 标记还没跟上当前筛选 —— 这里补一次，
    // 让「面板显示的筛选」和「画布上真正画出来的」从第一帧就一致。
    applyFilter()
  }

  function section(title, chips, reset) {
    const s = el('div', 'sect')
    const h = document.createElement('h4')
    h.appendChild(document.createTextNode(title))
    const right = el('span', 'h4-r')
    right.appendChild(attachFold(s, 'f:' + title))
    const btn = document.createElement('button')
    btn.textContent = T('全部')
    btn.onclick = reset
    right.appendChild(btn)
    h.appendChild(right)
    s.appendChild(h)
    const box = el('div', 'chips')
    for (const c of chips) box.appendChild(c)
    s.appendChild(box)
    return s
  }

  // ---------------- 记忆来源面板 ----------------
  // 谁在写记忆：每个工作区一个 meow 库，外加装了哪些插件 / 技能 / MCP。
  // 点工作区那一行就等于筛掉别的工作区，和左边 chips 联动。
  async function renderSources() {
    const list = $('#src-list')
    if (!list) return
    let ov
    try {
      ov = await API.overview()
    } catch (err) {
      softWarn('overview', err)
      list.innerHTML = ''
      list.appendChild(el('div', 'dim', T('来源读不到：') + ((err && err.message) || err)))
      return
    }
    list.innerHTML = ''
    state.hygiene = ov.hygiene || null
    const tagn = $('#src-tag')
    if (tagn) tagn.textContent = (ov.stats?.nodes || 0) + T(' 条')

    const num = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)
    const line = (k, v, note) => {
      const row = el('div', 'src')
      row.appendChild(el('span', null, k))
      row.appendChild(el('span', 'n', v))
      if (note) row.title = note
      list.appendChild(row)
    }
    const wsList = (ov.workspaces || []).map((w) => `${w.name} ${w.count}`)
    const inv = ov.inventory || {}
    line(T('记忆库'), (ov.workspaces || []).length + T(' 个'), T('每个工作区一个 .dsh-meow/memory.db\n') + wsList.join('\n'))
    line(T('已装插件'), num(inv.plugins), T('profile 里声明的全部插件'))
    const memPlugins = inv.memoryPlugins || []
    if (memPlugins.length) line(T('记忆类插件'), memPlugins.length, memPlugins.join('\n'))
    line(T('技能'), num(inv.skills), T('SKILL.md 目录数'))
    line('MCP', num(inv.mcp), (inv.mcpNames || []).join(' · '))

    // 被人工否掉的关联：可以展开看、逐条恢复。
    // 这张表就是「关联算错了」的出口，比删边更彻底——重建时也不会再连。
    let mutes = []
    let muteOk = true
    try {
      const r = await API.mutes()
      mutes = r.mutes || []
    } catch {
      // 走到这里说明后台是旧版宿主（没有 /mutes），先不显示这一行，免得点了报错
      muteOk = false
    }
    if (muteOk) {
      const mRow = el('div', 'src src-click')
      mRow.appendChild(el('span', null, T('已屏蔽关联')))
      mRow.appendChild(el('span', 'n', mutes.length + T(' 条')))
      mRow.title = mutes.length ? T('点一下展开，可以逐条恢复') : T('还没有屏蔽过任何关联')
      list.appendChild(mRow)
      if (mutes.length) {
      const box = el('div', 'mutes')
      box.style.display = 'none'
      const label = (id) => {
        const n = state.graph && state.graph.nodes.find((x) => x.id === id)
        return n ? n.label || n.title || id : id.slice(-8)
      }
      for (const m of mutes.slice(0, 24)) {
        const row = el('div', 'mute')
        const t = el('div', 'mt', label(m.a) + ' ⇸ ' + label(m.b))
        t.title = m.a + '\n' + m.b
        row.appendChild(t)
        const undo = el('button', 'mini', T('恢复'))
        undo.onclick = async (ev) => {
          ev.stopPropagation()
          try {
            await API.unmute(m.a, m.b)
            toast(T('已恢复这条关联'))
            await reload(false)
            renderSources()
          } catch (e) {
            toast(T('恢复失败：') + e.message)
          }
        }
        row.appendChild(undo)
        box.appendChild(row)
        }
        list.appendChild(box)
        mRow.onclick = () => {
          box.style.display = box.style.display === 'none' ? 'block' : 'none'
        }
      }
    }

    // 记忆体检：把「越写越肥 / 没人读 / 疑似重复 / 关系是凑的」查成一张清单。
    // 只诊断、不改记忆——这里点进去看，改不改由人（或 AI）决定。
    const hy = ov.hygiene
    if (hy && hy.total) {
      const HORDER = ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan']
      const HMIN = { dup: 1, stale: 1, thin: 1, oversize: 2, unread: 6, orphan: 6 }
      const kinds = HORDER.filter((k) => (hy.counts?.[k] || 0) >= (HMIN[k] || 1))
      if (kinds.length) {
        const head = el('div', 'src src-click')
        head.appendChild(el('span', null, T('记忆体检')))
        head.appendChild(el('span', 'n', hy.total + T(' 项')))
        head.title = T('不是说记忆写错了，是说它们该整理、该更新、该被用起来\n点一下展开')
        list.appendChild(head)

        const box = el('div', 'mutes')
        box.style.display = 'none'
        for (const k of kinds) {
          const meta = (hy.meta && hy.meta[k]) || { label: k, hint: '' }
          const wrap = el('div', 'hy')
          const title = el('div', 'hy-t', meta.label + ' · ' + hy.counts[k])
          title.title = meta.hint || ''
          wrap.appendChild(title)

          const items = (hy.items?.[k] || []).slice(0, 5)
          for (const it of items) {
            let text = ''
            let jump = null
            if (k === 'dup') {
              text = (it.a.label || '').slice(0, 22) + ' ⇄ ' + (it.b.label || '').slice(0, 22) + ' · ' + it.sim
              jump = it.a.id
            } else if (k === 'stale') {
              text = (it.label || '').slice(0, 26) + ' · ' + it.days + T(' 天')
              jump = it.id
            } else if (k === 'thin') {
              text = (it.label || '').slice(0, 26) + T(' · 均 ') + it.avg
              jump = it.id
            } else if (k === 'oversize') {
              text = (it.label || '').slice(0, 24) + ' · ' + it.size + T(' 字')
              jump = it.id
            } else if (k === 'unread') {
              text = (it.label || '').slice(0, 26) + ' · ' + it.days + T(' 天')
              jump = it.id
            } else {
              text = (it.label || '').slice(0, 28)
              jump = it.id
            }
            const row = el('div', 'hy-i', text)
            row.onclick = () => jump && showDetail(jump)
            wrap.appendChild(row)
          }
          if ((hy.counts?.[k] || 0) > items.length) {
            wrap.appendChild(el('div', 'hy-more', T('还有 ') + (hy.counts[k] - items.length) + T(' 条（用 nebula_stats 看全量）')))
          }
          box.appendChild(wrap)
        }
        list.appendChild(box)
        head.onclick = () => {
          box.style.display = box.style.display === 'none' ? 'block' : 'none'
        }
      }
    }

    const tip = el('div', 'dim', T('记忆本体只读：星图只读 meow-memory 的数据库，不改任何一条原文。'))
    list.appendChild(tip)
  }

  function clusterColor(graph, ws) {
    const c = (graph.clusters || []).find((x) => x.id === ws || x.title === ws)
    return (c && c.color) || '#6cc8ff'
  }

  // ---------------- 项目卡片（交接卡） ----------------
  // 一个工作区一张：现状（条数/层级/项目）· 最近变更 · 下一步与卡点 · 代表记忆 · 健康项。
  // 数据来自引擎的 /overview.cards，这里只排版面，不做判断。
  function agoText(ts) {
    if (!ts) return ''
    const m = Math.round((Date.now() - ts) / 60000)
    if (m < 1) return T('刚刚')
    if (m < 60) return m + T(' 分钟前')
    const h = Math.round(m / 60)
    if (h < 24) return h + T(' 小时前')
    const d = Math.round(h / 24)
    if (d < 30) return d + T(' 天前')
    return Math.round(d / 30) + T(' 个月前')
  }

  const HY_NAME = {
    dup: T('疑似重复'),
    oversize: T('太长'),
    stale: T('该更新'),
    unread: T('没人读'),
    thin: T('关系凑数'),
    orphan: T('孤立'),
  }

  function closeCards() {
    const box = $('#cards')
    if (box) box.hidden = true
  }

  // 只看一个工作区：直接点掉别的工作区 chip，复用原来的筛选逻辑
  function focusWorkspace(ws) {
    const chips = [...document.querySelectorAll('#filters .chip[data-ws]')]
    const target = chips.find((c) => c.dataset.ws === ws)
    if (!target) return
    for (const c of chips) {
      const on = c.classList.contains('on')
      if (c === target && !on) c.click()
      else if (c !== target && on) c.click()
    }
    if (state.stage) state.stage.fit()
    toast(T('只看 ') + ws)
  }

  async function openCards() {
    const box = $('#cards')
    const grid = $('#cards-grid')
    if (!box || !grid) return
    box.hidden = false
    grid.innerHTML = ''
    grid.appendChild(el('div', 'pc-empty', T('正在汇总…')))
    let ov
    try {
      ov = await API.overview()
    } catch (err) {
      grid.innerHTML = ''
      grid.appendChild(el('div', 'pc-empty', T('读取失败：') + ((err && err.message) || err)))
      return
    }
    const cards = (ov.cards && ov.cards.cards) || []
    const sub = $('#cards-sub')
    if (sub) {
      sub.textContent =
        cards.length + T(' 个工作区 · 共 ') + (ov.stats ? ov.stats.nodes : 0) + T(' 条记忆 · ') + agoText((ov.cards && ov.cards.generatedAt) || Date.now())
    }
    grid.innerHTML = ''
    if (!cards.length) {
      grid.appendChild(el('div', 'pc-empty', T('还没有可汇总的记忆')))
      return
    }
    for (const c of cards) {
      const card = el('div', 'pcard')
      const head = el('div', 'pc-head')
      const title = el('div', 'pc-title', c.title)
      title.title = T('点一下：星图里只看这个项目')
      title.onclick = () => {
        closeCards()
        focusWorkspace(c.ws)
      }
      head.appendChild(title)
      head.appendChild(el('div', 'pc-n', c.total + T(' 条')))
      card.appendChild(head)

      const meta = el('div', 'pc-meta')
      const lv = c.levels || {}
      for (const k of ['project', 'lesson', 'topic', 'fact', 'user', 'rules', 'soul']) {
        if (!lv[k]) continue
        meta.appendChild(el('span', 'pc-tag', (LEVEL_LABEL[k] || k) + ' ' + lv[k]))
      }
      if (c.sessions) meta.appendChild(el('span', 'pc-tag', c.sessions + T(' 个会话')))
      for (const p of (c.projects || []).slice(0, 3)) meta.appendChild(el('span', 'pc-tag', p))
      card.appendChild(meta)

      const sec = (t) => card.appendChild(el('div', 'pc-sec', t))
      const row = (txt, id, hint) => {
        const d = el('div', 'pc-row', txt)
        if (hint) d.title = hint
        if (id) {
          d.onclick = () => {
            closeCards()
            showDetail(id)
            if (state.stage) state.stage.focusNode(id, 2.4)
          }
        }
        card.appendChild(d)
      }

      if ((c.recent || []).length) {
        sec(T('最近变更'))
        for (const r of c.recent) row(r.label, r.id, agoText(r.at) + ' · ' + (LEVEL_LABEL[r.level] || r.level))
      }
      sec(T('下一步与卡点'))
      if ((c.todos || []).length) {
        for (const t of c.todos) row(t.label, t.id, 'importance ' + (t.importance || 1) + (t.goal ? ' · ' + t.goal : ''))
      } else {
        card.appendChild(el('div', 'pc-empty', T('没有 active 的 todo 条目')))
      }
      if ((c.hubs || []).length) {
        sec(T('代表记忆'))
        for (const h of c.hubs) row(h.label, h.id, T('重要度 ') + h.importance + ' · ' + h.degree + T(' 条连接'))
      }
      const health = Object.entries(c.health || {}).filter(([, v]) => v)
      if (health.length) {
        const hbox = el('div', 'pc-health')
        for (const [k, v] of health) hbox.appendChild(el('i', null, (HY_NAME[k] || k) + ' ' + v))
        card.appendChild(hbox)
      }
      grid.appendChild(card)
    }
  }

  function applyFilter() {
    state.stage.setFilter({
      ws: state.filter.ws,
      levels: state.filter.levels,
      types: state.filter.types,
      providers: state.filter.providers,
      minW: state.filter.minW,
      minImp: state.filter.minImp,
    })
    updateFilterHint()
  }

  /** 一行字告诉你「现在的筛选让多少东西看不见了」，避免误以为图坏了。 */
  function updateFilterHint() {
    const box = $('#filter-hint')
    if (!box || !state.graph) return
    const total = (state.graph.nodes || []).length
    const totalEdges = (state.graph.edges || []).length
    let shown = total
    try {
      const vis = state.stage.visibleNodes ? state.stage.visibleNodes() : null
      if (Array.isArray(vis)) shown = vis.length
    } catch {}
    const hidden = Math.max(0, total - shown)
    const f = state.filter
    const active = !!(f.ws || f.levels || f.types || f.providers || f.minW > 0 || f.minImp > 0)
    if (!active && !hidden) {
      box.textContent = ''
      box.classList.remove('warn')
      clearFilterEmptyHint()
      return
    }
    box.classList.add('warn')
    box.textContent =
      T('已筛选：隐藏 ') + hidden + T(' 条记忆') + (f.minW > 0 ? T(' / 弱连接 ') + f.minW.toFixed(2) + T(' 以下不画') : '') + T('（共 ') + totalEdges + T(' 条连接）')
    // 全被筛掉时不能只留一片空屏——那看着和图坏了没区别。给一句话和一个出口。
    const hint = $('#hint')
    if (hint) {
      if (total > 0 && shown === 0) {
        hint.innerHTML = ''
        hint.appendChild(el('b', null, T('这一屏没有记忆')))
        hint.appendChild(document.createTextNode(T('当前筛选把整张图都藏起来了 · Shift + F 或左栏「重置筛选」回到全视图')))
        hint.classList.add('show')
        hint.dataset.byFilter = '1'
      } else {
        clearFilterEmptyHint()
      }
    }
  }

  /** 只清掉「被筛空」这条提示，不碰搜索/空库的提示。 */
  function clearFilterEmptyHint() {
    const hint = $('#hint')
    if (!hint || hint.dataset.byFilter !== '1') return
    hint.classList.remove('show')
    hint.innerHTML = ''
    delete hint.dataset.byFilter
  }

  /** 一键回到全视图：清空筛选 ＋ 2D/3D 都回到 fit 位置。 */
  function resetFilters() {
    state.filter = { ws: null, levels: null, types: null, providers: null, minW: 0, minImp: 0 }
    for (const c of document.querySelectorAll('#filters .chip')) {
      if (!c.classList.contains('reset')) c.classList.add('on')
    }
    for (const r of document.querySelectorAll('#filters input[type=range]')) {
      r.value = r.max === '90' ? '0' : '0'
      const v = r.parentNode && r.parentNode.querySelector('.val')
      if (v) v.textContent = r.max === '4' ? '0' : '0.00'
    }
    applyFilter()
    if (state.stage) state.stage.fit()
    toast(T('已回到全视图'))
  }

  // ---------------- 图例 ----------------
  function renderLegend(graph) {
    const box = $('#legend')
    box.innerHTML = ''
    const levels = new Set((graph.nodes || []).map((n) => n.level))
    for (const key of ['project', 'lesson', 'topic', 'fact', 'user', 'rules', 'soul', 'source']) {
      if (!levels.has(key)) continue
      const lg = el('div', 'lg')
      if (key === 'source') {
        const dia = el('i')
        dia.style.width = '7px'
        dia.style.height = '7px'
        dia.style.background = 'transparent'
        dia.style.border = `1.5px solid ${LEVEL_COLOR.source}`
        dia.style.transform = 'rotate(45deg)'
        dia.style.boxShadow = `0 0 7px ${LEVEL_COLOR.source}`
        lg.appendChild(dia)
      } else {
        const dot = el('i')
        dot.style.width = '7px'
        dot.style.height = '7px'
        dot.style.borderRadius = '50%'
        dot.style.background = LEVEL_COLOR[key]
        dot.style.boxShadow = `0 0 7px ${LEVEL_COLOR[key]}`
        lg.appendChild(dot)
      }
      lg.appendChild(el('span', null, LEVEL_LABEL[key] || key))
      box.appendChild(lg)
    }
  }

  // ---------------- 搜索 ----------------
  const qInput = $('#q')
  /** 清空搜索并把焦点还给画布：Esc、空结果里的「清空搜索」共用同一条退路。 */
  function clearSearch() {
    qInput.value = ''
    state.query = ''
    state.hits = []
    $('#hits').classList.remove('show')
    state.stage.highlight(null, false)
    qInput.blur()
  }
  qInput.addEventListener('input', () => {
    clearTimeout(state.timer)
    const q = qInput.value.trim()
    state.query = q
    if (!q) {
      $('#hits').classList.remove('show')
      return
    }
    state.timer = setTimeout(runSearch, 240)
  })
  qInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      // 结果来了默认高亮第一条；回车打开高亮那条（没高亮过就是第一条）
      if (state.hits.length) pickHit(state.hits[Math.max(0, state.hitIndex | 0)])
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      setHitIndex((state.hitIndex | 0) + 1, true)
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      // 在第一条上按 ↑ 绕到最后一条，别卡住不动
      setHitIndex(state.hitIndex <= 0 ? state.hits.length - 1 : state.hitIndex - 1, true)
    } else if (ev.key === 'Escape') {
      // 顺手把焦点还给画布：否则人以为「Esc 已经退出了」，其实键盘还留在输入框里，
      // 后面的 1/2/3、f、r 全被吞掉（看起来像快捷键坏了）。
      clearSearch()
    }
  })
  /* ── 看板（来源 / 真源 / 体检 / 屏蔽） ───────────────────────────── */

  let boardTab = 'src'

  function closeBoards() {
    const box = $('#boards')
    if (box) box.hidden = true
  }

  async function openBoards(tab) {
    const box = $('#boards')
    if (!box) return
    box.hidden = false
    boardTab = tab || boardTab
    for (const b of document.querySelectorAll('#board-tabs .btab')) b.classList.toggle('on', b.dataset.tab === boardTab)
    await renderBoards()
  }

  async function renderBoards() {
    const body = $('#boards-body')
    if (!body) return
    body.innerHTML = ''
    // 屏蔽页只读自己的列表：不必先等 overview（那一趟在数据大时挺慢）
    if (boardTab === 'mute') return renderBoardMute(body)
    body.appendChild(el('div', 'bd-dim', T('正在读…')))
    let ov
    try {
      ov = await API.overview()
    } catch (err) {
      body.innerHTML = ''
      body.appendChild(el('div', 'bd-dim', T('读取失败：') + ((err && err.message) || err)))
      return
    }
    state.over = ov
    body.innerHTML = ''
    if (boardTab === 'src') return renderBoardSources(body, ov)
    if (boardTab === 'truth') return renderBoardTruth(body, ov)
    if (boardTab === 'health') return renderBoardHealth(body, ov)
    return renderBoardMute(body)
  }

  function boardRow(body, label, dim, act, onClick) {
    const row = el('div', 'bd-row')
    row.appendChild(el('b', '', label))
    if (dim) row.appendChild(el('span', 'bd-dim', dim))
    if (act) row.appendChild(el('span', 'bd-act', act))
    if (onClick) row.onclick = onClick
    body.appendChild(row)
    return row
  }

  function renderBoardSources(body, ov) {
    const inv = ov.inventory || {}
    const libs = (ov.workspaces || []).filter((w) => (w.name || w.title) !== '来源')
    body.appendChild(el('div', 'bd-sec', T('记忆库（只读）')))
    for (const w of libs) {
      const name = w.name || w.title
      boardRow(body, name, (w.count != null ? w.count : w.size) + T(' 条'), T('只看它 →'), () => {
        closeBoards()
        focusWorkspace(name)
      })
    }
    body.appendChild(el('div', 'bd-sec', T('记忆类插件 / MCP / 技能')))
    boardRow(body, T('已装插件 ') + (inv.plugins || 0) + T(' · 记忆类 ') + (inv.memoryPlugins || []).length, (inv.memoryPlugins || []).join('、'), '')
    boardRow(body, 'MCP ' + (inv.mcp || 0), (inv.mcpNames || []).join('、'), '')
    boardRow(body, T('技能 ') + (inv.skills || 0), '', '')
    body.appendChild(el('div', 'bd-sec', T('外部记忆源')))
    for (const e of (ov.externals && ov.externals.items) || []) {
      boardRow(body, e.name + (e.ok ? T(' · 可读') : T(' · 暂不可读')), e.note, '')
    }
  }

  function renderBoardTruth(body, ov) {
    const t = ov.truth || { total: 0, groups: [] }
    body.appendChild(el('div', 'bd-sec', T('声明过自己是权威的记忆：') + t.total + T(' 条 / ') + t.groups.length + T(' 个项目')))
    if (!t.total) body.appendChild(el('div', 'bd-dim', T('还没有记忆在正文里声明「以…为准」。')))
    for (const g of t.groups) {
      body.appendChild(el('div', 'bd-sec', g.project + '（' + g.items.length + '）'))
      for (const it of g.items) {
        boardRow(body, it.label, (LEVEL_LABEL[it.level] || it.level) + ' · ' + it.ws, T('打开 →'), () => {
          closeBoards()
          showDetail(it.id)
        })
      }
    }
  }

  function renderBoardHealth(body, ov) {
    const h = ov.hygiene || { total: 0, items: {} }
    body.appendChild(el('div', 'bd-sec', T('体检：') + (h.total || 0) + T(' 项 · 只诊断不改库')))
    const groups = h.items && !Array.isArray(h.items) ? Object.entries(h.items) : []
    if (!groups.length) {
      body.appendChild(el('div', 'bd-dim', T('没查出问题。')))
      return
    }
    for (const [kind, arr] of groups) {
      if (!arr || !arr.length) continue
      body.appendChild(el('div', 'bd-sec', (HY_NAME[kind] || kind) + '（' + arr.length + '）'))
      for (const it of arr.slice(0, 8)) {
        if (kind === 'dup' && it.a && it.b) {
          // 疑似重复：两条并排显示，点哪条看哪条
          boardRow(body, 'A ' + (it.a.label || '').slice(0, 40), 'B ' + (it.b.label || '').slice(0, 40), T('对比 →'), () => {
            closeBoards()
            showDetail(it.a.id)
          })
          continue
        }
        boardRow(body, (it.label || it.title || it.id || '').slice(0, 64), (it.ws || '') + (it.importance ? T(' · 重要度 ') + it.importance : ''), T('打开 →'), () => {
          closeBoards()
          showDetail(it.id)
        })
      }
      if (arr.length > 8) body.appendChild(el('div', 'bd-dim', T('…还有 ') + (arr.length - 8) + T(' 条')))
    }
  }

  async function renderBoardMute(body) {
    let list = []
    try {
      const r = await API.mutes()
      list = (r && r.mutes) || []
    } catch (err) {
      // 读不到 ≠ 没有屏蔽：别让人以为列表被清空了
      softWarn('mutes-board', err)
      body.appendChild(el('div', 'bd-sec', T('已屏蔽的关联')))
      body.appendChild(el('div', 'bd-dim', T('屏蔽列表读不到：') + ((err && err.message) || err)))
      return
    }
    body.appendChild(el('div', 'bd-sec', T('已屏蔽的关联：') + list.length))
    if (!list.length) body.appendChild(el('div', 'bd-dim', T('没有屏蔽任何关联。')))
    // 光给 id 尾号没人认得出来：能从当前图上找到就显示记忆标题，找不到才退回尾号
    const byId = new Map(((state.graph && state.graph.nodes) || []).map((n) => [n.id, n]))
    const nameOf = (id) => {
      const n = byId.get(id)
      const label = (n && (n.label || n.title)) || ''
      return label ? (label.length > 26 ? label.slice(0, 26) + '…' : label) : (id || '').slice(-12)
    }
    for (const m of list) {
      const row = boardRow(body, nameOf(m.a) + ' ⇸ ' + nameOf(m.b), m.note || '', T('恢复'))
      row.title = (m.a || '') + ' ⇸ ' + (m.b || '')
      const act = row.querySelector('.bd-act')
      act.onclick = async (ev) => {
        ev.stopPropagation()
        // 服务端撤完还要重建一次图（~3s），当场给个「恢复中」，别让人以为没点上
        const label = act.textContent
        act.textContent = T('恢复中…')
        act.style.pointerEvents = 'none'
        try {
          await API.unmute(m.a, m.b)
          toast(T('已恢复'))
          renderBoards()
        } catch (err) {
          act.textContent = label
          act.style.pointerEvents = ''
          toast(T('恢复失败：') + ((err && err.message) || err))
        }
      }
    }
  }

  /* ── 导出：一张能直接发出去的图 / 一份能再分析的子图 ──────────────── */

  /** 系统级的「减少动态效果」：动画、自动旋转都要让路。 */
  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  }

  function stamp() {
    const d = new Date()
    const p = (x) => String(x).padStart(2, '0')
    return (
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      '-' +
      p(d.getHours()) +
      p(d.getMinutes()) +
      p(d.getSeconds())
    )
  }

  function download(name, blob) {
    const url = URL.createObjectURL(blob)
    const a = el('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    // blob URL 是下载的数据源：revoke 早了，浏览器写盘写到一半就被抽走，
    // 事件里会看到 receivedBytes 已满、state 却是 canceled。留足一分钟。
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  /** 把「现在看到的画面」连同一条标题栏拼成 PNG（界面元素不进图）。 */
  /**
   * 把一张星图打包成一个 HTML：样式、脚本、数据全在里面，双击就能看。
   * 不带参数是整张图；opts.ws 只导一个工作区，opts.focus 只导选中节点周围 2 跳。
   * 范围外的记忆根本不会写进文件——隐私不是靠前端藏起来。
   * 文件里含记忆全文，是「用户主动下载」的动作，不会上传到任何地方。
   */
  function exportShare(opts = {}) {
    if (API.snapshot) {
      toast(T('这已经是一份离线快照了'))
      return
    }
    if (API.demo) {
      toast(T('示例星系不导出：先点顶部「退出示例」，再导你自己的星图'))
      return
    }
    const u = new URL(API.base + '/share', location.origin)
    let what = T('整张星图')
    const hideDiary = Boolean($('#hide-diary')?.checked)
    if (hideDiary && opts.ws === '日记') {
      toast(T('这个工作区就是「日记」：要么取消勾选，要么换个范围再导'))
      return
    }
    if (hideDiary) u.searchParams.append('hide', 'ws:日记')
    if (opts.focus) {
      u.searchParams.set('scope', 'focus:' + opts.focus)
      u.searchParams.set('hops', '2')
      what = T('选中节点周围 2 跳')
    } else if (opts.ws) {
      u.searchParams.set('scope', 'ws:' + opts.ws)
      what = T('工作区「') + opts.ws + '」'
    }
    toast(T('正在打包') + what + (hideDiary ? T('（已隐去日记）') : '') + T('；下载名带范围和本地时间，不会覆盖上一份'))
    location.href = u.toString()
  }

  function diagnosticsText() {
    const g = state.graph || {}
    const st = g.stats || {}
    const meta = API.meta || {}
    const n = (v) => Number(v || 0)
    let gl = 'unavailable'
    try {
      const c = document.createElement('canvas')
      const ctx = c.getContext('webgl2') || c.getContext('webgl')
      if (ctx) {
        const dbg = ctx.getExtension('WEBGL_debug_renderer_info')
        gl = String(dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER) || 'webgl')
      } else {
        gl = 'none'
      }
    } catch {}
    const lines = [
      'memory-nebula diagnostics',
      T('# 不含记忆正文；可以整段贴给支持'),
      'version: ' + APP_VERSION + (state.engineVersion && state.engineVersion !== APP_VERSION ? ' (engine ' + state.engineVersion + ')' : ''),
      'build: ' + (meta.build || 'unknown'),
      'mode: ' + (API.snapshot ? 'snapshot' : API.demo ? 'demo' : (meta.mode || 'host')) + ' / ' + (state.modeKey || 'nebula'),
      'language: ' + (window.NebulaI18n?.lang || navigator.language || ''),
      'browser: ' + String(navigator.userAgent || ''),
      'screen: ' + n(screen.width) + '×' + n(screen.height) + ' @' + n(window.devicePixelRatio) + 'x',
      'webgl: ' + gl,
      'graph: ' + n(st.nodes) + ' memories / ' + n(st.edges) + ' links / ' + n(st.workspaces) + ' workspaces / ' + n(st.sessions) + ' sessions',
      'build: ' + n(meta.buildMs || g.buildMs) + 'ms' + (g.builtAt ? ' at ' + new Date(g.builtAt).toISOString() : ''),
      'sources: ' + n((g.sources || []).length),
      'lastError: ' + (state.lastError || 'none'),
    ]
    return lines.join('\n')
  }

  async function copyDiagnostics() {
    const ok = await copyText(diagnosticsText())
    toast(ok ? T('诊断信息已复制（不含正文）') : T('复制失败：浏览器没给剪贴板权限'))
  }

  function exportPNG() {
    const is2d = state.modeKey === 'nebula'
    // 2D：出图时把「给左侧面板留的空白」收掉、重新居中，图才不会一半是空的。
    // 全程同步，浏览器来不及绘制中间态，所以屏幕上不会闪一下。
    if (is2d && state.stage2d) {
      // 刚点完重建就导出时，画面还在「长」：先把这一屏点亮，别导出一张半截图
      if (typeof state.stage2d.finishReveal === 'function') state.stage2d.finishReveal()
      state.stage2d.setPadding({ left: 0, right: 0, top: 0, bottom: 0 })
      state.stage2d.fit(true)
      state.stage2d.drawNow()
    }
    // 3D：先同步补画一帧再取图像。WebGL 绘制缓冲不保留，
    // 上一帧早已被合成清掉，直接 drawImage 会导出一张「只有标题和簇名」的空图。
    if (!is2d && state.space3d && typeof state.space3d.paintNow === 'function') state.space3d.paintNow()
    const labels = is2d ? null : $('#sky3dlbl')
    const sky = is2d ? $('#sky') : $('#sky3d')
    if (!sky || !sky.width) {
      toast(T('画布还没准备好'))
      if (is2d) {
        applyPadding()
        state.stage2d.fit(false)
      }
      return
    }
    const cw = sky.width
    const ch = sky.height
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const bar = Math.round(74 * dpr)
    const pad = Math.round(18 * dpr)
    const out = document.createElement('canvas')
    out.width = cw + pad * 2
    out.height = ch + bar + pad * 2
    const g = out.getContext('2d')
    g.fillStyle = '#05070d'
    g.fillRect(0, 0, out.width, out.height)
    g.drawImage(sky, pad, bar + pad, cw, ch)
    if (labels && labels.width) g.drawImage(labels, pad, bar + pad, cw, ch)
    // 像素已经拷进 out，可以立刻把界面恢复原样（回程用缓动，不硬跳）
    if (is2d && state.stage2d) {
      applyPadding()
      state.stage2d.fit(false)
    }

    const st = (state.graph && state.graph.stats) || {}
    g.textBaseline = 'middle'
    g.fillStyle = 'rgba(232,240,250,0.94)'
    g.font = '600 ' + Math.round(17 * dpr) + 'px "Segoe UI", system-ui, sans-serif'
    g.fillText(T('记忆星图'), pad + Math.round(4 * dpr), Math.round(26 * dpr))
    g.fillStyle = 'rgba(150,170,196,0.72)'
    g.font = '500 ' + Math.round(11 * dpr) + 'px "Segoe UI", system-ui, sans-serif'
    g.fillText('MEMORY NEBULA', pad + Math.round(78 * dpr), Math.round(27 * dpr))
    const line = [st.nodes, st.edges, st.workspaces].filter((v) => v != null)
    const info = (line.length ? line[0] + T(' 记忆 · ') + line[1] + T(' 连接 · ') + line[2] + T(' 工作区') : '') +
      (state.filter && (state.filter.minW || state.filter.ws || state.filter.types || state.filter.levels) ? T(' · 已筛选') : '')
    g.fillStyle = 'rgba(150,170,196,0.66)'
    g.font = '500 ' + Math.round(11 * dpr) + 'px "Segoe UI", system-ui, sans-serif'
    g.textAlign = 'right'
    g.fillText(info, out.width - pad - Math.round(4 * dpr), Math.round(26 * dpr))
    g.fillStyle = 'rgba(120,140,166,0.5)'
    g.fillText(new Date().toLocaleString('zh-CN'), out.width - pad - Math.round(4 * dpr), bar + pad + ch + Math.round(-18 * dpr))
    g.textAlign = 'left'

    out.toBlob((blob) => {
      if (!blob) {
        toast(T('导出失败：浏览器没给图'))
        return
      }
      download('memory-nebula-' + stamp() + '.png', blob)
      toast(T('已导出 PNG'))
    }, 'image/png')
  }

  /** 把当前筛选下看得见的这张子图导出成 JSON（节点 + 边 + 筛选条件）。 */
  function exportSubgraph() {
    const graph = state.graph
    if (!graph || !graph.nodes) {
      toast(T('还没有图可导出'))
      return
    }
    const f = state.filter || {}
    // 「可见」要和画面同一个定义：螺旋视图拖了时间轴，导出就只给那一天及之前的
    const cut = timeCutNow()
    const keep = (n) => {
      if (cut && (Number(n.createdAt) || 0) > cut) return false
      if (f.ws && !f.ws.has(n.ws)) return false
      if (f.levels && !f.levels.has(n.level)) return false
      if (f.minImp && (n.importance || 0) < f.minImp) return false
      return true
    }
    const nodes = graph.nodes.filter(keep).map((n) => ({
      id: n.id,
      label: n.label,
      workspace: n.ws,
      level: n.level,
      importance: n.importance,
      status: n.status || undefined,
      project: n.project || undefined,
      hits: n.hits || 0,
      degree: n.degree || 0,
      createdAt: n.createdAt || undefined,
    }))
    const ids = new Set(nodes.map((n) => n.id))
    const edges = (graph.edges || [])
      .filter((e) => ids.has(e.a) && ids.has(e.b))
      .filter((e) => !(f.types && !f.types.has(e.t)))
      .filter((e) => !(f.minW && e.w < f.minW))
      .map((e) => ({ source: e.a, target: e.b, type: e.t, weight: Math.round(e.w * 1000) / 1000, curated: !!e.curated }))
    const payload = {
      format: 'memory-nebula/subgraph@1',
      exportedAt: new Date().toISOString(),
      focus: state.selected || null,
      filter: {
        workspaces: f.ws ? [...f.ws] : null,
        levels: f.levels ? [...f.levels] : null,
        types: f.types ? [...f.types] : null,
        minWeight: f.minW || 0,
        minImportance: f.minImp || 0,
        until: cut ? new Date(cut).toISOString() : null,
      },
      stats: { nodes: nodes.length, edges: edges.length },
      nodes,
      edges,
    }
    download('memory-nebula-' + stamp() + '.json', new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    toast(T('已导出 ') + nodes.length + T(' 个节点 / ') + edges.length + T(' 条连接'))
  }

  /* ── 命令面板（Ctrl+K） ─────────────────────────────────────────── */

  const CMDS = [
    { k: T('视图'), t: T('星云（2D）'), run: () => applyMode('nebula') },
    { k: T('视图'), t: T('星系（3D）'), run: () => applyMode('space') },
    { k: T('视图'), t: T('时间（螺旋）'), run: () => applyMode('spiral') },
    { k: T('面板'), t: T('项目卡片'), run: () => openCards() },
    { k: T('面板'), t: T('看板：来源'), run: () => openBoards('src') },
    { k: T('面板'), t: T('看板：真源'), run: () => openBoards('truth') },
    { k: T('面板'), t: T('看板：体检'), run: () => openBoards('health') },
    { k: T('面板'), t: T('看板：屏蔽'), run: () => openBoards('mute') },
    { k: T('动作'), t: T('重建星图'), run: () => $('#btn-refresh')?.click() },
    { k: T('导出'), t: T('导出当前视图 PNG'), run: exportPNG },
    { k: T('导出'), t: T('导出可见子图 JSON'), run: exportSubgraph },
    { k: T('动作'), t: T('聚焦当前选中'), run: () => state.selected && state.stage.focusNode(state.selected, 2.2) },
    { k: T('动作'), t: T('重置筛选 · 回全视图'), run: () => resetFilters() },
    { k: T('动作'), t: T('主线：当前记忆的时间线'), run: () => openLine() },
    { k: T('帮助'), t: T('快捷键一览'), run: () => toggleKeys() },
  ]

  let cmdkIndex = 0
  let cmdkTimer = 0

  function closeCmdk() {
    const box = $('#cmdk')
    if (box) box.hidden = true
  }

  function openCmdk() {
    const box = $('#cmdk')
    const input = $('#cmdk-input')
    if (!box || !input) return
    box.hidden = false
    input.value = ''
    cmdkIndex = 0
    renderCmdk('')
    input.focus()
  }

  function renderCmdk(q) {
    const list = $('#cmdk-list')
    if (!list) return
    const query = q.trim().toLowerCase()
    list.innerHTML = ''
    const rows = []
    for (const c of CMDS) {
      if (query && !(c.t.toLowerCase().includes(query) || c.k.includes(query))) continue
      rows.push({ label: c.t, kind: c.k, ws: '', run: c.run })
    }
    if (query) {
      API.recall(q, { limit: 7 })
        .then((res) => {
          if (document.activeElement !== $('#cmdk-input')) return
          const box = $('#cmdk-list')
          if (!box) return
          const extra = (res.hits || []).map((h) => ({
            label: h.label || h.title || h.preview || h.id,
            kind: T('记忆'),
            ws: h.across ? '★ ' + (h.ws || '') : h.ws || '',
            run: () => showDetail(h.id),
          }))
          if (!extra.length) return
          for (const e of extra) box.appendChild(cmdRow(e))
        })
        .catch((err) => softWarn('recall', err))
    }
    for (const r of rows) list.appendChild(cmdRow(r))
    paintCmdk()
  }

  function cmdRow(r) {
    const row = el('div', 'cmd')
    row.appendChild(el('div', 'cm-k', r.kind))
    row.appendChild(el('div', 'cm-t', r.label))
    if (r.ws) row.appendChild(el('div', 'cm-w', r.ws))
    row.onclick = () => {
      closeCmdk()
      r.run()
    }
    row.dataset.run = '1'
    row._run = r.run
    return row
  }

  function paintCmdk() {
    const rows = [...document.querySelectorAll('#cmdk-list .cmd')]
    rows.forEach((r, i) => r.classList.toggle('on', i === cmdkIndex))
    const on = rows[cmdkIndex]
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' })
  }

  function runCmdk() {
    const rows = [...document.querySelectorAll('#cmdk-list .cmd')]
    const row = rows[cmdkIndex]
    if (!row) return
    closeCmdk()
    if (row._run) row._run()
  }

  /* ── 主线（一条记忆的时间上下文） ──────────────────────────────── */

  function closeLine() {
    const box = $('#linebar')
    if (box) box.hidden = true
  }

  async function openLine(id) {
    const box = $('#linebar')
    if (!box) return
    const target = id || state.selected
    if (!target) {
      toast(T('先选一条记忆，再看它的主线'))
      return
    }
    box.hidden = false
    const title = $('#lb-title')
    const body = $('#lb-body')
    body.innerHTML = ''
    body.appendChild(el('div', 'bd-dim', T('正在读…')))
    let d
    try {
      d = await API.node(target)
    } catch (err) {
      body.innerHTML = ''
      body.appendChild(el('div', 'bd-dim', T('读取失败：') + ((err && err.message) || err)))
      return
    }
    const node = d.node || d
    const peers = (node.peers && node.peers.items) || []
    if (title) title.textContent = T('主线 · ') + (node.title || node.label || '').slice(0, 26) + ' · ' + peers.length + T(' 条')
    body.innerHTML = ''
    if (!peers.length) {
      body.appendChild(el('div', 'bd-dim', T('这条记忆所在会话里没有别的记忆。')))
      return
    }
    // peers 是「同会话的其它记忆」，不含自己；主线要把当前这条也放进去，
    // 否则时间轴上找不到「我现在在哪」。
    const self = { id: node.id, label: node.title || node.label, level: node.level, createdAt: node.createdAt }
    const sorted = [self, ...peers.filter((p) => p.id !== node.id)].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    if (title) title.textContent = T('主线 · ') + (node.title || node.label || '').slice(0, 26) + ' · ' + sorted.length + T(' 条')
    // 跨天时给一个日期小标题：只靠「小时:分钟」的话，翻到昨天的段落完全看不出来。
    let lastKey = ''
    for (const p of sorted) {
      const dt = new Date(p.createdAt || 0)
      const key = dt.getFullYear() + '-' + (dt.getMonth() + 1) + '-' + dt.getDate()
      if (key !== lastKey) {
        lastKey = key
        body.appendChild(el('div', 'tl-day', dt.getMonth() + 1 + T('月') + dt.getDate() + T('日')))
      }
      const row = el('div', 'tl' + (p.id === node.id ? ' here' : ''))
      row.appendChild(el('div', 't', dt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })))
      row.appendChild(el('div', 'd', (p.label || p.title || '').slice(0, 60)))
      row.appendChild(el('div', 's', p.id === node.id ? T('当前') : LEVEL_LABEL[p.level] || p.level || ''))
      row.onclick = () => {
        closeLine()
        showDetail(p.id)
      }
      body.appendChild(row)
    }
    body.appendChild(el('div', 'bd-dim', T('同一次会话共 ') + ((node.peers.total || peers.length) + 1) + T(' 条（含当前这条），这里按时间排最相关的 ') + sorted.length + T(' 条。')))
  }

  document.addEventListener('keydown', (ev) => {
    const typing = document.activeElement === qInput || /input|textarea/i.test(document.activeElement?.tagName || '')
    // 命令面板：输入框里也要能上下选、回车执行
    if (!$('#cmdk').hidden) {
      if (ev.key === 'Escape') return closeCmdk()
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault()
        const n = document.querySelectorAll('#cmdk-list .cmd').length || 1
        cmdkIndex = (cmdkIndex + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n
        return paintCmdk()
      }
      if (ev.key === 'Enter') {
        ev.preventDefault()
        return runCmdk()
      }
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault()
      return openCmdk()
    }
    if (ev.key === '/' && !typing) {
      ev.preventDefault()
      qInput.focus()
      return
    }
    if (typing) return
    // 快捷键：1/2/3 切三档视图，e 聚焦选中，r 重建，Esc 关详情
    if (ev.key === '1') applyMode('nebula')
    else if (ev.key === '2') applyMode('space')
    else if (ev.key === '3') applyMode('spiral')
    else if (ev.key === 'p' || ev.key === 'P') {
      // 项目卡片：再按一次收起
      if ($('#cards').hidden) openCards()
      else closeCards()
    } else if (ev.key === 'b' || ev.key === 'B') {
      if ($('#boards').hidden) openBoards(boardTab)
      else closeBoards()
    } else if (ev.key === 'l' || ev.key === 'L') {
      if ($('#linebar').hidden) openLine()
      else closeLine()
    } else if (ev.key === 'e' || ev.key === 'E') {
      if (state.selected) state.stage.focusNode(state.selected, 2.2)
    } else if (ev.key === 'f' || ev.key === 'F') {
      // F 回全视图；Shift+F 连筛选一起清
      ev.preventDefault()
      if (ev.shiftKey) resetFilters()
      else {
        state.stage.fit()
        toast(T('回到全视图'))
      }
    } else if (ev.key === 'r' || ev.key === 'R') {
      $('#btn-refresh')?.click()
    } else if (ev.key === 'Escape') {
      if ($('#keys')) $('#keys').remove()
      else if (!$('#cmdk').hidden) closeCmdk()
      else if (!$('#cards').hidden) closeCards()
      else if (!$('#boards').hidden) closeBoards()
      else if (!$('#linebar').hidden) closeLine()
      else if (!$('#pathbar').hidden) closePath()
      else closeDetail()
    } else if (ev.key === '?') {
      toggleKeys()
    }
  })

  async function runSearch() {
    const q = state.query
    if (!q) return
    // 手快的时候两次请求会撞车：只认最后一次，别让旧结果盖掉新结果。
    const seq = (state.searchSeq || 0) + 1
    state.searchSeq = seq
    try {
      const res = await API.recall(q, { limit: 12 })
      if (seq !== state.searchSeq) return
      state.hits = res.hits || []
      renderHits(res)
      if (state.hits.length) {
        state.stage.pulseFrom(state.hits.slice(0, 6).map((h) => h.id), true)
        state.stage.highlight(state.hits[0].id, true)
      }
    } catch (err) {
      if (seq === state.searchSeq) toast(T('检索失败：') + err.message)
    }
  }

  /** 把命中标题里与查询重合的词标出来；用 indexOf 扫，不拼正则也不拼 HTML。 */
  function markTerms(host, text, query) {
    const terms = String(query || '').split(/\s+/).filter((t) => t.length >= 2).map((t) => t.toLowerCase())
    if (!terms.length) {
      host.appendChild(document.createTextNode(text))
      return
    }
    const lower = text.toLowerCase()
    let i = 0
    while (i < text.length) {
      let best = -1
      let bestLen = 0
      for (const t of terms) {
        const k = lower.indexOf(t, i)
        if (k !== -1 && (best === -1 || k < best || (k === best && t.length > bestLen))) {
          best = k
          bestLen = t.length
        }
      }
      if (best === -1) break
      if (best > i) host.appendChild(document.createTextNode(text.slice(i, best)))
      host.appendChild(el('b', 'hm', text.slice(best, best + bestLen)))
      i = best + bestLen
    }
    if (i < text.length) host.appendChild(document.createTextNode(text.slice(i)))
  }

  function renderHits(res) {
    const box = $('#hits')
    box.innerHTML = ''
    const hits = res.hits || []
    // 一小行抬头：搜了什么、扫了多少、最相关给了几条；认不出的词也说出来，
    // 免得人以为「没找到」而其实是词没落库。空结果也走这一套——空屏最需要解释。
    const head = el('div', 'hit-head')
    head.appendChild(el('div', 'hh-q', '“' + (res.query || '') + '”'))
    const meta = hits.length
      ? hits.length + T(' 条最相关') + (res.scanned ? T(' · 扫过 ') + res.scanned + T(' 条') : '')
      : T('没有命中') + (res.scanned ? T(' · 扫过 ') + res.scanned + T(' 条') : '')
    head.appendChild(el('div', 'hh-m', meta))
    box.appendChild(head)
    if (res.unknown && res.unknown.length) {
      box.appendChild(el('div', 'hit-unknown', T('没认出的词：') + res.unknown.slice(0, 6).join('、')))
    }
    if (!hits.length) {
      const row = el('div', 'hit-empty')
      row.appendChild(el('div', 't', T('没有找到相关记忆')))
      row.appendChild(el('div', 'm', T('换更短的词试试；也可以先按工作区筛一下，再在图里顺着连线找。')))
      const acts = el('div', 'hact')
      const retry = el('button', 'hbtn', T('清空搜索'))
      retry.type = 'button'
      retry.onclick = () => clearSearch()
      acts.appendChild(retry)
      const byWs = el('button', 'hbtn ghost', T('只看一个工作区'))
      byWs.type = 'button'
      byWs.onclick = () => {
        if ($('#leftcol') && getComputedStyle($('#leftcol')).display === 'none') $('#btn-left')?.click()
        toast(T('在左栏点一个工作区，就只看它'))
      }
      acts.appendChild(byWs)
      if (!API.snapshot && !API.demo) {
        const demo = el('button', 'hbtn ghost', T('看看示例'))
        demo.type = 'button'
        demo.onclick = () => window.dispatchEvent(new CustomEvent('nebula:enter-demo'))
        acts.appendChild(demo)
      }
      row.appendChild(acts)
      box.appendChild(row)
      box.classList.add('show')
      return
    }
    for (const h of hits) {
      const row = el('div', 'hit')
      const dot = el('i', 'dot')
      dot.style.background = LEVEL_COLOR[h.level] || '#8fb8d8'
      dot.style.boxShadow = `0 0 6px ${LEVEL_COLOR[h.level] || '#8fb8d8'}`
      const body = el('div', 'body')
      const titleRow = el('div', 't')
      if (h.across) titleRow.appendChild(document.createTextNode('★ '))
      markTerms(titleRow, h.label || h.title || h.id, res.query)
      if (h.across) {
        titleRow.title = T('跨工作区：这条记忆来自另一个项目，由星图的连接桥接过来')
        titleRow.style.color = '#ffd88a'
      }
      body.appendChild(titleRow)
      body.appendChild(el('div', 'm', [h.ws, LEVEL_LABEL[h.level] || h.level, T('强度 ') + (h.score || 0).toFixed(2)].join(' · ')))
      if (h.why) body.appendChild(el('div', 'why', '↳ ' + localizeWhy(h.why)))
      row.appendChild(dot)
      row.appendChild(body)
      row.onclick = () => pickHit(h)
      box.appendChild(row)
    }
    box.classList.add('show')
    setHitIndex(0, false)
  }

  /** 用 ↑↓ 在命中列表里走，右侧星图会实时预览（选中态由 Enter 决定）。 */
  function setHitIndex(i, preview) {
    const rows = [...document.querySelectorAll('#hits .hit')]
    if (!rows.length || !state.hits.length) return
    state.hitIndex = Math.max(0, Math.min(state.hits.length - 1, i))
    rows.forEach((r, k) => r.classList.toggle('on', k === state.hitIndex))
    rows[state.hitIndex].scrollIntoView({ block: 'nearest' })
    if (preview) {
      const h = state.hits[state.hitIndex]
      if (h) {
        state.stage.highlight(h.id, true)
        state.stage.pulseFrom([h.id], true)
      }
    }
  }

  function pickHit(h) {
    // 点完命中就把焦点还给画布：否则键盘还留在搜索框里，
    // 之后的 Esc / e / f / r 全被输入框吞掉（看起来像快捷键失灵）。
    if (document.activeElement === qInput) qInput.blur()
    state.stage.select(h.id)
    state.stage.focusNode(h.id, 2.1)
    showDetail(h.id)
    $('#hits').classList.remove('show')
  }

  // ---------------- 证据链（Shift + 点第二个节点） ----------------
  function closePath() {
    const bar = $('#pathbar')
    if (!bar) return
    bar.hidden = true
    if (state.stage2d) state.stage2d.setPath(null)
    if (state.space3d && state.space3d.setPath) state.space3d.setPath(null)
    applyPadding()
  }

  /**
   * 本地证据链：页面手里就有整张图（节点 + 带 why 的边），
   * 所以就算服务端还没带上 /path 路由（宿主未重启），也能当场算出来。
   * 代价函数与服务端一致：-log(权重)，即强证据更便宜；跳数超上限就认「没连上」。
   */
  function findPathLocal(from, to, maxHops) {
    const g = state.graph
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null
    const MAX_HOPS = maxHops || 6
    const MIN_W = 0.05
    const idx = new Map()
    g.nodes.forEach((n, i) => idx.set(n.id, i))
    if (!idx.has(from) || !idx.has(to)) return null
    const adj = new Map()
    for (const e of g.edges) {
      const w = Math.max(MIN_W, Number(e.w) || 0)
      if (!adj.has(e.a)) adj.set(e.a, [])
      if (!adj.has(e.b)) adj.set(e.b, [])
      adj.get(e.a).push({ to: e.b, w, t: e.t, why: e.why, e })
      adj.get(e.b).push({ to: e.a, w, t: e.t, why: e.why, e })
    }
    const cost = new Map([[from, 0]])
    const hops = new Map([[from, 0]])
    const prev = new Map()
    const done = new Set()
    while (done.size < g.nodes.length) {
      let u = null
      let best = Infinity
      for (const [id, c] of cost) {
        if (done.has(id)) continue
        if (c < best || (c === best && u && (hops.get(id) || 0) < (hops.get(u) || 0))) {
          best = c
          u = id
        }
      }
      if (u == null) break
      if (u === to) break
      done.add(u)
      for (const link of adj.get(u) || []) {
        if (done.has(link.to)) continue
        const nh = (hops.get(u) || 0) + 1
        if (nh > MAX_HOPS) continue
        const nc = best - Math.log(link.w)
        const old = cost.get(link.to)
        if (old == null || nc < old - 1e-9) {
          cost.set(link.to, nc)
          hops.set(link.to, nh)
          prev.set(link.to, { from: u, link })
        }
      }
    }
    if (!prev.has(to)) return null
    const idsR = [to]
    const edgesR = []
    let cur = to
    while (cur !== from) {
      const p = prev.get(cur)
      if (!p) return null
      edgesR.push({ t: p.link.t || 'link', w: Math.round(p.link.w * 1000) / 1000, why: p.link.why || '' })
      idsR.push(p.from)
      cur = p.from
    }
    const ids = idsR.reverse()
    edgesR.reverse()
    const score = edgesR.reduce((acc, e) => acc * e.w, 1)
    return { found: true, hops: ids.length - 1, score: Math.round(score * 1000) / 1000, ids, edges: edgesR, local: true }
  }

  /** 把「这两条记忆中间怎么连上的」摊开：图上编号 + 面板逐步证据。 */
  async function showPath(from, to) {
    if (!from || !to || from === to) return
    closePath()
    const bar = $('#pathbar')
    const body = $('#pb-body')
    bar.hidden = false
    body.innerHTML = '<div class="pb-empty">' + T('在算这条链…') + '</div>'
    let res = null
    let local = false
    try {
      res = await API.path(from, to)
    } catch (err) {
      softWarn('path', err)
      res = null
    }
    if (!res || !res.found) {
      const loc = findPathLocal(from, to, 6)
      if (loc) {
        const byId = new Map(state.graph.nodes.map((n) => [n.id, n]))
        res = {
          found: true,
          hops: loc.hops,
          score: loc.score,
          nodes: loc.ids.map((id) => {
            const n = byId.get(id) || {}
            return { id, label: n.label || id, level: n.level, ws: n.ws }
          }),
          edges: loc.edges,
        }
        local = true
      }
    }
    if (!res || !res.found) {
      $('#pb-title').textContent = T('证据链 · 没有连上')
      body.innerHTML =
        '<div class="pb-empty">' + T('这两条记忆在星图里没有连上（') +
        esc((res && res.error) || T('超过跳数上限')) +
        T('）。没有关系就不编关系。') + '</div>'
      return
    }
    const ids = res.nodes.map((n) => n.id)
    $('#pb-title').textContent =
      T('证据链 · ') + res.hops + T(' 跳 · 链强度 ') + res.score + (local ? T('（本地计算）') : '')
    if (state.stage2d) state.stage2d.setPath(ids)
    if (state.space3d && state.space3d.setPath) state.space3d.setPath(ids)
    if (state.stage && state.stage.pulseFrom) state.stage.pulseFrom(ids, true)
    body.innerHTML = ''
    res.nodes.forEach((n, i) => {
      const step = document.createElement('div')
      step.className = 'pb-step'
      const num = document.createElement('span')
      num.className = 'pb-n'
      num.textContent = String(i + 1)
      const lab = document.createElement('span')
      lab.className = 'pb-l'
      lab.textContent = n.label
      lab.title = n.label + '（' + n.ws + ' · ' + n.level + '）'
      step.append(num, lab)
      body.appendChild(step)
      if (i < res.edges.length) {
        const e = res.edges[i]
        const ed = document.createElement('div')
        ed.className = 'pb-edge'
        ed.textContent = '↳ ' + e.t + ' · ' + e.w + ' · ' + localizeWhylocalizeWhy(e.why || '')
        ed.title = localizeWhylocalizeWhy(e.why || '')
        body.appendChild(ed)
      }
    })
    applyPadding()
  }

  // ---------------- 详情 ----------------
  /* ── 新手三步 ─────────────────────────────────────────────────────
   * 有 1800 条记忆的人，第一眼的问题不是「怎么用」，是「从哪看起」。
   * 三步都做成能直接点的动作，不要求他先读说明书；跳过只写 localStorage，
   * 不碰记忆库，也不会在示例/快照里出现。
   */
  const ONBOARD_KEY = 'nebula.onboarded.v1'

  function dismissOnboard(card) {
    try {
      localStorage.setItem(ONBOARD_KEY, '1')
    } catch {}
    if (card) card.remove()
  }

  function showOnboard(force = false) {
    // 先收旧卡片，再决定要不要显示：从真实库进示例时，旧卡片不能留在画面上。
    const old = $('#onboard')
    if (old) old.remove()
    if (API.snapshot || API.demo) return
    if (!force) {
      try {
        if (localStorage.getItem(ONBOARD_KEY) === '1') return
      } catch {}
    }
    const g = state.graph
    if (!g || !Array.isArray(g.nodes) || g.nodes.length < 8) return

    const card = el('div', 'onboard')
    card.id = 'onboard'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', T('新手三步'))

    const head = el('div', 'ob-head')
    head.appendChild(el('b', null, T('第一次来？三步就够')))
    const x = el('button', 'ob-x', '×')
    x.type = 'button'
    x.setAttribute('aria-label', T('关闭新手引导'))
    x.onclick = () => dismissOnboard(card)
    head.appendChild(x)
    card.appendChild(head)

    const done = new Set()
    const mark = (n) => {
      done.add(n)
      const row = card.querySelector('[data-ob-step="' + n + '"]')
      if (row) row.classList.add('done')
      if (done.size === 3) {
        toast(T('三步走完了；想重看，按 ? 打开快捷键一览'))
        setTimeout(() => dismissOnboard(card), 600)
      }
    }

    const step = (n, title, hint, action, label) => {
      const row = el('div', 'ob-step')
      row.dataset.obStep = String(n)
      row.appendChild(el('span', 'ob-n', String(n)))
      const copy = el('div', 'ob-copy')
      copy.appendChild(el('b', null, title))
      copy.appendChild(el('span', null, hint))
      row.appendChild(copy)
      const btn = el('button', 'ob-act', label)
      btn.type = 'button'
      btn.onclick = () => {
        action()
        mark(n)
      }
      row.appendChild(btn)
      card.appendChild(row)
    }

    step(
      1,
      T('搜一个你记得的词'),
      T('标题、正文、关键词都算；找不到就换个更短的词。'),
      () => {
        const q = $('#q')
        if (q) {
          q.focus()
          q.select()
        }
        toast(T('输入一个词，比如「记忆」「部署」，回车看命中'))
      },
      T('去搜'),
    )
    step(
      2,
      T('点开一条，看它凭什么'),
      T('右栏是正文和它的邻居：每条连接都写了理由。'),
      () => {
        const hub = [...g.nodes]
          .filter((n) => n.level !== 'source' && n.kind !== 'source')
          .sort((a, b) => (b.degree || 0) - (a.degree || 0))[0]
        if (hub) showDetail(hub.id, { focus: true })
        else toast(T('先搜一条记忆，再点开它'))
      },
      T('看一条'),
    )
    step(
      3,
      T('Shift 点两条，看怎么连上'),
      T('不相关就直说「没连上」，不会硬编一条关系。'),
      () => {
        const edge = [...(g.edges || [])]
          .filter((e) => e.a && e.b && e.a !== e.b && (e.w || 0) >= 0.4)
          .sort((a, b) => (b.w || 0) - (a.w || 0))[0]
        if (edge) showPath(edge.a, edge.b)
        else toast(T('这一片没有够强的连接可演示；先搜一条记忆看看'))
      },
      T('看例子'),
    )

    const foot = el('div', 'ob-foot')
    const skip = el('button', 'ob-skip', T('跳过，直接逛'))
    skip.type = 'button'
    skip.onclick = () => dismissOnboard(card)
    foot.appendChild(skip)
    foot.appendChild(el('span', null, T('随时按 ? 可以重看')))
    card.appendChild(foot)

    // 卡片里的点击不要冒泡到画布/菜单的全局监听，免得点一下就被别处关掉。
    card.addEventListener('click', (ev) => ev.stopPropagation())
    document.body.appendChild(card)
  }

  /** 快捷键帮助浮层（按 ? 开合，点一下也关）。 */
  function toggleKeys() {
    let box = $('#keys')
    if (box) {
      box.remove()
      return
    }
    box = el('div', 'keys')
    box.id = 'keys'
    const rows = [
      ['/', T('搜索记忆')],
      ['Ctrl / ⌘ + K', T('命令面板：切视图、开面板、搜记忆')],
      ['↑ ↓', T('在搜索结果里走位，回车打开')],
      ['1 / 2 / 3', T('星云 / 星系 / 时间')],
      [T('左键拖'), T('星云平移 · 星系转视角')],
      [T('点光斑'), T('钻进那个项目（拉远到点聚成光斑时）')],
      [T('双击空白'), T('回到全图')],
      [T('中键 / 右键拖'), T('平移视角（不会误选节点）')],
      [T('Shift + 点两下'), T('查两个节点之间的证据链')],
      [T('时间视图底部滑杆'), T('回到某一天之前（双击滑杆恢复全部）')],
      [T('顶栏「导出」'), T('当前视图 PNG / 可见子图 JSON')],
      [T('左栏小箭头'), T('收起任一分组，状态会记住')],
      ['f', T('回全视图（双击空白也行）')],
      ['Shift + f', T('清掉所有筛选，回全视图')],
      ['e', T('把选中的那颗拉到面前')],
      ['p / b / l', T('项目卡片 / 四块看板 / 主线')],
      ['r', T('重建星云（重新分析全部记忆）')],
      ['Esc', T('从面板一层层关回去')],
      ['?', T('显示或关闭这张说明')],
    ]
    box.appendChild(el('div', 'keys-t', T('快捷键')))
    for (const [k, v] of rows) {
      const row = el('div', 'keys-row')
      row.appendChild(el('span', 'keys-k', k))
      row.appendChild(el('span', 'keys-v', v))
      box.appendChild(row)
    }
    const re = el('button', 'keys-re', T('重看新手三步'))
    re.type = 'button'
    re.onclick = (ev) => {
      ev.stopPropagation()
      box.remove()
      showOnboard(true)
    }
    box.appendChild(re)
    const diag = el('button', 'keys-diag', T('复制诊断'))
    diag.type = 'button'
    diag.onclick = (ev) => {
      ev.stopPropagation()
      copyDiagnostics()
    }
    box.appendChild(diag)
    const foot = el(
      'div',
      'keys-f',
      T('记忆星图 v') + (state.engineVersion || APP_VERSION) + T(' · 只读 · 数据留在本机')
    )
    box.appendChild(foot)
    box.onclick = () => box.remove()
    document.body.appendChild(box)
  }

  function closeDetail() {
    $('#detail').classList.remove('show')
    document.body.classList.remove('has-detail')
    state.selected = null
    state.detail = null
    if (state.stage) state.stage.select(null)
    applyPadding()
  }

  async function showDetail(id, opts) {
    if (!id) {
      $('#detail').classList.remove('show')
      document.body.classList.remove('has-detail')
      applyPadding()
      state.selected = null
      return
    }
    state.selected = id
    try {
      const d = await API.node(id)
      state.detail = d
      renderDetail(d)
      $('#detail').classList.add('show')
      document.body.classList.add('has-detail')
      applyPadding()
      // 从搜索、看板、详情里的邻居点进来时，把它带到画面中间——
      // 但本来就在视口里就别动镜头，免得点一下画面就跳。
      const st = state.stage
      if (st && !(opts && opts.focus === false)) {
        let onScreen = false
        try {
          const p = st.screenOf && st.screenOf(id)
          if (p) {
            const mx = window.innerWidth * 0.08
            const my = window.innerHeight * 0.08
            onScreen = p.x > mx && p.y > my && p.x < window.innerWidth - mx && p.y < window.innerHeight - my
          }
        } catch {}
        if (!onScreen || (opts && opts.focus)) {
          try {
            st.select(id)
            st.focusNode(id, (opts && opts.zoom) || 1.9)
          } catch {}
        }
      }
    } catch (err) {
      const msg = (err && err.message) || String(err)
      // 记忆被重建掉之后，右侧还挂着它的详情会很怪：这里直接收起来。
      if (/404|not\s*found|不存在|no such/i.test(msg)) {
        toast(T('这条记忆已经不在了'))
        showDetail(null)
      } else {
        toast(T('读取失败：') + msg)
      }
    }
  }

  /** 剪贴板：优先 navigator.clipboard，失败退回 textarea（无权限时也能用）。 */
  async function copyText(text) {
    const t = String(text || '')
    if (!t) return false
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t)
        return true
      }
    } catch (err) {
      softWarn('clipboard', err)
    }
    try {
      const ta = document.createElement('textarea')
      ta.value = t
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch (err) {
      softWarn('clipboard-fallback', err)
      return false
    }
  }

  function renderDetail(d) {
    const n = d.node
    const meta = $('#d-meta')
    meta.innerHTML = ''
    const tag = (text, color) => {
      const t = el('span', 'tag', text)
      if (color) {
        t.style.color = color
        t.style.borderColor = color + '44'
      }
      return t
    }
    meta.appendChild(tag(LEVEL_LABEL[n.level] || n.level, LEVEL_COLOR[n.level]))
    meta.appendChild(tag(n.ws))
    // 这条记忆是谁给的：接多个记忆插件之后，详情里必须能一眼看出来源。
    if (n.provider && n.provider !== 'meow-memory') meta.appendChild(tag(T('来源 · ') + providerLabel(n.provider), providerColor(n.provider)))
    if (n.project) meta.appendChild(tag(n.project))
    if (n.status && n.status !== 'active') meta.appendChild(tag(n.status, '#ff9f7a'))
    meta.appendChild(tag(T('连接 ') + (d.degree || 0)))
    if (n.hits) meta.appendChild(tag(T('命中 ') + n.hits))

    // 想把一条记忆带到别处（issue、聊天、笔记）时，最缺的就是它的 id
    const copyId = el('button', 'tag tag-btn', T('复制 id'))
    copyId.title = T('复制这条记忆的完整 id')
    copyId.onclick = async (ev) => {
      ev.stopPropagation()
      toast((await copyText(n.id)) ? T('已复制记忆 id') : T('复制失败'))
    }
    meta.appendChild(copyId)
    const sid = (d.origin && d.origin.sessionId) || n.sessionId
    if (sid) {
      const copySid = el('button', 'tag tag-btn', T('复制会话'))
      copySid.title = T('复制来源会话 id：') + String(sid)
      copySid.onclick = async (ev) => {
        ev.stopPropagation()
        toast((await copyText(sid)) ? T('已复制会话 id') : T('复制失败'))
      }
      meta.appendChild(copySid)
    }

    $('#d-title').textContent = n.title || n.label || T('(无标题)')

    // 体检结论直接贴在详情顶部：这样看到一条记忆就知道它有没有「该更新 / 重复」的毛病
    const hy = state.hygiene
    const dbody = $('#d-body')
    const staleNote = document.getElementById('d-hygiene')
    if (staleNote) staleNote.remove()
    if (hy && hy.items) {
      const staleIt = (hy.items.stale || []).find((x) => x.id === n.id)
      const dupIt = (hy.items.dup || []).find((x) => x.a.id === n.id || x.b.id === n.id)
      const overIt = (hy.items.oversize || []).find((x) => x.id === n.id)
      const thinIt = (hy.items.thin || []).find((x) => x.id === n.id)
      const notes = []
      if (staleIt) notes.push(T('还挂着 active，但「') + (staleIt.by.label || '').slice(0, 24) + T('」更新更全——这条可能该并进去'))
      if (dupIt) {
        const other = dupIt.a.id === n.id ? dupIt.b : dupIt.a
        notes.push(T('与「') + (other.label || '').slice(0, 24) + T('」高度重复（相似 ') + dupIt.sim + '）')
      }
      if (overIt) notes.push(T('正文 ') + overIt.size + T(' 字，属于本库最长的一批，读一次很贵'))
      if (thinIt) notes.push(T('连接 ') + thinIt.degree + T(' 条但平均强度只有 ') + thinIt.avg + T('，多半是关键词撞出来的'))
      if (notes.length) {
        const box = el('div', 'd-hygiene')
        box.id = 'd-hygiene'
        for (const t of notes) box.appendChild(el('div', 'd-hy-line', '· ' + t))
        dbody.parentNode.insertBefore(box, dbody)
      }
    }

    const imps = $('#d-imps')
    imps.innerHTML = ''
    for (let i = 1; i <= 4; i++) {
      const bar = document.createElement('i')
      if (i <= (n.importance || 0)) bar.className = 'on'
      imps.appendChild(bar)
    }

    const body = $('#d-body')
    body.innerHTML = ''

    // 重要度建议：只提示，不动别人的库
    if (n.suggest && n.suggest.to !== n.suggest.from) {
      const s = el('div', 'd-origin-meta', T('重要度建议 ') + n.suggest.from + ' → ' + n.suggest.to + '（' + localizeWhy(n.suggest.why || '') + '）')
      s.style.marginBottom = '6px'
      body.appendChild(s)
    }

    // 写入时就算过的证据（sidecar 缓存，第一次建图时落盘）
    if (n.evidence && n.evidence.edges && n.evidence.edges.length) {
      body.appendChild(el('div', 'd-sect-title', T('落库时算出的证据')))
      for (const e of n.evidence.edges) {
        const row = el('div', 'd-origin-meta', '· ' + (TYPE_LABEL[e.type] || e.type) + ' ' + e.w + ' · ' + localizeWhy(e.why || ''))
        row.style.cursor = 'pointer'
        row.onclick = () => e.id && showDetail(e.id)
        body.appendChild(row)
      }
    }
    // 出处：这条记忆是在主人在会话里说的哪句话之后写下的（来自会话转写）
    if (n.origin && n.origin.text) {
      const sect = el('div', 'd-sect-title', T('写这条记忆时，主人说的是'))
      body.appendChild(sect)
      const quote = el('div', 'd-origin')
      quote.textContent = n.origin.text
      const meta2 = el('div', 'd-origin-meta')
      const gap = Math.max(0, Math.round((n.origin.gapMs || 0) / 1000))
      const when =
        gap < 90 ? gap + T(' 秒后写下') : gap < 5400 ? Math.round(gap / 60) + T(' 分钟后写下') : Math.round(gap / 3600) + T(' 小时后写下')
      meta2.textContent =
        T('出自会话 ') + String(n.origin.sessionId || '').replace(/^session-/, '').slice(0, 8) + T(' · 说过这话') + when
      quote.appendChild(meta2)
      body.appendChild(quote)
    }

    const content = el('div', 'd-content')
    content.innerHTML = highlight(n.content || '', n.keywords || [])
    body.appendChild(content)

    if (n.goal) {
      body.appendChild(el('div', 'd-sect-title', T('目标')))
      const g = el('div', 'd-content')
      g.textContent = n.goal
      body.appendChild(g)
    }

    if ((n.keywords || []).length) {
      const kw = el('div', 'd-kw')
      for (const k of n.keywords) kw.appendChild(el('span', null, k))
      body.appendChild(kw)
    }

    if ((n.mentions || []).length) {
      body.appendChild(el('div', 'd-sect-title', T('这条记忆提到的来源')))
      const box = el('div', 'd-kw')
      for (const m of n.mentions) {
        const chip = el('span', null, (m.kind === 'skill' ? '◆ ' : m.kind === 'mcp' ? '▣ ' : '◈ ') + m.name)
        chip.style.color = m.kind === 'skill' ? '#8fd8ff' : m.kind === 'mcp' ? '#ffd88a' : '#9fe8c8'
        if (m.description) chip.title = m.description
        box.appendChild(chip)
      }
      body.appendChild(box)
    }

    // 来源节点（技能 / MCP / 插件）：反过来看「谁提到过它」，以及被哪些项目在用
    if (n.level === 'source' && n.mentionedBy) {
      const mb = n.mentionedBy
      body.appendChild(
        el('div', 'd-sect-title', T('谁提到过它 · ') + mb.total + T(' 条记忆') + (mb.byWorkspace.length ? T(' / 分布在 ') + mb.byWorkspace.length + T(' 个项目') : '')),
      )
      if (mb.usage && mb.usage.calls > 0) {
        const use = el('div', 'd-origin-meta', T('会话里实际调用过 ') + mb.usage.calls + T(' 次 · 分布在 ') + mb.usage.sessions + T(' 个会话'))
        use.style.marginBottom = '8px'
        body.appendChild(use)
      } else if (mb.usage) {
        const use = el('div', 'd-origin-meta', T('会话里没有直接调用过它（可能只是被记忆提到，或由别的入口自动挂载）'))
        use.style.marginBottom = '8px'
        body.appendChild(use)
      }
      if (mb.byWorkspace.length) {
        const box = el('div', 'd-kw')
        for (const w of mb.byWorkspace) {
          const chip = el('span', null, w.ws + ' × ' + w.n)
          box.appendChild(chip)
        }
        body.appendChild(box)
      }
      for (const t of mb.top) {
        const row = el('div', 'nbr')
        const dot = el('i', 'dot')
        dot.style.background = LEVEL_COLOR[t.level] || '#8fb8d8'
        dot.style.boxShadow = `0 0 6px ${LEVEL_COLOR[t.level] || '#8fb8d8'}`
        const b = el('div', 'nb')
        b.appendChild(el('div', 'nt', t.label || t.id))
        b.appendChild(el('div', 'nw', T('重要度 ') + (t.importance || 0) + ' · ' + (t.ws || '')))
        row.appendChild(dot)
        row.appendChild(b)
        row.onclick = () => showDetail(t.id)
        row.style.cursor = 'pointer'
        body.appendChild(row)
      }
    }

    // 同一次会话里还写下哪些记忆：一条上下文脉络，比孤立看一条更好判断它当时在讲什么
    if (n.peers && n.peers.items && n.peers.items.length) {
      body.appendChild(el('div', 'd-sect-title', T('同一次会话里还写下 ') + n.peers.total + T(' 条')))
      for (const p of n.peers.items) {
        const row = el('div', 'nbr')
        const dot = el('i', 'dot')
        dot.style.background = LEVEL_COLOR[p.level] || '#8fb8d8'
        dot.style.boxShadow = `0 0 6px ${LEVEL_COLOR[p.level] || '#8fb8d8'}`
        const b = el('div', 'nb')
        b.appendChild(el('div', 'nt', p.label || p.id))
        b.appendChild(el('div', 'nw', T('重要度 ') + (p.importance || 0) + ' · ' + (p.ws || '')))
        row.appendChild(dot)
        row.appendChild(b)
        row.onclick = () => showDetail(p.id)
        row.style.cursor = 'pointer'
        body.appendChild(row)
      }
    }

    const nbrTitle = el('div', 'd-sect-title')
    nbrTitle.appendChild(el('span', null, T('连接到的记忆 · ') + (d.neighbors || []).length))
    body.appendChild(nbrTitle)
    for (const nb of (d.neighbors || []).slice(0, 60)) {
      const row = el('div', 'nbr')
      const dot = el('i', 'dot')
      dot.style.background = LEVEL_COLOR[nb.level] || '#8fb8d8'
      dot.style.boxShadow = `0 0 6px ${LEVEL_COLOR[nb.level] || '#8fb8d8'}`
      const b = el('div', 'nb')
      b.appendChild(el('div', 'nt', nb.label || nb.title || nb.id))
      const reason = (TYPE_LABEL[nb.type] || nb.type) + (nb.why ? ' · ' + localizeWhy(nb.why) : '')
      b.appendChild(el('div', 'nw', reason))
      const bar = el('div', 'bar')
      const fill = document.createElement('i')
      fill.style.width = Math.round((nb.w || 0) * 100) + '%'
      fill.style.background = TYPE_COLOR[nb.type] || '#8fb8d8'
      bar.appendChild(fill)
      b.appendChild(bar)
      row.appendChild(dot)
      row.appendChild(b)
      // 「这条关联算错了」：人工策展边直接断；自动推断的边记进屏蔽表，重建也不再连
      const kill = el('button', 'mini kill', '×')
      kill.title = nb.type === 'explicit' ? T('断开这条人工连边') : T('屏蔽这条关联（以后重建也不会再连）')
      kill.onclick = async (ev) => {
        ev.stopPropagation()
        try {
          if (nb.type === 'explicit') await API.unlink(n.id, nb.id)
          else await API.mute(n.id, nb.id, '界面人工屏蔽')
          const back = async () => {
            if (nb.type === 'explicit') await API.link(n.id, nb.id)
            else await API.unmute(n.id, nb.id)
            await reload(false)
            renderSources()
            showDetail(n.id)
            toast(T('已撤销'))
          }
          toast(nb.type === 'explicit' ? T('已断开这条连边') : T('已屏蔽这条关联'), { label: T('撤销'), run: back })
          await reload(false)
          renderSources()
          showDetail(n.id)
        } catch (e) {
          // 后台是旧版宿主（没 /mute）时退一步：先把这条边断开，至少图是干净的
          if (nb.type !== 'explicit') {
            try {
              await API.unlink(n.id, nb.id)
              toast(T('当前引擎较旧，已改为断开这条边（重连后可用屏蔽）'))
              await reload(false)
              renderSources()
              showDetail(n.id)
              return
            } catch {}
          }
          toast(T('操作失败：') + e.message)
        }
      }
      // 快照与示例都是只读的：不摆一个点了必然失败的「屏蔽」按钮。
      if (!API.snapshot && !API.demo) row.appendChild(kill)
      row.onclick = () => {
        state.stage.select(nb.id)
        state.stage.focusNode(nb.id, 2.1)
        showDetail(nb.id)
      }
      row.title = T('点击查看：') + (nb.label || nb.id)
      body.appendChild(row)
    }

    const acts = el('div', 'acts')
    const btnSpread = el('button', 'btn', T('以它为种子扩散'))
    btnSpread.title = T('不是搜索：从这条出发，沿已有连接看 2 跳内的邻居')
    btnSpread.onclick = () => spread(n.id)
    const btnCopy = el('button', 'btn ghost', T('复制 id'))
    btnCopy.onclick = () => {
      navigator.clipboard.writeText(n.uid || n.id).then(() => toast(T('已复制 ') + (n.uid || n.id)))
    }
    const btnFocus = el('button', 'btn ghost', T('定位'))
    btnFocus.onclick = () => state.stage.focusNode(n.id, 2.4)
    acts.appendChild(btnSpread)
    acts.appendChild(btnFocus)
    acts.appendChild(btnCopy)
    body.appendChild(acts)
    body.appendChild(el('div', 'seed-note', T('扩散不是搜索：从这条出发，沿已有连接看 2 跳内的邻居。')))
  }

  function highlight(text, keywords) {
    const html = esc(text)
    // 一遍扫完：先插 <mark> 再拿后续关键词去 replace，会把标签本身也标亮，
    // 关键词含 mark 时还会生成嵌套标签，所以合成一个 alternation 一次替换。
    const words = [...new Set((keywords || []).filter((k) => k && k.length >= 2 && k.length <= 24))]
      .filter((k) => !/^(amp|lt|gt|quot|#39)$/i.test(k))
      .slice(0, 40)
      .sort((a, b) => b.length - a.length)
    if (words.length === 0) return html
    const pattern = words.map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    if (!pattern) return html
    return html.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>')
  }

  async function spread(id) {
    try {
      const res = await API.recall('', { seed: id, limit: 10 })
      const hits = res.hits || []
      if (!hits.length) return toast(T('它没有可以扩散出去的连接'))
      state.stage.highlight(id, true)
      state.stage.pulseFrom([id, ...hits.map((h) => h.id)], true)
      toast(T('激活 ') + hits.length + T(' 条相邻记忆'))
    } catch (err) {
      toast(T('扩散失败：') + err.message)
    }
  }

  // ---------------- 悬停提示 ----------------
  function onHover(hit) {
    let tip = $('#tip')
    if (!tip) {
      tip = el('div')
      tip.id = 'tip'
      document.body.appendChild(tip)
    }
    if (!hit || !state.graph) {
      tip.classList.remove('show')
      return
    }
    const n = state.graph.nodes.find((x) => x.id === hit.id)
    if (!n) {
      tip.classList.remove('show')
      return
    }
    const isSrc = n.level === 'source'
    const tipTitle = String(n.title || n.label || n.id)
    tip.innerHTML =
      '<div class="tip-title">' + esc(tipTitle.length > 30 ? tipTitle.slice(0, 30) + '…' : tipTitle) + '</div>' +
      '<div class="tip-meta">' +
      (isSrc
        ? esc(n.project || T('来源')) + T(' · 用过它的记忆 ') + (n.degree || 0) + T(' 条')
        : esc(n.ws) + ' · ' + (LEVEL_LABEL[n.level] || n.level) + T(' · 重要度 ') + (n.importance || 1) + ' · ' + (n.degree || 0) + T(' 条连接')) +
      '</div>'
    const w = 300
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 16, hit.x + 18)) + 'px'
    tip.style.top = Math.max(8, hit.y - 14) + 'px'
    tip.classList.add('show')
  }

  function bindHover() {
    onHover(null)
  }

  $('#btn-lang')?.addEventListener('click', () => window.NebulaI18n?.toggle())

  // ---------------- 启动 ----------------
  /** 让星图避开左侧筛选面板与顶栏（窗口变了要重算）。 */
  function applyPadding() {
    if (!state.stage) return
    const f = $('#filters')
    const rect = f ? f.getBoundingClientRect() : null
    const shown = rect && rect.width > 0 && f.offsetParent !== null
    const d = $('#detail')
    const dOpen = d && d.classList.contains('show')
    const pad = {
      left: shown ? Math.round(rect.width) + 26 : 16,
      right: dOpen ? Math.round(d.getBoundingClientRect().width) + 22 : 16,
      top: 76,
      bottom: 48,
    }
    if (state.stage2d) state.stage2d.setPadding(pad)
    if (state.space3d) state.space3d.setPadding(pad)
  }

  // 三档透镜：星云(2D) / 星系(3D 力导向) / 时间(3D 螺旋)
  function activeRenderer() {
    if (state.modeKey !== 'nebula' && state.space3d) return state.space3d
    return state.stage2d
  }

  function use3d() {
    return state.modeKey !== 'nebula' && !!state.space3d
  }

  /* ── 时间回放：把「时间」从只能看，变成能拖着看 ──────────────────
     只在螺旋视图出现。滑到最右＝全部，往左滑就是「当时那一刻已经有多少记忆」。
     闸门加在 space3d.visible() 里，所以连线也跟着同一时刻一起收。 */
  function timeBounds() {
    let min = 0
    let max = 0
    for (const n of (state.graph && state.graph.nodes) || []) {
      const t = Number(n.createdAt) || 0
      if (!t) continue
      if (!min || t < min) min = t
      if (t > max) max = t
    }
    if (!min || max <= min) return null
    return { min, max }
  }

  function syncTimeCut() {
    const bar = $('#timebar')
    const range = $('#time-range')
    const val = $('#time-val')
    if (!bar || !range || !val) return
    const b = timeBounds()
    if (!b || !state.space3d) {
      bar.hidden = true
      return
    }
    const v = Number(range.value) || 0
    const cut = v >= 1000 ? 0 : b.min + ((b.max - b.min) * v) / 1000
    state.space3d.setTimeCut(cut)
    const nodes = (state.graph && state.graph.nodes) || []
    if (!cut) {
      val.textContent = T('全部 ') + nodes.length + T(' 条')
      return
    }
    let shown = 0
    for (const n of nodes) {
      const t = Number(n.createdAt) || 0
      if (!t || t <= cut) shown++
    }
    const d = new Date(cut)
    const day = d.getMonth() + 1 + '-' + String(d.getDate()).padStart(2, '0')
    val.textContent = '≤ ' + day + ' · ' + shown + T(' 条')
  }

  /** 当前时间闸门（毫秒）；不在螺旋视图或滑到最右时为 0。 */
  function timeCutNow() {
    if (state.modeKey !== 'spiral' || !state.space3d) return 0
    const b = timeBounds()
    const r = $('#time-range')
    if (!b || !r) return 0
    const v = Number(r.value) || 0
    return v >= 1000 ? 0 : b.min + ((b.max - b.min) * v) / 1000
  }

  function showTimebar(on) {
    const bar = $('#timebar')
    if (!bar) return
    if (!on) {
      bar.hidden = true
      if (state.space3d && state.space3d.setTimeCut) state.space3d.setTimeCut(0)
      const r = $('#time-range')
      if (r) r.value = '1000'
      return
    }
    bar.hidden = false
    syncTimeCut()
  }

  function applyMode(nextKey) {
    let key = nextKey
    if (key !== 'nebula' && state.graph && (state.graph.nodes || []).length > 3000) {
      toast(T('超过三千条先在二维星云里看：三维在软件渲染下会卡，筛选到 3000 条以内再切'))
      key = 'nebula'
    } else if (key !== 'nebula' && !state.space3d) {
      toast(T('三维模块还没加载好（独立引擎没开？），先看星云视图'))
      key = 'nebula'
    }
    const prevKey = state.modeKey
    state.modeKey = key
    const three = key !== 'nebula'
    const c2 = $('#sky')
    const c3 = $('#sky3d')
    const l3 = $('#sky3dlbl')
    c2.style.display = three ? 'none' : ''
    if (c3) c3.hidden = !three
    if (l3) l3.hidden = !three
    document.body.classList.toggle('mode-space', three)

    if (three) {
      state.space3d.setActive(true)
      const sig = state.graph && state.graph.sig
      if (state.graph && (!state.space3dSig || state.space3dSig !== sig)) {
        state.space3d.load(state.graph, true)
        state.space3dSig = sig
      }
      state.space3d.setLayout(key === 'spiral' ? 'spiral' : 'cluster')
      state.space3d.setFilter({
        ws: state.filter.ws,
        levels: state.filter.levels,
        types: state.filter.types,
        minW: state.filter.minW,
        minImp: state.filter.minImp,
      })
      state.space3d.setSpin(key === 'spiral' && !reduceMotion())
      state.space3d.fit()
      showTimebar(key === 'spiral')
    } else {
      if (state.space3d) state.space3d.setActive(false)
      // 在 3D 里改过窗口大小的话，2D 画布的后备缓冲还是隐藏时的 1×1：先补量一次。
      if (typeof state.stage2d.resize === 'function') state.stage2d.resize()
      state.stage2d.setMode('nebula')
      // 从 3D 切回来时把同一份筛选重新交给 2D：
      // 两个渲染器各有自己的 hidden 标记，不重放就会「3D 筛过、2D 全亮」。
      state.stage2d.setFilter({
        ws: state.filter.ws,
        levels: state.filter.levels,
        types: state.filter.types,
        minW: state.filter.minW,
        minImp: state.filter.minImp,
      })
      state.stage2d.fit()
      showTimebar(false)
    }
    applyPadding()
    if (prevKey !== key) applyModeLabel()
    try {
      localStorage.setItem('nebula.mode', key)
    } catch {}
  }

  /** 三维脚本是异步加载的（宿主没它时会走独立引擎），等一会儿再建。 */
  async function waitSpace(timeout) {
    const t0 = Date.now()
    while (!window.NebulaSpace && Date.now() - t0 < (timeout || 4000)) {
      await new Promise((r) => setTimeout(r, 60))
    }
    return !!window.NebulaSpace
  }

  // 区块加载的可视化：星云是长出来的，遮罩上就给出「长到哪一步了」
  function watchGrowth() {
    const boot = $('#boot')
    if (!boot) return
    const t0 = performance.now()
    const tick = () => {
      const fn = state.stage && state.stage.progress
      const pr = typeof fn === 'function' ? state.stage.progress() : null
      if (!pr) {
        boot.style.display = 'none'
        return
      }
      const pct = pr.total ? Math.round((pr.shown / pr.total) * 100) : 100
      boot.innerHTML =
        '<div class="boot-line">' + T('正在生长记忆星云…') + '</div>' +
        '<div class="boot-bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="boot-num">' + pr.shown + ' / ' + pr.total + T(' 条记忆 · ') + pct + '%</div>'
      if (pr.done || performance.now() - t0 > 20000) {
        boot.style.display = 'none'
        if (window.__nebulaBoot) window.__nebulaBoot.doneMs = Math.round(performance.now() - window.__nebulaBoot.t0)
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  /** 「记忆来源」那块也能收起：小屏时把它叠起来，图就露出来了。 */
  function bindSourcesFold() {
    const panel = $('#sources')
    const title = panel && panel.querySelector('.f-title')
    if (!panel || !title || title.dataset.foldBound) return
    title.dataset.foldBound = '1'
    const right = el('span', 'h4-r')
    const tag = $('#src-tag')
    if (tag) right.appendChild(tag)
    right.appendChild(attachFold(panel, 'f:sources'))
    title.appendChild(right)
  }

  async function boot() {
    const canvas = $('#sky')
    state.stage2d = window.Nebula.stage(canvas, {})
    if (window.__NEBULA_DEBUG__) window.__NEBULA_STAGE2D__ = state.stage2d
    state.space3d = (await waitSpace()) ? window.NebulaSpace.create($('#sky3d'), $('#sky3dlbl')) : null
    state.modeKey = 'nebula'
    // 门面：所有 state.stage.xxx 调用都落到当前视图上
    state.stage = new Proxy(
      {},
      {
        get(_t, key) {
          const r = activeRenderer()
          const v = r[key]
          return typeof v === 'function' ? v.bind(r) : v
        },
      }
    )
    for (const r of [state.stage2d, state.space3d].filter(Boolean)) {
      r.on('select', (id) => showDetail(id))
      r.on('hover', (hit) => onHover(hit))
      // 点 LOD 光斑＝钻进那个项目。镜头会飞过去，但得说一声，别让人以为「怎么突然变了」
      r.on('lod', (ws) => {
        const c = ((state.graph && state.graph.clusters) || []).find((x) => x.id === ws)
        toast(T('已放大「') + ((c && c.title) || ws) + T('」 · 双击空白回到全图'))
      })
    if (typeof r.on === 'function') r.on('path', (req) => showPath(req && req.from, req && req.to))
    // 调试/自动化入口：等价于「Shift + 点两下」，也方便在控制台直接查
    window.__nebulaShowPath = showPath
    }
    bindHover()
    applyPadding()
    window.addEventListener('resize', () => {
      applyPadding()
      if (use3d() && state.space3d) state.space3d.resize()
    })
    /**
     * 引擎体检：页面能打开不代表宿主里的代码是新的。DSH 只在启动时装配插件，
     * 换了代码没重启时，页面的基础视图还活着，但 /sources /bridge /ledger /ingest
     * 这些新接口会 404——对用户就是「功能忽然消失了」，必须自己说出来。
     */
    const ENGINE_CAPS = ['sources', 'bridge', 'ledger', 'ingest']
    function checkEngine(meta) {
      if (!meta) return
      state.engineBuild = meta.build
      state.engineVersion = meta.version || ''
      const bar = $('#skewbar')
      if (!bar) return
      const caps = Array.isArray(meta.capabilities) ? meta.capabilities : null
      const missing = ENGINE_CAPS.filter((c) => !caps || !caps.includes(c))
      if (!missing.length) {
        bar.hidden = true
        // 只有页面本身不是独立引擎、却切到了 7890 这条腿时才值得说一声；
        // 从 /app 直接打开时 base 就是同源，不需要提示。
        if (meta.mode === 'standalone' && API.base !== '/api/memory-nebula') {
          const tag = 'standalone:' + (meta.version || '') + ':' + (meta.build || '')
          let seen = ''
          try {
            seen = sessionStorage.getItem('nebula.engine') || ''
          } catch {}
          if (seen !== tag) {
            try {
              sessionStorage.setItem('nebula.engine', tag)
            } catch {}
            toast(T('已切到独立引擎 ') + (meta.version ? 'v' + meta.version : '') + T('（宿主里的旧引擎没被使用）'))
          }
        }
        return
      }
      // 同一个构建只劝一次；重启后 build 变了会重新提示
      let dismissed = ''
      try {
        dismissed = sessionStorage.getItem('nebula.skew') || ''
      } catch {}
      if (dismissed === String(meta.build)) {
        bar.hidden = true
        return
      }
      const text = $('#skew-text')
      if (text) {
        const ver = meta.version ? 'v' + esc(meta.version) : T('旧版')
        text.innerHTML =
          '<b>' + T('宿主里跑的是 ') + ver + T(' 引擎') + '</b>' + T('，缺 ') +
          missing.map((c) => '<code>' + esc(c) + '</code>').join(' ') +
          T(' 接口。重启 DSH 后刷新即可；不想重启就在插件目录运行 ') +
          '<code>powershell -ExecutionPolicy Bypass -File sidecar.ps1 start</code>' +
          T('，再刷新本页就会自动切到独立引擎。')
      }
      bar.hidden = false
    }

    // 数据侧：探测接口 → 取图 → 交给渲染层 → 开轮询。
    // 失败重试走的是同一个函数，不另写一条路径（形状/统计/时间轴才不会分叉）。
    const skewClose = $('#skew-close')
    if (skewClose) {
      skewClose.onclick = () => {
        const bar = $('#skewbar')
        if (bar) bar.hidden = true
        try {
          sessionStorage.setItem('nebula.skew', String((API.meta && API.meta.build) || ''))
        } catch {}
      }
    }
    async function pullGraph() {
      // 离线快照没有后端：resolveBase 会直接返回（顺便把 META 填成快照自己的元信息），
      // 也不该去检查宿主的构建版本。
      await API.resolveBase()
      if (!API.snapshot && !API.demo) checkEngine(API.meta)
      // P0 计时：网络 / 建图 / 首帧 —— 没有基线就不许说"提速了"
      window.__nebulaBoot = { t0: performance.now() }
      const graph = await API.graph()
      window.__nebulaBoot.graphMs = Math.round(performance.now() - window.__nebulaBoot.t0)
      window.__nebulaBoot.nodes = graph.nodes.length
      window.__nebulaBoot.v = graph.v || 1
      applyGraph(graph, { keepView: false, filters: true })
      window.__nebulaBoot.firstDrawMs = Math.round(performance.now() - window.__nebulaBoot.t0)
      bindSourcesFold()
      renderSources()
      // 区块加载：星云还在长的时候别急着把遮罩撤掉
      watchGrowth()
      // 上次看的是哪一档就看哪一档
      try {
        const saved = localStorage.getItem('nebula.mode')
        if (saved && saved !== 'nebula' && state.space3d) applyMode(saved)
      } catch {}
      if (!graph.nodes.length) showEmptyHint()
      renderModeBar()
      // 示例与快照都是死的：没有「别的会话刚写了新记忆」这回事，别每 12 秒去敲一次门
      if (API.snapshot || API.demo) stopPolling()
      else startPolling()
      const boot = $('#boot')
      if (boot) {
        boot.classList.remove('err')
        boot.hidden = true
      }
    }

    /** 空库不是一句「这里还没有星星」：给三条能走的路，第一条直接能点。 */
    function showEmptyHint() {
      const hint = $('#hint')
      if (!hint) return
      hint.innerHTML = ''
      hint.classList.add('show', 'empty')
      hint.dataset.empty = '1'
      const card = el('div', 'hcard')
      card.appendChild(el('b', null, T('还没有星星')))
      card.appendChild(el('div', 'hsub', T('这里会显示你的记忆库。挑一条路开始：')))
      const opt = (n, text) => {
        const row = el('div', 'hopt')
        row.appendChild(el('span', 'hn', n))
        row.appendChild(el('span', null, text))
        card.appendChild(row)
      }
      opt('1', T('已经在用 meow-memory / OpenViking：先去对话里写几条记忆，再点「重建星图」。'))
      opt('2', T('想先看看长什么样：进示例星系，逛完随时退出来，不会动你的库。'))
      opt('3', T('想接自己的数据：看 docs/adapters.md，把记忆库指过来。'))
      const act = el('div', 'hact')
      let demoBtn = null
      if (!API.snapshot) {
        demoBtn = el('button', 'hbtn', T('看示例'))
        demoBtn.type = 'button'
        demoBtn.onclick = () => enterDemo()
        act.appendChild(demoBtn)
      }
      const retryBtn = el('button', 'hbtn ghost', T('重建星图'))
      retryBtn.type = 'button'
      retryBtn.onclick = () => $('#btn-refresh')?.click()
      act.appendChild(retryBtn)
      card.appendChild(act)
      hint.appendChild(card)
    }

    /** 顶部那条「示例 / 快照」的状态条。 */
    function renderModeBar() {
      const bar = $('#demobar')
      const text = $('#demo-text')
      const exit = $('#demo-exit')
      if (!bar || !text || !exit) return
      if (API.snapshot) {
        bar.hidden = false
        exit.hidden = true
        const when = API.meta && API.meta.builtAt ? new Date(API.meta.builtAt).toLocaleString(document.documentElement.lang === 'en' ? 'en-US' : 'zh-CN') : ''
        const snap = window.__NEBULA_SNAPSHOT__
        const scope = snap && snap.scope
        const where = scope && scope.kind !== 'all' && scope.label ? ' · ' + esc(scope.label) : ''
        text.innerHTML =
          '<b>' + T('离线快照') + '</b>' +
          where +
          T(' · 只读') +
          (when ? T(' · 生成于 ') + esc(when) : '') +
          T(' · 搜索与证据链都在本地算')
        return
      }
      if (API.demo) {
        bar.hidden = false
        exit.hidden = false
        const n = state.graph && state.graph.nodes ? state.graph.nodes.length : 0
        text.innerHTML = '<b>' + T('示例星系') + '</b> · ' + n + T(' 条虚构记忆 · 只读 · 你的记忆库没有被碰过')
        return
      }
      bar.hidden = true
    }

    async function enterDemo() {
      if (API.snapshot) return
      API.setDemo(true)
      const hint = $('#hint')
      if (hint) {
        hint.classList.remove('show', 'empty')
        delete hint.dataset.empty
      }
      try {
        await pullGraph()
        showOnboard()
        toast(T('示例星系：随便点，右栏的点线都是真的算出来的'))
      } catch (err) {
        API.setDemo(false)
        showBootError(err)
      }
    }

    /**
     * 失败态。以前这里直接把 `Failed to fetch` 和一大坨 debugState 糊在中间，
     * 用户既不知道发生了什么、也没有任何可点的东西。现在：说人话 + 给一个重试按钮，
     * 诊断信息折进 details（要报 bug 时再展开）。
     */
    function showBootError(err) {
      const boot = $('#boot')
      if (!boot) return
      const msg = String((err && err.message) || err || '')
      state.lastError = msg.slice(0, 300)
      const slow = /超时/.test(msg)
      const net = slow || /fetch|network|load failed|timeout|econn/i.test(msg)
      const denied = /40[13]/.test(msg)
      const title = denied ? T('这个视图需要从 DSH 里打开') : net ? T('连不上记忆库') : T('加载记忆库时出错')
      const why = denied
        ? T('直接打开这个地址会被挡在门外。回 DSH 的对话窗口，从侧栏或命令里打开记忆星图即可。')
        : net
          ? slow
            ? T('等了 12 秒还没有回包：宿主可能正忙，或者独立引擎半死。稍等一下再点重试。')
            : '<b>' + T('接口') + '</b> <b>/api/memory-nebula</b>' + T('没有回应。多半是 DSH 正在重启，或者独立引擎还没起来——等两秒再点重试。')
          : T('取图这一步失败了。技术细节在下面，重试一次通常就好。')
      let dbg = ''
      try {
        const d = state.stage2d && state.stage2d.debugState ? state.stage2d.debugState() : null
        if (d) dbg = JSON.stringify(d.row || d, null, 0)
      } catch {}
      boot.hidden = false
      boot.classList.add('err')
      // 换行字符用常量拼，避免字符串里真的断行
      const NL = String.fromCharCode(10)
      const stackLines = err && err.stack ? String(err.stack).split(NL).slice(1, 4).join(NL) : ''
      const detailText = (m, stackPart, d) => [m, stackPart, d].filter(Boolean).join(NL)
      boot.innerHTML =
        '<div class="bt">' + esc(title) + '</div>' +
        '<div class="bs">' + why + '</div>' +
        '<div class="brow">' +
        '<button class="bretry" type="button">' + T('重试') + '</button>' +
        (dbg ? '<button class="bdiag" type="button">' + T('复制诊断') + '</button>' : '') +
        '</div>' +
        '<details><summary>' + T('技术细节') + '</summary><pre>' +
        esc(detailText(msg, stackLines, dbg)) +
        '</pre></details>'
      const retry = boot.querySelector('.bretry')
      if (retry) {
        retry.onclick = async () => {
          retry.disabled = true
          retry.textContent = T('重试中…')
          try {
            await pullGraph()
          } catch (e2) {
            showBootError(e2)
          }
        }
      }
      const diag = boot.querySelector('.bdiag')
      if (diag) {
        diag.onclick = () => {
          copyText([msg, dbg].filter(Boolean).join(NL))
          toast(T('诊断信息已复制'))
        }
      }
    }

    // 退出示例必须回到真实库：这个 handler 得放在 boot 里，
    // pullGraph / showBootError 都是 boot 的局部函数（放外面会 ReferenceError，真踩过）。
    const demoExitBtn = $('#demo-exit')
    if (demoExitBtn) {
      demoExitBtn.onclick = async () => {
        demoExitBtn.disabled = true
        API.setDemo(false)
        try {
          await pullGraph()
          showOnboard()
          toast(T('回到你自己的记忆库'))
        } catch (err) {
          showBootError(err)
        } finally {
          demoExitBtn.disabled = false
        }
      }
    }

    // 搜索空态里的「看看示例」走事件，不把 boot 内部函数挂到模块作用域。
    window.addEventListener('nebula:enter-demo', () => {
      if (!API.snapshot && !API.demo) enterDemo()
    })

    try {
      // ?demo=1 直达示例星系：方便把示例链接发出去，也方便自动化验证。
      // 快照里没有后端，忽略这个参数。
      if (!API.snapshot && new URLSearchParams(location.search).get('demo') === '1') API.setDemo(true)
      await pullGraph()
      showOnboard()
    } catch (err) {
      console.error('[nebula] boot failed', err)
      showBootError(err)
    }
  }

  // 轮询：别的会话写入记忆后，星云自动长出新星星
  let pollTimer = 0
  function stopPolling() {
    clearInterval(pollTimer)
    pollTimer = 0
  }
  function startPolling() {
    clearInterval(pollTimer)
    // 示例星系是内存里的死数据、离线快照连后端都没有：都不需要「有没有新记忆」的轮询。
    if (API.snapshot || API.demo) return
    const tick = async () => {
      // 标签页在后台时没必要每 12 秒打一次 /ping（也不会有人看更新提示）
      if (document.hidden) return
      try {
        const ping = await fetch(API.base + '/ping', { headers: { accept: 'application/json' } }).then((r) => r.json())
        if (state.offline) setOffline(false)
        if (ping && ping.build !== state.engineBuild) checkEngine(ping)
        if (!state.graph || ping.sig !== state.graph.sig) {
          const before = state.graph ? state.graph.nodes.length : 0
          // 数据变了，左栏的计数/新工作区也要跟着变；buildFilters 会读 state.filter 并保留筛选
          const graph = applyGraph(await API.graph(), { keepView: true, filters: true })
          const diff = graph.nodes.length - before
          toast(T('星云已更新') + (diff ? '：' + (diff > 0 ? '+' : '') + diff + T(' 条记忆') : ''))
          if (state.selected) showDetail(state.selected)
        }
      } catch {
        // 这条腿断了（独立引擎被关掉 / 宿主正在重启）→ 换另一条腿再试；
        // 两条都不通就亮起顶部细提示，别让人对着不动的图猜发生了什么。
        const ok = await alignFailure()
        if (!ok) setOffline(true)
        else if (state.offline) setOffline(false)
      }
    }
    pollTimer = setInterval(tick, 12000)
    if (!state.visBound) {
      state.visBound = true
      // 回到前台补一次，免得刚切回来时图上还是十几分钟前的数据
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) tick()
      })
    }
  }

  /** 当前接口挂了：尝试换腿，接上了就重载整张图。 */
  async function alignFailure() {
    const switched = await API.failover()
    if (!switched) return false
    checkEngine(API.meta)
    toast(T('接口已切到 ') + (API.base === '/api/memory-nebula' ? T('宿主') : T('独立引擎')))
    try {
      applyGraph(await API.graph(), { keepView: true, filters: true })
    } catch (err) {
      softWarn('align', err)
    }
    return true
  }

  /**
   * 图进渲染层的唯一入口。
   *
   * 以前 boot / 轮询 / 重建 / 换腿 各自把 graph 塞给 stage，形状收口只在其中一条路径上，
   * 于是「点重建连线消失」这种事故迟早会发生（真的发生了）。现在统一从这里过：
   * ① 形状收口（幂等，压缩边还原成 {a,b}）
   * ② 更新 state
   * ③ 交给当前视图 load，并刷新统计/图例/筛选
   */
  function applyGraph(graph, opts = {}) {
    if (!graph) return null
    const g = API.normalizeGraph ? API.normalizeGraph(graph) : graph
    state.graph = g
    state.stage.load(g, opts.keepView !== false)
    renderStats(g)
    // 画布对读屏是块空白：给它一句话的摘要，至少知道「这儿有多少条记忆」。
    const canvasLabel = T('记忆星图：') + (g.stats ? g.stats.nodes + T(' 条记忆，') + g.stats.edges + T(' 条连接') : T('暂无数据'))
    for (const id of ['#sky', '#sky3d']) {
      const cv = $(id)
      if (cv) {
        cv.setAttribute('role', 'img')
        cv.setAttribute('aria-label', canvasLabel)
      }
    }
    renderLegend(g)
    if (opts.filters) buildFilters(g)
    // 螺旋视图下换了图：时间轴的范围与「≤ 某天 · N 条」得跟着新数据走，
    // 否则重建后新写的记忆会被上一版的 timeCut 挡在外面，看着像「重建丢记忆」。
    if (state.modeKey === 'spiral' && state.space3d) syncTimeCut()
    // 一开始是空库、后来有数据了：那句「记忆库是空的」得自己收起来
    const emptyHint = $('#hint')
    if (emptyHint && emptyHint.dataset.empty === '1' && g.nodes && g.nodes.length) {
      emptyHint.classList.remove('show', 'empty')
      emptyHint.innerHTML = ''
      delete emptyHint.dataset.empty
    }
    return g
  }

  /** 重新拉一次图（force 时强制在后端重建）。屏蔽/恢复/手工连边之后都走这里。 */
  async function reload(force) {
    const graph = force ? await API.refresh() : await API.graph({ refresh: 1 })
    return applyGraph(graph, { keepView: true, filters: true })
  }

  // 快照没有后端，重建按钮留着只会骗人；示例里则点了也没意义。
  if (API.snapshot) {
    const rb = $('#btn-refresh')
    if (rb) rb.hidden = true
  }

  $('#btn-refresh').onclick = async () => {
    if (API.demo) {
      toast(T('示例星系是只读的：先点顶部「退出示例」，再重建自己的库'))
      return
    }
    const btn = $('#btn-refresh')
    btn.disabled = true
    btn.classList.add('busy')
    btn.setAttribute('aria-busy', 'true')
    try {
      const graph = await reload(true)
      // buildMs 挂在图对象顶层（publicGraph），不在 stats 里——早先读到 undefined 就是这么来的
      const ms = graph.buildMs ?? graph.stats.buildMs ?? 0
      toast(T('已重建：') + graph.stats.edges + T(' 条连接 · ') + ms + 'ms')
      if (state.selected) showDetail(state.selected)
    } catch (err) {
      toast(T('重建失败：') + err.message)
    } finally {
      btn.disabled = false
      btn.classList.remove('busy')
      btn.removeAttribute('aria-busy')
    }
  }

  $('#btn-fit').onclick = () => state.stage.fit()
  const keysBtn = $('#btn-keys')
  if (keysBtn) keysBtn.onclick = (ev) => { ev.stopPropagation(); toggleKeys() }

  // 窄屏（<=900px）左列会被 CSS 收起。不能让人因此丢掉筛选能力：
  // 顶栏「筛选」把它当抽屉叫出来，点别处或 Esc 再收回去。
  const leftBtn = $('#btn-left')
  const leftCol = $('#leftcol')
  if (leftBtn && leftCol) {
    leftBtn.onclick = (ev) => {
      ev.stopPropagation()
      const open = leftCol.classList.toggle('open')
      leftBtn.classList.toggle('on', open)
      // 抽屉每次从顶上看起，不要带着上次滚到一半的位置
      if (open) { const f = $('#filters'); if (f) f.scrollTop = 0 }
    }
    document.addEventListener('click', (ev) => {
      if (!leftCol.classList.contains('open')) return
      if (leftCol.contains(ev.target) || leftBtn.contains(ev.target)) return
      leftCol.classList.remove('open')
      leftBtn.classList.remove('on')
    })
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return
      if (!leftCol.classList.contains('open')) return
      leftCol.classList.remove('open')
      leftBtn.classList.remove('on')
    })
  }

  const timeRange = $('#time-range')
  if (timeRange) timeRange.oninput = () => syncTimeCut()
  // 双击时间轴＝回到「全部」，不用去找最右端
  const timeBar = $('#timebar')
  if (timeBar) {
    timeBar.addEventListener('dblclick', () => {
      const r = $('#time-range')
      if (r) r.value = '1000'
      syncTimeCut()
    })
  }

  const exportBtn = $('#btn-export')
  const exportMenu = $('#export-menu')
  if (exportBtn && exportMenu) {
    const closeMenu = () => {
      exportMenu.hidden = true
    }
    exportBtn.onclick = (ev) => {
      ev.stopPropagation()
      exportMenu.hidden = !exportMenu.hidden
    }
    exportMenu.addEventListener('click', (ev) => {
      const hit = ev.target.closest('[data-export]')
      const act = hit && hit.dataset.export
      if (!act) return
      closeMenu()
      if (act === 'png') exportPNG()
      else if (act === 'html') exportShare()
      else if (act === 'html-ws') {
        const only = state.filter.ws && state.filter.ws.size === 1 ? [...state.filter.ws][0] : ''
        if (!only) toast(T('先在左栏「工作区」里只留一个，再导出这一片'))
        else exportShare({ ws: only })
      } else if (act === 'html-focus') {
        if (!state.selected) toast(T('先在图上点一个节点，再导出它周围 2 跳'))
        else exportShare({ focus: state.selected })
      } else exportSubgraph()
    })
    document.addEventListener('click', (ev) => {
      if (!exportMenu.hidden && !ev.target.closest('.menu-wrap')) closeMenu()
    })
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !exportMenu.hidden) closeMenu()
    })
  }
  $('#btn-cards').onclick = () => {
    if ($('#cards').hidden) openCards()
    else closeCards()
  }
  $('#cards-close').onclick = () => closeCards()
  const bBtn = $('#btn-boards')
  if (bBtn)
    bBtn.onclick = () => {
      if ($('#boards').hidden) openBoards(boardTab)
      else closeBoards()
    }
  const bClose = $('#boards-close')
  if (bClose) bClose.onclick = () => closeBoards()
  for (const b of document.querySelectorAll('#board-tabs .btab')) {
    b.onclick = () => {
      boardTab = b.dataset.tab
      for (const x of document.querySelectorAll('#board-tabs .btab')) x.classList.toggle('on', x === b)
      renderBoards()
    }
  }
  const lbClose = $('#lb-close')
  if (lbClose) lbClose.onclick = () => closeLine()
  const cmdInput = $('#cmdk-input')
  if (cmdInput) {
    cmdInput.addEventListener('input', () => {
      cmdkIndex = 0
      renderCmdk(cmdInput.value)
    })
  }
  $('#cmdk').addEventListener('click', (ev) => {
    if (ev.target === $('#cmdk')) closeCmdk()
  })
  const pbClose = $('#pb-close')
  if (pbClose) pbClose.onclick = () => closePath()
  // 星云(2D) → 星系(3D 力导向) → 时间(3D 螺旋) → 星云
  const MODE_ORDER = [
    { key: 'nebula', label: T('星云'), tip: T('平面星云：看清连接与证据') },
    { key: 'space', label: T('星系'), tip: T('三维力导向星系：结构由真实连接决定，重要度越高越贴核心') },
    { key: 'spiral', label: T('时间'), tip: T('时间螺旋：越新的记忆越靠中心，每个工作区一条旋臂') },
  ]
  function applyModeLabel() {
    const m = MODE_ORDER.find((x) => x.key === state.modeKey) || MODE_ORDER[0]
    const btn = $('#btn-mode')
    if (!btn) return
    btn.textContent = m.label
    btn.title = m.tip
  }
  state.modeKey = 'nebula'
  $('#btn-mode').onclick = () => {
    const i = MODE_ORDER.findIndex((x) => x.key === state.modeKey)
    const next = MODE_ORDER[(i + 1) % MODE_ORDER.length]
    applyMode(next.key)
  }
  applyModeLabel()

  window.addEventListener('load', boot)
})()

/* 拖动窗口大小时保持画面锐利 */
