// Shared test helpers: build synthetic multi-frame session logs without
// committing any real ~/.dsh data to the repository.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

let nextSeq = 0
let nextTime = 1_790_000_000_000

export function resetClock() {
  nextSeq = 0
  nextTime = 1_790_000_000_000
}

export function event(type, data, extra) {
  nextSeq += 1
  nextTime += 1000
  return Object.assign({ type: type, seq: nextSeq, time: nextTime, data: data }, extra || {})
}

export function header(id, extra) {
  return Object.assign(
    {
      type: 'session',
      version: 4,
      id: id,
      createdAt: nextTime,
      cwd: 'D:\\Projects\\demo',
      isSeeded: false,
    },
    extra || {},
  )
}

/** Encode a list of JSON values as one zstd frame per value. */
export function encodeFrames(records, perFrame) {
  const size = typeof perFrame === 'number' && perFrame > 0 ? perFrame : 1
  const frames = []
  for (let index = 0; index < records.length; index += size) {
    const chunk = records
      .slice(index, index + size)
      .map((record) => JSON.stringify(record))
      .join('\n')
    frames.push(zstdCompressSync(Buffer.from(chunk + (index + size < records.length ? '\n' : ''), 'utf8')))
  }
  return Buffer.concat(frames)
}

/**
 * Write a synthetic session.
 *
 * @param {string} root sessions root
 * @param {string} id session id / directory name
 * @param {Array<object>|{text:string}} records
 * @param {{bucket?:string,version?:number,perFrame?:number,plain?:boolean}} [options]
 */
export function writeSession(root, id, records, options) {
  const settings = options || {}
  const bucket = settings.bucket === undefined ? '--D-Projects--' : settings.bucket
  const dir = bucket.length > 0 ? join(root, bucket, id) : join(root, id)
  mkdirSync(dir, { recursive: true })
  const version = settings.version || 4
  if (settings.plain === true) {
    const text = typeof records.text === 'string' ? records.text : records.map((record) => JSON.stringify(record)).join('\n') + '\n'
    const file = join(dir, 'session.v' + version + '.jsonl')
    writeFileSync(file, text, 'utf8')
    return file
  }
  const payload =
    records !== null && typeof records === 'object' && typeof records.text === 'string'
      ? zstdCompressSync(Buffer.from(records.text, 'utf8'))
      : encodeFrames(records, settings.perFrame)
  const file = join(dir, 'session.v' + version + '.jsonl.zstd')
  writeFileSync(file, payload)
  return file
}

/**
 * A realistic mixed incident scenario. Physical line numbers are predictable:
 * every record below is one line.
 */
export function incidentScenario(id) {
  resetClock()
  const sessionId = id || 'session-demo-0001'
  return [
    header(sessionId),
    event('turn/start', { turn: 1 }),
    event('step/start', { turn: 1, step: 1 }),
    event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-write',
      name: 'write',
      arguments: '{"file_path":"D:\\\\Projects\\\\demo\\\\a.txt","content":"x"}',
    }),
    event('approval/asked', {
      id: 'approval-1',
      toolName: 'write',
      callId: 'call-write',
      reason: 'unrecognised tool write; confirm before it runs',
    }),
    event('approval/decided', { id: 'approval-1', outcome: 'rejected' }),
    event('tool/result', {
      turn: 1,
      step: 1,
      toolCallId: 'call-write',
      message: {
        role: 'tool',
        toolCallId: 'call-write',
        isError: true,
        content: [{ type: 'text', text: 'Error: the user rejected tool "write"' }],
      },
    }),
    event('step/end', { turn: 1, step: 1 }),
    event('step/start', { turn: 1, step: 2 }),
    event('tool/call', {
      turn: 1,
      step: 2,
      callId: 'call-plugin',
      name: 'den_status',
      arguments: '{}',
    }),
    event('tool/result', {
      turn: 1,
      step: 2,
      toolCallId: 'call-plugin',
      message: {
        role: 'tool',
        toolCallId: 'call-plugin',
        isError: true,
        content: [{ type: 'text', text: 'Error: plugin "den" failed to load its status route' }],
      },
    }),
    event('step/end', { turn: 1, step: 2 }),
    event('step/start', { turn: 1, step: 3 }),
    event('tool/call', {
      turn: 1,
      step: 3,
      callId: 'call-http',
      name: 'pwsh',
      arguments: '{"command":"curl http://127.0.0.1:10100/v1/models"}',
    }),
    event('tool/result', {
      turn: 1,
      step: 3,
      toolCallId: 'call-http',
      message: {
        role: 'tool',
        toolCallId: 'call-http',
        isError: true,
        content: [{ type: 'text', text: 'HTTP/1.1 502 Bad Gateway\nupstream unavailable' }],
      },
    }),
    event('step/end', { turn: 1, step: 3 }),
    event('step/start', { turn: 1, step: 4 }),
    event('assistant/attempt', {
      turn: 1,
      step: 4,
      stream: [
        {
          type: 'chunk',
          chunk: {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: '413: {"message":"Request body is too large","code":"request_too_large"}' },
            },
          },
        },
      ],
    }),
    event('step/end', { turn: 1, step: 4 }),
    event('step/start', { turn: 1, step: 5 }),
    event('hook/result', { hook: 'demo', error: { message: 'hook exploded while formatting the reply' } }),
    event('step/end', { turn: 1, step: 5 }),
    event('step/start', { turn: 1, step: 6 }),
    event('tool/result', {
      turn: 1,
      step: 6,
      toolCallId: 'call-ok',
      message: {
        role: 'tool',
        toolCallId: 'call-ok',
        isError: false,
        content: [{ type: 'text', text: 'HTTP/1.1 200 OK\nall good' }],
      },
    }),
    event('step/end', { turn: 1, step: 6 }),
    event('compaction/prune', {
      shadowedRange: { start: 1, end: 2 },
      shadowedSeqs: [2, 3],
      shadowedTokenCount: 120,
    }),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

/** A log that only recorded the rejection result, without approval events. */
export function rejectionOnlyScenario(id) {
  resetClock()
  return [
    header(id || 'session-demo-0002'),
    event('step/start', { turn: 1, step: 2 }),
    event('tool/call', {
      turn: 1,
      step: 2,
      callId: 'call-only',
      name: 'send_message',
      arguments: '{"agent_id":"parent","message":"report"}',
    }),
    event('tool/result', {
      turn: 1,
      step: 2,
      toolCallId: 'call-only',
      message: {
        role: 'tool',
        toolCallId: 'call-only',
        isError: true,
        content: [{ type: 'text', text: 'Error: the user rejected tool "send_message"' }],
      },
    }),
    event('step/end', { turn: 1, step: 2 }),
  ]
}
