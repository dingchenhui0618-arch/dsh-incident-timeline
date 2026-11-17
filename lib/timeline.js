// Incident classification over parsed session records.
//
// Three labels, deliberately kept separate so a rejected tool call is never
// reported as a plugin failure (and vice versa):
//
//   user-rejected  the human (or an approval policy acting as the human)
//                  rejected a tool call. Primary evidence is
//                  `approval/decided{outcome:"rejected"}`; the matching
//                  `tool/result` ("the user rejected tool ...") is a fallback
//                  for logs that recorded only the result.
//   plugin-error   an error surfaced by a tool, hook, command or model stream:
//                  `tool/result` with isError, `hook/result` error, or
//                  `assistant/attempt` / `llm/retry` failure without an HTTP
//                  status. This is the "not a rejection, not HTTP" bucket.
//   runtime-http   an explicit 4xx/5xx status in a failure message, e.g.
//                  `413: {"message":"Request body is too large..."}` or
//                  `HTTP 502 Bad Gateway`.
//
// The classifier is intentionally conservative about inventing facts: an
// event always carries the physical line it came from, the excerpt is copied
// from the log, and `confidence` records whether the match was structural
// (`exact`) or a text heuristic (`heuristic`).

export const KINDS = ['user-rejected', 'plugin-error', 'runtime-http']

export const KIND_LABEL = {
  'user-rejected': 'user rejected',
  'plugin-error': '插件/工具报错',
  'runtime-http': '运行时 HTTP',
}

const KIND_ORDER = new Map(KINDS.map((kind, index) => [kind, index]))

// Strong HTTP patterns. Bare numbers only count with an HTTP/status keyword,
// and only 4xx/5xx are incidents. `413: {...}` is how the gateway reports a
// request-body failure in a finish chunk; requiring a JSON opener after the
// colon keeps grep output such as `532: row["file"]` out of the HTTP bucket.
const HTTP_PATTERNS = [
  /\bHTTP(?:\/\d(?:\.\d)?)?\s*(?:status(?:\s*code)?)?\s*[:=]?\s*([45]\d{2})\b/i,
  /\bstatus(?:\s*code)?\s*[:=]\s*([45]\d{2})\b/i,
  /(?:^|[\s"'(])([45]\d{2}):\s*[\[{"]/,
  /\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Payment Required|Forbidden|Not Found|Method Not Allowed|Request Timeout|Payload Too Large|Request Entity Too Large|Too Many Requests|Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
]

const REJECTION_TEXT = /the user rejected tool\s+"?([^"\r\n]+)"?/i
const ERROR_PREFIX = /^\s*(?:Error|TypeError|RangeError|ToolCallError|Uncaught)\b/i

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function stringify(value, max) {
  try {
    if (typeof value === 'string') return value
    const text = JSON.stringify(value)
    if (typeof text !== 'string') return ''
    return text.length > max ? text.slice(0, max) + '…' : text
  } catch (error) {
    return ''
  }
}

/** Join text parts of a message, including nested tool-result wrappers. */
export function messageText(message) {
  if (message === undefined || message === null) return ''
  if (typeof message === 'string') return message
  const object = asObject(message)
  if (object === undefined) return ''
  if (typeof object.text === 'string' && object.text.length > 0 && (object.type === undefined || object.type === 'text')) {
    return object.text
  }
  if (typeof object.content === 'string') return object.content
  if (!Array.isArray(object.content)) return ''
  const parts = []
  for (const part of object.content) {
    const entry = asObject(part)
    if (entry === undefined) continue
    if (entry.type === 'text' && typeof entry.text === 'string') {
      parts.push(entry.text)
      continue
    }
    // DSH wraps tool results inside a `tool-result` content part whose own
    // `content` array holds the text. Recurse instead of dropping the error.
    if (Array.isArray(entry.content)) {
      const nested = messageText(entry)
      if (nested.length > 0) parts.push(nested)
    }
  }
  return parts.join('\n')
}

function hasErrorFlag(node, depth) {
  const level = typeof depth === 'number' ? depth : 0
  if (level > 6) return false
  const object = asObject(node)
  if (object === undefined) return false
  if (object.isError === true) return true
  if (object.error !== undefined && object.error !== null) return true
  if (Array.isArray(object.content)) {
    for (const part of object.content) {
      if (hasErrorFlag(part, level + 1)) return true
    }
  }
  return false
}

