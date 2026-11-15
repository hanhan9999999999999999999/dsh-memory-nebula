// 截断不许劈开一个字：代理对、ZWJ 连字、变体选择符、肤色修饰符。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clip, cut } from '../lib/host/text.js'
import { Nebula } from '../lib/host/nebula.js'

/** 找出所有「半个字符」的下标（孤立的代理项）。 */
function loneAt(s) {
  const bad = []
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) bad.push(i)
      else i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) bad.push(i)
  }
  return bad
}

/** 写进 UTF-8 再读回来，看看会不会变成替换符 U+FFFD。 */
function utf8RoundTrip(s) {
  return Buffer.from(s, 'utf8').toString('utf8')
}

test('cut：短于上限时原样返回，不做任何改写', () => {
  assert.equal(cut('星图', 10), '星图')
  assert.equal(cut('', 10), '')
  assert.equal(cut('a b', 3), 'a b')
})

test('cut：切点落在代理对中间时少吃一个，不算半个 emoji', () => {
  // '🌊' 是 U+1F30A，占两个 code unit；下标 2 是它的前半个
  const s = 'A' + '🌊' + 'B'
  const out = cut(s, 2)
  assert.equal(out, 'A')
  assert.deepEqual(loneAt(out), [])
  // 切点正好在 emoji 之后时，整个 emoji 保留
  assert.equal(cut(s, 3), 'A🌊')
})

test('cut：不把 ZWJ 连字、变体选择符、肤色修饰符切成半截', () => {
  const family = '👨‍👩‍👧' // 8 个 code unit（👨 ZWJ 👩 ZWJ 👧）
  // 任何切点都不许留半个字符，也不许以 ZWJ 收尾（那会画出半个连字）
  for (let max = 0; max <= family.length + 1; max += 1) {
    const out = cut('x' + family, max)
    assert.deepEqual(loneAt(out), [], `max=${max} 时出现了半个字符`)
    assert.equal(out.endsWith('\u200d'), false, `max=${max} 时以 ZWJ 收尾`)
  }
  assert.equal(cut('x' + family, 1), 'x')
  assert.equal(cut('x' + family, 2), 'x', '切在 emoji 前半个时要整颗退掉')

  const heart = '❤️' // U+2764 + U+FE0F
  assert.equal(cut('x' + heart, 2), 'x', '别把变体选择符留成孤儿')

  const wave = '👋🏽' // U+1F44B + U+1F3FD（肤色修饰符）
  for (let max = 0; max <= wave.length + 1; max += 1) {
    const out = cut('x' + wave, max)
    assert.deepEqual(loneAt(out), [], `max=${max} 时出现了半个字符`)
    const tail = out.codePointAt(out.length - 1)
    assert.equal(tail >= 0x1f3fb && tail <= 0x1f3ff, false, `max=${max} 时以肤色修饰符收尾`)
  }
  assert.equal(cut('x' + wave, 5), 'x' + wave, '够长时整颗保留')
})

test('cut：数据里本来就带半个字符时，顺手清掉', () => {
  const broken = 'A\ud83cB' // 孤立的高代理项
  assert.equal(cut(broken, 10), 'AB')
  const brokenLow = 'A\ufe0f\ud83dB'
  assert.equal(loneAt(cut(brokenLow, 10)).length, 0)
})

test('cut：上限为 0、负数、NaN 时给空串，不抛异常', () => {
  assert.equal(cut('星图', 0), '')
  assert.equal(cut('星图', -5), '')
  assert.equal(cut('星图', Number.NaN), '')
  assert.equal(cut(null, 3), '')
  assert.equal(cut(undefined, 3), '')
})

test('clip：以省略号收尾、长度不超过上限、没有半个字符', () => {
  const s = 'A'.repeat(258) + '🌊' + 'tail'
  const out = clip(s, 260)
  assert.ok(out.endsWith('…'))
  assert.ok(out.length <= 260)
  assert.deepEqual(loneAt(out), [])
  assert.equal(utf8RoundTrip(out).includes('\ufffd'), false, '写进 UTF-8 不该出现替换符')
})

test('clip：压缩空白、短文本不加省略号', () => {
  assert.equal(clip('  a\n\n b  ', 20), 'a b')
  assert.equal(clip('星图', 20), '星图')
})

test('clip：emoji 正好卡在切点时也不留半个（导出/接口都靠它）', () => {
  for (let pad = 0; pad < 4; pad += 1) {
    const out = clip('A'.repeat(20 + pad) + '🌊🌊🌊', 22)
    assert.deepEqual(loneAt(out), [], `pad=${pad} 时出现了半个字符`)
    assert.equal(utf8RoundTrip(out).includes('\ufffd'), false, `pad=${pad} 时 UTF-8 里出现替换符`)
  }
})

test('整条链路：记忆正文的 emoji 卡在预览切点上，detail 与导出的都是干净文本', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nebula-cut-home-'))
  const ws = mkdtempSync(join(tmpdir(), 'nebula-cut-ws-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const text = 'A'.repeat(258) + '🌊' + 'tail'

  try {
    const ingestDir = join(home, 'memory-nebula', 'ingest')
    mkdirSync(ingestDir, { recursive: true })
    writeFileSync(join(ingestDir, 'x.jsonl'), JSON.stringify({ uid: 'm-boundary', title: '边界', content: text, level: 'fact' }) + '\n', 'utf8')
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ workspaces: {} }), 'utf8')

    const nb = new Nebula({ root: ws })
    await nb.refresh()
    const g = nb.publicGraph({ limit: 10 })
    assert.equal(g.nodes.length, 1, '那一条记忆应该进图')
    const detail = nb.detail(g.nodes[0].id)
    const preview = detail && detail.preview
    assert.equal(typeof preview, 'string', 'detail 要给出预览')
    assert.deepEqual(loneAt(preview), [], '预览里不许有半个字符')
    assert.equal(utf8RoundTrip(preview).includes('\ufffd'), false, '预览写成 UTF-8 不许出现替换符')
    assert.ok(preview.endsWith('…'), '长文本预览要以省略号收尾')
    nb.stopWatching?.()
  } finally {
    const { closeStore } = await import('../lib/host/store.js')
    closeStore()
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
})
