// SQLite projection for session logs.
//
// The original reference project projects decoded logs into segments and
// replacements; this project needs the same "stable shape to query" step but
// for a narrower purpose: every incident event must be traceable back to a
// physical line in the decoded JSONL. The schema below keeps:
//
//   sessions          one row per session file (bytes + mtime for incremental sync)
//   records           per-line metadata; payloads are capped and only kept for
//                     event types that can produce a timeline row
//   segments          turn/step line ranges (the projection layer)
//   replacements      compaction shadow ranges (the projection layer)
//   timeline_events   classified incidents with session id, step, line, excerpt
//
// Writes go only to <dataDir>/projection.db. Session files are opened read-only
// by the scanner and never written.

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { discoverSessionFiles, scanSessionFile } from './scan.js'
import { classifyRecords } from './timeline.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  dir TEXT NOT NULL,
  version INTEGER,
  cwd TEXT,
  created_at INTEGER,
  bytes INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  frames INTEGER NOT NULL DEFAULT 0,
  decoded_lines INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0,
  malformed INTEGER NOT NULL DEFAULT 0,
  decode_complete INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  session_id TEXT NOT NULL,
  line INTEGER NOT NULL,
  seq INTEGER,
  type TEXT NOT NULL,
  time INTEGER,
  turn INTEGER,
  step INTEGER,
  payload TEXT NOT NULL DEFAULT '',
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  payload_truncated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, line)
);
CREATE INDEX IF NOT EXISTS records_session_time ON records (session_id, time);
CREATE INDEX IF NOT EXISTS records_session_type ON records (session_id, type);

CREATE TABLE IF NOT EXISTS segments (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  step INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_seq INTEGER,
  end_seq INTEGER,
  event_count INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'step',
  PRIMARY KEY (session_id, turn, step)
);

CREATE TABLE IF NOT EXISTS replacements (
  session_id TEXT NOT NULL,
  line INTEGER NOT NULL,
  seq INTEGER,
  shadowed_start INTEGER,
  shadowed_end INTEGER,
  shadowed_seqs TEXT,
  token_count INTEGER,
  PRIMARY KEY (session_id, line)
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  line INTEGER NOT NULL,
  seq INTEGER,
  time INTEGER,
  turn INTEGER,
  step INTEGER,
  kind TEXT NOT NULL,
  tool TEXT,
  status INTEGER,
  excerpt TEXT NOT NULL,
  confidence TEXT NOT NULL,
  detail TEXT NOT NULL,
  UNIQUE (session_id, line, kind, detail)
);
CREATE INDEX IF NOT EXISTS timeline_events_time ON timeline_events (time, session_id, line);
CREATE INDEX IF NOT EXISTS timeline_events_kind ON timeline_events (kind, time);
`

// Payloads for these types are useful after a scan (e.g. showing the rejected
// tool's arguments), but storing every assistant message would duplicate most
// of the session log. Everything else keeps metadata only and can still be
// cited by line.
const PAYLOAD_TYPES = new Set([
  'session',
  'approval/asked',
  'approval/decided',
  'tool/call',
  'tool/result',
  'assistant/attempt',
  'hook/result',
  'command/done',
  'llm/retry',
  'compaction/prune',
])

const PAYLOAD_LIMIT = 12000

export function openProjection(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.length === 0) throw new Error('dbPath is required')
  const absolute = resolve(dbPath)
  mkdirSync(dirname(absolute), { recursive: true })
  const db = new DatabaseSync(absolute)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  return db
}

export function closeProjection(db) {
  if (db && typeof db.close === 'function') db.close()
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value) {
  return typeof value === 'string' ? value : null
}

function deriveSegments(records) {
  const byStep = new Map()
  for (const record of records) {
    const data = record.event && record.event.data
    if (data === null || typeof data !== 'object') continue
    if (typeof data.turn !== 'number' || typeof data.step !== 'number') continue
    const key = data.turn + ':' + data.step
    let segment = byStep.get(key)
    if (segment === undefined) {
      segment = {
        turn: data.turn,
        step: data.step,
        startLine: record.line,
        endLine: record.line,
        startSeq: record.seq,
        endSeq: record.seq,
        eventCount: 0,
      }
      byStep.set(key, segment)
    }
    segment.endLine = record.line
    if (typeof record.seq === 'number') {
      if (segment.startSeq === undefined) segment.startSeq = record.seq
      segment.endSeq = record.seq
    }
    segment.eventCount += 1
  }
  return Array.from(byStep.values()).sort((a, b) => a.turn - b.turn || a.step - b.step)
}

function deriveReplacements(records) {
  const rows = []
  for (const record of records) {
    if (record.type !== 'compaction/prune') continue
    const data = record.event && record.event.data
    if (data === null || typeof data !== 'object') continue
    const range = data.shadowedRange
    if (range === null || typeof range !== 'object') continue
    rows.push({
      line: record.line,
      seq: record.seq,
      shadowedStart: asNumber(range.start),
      shadowedEnd: asNumber(range.end),
      shadowedSeqs: Array.isArray(data.shadowedSeqs) ? JSON.stringify(data.shadowedSeqs) : null,
      tokenCount: asNumber(data.shadowedTokenCount),
    })
  }
  return rows
}

function insertSession(db, meta, scan) {
  const stmt = db.prepare(`
    INSERT INTO sessions
      (id, path, dir, version, cwd, created_at, bytes, mtime_ms, frames,
       decoded_lines, records, malformed, decode_complete, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    meta.sessionId,
    meta.file,
    meta.sessionDir,
    meta.version,
    asString(scan.cwd),
    asNumber(scan.createdAt),
    meta.bytes,
    meta.mtimeMs,
    scan.decode.frames,
    scan.lineCount,
    scan.records.length,
    scan.malformed.length,
    scan.decode.complete ? 1 : 0,
    Date.now(),
  )
}

