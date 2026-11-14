import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, ROLES } from '../lib/index.js'
import { createMockCtx, invokeRoute, invokeTool } from './mock-ctx.mjs'

const DATE = '2026-10-12'
const MONTH = '2026-10'

const EXPECTED_TOOLS = [
  'wms_ingest_message',
  'wms_record_order',
  'wms_upsert_customer',
  'wms_list_customers',
  'wms_set_price',
  'wms_list_prices',
  'wms_daily_summary',
  'wms_export_outbound',
  'wms_monthly_settlement',
  'wms_export_settlement',
  'wms_list_pending',
]

const EXPECTED_ROUTES = [
  '/api/wms/panel',
  '/api/wms/health',
  '/api/wms/overview',
  '/api/wms/customers',
  '/api/wms/prices',
  '/api/wms/orders',
  '/api/wms/daily',
  '/api/wms/outbound.pdf',
  '/api/wms/settlement',
  '/api/wms/settlement.pdf',
  '/api/wms/pending',
  '/api/wms/pending/resolve',
  '/api/wms/ingest',
]

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wms-plugin-'))
  const mock = createMockCtx()
  apply(mock.ctx, { dataDir: dir, company: '测试鞋业' })
  return { ...mock, dir }
}

const get = (app, url, headers = {}) => invokeRoute(app.routes.get(url.split('?')[0]), { method: 'GET', url, headers })
const post = (app, url, body, headers = {}) =>
  invokeRoute(app.routes.get(url.split('?')[0]), { method: 'POST', url, headers, body })

const ingest = (app, body) => post(app, '/api/wms/ingest', body)

const tool = (app, name) => {
  const definition = app.tools.get(name)
  assert.ok(definition, `工具未注册：${name}`)
  return definition
}

test('插件装配：11 个 agent 工具 + 13 条后台路由 + 系统提示段', async () => {
  const app = await setup()
  assert.deepEqual([...app.tools.keys()].sort(), [...EXPECTED_TOOLS].sort())
  for (const route of EXPECTED_ROUTES) assert.ok(app.routes.has(route), `缺少路由：${route}`)

  const section = app.sections.find((s) => s.name === 'wms:procurement')
  assert.ok(section, '缺少系统提示段 wms:procurement')
  assert.match(section.text, /wms_ingest_message/)
  assert.match(section.text, /标准格式/)
  assert.equal(typeof section.order, 'number')
})

test('R1 飞书消息接入：完整消息直接入库，多条消息数量自动累加', async () => {
  const app = await setup()

  const first = (await ingest(app, { text: 'a客户 型号b 黑色3双43码', chat_id: 'chat-1', order_date: DATE })).json()
  assert.equal(first.action, 'recorded')
  assert.equal(first.customer, 'a')
  assert.equal(first.orderIds.length, 1)
  assert.match(first.reply, /已登记/)

  const second = (await ingest(app, { text: 'a客户 型号b 黑色2双43码', chat_id: 'chat-1', order_date: DATE })).json()
  assert.equal(second.action, 'recorded')

  const daily = (await get(app, `/api/wms/daily?date=${DATE}`)).json()
  assert.equal(daily.rows.length, 1)
  assert.equal(daily.rows[0].quantity, 5)
  assert.equal(daily.rows[0].color, '黑色')
  assert.equal(daily.rows[0].size, '43')
  assert.equal(daily.totals.quantity, 5)

  const orders = (await get(app, `/api/wms/orders?date=${DATE}`)).json()
  assert.equal(orders.orders.length, 2)
})

