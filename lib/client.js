/**
 * dsh-feishu-wms — Client 半（Web UI「设置 → 鞋类采购」）
 *
 * 只做轻量入口：概览数字 + 打开完整后台面板。
 * 完整后台在 Host 路由 /api/wms/panel（独立页面，管理员/库管/财务三角色可切）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-feishu-wms',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    const API = '/api/wms'
    const e = React.createElement

    const call = async (path) => {
      try {
        const res = await fetch(API + path)
        const text = await res.text()
        try {
          return JSON.parse(text)
        } catch {
          return { error: text.slice(0, 200) }
        }
      } catch (err) {
        return { error: String((err && err.message) || err) }
      }
    }

    const money = (n) =>
      n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    function stat(label, value) {
      return e(
        'div',
        { style: { border: '1px solid var(--dsw-alias-border-default, #e5e7eb)', borderRadius: 10, padding: '9px 12px', minWidth: 118 } },
        e('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)' } }, label),
        e('div', { style: { fontSize: 18, fontWeight: 650, marginTop: 2 } }, String(value)),
      )
    }

    function WmsSection() {
      const [data, setData] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        const load = async () => {
          const next = await call('/overview')
          if (alive && !next.error) setData(next)
        }
        void load()
        const timer = setInterval(load, 10000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const openPanel = () => window.open(API + '/panel', '_blank', 'noopener')

      const button = (primary, label, onClick) => {
        const base = { borderRadius: 8, padding: '7px 14px', fontSize: 12, cursor: 'pointer' }
        return e(
          'button',
          {
            onClick,
            style: primary
              ? { ...base, background: 'var(--dsw-alias-brand-primary, #2563eb)', color: '#fff', border: 0, fontWeight: 600 }
              : { ...base, background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-default, #ddd)' },
          },
          label,
        )
      }

      return e(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        e(
          'section',
          null,
          e('h3', { style: { margin: '0 0 4px', fontSize: 13, fontWeight: 600 } }, '鞋类采购报送'),
          e(
            'p',
            { style: { margin: '0 0 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #888)' } },
            '客户在飞书里报送采购需求 → Agent 语义解析入库 → 后台汇总出库单 / 月度结算。',
          ),
          data
            ? e(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                stat('今日数量（双）', data.todayQuantity ?? 0),
                stat('今日金额（元）', money(data.todayAmount)),
                stat('本月数量（双）', data.monthQuantity ?? 0),
                stat('本月金额（元）', money(data.monthAmount)),
                stat('客户', data.customers ?? 0),
                stat('待补录', data.pending ?? 0),
              )
            : e(
                'p',
                { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #888)' } },
                '还读不到数据：确认 feishu-wms 插件已加载（/api/wms/overview）。',
              ),
          e(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' } },
            button(true, '打开后台面板', openPanel),
            data && data.unpricedQuantity
              ? e(
                  'span',
                  { style: { fontSize: 12, color: '#d97706' } },
                  '本月有 ' + data.unpricedQuantity + ' 双未维护单价',
                )
              : null,
          ),
        ),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'feishu-wms', order: 41, label: () => '鞋类采购' },
          WmsSection,
        ),
      )
    }

    module.exports = { apply, inject }
    return module.exports
  },
})
