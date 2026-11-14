/**
 * lib/parse.js — 采购消息的确定性语义解析（Agent 的前置预解析器）
 *
 * Agent（LLM）负责真正的「动态语义理解」；本模块提供同一套规则的可复现实现，
 * 让「消息 → 结构化字段」在没有模型参与时也能被自动化测试逐条验证。
 *
 * 支持的典型写法：
 *   "a客户 型号b 黑色3双43码"
 *   "再补两双白色55码的b款"
 *   "b款 黑色3双43码 白色2双42码"
 *   "客户：张三，型号 X1，黑色，3双，43码"
 */

/** 标准示例格式（解析失败时引导客户） */
export const SUGGESTED_FORMAT = '客户名称 型号 颜色 数量 尺码，例如：a客户 型号b 黑色3双43码'

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 中文数字（含「十」组合）转阿拉伯数字；无法识别返回 NaN */
export function chineseToNumber(text) {
  const s = String(text ?? '').trim()
  if (!s) return Number.NaN
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s)
  if (s.includes('十')) {
    const [left, right] = s.split('十')
    const tens = left ? CN_DIGITS[left] : 1
    const ones = right ? CN_DIGITS[right] : 0
    if (tens === undefined || ones === undefined) return Number.NaN
    return tens * 10 + ones
  }
  let value = 0
  for (const ch of s) {
    if (CN_DIGITS[ch] === undefined) return Number.NaN
    value = value * 10 + CN_DIGITS[ch]
  }
  return value
}

const COLOR_TABLE = [
  ['黑色', ['黑色', '黑', 'black', 'blk', 'bk']],
  ['白色', ['白色', '白', 'white', 'wht', 'wh']],
  ['红色', ['红色', '红', 'red', 'rd']],
  ['蓝色', ['蓝色', '蓝', 'blue', 'blu', 'bl']],
  ['灰色', ['灰色', '灰', 'gray', 'grey', 'gy']],
  ['米色', ['米色', '米白', 'beige', 'ivory']],
  ['棕色', ['棕色', '棕', '咖啡色', 'brown', 'coffee']],
  ['绿色', ['绿色', '绿', 'green', 'gn']],
  ['黄色', ['黄色', '黄', 'yellow', 'yl']],
  ['粉色', ['粉色', '粉', 'pink', 'pk']],
  ['紫色', ['紫色', '紫', 'purple']],
  ['橙色', ['橙色', '橙', 'orange']],
  ['银色', ['银色', '银', 'silver']],
  ['金色', ['金色', '金', 'gold']],
  ['多色', ['多色', '花色', 'multi']],
]

/** 颜色归一化：黑 / 黑色 / black → 黑色；未识别返回 '' */
export function normalizeColor(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  for (const [canonical, aliases] of COLOR_TABLE) {
    for (const alias of aliases) {
      if (lower === alias.toLowerCase()) return canonical
    }
  }
  for (const [canonical, aliases] of COLOR_TABLE) {
    for (const alias of aliases) {
      if (alias.length >= 2 && lower.includes(alias.toLowerCase())) return canonical
    }
  }
  for (const [canonical, aliases] of COLOR_TABLE) {
    for (const alias of aliases) {
      if (alias.length === 1 && lower.includes(alias.toLowerCase())) return canonical
    }
  }
  return ''
}

/** 尺码归一化：43码 / 43 号 / EU43 / 43.5 → "43" / "43.5" */
export function normalizeSize(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  const m = raw.match(/(\d{2}(?:\.5)?)/)
  return m ? m[1] : ''
}

/** 型号归一化：去掉「型号 / 款 / model」等修饰，保留主体 */
export function normalizeModel(text) {
  let s = String(text ?? '').trim()
  if (!s) return ''
  s = s.replace(/^(?:型号|款号|货号|model|style)\s*[:：]?\s*/i, '')
  s = s.replace(/\s*(?:款|型号|款号|货号|model|style)$/i, '')
  s = s.replace(/^[：:，,、\s]+|[：:，,、\s]+$/g, '')
  return s
}

/** 数量归一化：3双 / 两双 / 3 pairs → 3 */
export function normalizeQuantity(text) {
  const raw = String(text ?? '')
    .trim()
    .replace(/\s*(?:双|对|只|件|个|包|箱|pairs?|pcs)$/i, '')
  const n = chineseToNumber(raw)
  return Number.isFinite(n) ? n : Number.NaN
}

const QTY_RE = /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十]+)\s*(?:双|对|只|件|个|包|箱|pairs?|pcs)/gi
const SIZE_RE = /(\d{2}(?:\.5)?)\s*(?:码|号|size|eu)/i
const MODEL_RES = [
  /(?:型号|款号|货号|model|style)\s*[:：]?\s*([A-Za-z0-9][\w\-.]{0,19})/i,
  /([A-Za-z][\w\-.]{0,19})\s*(?:款|型号|款号|货号|model|style)/i,
  /([\u4e00-\u9fa5]{2,8})\s*款/,
]

const CUSTOMER_STOPWORDS = new Set(['这个', '那个', '本', '该', '此', '每个', '每个客户', '新', '老', '同', '上述', '所有'])

function extractCustomer(text, knownNames = []) {
  let m = text.match(/(?:客户(?:名称|名)?|customer)\s*[:：]\s*([^\s，,；;、。:：]{1,24})/i)
  if (m) return { name: m[1], aliases: [] }
  m = text.match(/(?:我是|来自|这边是)\s*([^\s，,；;、。:：]{1,24})/)
  if (m) return { name: m[1], aliases: [] }
  m = text.match(/(?:^|[\s，,；;、。:：])([^\s，,；;、。:：]{1,24}?)\s*客户/)
  // "a客户" → 客户名 a，同时把 "a客户" 记成别名，后续两种写法都能命中
  if (m && !CUSTOMER_STOPWORDS.has(m[1])) return { name: m[1], aliases: [`${m[1]}客户`] }
  for (const name of knownNames) {
    if (name && text.includes(name)) return { name, aliases: [] }
  }
  return { name: '', aliases: [] }
}

