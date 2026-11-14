/**
 * lib/pdf.js — 出库单 / 月度结算单 PDF 渲染（pdfkit）
 *
 * 中文字体按候选列表探测（Windows / macOS / Linux 常见路径），
 * 找不到可嵌入的中文字体时降级为内置 Helvetica（中文会缺字，但不会崩）。
 * 每份 PDF 的 Info 字典里写一条机器可读标记，便于自动化测试断言内容。
 */
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import * as fontkit from 'fontkit'
import PDFDocument from 'pdfkit'

const FONT_CANDIDATES = [
  process.env.WMS_PDF_FONT,
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/Deng.ttf',
  'C:/Windows/Fonts/msyh.ttf',
  'C:/Windows/Fonts/simsun.ttf',
  'C:/Windows/Fonts/msyhl.ttc',
  'C:/Windows/Fonts/simsun.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]

let cachedFont

/**
 * 返回 pdfkit 能嵌入的中文字体路径，或 null。
 *
 * 注意：pdfkit 只能嵌单字体文件，`.ttc` 字体集合（雅黑/宋体集合）在 fontkit 里
 * 没有 createSubset，直接注册会抛 `this.font.createSubset is not a function`。
 * 这里用 fontkit 真正打开一次做能力校验，避免把不能用的字体传下去。
 */
export function findCjkFont() {
  if (cachedFont !== undefined) return cachedFont
  for (const candidate of FONT_CANDIDATES) {
    if (!candidate) continue
    try {
      if (!fs.statSync(candidate).isFile()) continue
      const font = fontkit.openSync(candidate)
      if (typeof font?.createSubset !== 'function') continue
      cachedFont = candidate
      return cachedFont
    } catch {
      /* 继续找下一个候选 */
    }
  }
  cachedFont = null
  return cachedFont
}

const money = (n) =>
  Number(n ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fontName = (doc) => doc.__wmsFont ?? 'Helvetica'

function createDoc(info) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    bufferPages: true,
    info: {
      Creator: 'dsh-feishu-wms',
      Producer: 'dsh-feishu-wms',
      ...info,
    },
  })
  doc.__wmsFont = 'Helvetica'
  const font = findCjkFont()
  if (font) {
    try {
      doc.registerFont('cjk', font)
      doc.font('cjk')
      doc.__wmsFont = 'cjk'
    } catch {
      doc.font('Helvetica')
    }
  }
  return doc
}

async function collect(doc) {
  const chunks = []
  doc.on('data', (chunk) => chunks.push(chunk))
  doc.end()
  await once(doc, 'end')
  return Buffer.concat(chunks)
}

function fitText(doc, text, width) {
  let s = String(text ?? '')
  if (!s) return ''
  if (doc.widthOfString(s) <= width) return s
  while (s.length > 1 && doc.widthOfString(`${s}…`) > width) s = s.slice(0, -1)
  return `${s}…`
}

function header(doc, { title, subtitle, metaLines = [] }) {
  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right
  doc.font(fontName(doc)).fontSize(9).fillColor('#6b7280').text('鞋类采购报送管理系统', left, doc.y, { width })
  doc.moveDown(0.4)
  doc.fontSize(20).fillColor('#111827').text(title, left, doc.y, { width })
  if (subtitle) {
    doc.moveDown(0.2)
    doc.fontSize(11).fillColor('#374151').text(subtitle, left, doc.y, { width })
  }
  for (const line of metaLines) {
    doc.moveDown(0.15)
    doc.fontSize(9).fillColor('#6b7280').text(line, left, doc.y, { width })
  }
  doc.moveDown(0.6)
  const y = doc.y
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor('#d1d5db').lineWidth(0.8).stroke()
  doc.moveDown(0.6)
  doc.fillColor('#111827')
}

function tableHeader(doc, columns, y) {
  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right
  doc.rect(left, y, width, 20).fill('#f3f4f6')
  doc.fillColor('#111827').fontSize(9)
  let x = left
  for (const col of columns) {
    doc.text(col.label, x + 4, y + 6, { width: col.width - 8, align: col.align ?? 'left', lineBreak: false })
    x += col.width
  }
  return y + 20
}

