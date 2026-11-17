// Read-only session discovery and JSONL parsing.
//
// Layout observed in DSH 0.2.x:
//   <root>/<cwd-bucket>/<session-dir>/session.v4.jsonl.zstd
//
// Nothing here mutates a session file: the only fs calls are readdir, stat and
// readFile. The projection layer owns all writes, and they land under the
// plugin's own data directory.

import { lstatSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { decodeSessionFile } from './decode.js'

const SESSION_FILE = /^session\.v(\d+)\.jsonl(\.zstd)?$/

/**
 * Find every session log under a sessions root.
 *
 * @param {string} root
 * @returns {Array<{sessionDir:string,file:string,fileId:string,version:number,
 *                  compression:'zstd'|'none',bytes:number,mtimeMs:number}>}
 */
export function discoverSessionFiles(root) {
  const found = []

  function visit(dir, depth) {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      return
    }
    let sessionFiles = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = SESSION_FILE.exec(entry.name)
      if (match === null) continue
      sessionFiles.push({
        name: entry.name,
        version: Number(match[1]),
        compression: match[2] === '.zstd' ? 'zstd' : 'none',
      })
    }
    if (sessionFiles.length > 0) {
      for (const candidate of sessionFiles) {
        const file = join(dir, candidate.name)
        let info
        try {
          info = lstatSync(file)
        } catch (error) {
          continue
        }
        if (!info.isFile()) continue
        found.push({
          sessionDir: dir,
          file: file,
          fileId: basename(dir),
          sessionId: basename(dir),
          version: candidate.version,
          compression: candidate.compression,
          bytes: info.size,
          mtimeMs: info.mtimeMs,
        })
      }
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Never follow junctions/symlinks while walking; a sessions tree is
      // data, not a place to discover new filesystem graph edges.
      const child = join(dir, entry.name)
      try {
        if (lstatSync(child).isSymbolicLink()) continue
      } catch (error) {
        continue
      }
      visit(child, depth + 1)
    }
  }

  visit(root, 0)
  found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return found
}

/**
 * Parse a decompressed JSONL session log.
 *
 * `line` is the physical 1-based line number in the decompressed log, which is
 * the number a reader can use to cite the record after decompressing the same
 * file. Blank lines still consume a line number.
 *
 * @param {string} text
 */
export function parseSessionText(text) {
  const lines = text.split('\n')
  const records = []
  const malformed = []
  let header
  let lastSeq = -1

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '')
    const lineNo = index + 1
    if (line.trim().length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      malformed.push({
        line: lineNo,
        bytes: Buffer.byteLength(line),
        message: String((error && error.message) || error),
        raw: line.length > 240 ? line.slice(0, 240) + '…' : line,
      })
      continue
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      malformed.push({
        line: lineNo,
        bytes: Buffer.byteLength(line),
        message: 'line is not a JSON object',
        raw: line.length > 240 ? line.slice(0, 240) + '…' : line,
      })
      continue
    }
    if (event.type === 'session' && header === undefined) {
      header = { line: lineNo, event: event }
    }
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    if (seq !== undefined) lastSeq = Math.max(lastSeq, seq)
    records.push({
      line: lineNo,
      seq: seq,
      type: typeof event.type === 'string' ? event.type : 'unknown',
      time: typeof event.time === 'number' ? event.time : undefined,
      event: event,
    })
  }

  return {
    header: header,
    records: records,
    malformed: malformed,
    lineCount: lines.length,
    lastSeq: lastSeq,
  }
}

/**
 * Decode and parse one session log.
 *
 * `maxSessionBytes` refuses pathologically large compressed logs before they
 * are read into memory (the largest observed DSH session can decompress past
 * V8's maximum string length); `maxDecodedBytes` bounds the decoded output.
 * A skipped session is reported, never silently projected as empty.
 *
 * @param {string} file
 * @param {{maxSessionBytes?:number,maxDecodedBytes?:number}} [options]
 */
export function scanSessionFile(file, options) {
  const settings = options || {}
  const maxSessionBytes =
    typeof settings.maxSessionBytes === 'number' && settings.maxSessionBytes > 0
      ? settings.maxSessionBytes
      : 64 * 1024 * 1024
  let info
  try {
    info = statSync(file)
  } catch (error) {
    return {
      oversized: false,
      error: String((error && error.message) || error),
      sessionId: basename(join(file, '..')),
      records: [],
      malformed: [],
      lineCount: 0,
      decode: { complete: false, frames: 0, errors: [] },
    }
  }
  if (info.size > maxSessionBytes) {
    return {
      oversized: true,
      error:
        'session file is ' +
        info.size +
        ' bytes, above the configured maxSessionBytes=' +
        maxSessionBytes +
        '; skipped instead of building a partial projection',
      sessionId: basename(join(file, '..')),
      records: [],
      malformed: [],
      lineCount: 0,
      decode: {
        complete: false,
        frames: 0,
        decodedFrames: 0,
        compressedBytes: info.size,
        decodedBytes: 0,
        truncated: true,
        errors: [{ offset: 0, message: 'skipped: compressed file exceeds maxSessionBytes' }],
      },
    }
  }
  const decoded = decodeSessionFile(file, { maxDecodedBytes: settings.maxDecodedBytes })
  const parsed = parseSessionText(decoded.text)
  const sessionId =
    parsed.header && typeof parsed.header.event.id === 'string'
      ? parsed.header.event.id
      : basename(join(file, '..'))
  const createdAt =
    parsed.header && typeof parsed.header.event.createdAt === 'number'
      ? parsed.header.event.createdAt
      : undefined
  const cwd = parsed.header && typeof parsed.header.event.cwd === 'string' ? parsed.header.event.cwd : undefined
  return {
    sessionId: sessionId,
    header: parsed.header,
    createdAt: createdAt,
    cwd: cwd,
    records: parsed.records,
    malformed: parsed.malformed,
    lineCount: parsed.lineCount,
    decode: decoded,
    oversized: false,
  }
}
