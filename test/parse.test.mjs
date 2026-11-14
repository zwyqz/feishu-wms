import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFollowUp,
  buildRetryReply,
  chineseToNumber,
  normalizeColor,
  normalizeModel,
  normalizeQuantity,
  normalizeSize,
  parseMessage,
  SUGGESTED_FORMAT,
} from '../lib/parse.js'

test('R1 解析：需求原文示例「a客户 型号b 黑色3双43码」', () => {
  const parsed = parseMessage('a客户 型号b 黑色3双43码')
  assert.equal(parsed.customerName, 'a')
  assert.deepEqual(parsed.customerAliases, ['a客户'])
  assert.equal(parsed.missing.length, 0)
  assert.deepEqual(
    parsed.items.map((item) => ({ model: item.model, color: item.color, size: item.size, quantity: item.quantity })),
    [{ model: 'b', color: '黑色', size: '43', quantity: 3 }],
  )
  assert.equal(parsed.ok, true)
})

test('R1 解析：需求原文示例「再补两双白色55码的b款」（中文数字 + 字段乱序）', () => {
  const parsed = parseMessage('再补两双白色55码的b款')
  assert.equal(parsed.items.length, 1)
  const [item] = parsed.items
  assert.equal(item.model, 'b')
  assert.equal(item.color, '白色')
  assert.equal(item.size, '55')
  assert.equal(item.quantity, 2)
})

test('R1 解析：一条消息多个行项目（型号 / 颜色 / 数量 / 尺码各自独立）', () => {
  const parsed = parseMessage('b款 黑色3双43码 白色2双42码')
  assert.equal(parsed.items.length, 2)
  assert.deepEqual(
    parsed.items.map((item) => [item.model, item.color, item.size, item.quantity]),
    [
      ['b', '黑色', '43', 3],
      ['b', '白色', '42', 2],
    ],
  )
})

test('R1 解析：带标签写法「客户：张三，型号 X1，黑色，3双，43码」', () => {
  const parsed = parseMessage('客户：张三，型号 X1，黑色，3双，43码')
  assert.equal(parsed.customerName, '张三')
  assert.equal(parsed.missing.length, 0)
  assert.deepEqual(
    parsed.items.map((item) => [item.model, item.color, item.size, item.quantity]),
    [['X1', '黑色', '43', 3]],
  )
})

test('R2 解析失败：没有数量 → 不可入库，并给出标准格式提示', () => {
  const parsed = parseMessage('你好，在吗')
  assert.equal(parsed.items.length, 0)
  assert.equal(parsed.unparsedReason, 'no-quantity')
  const reply = buildRetryReply(parsed)
  assert.match(reply, /标准格式/)
  assert.ok(reply.includes(SUGGESTED_FORMAT))
})

test('R3 字段缺失：缺尺码 → need_info 且追问话术点名「尺码」', () => {
  const parsed = parseMessage('a客户 b款 黑色3双')
  assert.deepEqual(parsed.missing, ['size'])
  const followUp = buildFollowUp(parsed)
  assert.match(followUp, /尺码/)
  assert.ok(followUp.includes(SUGGESTED_FORMAT))
})

test('R3 字段缺失：缺客户名 → missing 含 customer', () => {
  const parsed = parseMessage('b款 黑色3双43码')
  assert.deepEqual(parsed.missing, ['customer'])
})

test('中文数字 / 颜色 / 尺码 / 型号 归一化', () => {
  assert.equal(chineseToNumber('两'), 2)
  assert.equal(chineseToNumber('十'), 10)
  assert.equal(chineseToNumber('十二'), 12)
  assert.equal(chineseToNumber('二十'), 20)
  assert.equal(chineseToNumber('二十五'), 25)
  assert.equal(chineseToNumber('7'), 7)
  assert.equal(normalizeQuantity('两双'), 2)
  assert.equal(normalizeColor('黑'), '黑色')
  assert.equal(normalizeColor('BLACK'), '黑色')
  assert.equal(normalizeColor('天蓝'), '蓝色')
  assert.equal(normalizeSize('43码'), '43')
  assert.equal(normalizeSize('EU 42.5'), '42.5')
  assert.equal(normalizeModel('型号b'), 'b')
  assert.equal(normalizeModel('b款'), 'b')
})

test('空消息不会抛错，按解析失败处理', () => {
  const parsed = parseMessage('   ')
  assert.equal(parsed.items.length, 0)
  assert.equal(parsed.unparsedReason, 'empty')
  assert.match(buildRetryReply(parsed), /空/)
})
