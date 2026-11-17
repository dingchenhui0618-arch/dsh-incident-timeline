// Host half of dsh-incident-timeline.
//
// One fenced HTTP route under the plugin name:
//
//   GET  /dsh-incident-timeline/state?since=&until=&kinds=&session=&limit=
//   POST /dsh-incident-timeline/sync
//   GET  /dsh-incident-timeline/export?format=md|json&since=&until=
//   GET  /dsh-incident-timeline/preview
//
// The host owns the read-only projection. The client only renders what this
// route reports. A failed projection or a changed webServer contract must
// never take down the host: the route is contained, and errors become JSON.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closeProjection, countEvents, latestSync, loadEvents, loadSessions, openProjection, syncProjection } from './project.js'
import { KIND_LABEL, KINDS, toEpochMs } from './timeline.js'
import { formatWindow, renderJson, renderMarkdown } from './markdown.js'
import { renderPreviewHtml } from './preview.js'

export const name = 'dsh-incident-timeline'
export const inject = ['webServer']

const MOUNT = '/dsh-incident-timeline'
const DEFAULT_STALE_MS = 30_000

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function sendText(res, status, contentType, text, downloadName) {
  res.statusCode = status
  res.setHeader('content-type', contentType)
  res.setHeader('cache-control', 'no-store')
  if (typeof downloadName === 'string') {
    res.setHeader('content-disposition', 'attachment; filename="' + downloadName + '"')
  }
  res.end(text)
}

function methodFromUrl(url) {
  const path = String(url || '').split('?')[0]
  const rest = path.replace(/^\/dsh-incident-timeline\/?/, '')
  return rest || 'state'
}

export function normalizeConfig(config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const home = typeof settings.dshHome === 'string' && settings.dshHome.length > 0 ? settings.dshHome : dshHome()
  const dataDir =
    typeof settings.dataDir === 'string' && settings.dataDir.length > 0
      ? settings.dataDir
      : join(home, 'incident-timeline')
  return {
    sessionsRoot:
      typeof settings.sessionsRoot === 'string' && settings.sessionsRoot.length > 0
        ? settings.sessionsRoot
        : join(home, 'sessions'),
    dataDir: dataDir,
    dbPath:
      typeof settings.dbPath === 'string' && settings.dbPath.length > 0
        ? settings.dbPath
        : join(dataDir, 'projection.db'),
    autoSync: settings.autoSync !== false,
    staleMs:
      typeof settings.staleMs === 'number' && settings.staleMs >= 0 ? settings.staleMs : DEFAULT_STALE_MS,
    maxSessionBytes:
      typeof settings.maxSessionBytes === 'number' && settings.maxSessionBytes > 0
        ? settings.maxSessionBytes
        : 64 * 1024 * 1024,
    maxDecodedBytes:
      typeof settings.maxDecodedBytes === 'number' && settings.maxDecodedBytes > 0
        ? settings.maxDecodedBytes
        : 128 * 1024 * 1024,
    prune: settings.prune === true,
  }
}

/**
 * Parse a state/export query string into a timeline filter.
 * Invalid timestamps are reported, not silently ignored.
 */
export function windowFromSearch(searchParams, defaultLimit) {
  const sinceRaw = searchParams.get('since')
  const untilRaw = searchParams.get('until')
  const session = searchParams.get('session') || undefined
  const since = toEpochMs(sinceRaw === null ? undefined : sinceRaw)
  const until = toEpochMs(untilRaw === null ? undefined : untilRaw)
  if (sinceRaw !== null && sinceRaw !== '' && since === undefined) {
    return { error: 'since 不是合法的 ISO 时间或毫秒时间戳' }
  }
  if (untilRaw !== null && untilRaw !== '' && until === undefined) {
    return { error: 'until 不是合法的 ISO 时间或毫秒时间戳' }
  }
  if (since !== undefined && until !== undefined && since > until) {
    return { error: 'since 晚于 until' }
  }
  const rawKinds = searchParams.get('kinds')
  let kinds
  if (rawKinds !== null && rawKinds !== '') {
    kinds = rawKinds.split(',').map((value) => value.trim()).filter(Boolean)
    const unknown = kinds.filter((kind) => !KINDS.includes(kind))
    if (unknown.length > 0) return { error: '未知标签：' + unknown.join(', ') }
  }
  const limitRaw = searchParams.get('limit')
  let limit = typeof defaultLimit === 'number' && defaultLimit > 0 ? defaultLimit : 500
  if (limitRaw !== null && limitRaw !== '') {
    const parsed = Number(limitRaw)
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 5000) return { error: 'limit 必须是 1..5000 的整数' }
    limit = parsed
  }
  return {
    since: since,
    until: until,
    session: session,
    kinds: kinds,
    limit: limit,
  }
}

