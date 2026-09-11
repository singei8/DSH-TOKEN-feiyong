/**
 * dsh-token-feiyong — 宿主半边（直接维护的来源文件）
 *
 * 真实 cordis 插件：export name / export apply(ctx, rowConfig)。
 * 客户端可调用的 5 个方法挂在 POST /dsh-token-feiyong/* 上。
 *
 * I/O 刻意不用 fs / credentials / shell 这些服务：它们由 dsh-fs-local 等按作用域提供，
 * 根级插件 ctx 看不到（实测 ctx.get('fs') === undefined，徽标报「存档异常」）。
 * 真实插件运行在 Node 进程里，所以账本直接走 node:fs，余额直接走 fetch。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as pathJoin } from 'node:path'


/* DSH Token Billing — Host half v13b
 * 单次口径：三条收口路径（兼容 Agent 作用域过滤）：
 *  1) agent/turn-stopping（最精确，可能被 Agent 作用域过滤挡下）
 *  2) agent/inbox/claimed 的 turn 号变化（兼底）
 *  3) api-session/status running=false（根级事件，必达）
 * 日志会标注实际生效的路径，便于验证。
 */

const MAX_RECORDS = 300
const MAX_ROWS = 25
const MAX_PRICE_KEYS = 80
const MAX_WINDOWS = 8
const MAX_DAYS = 180
const MAX_SESSIONS = 200
const MAX_TURNS = 200
const WEEK_NAMES = ['一', '二', '三', '四', '五', '六', '日']
const BALANCE_TTL_MS = 60000
const STORE_FILE = 'token-billing-ledger.json'
const STORE_VERSION = 3

const config = {
  enabled: true,
  persist: true,
  currency: '\u00a5',
  utcOffsetMinutes: 480,
  peakDays: [1, 2, 3, 4, 5],
  peakWindows: [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  offPeakRatio: 0.5,
  showBalance: true,
  unconfinedBalance: true,
  credentialRef: 'DEEPSEEK_API_KEY',
  balanceUrl: 'https://api.deepseek.com/user/balance',
  prices: {
    'default': {
      cacheHit: 0.04, cacheMiss: 2, output: 8,
      cacheHitOff: 0.02, cacheMissOff: 1, outputOff: 4,
    },
    'deepseek-official/deepseek-v4-pro': {
      cacheHit: 0.3, cacheMiss: 9, output: 27,
      cacheHitOff: 0.15, cacheMissOff: 4.5, outputOff: 13.5,
    },
  },
}

const ledger = []
const totals = emptyBucket()
const byModel = {}
const bySession = {}
const byDay = {}
const turnOpen = {}
const openTurnNo = {}
const lastTurns = {}
let counter = 0
let hostCtx = null
let configDirty = false
let lastBalanceLog = ''
let lastBalanceOk = false
let balance = {
  at: 0,
  ok: false,
  loading: false,
  error: '余额尚未获取',
  isAvailable: null,
  currency: '',
  total: 0,
  granted: 0,
  toppedUp: 0,
  via: '',
}
let storePath = ''
let storeDir = ''
let storeReady = false
let storeWriting = false
let storeDirty = false
let storeSavedAt = 0
let storeError = ''

function emptyBucket() {
  return { calls: 0, cost: 0, hit: 0, miss: 0, write: 0, out: 0, offPeakCalls: 0 }
}

function bucketCopy(bucket) {
  return {
    calls: bucket.calls,
    cost: bucket.cost,
    hit: bucket.hit,
    miss: bucket.miss,
    write: bucket.write,
    out: bucket.out,
    offPeakCalls: bucket.offPeakCalls,
  }
}

function resetInto(bucket) {
  bucket.calls = 0
  bucket.cost = 0
  bucket.hit = 0
  bucket.miss = 0
  bucket.write = 0
  bucket.out = 0
  bucket.offPeakCalls = 0
}

function clearObject(target) {
  const keys = Object.keys(target)
  for (let index = 0; index < keys.length; index += 1) delete target[keys[index]]
}

function logInfo(message) {
  try { console.log('[billing] ' + message) } catch (error) { /* 忽略 */ }
}

function logError(message) {
  try { console.error('[billing] ' + message) } catch (error) { /* 忽略 */ }
}

function count(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : 0
}

function price(value) {
  const numeric = Number(value)
  return (Number.isFinite(numeric) && numeric >= 0) ? Math.min(numeric, 1000000) : 0
}

function errorText(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

function pad2(value) {
  return value < 10 ? '0' + String(value) : String(value)
}

function toMinutes(text, fallback) {
  if (typeof text !== 'string') return fallback
  const matched = /^(\d{1,2}):(\d{1,2})$/.exec(text.trim())
  if (matched === null) return fallback
  const hours = Number(matched[1])
  const mins = Number(matched[2])
  if (!(hours >= 0 && hours <= 23) || !(mins >= 0 && mins <= 59)) return fallback
  return hours * 60 + mins
}

function formatMinutes(value) {
  const total = ((Math.round(value) % 1440) + 1440) % 1440
  return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60)
}

function shifted(ms) {
  return new Date(ms + config.utcOffsetMinutes * 60000)
}

function isoDayOf(local) {
  const day = local.getUTCDay()
  return day === 0 ? 7 : day
}

function clockMinutes(ms) {
  const local = shifted(ms)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

function dayKey(ms) {
  const local = shifted(ms)
  return String(local.getUTCFullYear()) + '-' + pad2(local.getUTCMonth() + 1) + '-' + pad2(local.getUTCDate())
}

function stamp(ms) {
  const local = shifted(ms)
  return pad2(local.getUTCMonth() + 1) + '-' + pad2(local.getUTCDate()) + ' '
    + pad2(local.getUTCHours()) + ':' + pad2(local.getUTCMinutes()) + ':' + pad2(local.getUTCSeconds())
}

function inWindow(minutes, start, end) {
  if (start === end) return false
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end
}

function isOffPeak(ms) {
  const local = shifted(ms)
  if (config.peakDays.indexOf(isoDayOf(local)) === -1) return true
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
  const windows = config.peakWindows
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]
    const start = toMinutes(window.start, -1)
    const end = toMinutes(window.end, -1)
    if (start < 0 || end < 0) continue
    if (inWindow(minutes, start, end)) return false
  }
  return true
}

