// Citable Markdown / JSON export.
//
// A row is useful only if the reader can go back to the log. Every event row
// therefore carries the session id and the physical line number of the
// decoded JSONL, never a sequence number alone. Sequence numbers are included
// in the JSON export for tooling, but the Markdown table keeps the line number
// front and centre.

import { KINDS, KIND_LABEL } from './timeline.js'

const KIND_HINT = {
  'user-rejected': '审批被拒绝（approval/decided 或 tool/result）',
  'plugin-error': '工具 / 插件 / hook / 运行时错误（非拒绝、非 HTTP 状态）',
  'runtime-http': '失败信息中出现的 4xx/5xx HTTP 状态',
}

function iso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return new Date(value).toISOString()
}

function cell(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\s*\r?\n\s*/g, ' / ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
}

function stepLabel(event) {
  if (typeof event.turn === 'number' && typeof event.step === 'number') return event.turn + '/' + event.step
  if (typeof event.step === 'number') return String(event.step)
  return '—'
}

function objectLabel(event) {
  if (event.status !== undefined) return 'HTTP ' + event.status
  if (typeof event.tool === 'string' && event.tool.length > 0) return event.tool
  const source = event.detail && event.detail.source
  return typeof source === 'string' && source.length > 0 ? source : '—'
}

export function formatWindow(window) {
  const settings = window || {}
  if (typeof settings.since !== 'number' && typeof settings.until !== 'number') return '全部时间'
  return (typeof settings.since === 'number' ? iso(settings.since) : '最早') + ' → ' + (typeof settings.until === 'number' ? iso(settings.until) : '现在')
}

export function tableRows(events) {
  if (events.length === 0) return '| — | — | — | — | — | — | 该窗口内没有匹配事件 |\n'
  const lines = []
  for (const event of events) {
    lines.push(
      '| ' +
        [
          cell(KIND_LABEL[event.kind] || event.kind),
          '`' + cell(event.sessionId) + '`',
          cell(stepLabel(event)),
          cell(event.line),
          cell(iso(event.time)),
          cell(objectLabel(event)),
          cell(event.excerpt),
        ].join(' | ') +
        ' |',
    )
  }
  return lines.join('\n') + '\n'
}

const TABLE_HEAD = [
  '| 标签 | 会话 id | 步号 | 原始日志行号 | 时间（UTC） | 对象 | 原文摘录 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
].join('\n')

/**
 * Render a complete Markdown report.
 *
 * @param {{events:Array<object>,stats:object,window?:{since?:number,until?:number},
 *          root?:string,sessions?:Array<object>,generatedAt?:number,dbPath?:string}} input
 */
export function renderMarkdown(input) {
  const settings = input || {}
  const events = Array.isArray(settings.events) ? settings.events : []
  const stats = settings.stats || { total: events.length }
  const window = settings.window || {}
  const generatedAt = typeof settings.generatedAt === 'number' ? settings.generatedAt : Date.now()
  const sessions = Array.isArray(settings.sessions) ? settings.sessions : []

  const lines = []
  lines.push('# DSH 事故时间线')
  lines.push('')
  lines.push('> 由 `dsh-incident-timeline` 只读投影生成。会话文件未被修改；行号是解压后 JSONL 的物理行号，摘录为原文截断，未做改写。')
  lines.push('')
  lines.push('- 时间窗：' + formatWindow(window))
  lines.push('- 生成时间：' + iso(generatedAt))
  if (typeof settings.root === 'string' && settings.root.length > 0) lines.push('- 会话根目录：`' + settings.root + '`')
  if (typeof settings.dbPath === 'string' && settings.dbPath.length > 0) lines.push('- 投影库：`' + settings.dbPath + '`')
  lines.push('- 会话数：' + sessions.length + ' · 事件数：' + stats.total)
  lines.push(
    '- 分类计数：' +
      KINDS.map((kind) => (KIND_LABEL[kind] || kind) + ' ' + (stats[kind] || 0)).join(' · '),
  )
  lines.push('')
  lines.push('## 分类说明')
  lines.push('')
  for (const kind of KINDS) {
    lines.push('- **' + (KIND_LABEL[kind] || kind) + '**：' + KIND_HINT[kind])
  }
  lines.push('')
  lines.push('## 汇总')
  lines.push('')
  lines.push('| 标签 | 数量 |')
  lines.push('| --- | --- |')
  for (const kind of KINDS) lines.push('| ' + (KIND_LABEL[kind] || kind) + ' | ' + (stats[kind] || 0) + ' |')
  lines.push('| **合计** | ' + stats.total + ' |')
  lines.push('')
  lines.push('## 全部事件')
  lines.push('')
  lines.push(TABLE_HEAD)
  lines.push(tableRows(events).trimEnd())
  lines.push('')

  for (const kind of KINDS) {
    const subset = events.filter((event) => event.kind === kind)
    lines.push('## ' + kind + ' · ' + (KIND_LABEL[kind] || kind) + '（' + subset.length + '）')
    lines.push('')
    lines.push(TABLE_HEAD)
    lines.push(tableRows(subset).trimEnd())
    lines.push('')
  }

  lines.push('## 如何回查')
  lines.push('')
  lines.push('1. 找到对应的 `session.v*.jsonl.zstd`（会话 id 即目录名）。')
  lines.push('2. 解压多帧 zstd 后按上表的「原始日志行号」定位；注意 Node 的 `zstdDecompressSync` 只解第一帧，需逐帧解压后拼接。')
  lines.push('3. 本工具不会写回会话文件；如需重新生成，运行 `dsh-incident-timeline scan`。')
  lines.push('')
  return lines.join('\n')
}

/**
 * Machine-readable export. `events` keeps seq/turn/step/detail so another tool
 * can re-render or join without re-parsing session logs.
 */
export function renderJson(input) {
  const settings = input || {}
  const events = Array.isArray(settings.events) ? settings.events : []
  const stats = settings.stats || { total: events.length }
  const generatedAt = typeof settings.generatedAt === 'number' ? settings.generatedAt : Date.now()
  return {
    tool: 'dsh-incident-timeline',
    schema: 1,
    readOnly: true,
    generatedAt: generatedAt,
    generatedAtIso: iso(generatedAt),
    window: settings.window || {},
    root: settings.root,
    dbPath: settings.dbPath,
    stats: stats,
    sessions: Array.isArray(settings.sessions) ? settings.sessions : [],
    events: events,
  }
}
