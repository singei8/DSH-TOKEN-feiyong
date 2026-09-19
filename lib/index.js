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
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { execFile } from 'node:child_process'
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
const MAX_AFP_COEF_KEYS = 120
const MAX_WINDOWS = 8
const MAX_DAYS = 180
const MAX_SESSIONS = 200
const MAX_TURNS = 200
const MAX_LINEAGE = 200
const MAX_ADOPT_SESSIONS = 60
const MAX_ADOPT_FRAMES = 4
const MAX_ACTIVE_MODELS = 100
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
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
  mergeChildSessions: true,
  unconfinedBalance: true,
  credentialRef: 'DEEPSEEK_API_KEY',
  balanceUrl: 'https://api.deepseek.com/user/balance',
  balanceProfiles: {},
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
  /** 用户覆盖的 AFP 抵扣系数：{ '模型名或 provider/模型': { input, output } }。 */
  afpCoefs: {},
  /** 内置表里没有的模型按这个系数兜底（“进阶”档）。 */
  afpDefaultCoef: 2.5,
}

const ledger = []
const totals = emptyBucket()
const byModel = {}
const bySession = {}
const byDay = {}
const turnOpen = {}
const openTurnNo = {}
const lastTurns = {}
/** 子会话 -> 归属会话（侧边对话 / 子代理的花费并入主对话）。 */
const lineage = {}
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
  /** 这份余额属于哪个档位（provider|凭据|类型）；与当前档位不符时立刻作废。 */
  profileKey: '',
  /** 'balance' 金额 | 'quota' 配额 | 'none' 无接口 */
  kind: 'balance',
  label: '余额',
  quotaText: '',
  providerKey: '',
  providerLabel: '',
}
let balanceInflight = null
/** 套餐额度对账：把「按系数算出来的 AFP」和「控制台快照的增量」比一比，用于发现系数失效。 */
const planSeenUsed = {}
let planSeenReady = false
let planSeenSeq = 0
let planReconcile = { at: 0, delta: 0, computed: 0, ratio: 0, samples: 0 }
let balanceInflightKey = ''
/** DeepSeek 官方余额地址：用户没改过它时，不作为「兜底档位」使用。 */
const DEFAULT_BALANCE_URL = 'https://api.deepseek.com/user/balance'
let storePath = ''
let storeDir = ''
let storeReady = false
let storeWriting = false
let storeDirty = false
let storeSavedAt = 0
let storeError = ''

function emptyBucket() {
  return { calls: 0, cost: 0, hit: 0, miss: 0, write: 0, out: 0, offPeakCalls: 0, quota: 0 }
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
    quota: Number(bucket.quota) || 0,
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
  bucket.quota = 0
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

/**
 * 内置官方价目表（元/百万 Tokens）。
 *
 * 用户配置里没有的档位先回落到这里，再回落到 default —— 这样新增模型单价对**已有安装**
 * 也立即生效：账本里存过的 config.prices 会整体替换用户档位，但不会盖掉这张表。
 * 想覆盖某个内置档位，在设置页新增同名档位即可（用户档位优先级更高）。
 *
 * 来源与口径（核对于 2026-09-13）：
 *  - DeepSeek：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *  - 智谱 GLM：https://docs.bigmodel.cn/cn/guide/start/pricing
 *
 * GLM-5.3 与 GLM-5.3-Flash 均为 1M 上下文、单一价，**没有高峰/低谷之分**，
 * 所以两套单价写成相同值，时段不影响计价：
 *   GLM-5.3        输入 8   / 输出 28   / 缓存命中 2
 *   GLM-5.3-Flash  输入 0.8 / 输出 2.8 / 缓存命中 0.23
 * （单位：元/百万 tokens。缓存存储官方限时免费，本项目不计此项。）
 *
 * 同表另附 GLM-4.7：官方按输入长度分三档，这里取 输入 [32K, 200K) 档
 * （¥4 / ¥16 / 命中 ¥0.8）；另外两档为 <32K 且输出 <0.2K = ¥2 / ¥8 / 命中 ¥0.4、
 * <32K 且输出 ≥0.2K = ¥3 / ¥14 / 命中 ¥0.6，需要时在设置页新增同名档位覆盖。
 */
const BUILTIN_PRICES = {
  'default': {
    cacheHit: 0.04, cacheMiss: 2, output: 8,
    cacheHitOff: 0.02, cacheMissOff: 1, outputOff: 4,
  },
  'deepseek-official/deepseek-v4-pro': {
    cacheHit: 0.3, cacheMiss: 9, output: 27,
    cacheHitOff: 0.15, cacheMissOff: 4.5, outputOff: 13.5,
  },
  'glm-5.3': {
    cacheHit: 2, cacheMiss: 8, output: 28,
    cacheHitOff: 2, cacheMissOff: 8, outputOff: 28,
  },
  'glm-5.3-flash': {
    cacheHit: 0.23, cacheMiss: 0.8, output: 2.8,
    cacheHitOff: 0.23, cacheMissOff: 0.8, outputOff: 2.8,
  },
  'glm-4.7': {
    cacheHit: 0.8, cacheMiss: 4, output: 16,
    cacheHitOff: 0.8, cacheMissOff: 4, outputOff: 16,
  },
}

/**
 * Agent Plan 套餐内的 AFP 抵扣系数（官方文档《套餐内 AFP 抵扣规则》）。
 *
 *   文本生成 / 向量化模型：AFP = (输入 token × 输入系数 + 输出 token × 输出系数) / 10,000
 *
 * 输入 token = 缓存命中 + 缓存未命中 + 缓存写入（已用真实账号对过：控制台
 * `usage plan-details` 的 token 数与账本 hit+miss+write+out 完全一致）。
 * 文档里文本模型的输入、输出系数相同，这里仍分开存，将来不同时无需改结构。
 * `activities` 是限时折扣活动，按调用时刻决定是否打折（活动窗口用北京时间写）。
 *
 * 注意 deepseek-v4.1-flash：文档写 2.5、活动 5 折（=1.25），但实测账号的有效系数
 * 恰好是 1.0 —— 5h 窗口 832,517 token ↔ 83.2517 AFP，且把它代进 weekly/monthly
 * 两个窗口能对上 0.07%，所以这里记 0.4 折（=1.0）。
 */
const BUILTIN_AFP_COEFS = [
  { key: 'auto', label: 'Auto 模式', input: 0.5, output: 0.5, activities: [{ from: '2026-06-10T18:00:00+08:00', to: '2026-11-08T23:59:59+08:00', factor: 1, note: '活动期固定 0.5' }] },
  { key: 'doubao-seed-2-0-mini', label: 'doubao-seed-2.0-mini', input: 0.25, output: 0.25 },
  { key: 'doubao-seed-2-0-lite', label: 'doubao-seed-2.0-lite', input: 0.5, output: 0.5 },
  { key: 'deepseek-v4-flash', label: 'deepseek-v4-flash', input: 0.5, output: 0.5 },
  { key: 'glm-5-3-flash', label: 'glm-5.3-flash', input: 0.5, output: 0.5, activities: [{ from: '2026-08-28T00:00:00+08:00', to: '2026-09-11T23:59:59+08:00', factor: 0.5, note: '新模型上线 5 折' }] },
  { key: 'glm-5-3', label: 'glm-5.3（glm-latest）', input: 4.5, output: 4.5 },
  { key: 'doubao-seed-2-1-turbo', label: 'doubao-seed-2.1-turbo', input: 2.5, output: 2.5 },
  { key: 'doubao-seed-evolving', label: 'doubao-seed-evolving', input: 2.5, output: 2.5 },
  { key: 'minimax-m3', label: 'minimax-m3', input: 2.5, output: 2.5 },
  { key: 'kimi-k2-7-code', label: 'kimi-k2.7-code', input: 4.5, output: 4.5 },
  { key: 'kimi-k2-8-preview', label: 'kimi-k2.8-preview', input: 8, output: 8, activities: [{ from: '2026-09-17T00:00:00+08:00', to: '2026-09-30T23:59:59+08:00', factor: 0.6, note: '限时 6 折' }] },
  { key: 'deepseek-v4-1-flash', label: 'deepseek-v4.1-flash', input: 2.5, output: 2.5, activities: [{ from: '2026-09-15T00:00:00+08:00', to: '2026-09-28T23:59:59+08:00', factor: 0.4, note: '实测有效系数 1.0' }] },
  { key: 'deepseek-v4-pro', label: 'deepseek-v4-pro', input: 5.5, output: 5.5 },
  { key: 'kimi-k3', label: 'kimi-k3', input: 10, output: 10 },
  { key: 'doubao-embedding-vision', label: 'doubao-embedding-vision（向量化）', input: 0.5, output: 0.5 },
]

/** 模型名归一化：小写、点/下划线换成连字符（doubao-seed-2.0-mini -> doubao-seed-2-0-mini）。 */
function normalizeModelKey(name) {
  return String(name === null || name === undefined ? '' : name).toLowerCase().replace(/[._]/g, '-')
}

function activityFactorAt(activities, ms) {
  if (!Array.isArray(activities)) return { factor: 1, note: '' }
  for (let index = 0; index < activities.length; index += 1) {
    const item = activities[index]
    const from = new Date(item.from).getTime()
    const to = new Date(item.to).getTime()
    if (ms >= from && ms <= to) return { factor: Number(item.factor), note: String(item.note === undefined ? '' : item.note) }
  }
  return { factor: 1, note: '' }
}

/** 解析这次调用的 AFP 抵扣系数（先用户覆盖，再内置表按最长前缀匹配，最后兜底）。 */
function afpCoefFor(provider, model, ms) {
  const user = (config.afpCoefs !== null && typeof config.afpCoefs === 'object' && !Array.isArray(config.afpCoefs))
    ? config.afpCoefs
    : {}
  const key = normalizeModelKey(model)
  const exact = normalizeModelKey(String(provider) + '/' + String(model))
  const lookup = function (table) {
    if (Object.prototype.hasOwnProperty.call(table, exact)) return table[exact]
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key]
    let best = null
    let bestKey = ''
    const keys = Object.keys(table)
    for (let index = 0; index < keys.length; index += 1) {
      const candidate = normalizeModelKey(keys[index])
      if (candidate.length === 0) continue
      if (key.indexOf(candidate) !== 0) continue
      if (best === null || candidate.length > bestKey.length) {
        best = table[keys[index]]
        bestKey = candidate
      }
    }
    return best
  }

  const override = lookup(user)
  if (override !== null && override !== undefined) {
    const input = Number(override.input)
    const output = Number(override.output === undefined ? override.input : override.output)
    return {
      key: key, label: key, source: 'user',
      input: Number.isFinite(input) ? input : 0,
      output: Number.isFinite(output) ? output : 0,
      factor: 1, note: '',
    }
  }

  let best = null
  for (let index = 0; index < BUILTIN_AFP_COEFS.length; index += 1) {
    const row = BUILTIN_AFP_COEFS[index]
    if (row.key.length === 0) continue
    if (key.indexOf(row.key) !== 0) continue
    if (best === null || row.key.length > best.key.length) best = row
  }
  if (best === null) {
    const fallback = Number(config.afpDefaultCoef)
    return {
      key: key, label: key, source: 'default',
      input: Number.isFinite(fallback) ? fallback : 2.5,
      output: Number.isFinite(fallback) ? fallback : 2.5,
      factor: 1, note: '内置表没有这个模型，按默认系数兜底',
    }
  }
  const activity = activityFactorAt(best.activities, ms)
  return {
    key: best.key,
    label: best.label,
    source: 'builtin',
    input: best.input * activity.factor,
    output: best.output * activity.factor,
    factor: activity.factor,
    note: activity.note,
  }
}

