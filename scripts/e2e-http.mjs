#!/usr/bin/env node
/**
 * scripts/e2e-http.mjs — 对「正在运行的 DSH Web 实例」做端到端验收
 *
 * 默认只做只读检查（不写业务数据）：健康、面板、汇总、结算、PDF、角色权限。
 * 加 --write 会真的向线上库写入一条测试订单（用于验证消息接入链路），
 * 测试客户名以 `e2e-` 前缀标记，便于人工识别。
 *
 * 用法：
 *   node scripts/e2e-http.mjs
 *   node scripts/e2e-http.mjs --base http://127.0.0.1:3080 --write
 */
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const BASE = option('--base', process.env.WMS_BASE_URL || 'http://127.0.0.1:3080').replace(/\/$/, '')
const WRITE = flag('--write')
const DATE = option('--date', new Date().toLocaleDateString('sv-SE'))
const MONTH = DATE.slice(0, 7)

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

async function req(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) })
  const buffer = Buffer.from(await res.arrayBuffer())
  const type = res.headers.get('content-type') || ''
  return { status: res.status, type, buffer, text: buffer.toString('utf8') }
}

const json = async (path, init) => JSON.parse((await req(path, init)).text)

try {
  const health = await json('/api/wms/health')
  record('GET /api/wms/health', health.ok === true, `build=${health.build} data=${health.dataDir}`)
  record('中文字体可嵌入', Boolean(health.cjkFont), health.cjkFont || '未找到')
  record('三角色注册', Object.keys(health.roles || {}).length === 3, Object.keys(health.roles || {}).join('/'))

  const panel = await req('/api/wms/panel')
  record('GET /api/wms/panel', panel.status === 200 && /text\/html/.test(panel.type), `${panel.buffer.length} 字节`)
  record('面板含三大功能块', /当日汇总/.test(panel.text) && /月度结算/.test(panel.text) && /单价管理/.test(panel.text))

  const overview = await json('/api/wms/overview')
  record('GET /api/wms/overview', overview.ok === true, `客户 ${overview.customers} / 订单行 ${overview.orders}`)

  const daily = await json(`/api/wms/daily?date=${DATE}`)
  record('GET /api/wms/daily', daily.ok === true, `${daily.rows.length} 行 / ${daily.totals.quantity} 双`)

  const settlement = await json(`/api/wms/settlement?month=${MONTH}`)
  record('GET /api/wms/settlement', settlement.ok === true, `应收 ¥${settlement.totals.amount}`)

  const outbound = await req(`/api/wms/outbound.pdf?date=${DATE}`)
  record(
    'GET /api/wms/outbound.pdf',
    outbound.status === 200 && outbound.type === 'application/pdf' && outbound.buffer.subarray(0, 5).toString('latin1') === '%PDF-',
    `${outbound.buffer.length} 字节`,
  )

  const settlementPdf = await req(`/api/wms/settlement.pdf?month=${MONTH}`)
  record(
    'GET /api/wms/settlement.pdf',
    settlementPdf.status === 200 && settlementPdf.type === 'application/pdf',
    `${settlementPdf.buffer.length} 字节`,
  )

  const financeOutbound = await req(`/api/wms/outbound.pdf?date=${DATE}`, { headers: { 'x-wms-role': 'finance' } })
  record('财务导出出库单被拒绝', financeOutbound.status === 403, `HTTP ${financeOutbound.status}`)

  const warehouseSettlement = await req(`/api/wms/settlement?month=${MONTH}`, { headers: { 'x-wms-role': 'warehouse' } })
  record('库管查看结算被拒绝', warehouseSettlement.status === 403, `HTTP ${warehouseSettlement.status}`)

  if (WRITE) {
    const customer = `e2e-${Date.now().toString(36)}`
    const ingested = await json('/api/wms/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${customer}客户 型号e2e 黑色2双42码`, chat_id: 'e2e-verify', order_date: DATE }),
    })
    record('POST /api/wms/ingest（写库）', ingested.action === 'recorded', `订单 ${ingested.orderIds?.length ?? 0} 行`)

    const retry = await json('/api/wms/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '在吗', chat_id: 'e2e-verify', order_date: DATE }),
    })
    record('无法解析时返回 retry 话术', retry.action === 'retry' && /标准格式/.test(retry.reply), retry.reply.split('\n')[0].slice(0, 40))
  } else {
    console.log('SKIP  写入类检查（加 --write 才会真的写数据）')
  }
} catch (err) {
  record('连接 DSH Web 实例', false, String(err?.message ?? err))
}

const failed = results.filter((item) => !item.ok)
console.log('')
console.log(`合计 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length) process.exitCode = 1