function callIdOf(data) {
  if (data === undefined) return undefined
  if (typeof data.toolCallId === 'string') return data.toolCallId
  if (typeof data.callId === 'string') return data.callId
  const message = asObject(data.message)
  const source = message && asObject(message.source)
  if (source && typeof source.callId === 'string') return source.callId
  return undefined
}

/** Collapse whitespace and cut a raw excerpt for a table cell. */
export function excerpt(text, max) {
  const limit = typeof max === 'number' && max > 0 ? max : 280
  const flat = String(text === undefined || text === null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, ' / ')
    .trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

/** Extract the first 4xx/5xx status mentioned in a failure message. */
export function extractHttpStatus(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  for (const pattern of HTTP_PATTERNS) {
    const match = pattern.exec(text)
    if (match !== null) {
      const status = Number(match[1])
      if (status >= 400 && status <= 599) return status
    }
  }
  return undefined
}

function streamFailures(record) {
  const data = asObject(record.event && record.event.data)
  if (data === undefined || !Array.isArray(data.stream)) return []
  const failures = []
  for (const item of data.stream) {
    const entry = asObject(item)
    if (entry === undefined) continue
    const chunk = asObject(entry.chunk) || asObject(entry)
    if (chunk === undefined) continue
    const reason = asObject(chunk.reason)
    if (chunk.type === 'finish' && reason !== undefined && (reason.kind === 'error' || reason.kind === 'aborted')) {
      const failure = asObject(reason.failure)
      const message =
        (failure && typeof failure.message === 'string' && failure.message) ||
        (typeof reason.message === 'string' && reason.message) ||
        'finish ' + reason.kind
      failures.push({ kind: reason.kind, message: message })
    }
  }
  return failures
}

function genericErrorText(data) {
  if (data === undefined) return ''
  const candidates = [data.error, data.failure, data.reason, data.message]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
    const object = asObject(candidate)
    if (object === undefined) continue
    if (typeof object.message === 'string' && object.message.length > 0) return object.message
    if (typeof object.reason === 'string' && object.reason.length > 0) return object.reason
    const nested = asObject(object.failure)
    if (nested && typeof nested.message === 'string') return nested.message
  }
  // Some hook/command events wrap the failure one level deeper.
  const result = asObject(data.result)
  if (result !== undefined) {
    const nested = genericErrorText(result)
    if (nested.length > 0) return nested
  }
  return ''
}

function toolResultText(record) {
  const data = asObject(record.event && record.event.data) || {}
  const message = asObject(data.message)
  const fromMessage = messageText(message)
  if (fromMessage.length > 0) return fromMessage
  const generic = genericErrorText(data)
  if (generic.length > 0) return generic
  return stringify(data.error, 1200)
}

function turnStep(record) {
  const data = asObject(record.event && record.event.data) || {}
  const message = asObject(data.message)
  return {
    turn: typeof data.turn === 'number' ? data.turn : typeof (message && message.turn) === 'number' ? message.turn : undefined,
    step: typeof data.step === 'number' ? data.step : typeof (message && message.step) === 'number' ? message.step : undefined,
  }
}

function eventTime(record) {
  return typeof record.time === 'number' ? record.time : undefined
}

function baseEvent(record, kind) {
  const position = turnStep(record)
  return {
    kind: kind,
    line: record.line,
    seq: record.seq,
    time: eventTime(record),
    turn: position.turn,
    step: position.step,
    tool: undefined,
    status: undefined,
    excerpt: '',
    confidence: 'exact',
    detail: {},
  }
}

/**
 * Classify parsed records from one session.
 *
 * @param {Array<{line:number,seq?:number,time?:number,type:string,event:object}>} records
 * @param {{sessionId?:string}} [options]
 * @returns {Array<object>} events, sorted by time then line
 */
