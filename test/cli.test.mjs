import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseArgs, run } from '../bin/incident-timeline.mjs'
import { incidentScenario, writeSession } from '../test-fixtures/helpers.mjs'

function memoryIo() {
  const out = []
  const err = []
  return {
    stdout: { write(text) { out.push(text) } },
    stderr: { write(text) { err.push(text) } },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'it-cli-'))
  writeSession(root, 'session-demo-0001', incidentScenario('session-demo-0001'))
  return { root: root, db: join(root, '..', 'proj-' + Date.now() + '.db'), out: join(root, 'incident.md') }
}

test('parseArgs accepts the documented flags and rejects bad values', () => {
  const parsed = parseArgs([
    'scan',
    '--sessions-root', 'D:\\sessions',
    '--db', 'D:\\data\\p.db',
    '--format', 'json',
    '--kind', 'user-rejected,runtime-http',
    '--limit', '10',
    '--max-session-mb', '32',
    '--force',
    '--prune',
    '--no-sync',
    '--quiet',
  ])
  assert.equal(parsed.command, 'scan')
  assert.equal(parsed.sessionsRoot, 'D:\\sessions')
  assert.equal(parsed.format, 'json')
  assert.deepEqual(parsed.kinds, ['user-rejected', 'runtime-http'])
  assert.equal(parsed.limit, 10)
  assert.equal(parsed.maxSessionBytes, 32 * 1024 * 1024)
  assert.equal(parsed.force, true)
  assert.equal(parsed.prune, true)
  assert.equal(parsed.sync, false)
  assert.equal(parsed.quiet, true)

  assert.throws(() => parseArgs(['scan', '--limit', '0']), /limit/)
  assert.throws(() => parseArgs(['scan', '--kind', 'nope']), /未知标签/)
  assert.throws(() => parseArgs(['scan', '--since', 'nope']), /since/)
  assert.throws(() => parseArgs(['scan', '--format', 'yaml']), /format/)
  assert.throws(() => parseArgs(['other']), /未知子命令/)
  assert.throws(() => parseArgs(['scan', '--nope']), /未知选项/)
})

test('CLI writes a Markdown report with citations', () => {
  const f = fixture()
  const io = memoryIo()
  const code = run(['scan', '--sessions-root', f.root, '--db', f.db, '--out', f.out], io)
  assert.equal(code, 0)
  assert.equal(existsSync(f.out), true)
  const markdown = readFileSync(f.out, 'utf8')
  assert.match(markdown, /^# DSH 事故时间线/)
  assert.match(markdown, /session-demo-0001/)
  assert.match(markdown, /原始日志行号/)
  assert.match(io.err(), /事件 5/)
})

test('CLI emits machine-readable JSON on stdout', () => {
  const f = fixture()
  const io = memoryIo()
  const code = run(
    ['scan', '--sessions-root', f.root, '--db', f.db, '--format', 'json', '--kind', 'runtime-http', '--quiet'],
    io,
  )
  assert.equal(code, 0)
  const payload = JSON.parse(io.out())
  assert.equal(payload.readOnly, true)
  assert.equal(payload.stats.total, 2)
  assert.ok(payload.events.every((event) => event.kind === 'runtime-http'))
})

test('CLI validates a reversed window and returns a non-zero code', () => {
  const f = fixture()
  const io = memoryIo()
  const code = run(
    ['scan', '--sessions-root', f.root, '--db', f.db, '--since', '2026-11-17T00:00:00Z', '--until', '2026-11-16T00:00:00Z'],
    io,
  )
  assert.equal(code, 1)
  assert.match(io.err(), /since 晚于/)
})

test('CLI can read an existing projection with --no-sync', () => {
  const f = fixture()
  const first = memoryIo()
  assert.equal(run(['scan', '--sessions-root', f.root, '--db', f.db, '--quiet'], first), 0)

  const second = memoryIo()
  const code = run(['scan', '--sessions-root', f.root, '--db', f.db, '--no-sync', '--quiet'], second)
  assert.equal(code, 0)
  assert.match(second.out(), /session-demo-0001/)
  assert.match(second.out(), /事件数/)
})

test('--help prints usage without touching the filesystem', () => {
  const io = memoryIo()
  assert.equal(run(['--help'], io), 0)
  assert.match(io.out(), /只读事故时间线/)
  assert.match(io.out(), /--sessions-root/)
})
