/**
 * lib/store.js — 鞋类采购报送系统的数据层（零外部依赖，JSON 原子落盘）
 *
 * 领域模型：
 *   customers  客户档案（名称 / 别名 / 联系方式 / 地址）
 *   prices     客户单价体系（客户 × 型号 [+ 颜色] → 单价，带生效日期）
 *   orders     订单行（客户 × 型号 × 颜色 × 尺码 × 数量），只追加不修改
 *   pending    待补录请求（聊天里缺字段的消息，Agent 追问后回填）
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

/** 本地时区的 YYYY-MM-DD */
export function localDate(date = new Date()) {
  const d = new Date(date)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** YYYY-MM */
export function monthOf(value = new Date()) {
  const raw = typeof value === 'string' && /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : localDate(value).slice(0, 7)
  return raw
}

export function isValidMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00`)
  return !Number.isNaN(d.getTime()) && localDate(d) === value
}

const normalizeKey = (value) => String(value ?? '').trim().toLowerCase().replace(/[\s　_\-·.]+/g, '')

const emptyDb = () => ({
  version: 1,
  customers: [],
  prices: [],
  orders: [],
  pending: [],
  events: [],
  chats: {},
  seq: 0,
})

/** 客户端（面板）默认只读能力：把内部结构裁剪成视图 */
const customerView = (c) => ({
  id: c.id,
  name: c.name,
  aliases: c.aliases ?? [],
  contact: c.contact ?? '',
  address: c.address ?? '',
  note: c.note ?? '',
  profileComplete: Boolean(c.contact),
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
})

export class WmsStore {
  /**
   * @param {{ dataDir: string, outDir?: string, now?: () => Date }} options
   */
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('WmsStore: dataDir is required')
    this.dataDir = path.resolve(options.dataDir)
    this.outDir = path.resolve(options.outDir ?? path.join(this.dataDir, 'exports'))
    this.dbPath = path.join(this.dataDir, 'db.json')
    this.now = options.now ?? (() => new Date())
    this.db = emptyDb()
    this._loading = null
    this._saving = Promise.resolve()
  }

  // ------------------------------------------------------------ persistence

  async init() {
    if (!this._loading) {
      this._loading = (async () => {
        await fsp.mkdir(this.dataDir, { recursive: true })
        await fsp.mkdir(this.outDir, { recursive: true })
        try {
          const raw = await fsp.readFile(this.dbPath, 'utf8')
          const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
          this.db = { ...emptyDb(), ...parsed }
          for (const key of ['customers', 'prices', 'orders', 'pending', 'events']) {
            if (!Array.isArray(this.db[key])) this.db[key] = []
          }
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
          await this.save()
        }
      })()
    }
    return this._loading
  }

  /** 原子写：先写临时文件再 rename，避免进程中断留下半截 JSON */
  async save() {
    this._saving = this._saving.then(async () => {
      const body = JSON.stringify(this.db, null, 2)
      const tmp = `${this.dbPath}.${process.pid}.tmp`
      await fsp.writeFile(tmp, body, 'utf8')
      await fsp.rename(tmp, this.dbPath)
    })
    return this._saving
  }

  nextId(prefix) {
    this.db.seq = (this.db.seq ?? 0) + 1
    return `${prefix}_${this.db.seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`
  }

  recordEvent(type, detail) {
    this.db.events.unshift({ at: this.now().toISOString(), type, detail })
    if (this.db.events.length > 500) this.db.events.length = 500
  }

  // ------------------------------------------------------------ customers

  listCustomers() {
    return this.db.customers.map(customerView).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }

  findCustomer(ref) {
    const raw = String(ref ?? '').trim()
    if (!raw) return undefined
    const byId = this.db.customers.find((c) => c.id === raw)
    if (byId) return byId
    const key = normalizeKey(raw)
    const exact = this.db.customers.find((c) => normalizeKey(c.name) === key)
    if (exact) return exact
    const alias = this.db.customers.find((c) => (c.aliases ?? []).some((a) => normalizeKey(a) === key))
    if (alias) return alias
    if (key.length >= 2) {
      const fuzzy = this.db.customers.find(
        (c) => normalizeKey(c.name).includes(key) || key.includes(normalizeKey(c.name)),
      )
      if (fuzzy) return fuzzy
    }
    return undefined
  }

  /**
   * 建档或补录。同名（含别名）视为同一客户，只更新传入的字段。
   * @returns {Promise<{ customer: ReturnType<typeof customerView>, created: boolean }>}
   */
  async upsertCustomer(input = {}) {
    const name = String(input.name ?? '').trim()
    if (!name) throw new Error('客户名称不能为空')
    const now = this.now().toISOString()
    let customer = input.id ? this.db.customers.find((c) => c.id === input.id) : this.findCustomer(name)
    let created = false
    if (!customer) {
      customer = {
        id: this.nextId('cus'),
        name,
        aliases: [],
        contact: '',
        address: '',
        note: '',
        createdAt: now,
        updatedAt: now,
      }
      this.db.customers.push(customer)
      created = true
    }
    if (name && customer.name !== name) customer.aliases = [...new Set([...(customer.aliases ?? []), name])]
    for (const field of ['contact', 'address', 'note']) {
      if (input[field] !== undefined) customer[field] = String(input[field] ?? '').trim()
    }
    if (Array.isArray(input.aliases)) {
      const extra = input.aliases.map((a) => String(a ?? '').trim()).filter(Boolean)
      customer.aliases = [...new Set([...(customer.aliases ?? []), ...extra])]
    }
    customer.updatedAt = now
    this.recordEvent(created ? 'customer.created' : 'customer.updated', { id: customer.id, name: customer.name })
    await this.save()
    return { customer: customerView(customer), created }
  }

  /** 消息里出现的新客户：先建档（联系方式待补录） */
  async ensureCustomer(name, aliases = []) {
    const existing = this.findCustomer(name)
    if (existing) {
      const extra = aliases.filter((a) => a && a !== existing.name && !(existing.aliases ?? []).includes(a))
      if (extra.length) {
        existing.aliases = [...new Set([...(existing.aliases ?? []), ...extra])]
        await this.save()
      }
      return { customer: customerView(existing), created: false }
    }
    return this.upsertCustomer({ name, aliases })
  }

  /**
   * 聊天上下文：记住这个飞书会话最近一次报单的客户。
   * 客户补一句「再补两双白色55码的b款」时不写客户名，也能落到同一个客户身上。
   */
  chatCustomer(chatId) {
    if (!chatId) return undefined
    const hit = this.db.chats?.[chatId]
    if (!hit?.customerId) return undefined
    return this.db.customers.find((c) => c.id === hit.customerId)
  }

  async setChatCustomer(chatId, customerId) {
    if (!chatId) return
    this.db.chats = this.db.chats ?? {}
    this.db.chats[chatId] = { customerId, updatedAt: this.now().toISOString() }
    await this.save()
  }

  // ------------------------------------------------------------ prices

  listPrices() {
    return this.db.prices
      .map((p) => {
        const customer = this.db.customers.find((c) => c.id === p.customerId)
        return {
          id: p.id,
          customerId: p.customerId,
          customerName: customer?.name ?? '(已删除客户)',
          model: p.model,
          color: p.color ?? '',
          unitPrice: p.unitPrice,
          effectiveFrom: p.effectiveFrom,
          updatedAt: p.updatedAt,
        }
      })
      .sort((a, b) => `${a.customerName}${a.model}`.localeCompare(`${b.customerName}${b.model}`, 'zh-Hans-CN'))
  }

  /** 新增或修改「客户 + 型号 [+ 颜色]」的单价（客户不存在时自动建档） */
  async setPrice(input = {}) {
    const ref = input.customer ?? input.customerName ?? input.customerId
    if (!ref) throw new Error('客户不能为空')
    let customer = this.findCustomer(ref)
    if (!customer) {
      const ensured = await this.ensureCustomer(String(ref))
      customer = this.db.customers.find((c) => c.id === ensured.customer.id)
      if (!customer) throw new Error(`客户不存在：${ref}`)
    }
    const model = String(input.model ?? '').trim()
    if (!model) throw new Error('型号不能为空')
    const unitPrice = Number(input.unitPrice)
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('单价必须是不小于 0 的数字')
    const color = input.color ? String(input.color).trim() : ''
    const effectiveFrom = input.effectiveFrom ? String(input.effectiveFrom) : localDate(this.now())
    if (!isValidDate(effectiveFrom)) throw new Error(`生效日期不合法：${effectiveFrom}`)
    const modelKey = normalizeKey(model)
    const colorKey = normalizeKey(color)
    const now = this.now().toISOString()
    let row = this.db.prices.find(
      (p) => p.customerId === customer.id && normalizeKey(p.model) === modelKey && normalizeKey(p.color ?? '') === colorKey,
    )
    const created = !row
    if (!row) {
      row = { id: this.nextId('prc'), customerId: customer.id, model, color, unitPrice: round2(unitPrice), effectiveFrom, updatedAt: now }
      this.db.prices.push(row)
    } else {
      row.model = model
      row.color = color
      row.unitPrice = round2(unitPrice)
      row.effectiveFrom = effectiveFrom
      row.updatedAt = now
    }
    this.recordEvent(created ? 'price.created' : 'price.updated', {
      customer: customer.name,
      model,
      color,
      unitPrice: row.unitPrice,
    })
    await this.save()
    return { price: { ...row, customerName: customer.name }, created }
  }

  /** 查价：客户 + 型号 [+ 颜色]，优先颜色专价，其次型号通用价 */
  priceFor(customerId, model, color = '', date = localDate(this.now())) {
    const modelKey = normalizeKey(model)
    const colorKey = normalizeKey(color)
    const all = this.db.prices.filter((p) => p.customerId === customerId && normalizeKey(p.model) === modelKey)
    if (!all.length) return null
    const latest = (pool) => {
      const sorted = [...pool].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0))
      return sorted[0].unitPrice
    }
    const applicable = (pool) => pool.filter((p) => p.effectiveFrom <= date)
    const colorPool = all.filter((p) => normalizeKey(p.color ?? '') === colorKey)
    const genericPool = all.filter((p) => !p.color)
    const colorApplicable = applicable(colorPool)
    if (colorApplicable.length) return latest(colorApplicable)
    const genericApplicable = applicable(genericPool)
    if (genericApplicable.length) return latest(genericApplicable)
    // 所有价格都还没到生效日期（例如给历史订单补录价格）：用最早上架价兜底
    const fallback = colorPool.length ? colorPool : genericPool
    if (!fallback.length) return null
    return [...fallback].sort((a, b) => (a.effectiveFrom > b.effectiveFrom ? 1 : a.effectiveFrom < b.effectiveFrom ? -1 : 0))[0].unitPrice
  }

  // ------------------------------------------------------------ orders

  /**
   * 追加订单行（不做修改 / 作废：需求明确不包含）
   * @param {Array<{model:string,color:string,size:string,quantity:number,customerId?:string,customer?:string,unitPrice?:number}>} lines
   * @param {{ orderDate?: string, chatId?: string, messageId?: string, rawText?: string, source?: string }} meta
   */
  async recordOrders(lines, meta = {}) {
    if (!Array.isArray(lines) || !lines.length) throw new Error('至少需要一条订单行')
    const orderDate = meta.orderDate ? String(meta.orderDate) : localDate(this.now())
    if (!isValidDate(orderDate)) throw new Error(`日期不合法：${orderDate}`)
    const now = this.now().toISOString()
    const created = []
    for (const line of lines) {
      const customer = this.findCustomer(line.customerId ?? line.customer ?? line.customerName)
      if (!customer) throw new Error(`客户不存在：${line.customerId ?? line.customer ?? ''}`)
      const model = String(line.model ?? '').trim()
      const color = String(line.color ?? '').trim()
      const size = String(line.size ?? '').trim()
      const quantity = Number(line.quantity)
      if (!model) throw new Error('型号不能为空')
      if (!color) throw new Error('颜色不能为空')
      if (!size) throw new Error('尺码不能为空')
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('数量必须是正数')
      const unitPrice =
        line.unitPrice === undefined || line.unitPrice === null
          ? this.priceFor(customer.id, model, color, orderDate)
          : round2(line.unitPrice)
      const order = {
        id: this.nextId('ord'),
        customerId: customer.id,
        customerName: customer.name,
        model,
        color,
        size,
        quantity,
        unitPrice: unitPrice === null ? null : round2(unitPrice),
        amount: unitPrice === null ? null : round2(unitPrice * quantity),
        orderDate,
        createdAt: now,
        source: meta.source ?? 'manual',
        chatId: meta.chatId ?? '',
        messageId: meta.messageId ?? '',
        rawText: meta.rawText ?? '',
      }
      this.db.orders.push(order)
      created.push(order)
    }
    this.recordEvent('order.created', {
      date: orderDate,
      count: created.length,
      quantity: created.reduce((sum, o) => sum + o.quantity, 0),
      source: meta.source ?? 'manual',
    })
    await this.save()
    return created
  }

  listOrders(filter = {}) {
    const { date, month, customer } = filter
    const customerRef = customer ? this.findCustomer(customer) : undefined
    return this.db.orders
      .filter((o) => {
        if (date && o.orderDate !== date) return false
        if (month && !o.orderDate.startsWith(month)) return false
        if (customerRef && o.customerId !== customerRef.id) return false
        return true
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((o) => ({ ...o }))
  }

  // ------------------------------------------------------------ daily summary

  /**
   * 当天各客户的订单汇总：客户 × 型号 × 颜色 × 尺码 × 数量
   * @param {{date?: string}} [filter]
   */
  dailySummary(filter = {}) {
    const date = filter.date ? String(filter.date) : localDate(this.now())
    if (!isValidDate(date)) throw new Error(`日期不合法：${date}`)
    const orders = this.db.orders.filter((o) => o.orderDate === date)
    const groups = new Map()
    for (const o of orders) {
      const key = [o.customerId, normalizeKey(o.model), o.color, o.size].join('|')
      if (!groups.has(key)) {
        groups.set(key, {
          customerId: o.customerId,
          customerName: o.customerName,
          model: o.model,
          color: o.color,
          size: o.size,
          quantity: 0,
          unitPrice: null,
          amount: null,
          lines: 0,
        })
      }
      const row = groups.get(key)
      row.quantity += o.quantity
      row.lines += 1
      const unitPrice = o.unitPrice ?? this.priceFor(o.customerId, o.model, o.color, date)
      if (unitPrice !== null && unitPrice !== undefined) row.unitPrice = unitPrice
    }
    const rows = [...groups.values()].map((row) => ({
      ...row,
      amount: row.unitPrice === null ? null : round2(row.unitPrice * row.quantity),
    }))
    rows.sort(
      (a, b) =>
        a.customerName.localeCompare(b.customerName, 'zh-Hans-CN') ||
        a.model.localeCompare(b.model) ||
        a.color.localeCompare(b.color, 'zh-Hans-CN') ||
        a.size.localeCompare(b.size),
    )
    const priced = rows.filter((r) => r.amount !== null)
    return {
      date,
      rows,
      totals: {
        lines: rows.length,
        quantity: rows.reduce((sum, r) => sum + r.quantity, 0),
        amount: round2(priced.reduce((sum, r) => sum + r.amount, 0)),
        pricedRows: priced.length,
        unpricedRows: rows.length - priced.length,
        unpricedQuantity: rows.filter((r) => r.amount === null).reduce((sum, r) => sum + r.quantity, 0),
        customers: new Set(rows.map((r) => r.customerId)).size,
      },
    }
  }

  // ------------------------------------------------------------ monthly settlement

  /**
   * 月度结算：按「数量 × 该客户对应单价」计算金额
   * @param {{month?: string}} [filter]
   */
  monthlySettlement(filter = {}) {
    const month = filter.month ? String(filter.month) : monthOf(this.now())
    if (!isValidMonth(month)) throw new Error(`月份不合法（应为 YYYY-MM）：${month}`)
    const orders = this.db.orders.filter((o) => o.orderDate.startsWith(month))
    const byCustomer = new Map()
    for (const o of orders) {
      if (!byCustomer.has(o.customerId)) {
        const customer = this.db.customers.find((c) => c.id === o.customerId)
        byCustomer.set(o.customerId, {
          customerId: o.customerId,
          customerName: customer?.name ?? o.customerName,
          contact: customer?.contact ?? '',
          models: new Map(),
          quantity: 0,
          amount: 0,
        })
      }
      const entry = byCustomer.get(o.customerId)
      const modelKey = normalizeKey(o.model)
      if (!entry.models.has(modelKey)) {
        entry.models.set(modelKey, { model: o.model, quantity: 0, amount: 0, pricedQuantity: 0, unitPrices: new Set() })
      }
      const line = entry.models.get(modelKey)
      const unitPrice = o.unitPrice ?? this.priceFor(o.customerId, o.model, o.color, o.orderDate)
      line.quantity += o.quantity
      entry.quantity += o.quantity
      if (unitPrice === null || unitPrice === undefined) continue
      const amount = round2(unitPrice * o.quantity)
      line.amount = round2(line.amount + amount)
      line.pricedQuantity += o.quantity
      line.unitPrices.add(unitPrice)
      entry.amount = round2(entry.amount + amount)
    }
    const customers = [...byCustomer.values()]
      .map((entry) => {
        const models = [...entry.models.values()].map((line) => ({
          model: line.model,
          quantity: line.quantity,
          pricedQuantity: line.pricedQuantity,
          unpricedQuantity: line.quantity - line.pricedQuantity,
          unitPrice: line.unitPrices.size === 1 ? [...line.unitPrices][0] : line.pricedQuantity ? round2(line.amount / line.pricedQuantity) : null,
          mixedPrice: line.unitPrices.size > 1,
          amount: round2(line.amount),
        }))
        models.sort((a, b) => a.model.localeCompare(b.model))
        return {
          customerId: entry.customerId,
          customerName: entry.customerName,
          contact: entry.contact,
          models,
          quantity: entry.quantity,
          amount: round2(entry.amount),
          unpricedQuantity: models.reduce((sum, m) => sum + m.unpricedQuantity, 0),
        }
      })
      .sort((a, b) => a.customerName.localeCompare(b.customerName, 'zh-Hans-CN'))
    const totals = {
      customers: customers.length,
      quantity: customers.reduce((sum, c) => sum + c.quantity, 0),
      amount: round2(customers.reduce((sum, c) => sum + c.amount, 0)),
      unpricedQuantity: customers.reduce((sum, c) => sum + c.unpricedQuantity, 0),
      unpricedCustomers: customers.filter((c) => c.unpricedQuantity > 0).map((c) => c.customerName),
    }
    return { month, customers, totals }
  }

  // ------------------------------------------------------------ pending supplements

  async addPending(input = {}) {
    const chatId = String(input.chatId ?? '')
    const rawText = String(input.rawText ?? '').trim()
    const existing = this.db.pending.find(
      (p) => p.status === 'open' && p.chatId === chatId && p.rawText === rawText,
    )
    if (existing) return { pending: { ...existing }, created: false }
    const pending = {
      id: this.nextId('req'),
      chatId,
      messageId: String(input.messageId ?? ''),
      rawText,
      missing: Array.isArray(input.missing) ? input.missing : [],
      customerName: String(input.customerName ?? ''),
      status: 'open',
      createdAt: this.now().toISOString(),
      resolvedAt: '',
    }
    this.db.pending.push(pending)
    this.recordEvent('pending.created', { id: pending.id, missing: pending.missing })
    await this.save()
    return { pending: { ...pending }, created: true }
  }

  listPending(filter = {}) {
    const status = filter.status ?? 'open'
    return this.db.pending
      .filter((p) => (status === 'all' ? true : p.status === status))
      .filter((p) => (filter.chatId ? p.chatId === filter.chatId : true))
      .map((p) => ({ ...p }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  async resolvePending(id, resolution = {}) {
    const pending = this.db.pending.find((p) => p.id === id)
    if (!pending) throw new Error(`待补录记录不存在：${id}`)
    pending.status = 'resolved'
    pending.resolvedAt = this.now().toISOString()
    pending.resolution = resolution
    this.recordEvent('pending.resolved', { id })
    await this.save()
    return { pending: { ...pending } }
  }

  // ------------------------------------------------------------ overview

  overview() {
    const today = localDate(this.now())
    const daily = this.dailySummary({ date: today })
    const month = this.monthlySettlement({ month: monthOf(this.now()) })
    return {
      today,
      month: month.month,
      customers: this.db.customers.length,
      customersIncomplete: this.db.customers.filter((c) => !c.contact).length,
      prices: this.db.prices.length,
      orders: this.db.orders.length,
      todayQuantity: daily.totals.quantity,
      todayAmount: daily.totals.amount,
      todayRows: daily.rows.length,
      monthQuantity: month.totals.quantity,
      monthAmount: month.totals.amount,
      unpricedQuantity: month.totals.unpricedQuantity,
      pending: this.listPending().length,
      recentEvents: this.db.events.slice(0, 12),
    }
  }

  /** 仅测试用：清空全部业务数据（不删文件） */
  async reset() {
    this.db = emptyDb()
    await this.save()
  }
}

export { customerView, normalizeKey, round2 }