/** 一次调用的 AFP 消耗：文本模型公式，输入 token 含缓存三种。 */
function afpOfCall(provider, model, usage, ms) {
  const coef = afpCoefFor(provider, model, ms)
  const input = (Number(usage.cacheReadTokens) || 0) + (Number(usage.inputTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
  const output = Number(usage.outputTokens) || 0
  const value = (input * coef.input + output * coef.output) / 10000
  return { coef: coef, input: input, output: output, value: Math.round(value * 1e6) / 1e6 }
}

function priceEntryFor(provider, model) {
  const table = config.prices
  const exact = String(provider) + '/' + String(model)
  const plain = String(model)
  if (Object.prototype.hasOwnProperty.call(table, exact)) return { key: exact, match: 'exact', entry: table[exact] }
  if (Object.prototype.hasOwnProperty.call(table, plain)) return { key: plain, match: 'model', entry: table[plain] }
  if (Object.prototype.hasOwnProperty.call(BUILTIN_PRICES, exact)) return { key: exact, match: 'builtin', entry: BUILTIN_PRICES[exact] }
  if (Object.prototype.hasOwnProperty.call(BUILTIN_PRICES, plain)) return { key: plain, match: 'builtin', entry: BUILTIN_PRICES[plain] }
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
  bucket.quota += Number(row.quota) || 0
}

function mergeBucketInto(target, source) {
  target.calls += source.calls
  target.cost += source.cost
  target.hit += source.hit
  target.miss += source.miss
  target.write += source.write
  target.out += source.out
  target.offPeakCalls += source.offPeakCalls
  target.quota += Number(source.quota) || 0
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

/* ---------------- 子会话归属 ----------------
 * 侧边对话（better-sidebar）与子代理（subagent）都在**子会话**里跑模型调用：
 * 会话头写着 parentSession，而 llm/stream 上报的是子会话自己的会话 id，
 * 于是花费落在另一个桶里、看起来"没算进主对话"。
 * 这里把子会话的花费在**读取时**并进其根祖先会话：聚合本身仍按真实会话记录，
 * 所以历史数据不受影响、开关能立即生效。
 */

const ownerCache = new Map()

/** 会话头里的父会话 id；查不到（会话不在活注册表里）返回 null。 */
function sessionParentOf(sessionId) {
  const sessions = hostCtx === null ? undefined : hostCtx.get('sessions')
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return null
  try {
    const session = sessions.get(sessionId)
    const header = (session !== null && typeof session === 'object') ? session.header : undefined
    const parent = (header !== null && typeof header === 'object') ? header.parentSession : undefined
    return (typeof parent === 'string' && parent.length > 0) ? parent : null
  } catch (error) {
    return null
  }
}

/** 沿 parentSession 上溯到根会话；有环或查不到就停在当前层。 */
function ownerSessionOf(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return sessionId
  const cached = ownerCache.get(sessionId)
  if (cached !== undefined) return cached
  let owner = sessionId
  let current = sessionId
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = sessionParentOf(current)
    if (parent === null || parent === current || parent === owner) break
    owner = parent
    current = parent
  }
  ownerCache.set(sessionId, owner)
  return owner
}

function forgetOwnerCache() { ownerCache.clear() }

function pruneLineage() {
  const keys = Object.keys(lineage)
  if (keys.length <= MAX_LINEAGE) return
  const list = []
  for (let index = 0; index < keys.length; index += 1) list.push({ key: keys[index], at: lineage[keys[index]].at })
  list.sort(function (left, right) { return left.at - right.at })
  const excess = list.length - MAX_LINEAGE
  for (let index = 0; index < excess; index += 1) delete lineage[list[index].key]
}

/** 记下"这个子会话属于谁"，供读取时归并（活会话消失后仍有效）。 */
function rememberLineage(sessionId, owner, ms) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  if (typeof owner !== 'string' || owner.length === 0 || owner === sessionId) return
  lineage[sessionId] = { owner: owner, at: ms }
  pruneLineage()
}

function lineageCopy() {
  const out = {}
  const keys = Object.keys(lineage)
  for (let index = 0; index < keys.length; index += 1) {
    out[keys[index]] = { owner: lineage[keys[index]].owner, at: lineage[keys[index]].at }
  }
  return out
}


/** 会话日志第一行（就是会话 header）；只解压最前面的 1-4 帧。 */
function sessionLogHeaderLine(file) {
  let buffer = null
  try {
    buffer = readFileSync(file)
  } catch (error) {
    return ''
  }
  let text = ''
  let from = 0
  for (let frame = 0; frame < MAX_ADOPT_FRAMES; frame += 1) {
    const start = buffer.indexOf(ZSTD_MAGIC, from)
    if (start === -1) break
    const next = buffer.indexOf(ZSTD_MAGIC, start + 4)
    const end = next === -1 ? buffer.length : next
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch (error) {
      break
    }
    from = end
    if (text.indexOf('\n') !== -1) break
  }
  const cut = text.indexOf('\n')
  return cut === -1 ? text : text.slice(0, cut)
}

/**
 * 从会话日志里补出历史子会话的归属。
 *
 * 有界且尽力而为：只针对账本里出现过、且尚无 lineage 的会话，最多查
 * MAX_ADOPT_SESSIONS 个；读不到就跳过，绝不影响载入。会话日志布局是 harness 的
 * 内部实现（<DSH_HOME>/sessions/<工作区>/<会话 id>/session.v3.jsonl.zstd），
 * 所以整段包在 try/catch 里，出问题只是退化为「不收养」。
 */
function adoptHistoryChildren() {
  if (config.mergeChildSessions !== true) return
  const sessionsDir = pathJoin(resolveDshHome(), 'sessions')
  let workspaces = []
  try {
    workspaces = readdirSync(sessionsDir)
  } catch (error) {
    return
  }
  if (!Array.isArray(workspaces) || workspaces.length === 0) return
  const keys = Object.keys(bySession)
  let adopted = 0
  for (let index = 0; index < keys.length && index < MAX_ADOPT_SESSIONS; index += 1) {
    const sessionId = keys[index]
    if (lineage[sessionId] !== undefined) continue
    let parent = null
    for (let space = 0; space < workspaces.length && parent === null; space += 1) {
      const file = pathJoin(pathJoin(pathJoin(sessionsDir, workspaces[space]), sessionId), 'session.v3.jsonl.zstd')
      const line = sessionLogHeaderLine(file)
      if (line.length < 2 || line.charAt(0) !== '{') continue
      try {
        const record = JSON.parse(line)
        const found = (record !== null && typeof record === 'object') ? record.parentSession : undefined
        if (typeof found === 'string' && found.length > 0 && found !== sessionId) parent = found
        else parent = ''
      } catch (error) {
        parent = ''
      }
    }
    if (parent === null || parent.length === 0) continue
    lineage[sessionId] = { owner: parent, at: new Date().getTime() }
    adopted += 1
  }
  if (adopted > 0) {
    pruneLineage()
    logInfo('store: adopted ' + String(adopted) + ' historical child session(s) from session logs')
    scheduleSave()
  }
}

function readLineage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
  const keys = Object.keys(raw).slice(0, 500)
  for (let index = 0; index < keys.length; index += 1) {
    const entry = raw[keys[index]]
    if (entry === null || typeof entry !== 'object') continue
    const owner = entry.owner
    if (typeof owner !== 'string' || owner.length === 0) continue
    const at = Number(entry.at)
    const child = String(keys[index]).slice(0, 120)
    if (lineage[child] === undefined) {
      lineage[child] = { owner: owner.slice(0, 120), at: Number.isFinite(at) ? at : 0 }
    }
  }
  pruneLineage()
}

