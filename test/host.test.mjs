import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, createHandler, normalizeConfig, windowFromSearch } from '../src/host.js'
import { incidentScenario, rejectionOnlyScenario, writeSession } from '../test-fixtures/helpers.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'it-host-'))
}

function fixture() {
  const root = tempDir()
  writeSession(root, 'session-demo-0001', incidentScenario('session-demo-0001'))
  writeSession(root, 'session-demo-0002', rejectionOnlyScenario('session-demo-0002'), { bucket: '_no-cwd' })
  return { root: root, dataDir: join(tempDir(), 'data') }
}

function makeCtx(options) {
  const settings = options || {}
  const routes = []
  const disposers = []
  const webServer = {
    register(route) {
      if (settings.registerThrows === true) throw new Error('webServer.register unavailable')
      routes.push(route)
      return function () {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const ctx = {
    webServer: webServer,
    effect(fn) {
      const dispose = fn()
      disposers.push(typeof dispose === 'function' ? dispose : function () {})
      return dispose
    },
  }
  return { ctx, routes, dispose() { for (const fn of disposers.splice(0)) fn() } }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    text: '',
    setHeader(name, value) { this.headers[name] = value },
    end(value) { this.text = value === undefined ? '' : String(value) },
  }
}

async function call(route, method, url) {
  const req = { method: method, url: url }
  const res = fakeResponse()
  await route.handler(req, res)
  let json
  try {
    json = JSON.parse(res.text)
  } catch (error) {
    json = undefined
  }
  return { status: res.statusCode, headers: res.headers, text: res.text, json: json }
}

test('state route syncs on first read and reports all three labels', async () => {
  const f = fixture()
  const setup = makeCtx()
  apply(setup.ctx, { sessionsRoot: f.root, dataDir: f.dataDir })
  assert.equal(setup.routes.length, 1)
  assert.equal(setup.routes[0].path, '/dsh-incident-timeline')

  const out = await call(setup.routes[0], 'GET', '/dsh-incident-timeline/state')
  assert.equal(out.status, 200)
  assert.equal(out.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(out.json.ok, true)
  assert.equal(out.json.readOnly, true)
  assert.equal(out.json.stats.total, 6)
  assert.equal(out.json.stats['user-rejected'], 2)
  assert.equal(out.json.events.length, 6)
  assert.equal(out.json.sessions.length, 2)
  assert.match(out.json.windowLabel, /全部时间/)

  setup.dispose()
  assert.equal(setup.routes.length, 0, 'route removed on unload')
})

test('window filters are validated rather than silently ignored', async () => {
  const f = fixture()
  const setup = makeCtx()
  apply(setup.ctx, { sessionsRoot: f.root, dataDir: f.dataDir })
  const route = setup.routes[0]

  const invalid = await call(route, 'GET', '/dsh-incident-timeline/state?since=nonsense')
  assert.equal(invalid.status, 400)
  assert.match(invalid.json.error, /since/)

  const reversed = await call(route, 'GET', '/dsh-incident-timeline/state?since=2000&until=1000')
  assert.equal(reversed.status, 400)

  const unknown = await call(route, 'GET', '/dsh-incident-timeline/state?kinds=user-rejected,nope')
  assert.equal(unknown.status, 400)
  assert.match(unknown.json.error, /nope/)

  const oneKind = await call(route, 'GET', '/dsh-incident-timeline/state?kinds=runtime-http')
  assert.equal(oneKind.status, 200)
  assert.equal(oneKind.json.stats.total, 2)
  assert.equal(oneKind.json.stats['user-rejected'], 0)

  const limited = await call(route, 'GET', '/dsh-incident-timeline/state?limit=2')
  assert.equal(limited.status, 200)
  assert.equal(limited.json.events.length, 2)
  assert.equal(limited.json.stats.total, 6, 'totals are not capped by the list limit')

  setup.dispose()
})

test('markdown and JSON exports are available from the host', async () => {
  const f = fixture()
  const setup = makeCtx()
  apply(setup.ctx, { sessionsRoot: f.root, dataDir: f.dataDir })
  const route = setup.routes[0]

  const markdown = await call(route, 'GET', '/dsh-incident-timeline/export?format=md')
  assert.equal(markdown.status, 200)
  assert.match(markdown.headers['content-type'], /^text\/markdown/)
  assert.match(markdown.text, /^# DSH 事故时间线/)
  assert.match(markdown.text, /原始日志行号/)

  const json = await call(route, 'GET', '/dsh-incident-timeline/export?format=json')
  assert.equal(json.status, 200)
  assert.equal(json.json.readOnly, true)
  assert.equal(json.json.events.length, 6)

  const download = await call(route, 'GET', '/dsh-incident-timeline/export?format=md&download=1')
  assert.match(download.headers['content-disposition'], /incident-timeline\.md/)

  setup.dispose()
})

test('preview page is the real standalone renderer', async () => {
  const f = fixture()
  const setup = makeCtx()
  apply(setup.ctx, { sessionsRoot: f.root, dataDir: f.dataDir })
  const out = await call(setup.routes[0], 'GET', '/dsh-incident-timeline/preview')
  assert.equal(out.status, 200)
  assert.match(out.headers['content-type'], /^text\/html/)
  assert.match(out.text, /事故时间线/)
  assert.match(out.text, /\/state\?/)
  assert.match(out.text, /只读投影/)
  setup.dispose()
})

test('POST /sync forces a rescan; GET /sync is rejected', async () => {
  const f = fixture()
  const setup = makeCtx()
  apply(setup.ctx, { sessionsRoot: f.root, dataDir: f.dataDir })
  const route = setup.routes[0]

  const first = await call(route, 'POST', '/dsh-incident-timeline/sync')
  assert.equal(first.status, 200)
  assert.equal(first.json.sync.scanned, 2)
  assert.equal(first.json.state.stats.total, 6)

  const wrongMethod = await call(route, 'GET', '/dsh-incident-timeline/sync')
  assert.equal(wrongMethod.status, 405)
  setup.dispose()
})

test('unknown methods return 404 JSON instead of throwing', async () => {
  const f = fixture()
  const setup = makeCtx()
  apply(setup.ctx, { sessionsRoot: f.root, dataDir: f.dataDir })
  const out = await call(setup.routes[0], 'GET', '/dsh-incident-timeline/nope')
  assert.equal(out.status, 404)
  assert.equal(out.json.ok, false)
  assert.match(out.json.error, /unknown method/)
  setup.dispose()
})

test('a refusing webServer does not make apply() throw', () => {
  const f = fixture()
  const setup = makeCtx({ registerThrows: true })
  assert.doesNotThrow(() => apply(setup.ctx, { sessionsRoot: f.root, dataDir: f.dataDir }))
  assert.equal(setup.routes.length, 0)
  setup.dispose()
})

test('createHandler can be driven without a harness and uses the configured paths', () => {
  const f = fixture()
  const host = createHandler({ sessionsRoot: f.root, dataDir: f.dataDir, staleMs: 0 })
  assert.equal(host.settings.sessionsRoot, f.root)
  assert.match(host.settings.dbPath, /data[\\/]projection\.db$/)
  assert.equal(host.statePayload({ limit: 10 }).ok, true)
})

test('window parsing reports each invalid input and accepts a full range', () => {
  assert.equal(windowFromSearch(new URLSearchParams('since=bad')).error !== undefined, true)
  assert.equal(windowFromSearch(new URLSearchParams('until=bad')).error !== undefined, true)
  assert.equal(windowFromSearch(new URLSearchParams('since=2&until=1')).error !== undefined, true)
  assert.equal(windowFromSearch(new URLSearchParams('kinds=nope')).error !== undefined, true)
  assert.equal(windowFromSearch(new URLSearchParams('limit=0')).error !== undefined, true)
  const parsed = windowFromSearch(new URLSearchParams('since=1&until=2&kinds=runtime-http&limit=10&session=s1'))
  assert.deepEqual(parsed, { since: 1, until: 2, session: 's1', kinds: ['runtime-http'], limit: 10 })
})

test('normalizeConfig defaults under DSH home', () => {
  const home = join(tmpdir(), 'dsh-home-' + Date.now())
  const config = normalizeConfig({ dshHome: home })
  assert.equal(config.sessionsRoot, join(home, 'sessions'))
  assert.match(config.dbPath, /incident-timeline[\\/]projection\.db$/)
  assert.equal(config.autoSync, true)
  assert.equal(config.prune, false)
})