function priceEntryFor(provider, model) {
  const table = config.prices
  const exact = String(provider) + '/' + String(model)
  if (Object.prototype.hasOwnProperty.call(table, exact)) return { key: exact, match: 'exact', entry: table[exact] }
  if (Object.prototype.hasOwnProperty.call(table, String(model))) return { key: String(model), match: 'model', entry: table[String(model)] }
  return { key: 'default', match: 'default', entry: table['default'] }
}

function ratesFor(provider, model, offPeak) {
  const entry = priceEntryFor(provider, model).entry
  return offPeak
    ? { cacheHit: entry.cacheHitOff, cacheMiss: entry.cacheMissOff, output: entry.outputOff }
    : { cacheHit: entry.cacheHit, cacheMiss: entry.cacheMiss, output: entry.output }
}

function addInto(bucket, row) {
  bucket.calls += 1
  bucket.cost += row.cost
  bucket.hit += row.hit
  bucket.miss += row.miss
  bucket.write += row.write
  bucket.out += row.out
  if (row.offPeak === true) bucket.offPeakCalls += 1
}

function mergeBucketInto(target, source) {
  target.calls += source.calls
  target.cost += source.cost
  target.hit += source.hit
  target.miss += source.miss
  target.write += source.write
  target.out += source.out
  target.offPeakCalls += source.offPeakCalls
}

function mergeBucketMap(target, source) {
  const keys = Object.keys(source)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (target[key] === undefined) target[key] = emptyBucket()
    mergeBucketInto(target[key], source[key])
  }
}

function sessionKeyOf(row) {
  return row.sessionId === null ? '(未标注会话)' : row.sessionId
}

function pruneDays() {
  const keys = Object.keys(byDay)
  if (keys.length <= MAX_DAYS) return
  keys.sort()
  const excess = keys.length - MAX_DAYS
  for (let index = 0; index < excess; index += 1) delete byDay[keys[index]]
}

function pruneSessions() {
  const keys = Object.keys(bySession)
  if (keys.length <= MAX_SESSIONS) return
  const list = []
  for (let index = 0; index < keys.length; index += 1) list.push({ key: keys[index], cost: bySession[keys[index]].cost })
  list.sort(function (left, right) { return left.cost - right.cost })
  const excess = list.length - MAX_SESSIONS
  for (let index = 0; index < excess; index += 1) delete bySession[list[index].key]
}

function pruneLastTurns() {
  const keys = Object.keys(lastTurns)
  if (keys.length <= MAX_TURNS) return
  const list = []
  for (let index = 0; index < keys.length; index += 1) list.push({ key: keys[index], at: lastTurns[keys[index]].at })
  list.sort(function (left, right) { return left.at - right.at })
  const excess = list.length - MAX_TURNS
  for (let index = 0; index < excess; index += 1) delete lastTurns[list[index].key]
}

function closeTurn(sessionId, source) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  const bucket = turnOpen[sessionId]
  const turn = openTurnNo[sessionId]
  delete turnOpen[sessionId]
  delete openTurnNo[sessionId]
  if (bucket === undefined || bucket.calls === 0) return
  lastTurns[sessionId] = { bucket: bucket, at: new Date().getTime(), turn: Number.isFinite(turn) ? turn : 0 }
  pruneLastTurns()
  logInfo('turn closed via ' + source + ': session=' + sessionId + ' turn=' + String(Number.isFinite(turn) ? turn : 0)
    + ' calls=' + String(bucket.calls) + ' cost=' + bucket.cost.toFixed(6))
  scheduleSave()
}

function agentSessionId(agent) {
  if (agent === null || agent === undefined) return null
  if (typeof agent.id === 'string' && agent.id.length > 0) return agent.id
  const session = agent.session
  if (session !== null && typeof session === 'object' && typeof session.id === 'string' && session.id.length > 0) return session.id
  return null
}

function recordCall(meta, usage) {
  const ms = new Date().getTime()
  const offPeak = isOffPeak(ms)
  const rate = ratesFor(meta.provider, meta.model, offPeak)
  const sessionId = (meta.sessionId === null || meta.sessionId === undefined) ? null : String(meta.sessionId)
  const row = {
    seq: (counter += 1),
    ts: ms,
    day: dayKey(ms),
    time: stamp(ms),
    provider: meta.provider,
    model: meta.model,
    key: String(meta.provider) + '/' + String(meta.model),
    sessionId: sessionId,
    purpose: (meta.purpose === null || meta.purpose === undefined) ? null : String(meta.purpose),
    hit: usage.cacheReadTokens,
    miss: usage.inputTokens,
    write: usage.cacheWriteTokens,
    out: usage.outputTokens,
    reasoning: usage.reasoningTokens,
    offPeak: offPeak,
    cost: (usage.cacheReadTokens * rate.cacheHit
      + (usage.inputTokens + usage.cacheWriteTokens) * rate.cacheMiss
      + usage.outputTokens * rate.output) / 1000000,
  }
  ledger.push(row)
  while (ledger.length > MAX_RECORDS) ledger.shift()
  addInto(totals, row)
  if (byModel[row.key] === undefined) byModel[row.key] = emptyBucket()
  addInto(byModel[row.key], row)
  const sessionKey = sessionKeyOf(row)
  if (bySession[sessionKey] === undefined) bySession[sessionKey] = emptyBucket()
  addInto(bySession[sessionKey], row)
  if (byDay[row.day] === undefined) byDay[row.day] = emptyBucket()
  addInto(byDay[row.day], row)
  if (turnOpen[sessionKey] === undefined) turnOpen[sessionKey] = emptyBucket()
  addInto(turnOpen[sessionKey], row)
  pruneDays()
  pruneSessions()
  scheduleSave()
  return row
}