export function classifyRecords(records, options) {
  const settings = options || {}
  const sessionId = typeof settings.sessionId === 'string' ? settings.sessionId : ''
  const events = []
  const approvals = new Map()
  const calls = new Map()
  const rejections = new Map()

  const rememberCall = (callId, patch) => {
    if (typeof callId !== 'string' || callId.length === 0) return
    const previous = calls.get(callId) || {}
    calls.set(callId, Object.assign({}, previous, patch))
  }

  // First pass: resolve call ids to tool names and positions. Approval events
  // do not carry turn/step; their matching tool/call does.
  for (const record of records) {
    const data = asObject(record.event && record.event.data)
    if (data === undefined) continue
    if (record.type === 'tool/call') {
      rememberCall(data.callId, {
        tool: typeof data.name === 'string' ? data.name : undefined,
        turn: typeof data.turn === 'number' ? data.turn : undefined,
        step: typeof data.step === 'number' ? data.step : undefined,
        callLine: record.line,
      })
    } else if (record.type === 'tool/result') {
      rememberCall(callIdOf(data), {
        turn: typeof data.turn === 'number' ? data.turn : undefined,
        step: typeof data.step === 'number' ? data.step : undefined,
        resultLine: record.line,
      })
    } else if (record.type === 'approval/asked') {
      const id = typeof data.id === 'string' ? data.id : ''
      if (id.length === 0) continue
      approvals.set(id, {
        id: id,
        tool: typeof data.toolName === 'string' ? data.toolName : undefined,
        callId: typeof data.callId === 'string' ? data.callId : undefined,
        reason: typeof data.reason === 'string' ? data.reason : '',
        line: record.line,
        time: eventTime(record),
      })
      rememberCall(data.callId, {
        tool: typeof data.toolName === 'string' ? data.toolName : undefined,
      })
    }
  }

  const push = (event) => {
    event.sessionId = sessionId
    events.push(event)
  }

  const pushRejection = (record, tool, callId, reason, source, askedLine, confidence) => {
    const key = typeof callId === 'string' && callId.length > 0 ? callId : 'line:' + record.line
    if (rejections.has(key)) return
    rejections.set(key, true)
    const event = baseEvent(record, 'user-rejected')
    const call = calls.get(callId)
    event.tool = tool || (call && call.tool)
    event.step = event.step !== undefined ? event.step : call && call.step
    event.turn = event.turn !== undefined ? event.turn : call && call.turn
    event.excerpt = excerpt(reason || 'tool "' + (event.tool || 'unknown') + '" was rejected', 280)
    event.confidence = confidence
    event.detail = {
      source: source,
      eventType: source === 'approval' ? 'approval/decided' : 'tool/result',
      callId: callId || undefined,
      askedLine: askedLine,
      reason: reason || undefined,
    }
    push(event)
  }

  const pushError = (record, kind, text, source, extra) => {
    const base = baseEvent(record, kind)
    const details = Object.assign({ source: source }, extra || {})
    const status = kind === 'runtime-http' ? extractHttpStatus(text) : undefined
    if (kind === 'runtime-http' && status === undefined) return
    base.tool = details.tool
    base.status = status
    base.excerpt = excerpt(text || '(empty failure message)', 280)
    base.confidence = kind === 'runtime-http' ? 'exact' : 'heuristic'
    base.detail = details
    push(base)
  }

  // Second pass: turn records into events.
  for (const record of records) {
    const data = asObject(record.event && record.event.data)
    if (data === undefined) continue

    if (record.type === 'approval/decided') {
      const outcome = String(data.outcome || '').toLowerCase()
      if (!/^(reject|denied|deny)/.test(outcome)) continue
      const id = typeof data.id === 'string' ? data.id : ''
      const asked = approvals.get(id)
      const callId = asked && asked.callId
      pushRejection(
        record,
        asked && asked.tool,
        callId,
        asked && asked.reason,
        'approval',
        asked && asked.line,
        'exact',
      )
      continue
    }

    if (record.type === 'tool/result') {
      const text = toolResultText(record)
      const message = asObject(data.message)
      const isError = data.error !== undefined || (message && hasErrorFlag(message)) || ERROR_PREFIX.test(text)
      const rejection = REJECTION_TEXT.exec(text)
      if (rejection !== null) {
        const tool = rejection[1].trim()
        const callId = callIdOf(data)
        // If approval/decided already produced this rejection, this result is
        // the same incident, not a second one.
        const key = typeof callId === 'string' && callId.length > 0 ? callId : 'line:' + record.line
        if (!rejections.has(key)) {
          pushRejection(
            record,
            tool,
            callId,
            'the user rejected tool "' + tool + '"',
            'tool-result',
            undefined,
            'exact',
          )
        }
        continue
      }
      if (!isError) {
        // A successful shell command can still surface a real runtime HTTP
        // failure. Only an explicit `HTTP/1.1 503` shape counts; a bare
        // `532: ...` is almost always a grep line number.
        if (/\bHTTP\/?\d(?:\.\d)?\s+[45]\d{2}\b/i.test(text)) {
          pushError(record, 'runtime-http', text, 'tool/result', { tool: undefined })
        }
        continue
      }
      const status = extractHttpStatus(text)
      const callId = callIdOf(data)
      const call = calls.get(callId)
      if (status !== undefined) {
        pushError(record, 'runtime-http', text, 'tool/result', { tool: call && call.tool })
      } else {
        pushError(record, 'plugin-error', text, 'tool/result', { tool: call && call.tool })
      }
      continue
    }

    if (record.type === 'assistant/attempt' || record.type === 'llm/retry') {
      const failures = streamFailures(record)
      if (failures.length === 0) {
        const text = genericErrorText(data)
        if (text.length > 0) failures.push({ kind: 'error', message: text })
      }
      for (const failure of failures) {
        const status = extractHttpStatus(failure.message)
        if (status !== undefined) {
          pushError(record, 'runtime-http', failure.message, record.type, {})
        } else {
          pushError(record, 'plugin-error', failure.message, record.type, {})
        }
      }
      continue
    }

    if (record.type === 'hook/result' || record.type === 'command/done') {
      const text = genericErrorText(data) || toolResultText(record)
      const hasError =
        data.error !== undefined ||
        (asObject(data.result) && data.result.error !== undefined) ||
        text.length > 0
      if (!hasError) continue
      const status = extractHttpStatus(text)
      if (status !== undefined) {
        pushError(record, 'runtime-http', text, record.type, {})
      } else {
        pushError(record, 'plugin-error', text, record.type, {})
      }
    }
  }

  events.sort((a, b) => {
    const at = a.time === undefined ? 0 : a.time
    const bt = b.time === undefined ? 0 : b.time
    if (at !== bt) return at - bt
    if (a.line !== b.line) return a.line - b.line
    return (KIND_ORDER.get(a.kind) || 0) - (KIND_ORDER.get(b.kind) || 0)
  })
  return events
}