function extractModel(descriptor) {
  for (const re of MODEL_RES) {
    const m = descriptor.match(re)
    if (m) {
      const model = normalizeModel(m[1])
      if (model) return model
    }
  }
  return ''
}

function extractSize(descriptor) {
  const m = descriptor.match(SIZE_RE)
  return m ? normalizeSize(m[1]) : ''
}

function extractColor(descriptor) {
  return normalizeColor(descriptor)
}

/**
 * 把一条采购消息解析成结构化行项目。
 *
 * @param {string} text 原始消息
 * @param {{ knownCustomers?: string[], defaultDate?: string }} [options]
 * @returns {{
 *   ok: boolean, text: string, customerName: string,
 *   items: Array<{ model: string, color: string, size: string, quantity: number, raw: string }>,
 *   missing: string[], unparsedReason: string
 * }}
 */
export function parseMessage(text, options = {}) {
  const source = String(text ?? '').trim()
  const knownCustomers = Array.isArray(options.knownCustomers) ? options.knownCustomers : []
  const customerHit = extractCustomer(source, knownCustomers)
  const customerName = customerHit.name

  const tokens = source.split(/[\s，,；;、。\n]+/).filter(Boolean)
  const items = []
  let acc = ''
  let pending = null // 已出现数量、仍在等尺码的行
  let carriedModel = ''
  let carriedColor = ''

  const flushPending = () => {
    if (pending) {
      items.push(pending)
      pending = null
    }
  }

  for (const token of tokens) {
    QTY_RE.lastIndex = 0
    const qtyMatch = QTY_RE.exec(token)
    if (qtyMatch) {
      flushPending()
      const before = token.slice(0, qtyMatch.index)
      const after = token.slice(qtyMatch.index + qtyMatch[0].length)
      const descriptor = `${acc} ${before}`.trim()
      acc = ''
      const quantity = normalizeQuantity(qtyMatch[1])
      pending = {
        model: extractModel(descriptor) || carriedModel,
        color: extractColor(descriptor) || carriedColor,
        size: '',
        quantity: Number.isFinite(quantity) ? quantity : 0,
        raw: `${descriptor} ${qtyMatch[0]}`.trim(),
      }
      if (pending.model) carriedModel = pending.model
      if (pending.color) carriedColor = pending.color
      if (after) {
        const size = extractSize(after)
        const model = extractModel(after)
        const color = extractColor(after)
        if (size) pending.size = size
        if (model) pending.model = model
        if (color) pending.color = color
        pending.raw = `${pending.raw} ${after}`.trim()
        if (pending.model) carriedModel = pending.model
        if (pending.color) carriedColor = pending.color
      }
      flushPending()
      continue
    }

    // 纯尺码 token 补上前一行的尺码（"3双 43码"）
    if (items.length && !items[items.length - 1].size) {
      const size = extractSize(token)
      if (size) {
        items[items.length - 1].size = size
        items[items.length - 1].raw = `${items[items.length - 1].raw} ${token}`.trim()
        continue
      }
    }
    if (pending && !pending.size) {
      const size = extractSize(token)
      if (size) {
        pending.size = size
        pending.raw = `${pending.raw} ${token}`.trim()
        continue
      }
    }
    acc = `${acc} ${token}`.trim()
  }
  flushPending()

  // 型号 / 颜色兜底：消息里只出现一次时，补给缺字段的行
  const globalModel = extractModel(source)
  const globalColor = extractColor(source)
  for (const item of items) {
    if (!item.model) item.model = globalModel || carriedModel
    if (!item.color) item.color = globalColor || carriedColor
  }

  const missing = []
  if (!customerName) missing.push('customer')
  for (const item of items) {
    if (!item.model && !missing.includes('model')) missing.push('model')
    if (!item.color && !missing.includes('color')) missing.push('color')
    if (!item.size && !missing.includes('size')) missing.push('size')
    if (!(item.quantity > 0) && !missing.includes('quantity')) missing.push('quantity')
  }

  let unparsedReason = ''
  if (!source) unparsedReason = 'empty'
  else if (!items.length) unparsedReason = 'no-quantity'

  return {
    ok: items.length > 0 && items.every((i) => i.model && i.color && i.size && i.quantity > 0),
    text: source,
    customerName,
    customerAliases: customerHit.aliases,
    items,
    missing,
    unparsedReason,
  }
}

const FIELD_LABELS = {
  customer: '客户名称',
  model: '鞋型号',
  color: '颜色',
  size: '尺码',
  quantity: '数量',
}

/** 字段缺失时的追问话术（Agent 直接发给客户） */
export function buildFollowUp(parsed, extra = {}) {
  const fields = (parsed.missing || []).map((key) => FIELD_LABELS[key] || key)
  const parts = []
  if (fields.length) parts.push(`还差：${fields.join('、')}。`)
  if (extra.reason) parts.push(extra.reason)
  parts.push(`请按标准格式补充：${SUGGESTED_FORMAT}`)
  return parts.join('')
}

/** 完全无法解析时的提示话术 */
export function buildRetryReply(parsed) {
  const hint = parsed?.unparsedReason === 'empty' ? '这条消息看起来是空的。' : '这条消息里没有识别出数量，无法生成订单。'
  return `${hint}请按标准格式重新描述：${SUGGESTED_FORMAT}`
}