function rebuild() {
  resetInto(totals)
  clearObject(byModel)
  clearObject(bySession)
  clearObject(byDay)
  for (let index = 0; index < ledger.length; index += 1) {
    const row = ledger[index]
    addInto(totals, row)
    if (byModel[row.key] === undefined) byModel[row.key] = emptyBucket()
    addInto(byModel[row.key], row)
    const sessionKey = sessionKeyOf(row)
    if (bySession[sessionKey] === undefined) bySession[sessionKey] = emptyBucket()
    addInto(bySession[sessionKey], row)
    if (byDay[row.day] === undefined) byDay[row.day] = emptyBucket()
    addInto(byDay[row.day], row)
  }
}

function recent(sessionId, limit) {
  const rows = []
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const row = ledger[index]
    if (sessionId !== null && row.sessionId !== sessionId) continue
    rows.push(row)
    if (rows.length >= limit) break
  }
  return rows
}

function bucketList(source) {
  const list = []
  const keys = Object.keys(source)
  for (let index = 0; index < keys.length; index += 1) {
    const entry = bucketCopy(source[keys[index]])
    entry.key = keys[index]
    list.push(entry)
  }
  list.sort(function (left, right) { return right.cost - left.cost })
  return list
}

function modelList() {
  const list = bucketList(byModel)
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    const parts = String(entry.key).split('/')
    const provider = parts.length > 1 ? parts[0] : 'unknown'
    const model = parts.length > 1 ? parts.slice(1).join('/') : String(entry.key)
    const found = priceEntryFor(provider, model)
    entry.priceKey = found.key
    entry.priceMatch = found.match
    entry.pricePeak = {
      cacheHit: found.entry.cacheHit,
      cacheMiss: found.entry.cacheMiss,
      output: found.entry.output,
    }
    entry.priceOff = {
      cacheHit: found.entry.cacheHitOff,
      cacheMiss: found.entry.cacheMissOff,
      output: found.entry.outputOff,
    }
  }
  return list
}

function lastTurnView(sessionId) {
  const build = function (entry, key) {
    return {
      sessionId: key,
      at: entry.at,
      atText: stamp(entry.at),
      turn: entry.turn,
      calls: entry.bucket.calls,
      cost: entry.bucket.cost,
      hit: entry.bucket.hit,
      miss: entry.bucket.miss,
      write: entry.bucket.write,
      out: entry.bucket.out,
      offPeakCalls: entry.bucket.offPeakCalls,
    }
  }
  if (sessionId !== null && lastTurns[sessionId] !== undefined) return build(lastTurns[sessionId], sessionId)
  let bestKey = null
  const keys = Object.keys(lastTurns)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (bestKey === null || lastTurns[key].at > lastTurns[bestKey].at) bestKey = key
  }
  if (bestKey === null) return null
  return build(lastTurns[bestKey], bestKey)
}

function offsetLabel() {
  const total = Math.round(config.utcOffsetMinutes)
  const sign = total < 0 ? '-' : '+'
  const abs = Math.abs(total)
  return 'UTC' + sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60)
}

function daysText(days) {
  if (!Array.isArray(days) || days.length === 0) return '无高峰日'
  if (days.length === 7) return '每天'
  let contiguous = true
  for (let index = 1; index < days.length; index += 1) {
    if (days[index] !== days[index - 1] + 1) contiguous = false
  }
  if (contiguous && days.length > 1) {
    return '周' + WEEK_NAMES[days[0] - 1] + '至周' + WEEK_NAMES[days[days.length - 1] - 1]
  }
  const parts = []
  for (let index = 0; index < days.length; index += 1) parts.push('周' + WEEK_NAMES[days[index] - 1])
  return parts.join('、')
}

function windowsText() {
  const parts = []
  for (let index = 0; index < config.peakWindows.length; index += 1) {
    const window = config.peakWindows[index]
    parts.push(window.start + '-' + window.end)
  }
  return parts.length === 0 ? '未设置' : parts.join(', ')
}

function clonePrices() {
  const out = {}
  const keys = Object.keys(config.prices)
  for (let index = 0; index < keys.length; index += 1) {
    const entry = config.prices[keys[index]]
    out[keys[index]] = {
      cacheHit: entry.cacheHit,
      cacheMiss: entry.cacheMiss,
      output: entry.output,
      cacheHitOff: entry.cacheHitOff,
      cacheMissOff: entry.cacheMissOff,
      outputOff: entry.outputOff,
    }
  }
  return out
}

function readSessionId(args) {
  if (args === null || typeof args !== 'object') return null
  return (typeof args.sessionId === 'string' && args.sessionId.length > 0) ? args.sessionId : null
}