function row(doc, columns, values, y, options = {}) {
  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right
  const height = options.height ?? 20
  if (options.fill) doc.rect(left, y, width, height).fill(options.fill)
  doc.fontSize(options.fontSize ?? 9).fillColor(options.color ?? '#111827')
  let x = left
  columns.forEach((col, index) => {
    const text = options.bold ? String(values[index] ?? '') : fitText(doc, values[index], col.width - 8)
    doc.text(text, x + 4, y + 6, { width: col.width - 8, align: col.align ?? 'left', lineBreak: false })
    x += col.width
  })
  return y + height
}

function signatureBlock(doc) {
  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right
  doc.moveDown(1.4)
  const y = doc.y
  doc.fontSize(9).fillColor('#374151')
  const slots = ['制单：____________', '库管：____________', '日期：____________']
  const slotWidth = width / slots.length
  slots.forEach((slot, i) => doc.text(slot, left + i * slotWidth, y, { width: slotWidth, lineBreak: false }))
}

function paginate(doc, { footer }) {
  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i)
    const left = doc.page.margins.left
    const width = doc.page.width - left - doc.page.margins.right
    const bottom = doc.page.height - doc.page.margins.bottom + 10
    doc.font(fontName(doc)).fontSize(8).fillColor('#9ca3af')
    doc.text(`第 ${i + 1} / ${range.count} 页`, left, bottom, { width, align: 'right', lineBreak: false })
    doc.text(footer, left, bottom, { width: width - 60, align: 'left', lineBreak: false })
  }
}

const OUTBOUND_COLUMNS = [
  { key: 'index', label: '序号', width: 34, align: 'right' },
  { key: 'customerName', label: '客户', width: 110 },
  { key: 'model', label: '型号', width: 78 },
  { key: 'color', label: '颜色', width: 58 },
  { key: 'size', label: '尺码', width: 46, align: 'center' },
  { key: 'quantity', label: '数量', width: 44, align: 'right' },
  { key: 'unitPrice', label: '单价', width: 64, align: 'right' },
  { key: 'amount', label: '金额', width: 78, align: 'right' },
]

/**
 * 当日出库单 / 汇总单
 * @param {{date: string, rows: object[], totals: object, company?: string}} input
 * @returns {Promise<Buffer>}
 */
