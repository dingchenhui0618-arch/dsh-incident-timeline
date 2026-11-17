/* dsh-incident-timeline client bundle — generated from src/client.cjs */
window.__ModuleLoader__.load({
  id: "dsh-incident-timeline",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
// Client half of dsh-incident-timeline: the 事故时间线 Tab in the conversation
// view. Must stay CommonJS — the build wraps this in
// window.__ModuleLoader__.load() and React comes from the harness.

const React = require('react')
const h = React.createElement
const CSS = ".it-root{--it-space-1:4px;--it-space-2:8px;--it-space-3:12px;--it-space-4:16px;--it-space-5:24px;--it-space-6:32px;--it-space-7:48px;--it-font-sans:\"Inter\",\"Noto Sans SC\",\"Source Han Sans SC\",\"Microsoft YaHei\",system-ui,sans-serif;--it-font-mono:\"JetBrains Mono\",\"SFMono-Regular\",Menlo,Consolas,\"Liberation Mono\",monospace;--it-border:color-mix(in srgb,currentColor 14%,transparent);--it-border-strong:color-mix(in srgb,currentColor 24%,transparent);--it-muted:color-mix(in srgb,currentColor 58%,transparent);--it-faint:color-mix(in srgb,currentColor 38%,transparent);--it-surface:color-mix(in srgb,currentColor 3%,transparent);--it-rejected:#dc2626;--it-plugin:#d97706;--it-http:#2563eb;display:flex;flex-direction:column;gap:var(--it-space-5);padding:var(--it-space-5);height:100%;overflow:auto;color:inherit;font-family:var(--it-font-sans);font-size:14px;line-height:1.5;letter-spacing:.01em;}.it-root *{box-sizing:border-box}.it-head{display:flex;flex-direction:column;gap:var(--it-space-2)}.it-eyebrow{font-family:var(--it-font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--it-muted)}.it-title-row{display:flex;align-items:baseline;gap:var(--it-space-3);flex-wrap:wrap}.it-title{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em}.it-sub{margin:0;color:var(--it-muted);font-size:13px;max-width:72ch}.it-toolbar{display:flex;align-items:center;gap:var(--it-space-2);flex-wrap:wrap}.it-segment{display:inline-flex;border:1px solid var(--it-border);border-radius:8px;padding:2px;background:var(--it-surface)}.it-segment button{border:0;background:transparent;color:var(--it-muted);font:inherit;font-size:12px;line-height:1;padding:8px 12px;border-radius:6px;cursor:pointer}.it-segment button[aria-pressed=\"true\"]{background:color-mix(in srgb,currentColor 10%,transparent);color:inherit;font-weight:600}.it-segment button:hover{color:inherit}.it-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--it-border-strong);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;text-decoration:none;white-space:nowrap}.it-btn:hover{background:color-mix(in srgb,currentColor 7%,transparent)}.it-btn:disabled{opacity:.45;cursor:default}.it-btn-primary{border-color:color-mix(in srgb,currentColor 38%,transparent);background:color-mix(in srgb,currentColor 9%,transparent);font-weight:600}.it-btn:focus-visible,.it-segment button:focus-visible{outline:2px solid color-mix(in srgb,currentColor 55%,transparent);outline-offset:2px}.it-spacer{flex:1}.it-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--it-space-3)}.it-stat{border:1px solid var(--it-border);border-radius:10px;padding:var(--it-space-3) var(--it-space-4);background:var(--it-surface);min-width:0}.it-stat b{display:block;font-family:var(--it-font-mono);font-size:30px;font-weight:300;line-height:1.1;font-variant-numeric:tabular-nums}.it-stat span{display:block;margin-top:var(--it-space-1);font-size:11px;color:var(--it-muted);letter-spacing:.04em}.it-stat.it-rejected b{color:var(--it-rejected)}.it-stat.it-plugin b{color:var(--it-plugin)}.it-stat.it-http b{color:var(--it-http)}.it-card{border:1px solid var(--it-border);border-radius:10px;overflow:hidden}.it-card-head{display:flex;align-items:baseline;gap:var(--it-space-2);padding:var(--it-space-3) var(--it-space-4);border-bottom:1px solid var(--it-border)}.it-card-head h2{margin:0;font-size:13px;font-weight:600}.it-card-head span{font-size:11px;color:var(--it-muted)}.it-list{display:flex;flex-direction:column}.it-event{display:grid;grid-template-columns:4px minmax(0,1fr) auto;gap:var(--it-space-3);padding:var(--it-space-3) var(--it-space-4);border-bottom:1px solid var(--it-border);align-items:start}.it-event:last-child{border-bottom:0}.it-event:hover{background:color-mix(in srgb,currentColor 3%,transparent)}.it-kind-bar{width:4px;align-self:stretch;border-radius:2px;background:var(--it-kind,var(--it-faint))}.it-event.it-user-rejected{--it-kind:var(--it-rejected)}.it-event.it-plugin-error{--it-kind:var(--it-plugin)}.it-event.it-runtime-http{--it-kind:var(--it-http)}.it-event-main{min-width:0;display:flex;flex-direction:column;gap:var(--it-space-1)}.it-event-top{display:flex;align-items:center;gap:var(--it-space-2);flex-wrap:wrap}.it-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:1;white-space:nowrap;border:1px solid transparent}.it-badge.it-user-rejected{background:color-mix(in srgb,var(--it-rejected) 14%,transparent);color:color-mix(in srgb,var(--it-rejected) 82%,currentColor);border-color:color-mix(in srgb,var(--it-rejected) 34%,transparent)}.it-badge.it-plugin-error{background:color-mix(in srgb,var(--it-plugin) 14%,transparent);color:color-mix(in srgb,var(--it-plugin) 82%,currentColor);border-color:color-mix(in srgb,var(--it-plugin) 34%,transparent)}.it-badge.it-runtime-http{background:color-mix(in srgb,var(--it-http) 14%,transparent);color:color-mix(in srgb,var(--it-http) 82%,currentColor);border-color:color-mix(in srgb,var(--it-http) 34%,transparent)}.it-tool{font-family:var(--it-font-mono);font-size:12px}.it-meta{display:flex;gap:var(--it-space-2);flex-wrap:wrap;font-family:var(--it-font-mono);font-size:11px;color:var(--it-muted)}.it-meta a{color:inherit;text-decoration:none;border-bottom:1px dotted color-mix(in srgb,currentColor 40%,transparent)}.it-meta a:hover{border-bottom-style:solid}.it-excerpt{margin:0;color:color-mix(in srgb,currentColor 86%,transparent);font-size:13px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.it-event-side{display:flex;flex-direction:column;align-items:flex-end;gap:var(--it-space-1);font-family:var(--it-font-mono);font-size:11px;color:var(--it-muted);white-space:nowrap}.it-status{font-size:12px;color:var(--it-http)}.it-empty{padding:var(--it-space-7) var(--it-space-5);text-align:center;color:var(--it-muted)}.it-empty strong{display:block;color:inherit;font-size:14px;font-weight:600;margin-bottom:var(--it-space-1)}.it-empty span{font-size:12px}.it-error{border:1px solid color-mix(in srgb,var(--it-rejected) 45%,transparent);background:color-mix(in srgb,var(--it-rejected) 7%,transparent);border-radius:8px;padding:var(--it-space-2) var(--it-space-3);font-size:12px;color:inherit}.it-note{display:flex;gap:var(--it-space-2);flex-wrap:wrap;font-size:11px;color:var(--it-faint);border-top:1px solid var(--it-border);padding-top:var(--it-space-3)}.it-note code{font-family:var(--it-font-mono);font-size:11px}.it-skeleton{height:64px;background:color-mix(in srgb,currentColor 6%,transparent);border-bottom:1px solid var(--it-border);animation:it-pulse 1.6s ease-in-out infinite}@keyframes it-pulse{0%,100%{opacity:.55}50%{opacity:1}}@media (prefers-reduced-motion:reduce){.it-skeleton{animation:none}}@media (max-width:720px){.it-root{padding:var(--it-space-4);gap:var(--it-space-4)}.it-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.it-event{grid-template-columns:4px minmax(0,1fr);}.it-event-side{grid-column:2;align-items:flex-start;flex-direction:row;gap:var(--it-space-3)}}"

const API = '/dsh-incident-timeline'
const POLL_MS = 2000

const KIND_LABEL = {
  'user-rejected': 'user rejected',
  'plugin-error': '插件/工具报错',
  'runtime-http': '运行时 HTTP',
}

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: '24h', label: '24 小时' },
  { id: '7d', label: '7 天' },
]

