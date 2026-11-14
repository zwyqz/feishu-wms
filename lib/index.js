/**
 * dsh-feishu-wms — 鞋类采购报送管理系统（Host 插件入口）
 *
 * 结构：
 *   lib/index.js    装配：存储、工具、HTTP 路由、角色权限、系统提示
 *   lib/store.js    数据层（客户 / 单价 / 订单 / 汇总 / 结算 / 待补录）
 *   lib/parse.js    采购消息的确定性语义解析（Agent 的前置预解析器）
 *   lib/pdf.js      出库单与月度结算单 PDF
 *   lib/panel.html  后台管理面板
 *
 * 数据目录：$WMS_DATA_DIR 或 ~/.dsh/feishu-wms
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildFollowUp, buildRetryReply, parseMessage, SUGGESTED_FORMAT } from './parse.js'
import { renderOutboundPdf, renderSettlementPdf, writePdfToFile, findCjkFont } from './pdf.js'
import { isValidDate, isValidMonth, localDate, monthOf, WmsStore } from './store.js'

export const name = 'feishu-wms'
export const inject = ['tools', 'webServer']

const BUILD = 'wms-0.1.0'
const log = (...args) => console.log('[feishu-wms]', ...args)

// ---------------------------------------------------------------- roles

export const ROLES = {
  admin: {
    label: '管理员',
    capabilities: [
      'overview:read',
      'customer:read',
      'customer:write',
      'price:read',
      'price:write',
      'order:read',
      'order:write',
      'daily:read',
      'outbound:export',
      'settlement:read',
      'settlement:export',
      'pending:read',
      'pending:write',
    ],
  },
  warehouse: {
    label: '库管',
    capabilities: ['overview:read', 'customer:read', 'price:read', 'order:read', 'daily:read', 'outbound:export', 'pending:read'],
  },
  finance: {
    label: '财务',
    capabilities: ['overview:read', 'customer:read', 'price:read', 'order:read', 'settlement:read', 'settlement:export'],
  },
}

export function can(role, capability) {
  const spec = ROLES[role] ?? ROLES.admin
  return spec.capabilities.includes(capability)
}

// ---------------------------------------------------------------- config

function resolvePaths(config = {}) {
  const dataDir = path.resolve(
    process.env.WMS_DATA_DIR || config.dataDir || path.join(os.homedir(), '.dsh', 'feishu-wms'),
  )
  const outDir = path.resolve(process.env.WMS_OUT_DIR || config.outDir || path.join(dataDir, 'exports'))
  return { dataDir, outDir }
}

// ---------------------------------------------------------------- helpers

const json = (res, status, payload) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    try {
      return Object.fromEntries(new URLSearchParams(text))
    } catch {
      return {}
    }
  }
}

const roleOf = (req) => {
  const header = String(req.headers['x-wms-role'] ?? req.headers['X-WMS-Role'] ?? '').trim()
  return ROLES[header] ? header : 'admin'
}

const safeFilename = (name) => name.replace(/[\\/:*?"<>|]/g, '_')

// ---------------------------------------------------------------- text replies

const money = (n) => Number(n ?? 0).toFixed(2)

function describeItems(items, store) {
  return items
    .map((item) => {
      const price = store.priceFor(item.customerId, item.model, item.color, item.orderDate ?? item.date ?? localDate())
      const amount = price === null ? '待定价' : `¥${money(price)}/双，小计 ¥${money(price * item.quantity)}`
      return `· ${item.model} ${item.color} ${item.size}码 × ${item.quantity} 双（${amount}）`
    })
    .join('\n')
}

/**
 * 核心入站逻辑：一条采购消息 → 解析 → 入库 / 追问 / 提示重述
 * @returns {Promise<{action:'recorded'|'need_info'|'retry', reply:string, parsed:object, orders?:object[], customer?:object, pending?:object}>}
 */