function insertRecords(db, sessionId, records) {
  const stmt = db.prepare(`
    INSERT INTO records
      (session_id, line, seq, type, time, turn, step, payload, payload_bytes, payload_truncated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const record of records) {
    const data = record.event && record.event.data
    const turn = data && typeof data.turn === 'number' ? data.turn : null
    const step = data && typeof data.step === 'number' ? data.step : null
    let payload = ''
    let payloadBytes = 0
    let truncated = 0
    if (PAYLOAD_TYPES.has(record.type)) {
      try {
        payload = JSON.stringify(record.event)
      } catch (error) {
        payload = ''
      }
      payloadBytes = Buffer.byteLength(payload)
      if (payload.length > PAYLOAD_LIMIT) {
        payload = payload.slice(0, PAYLOAD_LIMIT)
        truncated = 1
      }
    }
    stmt.run(
      sessionId,
      record.line,
      asNumber(record.seq),
      record.type,
      asNumber(record.time),
      turn,
      step,
      payload,
      payloadBytes,
      truncated,
    )
  }
}

function insertSegments(db, sessionId, segments) {
  const stmt = db.prepare(`
    INSERT INTO segments
      (session_id, turn, step, start_line, end_line, start_seq, end_seq, event_count, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'step')
  `)
  for (const segment of segments) {
    stmt.run(
      sessionId,
      segment.turn,
      segment.step,
      segment.startLine,
      segment.endLine,
      asNumber(segment.startSeq),
      asNumber(segment.endSeq),
      segment.eventCount,
    )
  }
}

function insertReplacements(db, sessionId, replacements) {
  const stmt = db.prepare(`
    INSERT INTO replacements
      (session_id, line, seq, shadowed_start, shadowed_end, shadowed_seqs, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of replacements) {
    stmt.run(
      sessionId,
      row.line,
      asNumber(row.seq),
      asNumber(row.shadowedStart),
      asNumber(row.shadowedEnd),
      row.shadowedSeqs,
      asNumber(row.tokenCount),
    )
  }
}

function insertEvents(db, sessionId, events) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO timeline_events
      (session_id, line, seq, time, turn, step, kind, tool, status, excerpt, confidence, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const event of events) {
    stmt.run(
      sessionId,
      event.line,
      asNumber(event.seq),
      asNumber(event.time),
      asNumber(event.turn),
      asNumber(event.step),
      event.kind,
      asString(event.tool),
      asNumber(event.status),
      event.excerpt,
      event.confidence,
      JSON.stringify(event.detail || {}),
    )
  }
}

/**
 * Rewrite one session's projection in a transaction.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sessionId:string,file:string,sessionDir:string,version:number,bytes:number,mtimeMs:number}} meta
 * @param {ReturnType<typeof scanSessionFile>} scan
 */
