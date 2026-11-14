/**
 * test/mock-ctx.mjs — 最小 Cordis 宿主替身
 *
 * 只模拟插件用到的 4 个能力：tools.register / webServer.register /
 * systemPrompt.section / effect。足够把 apply() 完整跑起来做端到端断言。
 */
import { Buffer } from 'node:buffer'

export function createMockCtx({ withSystemPrompt = true } = {}) {
  const tools = new Map()
  const routes = new Map()
  const sections = []
  const disposers = []

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    systemPrompt: withSystemPrompt
      ? {
          section(section) {
            sections.push(section)
            return () => {}
          },
        }
      : undefined,
    get(key) {
      if (key === 'systemPrompt') return ctx.systemPrompt
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
  }

  return {
    ctx,
    tools,
    routes,
    sections,
    dispose() {
      for (const disposer of disposers.splice(0)) {
        try {
          disposer()
        } catch {
          /* ignore */
        }
      }
    },
  }
}

class MockResponse {
  constructor() {
    this.statusCode = 200
    this.headers = {}
    this.chunks = []
    this.headersSent = false
    this.finished = new Promise((resolve) => {
      this._resolve = resolve
    })
  }

  writeHead(status, headers = {}) {
    this.statusCode = status
    this.headers = { ...this.headers, ...headers }
    this.headersSent = true
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
    this._resolve()
  }

  get buffer() {
    return Buffer.concat(this.chunks)
  }

  get text() {
    return this.buffer.toString('utf8')
  }

  json() {
    return JSON.parse(this.text)
  }
}

/**
 * 调用一个 Host HTTP 路由
 * @param {(req: any, res: any) => void} handler
 */
export async function invokeRoute(handler, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload
    },
  }
  const res = new MockResponse()
  handler(req, res)
  await Promise.race([
    res.finished,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`route timeout: ${method} ${url}`)), 15000)),
  ])
  return res
}

/** 调用一个已注册的 agent 工具 */
export async function invokeTool(definition, args = {}) {
  return definition.execute(args, { signal: new AbortController().signal })
}
