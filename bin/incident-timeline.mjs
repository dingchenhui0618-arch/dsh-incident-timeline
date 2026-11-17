#!/usr/bin/env node
// Standalone CLI for the same read-only projection the plugin serves.
//
//   dsh-incident-timeline scan --since 2026-11-16T00:00:00Z --out incident.md
//
// The CLI is intentionally separate from the host route so an incident review
// can run without a browser, and so CI can assert the export shape.

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectTimeline } from '../src/project.js'
import { KINDS, toEpochMs } from '../src/timeline.js'
import { formatWindow, renderJson, renderMarkdown } from '../src/markdown.js'

const USAGE = `dsh-incident-timeline — 只读事故时间线

用法:
  dsh-incident-timeline scan [选项]

选项:
  --sessions-root <dir>  会话根目录（默认 $DSH_HOME/sessions 或 ~/.dsh/sessions）
  --db <file>            投影库路径（默认 $DSH_HOME/incident-timeline/projection.db）
  --out <file>           输出文件（默认 stdout；- 也表示 stdout）
  --format <md|json>     输出格式（默认 md）
  --since <iso|ms>       时间窗起点（含）
  --until <iso|ms>       时间窗终点（含）
  --kind <k1,k2>         只导出指定标签：user-rejected,plugin-error,runtime-http
  --session <id>         只导出指定会话
  --limit <n>            最多导出 n 条（1..5000，默认 500）
  --max-session-mb <n>   单个会话压缩文件上限（MB，默认 64；超过则跳过并报告）
  --force                忽略 bytes/mtime 跳过逻辑，全量重投影
  --prune                删除投影库中已不存在的会话（默认关闭）
  --no-sync              只读现有投影库，不扫描会话
  --quiet                不把扫描摘要写到 stderr
  -h, --help             显示帮助

示例:
  dsh-incident-timeline scan --since 2026-11-16T00:00:00Z --until 2026-11-17T00:00:00Z
  dsh-incident-timeline scan --kind user-rejected --out rejected.md
`

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function takeValue(argv, index, option) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(option + ' 需要一个值')
  return value
}

export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : []
  const options = {
    command: 'scan',
    sessionsRoot: undefined,
    dbPath: undefined,
    out: undefined,
    format: 'md',
    since: undefined,
    until: undefined,
    kinds: undefined,
    session: undefined,
    limit: 500,
    maxSessionBytes: undefined,
    force: false,
    prune: false,
    sync: true,
    quiet: false,
    help: false,
  }
  if (args.length > 0 && !args[0].startsWith('-')) {
    options.command = args.shift()
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') {
      options.help = true
    } else if (arg === '--sessions-root') {
      options.sessionsRoot = takeValue(args, index, arg)
      index += 1
    } else if (arg === '--db') {
      options.dbPath = takeValue(args, index, arg)
      index += 1
    } else if (arg === '--out') {
      options.out = takeValue(args, index, arg)
      index += 1
    } else if (arg === '--format') {
      options.format = takeValue(args, index, arg)
      index += 1
    } else if (arg === '--since') {
      options.since = takeValue(args, index, arg)
      index += 1
    } else if (arg === '--until') {
      options.until = takeValue(args, index, arg)
      index += 1
    } else if (arg === '--kind' || arg === '--kinds') {
      const raw = takeValue(args, index, arg)
      options.kinds = raw.split(',').map((value) => value.trim()).filter(Boolean)
      index += 1
    } else if (arg === '--session') {
      options.session = takeValue(args, index, arg)
      index += 1
    } else if (arg === '--limit') {
      const raw = takeValue(args, index, arg)
      const limit = Number(raw)
      if (!Number.isInteger(limit) || limit <= 0 || limit > 5000) throw new Error('--limit 必须是 1..5000 的整数')
      options.limit = limit
      index += 1
    } else if (arg === '--max-session-mb') {
      const raw = takeValue(args, index, arg)
      const mb = Number(raw)
      if (!Number.isFinite(mb) || mb <= 0) throw new Error('--max-session-mb 必须是正数')
      options.maxSessionBytes = Math.round(mb * 1024 * 1024)
      index += 1
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--prune') {
      options.prune = true
    } else if (arg === '--no-sync') {
      options.sync = false
    } else if (arg === '--quiet') {
      options.quiet = true
    } else {
      throw new Error('未知选项：' + arg)
    }
  }
  if (options.command !== 'scan') throw new Error('未知子命令：' + options.command)
  if (options.format !== 'md' && options.format !== 'json') throw new Error('--format 只能是 md 或 json')
  if (options.kinds !== undefined) {
    const unknown = options.kinds.filter((kind) => !KINDS.includes(kind))
    if (unknown.length > 0) throw new Error('未知标签：' + unknown.join(', '))
  }
  const since = toEpochMs(options.since)
  const until = toEpochMs(options.until)
  if (options.since !== undefined && since === undefined) throw new Error('--since 不是合法的 ISO 时间或毫秒时间戳')
  if (options.until !== undefined && until === undefined) throw new Error('--until 不是合法的 ISO 时间或毫秒时间戳')
  if (since !== undefined && until !== undefined && since > until) throw new Error('--since 晚于 --until')
  options.sinceMs = since
  options.untilMs = until
  return options
}