export function projectSession(db, meta, scan) {
  const sessionId = typeof scan.sessionId === 'string' && scan.sessionId.length > 0 ? scan.sessionId : meta.sessionId
  const events = classifyRecords(scan.records, { sessionId: sessionId })
  const segments = deriveSegments(scan.records)
  const replacements = deriveReplacements(scan.records)

  db.exec('BEGIN IMMEDIATE')
  try {
    // A session header can carry an id that differs from its directory name.
    // Clean up any row previously projected for the same path as well as the
    // row for the id we are about to write, so an id change cannot leave a
    // stale duplicate behind.
    const old = db.prepare('SELECT id FROM sessions WHERE path = ?').get(meta.file)
    const staleIds = new Set([sessionId])
    if (old !== undefined && typeof old.id === 'string') staleIds.add(old.id)
    for (const staleId of staleIds) {
      for (const table of ['records', 'segments', 'replacements', 'timeline_events']) {
        db.prepare('DELETE FROM ' + table + ' WHERE session_id = ?').run(staleId)
      }
      db.prepare('DELETE FROM sessions WHERE id = ?').run(staleId)
    }
    insertSession(db, Object.assign({}, meta, { sessionId: sessionId }), scan)
    insertRecords(db, sessionId, scan.records)
    insertSegments(db, sessionId, segments)
    insertReplacements(db, sessionId, replacements)
    insertEvents(db, sessionId, events)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError) {
      // Preserve the original failure.
    }
    throw error
  }

  return {
    sessionId: sessionId,
    records: scan.records.length,
    segments: segments.length,
    replacements: replacements.length,
    events: events.length,
    malformed: scan.malformed.length,
  }
}

function existingSession(db, meta) {
  const row = db.prepare('SELECT id, bytes, mtime_ms FROM sessions WHERE path = ?').get(meta.file)
  return row === undefined ? undefined : row
}

/**
 * Incrementally project every session under a root.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} root
 * @param {{force?:boolean, prune?:boolean, limit?:number, now?:number}} [options]
 */
export function syncProjection(db, root, options) {
  const settings = options || {}
  const started = Date.now()
  const rootExists = existsSync(root)
  const files = rootExists ? discoverSessionFiles(root) : []
  const limit = typeof settings.limit === 'number' && settings.limit > 0 ? settings.limit : files.length
  const candidates = files.slice(0, limit)
  const stats = {
    root: root,
    rootExists: rootExists,
    discovered: files.length,
    scanned: 0,
    skipped: 0,
    oversized: 0,
    failed: 0,
    pruned: 0,
    sessions: 0,
    records: 0,
    events: 0,
    malformed: 0,
    errors: [],
    durationMs: 0,
    syncedAt: started,
  }

  for (const meta of candidates) {
    const existing = existingSession(db, meta)
    if (settings.force !== true && existing !== undefined && existing.bytes === meta.bytes && existing.mtime_ms === meta.mtimeMs) {
      stats.skipped += 1
      continue
    }
    try {
      const scan = scanSessionFile(meta.file, {
        maxSessionBytes: settings.maxSessionBytes,
        maxDecodedBytes: settings.maxDecodedBytes,
      })
      if (scan.oversized === true) {
        stats.oversized += 1
        stats.errors.push({ file: meta.file, message: scan.error })
        continue
      }
      const result = projectSession(db, meta, scan)
      stats.scanned += 1
      stats.records += result.records
      stats.events += result.events
      stats.malformed += result.malformed
    } catch (error) {
      stats.failed += 1
      stats.errors.push({
        file: meta.file,
        message: String((error && error.message) || error),
      })
    }
  }

  // Pruning is opt-in and only safe after a complete discovery pass. With a
  // limit (or a missing root) "not seen this run" does not mean "deleted".
  if (settings.prune === true && rootExists && limit >= files.length) {
    const knownPaths = new Set(candidates.map((meta) => meta.file))
    const rows = db.prepare('SELECT id, path FROM sessions').all()
    for (const row of rows) {
      if (knownPaths.has(row.path)) continue
      const id = row.id
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const table of ['records', 'segments', 'replacements', 'timeline_events']) {
          db.prepare('DELETE FROM ' + table + ' WHERE session_id = ?').run(id)
        }
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
        db.exec('COMMIT')
        stats.pruned += 1
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch (rollbackError) {
          // ignore
        }
      }
    }
  }

  stats.sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
  stats.durationMs = Date.now() - started
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'last_sync',
    JSON.stringify({ at: stats.syncedAt, ...stats, errors: stats.errors.slice(0, 20) }),
  )
  return stats
}

function rowToEvent(row) {
  let detail = {}
  try {
    detail = JSON.parse(row.detail)
  } catch (error) {
    detail = {}
  }
  return {
    kind: row.kind,
    sessionId: row.session_id,
    line: row.line,
    seq: row.seq === null ? undefined : row.seq,
    time: row.time === null ? undefined : row.time,
    turn: row.turn === null ? undefined : row.turn,
    step: row.step === null ? undefined : row.step,
    tool: row.tool === null ? undefined : row.tool,
    status: row.status === null ? undefined : row.status,
    excerpt: row.excerpt,
    confidence: row.confidence,
    detail: detail,
  }
}

