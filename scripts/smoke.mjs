// 发布前冒烟：只读接口的契约自查。
// 用法: node scripts/smoke.mjs [base]
// 退出码 0 = 全过；1 = 有失败（可直接挂到 CI / 发布前手跑）。
const base = process.argv[2] || process.env.NEBULA_BASE || 'http://127.0.0.1:7891/api/memory-nebula'

let fails = 0
const ok = (name, cond, extra) => {
  if (cond) console.log('  ✓ ' + name + (extra ? '  ' + extra : ''))
  else { fails++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}
const get = async (p) => {
  const r = await fetch(base + p)
  if (!r.ok) throw new Error(p + ' → HTTP ' + r.status)
  return r.json()
}
const post = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  if (!r.ok) throw new Error(p + ' → HTTP ' + r.status)
  return r.json()
}

function checkGraph(tag, g) {
  ok(tag + ' v=2', g.v === 2, 'v=' + g.v)
  ok(tag + ' nodes>0', Array.isArray(g.nodes) && g.nodes.length > 0, g.nodes?.length + ' 条')
  ok(tag + ' edges>0', Array.isArray(g.edges) && g.edges.length > 0, g.edges?.length + ' 条')
  const e0 = g.edges?.[0]
  ok(tag + ' 边是 v2 下标形状', !!e0 && typeof e0.s === 'number' && typeof e0.d === 'number', JSON.stringify(e0))
  let bad = 0
  for (const e of g.edges || []) {
    if (!(e.s >= 0 && e.s < g.nodes.length && e.d >= 0 && e.d < g.nodes.length)) bad++
    if (!(e.w >= 0 && e.w <= 1)) bad++
  }
  ok(tag + ' 边端点/权重合法', bad === 0, bad + ' 条异常')
  const ids = new Set()
  let dup = 0
  for (const n of g.nodes || []) { if (ids.has(n.id)) dup++; ids.add(n.id) }
  ok(tag + ' 节点 id 唯一', dup === 0, dup + ' 个重复')
  ok(tag + ' stats 与数组一致', g.stats?.nodes === g.nodes.length && g.stats?.edges === g.edges.length,
    `stats ${g.stats?.nodes}/${g.stats?.edges}`)
  return g
}

console.log('base =', base)

// 1) ping
const ping = await get('/ping')
ok('ping.stats', !!ping.stats && ping.stats.nodes > 0, ping.stats?.nodes + ' 条记忆')
ok('ping 带 build 指纹', typeof ping.build === 'number' && ping.build > 0)

// 2) graph
const g = checkGraph('graph', await get('/graph'))

// 3) refresh 后形状必须与 graph 同构（历史上就是这里漏了展开 → 连线消失）
const r = checkGraph('refresh', await post('/refresh'))
ok('refresh 与 graph 规模同量级', Math.abs(r.nodes.length - g.nodes.length) <= 50, `${g.nodes.length} → ${r.nodes.length}`)

// 4) 单条详情
// 挑一个有连接的节点：孤立节点本来就没有邻居，不算失败
const first = r.nodes.find((n) => n.level !== 'source' && (n.degree || 0) > 0) || r.nodes[0]
const d = await get('/node?id=' + encodeURIComponent(first.id))
const dn = d && (d.node || d)
ok('node 详情', !!dn && dn.id === first.id, (dn?.label || '').slice(0, 24))
ok('node 带邻居', Array.isArray(d?.neighbors) && d.neighbors.length > 0, 'neighbors=' + (d?.neighbors?.length || 0))

// 5) 扩散检索
const rc = await get('/recall?q=' + encodeURIComponent('记忆') + '&limit=5')
ok('recall 有结果', Array.isArray(rc?.hits) && rc.hits.length > 0, rc.hits?.length + ' 条')
ok('recall 每条约带 why', (rc.hits || []).every((h) => Array.isArray(h.why) || h.why), '')

