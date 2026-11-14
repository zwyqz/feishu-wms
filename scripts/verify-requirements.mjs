#!/usr/bin/env node
/**
 * scripts/verify-requirements.mjs
 *
 * 逐条对照《鞋类采购报送管理系统 需求文档》做自动化验证，输出需求追溯矩阵。
 * 不依赖外部服务：用最小 Cordis 宿主替身装配插件，走的都是真实代码路径。
 *
 * 用法：node scripts/verify-requirements.mjs
 * 退出码：全部通过 0，任一失败 1
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply, ROLES } from '../lib/index.js'
import { findCjkFont } from '../lib/pdf.js'
import { parseMessage, SUGGESTED_FORMAT } from '../lib/parse.js'
import { WmsStore } from '../lib/store.js'
import { createMockCtx, invokeRoute, invokeTool } from '../test/mock-ctx.mjs'

const DATE = '2026-10-12'
const MONTH = '2026-10'
const results = []

async function check(id, title, fn) {
  try {
    const detail = await fn()
    results.push({ id, title, ok: true, detail: detail ?? '' })
  } catch (err) {
    results.push({ id, title, ok: false, detail: String(err?.message ?? err).split('\n')[0] })
  }
}

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wms-verify-'))
  const mock = createMockCtx()
  apply(mock.ctx, { dataDir: dir, company: '验收测试鞋业' })
  return { ...mock, dir }
}

const get = (app, url, headers = {}) => invokeRoute(app.routes.get(url.split('?')[0]), { method: 'GET', url, headers })
const post = (app, url, body, headers = {}) =>
  invokeRoute(app.routes.get(url.split('?')[0]), { method: 'POST', url, headers, body })
const ingest = (app, body) => post(app, '/api/wms/ingest', body)
const tool = (app, name) => {
  const definition = app.tools.get(name)
  assert.ok(definition, `工具缺失：${name}`)
  return definition
}

// ------------------------------------------------------------------ 场景

const app = await setup()

await check('R1.1', '飞书采购消息接入并生成结构化订单', async () => {
  const res = (await ingest(app, { text: 'a客户 型号b 黑色3双43码', chat_id: 'chat-1', order_date: DATE })).json()
  assert.equal(res.action, 'recorded')
  assert.equal(res.customer, 'a')
  assert.equal(res.items.length, 1)
  assert.deepEqual(
    { model: res.items[0].model, color: res.items[0].color, size: res.items[0].size, quantity: res.items[0].quantity },
    { model: 'b', color: '黑色', size: '43', quantity: 3 },
  )
  return '客户 a / 型号 b / 黑色 / 3 双 / 43 码 → 已入库'
})

await check('R1.2', '格式不固定的消息也能解析（「再补两双白色55码的b款」）', async () => {
  const parsed = parseMessage('再补两双白色55码的b款')
  assert.equal(parsed.items[0].model, 'b')
  assert.equal(parsed.items[0].color, '白色')
  assert.equal(parsed.items[0].size, '55')
  assert.equal(parsed.items[0].quantity, 2)
  const res = (await ingest(app, { text: '再补两双白色55码的b款', chat_id: 'chat-1', order_date: DATE })).json()
  assert.equal(res.action, 'recorded', JSON.stringify(res))
  return '中文数字 / 字段乱序 / 省略客户名（会话上下文）均识别'
})

await check('R1.3', '五个结构化字段齐全：客户名称 / 鞋型号 / 颜色 / 数量 / 尺码', async () => {
  const orders = (await get(app, `/api/wms/orders?date=${DATE}`)).json().orders
  assert.ok(orders.length >= 2)
  for (const key of ['customerName', 'model', 'color', 'size', 'quantity']) assert.ok(key in orders[0], `缺少字段 ${key}`)
  return `订单行 ${orders.length} 条，字段齐全`
})

await check('R1.4', '同一客户同一天多条消息，数量自动累加', async () => {
  await ingest(app, { text: 'a客户 型号b 黑色2双43码', chat_id: 'chat-1', order_date: DATE })
  const daily = (await get(app, `/api/wms/daily?date=${DATE}`)).json()
  const black = daily.rows.find((r) => r.color === '黑色' && r.size === '43')
  assert.equal(black.quantity, 5)
  assert.equal(daily.totals.quantity, 7)
  return '黑色 43 码：3 + 2 = 5 双；当日合计 7 双'
})

await check('R2.1', '无法解析时给出重新描述提示 + 标准示例格式', async () => {
  const res = (await ingest(app, { text: '你好，问一下鞋子怎么卖', chat_id: 'chat-9', order_date: DATE })).json()
  assert.equal(res.action, 'retry')
  assert.match(res.reply, /标准格式/)
  assert.ok(res.reply.includes(SUGGESTED_FORMAT))
  return '返回 action=retry，话术含标准示例'
})

await check('R2.2', '解析失败的消息进入待补录队列，供后续跟进', async () => {
  const pending = (await get(app, '/api/wms/pending')).json().pending
  assert.ok(pending.length >= 1)
  assert.equal(pending[0].status, 'open')
  return `待补录 ${pending.length} 条`
})

await check('R3.1', '后台可维护客户档案（新增 / 补录 / 查询）', async () => {
  const created = (await post(app, '/api/wms/customers', { name: '张三', contact: '13800000000', address: '杭州' })).json()
  assert.equal(created.created, true)
  const updated = (await post(app, '/api/wms/customers', { name: '张三', address: '温州' })).json()
  assert.equal(updated.created, false)
  const list = (await get(app, '/api/wms/customers')).json().customers
  const target = list.find((c) => c.name === '张三')
  assert.equal(target.contact, '13800000000')
  assert.equal(target.address, '温州')
  return '新增 / 同名更新 / 列表查询均正常'
})

await check('R3.2', '客户信息不全时 Agent 通过飞书追问（不落库，避免脏数据）', async () => {
  const before = (await get(app, `/api/wms/daily?date=${DATE}`)).json().totals.quantity
  const res = (await ingest(app, { text: 'b客户 型号x 白色2双', chat_id: 'chat-2', order_date: DATE })).json()
  assert.equal(res.action, 'need_info')
  assert.ok(res.missing.includes('size'))
  assert.match(res.reply, /尺码/)
  const after = (await get(app, `/api/wms/daily?date=${DATE}`)).json().totals.quantity
  assert.equal(after, before, '字段不全时不应入库')
  return '缺尺码 → 追问「尺码」，未产生订单'
})

await check('R3.3', '客户在聊天中补录后自动入库（联系方式补全）', async () => {
  const recorded = (await ingest(app, { text: 'c客户 型号y 黑色1双40码', chat_id: 'chat-3', order_date: DATE })).json()
  assert.match(recorded.reply, /联系方式/)
  let customers = (await get(app, '/api/wms/customers')).json().customers
  assert.equal(customers.find((c) => c.name === 'c').profileComplete, false)

  await invokeTool(tool(app, 'wms_upsert_customer'), { name: 'c', contact: '13900000000' })
  customers = (await get(app, '/api/wms/customers')).json().customers
  assert.equal(customers.find((c) => c.name === 'c').profileComplete, true)
  return '新建档 → 提示补联系方式 → 补录后 profileComplete=true'
})

await check('R4.1', '后台不定时汇总当天数据：客户 × 型号 × 颜色 × 尺码 × 数量', async () => {
  const daily = (await get(app, `/api/wms/daily?date=${DATE}`)).json()
  assert.ok(daily.rows.length >= 2)
  for (const row of daily.rows) {
    for (const key of ['customerName', 'model', 'color', 'size', 'quantity']) assert.ok(key in row, `汇总缺少 ${key}`)
  }
  return `当日 ${daily.rows.length} 行 / ${daily.totals.quantity} 双 / 客户 ${daily.totals.customers} 家`
})

await check('R4.2', '按钮导出 PDF 出库单（后台路由 + Agent 工具两条路径）', async () => {
  const pdf = await get(app, `/api/wms/outbound.pdf?date=${DATE}`)
  assert.equal(pdf.statusCode, 200)
  assert.equal(pdf.headers['content-type'], 'application/pdf')
  assert.equal(pdf.buffer.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.match(pdf.buffer.toString('latin1'), /wms-outbound/)

  const exported = await invokeTool(tool(app, 'wms_export_outbound'), { date: DATE })
  const file = exported.match(/已生成出库单：(.+\.pdf)/)?.[1]
  assert.ok(file, exported)
  const stat = await fsp.stat(file)
  assert.ok(stat.size > 1000)
  return `HTTP PDF ${pdf.buffer.length} 字节；工具落盘 ${stat.size} 字节`
})

await check('R5.1', '客户单价体系：按「客户 + 型号」新增 / 修改 / 查询', async () => {
  const created = await invokeTool(tool(app, 'wms_set_price'), { customer: 'a', model: 'b', unit_price: 120 })
  assert.match(created, /120\.00/)
  await invokeTool(tool(app, 'wms_set_price'), { customer: 'a', model: 'b', unit_price: 125 })
  const prices = (await get(app, '/api/wms/prices')).json().prices
  const row = prices.find((p) => p.customerName === 'a' && p.model === 'b')
  assert.equal(row.unitPrice, 125)
  assert.equal(prices.filter((p) => p.customerName === 'a' && p.model === 'b').length, 1)

  const listed = await invokeTool(tool(app, 'wms_list_prices'), { customer: 'a' })
  assert.match(listed, /125\.00/)
  return '新增 120 → 修改 125（同一条，不重复）；查询可见'
})

await check('R5.2', '订单金额 = 数量 × 该客户对应单价', async () => {
  const daily = (await get(app, `/api/wms/daily?date=${DATE}`)).json()
  const black = daily.rows.find((r) => r.customerName === 'a' && r.model === 'b' && r.color === '黑色' && r.size === '43')
  assert.equal(black.unitPrice, 125)
  assert.equal(black.amount, 625)
  return 'a · b · 黑色 · 43：5 双 × 125 = 625'
})

await check('R6.1', '每月自动汇总各客户采购数量', async () => {
  const settlement = (await get(app, `/api/wms/settlement?month=${MONTH}`)).json()
  assert.ok(settlement.customers.length >= 2)
  for (const customer of settlement.customers) assert.ok(customer.quantity > 0)
  return `${settlement.customers.length} 家客户 / ${settlement.totals.quantity} 双`
})

await check('R6.2', '月度结算金额按「数量 × 客户单价」计算并可导出 PDF', async () => {
  const settlement = (await get(app, `/api/wms/settlement?month=${MONTH}`)).json()
  for (const customer of settlement.customers) {
    const computed = customer.models.reduce((sum, model) => sum + model.quantity * (model.unitPrice ?? 0), 0)
    assert.ok(Math.abs(computed - customer.amount) < 0.01, `${customer.customerName} 金额不一致`)
  }
  const pdf = await get(app, `/api/wms/settlement.pdf?month=${MONTH}`)
  assert.equal(pdf.statusCode, 200)
  assert.equal(pdf.headers['content-type'], 'application/pdf')
  assert.match(pdf.buffer.toString('latin1'), /wms-settlement/)
  return `应收 ¥${settlement.totals.amount}；PDF ${pdf.buffer.length} 字节`
})

await check('ROLE.1', '管理员可维护客户与单价', async () => {
  assert.deepEqual(Object.keys(ROLES).sort(), ['admin', 'finance', 'warehouse'])
  const res = await post(app, '/api/wms/customers', { name: 'admin-测试' }, { 'x-wms-role': 'admin' })
  assert.equal(res.statusCode, 200)
  return '客户建档 200'
})

await check('ROLE.2', '库管可汇总 / 导出出库单，不能做结算', async () => {
  const ok = await get(app, `/api/wms/outbound.pdf?date=${DATE}`, { 'x-wms-role': 'warehouse' })
  assert.equal(ok.statusCode, 200)
  const denied = await get(app, `/api/wms/settlement?month=${MONTH}`, { 'x-wms-role': 'warehouse' })
  assert.equal(denied.statusCode, 403)
  return '出库单 200 / 结算 403'
})

await check('ROLE.3', '财务可结算 / 导出结算单，不能导出出库单或改单价', async () => {
  const ok = await get(app, `/api/wms/settlement.pdf?month=${MONTH}`, { 'x-wms-role': 'finance' })
  assert.equal(ok.statusCode, 200)
  const deniedOutbound = await get(app, `/api/wms/outbound.pdf?date=${DATE}`, { 'x-wms-role': 'finance' })
  assert.equal(deniedOutbound.statusCode, 403)
  const deniedPrice = await post(app, '/api/wms/prices', { customer: 'a', model: 'b', unitPrice: 1 }, { 'x-wms-role': 'finance' })
  assert.equal(deniedPrice.statusCode, 403)
  return '结算单 200 / 出库单 403 / 改价 403'
})

await check('FLOW', '端到端业务流程：消息 → 解析 → 入库 → 汇总 → 出库 PDF → 结算 → 结算 PDF', async () => {
  const fresh = await setup()
  await ingest(fresh, { text: 'd客户 型号z 黑色4双42码', chat_id: 'flow-1', order_date: DATE })
  await ingest(fresh, { text: '再补1双白色41码的z款', chat_id: 'flow-1', order_date: DATE })
  await post(fresh, '/api/wms/prices', { customer: 'd', model: 'z', unitPrice: 99.5 })
  const daily = (await get(fresh, `/api/wms/daily?date=${DATE}`)).json()
  assert.equal(daily.totals.quantity, 5)
  assert.equal(daily.totals.amount, 497.5)
  const outbound = await get(fresh, `/api/wms/outbound.pdf?date=${DATE}`)
  const settlement = (await get(fresh, `/api/wms/settlement?month=${MONTH}`)).json()
  assert.equal(settlement.totals.amount, 497.5)
  const settlementPdf = await get(fresh, `/api/wms/settlement.pdf?month=${MONTH}`)
  assert.equal(outbound.statusCode, 200)
  assert.equal(settlementPdf.statusCode, 200)
  return '5 双 / ¥497.50，出库单与结算单 PDF 均生成'
})

await check('EXCL', '暂不包含项确实没有实现（库存扣减 / 订单改废 / 收款折扣运费 / 定时汇总）', async () => {
  const paths = [...app.routes.keys()].join(' ')
  assert.doesNotMatch(paths, /stock|inventory|void|cancel|delete|discount|freight|refund|schedule|cron/i)
  const toolNames = [...app.tools.keys()].join(' ')
  assert.doesNotMatch(toolNames, /stock|inventory|void|cancel|delete|discount|freight|refund/i)
  for (const method of ['updateOrder', 'deleteOrder', 'cancelOrder', 'stockOut', 'deductStock']) {
    assert.equal(typeof WmsStore.prototype[method], 'undefined')
  }
  const store = new WmsStore({ dataDir: path.join(app.dir, 'probe') })
  await store.init()
  assert.equal(store.overview().pending, 0)
  return '路由 / 工具 / 数据层均无这些能力'
})

await check('UI', '后台面板与 DSH 设置页入口可用', async () => {
  const panel = await get(app, '/api/wms/panel')
  assert.equal(panel.statusCode, 200)
  assert.match(panel.text, /鞋类采购报送管理系统/)
  assert.match(panel.text, /月度结算/)
  assert.match(panel.text, /出库单/)
  const health = (await get(app, '/api/wms/health')).json()
  assert.equal(health.ok, true)
  return `面板 200；中文字体：${path.basename(health.cjkFont || '（未找到）')}`
})

await check('DEPLOY', '插件可被 DSH 加载的前提齐备（manifest / patch / 依赖）', async () => {
  const pkg = JSON.parse(await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-feishu-wms')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.main, './lib/client.js')
  assert.ok(pkg.dependencies.pdfkit)
  assert.ok(findCjkFont(), '应能探测到可嵌入的中文字体')
  const patch = await fsp.readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /dsh-feishu-wms/)
  return `${pkg.name}@${pkg.version}`
})

// ------------------------------------------------------------------ 输出

const widthOf = (text) => [...String(text)].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 2 : 1), 0)

const pad = (text, width) => {
  let s = String(text)
  if (widthOf(s) > width - 1) {
    const chars = [...s]
    while (chars.length > 1 && widthOf(`${chars.join('')}…`) > width - 1) chars.pop()
    s = `${chars.join('')}…`
  }
  return s + ' '.repeat(Math.max(0, width - widthOf(s)))
}

console.log('')
console.log('鞋类采购报送管理系统 · 需求追溯矩阵')
console.log('='.repeat(110))
console.log(`${pad('编号', 9)}${pad('状态', 7)}${pad('需求点', 50)}验证方式`)
console.log('-'.repeat(110))
for (const item of results) {
  console.log(`${pad(item.id, 9)}${pad(item.ok ? 'PASS' : 'FAIL', 7)}${pad(item.title, 50)}${item.detail}`)
}
const passed = results.filter((item) => item.ok).length
console.log('-'.repeat(110))
console.log(`合计 ${results.length} 项：通过 ${passed}，失败 ${results.length - passed}`)
console.log('')

if (passed !== results.length) {
  console.error('存在未通过的需求项，请查看上面的 FAIL 行。')
  process.exitCode = 1
}