function eventWhere(filter) {
  const settings = filter || {}
  const clauses = []
  const params = []
  if (typeof settings.since === 'number') {
    clauses.push('time IS NOT NULL AND time >= ?')
    params.push(settings.since)
  }
  if (typeof settings.until === 'number') {
    clauses.push('time IS NOT NULL AND time <= ?')
    params.push(settings.until)
  }
  if (typeof settings.session === 'string' && settings.session.length > 0) {
    clauses.push('session_id = ?')
    params.push(settings.session)
  }
  if (Array.isArray(settings.kinds) && settings.kinds.length > 0) {
    clauses.push('kind IN (' + settings.kinds.map(() => '?').join(',') + ')')
    params.push(...settings.kinds)
  }
  return { sql: clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '', params: params }
}

/**
 * Count matching events by label. Kept separate from loadEvents so the UI
 * totals stay correct when the visible list is capped by `limit`.
 */
export function countEvents(db, filter) {
  const where = eventWhere(filter)
  const rows = db
    .prepare('SELECT kind, COUNT(*) AS n FROM timeline_events' + where.sql + ' GROUP BY kind')
    .all(...where.params)
  const counts = { total: 0, 'user-rejected': 0, 'plugin-error': 0, 'runtime-http': 0 }
  for (const row of rows) {
    const n = Number(row.n)
    counts.total += n
    if (counts[row.kind] === undefined) counts[row.kind] = 0
    counts[row.kind] += n
  }
  return counts
}

/**
 * Load timeline events from the projection, optionally filtered.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{since?:number,until?:number,kinds?:string[],session?:string,limit?:number}} [filter]
 */
export function loadEvents(db, filter) {
  const settings = filter || {}
  const where = eventWhere(settings)
  const limit = typeof settings.limit === 'number' && settings.limit > 0 ? Math.min(settings.limit, 5000) : 1000
  const rows = db
    .prepare(
      'SELECT * FROM timeline_events' +
        where.sql +
        ' ORDER BY COALESCE(time, 0) ASC, session_id ASC, line ASC LIMIT ?',
    )
    .all(...where.params, limit)
  return rows.map(rowToEvent)
}

export function loadSessions(db) {
  const rows = db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM timeline_events e WHERE e.session_id = s.id) AS event_count,
        (SELECT COUNT(*) FROM timeline_events e WHERE e.session_id = s.id AND e.kind = 'user-rejected') AS rejected_count,
        (SELECT COUNT(*) FROM timeline_events e WHERE e.session_id = s.id AND e.kind = 'plugin-error') AS plugin_error_count,
        (SELECT COUNT(*) FROM timeline_events e WHERE e.session_id = s.id AND e.kind = 'runtime-http') AS http_count
       FROM sessions s ORDER BY s.created_at ASC, s.id ASC`,
    )
    .all()
  return rows.map((row) => ({
    sessionId: row.id,
    path: row.path,
    cwd: row.cwd === null ? undefined : row.cwd,
    createdAt: row.created_at === null ? undefined : row.created_at,
    bytes: row.bytes,
    records: row.records,
    malformed: row.malformed,
    decodeComplete: row.decode_complete === 1,
    eventCount: row.event_count,
    counts: {
      'user-rejected': row.rejected_count,
      'plugin-error': row.plugin_error_count,
      'runtime-http': row.http_count,
    },
  }))
}

export function loadProjectionSummary(db, filter) {
  const events = loadEvents(db, filter)
  return {
    events: events,
    stats: countEvents(db, filter),
    sessions: loadSessions(db),
  }
}

export function latestSync(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('last_sync')
  if (row === undefined) return undefined
  try {
    return JSON.parse(row.value)
  } catch (error) {
    return undefined
  }
}

/**
 * Convenience path used by the CLI and tests: open, sync, query, close.
 */
export function collectTimeline(options) {
  const settings = options || {}
  const db = openProjection(settings.dbPath)
  try {
    const sync = settings.sync === false ? undefined : syncProjection(db, settings.root, settings)
    const events = loadEvents(db, settings)
    return {
      sync: sync,
      events: events,
      stats: countEvents(db, settings),
      sessions: loadSessions(db),
      lastSync: latestSync(db),
    }
  } finally {
    closeProjection(db)
  }
}