export async function ingestMessage(store, input = {}) {
  const text = String(input.text ?? '').trim()
  const chatId = String(input.chatId ?? input.chat_id ?? '')
  const messageId = String(input.messageId ?? input.message_id ?? '')
  const orderDate = input.orderDate || input.order_date || localDate()
  if (!isValidDate(orderDate)) throw new Error(`日期不合法：${orderDate}`)

  const knownCustomers = store.listCustomers().flatMap((c) => [c.name, ...(c.aliases ?? [])]).filter(Boolean)
  const parsed = parseMessage(text, { knownCustomers })

  // 聊天上下文：这条消息没写客户名时，沿用该会话最近一次报单的客户
  if (!parsed.customerName && chatId) {
    const remembered = store.chatCustomer(chatId)
    if (remembered) {
      parsed.customerName = remembered.name
      parsed.customerAliases = []
      parsed.missing = parsed.missing.filter((key) => key !== 'customer')
    }
  }

  if (!parsed.items.length) {
    const pending = await store.addPending({ chatId, messageId, rawText: text, missing: ['all'] })
    return {
      action: 'retry',
      parsed,
      pending: pending.pending,
      reply: [
        buildRetryReply(parsed),
        '已把这条消息记入待补录，稍后可以继续补充。',
      ].join('\n'),
    }
  }

  if (parsed.missing.length) {
    const pending = await store.addPending({
      chatId,
      messageId,
      rawText: text,
      missing: parsed.missing,
      customerName: parsed.customerName,
    })
    const understood = parsed.items
      .map((item) => {
        const bits = [item.model || '（型号?）', item.color || '（颜色?）', item.size ? `${item.size}码` : '（尺码?）', `${item.quantity || '?'} 双`]
        return `· ${bits.join(' ')}`
      })
      .join('\n')
    return {
      action: 'need_info',
      parsed,
      pending: pending.pending,
      reply: [
        parsed.customerName ? `客户：${parsed.customerName}` : '还没识别出客户名称。',
        understood ? `已识别：\n${understood}` : '',
        buildFollowUp(parsed),
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  const { customer, created } = await store.ensureCustomer(parsed.customerName, parsed.customerAliases ?? [])
  await store.setChatCustomer(chatId, customer.id)
  const lines = parsed.items.map((item) => ({
    customerId: customer.id,
    model: item.model,
    color: item.color,
    size: item.size,
    quantity: item.quantity,
  }))
  const orders = await store.recordOrders(lines, {
    orderDate,
    chatId,
    messageId,
    rawText: text,
    source: 'feishu',
  })
  const total = orders.reduce((sum, o) => sum + o.quantity, 0)
  const amount = orders.reduce((sum, o) => sum + (o.amount ?? 0), 0)
  const unpriced = orders.filter((o) => o.unitPrice === null).length
  const needContact = !customer.contact

  const replyLines = [
    `✅ 已登记 ${customer.name} 的订单（${orderDate}）：`,
    describeItems(orders, store),
    `合计 ${total} 双${unpriced ? `，其中 ${unpriced} 行待定价` : `，金额合计 ¥${money(amount)}`}`,
  ]
  if (created) replyLines.push(`这是新客户，已自动建档。`)
  if (needContact) replyLines.push(`请补充 ${customer.name} 的联系方式（电话或微信），回复一条消息即可完成补录。`)
  return { action: 'recorded', parsed, orders, customer, reply: replyLines.join('\n') }
}

// ---------------------------------------------------------------- plugin

export function apply(ctx, config = {}) {
  const { dataDir, outDir } = resolvePaths(config)
  const store = new WmsStore({ dataDir, outDir })
  const ready = store.init().catch((err) => {
    log(`store init failed: ${String(err?.message ?? err)}`)
    throw err
  })
  const withStore = async (fn) => {
    await ready
    return fn(store)
  }

  // ------------------------------------------------------------ tools

  const textTool = (spec) =>
    defineTool({
      ...spec,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    })

  ctx.tools.register(
    textTool({
      name: 'wms_ingest_message',
      description:
        '把客户在飞书发来的一条采购消息登记进系统：自动解析客户/型号/颜色/数量/尺码，完整则入库（同一客户多条消息自动累加），缺字段则返回追问话术，完全无法解析则返回重述话术。回复客户时直接把返回的 reply 发出去。',
      parameters: {
        text: { type: 'string', required: true, description: '客户原始消息文本' },
        chat_id: { type: 'string', description: '飞书 chat_id（用于补录追踪，可选）' },
        message_id: { type: 'string', description: '飞书 message_id（可选）' },
        order_date: { type: 'string', description: '订单日期 YYYY-MM-DD，缺省今天' },
      },
      async execute(args) {
        return withStore(async (s) => {
          const result = await ingestMessage(s, args)
          return JSON.stringify(
            {
              action: result.action,
              reply: result.reply,
              customer: result.customer?.name ?? result.parsed.customerName ?? '',
              items: result.parsed.items,
              missing: result.parsed.missing,
              orderIds: (result.orders ?? []).map((o) => o.id),
            },
            null,
            2,
          )
        })
      },
    }),
  )

  ctx.tools.register(
    textTool({
      name: 'wms_record_order',
      description: '直接登记一条结构化的订单行（客户已解析好时使用）。同一客户同日多条会自动累加。',
      parameters: {
        customer: { type: 'string', required: true, description: '客户名称或客户 ID' },
        model: { type: 'string', required: true, description: '鞋型号，如 b' },
        color: { type: 'string', required: true, description: '颜色，如 黑色' },
        size: { type: 'string', required: true, description: '尺码，如 43' },
        quantity: { type: 'number', required: true, description: '数量（双）' },
        order_date: { type: 'string', description: '订单日期 YYYY-MM-DD，缺省今天' },
        chat_id: { type: 'string', description: '飞书 chat_id（可选）' },
        raw_text: { type: 'string', description: '原始消息（可选，便于追溯）' },
      },
      async execute(args) {
        return withStore(async (s) => {
          const orderDate = args.order_date || localDate()
          if (!isValidDate(orderDate)) throw new Error(`日期不合法：${orderDate}`)
          const { customer } = await s.ensureCustomer(args.customer)
          const [order] = await s.recordOrders(
            [{ customerId: customer.id, model: args.model, color: args.color, size: args.size, quantity: args.quantity }],
            { orderDate, chatId: args.chat_id ?? '', rawText: args.raw_text ?? '', source: 'agent' },
          )
          const price = order.unitPrice === null ? '待定价' : `¥${money(order.unitPrice)}/双`
          return `已登记：${customer.name} ${order.model} ${order.color} ${order.size}码 × ${order.quantity} 双（${price}，${order.orderDate}）`
        })
      },
    }),
  )

  ctx.tools.register(
    textTool({
      name: 'wms_upsert_customer',
      description: '新建客户档案或补录客户信息（联系方式、地址、别名）。补录完成后自动入库。',
      parameters: {
        name: { type: 'string', required: true, description: '客户名称' },
        contact: { type: 'string', description: '联系方式（电话/微信）' },
        address: { type: 'string', description: '地址' },
        note: { type: 'string', description: '备注' },
        aliases: { type: 'string', description: '别名，多个用逗号分隔' },
      },
      async execute(args) {
        return withStore(async (s) => {
          const aliases = args.aliases ? String(args.aliases).split(/[,，、]/).map((a) => a.trim()).filter(Boolean) : undefined
          const { customer, created } = await s.upsertCustomer({
            name: args.name,
            contact: args.contact,
            address: args.address,
            note: args.note,
            aliases,
          })
          return `${created ? '已新建' : '已更新'}客户：${customer.name}（联系方式：${customer.contact || '未填写'}，地址：${customer.address || '未填写'}）`
        })
      },
    }),
  )

  ctx.tools.register(
    textTool({
      name: 'wms_list_customers',
      description: '查询客户档案，可按关键字过滤。',
      parameters: {
        query: { type: 'string', description: '关键字（名称/别名/联系方式）' },
      },
      async execute(args) {
        return withStore(async (s) => {
          const keyword = String(args.query ?? '').trim()
          const rows = s
            .listCustomers()
            .filter((c) => !keyword || `${c.name}${c.aliases.join('')}${c.contact}`.includes(keyword))
          if (!rows.length) return '没有匹配的客户。'
          return [
            `共 ${rows.length} 个客户：`,
            ...rows.map(
              (c) =>
                `· ${c.name}${c.aliases.length ? `（别名：${c.aliases.join('、')}）` : ''}　联系方式：${c.contact || '未填写'}　地址：${c.address || '未填写'}`,
            ),
          ].join('\n')
        })
      },
    }),
  )

  ctx.tools.register(
    textTool({
      name: 'wms_set_price',
      description: '维护客户单价：按「客户 + 型号（+颜色）」设定单价，可指定生效日期。',
      parameters: {
        customer: { type: 'string', required: true, description: '客户名称或 ID' },
        model: { type: 'string', required: true, description: '型号' },
        color: { type: 'string', description: '颜色（可选；不填表示该型号通用价）' },
        unit_price: { type: 'number', required: true, description: '单价（元/双）' },
        effective_from: { type: 'string', description: '生效日期 YYYY-MM-DD，缺省今天' },
      },
      async execute(args) {
        return withStore(async (s) => {
          const { price, created } = await s.setPrice({
            customer: args.customer,
            model: args.model,
            color: args.color,
            unitPrice: args.unit_price,
            effectiveFrom: args.effective_from,
          })
          return `${created ? '已新增' : '已更新'}单价：${price.customerName} · ${price.model}${price.color ? ` ${price.color}` : '（通用）'} = ¥${money(price.unitPrice)}/双，生效日期 ${price.effectiveFrom}`
        })
      },
    }),
  )

  ctx.tools.register(
    textTool({
      name: 'wms_list_prices',
      description: '查询单价体系，可按客户过滤。',
      parameters: {
        customer: { type: 'string', description: '客户名称（可选）' },
      },
      async execute(args) {
        return withStore(async (s) => {
          const filter = String(args.customer ?? '').trim()
          const rows = s.listPrices().filter((p) => !filter || p.customerName.includes(filter))
          if (!rows.length) return '还没有维护单价。'
          return [
            `共 ${rows.length} 条单价：`,
            ...rows.map(
              (p) =>
                `· ${p.customerName} · ${p.model}${p.color ? ` ${p.color}` : '（通用）'} = ¥${money(p.unitPrice)}/双（生效 ${p.effectiveFrom}）`,
            ),
          ].join('\n')
        })
      },
    }),
  )

  ctx.tools.register(
    textTool({
      name: 'wms_daily_summary',
      description: '汇总某一天各客户的订单：客户 × 型号 × 颜色 × 尺码 × 数量，并给出金额合计。',
      parameters: {
        date: { type: 'string', description: '日期 YYYY-MM-DD，缺省今天' },
      },
      async execute(args) {
        return withStore(async (s) => {
          const summary = s.dailySummary({ date: args.date })
          const head = `【${summary.date} 当日汇总】客户 ${summary.totals.customers} 家 · 明细 ${summary.totals.lines} 行 · 合计 ${summary.totals.quantity} 双 · 金额 ¥${money(summary.totals.amount)}`
          if (!summary.rows.length) return `${head}\n当日暂无订单。`
          return [
            head,
            ...summary.rows.map(
              (r) =>
                `· ${r.customerName} ${r.model} ${r.color} ${r.size}码 × ${r.quantity} 双　${r.amount === null ? '待定价' : `¥${money(r.amount)}`}`,
            ),
          ].join('\n')
        })
      },
    }),
  )

  ctx.tools.register(
    textTool({
      name: 'wms_export_outbound',
      description: '导出某一天的出库单 PDF（按客户 × 型号 × 颜色 × 尺码 × 数量汇总），返回文件路径与下载地址。',
      parameters: {
        date: { type: 'string', description: '日期 YYYY-MM-DD，缺省今天' },
      },
      async execute(args) {
        return withStore(async (s) => {
          const summary = s.dailySummary({ date: args.date })
          const buffer = await renderOutboundPdf({
            date: summary.date,
            rows: summary.rows,
            totals: summary.totals,
            company: config.company,
          })
          const filename = `出库单_${summary.date}.pdf`
          const file = await writePdfToFile(buffer, outDir, safeFilename(filename))
          return `已生成出库单：${file}\n明细 ${summary.rows.length} 行 · ${summary.totals.quantity} 双 · ¥${money(summary.totals.amount)}\n下载：/api/wms/outbound.pdf?date=${summary.date}`
        })
      },
    }),
  )

  ctx.tools.register(
    textTool({
      name: 'wms_monthly_settlement',
      description: '生成某个月的结算数据：按「数量 × 该客户对应单价」计算每家客户每种型号的金额，并标出未定价部分。',
      parameters: {
        month: { type: 'string', description: '月份 YYYY-MM，缺省本月' },
      },
      async execute(args) {
        return withStore(async (s) => {
          const settlement = s.monthlySettlement({ month: args.month })
          const head = `【${settlement.month} 月度结算】客户 ${settlement.totals.customers} 家 · ${settlement.totals.quantity} 双 · 应收 ¥${money(settlement.totals.amount)}`
          if (!settlement.customers.length) return `${head}\n本月暂无订单。`
          const lines = [head]
          for (const c of settlement.customers) {
            lines.push(`${c.customerName}：${c.quantity} 双 · ¥${money(c.amount)}${c.unpricedQuantity ? `（${c.unpricedQuantity} 双未定价）` : ''}`)
            for (const m of c.models) {
              lines.push(
                `　· ${m.model} × ${m.quantity} 双 @ ¥${m.unitPrice === null ? '未定价' : money(m.unitPrice)} = ¥${money(m.amount)}`,
              )
            }
          }
          if (settlement.totals.unpricedQuantity) {
            lines.push(`⚠️ ${settlement.totals.unpricedQuantity} 双未维护单价：${settlement.totals.unpricedCustomers.join('、')}`)
          }
          return lines.join('\n')
        })
      },
    }),
  )

  ctx.tools.register(
    textTool({
      name: 'wms_export_settlement',
      description: '导出某个月的结算单 PDF，返回文件路径与下载地址。',
      parameters: {
        month: { type: 'string', description: '月份 YYYY-MM，缺省本月' },
      },
      async execute(args) {
        return withStore(async (s) => {
          const settlement = s.monthlySettlement({ month: args.month })
          const buffer = await renderSettlementPdf({
            month: settlement.month,
            customers: settlement.customers,
            totals: settlement.totals,
            company: config.company,
          })
          const filename = `结算单_${settlement.month}.pdf`
          const file = await writePdfToFile(buffer, outDir, safeFilename(filename))
          return `已生成结算单：${file}\n客户 ${settlement.totals.customers} 家 · ${settlement.totals.quantity} 双 · 应收 ¥${money(settlement.totals.amount)}\n下载：/api/wms/settlement.pdf?month=${settlement.month}`
        })
      },
    }),
  )

  ctx.tools.register(
    textTool({
      name: 'wms_list_pending',
      description: '列出待补录的客户消息（缺字段或需要补联系方式），用于后续追问。',
      parameters: {
        chat_id: { type: 'string', description: '只看某个飞书 chat（可选）' },
      },
      async execute(args) {
        return withStore(async (s) => {
          const rows = s.listPending({ chatId: args.chat_id ?? '' })
          if (!rows.length) return '没有待补录的消息。'
          return [
            `共 ${rows.length} 条待补录：`,
            ...rows.map((p) => `· [${p.id}] ${p.customerName || '未知客户'} — 缺：${p.missing.join('、')}；原文：${p.rawText}`),
          ].join('\n')
        })
      },
    }),
  )

  // ------------------------------------------------------------ system prompt

  ctx.effect(() => {
    const systemPrompt = (() => {
      try {
        return ctx.get?.('systemPrompt') ?? null
      } catch {
        return null
      }
    })()
    if (!systemPrompt?.section) return () => {}
    return systemPrompt.section({
      name: 'wms:procurement',
      order: 420,
      text: [
        '## 鞋类采购报送系统（feishu-wms）',
        '当对话来自客户在飞书的采购报送时，按下面的方式处理，不要自己编造入库结果：',
        '1. 调用 `wms_ingest_message`，把客户原话放进 text，并带上 chat_id。',
        '2. 如果返回 action=recorded，把返回的 reply 原样（可精简排版）回复给客户；如果 reply 里要求补联系方式，等客户回复后调用 `wms_upsert_customer` 补录。',
        '3. 如果返回 action=need_info，把 reply 回复给客户，等待客户补充后再次调用 `wms_ingest_message` 或 `wms_record_order`。',
        '4. 如果返回 action=retry，把 reply 回复给客户，引导客户按标准格式重述。',
        `标准格式：${SUGGESTED_FORMAT}`,
        '后台汇总 / 出库单 / 月度结算分别用 `wms_daily_summary`、`wms_export_outbound`、`wms_monthly_settlement`、`wms_export_settlement`。',
      ].join('\n'),
    })
  })

  // ------------------------------------------------------------ HTTP routes

  const register = (routePath, handler) =>
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: routePath, handler }))

  const guard = (req, res, capability, handler) => {
    void (async () => {
      try {
        const role = roleOf(req)
        if (!can(role, capability)) {
          return json(res, 403, { ok: false, error: `角色「${ROLES[role].label}」没有权限：${capability}` })
        }
        await ready
        await handler(req, res, { role, store })
      } catch (err) {
        log(`route error: ${String(err?.stack ?? err)}`)
        if (!res.headersSent) json(res, 400, { ok: false, error: String(err?.message ?? err) })
        else res.end()
      }
    })()
  }

  register('/api/wms/health', (req, res) => {
    guard(req, res, 'overview:read', async (_req, _res, { store }) => {
      json(res, 200, {
        ok: true,
        build: BUILD,
        dataDir,
        outDir,
        cjkFont: findCjkFont(),
        roles: Object.fromEntries(Object.entries(ROLES).map(([key, value]) => [key, value.label])),
        overview: store.overview(),
      })
    })
  })

  register('/api/wms/overview', (req, res) => {
    guard(req, res, 'overview:read', async (_req, _res, { store }) => {
      json(res, 200, { ok: true, build: BUILD, ...store.overview() })
    })
  })

  register('/api/wms/customers', (req, res) => {
    void (async () => {
      try {
        await ready
        if (req.method === 'GET') {
          const role = roleOf(req)
          if (!can(role, 'customer:read')) return json(res, 403, { ok: false, error: '无权限' })
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const query = String(url.searchParams.get('q') ?? '').trim()
          const rows = store.listCustomers().filter((c) => !query || `${c.name}${c.aliases.join('')}${c.contact}`.includes(query))
          return json(res, 200, { ok: true, customers: rows })
        }
        const role = roleOf(req)
        if (!can(role, 'customer:write')) return json(res, 403, { ok: false, error: '无权限' })
        const body = await readBody(req)
        const { customer, created } = await store.upsertCustomer(body)
        return json(res, 200, { ok: true, customer, created })
      } catch (err) {
        if (!res.headersSent) json(res, 400, { ok: false, error: String(err?.message ?? err) })
      }
    })()
  })

  register('/api/wms/prices', (req, res) => {
    void (async () => {
      try {
        await ready
        const role = roleOf(req)
        if (req.method === 'GET') {
          if (!can(role, 'price:read')) return json(res, 403, { ok: false, error: '无权限' })
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const customer = String(url.searchParams.get('customer') ?? '').trim()
          const rows = store.listPrices().filter((p) => !customer || p.customerName.includes(customer))
          return json(res, 200, { ok: true, prices: rows })
        }
        if (!can(role, 'price:write')) return json(res, 403, { ok: false, error: '无权限' })
        const body = await readBody(req)
        const { price, created } = await store.setPrice(body)
        return json(res, 200, { ok: true, price, created })
      } catch (err) {
        if (!res.headersSent) json(res, 400, { ok: false, error: String(err?.message ?? err) })
      }
    })()
  })

  register('/api/wms/orders', (req, res) => {
    void (async () => {
      try {
        await ready
        const role = roleOf(req)
        if (req.method === 'GET') {
          if (!can(role, 'order:read')) return json(res, 403, { ok: false, error: '无权限' })
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const orders = store.listOrders({
            date: url.searchParams.get('date') || undefined,
            month: url.searchParams.get('month') || undefined,
            customer: url.searchParams.get('customer') || undefined,
          })
          return json(res, 200, { ok: true, orders })
        }
        if (!can(role, 'order:write')) return json(res, 403, { ok: false, error: '无权限' })
        const body = await readBody(req)
        const lines = Array.isArray(body.items) ? body.items : [body]
        const { customer } = await store.ensureCustomer(body.customer ?? body.customerName ?? lines[0]?.customer ?? '')
        const orders = await store.recordOrders(
          lines.map((line) => ({ ...line, customerId: customer.id })),
          { orderDate: body.orderDate ?? body.order_date, chatId: body.chatId ?? '', rawText: body.rawText ?? '', source: body.source ?? 'manual' },
        )
        return json(res, 200, { ok: true, orders })
      } catch (err) {
        if (!res.headersSent) json(res, 400, { ok: false, error: String(err?.message ?? err) })
      }
    })()
  })

  register('/api/wms/daily', (req, res) => {
    guard(req, res, 'daily:read', async (r, response, { store: s }) => {
      const url = new URL(r.url ?? '/', 'http://127.0.0.1')
      json(response, 200, { ok: true, ...s.dailySummary({ date: url.searchParams.get('date') || undefined }) })
    })
  })

  register('/api/wms/outbound.pdf', (req, res) => {
    guard(req, res, 'outbound:export', async (r, response, { store: s }) => {
      const url = new URL(r.url ?? '/', 'http://127.0.0.1')
      const summary = s.dailySummary({ date: url.searchParams.get('date') || undefined })
      const buffer = await renderOutboundPdf({
        date: summary.date,
        rows: summary.rows,
        totals: summary.totals,
        company: config.company,
      })
      const filename = `出库单_${summary.date}.pdf`
      await writePdfToFile(buffer, outDir, safeFilename(filename))
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': buffer.length,
        'content-disposition': `attachment; filename="outbound-${summary.date}.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'cache-control': 'no-store',
      })
      response.end(buffer)
    })
  })

  register('/api/wms/settlement', (req, res) => {
    guard(req, res, 'settlement:read', async (r, response, { store: s }) => {
      const url = new URL(r.url ?? '/', 'http://127.0.0.1')
      const month = url.searchParams.get('month') || monthOf()
      if (!isValidMonth(month)) throw new Error(`月份不合法：${month}`)
      json(response, 200, { ok: true, ...s.monthlySettlement({ month }) })
    })
  })

  register('/api/wms/settlement.pdf', (req, res) => {
    guard(req, res, 'settlement:export', async (r, response, { store: s }) => {
      const url = new URL(r.url ?? '/', 'http://127.0.0.1')
      const month = url.searchParams.get('month') || monthOf()
      if (!isValidMonth(month)) throw new Error(`月份不合法：${month}`)
      const settlement = s.monthlySettlement({ month })
      const buffer = await renderSettlementPdf({
        month: settlement.month,
        customers: settlement.customers,
        totals: settlement.totals,
        company: config.company,
      })
      const filename = `结算单_${settlement.month}.pdf`
      await writePdfToFile(buffer, outDir, safeFilename(filename))
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': buffer.length,
        'content-disposition': `attachment; filename="settlement-${settlement.month}.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'cache-control': 'no-store',
      })
      response.end(buffer)
    })
  })

  register('/api/wms/pending', (req, res) => {
    guard(req, res, 'pending:read', async (_r, response, { store: s }) => {
      json(response, 200, { ok: true, pending: s.listPending({ status: 'open' }) })
    })
  })

  register('/api/wms/pending/resolve', (req, res) => {
    void (async () => {
      try {
        await ready
        if (!can(roleOf(req), 'pending:write')) return json(res, 403, { ok: false, error: '无权限' })
        const body = await readBody(req)
        if (!body.id) return json(res, 400, { ok: false, error: '缺少 id' })
        const { pending } = await store.resolvePending(body.id, { by: roleOf(req), note: body.note ?? '' })
        return json(res, 200, { ok: true, pending })
      } catch (err) {
        if (!res.headersSent) json(res, 400, { ok: false, error: String(err?.message ?? err) })
      }
    })()
  })

  register('/api/wms/ingest', (req, res) => {
    void (async () => {
      try {
        await ready
        const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams)
        const result = await ingestMessage(store, body)
        return json(res, 200, {
          ok: true,
          action: result.action,
          reply: result.reply,
          customer: result.customer?.name ?? result.parsed.customerName,
          items: result.parsed.items,
          missing: result.parsed.missing,
          orderIds: (result.orders ?? []).map((o) => o.id),
        })
      } catch (err) {
        if (!res.headersSent) json(res, 400, { ok: false, error: String(err?.message ?? err) })
      }
    })()
  })

  register('/api/wms/panel', (req, res) => {
    void (async () => {
      try {
        const html = await fsp.readFile(new URL('./panel.html', import.meta.url), 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`panel unavailable: ${String(err?.message ?? err)}`)
      }
    })()
  })

  log(`plugin loaded (${BUILD}); data at ${dataDir}`)
}