test('R1 一条消息多个行项目 + 同一会话可省略客户名（聊天上下文）', async () => {
  const app = await setup()
  await ingest(app, { text: 'a客户 型号b 黑色3双43码', chat_id: 'chat-2', order_date: DATE })
  const followUp = (await ingest(app, { text: '再补两双白色55码的b款', chat_id: 'chat-2', order_date: DATE })).json()
  assert.equal(followUp.action, 'recorded')
  assert.equal(followUp.customer, 'a')

  const daily = (await get(app, `/api/wms/daily?date=${DATE}`)).json()
  const white = daily.rows.find((r) => r.color === '白色')
  assert.ok(white, '白色行应存在')
  assert.equal(white.quantity, 2)
  assert.equal(white.size, '55')
  assert.equal(daily.totals.quantity, 5)

  // 一条消息两行
  const multi = (await ingest(app, { text: 'a客户 b款 黑色1双41码 白色4双40码', chat_id: 'chat-3', order_date: DATE })).json()
  assert.equal(multi.action, 'recorded')
  assert.equal(multi.items.length, 2)
})

test('R2 解析失败：自动回复重述话术 + 进入待补录', async () => {
  const app = await setup()
  const result = (await ingest(app, { text: '在吗？想问下鞋子', chat_id: 'chat-x', order_date: DATE })).json()
  assert.equal(result.action, 'retry')
  assert.match(result.reply, /标准格式/)
  assert.match(result.reply, /a客户 型号b 黑色3双43码/)

  const pending = (await get(app, '/api/wms/pending')).json()
  assert.equal(pending.pending.length, 1)
  assert.equal(pending.pending[0].rawText, '在吗？想问下鞋子')
})

test('R3 字段不全：追问话术点名缺失字段，并留下待补录', async () => {
  const app = await setup()
  const result = (await ingest(app, { text: 'a客户 b款 黑色3双', chat_id: 'chat-y', order_date: DATE })).json()
  assert.equal(result.action, 'need_info')
  assert.deepEqual(result.missing, ['size'])
  assert.match(result.reply, /尺码/)
  assert.match(result.reply, /已识别/)
  const daily = (await get(app, `/api/wms/daily?date=${DATE}`)).json()
  assert.equal(daily.rows.length, 0, '字段不全时不应入库')
})

test('R3 客户信息补录：新客户提示补联系方式，补录后资料完整', async () => {
  const app = await setup()
  const result = (await ingest(app, { text: 'b客户 型号x 白色1双40码', chat_id: 'chat-z', order_date: DATE })).json()
  assert.equal(result.action, 'recorded')
  assert.match(result.reply, /联系方式/)

  let customers = (await get(app, '/api/wms/customers')).json().customers
  const created = customers.find((c) => c.name === 'b')
  assert.ok(created)
  assert.equal(created.profileComplete, false)

  const saved = await invokeTool(tool(app, 'wms_upsert_customer'), { name: 'b', contact: '13900000000', address: '温州' })
  assert.match(saved, /已更新客户/)
  customers = (await get(app, '/api/wms/customers')).json().customers
  const updated = customers.find((c) => c.name === 'b')
  assert.equal(updated.contact, '13900000000')
  assert.equal(updated.profileComplete, true)

  // 后台也能建档 / 补录
  const viaApi = (await post(app, '/api/wms/customers', { name: 'c', contact: '13800000000' }, { 'x-wms-role': 'admin' })).json()
  assert.equal(viaApi.ok, true)
})

test('R5 客户单价：按客户 + 型号维护，订单金额随单价计算', async () => {
  const app = await setup()
  const priced = await invokeTool(tool(app, 'wms_set_price'), { customer: 'a', model: 'b', unit_price: 120 })
  assert.match(priced, /120\.00/)

  await invokeTool(tool(app, 'wms_record_order'), {
    customer: 'a',
    model: 'b',
    color: '黑色',
    size: '43',
    quantity: 2,
    order_date: DATE,
  })
  const daily = (await get(app, `/api/wms/daily?date=${DATE}`)).json()
  assert.equal(daily.rows[0].unitPrice, 120)
  assert.equal(daily.rows[0].amount, 240)
  assert.equal(daily.totals.amount, 240)

  // 修改单价（同一客户 + 型号）而不是新增
  await post(app, '/api/wms/prices', { customer: 'a', model: 'b', unitPrice: 150 }, { 'x-wms-role': 'admin' })
  const prices = (await get(app, '/api/wms/prices')).json().prices
  assert.equal(prices.length, 1)
  assert.equal(prices[0].unitPrice, 150)

  const listed = await invokeTool(tool(app, 'wms_list_prices'), {})
  assert.match(listed, /150\.00/)
})

