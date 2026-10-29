import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

test('Host routes publish real USD costs, cache safely, persist once, and enforce browser trust', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'beichen-host-test-'))
  const oldHome = process.env.DSH_HOME
  const oldKey = process.env.BEICHEN_API_KEY
  const oldFetch = globalThis.fetch
  process.env.DSH_HOME = home
  delete process.env.BEICHEN_API_KEY
  let actual = 1.25
  let calls = 0
  let status = 200
  let key = 'test-credential-must-not-leak'
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(new URL(url).origin, 'https://beichenapi.com')
    assert.equal(init.headers.Authorization, 'Bearer ' + key)
    return new Response(JSON.stringify({ isValid: true, balance: 4.5, unit: 'USD', mode: 'unrestricted',
      usage: { today: { actual_cost: actual, requests: 2 }, total: { actual_cost: actual, total_tokens: 100 } },
      daily_usage: [], model_stats: [{ model: 'test-model', actual_cost: actual }],
    }), { status })
  }
  const routes = new Map()
  const effects = []
  const listeners = new Map()
  const context = {
    on(event, callback) { listeners.set(event, callback); return () => {} },
    effect(callback) { effects.push(callback()) },
    inject(_deps, callback) { callback(context) },
    get(name) { return name === 'connection' ? this.connection : null },
    connection: { requestRejection() { return null } },
    credentials: {
      async resolve(name) { assert.equal(name, 'BEICHEN_API_KEY'); return { value: key } },
      async set(name, value) { assert.equal(name, 'BEICHEN_API_KEY'); key = value },
    },
    webServer: {
      register(route) { routes.set(route.path, route); return () => {} },
      tapIndex() { return () => {} },
    },
  }
  async function request(route, headers = {}, data) {
    let body
    let code
    const req = Readable.from(data ? [Buffer.from(JSON.stringify(data))] : [])
    Object.assign(req, { method: data ? 'POST' : 'GET', url: route, headers: { host: '127.0.0.1:18000', ...headers } })
    const res = { set statusCode(value) { code = value }, writeHead(status) { code = status }, end(value) { body = value } }
    await routes.get(route.split('?')[0]).handler(req, res)
    return { code, data: body ? JSON.parse(body) : null }
  }
  try {
    const plugin = (await import('../lib/index.js?host-test')).default
    plugin.apply(context)
    assert.equal(routes.size, 26)
    const first = await request('/dsh-whale/balance.json')
    assert.equal(first.code, 200)
    assert.equal(first.data.totalBalance, 4.5)
    assert.equal(first.data.todayUsage, 1.25)
    assert.equal(first.data.currency, 'USD')
    assert.equal(first.data.usageSource, 'beichen-api')
    assert.equal(first.data.peakSupported, false)
    assert.ok(!('accountTag' in first.data))
    assert.ok(!('serverUsage' in first.data))
    await request('/dsh-whale/balance.json')
    assert.equal(calls, 1, 'cached read must not poll upstream again')
    actual = 1.5
    await request('/dsh-whale/balance.json?refresh=1')
    const last = await request('/dsh-whale/last-turn.json')
    assert.equal(last.data.amount, 0.25)
    assert.equal(last.data.seq, 1)
    await request('/dsh-whale/balance.json?refresh=1')
    assert.equal((await request('/dsh-whale/last-turn.json')).data.seq, 1)
    const records = await request('/dsh-whale/usage-records.json')
    assert.equal(records.data.today.total, 1.5)
    assert.equal(records.data.today.models[0].cost, 1.5)
    assert.equal(records.data.total7Currency, 'USD')
    const models = await request('/dsh-whale/api-models.json')
    assert.equal(models.data.builtinId, 'beichen')
    assert.equal(models.data.models[0].keyRef, 'BEICHEN_API_KEY')
    assert.equal(models.data.models[0].canAdjustBalance, false)
    assert.ok(!JSON.stringify(models.data).includes(key))
    status = 503
    const stale = await request('/dsh-whale/balance.json?refresh=1')
    assert.equal(stale.data.stale, true)
    assert.equal(stale.data.todayUsage, 1.5)
    status = 401
    const expired = await request('/dsh-whale/balance.json?refresh=1')
    assert.equal(expired.data.ok, false)
    const denied = await request('/dsh-whale/balance.json', { 'sec-fetch-site': 'cross-site' })
    assert.equal(denied.code, 403)
    status = 200
    actual = 0.75
    const saved = await request('/dsh-whale/api-models.json', {}, {
      action: 'save', model: { id: 'beichen', provider: 'custom', keyRef: 'WRONG_REF',
        balance: { url: 'https://evil.example' } }, keyValue: 'new-test-key',
    })
    assert.equal(saved.data.ok, true)
    assert.equal(key, 'new-test-key')
    assert.equal(saved.data.models[0].provider, 'beichen')
    assert.equal(saved.data.models[0].todayUsage, 0.75)
    assert.equal((await request('/dsh-whale/last-turn.json')).data.seq, 1, 'switching keys must not emit a false expense')
    const ledger = await fs.readFile(path.join(home, '.bcw-usage.json'), 'utf8')
    assert.ok(!ledger.includes(key))
    assert.equal((await fs.readdir(home)).some(name => name.startsWith('.dshw-')), false)
    const rows = []
    listeners.get('webserver/index-inject')(rows)
    assert.equal(rows.length, 1, 'desktop injection must be registered synchronously')
  } finally {
    for (const dispose of effects) if (typeof dispose === 'function') dispose()
    globalThis.fetch = oldFetch
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    if (oldKey === undefined) delete process.env.BEICHEN_API_KEY; else process.env.BEICHEN_API_KEY = oldKey
    await fs.rm(home, { recursive: true, force: true })
  }
})