/** Count events by label, always returning all three keys. */
export function summarizeEvents(events) {
  const counts = { total: 0, 'user-rejected': 0, 'plugin-error': 0, 'runtime-http': 0 }
  for (const event of events) {
    counts.total += 1
    if (counts[event.kind] === undefined) counts[event.kind] = 0
    counts[event.kind] += 1
  }
  return counts
}

/** Parse an ISO timestamp or an epoch-millisecond string. */
export function toEpochMs(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^-?\d+$/.test(trimmed)) {
      const number = Number(trimmed)
      if (Number.isFinite(number)) return number
    }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Filter events by an inclusive time window and optional kind/session sets.
 *
 * @param {Array<object>} events
 * @param {{since?:number,until?:number,kinds?:string[],session?:string}} [filter]
 */
export function filterEvents(events, filter) {
  const settings = filter || {}
  const since = typeof settings.since === 'number' ? settings.since : undefined
  const until = typeof settings.until === 'number' ? settings.until : undefined
  const kinds = Array.isArray(settings.kinds) && settings.kinds.length > 0 ? new Set(settings.kinds) : undefined
  const session = typeof settings.session === 'string' && settings.session.length > 0 ? settings.session : undefined
  return events.filter((event) => {
    if (kinds !== undefined && !kinds.has(event.kind)) return false
    if (session !== undefined && event.sessionId !== session) return false
    if (since !== undefined && (event.time === undefined || event.time < since)) return false
    if (until !== undefined && (event.time === undefined || event.time > until)) return false
    return true
  })
}