test('R4 每日汇总与出库：后台导出 PDF，同一份数据也能由 Agent 工具导出', async () => {
  const app = await setup()
  await ingest(app, { text: 'a客户 型号b 黑色3双43码', chat_id: 'chat-p', order_date: DATE })
  await post(app, '/api/wms/prices', { customer: 'a', model: 'b', unitPrice: 100 }, { 'x-wms-role': 'admin' })

  const res = await get(app, `/api/wms/outbound.pdf?date=${DATE}`)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/pdf')
  assert.equal(res.buffer.subarray(0, 5).toString('latin1'), '%PDF-')
  const text = res.buffer.toString('latin1')
  assert.match(text, /wms-outbound/)
  assert.match(text, new RegExp(`date=${DATE}`))
  assert.match(text, /qty=3/)

  const summary = (await get(app, `/api/wms/daily?date=${DATE}`)).json()
  assert.equal(summary.totals.amount, 300)

  const exported = await invokeTool(tool(app, 'wms_export_outbound'), { date: DATE })
  const match = exported.match(/(?:已生成出库单：)(.+\.pdf)/)
  assert.ok(match, `工具应返回文件路径：${exported}`)
  const stat = await fsp.stat(match[1])
  assert.ok(stat.size > 1000)
})

test('R6 月度结算：按「数量 × 客户单价」结算并导出 PDF', async () => {
  const app = await setup()
  await post(app, '/api/wms/prices', { customer: 'a', model: 'b', unitPrice: 100 }, { 'x-wms-role': 'admin' })
  await post(app, '/api/wms/prices', { customer: 'b', model: 'b', unitPrice: 80 }, { 'x-wms-role': 'admin' })
  await ingest(app, { text: 'a客户 型号b 黑色3双43码', chat_id: 'c-a', order_date: '2026-10-02' })
  await ingest(app, { text: 'a客户 型号b 白色2双42码', chat_id: 'c-a', order_date: '2026-10-20' })
  await ingest(app, { text: 'b客户 型号b 黑色5双41码', chat_id: 'c-b', order_date: '2026-10-05' })

  const settlement = (await get(app, `/api/wms/settlement?month=${MONTH}`)).json()
  assert.equal(settlement.totals.customers, 2)
  assert.equal(settlement.totals.quantity, 10)
  assert.equal(settlement.totals.amount, 5 * 100 + 5 * 80)
  const customerA = settlement.customers.find((c) => c.customerName === 'a')
  assert.equal(customerA.quantity, 5)
  assert.equal(customerA.amount, 500)

  const pdf = await get(app, `/api/wms/settlement.pdf?month=${MONTH}`)
  assert.equal(pdf.statusCode, 200)
  assert.equal(pdf.headers['content-type'], 'application/pdf')
  const text = pdf.buffer.toString('latin1')
  assert.match(text, /wms-settlement/)
  assert.match(text, /month=2026-10/)
  assert.match(text, /qty=10/)

  const agentView = await invokeTool(tool(app, 'wms_monthly_settlement'), { month: MONTH })
  assert.match(agentView, /应收 ¥900\.00/)
})