// 6) 证据链：从一条记忆跳到它的一个邻居
const nb = (d?.neighbors || [])[0]
if (nb && nb.id) {
  const p = await get(`/path?a=${encodeURIComponent(first.id)}&b=${encodeURIComponent(nb.id)}`)
  ok('path 能连上直接邻居', !!p && p.found === true && (p.nodes || []).length >= 2,
    `hops=${p?.hops} score=${p?.score}`)
} else {
  ok('path（无邻居可测）', true, 'skipped')
}

// 7) 体检 / 总览
const ov = await get('/overview')
ok('overview 带来源', !!ov && !!ov.stats, JSON.stringify(ov?.stats || {}).slice(0, 80))

// 8) 来源层：适配器注册表 + 配置位置 + 每个来源都读到了东西
const src = await get('/sources')
ok('sources 有适配器清单', Array.isArray(src?.adapters) && src.adapters.length >= 4,
  (src?.adapters || []).map((a) => a.id).join('/'))
ok('sources 报了配置文件位置', typeof src?.config?.path === 'string' && src.config.path.length > 0)
ok('sources 至少接了一个来源', (src?.live?.stores || []).length > 0, (src?.live?.stores || []).length + ' 个来源')
ok('sources 读过节点', (src?.live?.nodes || 0) > 0, (src?.live?.nodes || 0) + ' 条')
const srcErrors = (src?.live?.errors || []).length
ok('sources 没有读取失败', srcErrors === 0, srcErrors + ' 条错误')

// 9) 节点带 provider：接了多来源之后，「这条记忆谁给的」必须能查
const provCount = {}
for (const n of g.nodes) provCount[n.provider || '(缺)'] = (provCount[n.provider || '(缺)'] || 0) + 1
ok('每个节点都标了 provider', !provCount['(缺)'], JSON.stringify(provCount))
ok('provider 统计与节点数一致',
  Object.values(provCount).reduce((a, b) => a + b, 0) === g.nodes.length)

// 10) 补充包：跨插件协同注入的核心接口
const bg = await get('/bridge?query=' + encodeURIComponent('记忆') + '&limit=3&mark=0')
ok('bridge 返回结构完整', !!bg && Array.isArray(bg.items) && !!bg.stats, `items=${bg?.items?.length ?? '?'}`)
ok('bridge 每条都带证据理由', (bg?.items || []).every((it) => Array.isArray(it.why) || it.why || it.text),
  '')
ok('bridge 遵守条数预算', (bg?.items || []).length <= 3)
if ((bg?.items || []).length > 0) {
  ok('bridge 文本非空', typeof bg.text === 'string' && bg.text.trim().length > 0, bg.text.slice(0, 40))
}

// 11) 注入账本
const lg = await get('/ledger')
ok('ledger 有统计', !!lg?.stats && typeof lg.stats.sessions === 'number', JSON.stringify(lg?.stats || {}).slice(0, 60))

// 12) 导出：给外部 AI 用的 JSON 与给人看的 MD
const ej = await get('/export?format=json&limit=10')
ok('export json 结构', !!ej && Array.isArray(ej.nodes) && Array.isArray(ej.edges) && !!ej.stats)
const em = await get('/export?format=md&limit=10')
ok('export md 有正文', typeof em?.text === 'string' && em.text.includes('# 记忆星图导出'), (em?.text || '').length + ' 字')

// 13) 推送通道的入参校验（不写盘，只确认它拒绝空参数而不是 500）
let ingestGuard = false
try {
  await post('/ingest', {})
} catch (err) {
  ingestGuard = /HTTP 400/.test(String(err))
}
ok('ingest 缺少 provider 时返回 400', ingestGuard)

// 14) 示例星系：第一次打开就能看，但一行都不写进真实库
const dping = await fetch(base + '/ping?demo=1').then((x) => x.json())
ok('示例 ping 带 demo 标记', dping.demo === true && dping.stats?.nodes > 40,
  `${dping.stats?.nodes} 条 / ${dping.stats?.edges} 连接`)
ok('能力清单声明 demo/share',
  (dping.capabilities || []).includes('demo') && (dping.capabilities || []).includes('share'),
  (dping.capabilities || []).join(','))