export async function renderOutboundPdf(input) {
  const { date, rows = [], totals = {}, company = '' } = input
  const marker = `wms-outbound date=${date} rows=${rows.length} qty=${totals.quantity ?? 0} amount=${money(totals.amount ?? 0)}`
  const doc = createDoc({
    Title: `出库单 ${date}`,
    Subject: '当日采购出库汇总',
    Keywords: marker,
  })
  header(doc, {
    title: '出库单（当日汇总）',
    subtitle: `出库日期：${date}`,
    metaLines: [
      company ? `公司：${company}` : '',
      `明细 ${rows.length} 行 · 合计 ${totals.quantity ?? 0} 双`,
      `制单时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ].filter(Boolean),
  })

  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right
  let y = tableHeader(doc, OUTBOUND_COLUMNS, doc.y)
  if (!rows.length) {
    y = row(doc, OUTBOUND_COLUMNS, ['', '当日暂无订单', '', '', '', '', '', ''], y, { color: '#9ca3af' })
  }
  rows.forEach((item, index) => {
    if (y > doc.page.height - doc.page.margins.bottom - 80) {
      doc.addPage()
      y = tableHeader(doc, OUTBOUND_COLUMNS, doc.page.margins.top)
    }
    y = row(
      doc,
      OUTBOUND_COLUMNS,
      [
        String(index + 1),
        item.customerName,
        item.model,
        item.color,
        item.size,
        String(item.quantity),
        item.unitPrice === null || item.unitPrice === undefined ? '—' : money(item.unitPrice),
        item.amount === null || item.amount === undefined ? '待定价' : money(item.amount),
      ],
      y,
      { fill: index % 2 ? '#fafafa' : undefined },
    )
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor('#e5e7eb').lineWidth(0.5).stroke()
  })

  y += 6
  doc.rect(left, y, width, 24).fill('#f3f4f6')
  doc.fontSize(10).fillColor('#111827')
  doc.text(
    `合计：${totals.quantity ?? 0} 双　金额：¥${money(totals.amount ?? 0)}` +
      (totals.unpricedRows ? `　（${totals.unpricedRows} 行未定价，${totals.unpricedQuantity} 双）` : ''),
    left + 6,
    y + 7,
    { width: width - 12, align: 'right', lineBreak: false },
  )
  doc.y = y + 30
  doc.fontSize(9).fillColor('#6b7280')
  doc.text(`客户数：${totals.customers ?? 0}　明细行：${totals.lines ?? rows.length}`, left, doc.y, { width })
  signatureBlock(doc)
  paginate(doc, { footer: `出库单 ${date} · dsh-feishu-wms` })
  return collect(doc)
}

const SETTLEMENT_COLUMNS = [
  { key: 'customerName', label: '客户', width: 132 },
  { key: 'model', label: '型号', width: 92 },
  { key: 'quantity', label: '数量', width: 66, align: 'right' },
  { key: 'unitPrice', label: '单价', width: 88, align: 'right' },
  { key: 'amount', label: '金额', width: 95, align: 'right' },
]

/**
 * 月度结算单
 * @param {{month: string, customers: object[], totals: object, company?: string}} input
 * @returns {Promise<Buffer>}
 */
export async function renderSettlementPdf(input) {
  const { month, customers = [], totals = {}, company = '' } = input
  const marker = `wms-settlement month=${month} customers=${totals.customers ?? 0} qty=${totals.quantity ?? 0} amount=${money(totals.amount ?? 0)}`
  const doc = createDoc({
    Title: `月度结算单 ${month}`,
    Subject: '按客户单价结算',
    Keywords: marker,
  })
  header(doc, {
    title: '月度结算单',
    subtitle: `结算月份：${month}`,
    metaLines: [
      company ? `公司：${company}` : '',
      `客户 ${totals.customers ?? 0} 家 · 合计 ${totals.quantity ?? 0} 双 · 应收 ¥${money(totals.amount ?? 0)}`,
      `制单时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ].filter(Boolean),
  })

  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right
  let y = tableHeader(doc, SETTLEMENT_COLUMNS, doc.y)
  if (!customers.length) {
    y = row(doc, SETTLEMENT_COLUMNS, ['本月暂无订单', '', '', '', ''], y, { color: '#9ca3af' })
  }
  for (const customer of customers) {
    const models = customer.models ?? []
    models.forEach((line, index) => {
      if (y > doc.page.height - doc.page.margins.bottom - 90) {
        doc.addPage()
        y = tableHeader(doc, SETTLEMENT_COLUMNS, doc.page.margins.top)
      }
      y = row(
        doc,
        SETTLEMENT_COLUMNS,
        [
          index === 0 ? customer.customerName : '',
          line.model,
          String(line.quantity),
          line.unitPrice === null || line.unitPrice === undefined ? '未定价' : money(line.unitPrice),
          money(line.amount),
        ],
        y,
        { fill: index % 2 ? '#fafafa' : undefined },
      )
    })
    if (y > doc.page.height - doc.page.margins.bottom - 90) {
      doc.addPage()
      y = tableHeader(doc, SETTLEMENT_COLUMNS, doc.page.margins.top)
    }
    y = row(
      doc,
      SETTLEMENT_COLUMNS,
      [
        '',
        `${customer.customerName} 小计`,
        String(customer.quantity),
        customer.unpricedQuantity ? `未定价 ${customer.unpricedQuantity} 双` : '',
        money(customer.amount),
      ],
      y,
      { fill: '#eef2ff', bold: true },
    )
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor('#e5e7eb').lineWidth(0.5).stroke()
  }

  y += 8
  doc.rect(left, y, width, 26).fill('#111827')
  doc.fontSize(11).fillColor('#ffffff')
  doc.text(`应收合计：¥${money(totals.amount ?? 0)}　数量：${totals.quantity ?? 0} 双`, left + 8, y + 8, {
    width: width - 16,
    align: 'right',
    lineBreak: false,
  })
  doc.y = y + 34
  if (totals.unpricedQuantity) {
    doc.fontSize(9).fillColor('#b91c1c')
    doc.text(
      `注意：仍有 ${totals.unpricedQuantity} 双未维护单价（${(totals.unpricedCustomers ?? []).join('、')}），金额未计入，请先在「单价管理」补录。`,
      left,
      doc.y,
      { width },
    )
  }
  signatureBlock(doc)
  paginate(doc, { footer: `月度结算单 ${month} · dsh-feishu-wms` })
  return collect(doc)
}

/** 把 PDF 落到磁盘，返回路径 */
export async function writePdfToFile(buffer, dir, filename) {
  await fs.promises.mkdir(dir, { recursive: true })
  const target = path.join(dir, filename)
  await fs.promises.writeFile(target, buffer)
  return target
}
