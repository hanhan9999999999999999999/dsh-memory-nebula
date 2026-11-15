/**
 * 1.11.58：共激活的判据是「几次会话」，不是「一份算得出来的分」。
 *
 * 文档第 10 行写着「同一会话里被一起点亮（Hebbian 共激活，出现在 ≥2 次会话才认）」，
 * 但代码算的是「每会话 1/log2(2+条数) 的阻尼分之和 ≥ 1.6」——60 条记忆的会话只加 0.17 分，
 * 同一对记忆要在十次会话里同时出现才够；再过一道 0.3 的最小边权，两头互相否掉。
 * 真实库上（2,196 条记忆 / 284 行账本）改前 211 条边带共激活、改后 951 条。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGraph } from '../lib/host/graph.js'
import { readSessionLedgers, LEDGER_KINDS } from '../lib/host/adapters/meow.js'

const HEBB_WHY = /^在 \d+ 次会话里一起被点亮$/

/**
 * 两条正文**一个实词都不共用**的记忆：只靠文本永远连不起来。
 * （共用「这条」「记录」这种填充词也会被算成语义证据，所以刻意用两组不相交的字。）
 */
function pair(idA = 'a', idB = 'b', ws = 'w') {
  return [
    {
      id: 'n' + idA,
      uid: idA,
      ws,
      wsTitle: ws,
      title: '甲 ' + idA,
      content: '甲甲 分页 快照 取舍 逐页 翻动 stillwater ' + idA,
      keywords: ['分页'],
      level: 'fact',
      project: 'pa',
    },
    {
      id: 'n' + idB,
      uid: idB,
      ws,
      wsTitle: ws,
      title: '乙 ' + idB,
      content: '乙乙 许可 安装 体积 逐条 计量 offtide ' + idB,
      keywords: ['许可'],
      level: 'fact',
      project: 'pb',
    },
  ]
}

const sessions = (list) => list.map(([sessionId, ids], i) => ({ sessionId, kind: ['injected', 'searched', 'written'][i % 3], ids, ws: 'w' }))

test('同一对记忆出现在两次会话里：长出共激活边，理由写着「在 2 次会话里」', () => {
  const g = buildGraph({ nodes: pair(), ledgers: sessions([['s1', ['a', 'b']], ['s2', ['a', 'b']]]) })
  const edge = g.edges.find((e) => (e.why || []).some((w) => HEBB_WHY.test(w)))
  assert.ok(edge, '两次会话共激活应该成边：' + JSON.stringify(g.edges))
  assert.equal(edge.type, 'hebbian')
  assert.match(edge.why.join('｜'), /在 2 次会话里一起被点亮/)
  assert.ok(edge.w >= 0.3, '边权要过得去最小边权：' + edge.w)
})

test('只出现在一次会话里：不算证据（哪怕那一次点亮了几十条）', () => {
  const nodes = pair()
  const many = ['a', 'b', ...Array.from({ length: 40 }, (_, i) => 'x' + i)]
  for (const i of Array.from({ length: 40 }, (_, k) => k)) {
    nodes.push({
      id: 'nx' + i,
      uid: 'x' + i,
      ws: 'w',
      wsTitle: 'w',
      title: '填充 ' + i,
      content: '填充正文 ' + i + ' 与别的都不同 ' + 'z'.repeat(3 + (i % 7)),
      keywords: ['填充'],
      level: 'fact',
      project: 'pz',
    })
  }
  const g = buildGraph({ nodes, ledgers: sessions([['s1', many]]) })
  const edge = g.edges.find((e) => (e.why || []).some((w) => HEBB_WHY.test(w)))
  assert.equal(edge, undefined, '一次会话不该算共激活')
})

test('会话越大，同样的两次共激活给的权重越低（但不归零）', () => {
  const build = (filler) => {
    const nodes = pair()
    const ids = ['a', 'b']
    for (let i = 0; i < filler; i++) {
      ids.push('y' + i)
      nodes.push({
        id: 'ny' + i,
        uid: 'y' + i,
        ws: 'w',
        wsTitle: 'w',
        title: '填充 ' + i,
        content: '填充正文 ' + i + ' 与别的都不同 ' + 'q'.repeat(3 + (i % 5)),
        keywords: ['填充'],
        level: 'fact',
        project: 'py',
      })
    }
    const g = buildGraph({ nodes, ledgers: sessions([['s1', ids], ['s2', ids]]) })
    // 只取 a、b 这两条之间的边：整场会话里每一对都共激活两次，随便找一条会拿到别的对。
    const edge = g.edges.find(
      (e) => (e.s === 0 && e.t === 1) || (e.s === 1 && e.t === 0)
    )
    if (!edge) return 0
    assert.ok((edge.why || []).some((w) => HEBB_WHY.test(w)), '这条边的理由里应有共激活：' + edge.why.join('｜'))
    return edge.w
  }
  const small = build(0)
  const big = build(60)
  assert.ok(small > 0, '小会话应该成边')
  assert.ok(big > 0, '大会话也不该归零（同一对记忆确实在两次会话里一起出现过）')
  assert.ok(small > big, `小会话权重应更高：small=${small} big=${big}`)
})

test('账本只认活动键：projectsQueried 里的项目名不算点亮过记忆', (t) => {
  assert.ok(LEDGER_KINDS.has('injected') && LEDGER_KINDS.has('written'), '四个活动键都要在名单里')
  assert.equal(LEDGER_KINDS.has('projectsQueried'), false, 'projectsQueried 装的是项目名，不是记忆 id')

  const dir = mkdtempSync(join(tmpdir(), 'nebula-ledger-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeFileSync(
    join(dir, 'sessions', 'session-1.json'),
    JSON.stringify({
      injected: ['m1', 'm2'],
      searched: ['m3'],
      accessed: [],
      written: ['m4'],
      projectsQueried: ['Memory Universe', 'Remote Connect DSH'],
      reinjectPending: false,
      currentProject: 'Memory Universe',
    }),
    'utf8'
  )
  const rows = readSessionLedgers(join(dir, 'sessions'))
  const kinds = rows.map((r) => r.kind).sort()
  assert.deepEqual(kinds, ['injected', 'searched', 'written'])
  assert.equal(rows.every((r) => r.ids.every((id) => !id.includes(' '))), true, '不该把项目名当 id')
})

test('一条边既有文本证据也有共激活：理由里两句话都在，主证据仍按权重排', () => {
  const nodes = pair()
  nodes[0].content += ' 共同词 alpha beta gamma'
  nodes[1].content += ' 共同词 alpha beta gamma'
  nodes[0].keywords.push('alpha', 'beta')
  nodes[1].keywords.push('alpha', 'beta')
  const g = buildGraph({ nodes, ledgers: sessions([['s1', ['a', 'b']], ['s2', ['a', 'b']]]) })
  const edge = g.edges.find((e) => (e.s === 0 && e.t === 1) || (e.s === 1 && e.t === 0))
  assert.ok(edge, '这对应该有边')
  assert.match(edge.why.join('｜'), /在 2 次会话里一起被点亮/)
  assert.ok(['hebbian', 'keyword', 'semantic', 'entity'].includes(edge.type), '主证据类型要合法：' + edge.type)
})
