import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBeichenUsage, fetchBeichenUsage, recordBeichenUsage, beichenDaySummary, beichenRecords } from '../lib/beichen.mjs'

const now = Date.parse('2026-10-29T12:00:00Z')
function response(over = {}) {
  return { isValid: true, mode: 'unrestricted', balance: 12.5, remaining: 12.5, unit: 'USD',
    usage: { today: { actual_cost: 0.25, cost: 2.5, requests: 3 }, total: { actual_cost: 10.25, total_tokens: 1234 } },
    daily_usage: [{ date: '2026-10-28', actual_cost: 1.5, cost: 15, requests: 5 }],
    model_stats: [{ model: 'gpt-example', actual_cost: 0.25, cost: 2.5 }], ...over }
}

test('wallet zero, negative balance and actual discounted USD charges remain accurate', () => {
  const data = parseBeichenUsage(response({ balance: 0 }), 'secret', now)
  assert.equal(data.totalBalance, 0)
  assert.equal(data.balanceKind, 'wallet')
  assert.equal(data.serverUsage.todayCost, 0.25)
  assert.equal(data.serverUsage.models[0].cost, 0.25)
  assert.equal(data.currency, 'USD')
  assert.equal(parseBeichenUsage(response({ balance: -0.5 }), 'secret', now).totalBalance, -0.5)
})

test('key quota and subscription are labelled distinctly from wallet balance', () => {
  const limited = parseBeichenUsage(response({ balance: undefined, mode: 'quota_limited', remaining: 5 }), 'key', now)
  assert.equal(limited.balanceKind, 'key-quota')
  assert.match(limited.balanceLabel, /Key/)
  assert.equal(limited.rechargeBalance, null)
  const unlimited = parseBeichenUsage(response({ balance: undefined, remaining: undefined, subscription: {} }), 'key', now)
  assert.equal(unlimited.totalBalance, null)
  assert.equal(unlimited.balanceKind, 'subscription')
})

test('malformed or missing usage never turns into a successful zero', () => {
  const payload = parseBeichenUsage(response({ usage: undefined, daily_usage: undefined }), 'key', now)
  const ledger = {}
  recordBeichenUsage(ledger, payload)
  assert.equal(beichenDaySummary(ledger, '2026-10-29').amount, null)
  assert.equal(beichenRecords(ledger, now).today.total, null)
  assert.equal(beichenRecords(ledger, now).total7, null)
  assert.throws(() => parseBeichenUsage({ isValid: false }, 'key', now))
  assert.throws(() => parseBeichenUsage(response({ unit: 'CNY' }), 'key', now))
})

test('large token totals use count units and malformed daily charges remain unknown', () => {
  const payload = parseBeichenUsage(response({
    usage: { today: { actual_cost: 0 }, total: { actual_cost: 54, total_tokens: 1260300000 } },
    daily_usage: [{ date: '2026-10-28', cost: 10 }],
  }), 'key', now)
  assert.equal(payload.serverUsage.totalTokens, 1260300000)
  const ledger = {}
  recordBeichenUsage(ledger, payload)
  assert.equal(beichenDaySummary(ledger, '2026-10-28').amount, null)
  assert.equal(beichenRecords(ledger, now).total7, null)
})

test('repeated snapshots replace totals; recharge and stale balance cannot inflate consumption', () => {
  const ledger = {}
  const data = parseBeichenUsage(response(), 'first-key', now)
  recordBeichenUsage(ledger, data)
  recordBeichenUsage(ledger, data)
  recordBeichenUsage(ledger, { ...data, totalBalance: 100 })
  assert.equal(beichenDaySummary(ledger, '2026-10-29').amount, 0.25)
  assert.equal(beichenRecords(ledger, now).total7, 1.75)
  assert.equal(beichenRecords(ledger, now).days7[2].total, 0)
  assert.equal(beichenRecords(ledger, now).today.models[0].cost, 0.25)
  assert.equal(beichenRecords(ledger, now).all.days.length, 90)
})

test('switching API keys isolates ledgers and preserves prior snapshots', () => {
  const ledger = {}
  const a = parseBeichenUsage(response(), 'key-A', now)
  const b = parseBeichenUsage(response({ usage: { today: { actual_cost: 2 }, total: { actual_cost: 2 } } }), 'key-B', now)
  recordBeichenUsage(ledger, a)
  recordBeichenUsage(ledger, b)
  assert.equal(beichenDaySummary(ledger, '2026-10-29').amount, 2)
  recordBeichenUsage(ledger, a)
  assert.equal(beichenDaySummary(ledger, '2026-10-29').amount, 0.25)
  assert.equal(Object.keys(ledger.beichen.accounts).length, 2)
  assert.ok(!JSON.stringify(ledger).includes('key-A'))
})

test('Beijing midnight rolls to the next day without copying yesterday', () => {
  const ledger = {}
  recordBeichenUsage(ledger, parseBeichenUsage(response(), 'key', now))
  const midnight = Date.parse('2026-10-29T16:00:00Z')
  recordBeichenUsage(ledger, parseBeichenUsage(response({ usage: { today: { actual_cost: 0 }, total: { actual_cost: 10.25 } } }), 'key', midnight))
  assert.equal(beichenRecords(ledger, midnight).today.total, 0)
  // The new server snapshot is authoritative, including sparse zero days.
  assert.equal(beichenRecords(ledger, midnight).today.date, '2026-10-30')
})

test('fetch only sends key to fixed Beichen HTTPS endpoint and forbids redirects', async () => {
  let calls = 0
  const data = await fetchBeichenUsage('secret', { now, fetchImpl: async (url, init) => {
    calls++
    assert.equal(new URL(url).origin, 'https://beichenapi.com')
    assert.equal(new URL(url).pathname, '/v1/usage')
    assert.equal(new URL(url).searchParams.get('days'), '90')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, 'Bearer secret')
    return new Response(JSON.stringify(response()))
  } })
  assert.equal(calls, 1)
  assert.equal(data.ok, true)
  assert.equal((await fetchBeichenUsage('')).code, 'NO_KEY')
})

test('401 is explicit, 5xx is transient, and thrown errors never echo credentials', async () => {
  const unauthorized = await fetchBeichenUsage('secret', { fetchImpl: async () => new Response('{}', { status: 401 }) })
  assert.equal(unauthorized.ok, false)
  assert.equal(unauthorized.transient, false)
  const unavailable = await fetchBeichenUsage('secret', { fetchImpl: async () => new Response('{}', { status: 503 }) })
  assert.equal(unavailable.transient, true)
  const failure = await fetchBeichenUsage('secret', { fetchImpl: async () => { throw new Error('Authorization: Bearer secret') } })
  assert.ok(!JSON.stringify(failure).includes('secret'))
})
