import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findCjkFont, renderOutboundPdf, renderSettlementPdf, writePdfToFile } from '../lib/pdf.js'

const latin1 = (buffer) => buffer.toString('latin1')

test('PDF 渲染：能探测到中文字体（Windows / macOS / Linux 任一候选）', () => {
  const font = findCjkFont()
  assert.ok(font === null || typeof font === 'string')
  if (process.platform === 'win32') assert.ok(font, 'Windows 上应能找到中文字体')
})

test('R4 出库单 PDF：合法 PDF + 可被断言的内容标记', async () => {
  const buffer = await renderOutboundPdf({
    date: '2026-10-12',
    rows: [
      { customerName: 'a', model: 'b', color: '黑色', size: '43', quantity: 3, unitPrice: 120, amount: 360 },
      { customerName: 'a', model: 'b', color: '白色', size: '42', quantity: 2, unitPrice: 120, amount: 240 },
    ],
    totals: { quantity: 5, amount: 600, lines: 2, customers: 1, unpricedRows: 0, unpricedQuantity: 0 },
    company: '测试公司',
  })
  assert.ok(Buffer.isBuffer(buffer))
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.ok(buffer.length > 2000, `PDF 太小：${buffer.length}`)
  const text = latin1(buffer)
  assert.match(text, /wms-outbound/)
  assert.match(text, /date=2026-10-12/)
  assert.match(text, /rows=2/)
  assert.match(text, /qty=5/)
})

test('R6 结算单 PDF：合法 PDF + 可被断言的内容标记（含未定价提示）', async () => {
  const buffer = await renderSettlementPdf({
    month: '2026-10',
    customers: [
      {
        customerName: 'a',
        quantity: 5,
        amount: 500,
        unpricedQuantity: 0,
        models: [
          { model: 'b', quantity: 5, unitPrice: 100, amount: 500, unpricedQuantity: 0 },
        ],
      },
      {
        customerName: 'c',
        quantity: 2,
        amount: 0,
        unpricedQuantity: 2,
        models: [{ model: 'x', quantity: 2, unitPrice: null, amount: 0, unpricedQuantity: 2 }],
      },
    ],
    totals: { customers: 2, quantity: 7, amount: 500, unpricedQuantity: 2, unpricedCustomers: ['c'] },
  })
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-')
  const text = latin1(buffer)
  assert.match(text, /wms-settlement/)
  assert.match(text, /month=2026-10/)
  assert.match(text, /customers=2/)
  assert.match(text, /qty=7/)
})

test('PDF 渲染：空数据也能生成（不抛错，给出「暂无订单」）', async () => {
  const outbound = await renderOutboundPdf({ date: '2026-10-12', rows: [], totals: { quantity: 0, amount: 0 } })
  const settlement = await renderSettlementPdf({ month: '2026-10', customers: [], totals: { quantity: 0, amount: 0 } })
  assert.equal(outbound.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.equal(settlement.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.match(latin1(outbound), /rows=0/)
})

test('writePdfToFile：目录不存在会自动创建', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wms-pdf-'))
  const buffer = await renderOutboundPdf({ date: '2026-10-12', rows: [], totals: {} })
  const file = await writePdfToFile(buffer, path.join(dir, 'nested', 'exports'), '出库单_2026-10-12.pdf')
  const stat = await fsp.stat(file)
  assert.equal(stat.size, buffer.length)
  assert.ok(file.endsWith('出库单_2026-10-12.pdf'))
})
