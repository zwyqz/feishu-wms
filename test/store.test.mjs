import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { localDate, monthOf, WmsStore } from '../lib/store.js'

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'wms-store-'))

async function freshStore(now = new Date('2026-10-12T09:00:00')) {
  const dir = await tmpDir()
  const store = new WmsStore({ dataDir: dir, now: () => now })
  await store.init()
  return { store, dir }
}

test('R3 客户档案：建档 / 同名更新 / 别名匹配 / 资料完整度', async () => {
  const { store } = await freshStore()
  const created = await store.upsertCustomer({ name: '张三', contact: '13800000000' })
  assert.equal(created.created, true)
  assert.equal(created.customer.profileComplete, true)

  const updated = await store.upsertCustomer({ name: '张三', address: '杭州' })
  assert.equal(updated.created, false)
  assert.equal(updated.customer.contact, '13800000000')
  assert.equal(updated.customer.address, '杭州')
  assert.equal(store.listCustomers().length, 1)

  await store.upsertCustomer({ name: '阿三', aliases: ['三哥'] })
  assert.equal(store.findCustomer('三哥')?.name, '阿三')
  assert.equal(store.findCustomer('张三')?.name, '张三')
})

test('R3 补录：新客户没有联系方式时 profileComplete=false', async () => {
  const { store } = await freshStore()
  const { customer } = await store.ensureCustomer('a', ['a客户'])
  assert.equal(customer.contact, '')
  assert.equal(customer.profileComplete, false)
  assert.equal(store.findCustomer('a客户')?.id, customer.id)
})

test('R5 单价：客户 + 型号新增/修改，颜色专价覆盖通用价，生效日期生效', async () => {
  const { store } = await freshStore()
  const { customer } = await store.upsertCustomer({ name: '张三' })
  await store.setPrice({ customer: '张三', model: 'b', unitPrice: 100 })
  assert.equal(store.priceFor(customer.id, 'b', '黑色', '2026-10-12'), 100)

  await store.setPrice({ customer: '张三', model: 'b', color: '黑色', unitPrice: 120 })
  assert.equal(store.priceFor(customer.id, 'b', '黑色', '2026-10-12'), 120)
  assert.equal(store.priceFor(customer.id, 'b', '白色', '2026-10-12'), 100)

  // 修改同一条（客户 + 型号 + 颜色）而不是新增
  await store.setPrice({ customer: '张三', model: 'b', color: '黑色', unitPrice: 130 })
  assert.equal(store.listPrices().length, 2)
  assert.equal(store.priceFor(customer.id, 'b', '黑色', '2026-10-12'), 130)

  // 生效日期在未来的价格不生效
  await store.setPrice({ customer: '张三', model: 'b', color: '白色', unitPrice: 200, effectiveFrom: '2026-11-01' })
  assert.equal(store.priceFor(customer.id, 'b', '白色', '2026-10-12'), 100)
  assert.equal(store.priceFor(customer.id, 'b', '白色', '2026-11-02'), 200)

  assert.equal(store.listPrices().length, 3)
  // 给还不存在的客户报价会自动建档（联系方式待补录）
  await store.setPrice({ customer: '新客户', model: 'b', unitPrice: 88 })
  assert.equal(store.findCustomer('新客户')?.contact, '')
  await assert.rejects(store.setPrice({ customer: '张三', model: 'b', unitPrice: -1 }), /单价/)
})

test('R4 当日汇总：同一客户多条消息数量自动累加，按 客户×型号×颜色×尺码 分组', async () => {
  const { store } = await freshStore()
  await store.ensureCustomer('a', ['a客户'])
  await store.recordOrders(
    [{ customer: 'a客户', model: 'b', color: '黑色', size: '43', quantity: 3 }],
    { orderDate: '2026-10-12', source: 'feishu' },
  )
  // 同一天第二条消息：同款同色同码 → 累加；不同尺码 → 新行
  await store.recordOrders(
    [
      { customer: 'a客户', model: 'b', color: '黑色', size: '43', quantity: 2 },
      { customer: 'a客户', model: 'b', color: '白色', size: '42', quantity: 1 },
    ],
    { orderDate: '2026-10-12', source: 'feishu' },
  )
  const summary = store.dailySummary({ date: '2026-10-12' })
  assert.equal(summary.rows.length, 2)
  const black = summary.rows.find((r) => r.color === '黑色')
  assert.equal(black.quantity, 5)
  assert.equal(summary.totals.quantity, 6)
  assert.equal(summary.totals.customers, 1)
  assert.equal(summary.totals.lines, 2)
  // 没有单价时金额为 null 且被标为未定价
  assert.equal(black.amount, null)
  assert.equal(summary.totals.unpricedQuantity, 6)
})

test('R4 当日汇总：有单价时算出金额，未定价行单独计数', async () => {
  const { store } = await freshStore()
  await store.ensureCustomer('a', ['a客户'])
  await store.setPrice({ customer: 'a', model: 'b', unitPrice: 120 })
  await store.recordOrders(
    [
      { customer: 'a', model: 'b', color: '黑色', size: '43', quantity: 3 },
      { customer: 'a', model: 'c', color: '白色', size: '42', quantity: 2 },
    ],
    { orderDate: '2026-10-12' },
  )
  const summary = store.dailySummary({ date: '2026-10-12' })
  const black = summary.rows.find((r) => r.model === 'b')
  assert.equal(black.unitPrice, 120)
  assert.equal(black.amount, 360)
  assert.equal(summary.totals.amount, 360)
  assert.equal(summary.totals.pricedRows, 1)
  assert.equal(summary.totals.unpricedRows, 1)
  assert.equal(summary.totals.unpricedQuantity, 2)
})