export function run(argv, io) {
  const stream = io || { stdout: process.stdout, stderr: process.stderr }
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    stream.stderr.write('错误：' + String((error && error.message) || error) + '\n\n')
    stream.stderr.write(USAGE)
    return 1
  }
  if (options.help) {
    stream.stdout.write(USAGE)
    return 0
  }

  const home = dshHome()
  const root = options.sessionsRoot !== undefined ? resolve(options.sessionsRoot) : join(home, 'sessions')
  const dbPath = options.dbPath !== undefined ? resolve(options.dbPath) : join(home, 'incident-timeline', 'projection.db')

  let result
  try {
    result = collectTimeline({
      root: root,
      dbPath: dbPath,
      force: options.force,
      prune: options.prune,
      sync: options.sync,
      maxSessionBytes: options.maxSessionBytes,
      since: options.sinceMs,
      until: options.untilMs,
      kinds: options.kinds,
      session: options.session,
      limit: options.limit,
    })
  } catch (error) {
    stream.stderr.write('扫描失败：' + String((error && error.message) || error) + '\n')
    return 1
  }

  const generatedAt = Date.now()
  const payload = {
    events: result.events,
    stats: result.stats,
    window: { since: options.sinceMs, until: options.untilMs },
    root: root,
    sessions: result.sessions,
    generatedAt: generatedAt,
    dbPath: dbPath,
  }
  const output = options.format === 'json' ? JSON.stringify(renderJson(payload), null, 2) + '\n' : renderMarkdown(payload)

  try {
    if (options.out === undefined || options.out === '-') {
      stream.stdout.write(output)
    } else {
      const file = resolve(options.out)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, output, 'utf8')
      if (!options.quiet) {
        stream.stderr.write('已写入 ' + file + '\n')
      }
    }
  } catch (error) {
    stream.stderr.write('写入失败：' + String((error && error.message) || error) + '\n')
    return 1
  }

  if (!options.quiet) {
    const sync = result.sync
    stream.stderr.write(
      '时间窗 ' +
        formatWindow(payload.window) +
        ' · 事件 ' +
        payload.stats.total +
        ' · 会话 ' +
        payload.sessions.length +
        (sync ? ' · 扫描 ' + sync.scanned + ' / 跳过 ' + sync.skipped + ' / 超大 ' + (sync.oversized || 0) + ' / 失败 ' + sync.failed : ' · 未扫描') +
        '\n',
    )
    if (sync && sync.errors && sync.errors.length > 0) {
      stream.stderr.write('扫描警告：' + sync.errors.length + ' 个文件未投影\n')
      for (const error of sync.errors.slice(0, 5)) {
        stream.stderr.write('  ' + error.file + ': ' + error.message + '\n')
      }
    }
  }
  return 0
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  process.exitCode = run(process.argv.slice(2))
}