const dg = checkGraph('demo', await get('/graph?demo=1'))
ok('示例图确实是虚构的', dg.demo === true && dg.nodes.every((n) => n.provider !== 'meow-memory'))
const dnode = await get('/node?demo=1&id=xg-weekly')
ok('示例详情有邻居', (dnode.degree || 0) >= 10, 'degree=' + dnode.degree)
const drecall = await get('/recall?demo=1&q=' + encodeURIComponent('星港') + '&limit=8')
ok('示例检索能搜到', (drecall.hits || []).length >= 5, drecall.hits?.length + ' 条')
const dpath = await get('/path?demo=1&a=vc-quote&b=dy-touched')
ok('示例证据链能走通', dpath.found === true && dpath.hops >= 1, 'hops=' + dpath.hops)
const writeRes = await fetch(base + '/link?demo=1', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
})
ok('示例模式拒绝写入', writeRes.status === 403, 'HTTP ' + writeRes.status)

// 15) 单文件快照：能下载、能自带一切
const shareRes = await fetch(base + '/share')
const shareHtml = await shareRes.text()
ok('share 返回 HTML', shareRes.ok && /text\/html/.test(shareRes.headers.get('content-type') || ''),
  shareRes.headers.get('content-type'))
ok('share 带下载文件名', /attachment; filename="memory-nebula-snapshot-/.test(shareRes.headers.get('content-disposition') || ''))
ok('share 自包含', shareHtml.includes('window.__NEBULA_SNAPSHOT__') && !/<script[^>]+src=/i.test(shareHtml),
  shareHtml.length + ' 字')

const wsShare = await fetch(base + '/share?demo=1&scope=ws:xingang')
const wsHtml = await wsShare.text()
const wsScope = (wsHtml.match(/"scope":\{[^}]*\}/) || [''])[0]
ok('范围 share 只导出工作区', wsShare.ok && /-ws-/.test(wsShare.headers.get('content-disposition') || '') &&
  wsScope.includes('"kind":"ws"') && wsScope.includes('"nodes":32') && !wsHtml.includes('dy-locker'),
  wsScope.slice(0, 90))
const badScope = await fetch(base + '/share?demo=1&scope=wat')
ok('非法范围返回 400', badScope.status === 400, String(badScope.status))

const hideRes = await fetch(base + '/share?demo=1&hide=ws:diary')
const hideHtml = await hideRes.text()
const hideScope = (hideHtml.match(/"scope":\{[^}]*\}/) || [''])[0]
ok('hide 把工作区整体剔除', hideRes.ok && hideScope.includes('"hidden":7') &&
  hideScope.includes('"nodes":57') && !hideHtml.includes('（内置演示数据，不写盘）'),
  hideScope.slice(0, 100))
const emptyHide = await fetch(base + '/share?demo=1&scope=ws:diary&hide=ws:diary')
ok('hide 把范围清空时返回 404', emptyHide.status === 404, String(emptyHide.status))
const badHide = await fetch(base + '/share?demo=1&hide=nope:x')
ok('非法 hide 返回 400', badHide.status === 400, String(badHide.status))

// 16) 诊断：可贴给支持，但不带正文与路径
const diagRes = await fetch(base + '/diagnostics')
const diagText = await diagRes.text()
ok('诊断返回纯文本', diagRes.ok && /text\/plain/.test(diagRes.headers.get('content-type') || ''),
  diagRes.headers.get('content-type'))
ok('诊断不含正文与本机路径',
  diagText.includes('memory-nebula diagnostics') && /graph: \d+ memories/.test(diagText) &&
    !diagText.includes('dbPath') && !diagText.includes('C:\\'),
  diagText.split('\n')[0])
const demoDiag = await (await fetch(base + '/diagnostics?demo=1')).text()
ok('示例诊断标记 demo', /mode: .*\(demo\)/.test(demoDiag) && /graph: 64 memories/.test(demoDiag),
  (demoDiag.match(/mode: .+/) || [''])[0])

console.log(fails ? `\n失败 ${fails} 项` : '\n全部通过')
process.exit(fails ? 1 : 0)
