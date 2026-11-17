import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  KINDS,
  classifyRecords,
  excerpt,
  extractHttpStatus,
  filterEvents,
  messageText,
  summarizeEvents,
  toEpochMs,
} from '../src/timeline.js'
import { incidentScenario, rejectionOnlyScenario } from '../test-fixtures/helpers.mjs'

function parsed(events) {
  return events.map((event, index) => ({
    line: index + 1,
    seq: event.seq,
    time: event.time,
    type: event.type,
    event: event,
  }))
}

test('the three labels stay separate in a mixed incident', () => {
  const events = classifyRecords(parsed(incidentScenario('session-demo-0001')), { sessionId: 'session-demo-0001' })
  assert.equal(events.length, 5)
  assert.deepEqual(
    events.map((event) => event.kind),
    ['user-rejected', 'plugin-error', 'runtime-http', 'runtime-http', 'plugin-error'],
  )

  const rejected = events[0]
  assert.equal(rejected.line, 6)
  assert.equal(rejected.tool, 'write')
  assert.equal(rejected.turn, 1)
  assert.equal(rejected.step, 1)
  assert.match(rejected.excerpt, /unrecognised tool write/)
  assert.equal(rejected.confidence, 'exact')
  assert.equal(rejected.detail.source, 'approval')
  assert.equal(rejected.detail.askedLine, 5)
})

test('a rejection result is deduplicated against approval/decided', () => {
  const events = classifyRecords(parsed(incidentScenario()), { sessionId: 's' })
  const rejections = events.filter((event) => event.kind === 'user-rejected')
  assert.equal(rejections.length, 1)
  assert.equal(rejections[0].line, 6)
  assert.ok(!events.some((event) => event.line === 7), 'the tool/result line is not a second event')
})

test('a rejection recorded only as a tool result is still found, with step', () => {
  const events = classifyRecords(parsed(rejectionOnlyScenario('session-demo-0002')), { sessionId: 'session-demo-0002' })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'user-rejected')
  assert.equal(events[0].line, 4)
  assert.equal(events[0].tool, 'send_message')
  assert.equal(events[0].step, 2)
  assert.equal(events[0].detail.source, 'tool-result')
})

test('tool errors, hook errors and HTTP statuses are classified by evidence', () => {
  const events = classifyRecords(parsed(incidentScenario()), { sessionId: 's' })
  const plugin = events.find((event) => event.kind === 'plugin-error' && event.line === 11)
  assert.ok(plugin)
  assert.equal(plugin.tool, 'den_status')
  assert.equal(plugin.step, 2)

  const http = events.find((event) => event.kind === 'runtime-http' && event.line === 15)
  assert.ok(http)
  assert.equal(http.status, 502)
  assert.equal(http.tool, 'pwsh')
  assert.equal(http.step, 3)

  const tooLarge = events.find((event) => event.kind === 'runtime-http' && event.line === 18)
  assert.ok(tooLarge)
  assert.equal(tooLarge.status, 413)
  assert.equal(tooLarge.step, 4)

  const hook = events.find((event) => event.kind === 'plugin-error' && event.line === 21)
  assert.ok(hook)
  assert.equal(hook.detail.source, 'hook/result')
})

test('successful HTTP 200 output is not an incident', () => {
  const events = classifyRecords(parsed(incidentScenario()), { sessionId: 's' })
  assert.ok(!events.some((event) => event.line === 24))
  assert.ok(!events.some((event) => event.status === 200))
})

test('HTTP extraction is strict about context and only reports 4xx/5xx', () => {
  assert.equal(extractHttpStatus('413: {"message":"Request body is too large"}'), 413)
  assert.equal(extractHttpStatus('413: Request body is too large'), undefined)
  assert.equal(extractHttpStatus('532: r["rows"][0]["media"][0]'), undefined)
  assert.equal(extractHttpStatus('540: function BotPanel(props) {'), undefined)
  assert.equal(extractHttpStatus('HTTP/1.1 502 Bad Gateway'), 502)
  assert.equal(extractHttpStatus('upstream returned status code: 429'), 429)
  assert.equal(extractHttpStatus('HTTP 200 OK'), undefined)
  assert.equal(extractHttpStatus('GET http://127.0.0.1:3080/state returned 500'), undefined)
  assert.equal(extractHttpStatus('port 443 is open'), undefined)
  assert.equal(extractHttpStatus(''), undefined)
})

test('event window filtering is inclusive on both ends', () => {
  const events = classifyRecords(parsed(incidentScenario()), { sessionId: 's' })
  const times = events.map((event) => event.time)
  const middle = events[2]
  assert.deepEqual(filterEvents(events, { since: middle.time, until: middle.time }), [middle])
  assert.equal(filterEvents(events, { since: middle.time + 1 }).length, 2)
  assert.equal(filterEvents(events, { until: middle.time - 1 }).length, 2)
  assert.equal(filterEvents(events, { kinds: ['runtime-http'] }).length, 2)
  assert.equal(filterEvents(events, { session: 'other' }).length, 0)
  assert.equal(filterEvents(events, { session: 's' }).length, 5)
  assert.ok(times.every((time) => typeof time === 'number'))
})

test('timestamps accept ISO strings and epoch milliseconds', () => {
  assert.equal(toEpochMs('1970-01-01T00:00:01Z'), 1000)
  assert.equal(toEpochMs('1000'), 1000)
  assert.equal(toEpochMs(1000), 1000)
  assert.equal(toEpochMs('not a date'), undefined)
  assert.equal(toEpochMs(''), undefined)
  assert.equal(toEpochMs(undefined), undefined)
})

test('summaries always expose all three labels', () => {
  const summary = summarizeEvents([
    { kind: 'user-rejected' },
    { kind: 'runtime-http' },
    { kind: 'runtime-http' },
  ])
  assert.deepEqual(summary, { total: 3, 'user-rejected': 1, 'plugin-error': 0, 'runtime-http': 2 })
  assert.deepEqual(KINDS, ['user-rejected', 'plugin-error', 'runtime-http'])
})

test('nested tool-result wrappers keep their text and tool name', () => {
  const records = parsed([
    { type: 'tool/call', seq: 1, time: 1790000000000, data: { turn: 1, step: 2, callId: 'call-web', name: 'web_fetch', arguments: '{}' } },
    {
      type: 'tool/result',
      seq: 2,
      time: 1790000001000,
      data: {
        turn: 1,
        step: 2,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'call-web' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-web',
              isError: true,
              content: [{ type: 'text', text: 'Error: web fetch failed: TypeError: fetch failed' }],
            },
          ],
        },
        error: { name: 'WebError', code: 'WEB_PROVIDER_ERROR' },
      },
    },
  ])
  const events = classifyRecords(records, { sessionId: 'nested' })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'plugin-error')
  assert.equal(events[0].tool, 'web_fetch')
  assert.equal(events[0].step, 2)
  assert.match(events[0].excerpt, /web fetch failed/)
  assert.notEqual(events[0].excerpt, '(empty failure message)')
})

test('message text ignores tool-call parts and excerpt flattens table hazards', () => {
  assert.equal(
    messageText({
      content: [
        { type: 'text', text: 'line one' },
        { type: 'tool-call', name: 'pwsh' },
        { type: 'text', text: 'line two' },
      ],
    }),
    'line one\nline two',
  )
  assert.equal(messageText('plain'), 'plain')
  assert.equal(excerpt('a|b\nc\td', 40), 'a|b / c d')
  assert.equal(excerpt('x'.repeat(300), 10), 'xxxxxxxxxx…')
})
