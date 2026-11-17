import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  closeProjection,
  collectTimeline,
  countEvents,
  latestSync,
  loadEvents,
  loadSessions,
  openProjection,
  syncProjection,
} from '../src/project.js'
import { incidentScenario, rejectionOnlyScenario, writeSession } from '../test-fixtures/helpers.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'it-project-'))
}

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function makeFixture() {
  const root = tempDir()
  const data = tempDir()
  const first = writeSession(root, 'session-demo-0001', incidentScenario('session-demo-0001'))
  const second = writeSession(root, 'session-demo-0002', rejectionOnlyScenario('session-demo-0002'), {
    bucket: '_no-cwd',
  })
  return { root, data, first, second, dbPath: join(data, 'projection.db') }
}

test('projects sessions, segments, replacements and timeline events', () => {
  const fixture = makeFixture()
  const db = openProjection(fixture.dbPath)
  try {
    const sync = syncProjection(db, fixture.root)
    assert.equal(sync.rootExists, true)
    assert.equal(sync.discovered, 2)
    assert.equal(sync.scanned, 2)
    assert.equal(sync.failed, 0)
    assert.equal(sync.events, 6)
    assert.equal(sync.sessions, 2)

    const sessions = loadSessions(db)
    assert.equal(sessions.length, 2)
    assert.equal(sessions.find((session) => session.sessionId === 'session-demo-0001').eventCount, 5)
    assert.deepEqual(sessions.find((session) => session.sessionId === 'session-demo-0001').counts, {
      'user-rejected': 1,
      'plugin-error': 2,
      'runtime-http': 2,
    })

    const events = loadEvents(db)
    assert.equal(events.length, 6)
    assert.equal(events.find((event) => event.sessionId === 'session-demo-0001').line, 6)
    assert.equal(events.find((event) => event.kind === 'runtime-http').status, 502)

    const records = db.prepare('SELECT COUNT(*) AS n FROM records').get().n
    assert.ok(records > 20)
    const segments = db.prepare('SELECT COUNT(*) AS n FROM segments').get().n
    assert.equal(segments, 7)
    const replacements = db.prepare('SELECT COUNT(*) AS n FROM replacements').get().n
    assert.equal(replacements, 1)
    const payload = db
      .prepare('SELECT payload FROM records WHERE session_id = ? AND type = ? LIMIT 1')
      .get('session-demo-0001', 'tool/result')
    assert.match(payload.payload, /the user rejected tool/)

    const info = latestSync(db)
    assert.equal(info.scanned, 2)
    assert.equal(info.sessions, 2)
  } finally {
    closeProjection(db)
  }
})

test('projection is read-only for session files and idempotent on resync', () => {
  const fixture = makeFixture()
  const beforeHash = digest(fixture.first)
  const beforeStat = statSync(fixture.first)
  const beforeNames = readdirSync(join(fixture.root, '--D-Projects--', 'session-demo-0001')).sort()

  const db = openProjection(fixture.dbPath)
  try {
    syncProjection(db, fixture.root)
    const second = syncProjection(db, fixture.root)
    assert.equal(second.scanned, 0)
    assert.equal(second.skipped, 2)
    assert.equal(loadEvents(db).length, 6)

    const forced = syncProjection(db, fixture.root, { force: true })
    assert.equal(forced.scanned, 2)
    assert.equal(loadEvents(db).length, 6)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM timeline_events').get().n, 6)
  } finally {
    closeProjection(db)
  }

  assert.equal(digest(fixture.first), beforeHash, 'session bytes are unchanged')
  assert.equal(statSync(fixture.first).mtimeMs, beforeStat.mtimeMs, 'session mtime is unchanged')
  assert.deepEqual(readdirSync(join(fixture.root, '--D-Projects--', 'session-demo-0001')).sort(), beforeNames)
})