function snapshot(sessionId) {
  const ms = new Date().getTime()
  const offPeak = isOffPeak(ms)
  const minutes = clockMinutes(ms)
  const local = shifted(ms)
  const isoDay = isoDayOf(local)
  const todayKey = dayKey(ms)
  const sessionBucket = sessionId === null
    ? totals
    : (bySession[sessionId] === undefined ? emptyBucket() : bySession[sessionId])
  const known = Object.keys(byModel)
  const priceKeys = Object.keys(config.prices)
  for (let index = 0; index < priceKeys.length; index += 1) {
    if (known.indexOf(priceKeys[index]) === -1) known.push(priceKeys[index])
  }
  if (config.enabled === true && config.showBalance === true) kickBalance(false)
  return {
    now: ms,
    config: {
      enabled: config.enabled,
      persist: config.persist,
      currency: config.currency,
      utcOffsetMinutes: config.utcOffsetMinutes,
      peakDays: config.peakDays.slice(),
      peakWindows: config.peakWindows.slice(),
      peakWindowsText: windowsText(),
      offPeakRatio: config.offPeakRatio,
      showBalance: config.showBalance,
      unconfinedBalance: config.unconfinedBalance,
      credentialRef: config.credentialRef,
      balanceUrl: config.balanceUrl,
      prices: clonePrices(),
    },
    phase: {
      offPeak: offPeak,
      label: offPeak ? '低谷' : '高峰',
      clock: pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60),
      isoDay: isoDay,
      dayLabel: '周' + WEEK_NAMES[isoDay - 1],
      peakDay: config.peakDays.indexOf(isoDay) !== -1,
      offsetLabel: offsetLabel(),
      peakDaysText: daysText(config.peakDays),
      peakWindowsText: windowsText(),
    },
    balance: {
      at: balance.at,
      ok: balance.ok,
      loading: balance.loading,
      error: balance.error,
      isAvailable: balance.isAvailable,
      currency: balance.currency,
      total: balance.total,
      granted: balance.granted,
      toppedUp: balance.toppedUp,
      via: balance.via,
    },
    store: {
      ready: storeReady,
      enabled: config.persist,
      path: storePath,
      savedAt: storeSavedAt,
      savedAtText: storeSavedAt > 0 ? stamp(storeSavedAt) : '',
      error: storeError,
      rows: ledger.length,
    },
    lastTurn: lastTurnView(sessionId),
    totals: bucketCopy(totals),
    sessionTotals: bucketCopy(sessionBucket),
    todayTotals: bucketCopy(byDay[todayKey] === undefined ? emptyBucket() : byDay[todayKey]),
    todayKey: todayKey,
    sessionId: sessionId,
    byModel: modelList(),
    sessions: bucketList(bySession),
    days: bucketList(byDay),
    knownModels: known,
    rows: recent(sessionId, MAX_ROWS),
    rowsAll: recent(null, MAX_ROWS),
  }
}

/* ---------------- 数据存档 ---------------- */

function joinPath(dir, name) {
  const sep = dir.indexOf('\\') !== -1 ? '\\' : '/'
  if (dir.length === 0) return name
  const last = dir.charAt(dir.length - 1)
  return (last === '\\' || last === '/') ? dir + name : dir + sep + name
}

/** DSH 主目录：优先 DSH_HOME，否则 ~/.dsh（与旧版写入位置一致）。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return pathJoin(homedir(), '.dsh')
}

/**
 * 账本路径。
 *
 * 旧版向 settings 服务要文档路径再取目录；现在直接由 DSH_HOME 推导，
 * 结果相同（<DSH_HOME>/token-billing-ledger.json），历史账本自然延续，
 * 也不再依赖任何按作用域提供的服务。
 */
function resolveStorePath() {
  storeDir = resolveDshHome()
  return pathJoin(storeDir, STORE_FILE)
}

function bucketMapCopy(source) {
  const out = {}
  const keys = Object.keys(source)
  for (let index = 0; index < keys.length; index += 1) out[keys[index]] = bucketCopy(source[keys[index]])
  return out
}

function lastTurnMapCopy() {
  const out = {}
  const keys = Object.keys(lastTurns)
  for (let index = 0; index < keys.length; index += 1) {
    const entry = lastTurns[keys[index]]
    out[keys[index]] = { at: entry.at, turn: entry.turn, bucket: bucketCopy(entry.bucket) }
  }
  return out
}

function readLastTurnMap(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const keys = Object.keys(raw).slice(0, 400)
  for (let index = 0; index < keys.length; index += 1) {
    const entry = raw[keys[index]]
    if (entry === null || typeof entry !== 'object') continue
    const bucket = emptyBucket()
    if (!readBucket(entry.bucket, bucket)) continue
    const at = Number(entry.at)
    const turn = Number(entry.turn)
    out[String(keys[index]).slice(0, 120)] = {
      at: Number.isFinite(at) && at > 0 ? Math.round(at) : 0,
      turn: Number.isFinite(turn) && turn > 0 ? Math.round(turn) : 0,
      bucket: bucket,
    }
  }
  return out
}

function mergeLastTurns(target, source) {
  const keys = Object.keys(source)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const existing = target[key]
    if (existing === undefined || source[key].at > existing.at) target[key] = source[key]
  }
}

function storePayload() {
  return JSON.stringify({
    version: STORE_VERSION,
    savedAt: new Date().getTime(),
    config: {
      enabled: config.enabled,
      persist: config.persist,
      currency: config.currency,
      utcOffsetMinutes: config.utcOffsetMinutes,
      peakDays: config.peakDays.slice(),
      peakWindows: config.peakWindows.slice(),
      offPeakRatio: config.offPeakRatio,
      showBalance: config.showBalance,
      unconfinedBalance: config.unconfinedBalance,
      credentialRef: config.credentialRef,
      balanceUrl: config.balanceUrl,
      prices: clonePrices(),
    },
    counter: counter,
    totals: bucketCopy(totals),
    byModel: bucketMapCopy(byModel),
    byDay: bucketMapCopy(byDay),
    bySession: bucketMapCopy(bySession),
    lastTurns: lastTurnMapCopy(),
    rows: ledger.slice(ledger.length > MAX_RECORDS ? ledger.length - MAX_RECORDS : 0),
  })
}

