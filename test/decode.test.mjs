import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { decodeSessionFile, decodeZstdFrames, splitZstdFrames } from '../src/decode.js'
import { discoverSessionFiles, parseSessionText } from '../src/scan.js'

function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'it-decode-'))
}

test('decodes every frame, not only the first', () => {
  const one = '{"type":"session","id":"s1"}\n'
  const two = '{"type":"turn/start","data":{"turn":1}}\n'
  const three = '{"type":"turn/end","data":{"turn":1}}\n'
  const compressed = Buffer.concat([frame(one), frame(two), frame(three)])
  const decoded = decodeZstdFrames(compressed)
  assert.equal(decoded.text, one + two + three)
  assert.equal(decoded.frames, 3)
  assert.equal(decoded.decodedFrames, 3)
  assert.equal(decoded.complete, true)
  assert.equal(decoded.errors.length, 0)
  assert.equal(splitZstdFrames(compressed).frames.length, 3)
})

test('skips skippable frames without losing later data', () => {
  const skippable = Buffer.alloc(12)
  skippable.writeUInt32LE(0x184d2a50, 0)
  skippable.writeUInt32LE(4, 4)
  skippable.write('meta', 8, 'utf8')
  const compressed = Buffer.concat([skippable, frame('hello\n')])
  const decoded = decodeZstdFrames(compressed)
  assert.equal(decoded.text, 'hello\n')
  assert.equal(decoded.frames, 2)
  assert.equal(decoded.complete, true)
})

test('reports trailing garbage but keeps earlier frames', () => {
  const compressed = Buffer.concat([frame('ok\n'), Buffer.from('not-a-frame')])
  const decoded = decodeZstdFrames(compressed)
  assert.equal(decoded.text, 'ok\n')
  assert.equal(decoded.complete, false)
  assert.ok(decoded.errors.length > 0)
  assert.match(decoded.errors[0].message, /unexpected byte/)
})

test('reports a truncated final frame without throwing', () => {
  const full = frame('{"type":"session"}\n')
  const decoded = decodeZstdFrames(full.subarray(0, full.length - 6))
  assert.equal(decoded.complete, false)
  assert.ok(decoded.errors.length > 0)
})

test('an empty file decodes to empty text', () => {
  const decoded = decodeZstdFrames(Buffer.alloc(0))
  assert.equal(decoded.text, '')
  assert.equal(decoded.frames, 0)
  assert.equal(decoded.complete, true)
})

test('a decoded byte cap marks the result as truncated, never complete', () => {
  const decoded = decodeZstdFrames(Buffer.concat([frame('0123456789'), frame('abcdefghij')]), {
    maxDecodedBytes: 7,
  })
  assert.equal(decoded.text, '0123456')
  assert.equal(decoded.truncated, true)
  assert.equal(decoded.complete, false)
})

test('plain JSONL session files are read without zstd', () => {
  const dir = tempDir()
  const file = join(dir, 'session.v4.jsonl')
  writeFileSync(file, '{"type":"session","id":"plain"}\n', 'utf8')
  const decoded = decodeSessionFile(file)
  assert.equal(decoded.compression, 'none')
  assert.match(decoded.text, /"plain"/)
  assert.equal(decoded.complete, true)
})

test('physical line numbers count blank lines and survive malformed rows', () => {
  const parsed = parseSessionText(
    ['{"type":"session","id":"s1"}', '', 'not json', '{"type":"turn/start","data":{"turn":1}}'].join('\n'),
  )
  assert.equal(parsed.header.line, 1)
  assert.equal(parsed.records.length, 2)
  assert.equal(parsed.records[1].line, 4)
  assert.equal(parsed.malformed.length, 1)
  assert.equal(parsed.malformed[0].line, 3)
  assert.equal(parsed.lineCount, 4)
})

test('discovery finds session logs at bucket depth and ignores other files', () => {
  const root = tempDir()
  const sessionDir = join(root, '--D-Projects--', 'session-a')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.alloc(0))
  writeFileSync(join(sessionDir, 'workspace.json'), '{}')
  writeFileSync(join(sessionDir, 'notes.txt'), 'ignore me')
  const found = discoverSessionFiles(root)
  assert.equal(found.length, 1)
  assert.equal(found[0].fileId, 'session-a')
  assert.equal(found[0].version, 4)
  assert.equal(found[0].compression, 'zstd')
})

test('discovery also understands v3 plain logs and missing roots', () => {
  const root = tempDir()
  const sessionDir = join(root, '_no-cwd', 'session-b')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'session.v3.jsonl'), '{"type":"session","id":"session-b"}\n')
  const found = discoverSessionFiles(root)
  assert.equal(found.length, 1)
  assert.equal(found[0].version, 3)
  assert.equal(found[0].compression, 'none')
  assert.deepEqual(discoverSessionFiles(join(root, 'missing')), [])
})

