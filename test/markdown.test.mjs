import { strict as assert } from 'node:assert'
import test from 'node:test'
import { formatWindow, renderJson, renderMarkdown, tableRows } from '../src/markdown.js'
import { classifyRecords, summarizeEvents } from '../src/timeline.js'
import { incidentScenario } from '../test-fixtures/helpers.mjs'

function scenarioEvents() {
  const records = incidentScenario('session-demo-0001').map((event, index) => ({
    line: index + 1,
    seq: event.seq,
    time: event.time,
    type: event.type,
    event: event,
  }))
  return classifyRecords(records, { sessionId: 'session-demo-0001' })
}

test('markdown has the required columns, counts and per-label sections', () => {
  const events = scenarioEvents()
  const stats = summarizeEvents(events)
  const markdown = renderMarkdown({
    events: events,
    stats: stats,
    window: { since: 1790000000000, until: 1790000030000 },
    root: 'D:\\Projects\\demo',
    sessions: [{ sessionId: 'session-demo-0001' }],
    generatedAt: 1790000040000,
  })
  assert.match(markdown, /^# DSH 事故时间线/m)
  assert.match(markdown, /\| 标签 \| 会话 id \| 步号 \| 原始日志行号 \| 时间（UTC） \| 对象 \| 原文摘录 \|/)
  assert.match(markdown, /session-demo-0001/)
  assert.match(markdown, /\| user rejected \|/)
  assert.match(markdown, /\| 插件\/工具报错 \|/)
  assert.match(markdown, /\| 运行时 HTTP \|/)
  assert.match(markdown, /只读投影/)
  assert.match(markdown, /user-rejected · user rejected（1）/)
  assert.match(markdown, /runtime-http · 运行时 HTTP（2）/)
  assert.match(markdown, /plugin-error · 插件\/工具报错（2）/)
  assert.match(markdown, /分类计数：user rejected 1/)
  assert.match(markdown, /\| 6 \|/, 'the rejected event cites physical line 6')
})

test('table cells escape pipes, angle brackets and newlines', () => {
  const events = [
    {
      kind: 'plugin-error',
      sessionId: 's|1',
      line: 9,
      step: 2,
      turn: 1,
      time: 1790000000000,
      tool: '<script>',
      excerpt: 'a|b\nc<d>e',
      detail: { source: 'tool/result' },
    },
  ]
  const markdown = renderMarkdown({ events: events, stats: summarizeEvents(events), sessions: [] })
  assert.match(markdown, /s\\\|1/)
  assert.match(markdown, /a\\\|b \/ c&lt;d&gt;e/)
  assert.match(markdown, /&lt;script&gt;/)
  assert.ok(!markdown.includes('\n| a|b'), 'raw pipe does not break the table')
})

test('window labels cover open and closed ranges', () => {
  assert.equal(formatWindow({}), '全部时间')
  assert.match(formatWindow({ since: 0 }), /1970-01-01T00:00:00.000Z → 现在/)
  assert.match(formatWindow({ until: 0 }), /最早 → 1970-01-01T00:00:00.000Z/)
  assert.match(formatWindow({ since: 0, until: 1000 }), /1970-01-01T00:00:00.000Z → 1970-01-01T00:00:01.000Z/)
})

test('an empty window still renders a valid table and an explicit empty row', () => {
  const markdown = renderMarkdown({ events: [], stats: summarizeEvents([]), sessions: [] })
  assert.match(markdown, /该窗口内没有匹配事件/)
  assert.match(markdown, /\| \*\*合计\*\* \| 0 \|/)
  assert.equal(tableRows([]).trim().startsWith('| —'), true)
})

test('json export is explicitly read-only and keeps citation fields', () => {
  const events = scenarioEvents()
  const payload = renderJson({
    events: events,
    stats: summarizeEvents(events),
    window: { since: 1, until: 2 },
    root: 'D:\\Projects\\demo',
    dbPath: 'D:\\data\\projection.db',
    sessions: [{ sessionId: 'session-demo-0001' }],
    generatedAt: 1790000040000,
  })
  assert.equal(payload.tool, 'dsh-incident-timeline')
  assert.equal(payload.schema, 1)
  assert.equal(payload.readOnly, true)
  assert.equal(payload.window.since, 1)
  assert.equal(payload.events.length, 5)
  assert.equal(payload.events[0].line, 6)
  assert.equal(payload.events[0].detail.source, 'approval')
  assert.equal(payload.generatedAtIso, '2026-09-21T14:14:00.000Z')
})

test('markdown generation is deterministic for a fixed input', () => {
  const events = scenarioEvents()
  const input = {
    events: events,
    stats: summarizeEvents(events),
    window: {},
    sessions: [],
    generatedAt: 1790000040000,
  }
  assert.equal(renderMarkdown(input), renderMarkdown(input))
})
