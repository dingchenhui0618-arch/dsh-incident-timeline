// Multi-frame zstd decoder for DeepSeek Harness session logs.
//
// DSH appends each batch of JSONL lines as its own zstd frame. Node's
// zstdDecompressSync() stops after the first frame, so reading only that call
// yields a 200-byte session header and nothing else. This module walks the
// standard zstd frame format block by block to find frame boundaries, then
// decompresses every frame and concatenates the output.
//
// The walker handles the two frame kinds the format allows here:
//   - standard frames (magic 0xFD2FB528)
//   - skippable frames (magic 0x184D2A50..0x184D2A5F, 4-byte little-endian size)
//
// It deliberately does not decode compressed data itself. Boundary scanning is
// enough to hand each frame to node:zlib, which keeps the code small and lets
// the platform own the entropy decoder.

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

export const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MIN = 0x184d2a50
const SKIPPABLE_MAX = 0x184d2a5f

class FrameError extends Error {
  constructor(offset, message) {
    super('zstd frame at byte ' + offset + ': ' + message)
    this.name = 'FrameError'
    this.offset = offset
  }
}

function contentSizeBytes(descriptor, singleSegment) {
  const flag = descriptor >>> 6
  if (flag === 0) return singleSegment ? 1 : 0
  return 1 << flag
}

function dictionaryBytes(descriptor) {
  const flag = descriptor & 3
  return flag === 3 ? 4 : flag
}

/**
 * List the frame spans in a buffer without decompressing them.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {{ frames: Array<{start:number,end:number,kind:'zstd'|'skippable'}>,
 *            errors: Array<{offset:number,message:string}>,
 *            trailing: number }}
 */
export function splitZstdFrames(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const frames = []
  const errors = []
  let offset = 0

  const need = (count, at) => {
    if (at + count > buf.length) {
      throw new FrameError(at, 'truncated (needs ' + count + ' bytes)')
    }
  }

  while (offset < buf.length) {
    const start = offset

    // Trailing NUL padding appears when a preallocated file is truncated.
    // Anything else that is not a known magic is real damage.
    if (buf.length - offset < 4) {
      const rest = buf.subarray(offset)
      if (rest.every((byte) => byte === 0 || byte === 0x0a || byte === 0x0d || byte === 0x20 || byte === 0x09)) {
        break
      }
      errors.push({ offset: offset, message: 'trailing bytes are shorter than a frame magic' })
      break
    }

    const magic = buf.readUInt32LE(offset)
    if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
      try {
        need(8, offset)
        const size = buf.readUInt32LE(offset + 4)
        need(8 + size, offset)
        offset += 8 + size
        frames.push({ start: start, end: offset, kind: 'skippable' })
        continue
      } catch (error) {
        errors.push({ offset: start, message: error.message })
        break
      }
    }

    if (magic !== ZSTD_MAGIC) {
      errors.push({
        offset: start,
        message: 'unexpected byte 0x' + magic.toString(16) + ' (expected zstd magic)',
      })
      break
    }

    try {
      offset += 4
      need(1, offset)
      const descriptor = buf[offset]
      offset += 1

      if ((descriptor & 8) !== 0) {
        throw new FrameError(start, 'reserved header bit is set')
      }
      const singleSegment = (descriptor & 32) !== 0
      const checksum = (descriptor & 4) !== 0

      if (!singleSegment) {
        need(1, offset)
        offset += 1 // window descriptor
      }
      offset += dictionaryBytes(descriptor)
      const fcsBytes = contentSizeBytes(descriptor, singleSegment)
      need(fcsBytes, offset)
      offset += fcsBytes
      need(3, offset)

      for (;;) {
        need(3, offset)
        const blockHeader = buf.readUIntLE(offset, 3)
        offset += 3
        const lastBlock = (blockHeader & 1) !== 0
        const blockType = (blockHeader >>> 1) & 3
        const blockSize = blockHeader >>> 3
        if (blockType === 3) throw new FrameError(start, 'reserved block type')
        // A zstd block payload cannot exceed 128 KiB. Rejecting larger sizes
        // stops a damaged header from making the walker jump past the buffer.
        if (blockType !== 1 && blockSize > 0x20000) {
          throw new FrameError(start, 'block size exceeds the format maximum')
        }
        const payload = blockType === 1 ? 1 : blockSize
        need(payload, offset)
        offset += payload
        if (lastBlock) break
      }

      if (checksum) {
        need(4, offset)
        offset += 4
      }
      frames.push({ start: start, end: offset, kind: 'zstd' })
    } catch (error) {
      errors.push({ offset: start, message: error.message })
      break
    }
  }

  return { frames: frames, errors: errors, trailing: buf.length - offset }
}

/**
 * Decode every frame in a compressed session log.
 *
 * A damaged frame is reported in `errors` and skipped; earlier frames are still
 * returned. `maxDecodedBytes` bounds memory for pathologically large sessions;
 * when the cap is hit the result is marked `truncated` and `complete` is false,
 * so callers never mistake a partial projection for a whole log.
 *
 * @param {Buffer|Uint8Array} input
 * @param {{maxDecodedBytes?:number}} [options]
 */
export function decodeZstdFrames(input, options) {
  const settings = options || {}
  const maxDecodedBytes =
    typeof settings.maxDecodedBytes === 'number' && settings.maxDecodedBytes > 0
      ? settings.maxDecodedBytes
      : 128 * 1024 * 1024
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const split = splitZstdFrames(buf)
  const chunks = []
  const errors = split.errors.slice()
  let decodedFrames = 0
  let decodedBytes = 0
  let truncated = false

  for (let index = 0; index < split.frames.length; index += 1) {
    const frame = split.frames[index]
    if (frame.kind === 'skippable') continue
    if (decodedBytes >= maxDecodedBytes) {
      truncated = true
      break
    }
    try {
      let chunk = zstdDecompressSync(buf.subarray(frame.start, frame.end))
      if (decodedBytes + chunk.length > maxDecodedBytes) {
        chunk = chunk.subarray(0, maxDecodedBytes - decodedBytes)
        truncated = true
      }
      chunks.push(chunk)
      decodedBytes += chunk.length
      decodedFrames += 1
      if (truncated) break
    } catch (error) {
      errors.push({
        offset: frame.start,
        message: 'frame ' + index + ' failed to decompress: ' + String((error && error.message) || error),
      })
    }
  }

  const output = Buffer.concat(chunks)
  return {
    buffer: output,
    text: output.toString('utf8'),
    compression: 'zstd',
    frames: split.frames.length,
    decodedFrames: decodedFrames,
    compressedBytes: buf.length,
    decodedBytes: decodedBytes,
    truncated: truncated,
    complete: errors.length === 0 && !truncated,
    errors: errors,
  }
}

/**
 * Read a session log from disk. Supports both `*.jsonl.zstd` and plain
 * `*.jsonl`; the caller is responsible for only passing files under the
 * sessions root.
 *
 * @param {string} file
 * @param {{maxDecodedBytes?:number}} [options]
 */
export function decodeSessionFile(file, options) {
  const data = readFileSync(file)
  if (file.endsWith('.zstd')) return decodeZstdFrames(data, options)
  const text = data.toString('utf8')
  return {
    buffer: data,
    text: text,
    compression: 'none',
    frames: 1,
    decodedFrames: 1,
    compressedBytes: data.length,
    decodedBytes: data.length,
    truncated: false,
    complete: true,
    errors: [],
  }
}
