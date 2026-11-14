#!/usr/bin/env node
/**
 * scripts/preview-panel.mjs — 隔离预览后台面板（不碰线上数据）
 *
 * 用最小 Cordis 宿主替身装配插件，起一个只服务 /api/wms/* 的临时 HTTP 服务，
 * 自动灌入一批演示数据，方便在浏览器里看各个页签的真实渲染。
 *
 * 用法：
 *   node scripts/preview-panel.mjs [--port 3099] [--data <dir>]
 *   # 然后打开 http://127.0.0.1:3099/api/wms/panel#/daily
 */
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { createMockCtx } from '../test/mock-ctx.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const port = Number(option('--port', process.env.WMS_PREVIEW_PORT || 3099))
const dataDir = option('--data', await fsp.mkdtemp(path.join(os.tmpdir(), 'wms-preview-')))
const today = new Date().toLocaleDateString('sv-SE')
const month = today.slice(0, 7)

const mock = createMockCtx()
apply(mock.ctx, { dataDir, company: '演示鞋业' })

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  const handler = mock.routes.get(pathname)
  if (!handler) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: `no route ${pathname}` }))
    return
  }
  handler(req, res)
})

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${port}`
console.log(`preview: ${base}/api/wms/panel   data: ${dataDir}`)

const post = (pathname, body) =>
  fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json())

await post('/api/wms/customers', { name: '张三', contact: '13800000000', address: '杭州市余杭区' })
await post('/api/wms/prices', { customer: 'a', model: 'b', unitPrice: 120 })
await post('/api/wms/prices', { customer: 'b', model: 'x', unitPrice: 88.5 })
await post('/api/wms/ingest', { text: 'a客户 型号b 黑色3双43码', chat_id: 'preview-a', order_date: today })
await post('/api/wms/ingest', { text: '再补两双白色55码的b款', chat_id: 'preview-a', order_date: today })
await post('/api/wms/ingest', { text: 'b客户 型号x 白色2双42码', chat_id: 'preview-b', order_date: today })
await post('/api/wms/ingest', { text: '张三客户 型号x 黑色1双41码', chat_id: 'preview-c', order_date: today })
await post('/api/wms/ingest', { text: '那个…还有货吗', chat_id: 'preview-d', order_date: today })

console.log(`seeded: ${today} / month ${month}`)
console.log('Ctrl+C 结束预览')