let filter = 'all'
let snap = { data: null, error: '', at: 0, loading: true }
const listeners = new Set()
let timer = null

function queryFor(current) {
  const parts = ['limit=500']
  if (current === '24h') parts.push('since=' + (Date.now() - 24 * 60 * 60 * 1000))
  if (current === '7d') parts.push('since=' + (Date.now() - 7 * 24 * 60 * 60 * 1000))
  return parts.join('&')
}

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-incident-timeline] listener failed', error)
    }
  })
}

function load() {
  fetch(API + '/state?' + queryFor(filter), { headers: { accept: 'application/json' } })
    .then(function (res) { return res.json() })
    .then(function (data) {
      snap = { data: data, error: data && data.ok === false ? String(data.error || 'host 返回失败') : '', at: Date.now(), loading: false }
      emit()
    })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), at: Date.now(), loading: false }
      emit()
    })
}

function sync() {
  fetch(API + '/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(function () { load() })
    .catch(function () { load() })
}

function setFilter(next) {
  if (filter === next) return
  filter = next
  snap = { data: snap.data, error: '', at: Date.now(), loading: true }
  emit()
  load()
}

function subscribe(fn) {
  listeners.add(fn)
  if (timer === null) {
    load()
    timer = setInterval(load, POLL_MS)
  }
  fn(snap)
  return function () {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function pad(value) {
  return value < 10 ? '0' + value : String(value)
}

function clock(ms) {
  if (typeof ms !== 'number') return '—'
  const date = new Date(ms)
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

function day(ms) {
  if (typeof ms !== 'number') return '—'
  const date = new Date(ms)
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function stepText(event) {
  if (typeof event.turn === 'number' && typeof event.step === 'number') return event.turn + '/' + event.step
  if (typeof event.step === 'number') return String(event.step)
  return '—'
}

function objectText(event) {
  if (typeof event.status === 'number') return 'HTTP ' + event.status
  if (typeof event.tool === 'string' && event.tool.length > 0) return event.tool
  const source = event.detail && event.detail.source
  return typeof source === 'string' ? source : '—'
}

function Stat(props) {
  return h('div', { className: 'it-stat ' + (props.tone || '') },
    h('b', null, String(props.value)),
    h('span', null, props.label),
  )
}

function EventRow(props) {
  const event = props.event
  const label = KIND_LABEL[event.kind] || event.kind
  return h('div', { className: 'it-event it-' + event.kind },
    h('div', { className: 'it-kind-bar', 'aria-hidden': 'true' }),
    h('div', { className: 'it-event-main' },
      h('div', { className: 'it-event-top' },
        h('span', { className: 'it-badge it-' + event.kind }, label),
        h('span', { className: 'it-tool' }, objectText(event)),
        typeof event.confidence === 'string' && event.confidence !== 'exact'
          ? h('span', { className: 'it-meta' }, '启发式')
          : null,
      ),
      h('p', { className: 'it-excerpt' }, event.excerpt),
      h('div', { className: 'it-meta' },
        h('span', null, 'session ' + event.sessionId),
        h('span', null, 'step ' + stepText(event)),
        h('span', null, 'L' + event.line),
        h('span', null, day(event.time)),
      ),
    ),
    h('div', { className: 'it-event-side' },
      h('span', null, clock(event.time)),
      h('span', { title: '事件日期' }, day(event.time)),
    ),
  )
}

function TimelineView() {
  const [state, setState] = React.useState(snap)
  React.useEffect(function () { return subscribe(setState) }, [])

  const data = state.data
  const stats = (data && data.stats) || { total: 0, 'user-rejected': 0, 'plugin-error': 0, 'runtime-http': 0 }
  const events = (data && data.events) || []
  const exportHref = API + '/export?format=md&download=1&' + queryFor(filter)

  return h('div', { className: 'it-root' },
    h('header', { className: 'it-head' },
      h('div', { className: 'it-eyebrow' }, 'Incident timeline · read-only'),
      h('div', { className: 'it-title-row' },
        h('h1', { className: 'it-title' }, '事故时间线'),
        h('span', { className: 'it-sub' }, '把审批拒绝、插件报错、运行时 HTTP 状态拆开，并保留原始日志行号'),
      ),
    ),
    h('div', { className: 'it-toolbar' },
      h('div', { className: 'it-segment', role: 'group', 'aria-label': '时间窗' },
        FILTERS.map(function (item) {
          return h('button', {
            key: item.id,
            type: 'button',
            'aria-pressed': filter === item.id,
            onClick: function () { setFilter(item.id) },
          }, item.label)
        }),
      ),
      h('div', { className: 'it-spacer' }),
      h('button', { className: 'it-btn', type: 'button', onClick: sync, disabled: state.loading }, state.loading ? '扫描中…' : '重新扫描'),
      h('a', { className: 'it-btn it-btn-primary', href: exportHref, download: 'incident-timeline.md' }, '导出 Markdown'),
    ),
    state.error ? h('div', { className: 'it-error' }, '与 host 通信失败：' + state.error) : null,
    h('div', { className: 'it-stats' },
      h(Stat, { label: '事件', value: stats.total || 0 }),
      h(Stat, { label: 'user rejected', value: stats['user-rejected'] || 0, tone: 'it-rejected' }),
      h(Stat, { label: '插件/工具报错', value: stats['plugin-error'] || 0, tone: 'it-plugin' }),
      h(Stat, { label: '运行时 HTTP', value: stats['runtime-http'] || 0, tone: 'it-http' }),
    ),
    h('section', { className: 'it-card' },
      h('div', { className: 'it-card-head' },
        h('h2', null, '事件'),
        h('span', null, (data && data.windowLabel ? data.windowLabel : '当前时间窗') + ' · ' + events.length + ' 条'),
      ),
      state.loading && events.length === 0
        ? h('div', { className: 'it-list' },
            h('div', { className: 'it-skeleton' }),
            h('div', { className: 'it-skeleton' }),
            h('div', { className: 'it-skeleton' }),
          )
        : events.length === 0
          ? h('div', { className: 'it-empty' },
              h('strong', null, '该时间窗内没有事件'),
              h('span', null, '换一个时间窗，或点击「重新扫描」读取最新会话日志。'),
            )
          : h('div', { className: 'it-list' }, events.map(function (event, index) {
              return h(EventRow, { key: String(event.sessionId) + '-' + event.line + '-' + event.kind + '-' + index, event: event })
            })),
    ),
    h('div', { className: 'it-note' },
      h('span', null, '只读投影：会话文件未修改。'),
      h('span', null, '行号是解压后 JSONL 的物理行号；摘录为原文截断。'),
      data && data.dbPath ? h('code', null, data.dbPath) : null,
    ),
  )
}

function apply(ctx) {
  // Every registration has a teardown: dsh 0.1.6+ can unload a plugin at
  // runtime, and the shared poll lives at module scope beyond one apply().
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      snap = { data: null, error: '', at: 0, loading: true }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-incident-timeline'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  ctx.slots.inject('conversation.view', function () {
    let disposeView
    try {
      disposeView = ctx.slots.register(
        { name: 'conversation.view', id: 'incident-timeline', order: 32, label: '事故时间线' },
        TimelineView,
      )
    } catch (error) {
      disposeView = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-incident-timeline] could not register the 事故时间线 view', error)
      }
    }
    return typeof disposeView === 'function' ? disposeView : function () {}
  })
}

module.exports = {
  name: 'dsh-incident-timeline',
  inject: ['slots'],
  apply: apply,
}
    return module.exports;
  },
});