test('filters by window, label and session, and keeps totals separate from the list limit', () => {
  const fixture = makeFixture()
  const db = openProjection(fixture.dbPath)
  try {
    syncProjection(db, fixture.root)
    const http = loadEvents(db, { kinds: ['runtime-http'] })
    assert.equal(http.length, 2)
    assert.ok(http.every((event) => event.kind === 'runtime-http'))

    const oneSession = loadEvents(db, { session: 'session-demo-0002' })
    assert.equal(oneSession.length, 1)
    assert.equal(oneSession[0].kind, 'user-rejected')

    const all = loadEvents(db)
    const middle = all[2]
    const windowed = loadEvents(db, { since: middle.time, until: middle.time })
    assert.equal(windowed.length, 1)
    assert.equal(windowed[0].line, middle.line)

    const limited = loadEvents(db, { limit: 2 })
    assert.equal(limited.length, 2)
    assert.equal(countEvents(db).total, 6)
    assert.equal(countEvents(db, { kinds: ['runtime-http'] })['runtime-http'], 2)
    assert.deepEqual(countEvents(db, { session: 'session-demo-0002' }), {
      total: 1,
      'user-rejected': 1,
      'plugin-error': 0,
      'runtime-http': 0,
    })
  } finally {
    closeProjection(db)
  }
})

test('a malformed line is reported but does not abort the session', () => {
  const root = tempDir()
  const data = tempDir()
  const text =
    '{"type":"session","id":"session-bad"}\n' +
    'this is not json\n' +
    '{"type":"tool/result","seq":2,"time":1790000000000,"data":{"turn":1,"step":1,"message":{"isError":true,"content":[{"type":"text","text":"Error: boom"}]}}}\n'
  writeSession(root, 'session-bad', { text: text })
  const db = openProjection(join(data, 'projection.db'))
  try {
    const sync = syncProjection(db, root)
    assert.equal(sync.scanned, 1)
    assert.equal(sync.malformed, 1)
    const session = loadSessions(db)[0]
    assert.equal(session.malformed, 1)
    assert.equal(session.records, 2)
    assert.equal(loadEvents(db).length, 1)
  } finally {
    closeProjection(db)
  }
})

test('pruning is opt-in and refuses to prune on a missing sessions root', () => {
  const root = tempDir()
  const data = tempDir()
  writeSession(root, 'session-one', incidentScenario('session-one'))
  const db = openProjection(join(data, 'projection.db'))
  try {
    syncProjection(db, root)
    assert.equal(loadSessions(db).length, 1)

    rmSync(join(root, '--D-Projects--', 'session-one'), { recursive: true, force: true })
    const withoutPrune = syncProjection(db, root, { force: true })
    assert.equal(withoutPrune.pruned, 0)
    assert.equal(loadSessions(db).length, 1, 'stale rows survive unless prune is requested')

    const pruned = syncProjection(db, root, { force: true, prune: true })
    assert.equal(pruned.pruned, 1)
    assert.equal(loadSessions(db).length, 0)

    writeSession(root, 'session-two', rejectionOnlyScenario('session-two'))
    syncProjection(db, root, { force: true, prune: true })
    assert.equal(loadSessions(db).length, 1)
  } finally {
    closeProjection(db)
  }

  const missingRoot = join(root, 'does-not-exist')
  const db2 = openProjection(join(data, 'missing.db'))
  try {
    const result = syncProjection(db2, missingRoot, { prune: true })
    assert.equal(result.rootExists, false)
    assert.equal(result.pruned, 0)
    assert.equal(result.discovered, 0)
  } finally {
    closeProjection(db2)
  }
})

test('oversized sessions are reported and not projected as empty', () => {
  const root = tempDir()
  const data = tempDir()
  writeSession(root, 'session-huge', incidentScenario('session-huge'))
  const db = openProjection(join(data, 'projection.db'))
  try {
    const sync = syncProjection(db, root, { maxSessionBytes: 10 })
    assert.equal(sync.oversized, 1)
    assert.equal(sync.scanned, 0)
    assert.equal(sync.errors.length, 1)
    assert.match(sync.errors[0].message, /maxSessionBytes/)
    assert.equal(loadSessions(db).length, 0)
  } finally {
    closeProjection(db)
  }
})

test('collectTimeline opens, syncs, counts and closes in one call', () => {
  const fixture = makeFixture()
  const result = collectTimeline({
    root: fixture.root,
    dbPath: fixture.dbPath,
    since: undefined,
    until: undefined,
  })
  assert.equal(result.sync.scanned, 2)
  assert.equal(result.events.length, 6)
  assert.equal(result.stats.total, 6)
  assert.equal(result.stats['user-rejected'], 2)
  assert.equal(result.sessions.length, 2)
  assert.equal(result.lastSync.scanned, 2)
})
