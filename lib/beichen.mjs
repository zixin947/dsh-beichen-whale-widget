import { createHash } from 'node:crypto'
import { preciseMoney, beijingDay, dayOffset, sumMoney } from './accounting.mjs'

export const BEICHEN_DASHBOARD = 'https://beichenapi.com/dashboard'
export const BEICHEN_USAGE_URL = 'https://beichenapi.com/v1/usage?days=90&timezone=Asia%2FShanghai'

function number(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? preciseMoney(n) : null
}

function balanceNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? preciseMoney(n) : null
}

function count(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

// Only public accounting fields leave the Host. Never forward raw responses,
// keys, user profiles, request identifiers or authentication headers.
export function parseBeichenUsage(data, key, now = Date.now()) {
  if (!data || data.isValid !== true) throw new Error('北辰 API key 无效或用量响应异常')
  const currency = String(data.unit || 'USD').toUpperCase()
  if (currency !== 'USD') throw new Error('北辰用量币种异常，预期 USD')
  const wallet = balanceNumber(data.balance)
  const remaining = wallet ?? balanceNumber(data.remaining) ?? balanceNumber(data.quota?.remaining)
  const balanceKind = wallet !== null ? 'wallet' : data.mode === 'quota_limited' ? 'key-quota' : 'subscription'
  const today = data.usage?.today
  const total = data.usage?.total
  const todayCost = number(today?.actual_cost)
  const totalCost = number(total?.actual_cost)
  // Missing statistics must remain missing, never turn into a successful zero.
  const days = {}
  const day = beijingDay(now)
  if (Array.isArray(data.daily_usage)) {
    for (let i = 0; i < 90; i++) days[dayOffset(day, -i)] = { amount: 0, requests: 0, currency }
  }
  for (const row of Array.isArray(data.daily_usage) ? data.daily_usage : []) {
    const cost = number(row?.actual_cost)
    if (/^\d{4}-\d{2}-\d{2}$/.test(row?.date || '')) {
      days[row.date] = { amount: cost, requests: count(row.requests), currency }
    }
  }
  if (todayCost !== null) days[day] = { amount: todayCost, requests: count(today.requests), currency }
  const models = (Array.isArray(data.model_stats) ? data.model_stats : [])
    .filter(row => typeof row?.model === 'string' && number(row.actual_cost) !== null)
    .map(row => ({ model: row.model.slice(0, 160), cost: number(row.actual_cost), currency, source: 'beichen-api' }))
  return {
    ok: true, totalBalance: remaining, rechargeBalance: wallet, bonusBalance: null,
    currency, balanceKind, balanceSource: 'beichen-api',
    balanceLabel: balanceKind === 'wallet' ? '北辰钱包余额' : balanceKind === 'key-quota' ? '北辰 Key 剩余额度' : '北辰订阅剩余额度',
    accountTag: createHash('sha256').update('beichen:' + key).digest('hex').slice(0, 24),
    updatedAt: new Date(now).toISOString(),
    serverUsage: { day, days, models, todayCost, totalCost, totalTokens: count(total?.total_tokens), scope: 'api-key', currency },
  }
}

export async function fetchBeichenUsage(key, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (typeof key !== 'string' || !key.trim()) return { ok: false, code: 'NO_KEY', error: '请在 DSH 凭据中配置 BEICHEN_API_KEY' }
  const day = beijingDay(now)
  const url = BEICHEN_USAGE_URL + '&start_date=' + day + '&end_date=' + day
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: 'Bearer ' + key.trim() },
      redirect: 'error', signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) return { ok: false, code: 'HTTP', transient: response.status >= 500 || response.status === 429, error: '北辰用量接口 HTTP ' + response.status }
    return parseBeichenUsage(await response.json(), key.trim(), now)
  } catch (err) {
    // Do not echo network errors: custom transports can include auth headers.
    return { ok: false, code: 'FETCH', transient: true, error: '北辰用量请求失败或响应格式异常，请检查密钥、网络及接口状态' }
  }
}

export function recordBeichenUsage(ledger, payload) {
  const usage = payload.serverUsage
  if (!usage || !payload.accountTag) return
  ledger.beichen ||= { active: '', accounts: {} }
  ledger.beichen.accounts ||= {}
  ledger.beichen.active = payload.accountTag
  const previous = ledger.beichen.accounts[payload.accountTag]
  const snapshot = { ...usage, updatedAt: payload.updatedAt, days: { ...(previous?.days || {}), ...usage.days } }
  // A key snapshot is replaced, not added. Repeated refreshes cannot double bill.
  const cutoff = dayOffset(usage.day, -365)
  snapshot.days = Object.fromEntries(Object.entries(snapshot.days).filter(([day]) => day >= cutoff))
  ledger.beichen.accounts[payload.accountTag] = snapshot
  return previous
}

export function beichenDaySummary(ledger, day = beijingDay()) {
  const snapshot = ledger.beichen?.accounts?.[ledger.beichen?.active]
  const row = snapshot?.days?.[day]
  const available = !!row && row.amount !== null && !(day === snapshot.day && snapshot.todayCost === null)
  return {
    amount: available ? row.amount : null, currency: 'USD',
    source: available ? 'beichen-api' : 'unavailable',
    label: available ? '北辰实际费用 · 当前 API key' : '北辰用量暂不可用',
    partialDay: false, requests: row?.requests ?? null, scope: 'api-key',
  }
}

export function beichenRecords(ledger, now = Date.now()) {
  const today = beijingDay(now)
  const snapshot = ledger.beichen?.accounts?.[ledger.beichen?.active]
  const forDay = date => {
    const summary = beichenDaySummary(ledger, date)
    const models = date === snapshot?.day ? snapshot.models : []
    return { ...summary, date, total: summary.amount, models, modelTotal: models.length ? sumMoney(models.map(m => m.cost)) : summary.amount, modelCurrency: 'USD' }
  }
  const days7 = Array.from({ length: 7 }, (_, i) => forDay(dayOffset(today, -i)))
  const total7 = days7.every(d => d.total !== null) ? sumMoney(days7.map(d => d.total)) : null
  return {
    today: forDay(today), days7, total7, total7Currency: 'USD', total7ByCurrency: { USD: total7 },
    all: { days: Object.keys(snapshot?.days || {}).sort().reverse().map(forDay), events: [] },
    totalActualCost: snapshot?.totalCost ?? null, scope: 'api-key',
  }
}