function sanitizeRow(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const seq = Number(raw.seq)
  const ts = Number(raw.ts)
  if (!Number.isFinite(seq) || !Number.isFinite(ts) || ts <= 0) return null
  const num = function (value) { const n = Number(value); return (Number.isFinite(n) && n >= 0) ? n : 0 }
  const provider = typeof raw.provider === 'string' ? raw.provider.slice(0, 60) : 'unknown'
  const model = typeof raw.model === 'string' ? raw.model.slice(0, 90) : 'unknown'
  const stored = Number(raw.cost)
  return {
    seq: Math.round(seq),
    ts: Math.round(ts),
    day: typeof raw.day === 'string' ? raw.day : dayKey(ts),
    time: typeof raw.time === 'string' ? raw.time : stamp(ts),
    provider: provider,
    model: model,
    key: provider + '/' + model,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    purpose: typeof raw.purpose === 'string' ? raw.purpose : null,
    hit: num(raw.hit),
    miss: num(raw.miss),
    write: num(raw.write),
    out: num(raw.out),
    reasoning: num(raw.reasoning),
    offPeak: raw.offPeak === true,
    cost: (Number.isFinite(stored) && stored >= 0) ? stored : 0,
  }
}

function readBucket(raw, target) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const num = function (value) { const n = Number(value); return (Number.isFinite(n) && n >= 0) ? n : 0 }
  resetInto(target)
  target.calls = num(raw.calls)
  target.cost = num(raw.cost)
  target.hit = num(raw.hit)
  target.miss = num(raw.miss)
  target.write = num(raw.write)
  target.out = num(raw.out)
  target.offPeakCalls = num(raw.offPeakCalls)
  return true
}

function readBucketMap(raw, target) {
  clearObject(target)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
  const keys = Object.keys(raw).slice(0, 500)
  for (let index = 0; index < keys.length; index += 1) {
    const bucket = emptyBucket()
    if (readBucket(raw[keys[index]], bucket)) target[String(keys[index]).slice(0, 120)] = bucket
  }
}

function restoreStore(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return
  if (configDirty !== true && data.config !== null && typeof data.config === 'object' && !Array.isArray(data.config)) {
    applyConfig(data.config)
  }
  const savedAt = Number(data.savedAt)
  if (Number.isFinite(savedAt) && savedAt > 0) storeSavedAt = Math.round(savedAt)
  const seen = {}
  for (let index = 0; index < ledger.length; index += 1) seen[String(ledger[index].seq)] = true
  const memoryRows = ledger.length
  const memoryTotals = bucketCopy(totals)
  const memoryModel = bucketMapCopy(byModel)
  const memoryDay = bucketMapCopy(byDay)
  const memorySession = bucketMapCopy(bySession)
  if (Array.isArray(data.rows)) {
    for (let index = 0; index < data.rows.length; index += 1) {
      const row = sanitizeRow(data.rows[index])
      if (row === null) continue
      if (seen[String(row.seq)] === true) continue
      seen[String(row.seq)] = true
      ledger.push(row)
    }
    ledger.sort(function (left, right) { return left.ts - right.ts })
    while (ledger.length > MAX_RECORDS) ledger.shift()
  }
  const storedCounter = Number(data.counter)
  if (Number.isFinite(storedCounter) && storedCounter > counter) counter = Math.round(storedCounter)
  for (let index = 0; index < ledger.length; index += 1) {
    if (ledger[index].seq > counter) counter = ledger[index].seq
  }
  mergeLastTurns(lastTurns, readLastTurnMap(data.lastTurns))
  const hasAggregates = data.totals !== null && typeof data.totals === 'object'
  if (hasAggregates) {
    resetInto(totals)
    clearObject(byModel)
    clearObject(byDay)
    clearObject(bySession)
    const fileTotals = emptyBucket()
    readBucket(data.totals, fileTotals)
    mergeBucketInto(totals, fileTotals)
    mergeBucketInto(totals, memoryTotals)
    const fileModel = {}
    readBucketMap(data.byModel, fileModel)
    mergeBucketMap(byModel, fileModel)
    mergeBucketMap(byModel, memoryModel)
    const fileDay = {}
    readBucketMap(data.byDay, fileDay)
    mergeBucketMap(byDay, fileDay)
    mergeBucketMap(byDay, memoryDay)
    const fileSession = {}
    readBucketMap(data.bySession, fileSession)
    mergeBucketMap(bySession, fileSession)
    mergeBucketMap(bySession, memorySession)
    pruneDays()
    pruneSessions()
    logInfo('store: merged file+' + String(fileTotals.calls) + ' + memory+' + String(memoryTotals.calls)
      + ' -> calls=' + String(totals.calls) + ' cost=' + totals.cost.toFixed(6))
  } else {
    rebuild()
    logInfo('store: v1 file, aggregates rebuilt from ' + String(ledger.length) + ' rows')
  }
  logInfo('store: rows memory=' + String(memoryRows) + ' final=' + String(ledger.length) + ' counter=' + String(counter)
    + ' lastTurns=' + String(Object.keys(lastTurns).length))
}

async function loadStore() {
  if (config.persist !== true) { storeReady = true; return }
  storePath = resolveStorePath()
  if (storePath.length === 0) {
    storeError = '无法定位存档路径'
    logError('store: ' + storeError)
    return
  }
  let text = ''
  try {
    text = readFileSync(storePath, 'utf8')
  } catch (error) {
    logInfo('store: no readable file yet at ' + storePath + ' (' + errorText(error) + ')')
    text = ''
  }
  if (typeof text === 'string' && text.length > 0) {
    try {
      restoreStore(JSON.parse(text))
      storeError = ''
    } catch (error) {
      storeError = '存档解析失败：' + errorText(error)
      logError('store: ' + storeError)
    }
  }
  storeReady = true
  logInfo('store: ready at ' + storePath)
}

function scheduleSave() {
  if (config.persist !== true) return
  if (storeReady !== true || storePath.length === 0) return
  storeDirty = true
  if (storeWriting === true) return
  flushStore()
}