test('角色权限：管理员 / 库管 / 财务 各管一段，越权返回 403', async () => {
  const app = await setup()
  await ingest(app, { text: 'a客户 型号b 黑色3双43码', chat_id: 'c-r', order_date: DATE })

  // 库管：能导出出库单，不能结算、不能改客户
  assert.equal((await get(app, `/api/wms/outbound.pdf?date=${DATE}`, { 'x-wms-role': 'warehouse' })).statusCode, 200)
  assert.equal((await get(app, `/api/wms/settlement?month=${MONTH}`, { 'x-wms-role': 'warehouse' })).statusCode, 403)
  assert.equal(
    (await post(app, '/api/wms/customers', { name: 'w' }, { 'x-wms-role': 'warehouse' })).statusCode,
    403,
  )

  // 财务：能结算/导出结算单，不能导出出库单、不能改单价
  assert.equal((await get(app, `/api/wms/settlement?month=${MONTH}`, { 'x-wms-role': 'finance' })).statusCode, 200)
  assert.equal((await get(app, `/api/wms/settlement.pdf?month=${MONTH}`, { 'x-wms-role': 'finance' })).statusCode, 200)
  assert.equal((await get(app, `/api/wms/outbound.pdf?date=${DATE}`, { 'x-wms-role': 'finance' })).statusCode, 403)
  assert.equal(
    (await post(app, '/api/wms/prices', { customer: 'a', model: 'b', unitPrice: 1 }, { 'x-wms-role': 'finance' })).statusCode,
    403,
  )

  // 管理员：全部可做
  assert.equal((await post(app, '/api/wms/customers', { name: 'a' }, { 'x-wms-role': 'admin' })).statusCode, 200)
  assert.equal((await post(app, '/api/wms/prices', { customer: 'a', model: 'b', unitPrice: 90 }, { 'x-wms-role': 'admin' })).statusCode, 200)
  assert.deepEqual(Object.keys(ROLES).sort(), ['admin', 'finance', 'warehouse'])
})

test('后台面板：/api/wms/panel 返回可用 HTML，health 报告数据目录与字体', async () => {
  const app = await setup()
  const panel = await get(app, '/api/wms/panel')
  assert.equal(panel.statusCode, 200)
  assert.match(panel.headers['content-type'], /text\/html/)
  assert.match(panel.text, /鞋类采购报送管理系统/)
  assert.match(panel.text, /\/api\/wms/)

  const health = (await get(app, '/api/wms/health')).json()
  assert.equal(health.ok, true)
  assert.equal(health.dataDir, app.dir)
  assert.ok(health.roles.admin)
  assert.ok(health.overview)
})

test('概览：数字与业务数据一致', async () => {
  const app = await setup()
  await ingest(app, { text: 'a客户 型号b 黑色3双43码', chat_id: 'c-o', order_date: DATE })
  const overview = (await get(app, '/api/wms/overview')).json()
  assert.equal(overview.customers, 1)
  assert.equal(overview.orders, 1)
  assert.equal(overview.todayQuantity >= 0, true)
  assert.equal(typeof overview.recentEvents.length, 'number')
})

test('重启后数据仍在（同一数据目录重新装配插件）', async () => {
  const app = await setup()
  await ingest(app, { text: 'a客户 型号b 黑色3双43码', chat_id: 'c-persist', order_date: DATE })

  const restarted = createMockCtx()
  apply(restarted.ctx, { dataDir: app.dir })
  const daily = (await invokeRoute(restarted.routes.get('/api/wms/daily'), { method: 'GET', url: `/api/wms/daily?date=${DATE}` })).json()
  assert.equal(daily.totals.quantity, 3)
  const customers = (await invokeRoute(restarted.routes.get('/api/wms/customers'), { method: 'GET', url: '/api/wms/customers' })).json().customers
  assert.equal(customers.length, 1)
})

test('需求边界：不含库存扣减 / 订单修改作废 / 收款折扣运费 / 定时汇总', async () => {
  const app = await setup()
  const paths = [...app.routes.keys()].join(' ')
  assert.doesNotMatch(paths, /stock|inventory|void|cancel|delete|discount|freight|refund/i)
  assert.equal(app.tools.has('wms_delete_order'), false)
  assert.equal(app.tools.has('wms_update_order'), false)

  const { WmsStore } = await import('../lib/store.js')
  for (const method of ['updateOrder', 'deleteOrder', 'cancelOrder', 'stockOut', 'deductStock']) {
    assert.equal(typeof WmsStore.prototype[method], 'undefined', `不应实现 ${method}`)
  }
})