export function createHandler(config) {
  const settings = normalizeConfig(config)
  let lastRun = 0
  let lastStats
  let syncPromise = null

  function syncNow(force) {
    if (syncPromise !== null) return syncPromise
    syncPromise = Promise.resolve()
      .then(() => {
        const db = openProjection(settings.dbPath)
        try {
          const stats = syncProjection(db, settings.sessionsRoot, {
            force: force === true,
            prune: settings.prune,
            maxSessionBytes: settings.maxSessionBytes,
            maxDecodedBytes: settings.maxDecodedBytes,
          })
          lastRun = Date.now()
          lastStats = stats
          return stats
        } finally {
          closeProjection(db)
        }
      })
      .finally(() => {
        syncPromise = null
      })
    return syncPromise
  }

  async function ensureFresh() {
    if (!settings.autoSync) return lastStats
    if (lastRun !== 0 && Date.now() - lastRun < settings.staleMs) return lastStats
    return syncNow(false)
  }

  function query(filter) {
    const db = openProjection(settings.dbPath)
    try {
      const events = loadEvents(db, filter)
      const sessions = loadSessions(db)
      const summary = countEvents(db, filter)
      const lastSync = latestSync(db)
      return { events: events, stats: summary, sessions: sessions, lastSync: lastSync }
    } finally {
      closeProjection(db)
    }
  }

  function statePayload(filter) {
    const result = query(filter)
    return {
      ok: true,
      readOnly: true,
      root: settings.sessionsRoot,
      rootExists: existsSync(settings.sessionsRoot),
      dbPath: settings.dbPath,
      window: { since: filter.since, until: filter.until },
      windowLabel: formatWindow({ since: filter.since, until: filter.until }),
      stats: result.stats,
      events: result.events,
      sessions: result.sessions,
      lastSync: result.lastSync,
      generatedAt: Date.now(),
      kinds: KINDS.map((kind) => ({ id: kind, label: KIND_LABEL[kind] })),
    }
  }

  async function handler(req, res) {
    try {
      const method = methodFromUrl(req.url)
      const url = new URL(String(req.url || '/'), 'http://localhost')
      // An export is expected to be complete; the state list is capped for the
      // panel. Both can be overridden with an explicit `limit`.
      const filterResult = windowFromSearch(url.searchParams, method === 'export' ? 5000 : 500)
      if (filterResult.error !== undefined) {
        sendJson(res, 400, { ok: false, error: filterResult.error })
        return
      }
      const filter = filterResult

      if (method === 'preview') {
        sendText(res, 200, 'text/html; charset=utf-8', renderPreviewHtml({ mountPath: MOUNT }))
        return
      }

      if (method === 'export') {
        await ensureFresh()
        const format = url.searchParams.get('format') === 'json' ? 'json' : 'md'
        const result = query(filter)
        const generatedAt = Date.now()
        const payload = {
          events: result.events,
          stats: result.stats,
          window: { since: filter.since, until: filter.until },
          root: settings.sessionsRoot,
          sessions: result.sessions,
          generatedAt: generatedAt,
          dbPath: settings.dbPath,
        }
        if (format === 'json') {
          sendJson(res, 200, renderJson(payload))
          return
        }
        const markdown = renderMarkdown(payload)
        const download = url.searchParams.get('download') === '1' ? 'incident-timeline.md' : undefined
        sendText(res, 200, 'text/markdown; charset=utf-8', markdown, download)
        return
      }

      if (method === 'state') {
        await ensureFresh()
        sendJson(res, 200, statePayload(filter))
        return
      }

      if (method === 'sync') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const stats = await syncNow(true)
        sendJson(res, 200, { ok: true, sync: stats, state: statePayload(filter) })
        return
      }

      if (method === 'health') {
        sendJson(res, 200, { ok: true, name: name, readOnly: true })
        return
      }

      sendJson(res, 404, { ok: false, error: 'unknown method: ' + method })
    } catch (error) {
      try {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      } catch (inner) {
        // The response may already be gone; nothing useful remains to do.
      }
    }
  }

  return {
    settings: settings,
    handler: handler,
    syncNow: syncNow,
    query: query,
    statePayload: statePayload,
  }
}

export function apply(ctx, config) {
  const host = createHandler(config)

  // The panel route is the disposable half. If registration fails, the plugin
  // reports that failure in the console instead of aborting apply().
  ctx.effect(function () {
    let disposeRoute
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: MOUNT,
        handler: host.handler,
      })
    } catch (error) {
      disposeRoute = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-incident-timeline] could not register the route', error)
      }
    }
    return function () {
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  })
}