async function flushStore() {
  if (config.persist !== true) return
  if (storeReady !== true || storePath.length === 0) return
  storeWriting = true
  try {
    while (storeDirty === true) {
      storeDirty = false
      const payload = storePayload()
      mkdirSync(storeDir, { recursive: true })
      writeFileSync(storePath, payload, 'utf8')
      storeSavedAt = new Date().getTime()
      storeError = ''
    }
  } catch (error) {
    storeError = errorText(error)
    logError('store: write failed: ' + storeError)
  }
  storeWriting = false
  if (storeDirty === true) scheduleSave()
}

/* ---------------- 账户余额 ---------------- */

/**
 * 从 <DSH_HOME>/.credentials.yaml 的 refs 段读一个凭据。
 *
 * 只在凭据服务不可用时兜底；按行扫描而非引入 YAML 依赖，
 * 因为只需要 refs 下一个顶层键的标量值。
 */
function credentialFromFile(ref) {
  let text = ''
  try {
    text = readFileSync(pathJoin(resolveDshHome(), '.credentials.yaml'), 'utf8')
  } catch (error) {
    return ''
  }
  const lines = text.split(/\r?\n/)
  let inRefs = false
  let indent = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const currentIndent = line.length - line.trimStart().length
    if (inRefs !== true) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; indent = -1 }
      continue
    }
    if (currentIndent === 0) break
    if (indent === -1) indent = currentIndent
    if (currentIndent !== indent) continue
    const match = /^([A-Za-z0-9_./-]+):[ \t]*(.*)$/.exec(line.trim())
    if (match === null || match[1] !== ref) continue
    return match[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return ''
}

/** 解析 /user/balance 的响应体；形状不对时返回 null。 */
function parseBalanceBody(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  let data = null
  try { data = JSON.parse(text) } catch (error) { return null }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
  const info = infos.length > 0 && infos[0] !== null && typeof infos[0] === 'object' ? infos[0] : null
  const toNumber = function (value) {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : 0
  }
  return {
    at: new Date().getTime(),
    ok: true,
    loading: false,
    error: '',
    isAvailable: data.is_available !== false,
    currency: (info !== null && typeof info.currency === 'string') ? info.currency : '',
    total: info === null ? 0 : toNumber(info.total_balance),
    granted: info === null ? 0 : toNumber(info.granted_balance),
    toppedUp: info === null ? 0 : toNumber(info.topped_up_balance),
    via: '',
  }
}

/**
 * 取一次余额。只读 GET，凭据按 env -> credentials 服务 -> .credentials.yaml 依次尝试。
 * 密钥不进日志、不进命令行参数、不下发前端。
 */
async function fetchBalance() {
  const failed = function (message) {
    lastBalanceOk = false
    logError('balance failed: ' + message)
    return {
      at: new Date().getTime(), ok: false, loading: false, error: message,
      isAvailable: null, currency: '', total: 0, granted: 0, toppedUp: 0, via: '',
    }
  }
  let key = ''
  let keySource = 'none'
  const fromEnv = process.env[config.credentialRef]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    key = fromEnv.trim()
    keySource = 'env'
  }
  if (key.length === 0) {
    const credentials = hostCtx === null ? undefined : hostCtx.get('credentials')
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(config.credentialRef)
        if (resolved !== null && resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
          key = resolved.value
          keySource = typeof resolved.source === 'string' ? resolved.source : 'credentials'
        }
      } catch (error) {
        logError('credentials.resolve threw: ' + errorText(error))
      }
    }
  }
  if (key.length === 0) {
    key = credentialFromFile(config.credentialRef)
    if (key.length > 0) keySource = 'file'
  }
  if (key.length === 0) {
    return failed('找不到凭据 ' + config.credentialRef + '（env、credentials 服务、.credentials.yaml 都没有）')
  }
  try {
    const response = await fetch(config.balanceUrl, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    })
    const body = (await response.text()).trim()
    if (response.status !== 200) {
      return failed('余额接口 HTTP ' + String(response.status) + '：' + body.slice(0, 200))
    }
    const parsed = parseBalanceBody(body)
    if (parsed === null) return failed('余额接口返回了无法解析的内容：' + body.slice(0, 200))
    parsed.via = 'fetch:' + keySource
    lastBalanceOk = true
    const fingerprint = String(parsed.currency) + ':' + String(parsed.total)
    if (lastBalanceLog !== fingerprint) {
      lastBalanceLog = fingerprint
      logInfo('balance ok via fetch (' + keySource + '): ' + String(parsed.total) + ' ' + parsed.currency)
    }
    return parsed
  } catch (error) {
    return failed('请求余额失败：' + errorText(error))
  }
}

function kickBalance(force) {
  if (config.enabled !== true && force !== true) return Promise.resolve(balance)
  if (config.showBalance !== true && force !== true) return Promise.resolve(balance)
  const now = new Date().getTime()
  if (balance.loading === true) return Promise.resolve(balance)
  if (force !== true && balance.at > 0 && (now - balance.at) < BALANCE_TTL_MS) return Promise.resolve(balance)
  balance.loading = true
  return fetchBalance().then(function (next) {
    balance = next
    return balance
  }).catch(function (error) {
    lastBalanceOk = false
    logError('balance unexpected: ' + errorText(error))
    balance = {
      at: new Date().getTime(), ok: false, loading: false, error: errorText(error),
      isAvailable: null, currency: '', total: 0, granted: 0, toppedUp: 0, via: '',
    }
    return balance
  })
}

function resetBalance() {
  balance = { at: 0, ok: false, loading: false, error: '余额尚未获取', isAvailable: null, currency: '', total: 0, granted: 0, toppedUp: 0, via: '' }
}

function applyConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return
  if (typeof input.currency === 'string' && input.currency.length > 0 && input.currency.length <= 6) {
    config.currency = input.currency
  }
  const offset = Number(input.utcOffsetMinutes)
  if (Number.isFinite(offset) && offset >= -840 && offset <= 840) {
    config.utcOffsetMinutes = Math.round(offset)
  }
  if (Array.isArray(input.peakDays)) {
    const days = []
    for (let index = 0; index < input.peakDays.length; index += 1) {
      const day = Number(input.peakDays[index])
      if (!Number.isInteger(day) || day < 1 || day > 7) continue
      if (days.indexOf(day) === -1) days.push(day)
    }
    days.sort(function (left, right) { return left - right })
    config.peakDays = days
  }
  if (Array.isArray(input.peakWindows)) {
    const windows = []
    const limit = Math.min(input.peakWindows.length, MAX_WINDOWS)
    for (let index = 0; index < limit; index += 1) {
      const raw = input.peakWindows[index]
      if (raw === null || typeof raw !== 'object') continue
      const start = toMinutes(raw.start, -1)
      const end = toMinutes(raw.end, -1)
      if (start < 0 || end < 0 || start === end) continue
      windows.push({ start: formatMinutes(start), end: formatMinutes(end) })
    }
    config.peakWindows = windows
  }
  const ratio = Number(input.offPeakRatio)
  if (Number.isFinite(ratio) && ratio >= 0) config.offPeakRatio = Math.min(ratio, 10)
  const ref = input.credentialRef
  if (typeof ref === 'string' && ref.trim().length > 0 && ref.length <= 120) config.credentialRef = ref.trim()
  const url = input.balanceUrl
  if (typeof url === 'string' && /^https?:\/\//.test(url.trim()) && url.length <= 300) config.balanceUrl = url.trim()
  if (typeof input.showBalance === 'boolean' && input.showBalance !== config.showBalance) {
    config.showBalance = input.showBalance
    resetBalance()
  }
  if (typeof input.unconfinedBalance === 'boolean' && input.unconfinedBalance !== config.unconfinedBalance) {
    config.unconfinedBalance = input.unconfinedBalance
    resetBalance()
  }
  if (typeof input.enabled === 'boolean' && input.enabled !== config.enabled) {
    config.enabled = input.enabled
    logInfo('enabled -> ' + String(config.enabled))
    if (config.enabled === true) resetBalance()
  }
  if (typeof input.persist === 'boolean') config.persist = input.persist
  const incoming = input.prices
  if (incoming !== null && typeof incoming === 'object' && !Array.isArray(incoming)) {
    const next = {}
    const keys = Object.keys(incoming).slice(0, MAX_PRICE_KEYS)
    for (let index = 0; index < keys.length; index += 1) {
      const key = String(keys[index]).trim().slice(0, 90)
      if (key.length === 0) continue
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      const entry = incoming[keys[index]]
      if (entry === null || typeof entry !== 'object') continue
      next[key] = {
        cacheHit: price(entry.cacheHit),
        cacheMiss: price(entry.cacheMiss),
        output: price(entry.output),
        cacheHitOff: price(entry.cacheHitOff),
        cacheMissOff: price(entry.cacheMissOff),
        outputOff: price(entry.outputOff),
      }
    }
    if (next['default'] === undefined) {
      const fallback = config.prices['default']
      next['default'] = fallback === undefined
        ? { cacheHit: 0, cacheMiss: 0, output: 0, cacheHitOff: 0, cacheMissOff: 0, outputOff: 0 }
        : {
          cacheHit: fallback.cacheHit, cacheMiss: fallback.cacheMiss, output: fallback.output,
          cacheHitOff: fallback.cacheHitOff, cacheMissOff: fallback.cacheMissOff, outputOff: fallback.outputOff,
        }
    }
    config.prices = next
  }
}

async function* relay(stream, meta) {
  let usage = null
  try {
    for await (const chunk of stream) {
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') {
        const raw = chunk.usage
        if (raw !== null && typeof raw === 'object') {
          usage = {
            inputTokens: count(raw.inputTokens),
            outputTokens: count(raw.outputTokens),
            cacheReadTokens: count(raw.cacheReadTokens),
            cacheWriteTokens: count(raw.cacheWriteTokens),
            reasoningTokens: count(raw.reasoningTokens),
          }
        }
      }
      yield chunk
    }
  } finally {
    if (usage !== null) recordCall(meta, usage)
  }
}

/* ------------------------------------------------------------------ *
 * 真实插件外壳
 *
 * 动态沙箱里的 harness.handle(method, fn) 在这里换成 webServer 上的 HTTP
 * 路由：方法名不变，路径为 /dsh-token-feiyong/<method 去掉 "billing/" 前缀>。
 * 客户端用 POST + 自定义头调用，路由由 ctx.effect 注销。
 * ------------------------------------------------------------------ */

const ROUTE_PREFIX = '/dsh-token-feiyong'
const MAX_BODY_BYTES = 1048576
/** 客户端必须带这个头：跨源页面无法在没有预检的情况下发送自定义头。 */
const ROUTE_HEADER = 'x-dsh-token-feiyong'

const routeHandlers = {}

function __register(method, handler) {
  routeHandlers[method] = handler
}

function __sendJson(response, status, value, extraHeaders) {
  const body = JSON.stringify(value === undefined ? null : value)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  }
  if (extraHeaders !== undefined && extraHeaders !== null) {
    const keys = Object.keys(extraHeaders)
    for (let index = 0; index < keys.length; index += 1) headers[keys[index]] = extraHeaders[keys[index]]
  }
  response.writeHead(status, headers)
  response.end(body)
}

function __readJson(request) {
  return new Promise(function (resolve, reject) {
    const chunks = []
    let size = 0
    request.on('data', function (chunk) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body exceeds ' + String(MAX_BODY_BYTES) + ' bytes'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', function (error) { reject(error) })
    request.on('end', function () {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch (error) { reject(error) }
    })
  })
}