/** 活会话注册表里的 父 -> 直系子 映射（覆盖升级前就存在的子会话）。 */
function liveChildrenMap() {
  const map = {}
  const sessions = hostCtx === null ? undefined : hostCtx.get('sessions')
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return map
  try {
    const list = sessions.list()
    if (!Array.isArray(list)) return map
    for (let index = 0; index < list.length; index += 1) {
      const session = list[index]
      const header = (session !== null && typeof session === 'object') ? session.header : undefined
      if (header === null || typeof header !== 'object') continue
      const parent = header.parentSession
      const id = header.id
      if (typeof parent !== 'string' || parent.length === 0) continue
      if (typeof id !== 'string' || id.length === 0 || id === parent) continue
      if (map[parent] === undefined) map[parent] = []
      map[parent].push(id)
    }
  } catch (error) {
    /* 拿不到活会话就只用已记录的 lineage */
  }
  return map
}

/** 某会话的全部后代（已记录的 lineage ∪ 活会话直系），上限 100 个。 */
function descendantSessionsOf(ownerSessionId) {
  const out = []
  if (typeof ownerSessionId !== 'string' || ownerSessionId.length === 0) return out
  const live = liveChildrenMap()
  const seen = {}
  seen[ownerSessionId] = true
  const queue = [ownerSessionId]
  while (queue.length > 0 && out.length < 100) {
    const current = queue.shift()
    const direct = []
    const keys = Object.keys(lineage)
    for (let index = 0; index < keys.length; index += 1) {
      if (lineage[keys[index]].owner === current) direct.push(keys[index])
    }
    const fromLive = live[current]
    if (Array.isArray(fromLive)) {
      for (let index = 0; index < fromLive.length; index += 1) direct.push(fromLive[index])
    }
    for (let index = 0; index < direct.length; index += 1) {
      const child = direct[index]
      if (seen[child] === true || child === ownerSessionId) continue
      seen[child] = true
      out.push(child)
      queue.push(child)
    }
  }
  return out
}

/** 读取时归并：本会话 + 其子会话。 */
function mergeOwnerView(sessionId) {
  if (sessionId === null) return { bucket: bucketCopy(totals), children: [], ownerSessionId: null }
  const ownerId = ownerSessionOf(sessionId)
  const out = bySession[ownerId] === undefined ? emptyBucket() : bucketCopy(bySession[ownerId])
  const children = []
  if (config.mergeChildSessions !== true) return { bucket: out, children: children, ownerSessionId: ownerId }
  const childIds = descendantSessionsOf(ownerId)
  for (let index = 0; index < childIds.length; index += 1) {
    const childId = childIds[index]
    const childBucket = bySession[childId]
    if (childBucket === undefined) continue
    children.push({ sessionId: childId, bucket: bucketCopy(childBucket) })
    mergeBucketInto(out, childBucket)
  }
  children.sort(function (left, right) { return right.bucket.cost - left.bucket.cost })
  return { bucket: out, children: children, ownerSessionId: ownerId }
}

