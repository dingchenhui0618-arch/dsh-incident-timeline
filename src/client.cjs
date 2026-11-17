// Client half of dsh-incident-timeline: the 事故时间线 Tab in the conversation
// view. Must stay CommonJS — the build wraps this in
// window.__ModuleLoader__.load() and React comes from the harness.

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

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