function __routeName(method) {
  const cut = method.indexOf('/')
  return cut === -1 ? method : method.slice(cut + 1)
}

function __routeHandler(method) {
  return async function (request, response) {
    if (request.method !== 'POST') {
      __sendJson(response, 405, { error: 'POST required' }, { allow: 'POST' })
      return
    }
    if (request.headers[ROUTE_HEADER] !== '1') {
      __sendJson(response, 403, { error: 'missing ' + ROUTE_HEADER + ' header' })
      return
    }
    let args = {}
    try {
      args = await __readJson(request)
    } catch (error) {
      __sendJson(response, 400, { error: errorText(error) })
      return
    }
    try {
      __sendJson(response, 200, await routeHandlers[method](args))
    } catch (error) {
      logError('http: ' + method + ' failed: ' + errorText(error))
      __sendJson(response, 500, { error: errorText(error) })
    }
  }
}

/**
 * 复位模块级聚合状态。
 *
 * apply 会在不重启进程的情况下被再次执行（补丁热重载、配置变更），而 ESM 模块实例
 * 在进程内是复用的：不清空的话 loadStore 会把账本里的聚合再次并入已在内存的聚合，
 * 造成重复计数。真正跨进程的持久化由账本文件负责，这里只需把内存归零。
 */
function __resetState() {
  ledger.length = 0
  counter = 0
  resetInto(totals)
  clearObject(byModel)
  clearObject(byDay)
  clearObject(bySession)
  clearObject(turnOpen)
  clearObject(openTurnNo)
  clearObject(lastTurns)
  storeReady = false
  storeWriting = false
  storeDirty = false
  storeError = ''
}

function __mountRoutes(ctx) {
  ctx.inject(['webServer'], function (scoped) {
    scoped.effect(function () {
      const offs = []
      const methods = Object.keys(routeHandlers)
      for (let index = 0; index < methods.length; index += 1) {
        const method = methods[index]
        offs.push(scoped.webServer.register({
          kind: 'exact',
          path: ROUTE_PREFIX + '/' + __routeName(method),
          handler: __routeHandler(method),
        }))
      }
      logInfo('http: mounted ' + String(offs.length) + ' routes under ' + ROUTE_PREFIX)
      return function () {
        for (let index = 0; index < offs.length; index += 1) {
          const off = offs[index]
          if (typeof off === 'function') off()
        }
      }
    }, 'dsh-token-feiyong: http routes')
  })
}

export const name = 'dsh-token-feiyong'

/**
 * 挂载计费拦截、单次收口、余额探测与账本存档。
 * @param {object} ctx 宿主上下文（cordis Context）。
 * @param {object} [rowConfig] cordis.yml 该行的 config，作为初始配置。
 */
export function apply(ctx, rowConfig) {
  __resetState()
  if (rowConfig !== null && typeof rowConfig === "object") applyConfig(rowConfig)
    hostCtx = ctx
    logInfo('apply: enabled=' + String(config.enabled) + ' persist=' + String(config.persist))

    loadStore().catch(function (error) {
      storeError = errorText(error)
      logError('store: load failed: ' + storeError)
    })

    ctx.on('llm/stream', function (options, next) {
      const stream = next()
      if (stream === null || stream === undefined || typeof stream[Symbol.asyncIterator] !== 'function') {
        return stream
      }
      const source = (options !== null && typeof options === 'object') ? options : {}
      const meta = {
        provider: typeof source.provider === 'string' ? source.provider : 'unknown',
        model: typeof source.model === 'string' ? source.model : 'unknown',
        sessionId: (typeof source.sessionId === 'string' && source.sessionId.length > 0) ? source.sessionId : null,
        purpose: typeof source.purpose === 'string' ? source.purpose : null,
      }
      return relay(stream, meta)
    })

    /* 路径 1：Agent 作用域内的一轮收口（最精确）。 */
    ctx.on('agent/turn-stopping', function (payload) {
      if (payload === null || typeof payload !== 'object') return
      closeTurn(agentSessionId(payload.agent), 'turn-stopping')
    })

    /* 路径 2：新的一轮被认领时，收口遗留的上一轮（兼底）。 */
    ctx.on('agent/inbox/claimed', function (payload) {
      if (payload === null || typeof payload !== 'object') return
      const sessionId = agentSessionId(payload.agent)
      if (sessionId === null) return
      const turn = Number(payload.turn)
      if (!Number.isFinite(turn)) return
      const previous = openTurnNo[sessionId]
      if (previous !== undefined && turn !== previous) closeTurn(sessionId, 'inbox-claimed')
      openTurnNo[sessionId] = turn
    })

    /* 路径 3：根级事件，Agent 作用域过滤不到它（必达）。 */
    ctx.on('api-session/status', function (sessionId, running) {
      if (running === true) return
      closeTurn(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null, 'session-status')
    })

    __register('billing/state', function (args) {
      return snapshot(readSessionId(args))
    })

    __register('billing/save', function (args) {
      const input = (args !== null && typeof args === 'object') ? args : {}
      configDirty = true
      applyConfig(input.config)
      scheduleSave()
      return snapshot(readSessionId(args))
    })

    __register('billing/store', function (args) {
      storeDirty = true
      return flushStore().then(function () {
        return snapshot(readSessionId(args))
      })
    })

    __register('billing/balance', function (args) {
      return kickBalance(true).then(function () {
        return snapshot(readSessionId(args))
      })
    })

    __register('billing/reset', function (args) {
      ledger.length = 0
      counter = 0
      resetInto(totals)
      clearObject(byModel)
      clearObject(byDay)
      clearObject(bySession)
      clearObject(turnOpen)
      clearObject(openTurnNo)
      clearObject(lastTurns)
      scheduleSave()
      return snapshot(readSessionId(args))
    })

  __mountRoutes(ctx)
}
