// hops 的解析契约：不传按 2，写错直接 400（不静默回落），上限 5。
// 以前 parseShareHops 对垃圾输入一律返回 2，和 parseShareLimit 的「拼错就 400」自相矛盾。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShareHops } from '../lib/host/share.js'

test('不传或留空时按 2 跳', () => {
  for (const raw of [undefined, null, '', '  ']) assert.equal(parseShareHops(raw), 2)
})

test('1–5 的原样接受', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    assert.equal(parseShareHops(String(n)), n)
    assert.equal(parseShareHops(n), n)
  }
})

test('越界和拼错都报 400，而不是悄悄改成别的数', () => {
  for (const raw of ['0', '-1', '6', '9', '2.5', 'abc', '2跳', 'Infinity', '1e3', 'NaN']) {
    assert.throws(
      () => parseShareHops(raw),
      (err) => err.status === 400 && /hops 需要 1–5 的整数/.test(err.message),
      String(raw),
    )
  }
})

test('前导零与周围空白算合法', () => {
  assert.equal(parseShareHops(' 3 '), 3)
  assert.equal(parseShareHops('02'), 2)
})