test('R6 月度结算：数量 × 客户单价，按客户与型号汇总，未定价单列', async () => {
  const { store } = await freshStore()
  await store.ensureCustomer('a')
  await store.ensureCustomer('b')
  await store.setPrice({ customer: 'a', model: 'b', unitPrice: 100 })
  await store.setPrice({ customer: 'b', model: 'b', unitPrice: 80, color: '黑色' })

  await store.recordOrders([{ customer: 'a', model: 'b', color: '黑色', size: '43', quantity: 3 }], { orderDate: '2026-10-02' })
  await store.recordOrders([{ customer: 'a', model: 'b', color: '白色', size: '42', quantity: 2 }], { orderDate: '2026-10-20' })
  await store.recordOrders([{ customer: 'b', model: 'b', color: '黑色', size: '41', quantity: 5 }], { orderDate: '2026-10-05' })
  // 跨月不应计入
  await store.recordOrders([{ customer: 'b', model: 'b', color: '黑色', size: '41', quantity: 9 }], { orderDate: '2026-11-01' })

  const settlement = store.monthlySettlement({ month: '2026-10' })
  assert.equal(settlement.month, '2026-10')
  assert.equal(settlement.totals.customers, 2)
  assert.equal(settlement.totals.quantity, 10)
  const a = settlement.customers.find((c) => c.customerName === 'a')
  assert.equal(a.quantity, 5)
  assert.equal(a.amount, 500)
  assert.equal(a.models[0].unitPrice, 100)
  const b = settlement.customers.find((c) => c.customerName === 'b')
  assert.equal(b.amount, 400)
  assert.equal(settlement.totals.amount, 900)
  assert.equal(settlement.totals.unpricedQuantity, 0)
})

test('R6 月度结算：没有单价的客户被标记为未定价，金额不计入', async () => {
  const { store } = await freshStore()
  await store.ensureCustomer('a')
  await store.recordOrders([{ customer: 'a', model: 'x', color: '黑色', size: '43', quantity: 4 }], { orderDate: '2026-10-03' })
  const settlement = store.monthlySettlement({ month: '2026-10' })
  assert.equal(settlement.totals.amount, 0)
  assert.equal(settlement.totals.unpricedQuantity, 4)
  assert.deepEqual(settlement.totals.unpricedCustomers, ['a'])
})

test('数据持久化：重新打开同一目录能看到之前的数据', async () => {
  const { store, dir } = await freshStore()
  await store.ensureCustomer('a')
  await store.recordOrders([{ customer: 'a', model: 'b', color: '黑色', size: '43', quantity: 1 }], { orderDate: '2026-10-12' })
  const reopened = new WmsStore({ dataDir: dir })
  await reopened.init()
  assert.equal(reopened.listCustomers().length, 1)
  assert.equal(reopened.listOrders({ date: '2026-10-12' }).length, 1)
})

test('各日期工具函数：localDate / monthOf', () => {
  assert.equal(localDate(new Date('2026-10-12T23:30:00')), '2026-10-12')
  assert.equal(monthOf(new Date('2026-10-12T23:30:00')), '2026-10')
  assert.equal(monthOf('2026-03-05'), '2026-03')
})

test('入参校验：日期 / 月份 / 数量不合法会报错', async () => {
  const { store } = await freshStore()
  await store.ensureCustomer('a')
  assert.throws(() => store.dailySummary({ date: '2026-13-01' }), /日期不合法/)
  assert.throws(() => store.monthlySettlement({ month: '2026-13' }), /月份不合法/)
  await assert.rejects(
    store.recordOrders([{ customer: 'a', model: 'b', color: '黑色', size: '43', quantity: 0 }], { orderDate: '2026-10-12' }),
    /数量/,
  )
  await assert.rejects(
    store.recordOrders([{ customer: 'a', model: 'b', color: '', size: '43', quantity: 1 }], { orderDate: '2026-10-12' }),
    /颜色/,
  )
})

test('R3 待补录：同一条消息不重复入队，可标记为已处理', async () => {
  const { store } = await freshStore()
  const first = await store.addPending({ chatId: 'c1', rawText: 'a客户 黑色三双', missing: ['size'] })
  const second = await store.addPending({ chatId: 'c1', rawText: 'a客户 黑色三双', missing: ['size'] })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(store.listPending().length, 1)
  await store.resolvePending(first.pending.id, { note: '客户已补充' })
  assert.equal(store.listPending().length, 0)
  assert.equal(store.listPending({ status: 'all' }).length, 1)
})

test('聊天上下文：同一 chat 的第二条消息可以不再写客户名', async () => {
  const { store } = await freshStore()
  const { customer } = await store.ensureCustomer('a', ['a客户'])
  assert.equal(store.chatCustomer('chat-1'), undefined)
  await store.setChatCustomer('chat-1', customer.id)
  assert.equal(store.chatCustomer('chat-1')?.name, 'a')
})
