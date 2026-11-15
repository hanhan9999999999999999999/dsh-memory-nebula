/**
 * 诊断报告：给支持用的「可复制事实」，不是内容导出。
 *
 * 这里刻意只收集版本、环境、图规模、来源统计与最近一次错误；
 * 不读记忆正文、不写来源路径。用户把这段贴给支持，足够判断
 * 「跑的是哪一版 / 哪个来源挂了 / 图为什么是空的」，又不会泄露日记。
 */

function sourceRow(store, errors) {
  const key = String(store?.key || '')
  const hit = (errors || []).find((e) => e.store === key || (store?.id && e.id === store.id))
  return {
    key,
    title: String(store?.title || ''),
    adapter: String(store?.adapter || ''),
    provider: String(store?.provider || ''),
    size: Number(store?.size || 0),
    kind: String(store?.kind || ''),
    // 这个来源读坏了就带上（已抹掉路径/文件名的）原因：诊断里必须能一眼看出「0 条」是空的还是坏了
    error: hit ? redact(hit.error).slice(0, 200) : '',
  }
}

function iso(value) {
  const ms = Number(value || 0)
  if (!ms) return ''
  try {
    return new Date(ms).toISOString()
  } catch {
    return ''
  }
}

/**
 * 诊断报告对外可贴：来源错误里可能带绝对路径或库文件名（sqlite 的原文五花八门），
 * 这里统一抹掉，只留下「哪个来源」和「什么毛病」。
 */
function redact(text) {
  return String(text || '')
    .replace(/[A-Za-z]:[\\/][^\s，。；:：]*/g, '[路径]')
    .replace(/(?:\\\\|\/)[^\s，。；:：]+/g, '[路径]')
    .replace(/[\w.-]+\.(?:db|sqlite3?|db-wal|db-shm)\b/gi, '[数据库]')
}

/**
 * @param {{version:string, build:number, startedAt:number, mode:string, demo?:boolean,
 *          nebula:any, runtime?:object, capabilities?:string[]}} input
 */
export function buildDiagnostics(input) {
  const graph = input.nebula?.graph || {}
  const stats = graph.stats || {}
  const runtime = input.runtime || {}
  const storeErrors = Array.isArray(input.nebula?.storeErrors) ? input.nebula.storeErrors : []
  return {
    product: 'memory-nebula',
    content: 'none',
    version: String(input.version || ''),
    build: Number(input.build || 0),
    startedAt: iso(input.startedAt),
    mode: String(input.mode || ''),
    demo: Boolean(input.demo),
    runtime: {
      node: String(runtime.node || ''),
      platform: String(runtime.platform || ''),
      arch: String(runtime.arch || ''),
      pid: Number(runtime.pid || 0),
      uptimeSec: Math.round(Number(runtime.uptimeSec || 0)),
      rssMb: Math.round(Number(runtime.rssMb || 0)),
    },
    graph: {
      nodes: Number(stats.nodes || 0),
      edges: Number(stats.edges || 0),
      workspaces: Number(stats.workspaces || 0),
      sessions: Number(stats.sessions || 0),
      buildMs: Number(input.nebula?.lastBuildMs || 0),
      builtAt: iso(graph.builtAt),
      lastError: redact(input.nebula?.lastError || '').slice(0, 600),
    },
    sources: (input.nebula?.stores || []).map((s) => sourceRow(s, storeErrors)),
    errors: storeErrors.slice(0, 8).map((e) => ({ store: String(e.store || ''), error: redact(e.error).slice(0, 300) })),
    capabilities: Array.isArray(input.capabilities) ? [...input.capabilities] : [],
  }
}

/** 人类可读的纯文本；`/diagnostics` 与 `--diagnose` 共用这一份格式。 */
export function formatDiagnostics(d, opts = {}) {
  const en = opts.lang === 'en'
  const lines = [
    'memory-nebula diagnostics',
    en ? '# contains no memory text; you can paste this whole report into a support thread'
       : '# 不含记忆正文；可以整段贴给支持',
    'version: ' + d.version,
    'build: ' + d.build,
    'started: ' + (d.startedAt || 'unknown'),
    'mode: ' + d.mode + (d.demo ? ' (demo)' : ''),
  ]
  if (d.runtime?.node || d.runtime?.platform) {
    lines.push(
      'runtime: node ' + (d.runtime.node || '?') + ' / ' + (d.runtime.platform || '?') + ' ' + (d.runtime.arch || '') +
        (d.runtime.pid ? ' / pid ' + d.runtime.pid : '') +
        (d.runtime.uptimeSec ? ' / up ' + d.runtime.uptimeSec + 's' : '') +
        (d.runtime.rssMb ? ' / rss ' + d.runtime.rssMb + 'MB' : ''),
    )
  }
  lines.push(
    'graph: ' + d.graph.nodes + ' memories / ' + d.graph.edges + ' links / ' +
      d.graph.workspaces + ' workspaces / ' + d.graph.sessions + ' sessions',
    'build: ' + d.graph.buildMs + 'ms' + (d.graph.builtAt ? ' at ' + d.graph.builtAt : ''),
  )
  lines.push('sources: ' + d.sources.length)
  for (const s of d.sources) {
    lines.push(
      '  - ' + (s.key || '?') + ' | ' + (s.title || '?') + ' | ' + (s.adapter || '?') +
        (s.provider ? ' / ' + s.provider : '') + (s.size ? ' | ' + s.size + 'B' : '') +
        (s.kind ? ' | ' + s.kind : ''),
    )
  }
  lines.push('capabilities: ' + (d.capabilities.length ? d.capabilities.join(',') : 'none'))
  if (Array.isArray(d.errors) && d.errors.length) {
    lines.push('sourceErrors: ' + d.errors.length)
    for (const e of d.errors) lines.push('  ! ' + (e.store || '?') + '：' + (e.error || '?'))
  }
  lines.push('lastError: ' + (d.graph.lastError || 'none'))
  return lines.join('\n')
}