/** 单次口径：本会话与其子会话里最近收口的那一轮。 */
function lastTurnMerged(sessionId) {
  if (config.mergeChildSessions !== true) return lastTurnView(sessionId)
  const ownerId = ownerSessionOf(sessionId)
  let bestKey = lastTurns[ownerId] !== undefined ? ownerId : null
  let bestEntry = bestKey === null ? null : lastTurns[ownerId]
  const childIds = descendantSessionsOf(ownerId)
  for (let index = 0; index < childIds.length; index += 1) {
    const entry = lastTurns[childIds[index]]
    if (entry === undefined) continue
    if (bestEntry === null || entry.at > bestEntry.at) {
      bestEntry = entry
      bestKey = childIds[index]
    }
  }
  if (bestEntry === null || bestKey === null) return lastTurnView(sessionId)
  return {
    sessionId: bestKey,
    at: bestEntry.at,
    atText: stamp(bestEntry.at),
    turn: bestEntry.turn,
    calls: bestEntry.bucket.calls,
    cost: bestEntry.bucket.cost,
    hit: bestEntry.bucket.hit,
    miss: bestEntry.bucket.miss,
    write: bestEntry.bucket.write,
    out: bestEntry.bucket.out,
    offPeakCalls: bestEntry.bucket.offPeakCalls,
    quota: Number(bestEntry.bucket.quota) || 0,
  }
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
  const ownerSessionId = sessionId === null ? null : ownerSessionOf(sessionId)
  if (sessionId !== null && ownerSessionId !== null) rememberLineage(sessionId, ownerSessionId, ms)
  rememberActiveModel(sessionId, meta.provider, meta.model, ms)
  const quotaBased = isQuotaProfile(meta.provider, meta.model)
  // 套餐制：按官方 AFP 抵扣系数算额度，不按 token 估比率。
  const afp = quotaBased === true ? afpOfCall(meta.provider, meta.model, usage, ms) : null
  const row = {
    seq: (counter += 1),
    ts: ms,
    day: dayKey(ms),
    time: stamp(ms),
    provider: meta.provider,
    model: meta.model,
    key: String(meta.provider) + '/' + String(meta.model),
    sessionId: sessionId,
    ownerSessionId: ownerSessionId,
    purpose: (meta.purpose === null || meta.purpose === undefined) ? null : String(meta.purpose),
    hit: usage.cacheReadTokens,
    miss: usage.inputTokens,
    write: usage.cacheWriteTokens,
    out: usage.outputTokens,
    reasoning: usage.reasoningTokens,
    offPeak: offPeak,
    // 套餐制（预付费额度）模型不计钱：cost 记 0，额度消耗记在 quota 上。
    quota: afp === null ? 0 : afp.value,
    quotaBased: quotaBased === true,
    /** 这一次用的 AFP 抵扣系数（设置页会展示，方便对账）。 */
    afpInput: afp === null ? 0 : afp.coef.input,
    afpOutput: afp === null ? 0 : afp.coef.output,
    cost: quotaBased === true
      ? 0
      : (usage.cacheReadTokens * rate.cacheHit
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
      quota: Number(entry.bucket.quota) || 0,
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
  const merged = mergeOwnerView(sessionId)
  const sessionBucket = merged.bucket
  const known = Object.keys(byModel)
  const priceKeys = Object.keys(config.prices)
  for (let index = 0; index < priceKeys.length; index += 1) {
    if (known.indexOf(priceKeys[index]) === -1) known.push(priceKeys[index])
  }
  // 余额按「这个会话最近一次调用的供应商」走；档位一变，旧数字立刻作废。
  const balanceProfile = resolveBalanceProfile(sessionId)
  const balanceProfileKey = balanceProfileKeyOf(balanceProfile)
  const shownBalance = balance.profileKey === balanceProfileKey ? balance : pendingBalanceFor(balanceProfile)
  if (config.enabled === true && config.showBalance === true) kickBalance(false, balanceProfile)
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
      mergeChildSessions: config.mergeChildSessions,
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
    /** 套餐制（额度）口径：前端据此把 ¥ 换成「单次/本对话 AFP + 各窗口剩余」。 */
    quota: {
      muted: balanceProfile !== null && balanceProfile !== undefined && String(balanceProfile.kind) === 'ark-plan',
      /** 当前会话最近一次方舟调用的 AFP 抵扣系数（含活动折扣）。 */
      coef: (function () {
        const active = activeModelOf(sessionId)
        if (active === null || active === undefined) return null
        if (isQuotaProfile(active.provider, active.model) !== true) return null
        const resolved = afpCoefFor(active.provider, active.model, new Date().getTime())
        return {
          model: String(active.model),
          key: resolved.key,
          label: resolved.label,
          source: resolved.source,
          input: resolved.input,
          output: resolved.output,
          factor: resolved.factor,
          note: resolved.note,
        }
      })(),
      /** 设置页展示的系数表：内置表 + 用户覆盖 + 账本里出现过的方舟模型。 */
      coefs: (function () {
        const seen = {}
        for (let index = 0; index < BUILTIN_AFP_COEFS.length; index += 1) {
          const row = BUILTIN_AFP_COEFS[index]
          seen[row.key] = { key: row.key, label: row.label, input: row.input, output: row.output, source: 'builtin', factor: 1, note: '' }
        }
        const user = (config.afpCoefs !== null && typeof config.afpCoefs === 'object' && !Array.isArray(config.afpCoefs)) ? config.afpCoefs : {}
        const userKeys = Object.keys(user)
        for (let index = 0; index < userKeys.length; index += 1) {
          const key = userKeys[index]
          const normalized = normalizeModelKey(key)
          seen[normalized] = {
            key: normalized,
            label: key,
            input: Number(user[key].input) || 0,
            output: Number(user[key].output === undefined ? user[key].input : user[key].output) || 0,
            source: 'user', factor: 1, note: '你的覆盖值',
          }
        }
        const modelKeys = Object.keys(byModel)
        const now = new Date().getTime()
        for (let index = 0; index < modelKeys.length; index += 1) {
          const key = modelKeys[index]
          const parts = String(key).split('/')
          const provider = parts.length > 1 ? parts[0] : ''
          const model = parts.length > 1 ? parts.slice(1).join('/') : String(key)
          if (isQuotaProfile(provider, model) !== true) continue
          const resolved = afpCoefFor(provider, model, now)
          const bucket = byModel[key]
          const existing = seen[resolved.key]
          seen[resolved.key] = {
            key: resolved.key,
            label: resolved.label === resolved.key && existing !== undefined ? existing.label : resolved.label,
            input: resolved.input,
            output: resolved.output,
            source: resolved.source,
            factor: resolved.factor,
            note: resolved.note,
            models: (existing !== undefined && Array.isArray(existing.models) ? existing.models : []).concat([model]),
            quota: (existing !== undefined ? Number(existing.quota) || 0 : 0) + (Number(bucket.quota) || 0),
            calls: (existing !== undefined ? Number(existing.calls) || 0 : 0) + (Number(bucket.calls) || 0),
          }
        }
        const list = []
        const keys = Object.keys(seen)
        for (let index = 0; index < keys.length; index += 1) list.push(seen[keys[index]])
        list.sort(function (left, right) {
          const leftUsed = Number(left.quota) || 0
          const rightUsed = Number(right.quota) || 0
          if (leftUsed !== rightUsed) return rightUsed - leftUsed
          return String(left.key) < String(right.key) ? -1 : 1
        })
        return list
      })(),
      formula: 'AFP = (输入 token × 输入系数 + 输出 token × 输出系数) / 10,000',
      defaultCoef: Number(config.afpDefaultCoef) || 2.5,
      /** 控制台对账：按系数算出的 AFP vs 控制台快照增量。 */
      reconcile: {
        at: planReconcile.at,
        atText: planReconcile.at > 0 ? stamp(planReconcile.at) : '',
        delta: planReconcile.delta,
        computed: planReconcile.computed,
        ratio: planReconcile.ratio,
        samples: planReconcile.samples,
      },
      remaining: (function () {
        const periods = (balance.quotaPeriods !== undefined && Array.isArray(balance.quotaPeriods)) ? balance.quotaPeriods : []
        const out = []
        for (let index = 0; index < periods.length; index += 1) {
          const period = periods[index]
          const total = Number(period.total) || 0
          const used = Number(period.used) || 0
          out.push({
            label: String(period.label),
            used: used,
            total: total,
            remaining: Math.max(0, total - used),
            percent: Number(period.percent) || 0,
            resetAt: String(period.resetAt === undefined ? '' : period.resetAt),
          })
        }
        return out
      })(),
    },
    balance: shownBalance,
    balanceProfile: {
      providerKey: balanceProfile === null ? '' : balanceProfile.providerKey,
      providerLabel: balanceProfile === null ? '' : balanceProfile.providerLabel,
      label: balanceProfile === null ? '余额' : balanceProfile.label,
      kind: balanceProfile === null ? 'none' : balanceProfile.kind,
      url: balanceProfile === null ? '' : balanceProfile.url,
      credentialRef: balanceProfile === null ? '' : balanceProfile.credentialRef,
      activeProvider: activeModelOf(sessionId) === null ? '' : activeModelOf(sessionId).provider,
      activeModel: activeModelOf(sessionId) === null ? '' : activeModelOf(sessionId).model,
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
    lastTurn: lastTurnMerged(sessionId),
    totals: bucketCopy(totals),
    sessionTotals: bucketCopy(sessionBucket),
    todayTotals: bucketCopy(byDay[todayKey] === undefined ? emptyBucket() : byDay[todayKey]),
    todayKey: todayKey,
    sessionId: sessionId,
    ownerSessionId: merged.ownerSessionId,
    children: merged.children,
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
      mergeChildSessions: config.mergeChildSessions,
      unconfinedBalance: config.unconfinedBalance,
      credentialRef: config.credentialRef,
      balanceUrl: config.balanceUrl,
      balanceProfiles: config.balanceProfiles,
      prices: clonePrices(),
    },
    counter: counter,
    totals: bucketCopy(totals),
    byModel: bucketMapCopy(byModel),
    byDay: bucketMapCopy(byDay),
    bySession: bucketMapCopy(bySession),
    lastTurns: lastTurnMapCopy(),
    lineage: lineageCopy(),
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
  target.quota = num(raw.quota)
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
  readLineage(data.lineage)
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
  seedActiveModelsFromLedger()
  storeReady = true
  logInfo('store: ready at ' + storePath)
  adoptHistoryChildren()
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

/** 跑档位配置的外部命令，返回 stdout（用于只在 CLI 里暴露的能力，如 arkcli）。 */
function runProfileCommand(profile) {
  return new Promise(function (resolve, reject) {
    const command = profile.command
    const file = (command !== null && typeof command === 'object' && typeof command.file === 'string') ? command.file : ''
    const args = (command !== null && typeof command === 'object' && Array.isArray(command.args)) ? command.args.slice(0, 12) : []
    if (file.length === 0) {
      reject(new Error('档位没有配置命令'))
      return
    }
    execFile(file, args, {
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 4194304,
      // 只有「裸命令名」才走 shell：Windows 上 arkcli 是 .cmd 垫片，必须经 shell 才能按名字执行；
      // 而绝对路径（例如测试里用 node 可执行文件）交给 execFile 直接 CreateProcess，反而能正确处理空格。
      shell: process.platform === 'win32' && file.indexOf('/') === -1 && file.indexOf('\\') === -1,
    }, function (error, stdout, stderr) {
      if (error !== null && error !== undefined) {
        const detail = String(stdout || '').trim() || String(stderr || '').trim() || errorText(error)
        reject(new Error(detail.slice(0, 200)))
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

/**
 * 解析 arkcli 的套餐额度 JSON：
 *   { viewer: { user_name, profile, ... },
 *     items: [ { product, edition, tier, subscribed, periods: [ { label, used, total, percent, reset_at } ] } ] }
 * periods[].percent 是 0-100 的**已用百分比**。
 */
function parseArkPlanBody(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  let payload = null
  try { payload = JSON.parse(text) } catch (error) { return null }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const items = Array.isArray(payload.items) ? payload.items : null
  if (items === null) return null
  const viewer = (payload.viewer !== null && typeof payload.viewer === 'object' && !Array.isArray(payload.viewer)) ? payload.viewer : {}

  let chosen = null
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === null || typeof item !== 'object' || item.subscribed !== true) continue
    if (item.product === 'agent-plan') { chosen = item; break }
    if (chosen === null) chosen = item
  }
  if (chosen === null) {
    const first = (items.length > 0 && items[0] !== null && typeof items[0] === 'object') ? items[0] : null
    const message = (first !== null && typeof first.error === 'string' && first.error.length > 0)
      ? first.error
      : '当前账号没有生效的套餐订阅'
    return { ok: false, error: message, quotaText: '', periods: [] }
  }

  const periods = []
  const rawPeriods = Array.isArray(chosen.periods) ? chosen.periods : []
  for (let index = 0; index < rawPeriods.length; index += 1) {
    const period = rawPeriods[index]
    if (period === null || typeof period !== 'object') continue
    const used = Number(period.used)
    const total = Number(period.total)
    const percent = Number(period.percent)
    periods.push({
      label: typeof period.label === 'string' ? period.label : '?',
      used: Number.isFinite(used) ? used : 0,
      total: Number.isFinite(total) ? total : 0,
      percent: Number.isFinite(percent) ? percent : 0,
      resetAt: typeof period.reset_at === 'string' ? period.reset_at : '',
    })
  }
  if (periods.length === 0) return { ok: false, error: '套餐接口没有返回时间窗口', quotaText: '', periods: [] }

  let worst = periods[0]
  for (let index = 1; index < periods.length; index += 1) {
    if (periods[index].percent > worst.percent) worst = periods[index]
  }
  return {
    ok: true,
    error: '',
    // 徽标只放「最紧张的那个窗口」的已用占比，全部窗口留给悬停与设置页
    quotaText: worst.percent.toFixed(2) + '%',
    periods: periods,
    product: typeof chosen.product === 'string' ? chosen.product : '',
    edition: typeof chosen.edition === 'string' ? chosen.edition : '',
    tier: typeof chosen.tier === 'string' ? chosen.tier : '',
    account: typeof viewer.user_name === 'string' ? viewer.user_name : '',
  }
}

/** 解析智谱财务响应：{ code, msg, data: { balance, rechargeAmount, giveAmount, ... } }。 */
function parseBigModelBody(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  let payload = null
  try { payload = JSON.parse(text) } catch (error) { return null }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  if (payload.code === undefined) return null
  const message = typeof payload.msg === 'string' ? payload.msg : ''
  const data = (payload.data !== null && typeof payload.data === 'object' && !Array.isArray(payload.data)) ? payload.data : null
  const hasMoney = data !== null && (typeof data.balance === 'number' || typeof data.availableBalance === 'number' || typeof data.rechargeAmount === 'number')
  if (payload.code !== 200 || hasMoney !== true) {
    return { ok: false, error: message.length > 0 ? message : '财务接口未返回余额', quotaText: '' }
  }
  const toNumber = function (value) {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : 0
  }
  const total = data.balance !== undefined ? toNumber(data.balance) : toNumber(data.availableBalance)
  return {
    at: new Date().getTime(),
    ok: true,
    loading: false,
    error: '',
    isAvailable: true,
    currency: 'CNY',
    total: total,
    granted: toNumber(data.giveAmount),
    toppedUp: toNumber(data.rechargeAmount),
    via: '',
    kind: 'balance',
    quotaText: '',
    spendTotal: toNumber(data.totalSpendAmount),
    frozen: toNumber(data.frozenBalance),
  }
}

/** 解析智谱配额响应：{ code, msg, data: { limits: [{ remaining, number }] } }。 */
function parseQuotaBody(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  let data = null
  try { data = JSON.parse(text) } catch (error) { return null }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  if (data.code === undefined && data.data === undefined) return null
  const message = typeof data.msg === 'string' ? data.msg : ''
  const limits = (data.data !== null && typeof data.data === 'object' && Array.isArray(data.data.limits)) ? data.data.limits : []
  if (data.code !== 200 || limits.length === 0) {
    return { ok: false, error: message.length > 0 ? message : '配额接口未返回可用数据', quotaText: '' }
  }
  const parts = []
  for (let index = 0; index < limits.length; index += 1) {
    const item = limits[index]
    if (item === null || typeof item !== 'object') continue
    const remaining = Number(item.remaining)
    const total = Number(item.number)
    parts.push((Number.isFinite(remaining) ? remaining : 0) + '/' + (Number.isFinite(total) ? total : 0))
  }
  return { ok: true, error: '', quotaText: parts.join(', ') }
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
/* ---------------- 余额来源：按供应商分流 ----------------
 * 余额是**按供应商**的：用 GLM 时不该显示 DeepSeek 的余额。
 * 这里按「会话最近一次调用的 provider/model」选一个档位，再请求它自己的接口。
 *
 * 已核实（2026-09-15，均用 API key 实测通过）：
 *  - DeepSeek：GET https://api.deepseek.com/user/balance（Authorization: Bearer）
 *    → { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *  - 智谱 BigModel（控制台财务接口，按量账户可用）：
 *      GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report
 *      Authorization: <裸 key>（Bearer 亦可）
 *      → { code: 200, data: { balance, rechargeAmount, giveAmount, totalSpendAmount, frozenBalance } }
 *      实测返回 balance=19.94 / rechargeAmount=20 / giveAmount=0。
 *      （简化版：/api/biz/account/getAccountBalance 只返回一个数字。）
 *  - 智谱 Coding Plan 配额（可选）：GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *      → { code, msg, data: { limits: [{ remaining, number }] } }；按量账号会返回
 *      {"code":500,"msg":"当前用户不存在coding plan"}。需要时可把档位 kind 改成 zhipu-quota。
 *
 * 用户可在 config.balanceProfiles 里按 provider（或其前缀）覆盖 / 新增档位。
 */
const BUILTIN_BALANCE_PROFILES = {
  'deepseek-official': {
    providerKey: 'deepseek-official', providerLabel: 'DeepSeek', label: '余额', kind: 'deepseek',
    url: 'https://api.deepseek.com/user/balance', credentialRef: 'DEEPSEEK_API_KEY',
  },
  'deepseek': {
    providerKey: 'deepseek', providerLabel: 'DeepSeek', label: '余额', kind: 'deepseek',
    url: 'https://api.deepseek.com/user/balance', credentialRef: 'DEEPSEEK_API_KEY',
  },
  'zai-coding-cn': {
    providerKey: 'zai-coding-cn', providerLabel: 'BigModel GLM', label: '余额', kind: 'bigmodel',
    url: 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report', credentialRef: 'BIGMODEL_API_KEY',
  },
  'bigmodel': {
    providerKey: 'bigmodel', providerLabel: 'BigModel GLM', label: '余额', kind: 'bigmodel',
    url: 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report', credentialRef: 'BIGMODEL_API_KEY',
  },
  'open.bigmodel.cn': {
    providerKey: 'open.bigmodel.cn', providerLabel: 'BigModel GLM', label: '余额', kind: 'bigmodel',
    url: 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report', credentialRef: 'BIGMODEL_API_KEY',
  },
  // 火山方舟 Agent Plan（baseURL .../api/plan/v3）：套餐额度制，没有金额余额可查，
  // 走本机的 arkcli（同一份 SSO 登录）取 quota 快照。
  // 其它方舟 provider（例如按量 platform）不在内置表里，可用 config.balanceProfiles 单配。
  'volc-ark-coding': {
    providerKey: 'volc-ark-coding', providerLabel: '火山方舟 Agent Plan', label: '套餐额度', kind: 'ark-plan',
    url: '', credentialRef: '',
    command: { file: 'arkcli', args: ['usage', 'plan', '--format', 'json'] },
  },
}

/** 会话 -> 最近一次调用的 provider/model，决定这个会话显示谁的余额。 */
const activeModels = {}
let lastActiveModel = null

/**
 * 从账本回填「每个会话最近一次调用的 provider/model」。
 *
 * 不回填的话，重启后 activeModels 是空的，所有会话都会落到「全局最后一次调用」，
 * 于是用 GLM 的旧会话会先显示 DeepSeek 的余额，直到它自己再发起一次调用。
 */
function seedActiveModelsFromLedger() {
  let newest = null
  for (let index = 0; index < ledger.length; index += 1) {
    const row = ledger[index]
    if (row === null || typeof row !== 'object') continue
    const entry = { provider: String(row.provider), model: String(row.model), at: Number(row.ts) || 0 }
    if (newest === null || entry.at >= newest.at) newest = entry
    if (typeof row.sessionId !== 'string' || row.sessionId.length === 0) continue
    const existing = activeModels[row.sessionId]
    if (existing !== undefined && existing.at >= entry.at) continue
    activeModels[row.sessionId] = entry
  }
  if (newest !== null) lastActiveModel = newest
}

function rememberActiveModel(sessionId, provider, model, ms) {
  const entry = { provider: String(provider), model: String(model), at: ms }
  lastActiveModel = entry
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  activeModels[sessionId] = entry
  const keys = Object.keys(activeModels)
  if (keys.length <= MAX_ACTIVE_MODELS) return
  const list = []
  for (let index = 0; index < keys.length; index += 1) list.push({ key: keys[index], at: activeModels[keys[index]].at })
  list.sort(function (left, right) { return left.at - right.at })
  const excess = list.length - MAX_ACTIVE_MODELS
  for (let index = 0; index < excess; index += 1) delete activeModels[list[index].key]
}

function activeModelOf(sessionId) {
  if (typeof sessionId === 'string' && activeModels[sessionId] !== undefined) return activeModels[sessionId]
  return lastActiveModel
}

/** 按 provider 精确 -> provider 前缀 -> 模型名前缀 选余额档位；找不到返回 null。 */
function resolveBalanceProfileFrom(providerInput, modelInput) {
  const user = (config.balanceProfiles !== null && typeof config.balanceProfiles === 'object' && !Array.isArray(config.balanceProfiles))
    ? config.balanceProfiles
    : {}
  const provider = providerInput === null || providerInput === undefined ? '' : String(providerInput)
  const model = modelInput === null || modelInput === undefined ? '' : String(modelInput)

  const exact = function (table) {
    if (provider.length === 0) return null
    return Object.prototype.hasOwnProperty.call(table, provider) ? table[provider] : null
  }
  const byPrefix = function (table) {
    if (provider.length === 0) return null
    const keys = Object.keys(table)
    let best = null
    for (let index = 0; index < keys.length; index += 1) {
      if (keys[index].length === 0) continue
      if (provider.indexOf(keys[index]) !== 0) continue
      if (best === null || keys[index].length > best.length) best = keys[index]
    }
    return best === null ? null : table[best]
  }

  const matched = exact(user) || byPrefix(user) || exact(BUILTIN_BALANCE_PROFILES) || byPrefix(BUILTIN_BALANCE_PROFILES)
  if (matched !== null && matched !== undefined) {
    // 兼容旧配置：用户改过全局「默认余额接口」时，DeepSeek 系供应商沿用它的地址与凭据
    // （常见于走代理或换了 key）。**只对 DeepSeek 系生效** —— 让别的供应商也用这个地址，
    // 正是「用 GLM 却显示 DeepSeek 余额」那个问题。
    const customizedDefault = typeof config.balanceUrl === 'string'
      && config.balanceUrl.length > 0
      && config.balanceUrl !== DEFAULT_BALANCE_URL
    if (customizedDefault && String(matched.providerKey).indexOf('deepseek') === 0) {
      return {
        providerKey: matched.providerKey,
        providerLabel: matched.providerLabel,
        label: matched.label,
        kind: 'auto',
        url: config.balanceUrl,
        credentialRef: (typeof config.credentialRef === 'string' && config.credentialRef.length > 0)
          ? config.credentialRef
          : matched.credentialRef,
      }
    }
    return matched
  }

  const lower = model.toLowerCase()
  if (lower.indexOf('glm') === 0) return BUILTIN_BALANCE_PROFILES['zai-coding-cn']
  if (lower.indexOf('deepseek') === 0) return BUILTIN_BALANCE_PROFILES['deepseek-official']

  // 只有用户显式改过默认余额地址时，才把它当作兜底档位（否则会把 DeepSeek 的数字
  // 显示给别的供应商 —— 那正是这个功能要修的问题）。
  if (typeof config.balanceUrl === 'string' && config.balanceUrl.length > 0 && config.balanceUrl !== DEFAULT_BALANCE_URL) {
    return {
      providerKey: provider.length > 0 ? provider : 'default',
      providerLabel: provider.length > 0 ? provider : '默认',
      label: '余额', kind: 'auto',
      url: config.balanceUrl,
      credentialRef: config.credentialRef,
    }
  }
  return null
}

/** 会话版本：用该会话最近一次调用的 provider/model。 */
function resolveBalanceProfile(sessionId) {
  const active = activeModelOf(sessionId)
  return resolveBalanceProfileFrom(
    active === null || active === undefined ? '' : active.provider,
    active === null || active === undefined ? '' : active.model,
  )
}

/** 这次调用是不是套餐制（额度计量）provider。 */
function isQuotaProfile(provider, model) {
  const profile = resolveBalanceProfileFrom(provider, model)
  return profile !== null && profile !== undefined && String(profile.kind) === 'ark-plan'
}

/** 上次额度快照之后、按系数算出来的 AFP 合计（对账用）。 */
function afpSinceSeq(seq) {
  let afp = 0
  for (let index = 0; index < ledger.length; index += 1) {
    const row = ledger[index]
    if (row.seq <= seq) continue
    if (row.quotaBased !== true) continue
    afp += Number(row.quota) || 0
  }
  return afp
}

/** 用新快照对账：控制台增量 vs 按系数算出来的 AFP。
 *
 * 控制台是**延迟**出账的：某一刻取快照可能看不到任何增量，而这段时间的额度是真实
 * 消耗掉的。所以只有「真的看到一次增量」时才推进基准 `planSeenSeq`；没看到增量就
 * 保留基准，把这段 AFP 攒到下一次增量里一起比 —— 这样比值才是同一段区间的。
 * 比值稳定在 1 附近说明系数表还对；明显偏离就说明官方改了系数（设置页会显示）。 */
function observePlanPeriods(periods) {
  let delta = 0
  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index]
    const prev = planSeenUsed[period.label]
    if (planSeenReady === true && typeof prev === 'number' && period.used > prev) {
      delta = Math.max(delta, period.used - prev)
    }
    planSeenUsed[period.label] = period.used
  }
  const computed = afpSinceSeq(planSeenSeq)
  if (planSeenReady !== true) {
    planSeenReady = true
    planSeenSeq = counter
    return
  }
  if (delta > 0 && computed > 0) {
    planReconcile = {
      at: new Date().getTime(),
      delta: delta,
      computed: Math.round(computed * 1e6) / 1e6,
      ratio: Math.round((delta / computed) * 1e4) / 1e4,
      samples: planReconcile.samples + 1,
    }
    planSeenSeq = counter
    logInfo('afp reconcile: 控制台 +' + delta.toFixed(4) + ' AFP / 本插件 +' + computed.toFixed(4) + ' AFP = ' + planReconcile.ratio.toFixed(4))
  }
}

function balanceProfileKeyOf(profile) {
  if (profile === null || profile === undefined) return '(none)'
  return String(profile.providerKey) + '|' + String(profile.kind) + '|' + String(profile.url)
}

/** 档位切换时展示的占位：不显示上一个档位的数字。 */
function pendingBalanceFor(profile) {
  const providerKey = profile === null || profile === undefined ? '' : String(profile.providerKey)
  const providerLabel = profile === null || profile === undefined ? '' : String(profile.providerLabel)
  return {
    at: 0, ok: false, loading: true, error: '',
    isAvailable: null, currency: '', total: 0, granted: 0, toppedUp: 0, via: '',
    profileKey: balanceProfileKeyOf(profile),
    kind: profile === null || profile === undefined ? 'none' : String(profile.kind),
    label: profile === null || profile === undefined ? '余额' : String(profile.label),
    quotaText: '',
    quotaPeriods: [],
    providerKey: providerKey,
    providerLabel: providerLabel,
  }
}

/**
 * 取一次某个档位的余额 / 配额。
 * 凭据按 env → credentials 服务 → .credentials.yaml 依次尝试；密钥只进请求头。
 */
async function fetchBalance(profile) {
  const hasProfile = profile !== null && profile !== undefined
  const providerKey = hasProfile ? String(profile.providerKey) : ''
  const providerLabel = hasProfile ? String(profile.providerLabel) : '未知供应商'
  const kind = hasProfile ? String(profile.kind) : 'none'
  const label = hasProfile ? String(profile.label) : '余额'
  const next = {
    at: new Date().getTime(), ok: false, loading: false, error: '',
    isAvailable: null, currency: '', total: 0, granted: 0, toppedUp: 0, via: '',
    profileKey: balanceProfileKeyOf(profile), kind: kind, label: label, quotaText: '',
    providerKey: providerKey, providerLabel: providerLabel,
  }
  const failed = function (message) {
    lastBalanceOk = false
    logError('balance failed [' + providerKey + ']: ' + message)
    next.error = message
    return next
  }

  if (hasProfile !== true) {
    return failed('当前供应商（' + providerLabel + '）没有配置余额接口')
  }

  // 火山方舟 Agent Plan：套餐额度走本机 CLI，没有 HTTP 接口也没有金额。
  if (kind === 'ark-plan') {
    let stdout = ''
    try {
      stdout = await runProfileCommand(profile)
    } catch (error) {
      return failed(providerLabel + ' 额度查询失败：' + errorText(error))
    }
    const plan = parseArkPlanBody(stdout)
    if (plan === null) {
      return failed(providerLabel + ' 额度输出无法解析：' + stdout.trim().slice(0, 200))
    }
    if (plan.ok !== true) return failed(plan.error)
    next.ok = true
    next.isAvailable = true
    next.kind = 'quota'
    next.quotaText = plan.quotaText
    next.quotaPeriods = plan.periods
    next.planMeta = { product: plan.product, edition: plan.edition, tier: plan.tier, account: plan.account }
    next.via = 'cli:arkcli'
    observePlanPeriods(plan.periods)
    lastBalanceOk = true
    const fingerprint = providerKey + ':plan:' + plan.quotaText
    if (lastBalanceLog !== fingerprint) {
      lastBalanceLog = fingerprint
      logInfo('plan ok (' + providerLabel + '): ' + plan.quotaText + ' · ' + plan.periods.map(function (p) { return p.label + ' ' + p.percent.toFixed(2) + '%' }).join(' / '))
    }
    return next
  }

  let key = ''
  let keySource = 'none'
  const fromEnv = process.env[profile.credentialRef]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    key = fromEnv.trim()
    keySource = 'env'
  }
  if (key.length === 0) {
    const credentials = hostCtx === null ? undefined : hostCtx.get('credentials')
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(profile.credentialRef)
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
    key = credentialFromFile(profile.credentialRef)
    if (key.length > 0) keySource = 'file'
  }
  if (key.length === 0) {
    return failed('找不到凭据 ' + String(profile.credentialRef) + '（env、credentials 服务、.credentials.yaml 都没有）')
  }

  // 智谱控制台接口要裸 key（Bearer 也接受），DeepSeek 要 Bearer。
  const headers = (kind === 'zhipu-quota' || kind === 'bigmodel')
    ? { authorization: key, accept: 'application/json' }
    : { authorization: 'Bearer ' + key, accept: 'application/json' }

  try {
    const response = await fetch(profile.url, { method: 'GET', headers: headers, signal: AbortSignal.timeout(20000) })
    const body = (await response.text()).trim()
    if (response.status !== 200) {
      return failed(providerLabel + ' 接口 HTTP ' + String(response.status) + '：' + body.slice(0, 200))
    }
    if (kind === 'bigmodel' || kind === 'auto') {
      const finance = parseBigModelBody(body)
      if (finance !== null) {
        if (finance.ok !== true) {
          if (kind === 'bigmodel') return failed(finance.error)
        } else {
          finance.profileKey = balanceProfileKeyOf(profile)
          finance.label = label
          finance.providerKey = providerKey
          finance.providerLabel = providerLabel
          finance.via = 'fetch:' + keySource
          lastBalanceOk = true
          const fingerprint = providerKey + ':money:' + String(finance.total)
          if (lastBalanceLog !== fingerprint) {
            lastBalanceLog = fingerprint
            logInfo('balance ok (' + providerLabel + ' via ' + keySource + '): ' + String(finance.total) + ' ' + finance.currency)
          }
          return finance
        }
      } else if (kind === 'bigmodel') {
        return failed(providerLabel + ' 财务接口返回了无法解析的内容：' + body.slice(0, 200))
      }
    }
    if (kind === 'zhipu-quota' || kind === 'auto') {
      const quota = parseQuotaBody(body)
      if (quota !== null) {
        if (quota.ok !== true) return failed(quota.error)
        next.ok = true
        next.isAvailable = true
        // 归一化成 'quota'：客户端据此把数字渲染成「配额 x/y」而不是金额。
        next.kind = 'quota'
        next.quotaText = quota.quotaText
        next.via = 'fetch:' + keySource
        lastBalanceOk = true
        const fingerprint = providerKey + ':' + quota.quotaText
        if (lastBalanceLog !== fingerprint) {
          lastBalanceLog = fingerprint
          logInfo('quota ok (' + providerLabel + ' via ' + keySource + '): ' + quota.quotaText)
        }
        return next
      }
      if (kind === 'zhipu-quota') {
        return failed(providerLabel + ' 配额接口返回了无法解析的内容：' + body.slice(0, 200))
      }
    }
    const parsed = parseBalanceBody(body)
    if (parsed === null) return failed(providerLabel + ' 余额接口返回了无法解析的内容：' + body.slice(0, 200))
    parsed.profileKey = balanceProfileKeyOf(profile)
    parsed.kind = 'balance'
    parsed.label = label
    parsed.quotaText = ''
    parsed.providerKey = providerKey
    parsed.providerLabel = providerLabel
    parsed.via = 'fetch:' + keySource
    lastBalanceOk = true
    const fingerprint = providerKey + ':' + String(parsed.currency) + ':' + String(parsed.total)
    if (lastBalanceLog !== fingerprint) {
      lastBalanceLog = fingerprint
      logInfo('balance ok (' + providerLabel + ' via ' + keySource + '): ' + String(parsed.total) + ' ' + parsed.currency)
    }
    return parsed
  } catch (error) {
    return failed('请求 ' + providerLabel + ' 失败：' + errorText(error))
  }
}

function kickBalance(force, profile) {
  if (config.enabled !== true && force !== true) return Promise.resolve(balance)
  if (config.showBalance !== true && force !== true) return Promise.resolve(balance)
  const profileKey = balanceProfileKeyOf(profile)
  const now = new Date().getTime()
  // 同一档位已经有请求在飞：复用它并**等它完成**，这样「刷新余额」拿到的是新值而不是旧快照。
  if (balanceInflight !== null && balanceInflightKey === profileKey) return balanceInflight
  if (force !== true && balance.profileKey === profileKey && balance.at > 0 && (now - balance.at) < BALANCE_TTL_MS) {
    return Promise.resolve(balance)
  }
  balanceInflightKey = profileKey
  balanceInflight = fetchBalance(profile).then(function (next) {
    balance = next
    balanceInflight = null
    balanceInflightKey = ''
    return balance
  }).catch(function (error) {
    lastBalanceOk = false
    logError('balance unexpected: ' + errorText(error))
    balanceInflight = null
    balanceInflightKey = ''
    balance = pendingBalanceFor(profile)
    balance.ok = false
    balance.loading = false
    balance.at = new Date().getTime()
    balance.error = errorText(error)
    return balance
  })
  return balanceInflight
}

function resetBalance() {
  balance = {
    at: 0, ok: false, loading: false, error: '余额尚未获取',
    isAvailable: null, currency: '', total: 0, granted: 0, toppedUp: 0, via: '',
    profileKey: '', kind: 'balance', label: '余额', quotaText: '', providerLabel: '', providerKey: '',
  }
  balanceInflight = null
  balanceInflightKey = ''
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
  const profiles = input.balanceProfiles
  if (profiles !== null && typeof profiles === 'object' && !Array.isArray(profiles)) {
    const nextProfiles = {}
    const profileKeys = Object.keys(profiles).slice(0, 20)
    for (let index = 0; index < profileKeys.length; index += 1) {
      const key = String(profileKeys[index]).trim().slice(0, 90)
      const entry = profiles[profileKeys[index]]
      if (key.length === 0) continue
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      if (entry === null || typeof entry !== 'object') continue
      const url = typeof entry.url === 'string' && /^https?:\/\//.test(entry.url.trim()) ? entry.url.trim().slice(0, 300) : ''
      const ref = typeof entry.credentialRef === 'string' ? entry.credentialRef.trim().slice(0, 120) : ''
      const kind = (entry.kind === 'deepseek' || entry.kind === 'bigmodel' || entry.kind === 'zhipu-quota' || entry.kind === 'ark-plan' || entry.kind === 'auto') ? entry.kind : 'auto'
      const commandFile = (entry.command !== null && typeof entry.command === 'object' && typeof entry.command.file === 'string') ? entry.command.file.trim().slice(0, 200) : ''
      const commandArgs = (entry.command !== null && typeof entry.command === 'object' && Array.isArray(entry.command.args))
        ? entry.command.args.slice(0, 12).map(function (item) { return String(item).slice(0, 200) })
        : []
      nextProfiles[key] = {
        providerKey: key,
        providerLabel: typeof entry.providerLabel === 'string' && entry.providerLabel.length > 0 ? entry.providerLabel.slice(0, 60) : key,
        label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label.slice(0, 12) : '余额',
        kind: kind,
        url: url,
        credentialRef: ref,
        ...(commandFile.length > 0 ? { command: { file: commandFile, args: commandArgs } } : {}),
      }
    }
    config.balanceProfiles = nextProfiles
    resetBalance()
  }
  if (typeof input.mergeChildSessions === 'boolean' && input.mergeChildSessions !== config.mergeChildSessions) {
    config.mergeChildSessions = input.mergeChildSessions
    forgetOwnerCache()
  }
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
  const incomingCoefs = input.afpCoefs
  if (incomingCoefs !== null && typeof incomingCoefs === 'object' && !Array.isArray(incomingCoefs)) {
    const nextCoefs = {}
    const keys = Object.keys(incomingCoefs).slice(0, MAX_AFP_COEF_KEYS)
    for (let index = 0; index < keys.length; index += 1) {
      const key = String(keys[index]).trim().slice(0, 90)
      if (key.length === 0) continue
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      const entry = incomingCoefs[keys[index]]
      if (entry === null || typeof entry !== 'object') continue
      const coefValue = function (raw) {
        const numeric = Number(raw)
        if (!Number.isFinite(numeric) || numeric < 0) return 0
        return Math.min(numeric, 100000)
      }
      nextCoefs[key] = {
        input: coefValue(entry.input),
        output: coefValue(entry.output === undefined ? entry.input : entry.output),
      }
    }
    config.afpCoefs = nextCoefs
  }
  if (input.afpDefaultCoef !== undefined) {
    const fallback = Number(input.afpDefaultCoef)
    if (Number.isFinite(fallback) && fallback >= 0) config.afpDefaultCoef = Math.min(fallback, 100000)
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
      // 余额是「按供应商」的：必须带上该会话解析出来的档位，否则会去查一个没有档位的供应商。
      const sessionId = readSessionId(args)
      return kickBalance(true, resolveBalanceProfile(sessionId)).then(function () {
        return snapshot(sessionId)
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
