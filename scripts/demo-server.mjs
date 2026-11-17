#!/usr/bin/env node
// Local demo for screenshots and for inspecting the panel without installing
// the plugin into a DSH profile. It uses the real host route and a synthetic
// sessions tree; no real ~/.dsh data is read or copied.

import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHandler } from '../src/host.js'
import { event, header, incidentScenario, rejectionOnlyScenario, resetClock, writeSession } from '../test-fixtures/helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const demoRoot = join(root, 'docs', '.demo-data')
const sessionsRoot = join(demoRoot, 'sessions')
const dataDir = join(demoRoot, 'data')
const port = Number(process.env.PORT || 4317)

function httpScenario(id) {
  resetClock()
  return [
    header(id),
    event('turn/start', { turn: 1 }),
    event('step/start', { turn: 1, step: 1 }),
    event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-web',
      name: 'web_fetch',
      arguments: '{"url":"https://example.invalid/status"}',
    }),
    event('tool/result', {
      turn: 1,
      step: 1,
      toolCallId: 'call-web',
      message: {
        role: 'tool',
        toolCallId: 'call-web',
        isError: true,
        content: [{ type: 'text', text: 'HTTP/1.1 503 Service Unavailable\nupstream overloaded' }],
      },
    }),
    event('step/end', { turn: 1, step: 1 }),
    event('step/start', { turn: 1, step: 2 }),
    event('assistant/attempt', {
      turn: 1,
      step: 2,
      stream: [
        {
          type: 'chunk',
          chunk: {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: '429: {"message":"Too many requests; retry later"}' },
            },
          },
        },
      ],
    }),
    event('hook/result', { hook: 'demo', error: { message: 'plugin hook timed out after 1s' } }),
    event('step/end', { turn: 1, step: 2 }),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

rmSync(demoRoot, { recursive: true, force: true })
writeSession(sessionsRoot, 'session-demo-a1b2', incidentScenario('session-demo-a1b2'))
writeSession(sessionsRoot, 'session-demo-c3d4', rejectionOnlyScenario('session-demo-c3d4'), { bucket: '_no-cwd' })
writeSession(sessionsRoot, 'session-demo-e5f6', httpScenario('session-demo-e5f6'), { bucket: '--D-Projects--' })

const host = createHandler({
  sessionsRoot: sessionsRoot,
  dataDir: dataDir,
  autoSync: true,
  staleMs: 0,
  maxSessionBytes: 64 * 1024 * 1024,
})

const server = createServer(function (req, res) {
  if (req.url === '/' || req.url === '') {
    res.statusCode = 302
    res.setHeader('location', '/dsh-incident-timeline/preview')
    res.end('')
    return
  }
  Promise.resolve(host.handler(req, res)).catch(function (error) {
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
    }
    res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
  })
})

server.listen(port, '127.0.0.1', function () {
  console.log('demo: http://127.0.0.1:' + port + '/dsh-incident-timeline/preview')
})

function shutdown() {
  server.close(function () {
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
