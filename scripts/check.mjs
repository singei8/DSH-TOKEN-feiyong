/**
 * 自测：在没有 DSH 进程的情况下验证两半插件的契约与算法。
 *
 *   node scripts/check.mjs
 *
 * 覆盖：
 *   宿主  apply 后注册 5 条路由；路由只接受 POST + 自定义头；账本记账、
 *         分时计价（高峰/低谷各自单价）、配置保存、清空、node:fs 落盘、
 *         fetch 拉余额（凭据从 .credentials.yaml 读取）。
 *   客户端 lib/client.js 能被 __ModuleLoader__ 加载，导出 name/inject/apply，
 *         注册且只注册 settings.section 与 conversation.composer.dock，
 *         并且不再含动态沙箱遗留（host.call / styles.insert / cordis-panel）。
 *
 * 关键回归：宿主半边不得再依赖按作用域提供的 fs / settings / shell 服务
 * （根级插件 ctx 看不到它们，曾在真实宿主里表现为徽标「存档异常」）。
 *
 * 退出码 0 表示全部通过；任一条失败抛错并以非 0 退出。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let passed = 0
function ok(condition, label) {
  if (!condition) throw new Error('FAIL: ' + label)
  passed += 1
  console.log('  ok  ' + label)
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error('FAIL: ' + label + ' (got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected) + ')')
  }
  passed += 1
  console.log('  ok  ' + label + ' = ' + JSON.stringify(actual))
}
function near(actual, expected, label) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error('FAIL: ' + label + ' (got ' + String(actual) + ', want ' + String(expected) + ')')
  }
  passed += 1
  console.log('  ok  ' + label + ' = ' + String(actual))
}

/* ================================================================== *
 * 0. 隔离的 DSH_HOME 与凭据文件
 * ================================================================== */

const home = mkdtempSync(join(tmpdir(), 'dsh-token-feiyong-'))
const STORE_PATH = join(home, 'token-billing-ledger.json')
mkdirSync(home, { recursive: true })
writeFileSync(
  join(home, '.credentials.yaml'),
  [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: test-key-from-file',
    '  OPENAI_API_KEY: another-key',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: must-not-be-used',
    '',
  ].join('\n'),
  'utf8',
)
process.env.DSH_HOME = home
delete process.env.DEEPSEEK_API_KEY

/* ================================================================== *
 * 1. 宿主半边：真起 HTTP 服务，把路由注册进去
 * ================================================================== */

console.log('\n[host] lib/index.js')

const hostSource = read('lib/index.js')
for (const forbidden of ["hostCtx.get('fs')", "hostCtx.get('settings')", "hostCtx.get('shell')"]) {
  ok(!hostSource.includes(forbidden), 'host half does not read ' + forbidden)
}
ok(hostSource.includes("from 'node:fs'"), 'host half imports node:fs')
ok(hostSource.includes("from 'node:zlib'"), 'host half imports node:zlib for session-log adoption')
ok(hostSource.includes('await fetch(profile.url'), 'host half uses fetch against the resolved balance profile')

const host = await import(new URL('../lib/index.js', import.meta.url).href)
eq(host.name, 'dsh-token-feiyong', 'export name')
eq(typeof host.apply, 'function', 'export apply')

const ROUTES = []
const registered = []
let requestHandler = null
let balanceAuth = ''
let balanceHits = 0
let financeAuth = ''
let financeHits = 0
let quotaAuth = ''
let quotaHits = 0

const server = createServer((request, response) => {
  if (request.url === '/fake-balance') {
    balanceHits += 1
    balanceAuth = String(request.headers.authorization ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '32.31', granted_balance: '5.00', topped_up_balance: '27.31' }],
    }))
    return
  }
  if (request.url === '/fake-bigmodel') {
    financeHits += 1
    financeAuth = String(request.headers.authorization ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    // 形状照抄智谱 /api/biz/account/query-customer-account-report 的实测响应
    response.end(JSON.stringify({
      code: 200, msg: '操作成功', success: true,
      data: { balance: 19.94012911, rechargeAmount: 20, giveAmount: 0, totalSpendAmount: 0.05987089, frozenBalance: 0, creditStatus: 'NOT_OPEN' },
    }))
    return
  }
  if (request.url === '/fake-quota') {
    quotaHits += 1
    quotaAuth = String(request.headers.authorization ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 200, msg: 'success', success: true, data: { limits: [{ remaining: 3, number: 5 }] } }))
    return
  }
  if (requestHandler !== null) requestHandler(request, response)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + String(server.address().port)

const webServer = {
  register(route) {
    ROUTES.push(route)
    return () => {
      const at = ROUTES.indexOf(route)
      if (at !== -1) ROUTES.splice(at, 1)
    }
  },
}

/** 记录插件向 ctx 要过哪些服务：真实根级 ctx 里这些按作用域提供的服务都拿不到。 */
const requestedServices = []
const listeners = {}
const effects = []
/** 假的活会话注册表：子会话的 header.parentSession 指向父会话（侧边对话 / 子代理即如此）。 */
const sessionHeaders = {}
let sessionsAvailable = true
const sessionsStub = {
  get(id) {
    if (sessionsAvailable !== true) return undefined
    const header = sessionHeaders[id]
    return header === undefined ? undefined : { id: id, header: header }
  },
  list() {
    if (sessionsAvailable !== true) return []
    return Object.keys(sessionHeaders).map((id) => ({ id: id, header: sessionHeaders[id] }))
  },
}
const ctx = {
  on(event, callback) { (listeners[event] ??= []).push(callback) },
  get(name) {
    requestedServices.push(name)
    if (name === 'sessions') return sessionsStub
    return undefined
  },
  inject(_services, callback) { callback(ctx) },
  effect(callback, label) { effects.push(label); callback() },
  webServer,
  logger: { info() {}, warn() {} },
}

/** 自检不打真网络：宿主半边的外部 HTTP 一律拦成假响应，本地假服务器照旧放行。
 *  （用例里确实有几处配了「内置 DeepSeek 地址」来验证档位解析，真发出去会偶发
 *  fetch failed，还会把真实余额读进断言里。） */
const realOutboundFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).indexOf(origin) === 0) return realOutboundFetch(url, init)
  const body = JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '32.31' }] })
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }
}

host.apply(ctx, {
  currency: '\u00a5',
  balanceUrl: origin + '/fake-balance',
  credentialRef: 'DEEPSEEK_API_KEY',
})
await new Promise((resolve) => setTimeout(resolve, 50))

eq(ROUTES.length, 5, 'registered route count')
const paths = ROUTES.map((route) => route.path).sort()
eq(paths.join(' '), [
  '/dsh-token-feiyong/balance',
  '/dsh-token-feiyong/reset',
  '/dsh-token-feiyong/save',
  '/dsh-token-feiyong/state',
  '/dsh-token-feiyong/store',
].join(' '), 'route paths')
ok(ROUTES.every((route) => route.kind === 'exact'), 'routes are exact-kind')
ok(effects.some((label) => label.includes('http routes')), 'routes mounted inside ctx.effect')
ok(listeners['llm/stream']?.length === 1, 'llm/stream listener installed')
ok(listeners['api-session/status']?.length === 1, 'api-session/status listener installed')

requestHandler = (request, response) => {
  const route = ROUTES.find((item) => item.path === request.url)
  if (route === undefined) { response.writeHead(404); response.end(); return }
  void route.handler(request, response)
}

/** 走真实 HTTP 调宿主方法，模拟客户端的调用方式。 */
async function call(method, args, options = {}) {
  const headers = { 'content-type': 'application/json' }
  if (options.noHeader !== true) headers['x-dsh-token-feiyong'] = '1'
  const response = await fetch(origin + '/dsh-token-feiyong/' + method, {
    method: options.httpMethod ?? 'POST',
    headers,
    body: options.httpMethod === 'GET' ? undefined : JSON.stringify(args ?? {}),
  })
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = text }
  return { status: response.status, payload }
}

const first = await call('state', { sessionId: 's-test' })
eq(first.status, 200, 'POST state -> 200')
ok(first.payload !== null && typeof first.payload === 'object', 'state returns an object')
eq((await call('state', {}, { noHeader: true })).status, 403, 'missing plugin header -> 403')
eq((await call('state', {}, { httpMethod: 'GET' })).status, 405, 'GET -> 405')

/* ---------------- 记账与分时计价 ---------------- */

function emit(meta, usage) {
  const listener = listeners['llm/stream'][0]
  const stream = (async function* generate() {
    yield { type: 'text', text: 'hello' }
    yield { type: 'usage', usage }
  })()
  return (async () => {
    const relayed = listener(meta, () => stream)
    for await (const _chunk of relayed) { /* drain */ }
  })()
}

const PRO = { provider: 'deepseek-official', model: 'deepseek-v4-pro', sessionId: 's-test' }
const PRO_USAGE = { inputTokens: 500000, outputTokens: 100000, cacheReadTokens: 1000000, cacheWriteTokens: 0, reasoningTokens: 0 }

const RealDate = Date
async function withClock(iso, run) {
  const fixed = new RealDate(iso).getTime()
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args) }
    static now() { return fixed }
  }
  globalThis.Date = FakeDate
  try { return await run() } finally { globalThis.Date = RealDate }
}

// 2026-09-14 是周一：02:00Z = 北京 10:00（高峰），12:00Z = 北京 20:00（低谷）
// 注意 state.rows 是最新在前（最近 25 条），所以新记的一行是 rows[0]。
await withClock('2026-09-14T02:00:00Z', async () => { await emit(PRO, PRO_USAGE) })
let state = (await call('state', { sessionId: 's-test' })).payload
const peakRow = state.rows[0]
eq(peakRow.offPeak, false, 'Monday 10:00 Beijing -> peak')
near(peakRow.cost, 0.3 + 4.5 + 2.7, 'peak cost uses peak rates (0.30/9/27)')

await withClock('2026-09-14T12:00:00Z', async () => { await emit(PRO, PRO_USAGE) })
state = (await call('state', { sessionId: 's-test' })).payload
const offRow = state.rows[0]
eq(offRow.offPeak, true, 'Monday 20:00 Beijing -> off-peak')
near(offRow.cost, 0.15 + 2.25 + 1.35, 'off-peak cost uses off-peak rates (0.15/4.5/13.5)')

// 2026-09-19 是周六：无论几点都是低谷
await withClock('2026-09-19T02:00:00Z', async () => { await emit(PRO, PRO_USAGE) })
state = (await call('state', { sessionId: 's-test' })).payload
eq(state.rows[0].offPeak, true, 'Saturday 10:00 Beijing -> off-peak')

// Flash 档：无专用价目表的模型走 default
const FLASH = { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 's-test' }
const FLASH_USAGE = { inputTokens: 1000000, outputTokens: 500000, cacheReadTokens: 2000000, cacheWriteTokens: 0, reasoningTokens: 0 }
await withClock('2026-09-14T02:00:00Z', async () => { await emit(FLASH, FLASH_USAGE) })
state = (await call('state', { sessionId: 's-test' })).payload
const flashRow = state.rows[0]
eq(flashRow.model, 'deepseek-flash', 'flash row recorded')
near(flashRow.cost, 0.08 + 2 + 4, 'flash peak cost uses default tier (0.04/2/8)')

eq(state.rows.length, 4, 'ledger row count')
eq(state.totals.calls, 4, 'totals.calls')

// 价目表解析：Pro 走专用行（exact），Flash 落到 default 档
const pro = state.byModel.find((entry) => entry.key === 'deepseek-official/deepseek-v4-pro')
ok(pro !== undefined, 'byModel has the Pro entry')
eq(pro.priceKey, 'deepseek-official/deepseek-v4-pro', 'Pro resolves to its own price row')
eq(pro.priceMatch, 'exact', 'Pro price match is exact')
near(pro.pricePeak.cacheHit, 0.3, 'Pro peak cache-hit price')
near(pro.priceOff.output, 13.5, 'Pro off-peak output price')
const flash = state.byModel.find((entry) => entry.key === 'deepseek-official/deepseek-flash')
ok(flash !== undefined, 'byModel has the Flash entry')
eq(flash.priceMatch, 'default', 'Flash falls back to the default tier')
near(flash.pricePeak.cacheMiss, 2, 'Flash peak cache-miss price')

// 单次收口：根级 api-session/status(running=false) 必须关闭本轮
listeners['api-session/status'][0]('s-test', false)
state = await withClock('2026-09-14T12:00:00Z', async () => (await call('state', { sessionId: 's-test' })).payload)
eq(state.lastTurn.calls, 4, 'last turn calls')
near(state.lastTurn.cost, 7.5 + 3.75 + 3.75 + 6.08, 'last turn cost (sum of the 4 recorded calls)')
eq(state.todayTotals.calls, 3, 'today totals only counts the rows of that local day')

/* ---------------- 落盘（node:fs，路径由 DSH_HOME 决定） ---------------- */

eq(state.store.path, STORE_PATH, 'store path resolves under DSH_HOME')
eq(state.store.error, '', 'no store error')

const stored = await call('store', { sessionId: 's-test' })
eq(stored.status, 200, 'POST store -> 200')
ok(existsSync(STORE_PATH), 'ledger written to ' + STORE_PATH)
const payload = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
eq(payload.version, 3, 'store version')
eq(payload.totals.calls, 4, 'store totals.calls')
ok(Array.isArray(payload.rows) && payload.rows.length === 4, 'store rows persisted')

/* ---------------- 可重入：apply 再次执行不得重复计数 ---------------- */

// 场景：补丁热重载（profile 的 patchReload: live）会让同一个模块实例再次 apply，
// 而 ESM 模块在进程内是复用的。若 apply 不复位内存聚合，loadStore 会把账本里的
// 聚合再并入一次，totals 翻倍——实测在真实宿主里出现过 calls 185 -> 382。
host.apply(ctx, {
  currency: '\u00a5',
  balanceUrl: origin + '/fake-balance',
  credentialRef: 'DEEPSEEK_API_KEY',
})
await new Promise((resolve) => setTimeout(resolve, 50))
const afterRemount = (await call('state', { sessionId: 's-test' })).payload
eq(afterRemount.totals.calls, 4, 'second apply does not double count totals')
near(afterRemount.totals.cost, payload.totals.cost, 'second apply does not double count cost')
eq(afterRemount.rows.length, 4, 'second apply keeps rows de-duplicated')
eq(afterRemount.store.path, STORE_PATH, 'second apply keeps the same store path')

/* ---------------- 子会话归属：侧边对话 / 子代理的费用并进主对话 ---------------- */

// 侧边对话与子代理都在**子会话**里跑模型调用：会话头写着 parentSession，
// 而 llm/stream 上报的是子会话自己的会话 id。这里验证归并、开关、以及
// 会话消失后靠存档里的 lineage 继续归并。
sessionHeaders['child-sidechat'] = { id: 'child-sidechat', parentSession: 's-test', origin: 'subagent' }
const CHILD = { provider: 'deepseek-official', model: 'deepseek-v4-pro', sessionId: 'child-sidechat' }

await withClock('2026-09-14T02:00:00Z', async () => { await emit(CHILD, PRO_USAGE) })
await withClock('2026-09-14T02:00:00Z', async () => { await emit(CHILD, PRO_USAGE) })
state = (await call('state', { sessionId: 's-test' })).payload
eq(state.totals.calls, 6, 'totals count the child calls')
eq(state.sessionTotals.calls, 6, 'conversation total merges the child session')
near(state.sessionTotals.cost, 7.5 + 3.75 + 3.75 + 6.08 + 7.5 + 7.5, 'merged conversation cost')
eq(state.children.length, 1, 'children list has one entry')
eq(state.children[0].sessionId, 'child-sidechat', 'children entry is the child session')
eq(state.children[0].bucket.calls, 2, 'children entry counts the child calls')
const childBucket = state.sessions.find((item) => item.key === 'child-sidechat')
ok(childBucket !== undefined && childBucket.calls === 2, 'bySession still keeps the child separately (no double counting)')
eq(state.ownerSessionId, 's-test', 'owner session id reported')

// 单次口径跟着最近收口的那一轮（子会话的一轮也算）
listeners['api-session/status'][0]('child-sidechat', false)
state = (await call('state', { sessionId: 's-test' })).payload
eq(state.lastTurn.sessionId, 'child-sidechat', 'last turn follows the most recent turn including children')

// 开关立即生效：关掉后本对话只剩自己的花费
await call('save', { sessionId: 's-test', config: { mergeChildSessions: false } })
state = (await call('state', { sessionId: 's-test' })).payload
eq(state.sessionTotals.calls, 4, 'merge off excludes the child')
eq(state.children.length, 0, 'merge off reports no children')
await call('save', { sessionId: 's-test', config: { mergeChildSessions: true } })
state = (await call('state', { sessionId: 's-test' })).payload
eq(state.sessionTotals.calls, 6, 'merge on includes the child again')

// lineage 落档：子会话消失后仍能归并
const flushedWithChild = await call('store', { sessionId: 's-test' })
eq(flushedWithChild.status, 200, 'POST store with child rows -> 200')
const storedWithChild = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
ok(storedWithChild.lineage !== undefined && storedWithChild.lineage['child-sidechat'] !== undefined, 'lineage persisted with the ledger')
eq(storedWithChild.lineage['child-sidechat'].owner, 's-test', 'lineage records the parent session')

sessionsAvailable = false
host.apply(ctx, {
  currency: '\u00a5',
  balanceUrl: origin + '/fake-balance',
  credentialRef: 'DEEPSEEK_API_KEY',
})
await new Promise((resolve) => setTimeout(resolve, 50))
const afterGone = (await call('state', { sessionId: 's-test' })).payload
eq(afterGone.children.length, 1, 'merge survives the child session being gone (from persisted lineage)')
eq(afterGone.sessionTotals.calls, 6, 'merged total survives without the sessions service')
near(afterGone.sessionTotals.cost, 7.5 + 3.75 + 3.75 + 6.08 + 7.5 + 7.5, 'merged cost survives without the sessions service')
sessionsAvailable = true

/* ---------------- 内置官方价目表：智谱 GLM ---------------- */

// 账本里存过的 config.prices 会整体替换「用户档位」，所以新增模型单价必须靠内置表兜底，
// 否则老安装升级后，新模型仍会按 default（DeepSeek Flash）计价。
const GLM_FLASH = { provider: 'openai', model: 'glm-5.3-flash', sessionId: 's-test' }
const GLM_53 = { provider: 'openai', model: 'glm-5.3', sessionId: 's-test' }
const GLM_USAGE = { inputTokens: 1000000, outputTokens: 500000, cacheReadTokens: 2000000, cacheWriteTokens: 0, reasoningTokens: 0 }

await withClock('2026-09-14T02:00:00Z', async () => { await emit(GLM_FLASH, GLM_USAGE) })
await withClock('2026-09-14T12:00:00Z', async () => { await emit(GLM_53, GLM_USAGE) })
state = (await call('state', { sessionId: 's-test' })).payload

const glmFlashRow = state.byModel.find((entry) => entry.key === 'openai/glm-5.3-flash')
ok(glmFlashRow !== undefined, 'GLM-5.3-Flash appears in byModel')
eq(glmFlashRow.priceMatch, 'builtin', 'GLM-5.3-Flash resolves from the builtin table')
eq(glmFlashRow.priceKey, 'glm-5.3-flash', 'GLM-5.3-Flash builtin key')
near(glmFlashRow.pricePeak.cacheHit, 0.23, 'GLM-5.3-Flash cache-hit price')
near(glmFlashRow.pricePeak.cacheMiss, 0.8, 'GLM-5.3-Flash input price')
near(glmFlashRow.pricePeak.output, 2.8, 'GLM-5.3-Flash output price')

const glmFlashCost = state.rowsAll.find((row) => row.model === 'glm-5.3-flash').cost
near(glmFlashCost, (2000000 * 0.23 + 1000000 * 0.8 + 500000 * 2.8) / 1000000, 'GLM-5.3-Flash cost math (peak)')

const glm53Row = state.byModel.find((entry) => entry.key === 'openai/glm-5.3')
eq(glm53Row.priceMatch, 'builtin', 'GLM-5.3 resolves from the builtin table')
eq(glm53Row.priceKey, 'glm-5.3', 'GLM-5.3 builtin key')
near(glm53Row.pricePeak.cacheHit, 2, 'GLM-5.3 cache-hit price')
near(glm53Row.pricePeak.cacheMiss, 8, 'GLM-5.3 input price')
near(glm53Row.pricePeak.output, 28, 'GLM-5.3 output price')
// 无高峰/低谷：同一个模型在两套单价下必须相同
near(glm53Row.priceOff.cacheHit, glm53Row.pricePeak.cacheHit, 'GLM-5.3 has no peak/off-peak split (cache hit)')
near(glm53Row.priceOff.cacheMiss, glm53Row.pricePeak.cacheMiss, 'GLM-5.3 has no peak/off-peak split (input)')
near(glm53Row.priceOff.output, glm53Row.pricePeak.output, 'GLM-5.3 has no peak/off-peak split (output)')
const glm53 = state.rowsAll.find((row) => row.model === 'glm-5.3')
eq(glm53.offPeak, true, 'the GLM-5.3 call landed in off-peak hours')
near(glm53.cost, (2000000 * 2 + 1000000 * 8 + 500000 * 28) / 1000000, 'GLM 无高低峰，低谷时段同样计价')

// 用户同名档位优先级更高，可以覆盖内置表
await call('save', {
  sessionId: 's-test',
  config: {
    prices: {
      default: { cacheHit: 0, cacheMiss: 0, output: 0, cacheHitOff: 0, cacheMissOff: 0, outputOff: 0 },
      'glm-5.3-flash': { cacheHit: 1, cacheMiss: 2, output: 3, cacheHitOff: 1, cacheMissOff: 2, outputOff: 3 },
    },
  },
})
await withClock('2026-09-14T02:00:00Z', async () => { await emit(GLM_FLASH, GLM_USAGE) })
state = (await call('state', { sessionId: 's-test' })).payload
const overridden = state.byModel.find((entry) => entry.key === 'openai/glm-5.3-flash')
eq(overridden.priceMatch, 'model', 'a user row with the same model name overrides the builtin table')
near(overridden.pricePeak.cacheMiss, 2, 'overridden input price wins')
const overriddenCost = state.rowsAll.find((row) => row.model === 'glm-5.3-flash').cost
near(overriddenCost, (2000000 * 1 + 1000000 * 2 + 500000 * 3) / 1000000, 'overridden price is what gets billed')

/* ---------------- 余额按供应商分流 ---------------- */

// 先关掉余额请求，只验证「档位解析」与「不串数字」，避免测试访问真实网络
await call('save', { sessionId: 's-glm', config: { showBalance: false } })

await withClock('2026-09-14T02:00:00Z', async () => {
  await emit({ provider: 'zai-coding-cn', model: 'glm-5.3-flash', sessionId: 's-glm' }, GLM_USAGE)
})
state = (await call('state', { sessionId: 's-glm' })).payload
eq(state.balanceProfile.providerLabel, 'BigModel GLM', 'GLM session resolves to the BigModel profile')
eq(state.balanceProfile.kind, 'bigmodel', 'GLM profile uses the BigModel finance endpoint')
eq(state.balanceProfile.url, 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report', 'GLM profile url')
eq(state.balanceProfile.credentialRef, 'BIGMODEL_API_KEY', 'GLM profile uses BIGMODEL_API_KEY')
eq(state.balance.providerLabel, 'BigModel GLM', 'the shown balance belongs to BigModel')
eq(state.balance.total, 0, 'no DeepSeek amount leaks into a GLM session')

// DeepSeek 会话仍是金额余额（上一段缓存下来的值，档位一致）
await withClock('2026-09-14T02:00:00Z', async () => {
  await emit({ provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 's-balance' }, PRO_USAGE)
})
state = (await call('state', { sessionId: 's-balance' })).payload
eq(state.balanceProfile.providerLabel, 'DeepSeek', 'DeepSeek session resolves to the DeepSeek profile')
eq(state.balanceProfile.kind, 'auto', 'customized default url makes the DeepSeek profile auto-detect the shape')
eq(state.balanceProfile.activeModel, 'deepseek-flash', 'DeepSeek session keeps its own last model')

// provider 叫 openai、模型是 glm-* 时，按模型名归到智谱
await withClock('2026-09-14T02:00:00Z', async () => {
  await emit({ provider: 'openai', model: 'glm-5.3', sessionId: 's-glm2' }, GLM_USAGE)
})
state = (await call('state', { sessionId: 's-glm2' })).payload
eq(state.balanceProfile.kind, 'bigmodel', 'openai/glm-* resolves to the GLM profile by model name')
eq(state.balance.providerLabel, 'BigModel GLM', 'and shows the BigModel label')

// 智谱财务接口解析（走本地假端点）：balance/rechargeAmount/giveAmount 对上余额/充值/赠金
await call('save', {
  sessionId: 's-glm',
  config: {
    showBalance: true,
    balanceProfiles: {
      'zai-coding-cn': {
        url: origin + '/fake-bigmodel',
        credentialRef: 'DEEPSEEK_API_KEY',
        kind: 'bigmodel',
        providerLabel: 'BigModel GLM',
        label: '余额',
      },
    },
  },
})
const finance = await call('balance', { sessionId: 's-glm' })
eq(finance.status, 200, 'POST balance (GLM) -> 200')
eq(finance.payload.balance.ok, true, 'GLM finance ok')
eq(finance.payload.balance.kind, 'balance', 'GLM finance reports money, not quota')
near(finance.payload.balance.total, 19.94012911, 'GLM balance')
near(finance.payload.balance.toppedUp, 20, 'GLM rechargeAmount -> 充值')
near(finance.payload.balance.granted, 0, 'GLM giveAmount -> 赠金')
eq(finance.payload.balance.providerLabel, 'BigModel GLM', 'GLM finance belongs to BigModel')
ok(financeHits > 0, 'the BigModel endpoint was actually called')
eq(financeAuth, 'test-key-from-file', 'BigModel request sent the raw key')

// 配额接口仍可用（Coding Plan 账号）：自定义档位 kind=zhipu-quota
await call('save', {
  sessionId: 's-glm',
  config: {
    balanceProfiles: {
      'zai-coding-cn': {
        url: origin + '/fake-quota',
        credentialRef: 'DEEPSEEK_API_KEY',
        kind: 'zhipu-quota',
        providerLabel: 'BigModel GLM',
        label: '配额',
      },
    },
  },
})
const quota = await call('balance', { sessionId: 's-glm' })
eq(quota.payload.balance.ok, true, 'quota profile still works')
eq(quota.payload.balance.quotaText, '3/5', 'quota text parsed from limits')
eq(quota.payload.balance.kind, 'quota', 'quota kind')
ok(quotaHits > 0, 'the quota endpoint was actually called')

// 未知供应商：把默认余额地址还原成内置值后，不得套用别家数字。
// （用户若显式配置过默认地址，那属于他自己设的兜底档位，这里不覆盖那种情况。）
await call('save', { sessionId: 's-unknown', config: { balanceUrl: 'https://api.deepseek.com/user/balance' } })
await withClock('2026-09-14T02:00:00Z', async () => {
  await emit({ provider: 'some-other-vendor', model: 'mystery-model', sessionId: 's-unknown' }, PRO_USAGE)
})
state = (await call('state', { sessionId: 's-unknown' })).payload
eq(state.balanceProfile.kind, 'none', 'unknown provider has no balance profile')
eq(state.balance.total, 0, 'unknown provider shows no foreign amount')
eq(state.balance.providerLabel, '', 'unknown provider has no borrowed label')

// 重启后回填：remount 会重新读账本，会话最近的模型应当来自账本而不是空的。
// 先清掉上面为配额用例加的自定义档位，这样验证的是「内置 GLM 档位」。
await call('save', { sessionId: 's-glm', config: { showBalance: false, balanceProfiles: {} } })
host.apply(ctx, { currency: '\u00a5', balanceUrl: origin + '/fake-balance', credentialRef: 'DEEPSEEK_API_KEY' })
await new Promise((resolve) => setTimeout(resolve, 60))
state = (await call('state', { sessionId: 's-glm' })).payload
eq(state.balanceProfile.kind, 'bigmodel', 'after a remount the GLM session still resolves to GLM (seeded from the ledger)')
eq(state.balanceProfile.activeModel, 'glm-5.3-flash', 'and its last model comes from the ledger')

/* ---------------- 火山方舟 Agent Plan：额度走本地 CLI ---------------- */

// 用真实子进程输出套餐 JSON，验证「起进程 → 解析 → 展示字段」整条链路。
// 命令写成「node 脚本 数据文件」：不把长 JSON 塞进 -e 参数（Windows 引号转义会出问题）。
const planPayload = {
  viewer: { auth_method: 'sso', user_name: 'tester', profile: 'agent-plan_cn-beijing_personal' },
  items: [
    {
      product: 'agent-plan', edition: 'personal', tier: 'small', subscribed: true,
      periods: [
        { label: '5h', used: 19.1137, total: 2000, percent: 0.955685, reset_at: '2026-09-18T05:13:12+08:00' },
        { label: 'weekly', used: 19.1137, total: 7000, percent: 0.27305285714285715, reset_at: '2026-09-21T00:00:00+08:00' },
        { label: 'monthly', used: 118.2357, total: 20000, percent: 0.5911785, reset_at: '2026-10-10T23:59:59+08:00' },
      ],
    },
  ],
}
const echoScript = join(home, 'fake-ark-echo.cjs')
const printPlanScript = join(home, 'fake-ark-plan.cjs')
writeFileSync(echoScript, 'process.stdout.write(require("fs").readFileSync(process.argv[2], "utf8"))\n', 'utf8')
writeFileSync(printPlanScript, JSON.stringify(planPayload), 'utf8')

const ARK_META = { provider: 'volc-ark-coding', model: 'doubao-seed-2-1-turbo-260628', sessionId: 's-ark' }

await call('save', {
  sessionId: 's-ark',
  config: {
    showBalance: true,
    balanceProfiles: {
      'volc-ark-coding': {
        kind: 'ark-plan',
        providerLabel: '火山方舟 Agent Plan',
        label: '套餐额度',
        command: { file: process.execPath, args: [echoScript, printPlanScript] },
      },
    },
  },
})
await withClock('2026-09-14T02:00:00Z', async () => {
  await emit({ provider: 'volc-ark-coding', model: 'doubao-seed-2-1-turbo-260628', sessionId: 's-ark' }, PRO_USAGE)
})

state = (await call('state', { sessionId: 's-ark' })).payload
eq(state.balanceProfile.providerLabel, '火山方舟 Agent Plan', 'Ark session resolves to the Ark plan profile')
eq(state.balanceProfile.kind, 'ark-plan', 'Ark profile kind')

const plan = await call('balance', { sessionId: 's-ark' })
eq(plan.status, 200, 'POST balance (Ark) -> 200')
eq(plan.payload.balance.ok, true, 'plan quota ok')
eq(plan.payload.balance.kind, 'quota', 'plan reports quota, not money')
eq(plan.payload.balance.quotaText, '0.96%', 'badge shows the most-used window')
eq(plan.payload.balance.label, '套餐额度', 'plan label')
eq(plan.payload.balance.quotaPeriods.length, 3, 'three quota windows')
eq(plan.payload.balance.quotaPeriods[0].label, '5h', 'first window label')
near(plan.payload.balance.quotaPeriods[2].percent, 0.5911785, 'monthly percent')
eq(plan.payload.balance.quotaPeriods[0].resetAt, '2026-09-18T05:13:12+08:00', 'reset time kept as-is')
eq(plan.payload.balance.planMeta.tier, 'small', 'plan tier')
eq(plan.payload.balance.planMeta.account, 'tester', 'plan account from viewer')
eq(plan.payload.balance.via, 'cli:arkcli', 'source is a CLI command')
eq(plan.payload.balance.total, 0, 'quota is not a money amount')

// 内置档位（不配 command 时）指向真正的 arkcli
await call('save', { sessionId: 's-ark', config: { balanceProfiles: {} } })
state = (await call('state', { sessionId: 's-ark' })).payload
eq(state.balanceProfile.providerLabel, '火山方舟 Agent Plan', 'builtin Ark profile resolves without user config')
eq(state.balanceProfile.kind, 'ark-plan', 'builtin Ark kind')
eq(state.balanceProfile.url, '', 'builtin Ark profile needs no HTTP url')

// 没订阅：如实报错，不算出任何数字
const emptyPlan = join(home, 'fake-ark-empty.json')
writeFileSync(emptyPlan, JSON.stringify({ viewer: {}, items: [] }), 'utf8')
await call('save', {
  sessionId: 's-ark',
  config: { balanceProfiles: { 'volc-ark-coding': { kind: 'ark-plan', providerLabel: '火山方舟 Agent Plan', label: '套餐额度', command: { file: process.execPath, args: [echoScript, emptyPlan] } } } },
})
const noSub = await call('balance', { sessionId: 's-ark' })
eq(noSub.payload.balance.ok, false, 'no subscription -> not ok')
ok(String(noSub.payload.balance.error).includes('没有生效'), 'no subscription reports a clear reason')
eq(noSub.payload.balance.total, 0, 'no subscription shows no amount')

// 命令失败：把原因带出来，不静默
const failScript = join(home, 'fake-ark-fail.cjs')
writeFileSync(failScript, 'process.stderr.write("boom")\nprocess.exit(3)\n', 'utf8')
await call('save', {
  sessionId: 's-ark',
  config: { balanceProfiles: { 'volc-ark-coding': { kind: 'ark-plan', providerLabel: '火山方舟 Agent Plan', label: '套餐额度', command: { file: process.execPath, args: [failScript] } } } },
})
const failed = await call('balance', { sessionId: 's-ark' })
eq(failed.payload.balance.ok, false, 'failing command -> not ok')
ok(String(failed.payload.balance.error).includes('额度查询失败'), 'failing command reports the failure')
await call('save', { sessionId: 's-ark', config: { balanceProfiles: {} } })

/* ---------------- 套餐额度计量：消耗 + 剩余 ---------------- */

// 用「改写额度数据文件」来模拟控制台的额度增长，从而估出 AFP/Token 比率。
const raisedPlan = join(home, 'fake-ark-raised.json')
writeFileSync(raisedPlan, JSON.stringify({
  viewer: { user_name: 'tester' },
  items: [{
    product: 'agent-plan', edition: 'personal', tier: 'small', subscribed: true,
    periods: [
      { label: '5h', used: 20, total: 2000, percent: 1.0, reset_at: '2026-09-18T05:13:12+08:00' },
      { label: 'weekly', used: 20, total: 7000, percent: 0.2857, reset_at: '2026-09-21T00:00:00+08:00' },
      { label: 'monthly', used: 119, total: 20000, percent: 0.595, reset_at: '2026-10-10T23:59:59+08:00' },
    ],
  }],
}), 'utf8')

await call('save', {
  sessionId: 's-ark',
  config: {
    showBalance: true,
    balanceProfiles: {
      'volc-ark-coding': {
        kind: 'ark-plan', providerLabel: '火山方舟 Agent Plan', label: '套餐额度',
        command: { file: process.execPath, args: [echoScript, printPlanScript] },
      },
    },
  },
})

// 第一次快照：只建基准，不比出比率
const baseline = await call('balance', { sessionId: 's-ark' })
eq(baseline.payload.quota.muted, true, 'quota mode is on for the Ark profile')
eq(baseline.payload.quota.remaining.length, 3, 'three remaining windows')
near(baseline.payload.quota.remaining[0].remaining, 2000 - 19.1137, 'remaining = total - used')

// 一次调用（此刻比率还是 0，额度记 0）
await withClock('2026-09-14T02:00:00Z', async () => { await emit(ARK_META, PRO_USAGE) })

// 控制台额度上涨 → 再取快照即可估出比率
writeFileSync(printPlanScript, readFileSync(raisedPlan, 'utf8'), 'utf8')
const risen = await call('balance', { sessionId: 's-ark' })
eq(risen.payload.balance.ok, true, 'plan still ok after the raise')
ok(risen.payload.quota.rate > 0, 'AFP/token rate estimated from the observed delta')
near(risen.payload.quota.remaining[0].remaining, 2000 - 20, 'remaining follows the new snapshot')

// 之后再调用：记额度、不计钱
await withClock('2026-09-14T02:00:00Z', async () => { await emit(ARK_META, PRO_USAGE) })
state = (await call('state', { sessionId: 's-ark' })).payload
const arkModel = state.byModel.find((entry) => entry.key === 'volc-ark-coding/doubao-seed-2-1-turbo-260628')
ok(arkModel !== undefined, 'quota-based model appears in byModel')
eq(arkModel.cost, 0, 'quota-based model costs no money')
ok(arkModel.quota > 0, 'quota-based model records quota usage')
ok(state.sessionTotals.quota > 0, 'conversation quota usage accumulates')
near(state.sessionTotals.quota, arkModel.quota, 'session quota equals the model quota here')

// 收口后「单次」也带额度
listeners['api-session/status'][0]('s-ark', false)
state = (await call('state', { sessionId: 's-ark' })).payload
ok(state.lastTurn.quota > 0, 'last turn carries quota usage')

// 控制台延迟出账：某一刻的快照没看到增量时，token 基准不能被推进，
// 否则那段额度会被摊到之后的一小段 token 上，比率被高估。
const flat = await call('balance', { sessionId: 's-ark' })
eq(flat.payload.quota.rate, risen.payload.quota.rate, 'a lagging snapshot leaves the rate alone')
await withClock('2026-09-14T02:00:00Z', async () => { await emit(ARK_META, PRO_USAGE) })
const laggedPlan = join(home, 'fake-ark-lagged.json')
writeFileSync(laggedPlan, JSON.stringify({
  viewer: { user_name: 'tester' },
  items: [{
    product: 'agent-plan', edition: 'personal', tier: 'small', subscribed: true,
    periods: [
      { label: '5h', used: 21, total: 2000, percent: 1.05, reset_at: '2026-09-18T05:13:12+08:00' },
      { label: 'weekly', used: 21, total: 7000, percent: 0.3, reset_at: '2026-09-21T00:00:00+08:00' },
      { label: 'monthly', used: 120, total: 20000, percent: 0.6, reset_at: '2026-10-10T23:59:59+08:00' },
    ],
  }],
}), 'utf8')
writeFileSync(printPlanScript, readFileSync(laggedPlan, 'utf8'), 'utf8')
const caught = await call('balance', { sessionId: 's-ark' })
// 增量 20 -> 21 = 1.0；这期间攒下的 token 是「上一次真的用掉增量之后」的两笔
// PRO_USAGE（每笔 1,600,000），不能只除最后一笔。
near(caught.payload.quota.rate, 1 / 3200000, 'the lagging window is divided over all the tokens it covers')

// 按量付费的模型不受影响
await withClock('2026-09-14T02:00:00Z', async () => { await emit(PRO, PRO_USAGE) })
state = (await call('state', { sessionId: 's-test' })).payload
eq(state.quota.muted, false, 'money-based session is not in quota mode')
ok(state.sessionTotals.cost > 0, 'money-based providers still accumulate cost')
await call('save', { sessionId: 's-ark', config: { balanceProfiles: {} } })

/* ---------------- 只向 ctx 要过合理的东西 ---------------- */

const badRequests = requestedServices.filter((name) => name !== 'credentials' && name !== 'sessions')
eq(badRequests.length, 0, 'never asked ctx.get for anything but credentials/sessions (asked: ' + (badRequests.join(',') || 'none') + ')')

/* ---------------- 历史子会话收养 ---------------- */

// 场景：子会话早已结束、账本里也没有它的归属，但它的会话日志第一行留着
// parentSession。用一份合成的账本 + 一份合成的 zstd 会话日志验证收养。
sessionsAvailable = false
const legacyChild = 'child-legacy'
const legacyLog = join(home, 'sessions', '--test-workspace--', legacyChild, 'session.v3.jsonl.zstd')
mkdirSync(dirname(legacyLog), { recursive: true })
writeFileSync(
  legacyLog,
  zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 3, id: legacyChild, parentSession: 's-test' }) + '\n', 'utf8')),
)
writeFileSync(STORE_PATH, JSON.stringify({
  version: 3,
  savedAt: Date.now(),
  config: {},
  counter: 7,
  totals: { calls: 7, cost: 39.58, hit: 0, miss: 0, write: 0, out: 0, offPeakCalls: 7 },
  byModel: {},
  byDay: {},
  bySession: {
    's-test': { calls: 6, cost: 36.08, hit: 0, miss: 0, write: 0, out: 0, offPeakCalls: 6 },
    [legacyChild]: { calls: 1, cost: 3.5, hit: 0, miss: 0, write: 0, out: 0, offPeakCalls: 1 },
  },
  lastTurns: {},
  rows: [],
}), 'utf8')

host.apply(ctx, { currency: '\u00a5', balanceUrl: origin + '/fake-balance', credentialRef: 'DEEPSEEK_API_KEY' })
await new Promise((resolve) => setTimeout(resolve, 100))
const adopted = (await call('state', { sessionId: 's-test' })).payload
eq(adopted.children.length, 1, 'adopted the historical child session from its session log')
eq(adopted.children[0].sessionId, legacyChild, 'adopted child id')
eq(adopted.children[0].bucket.calls, 1, 'adopted child calls')
near(adopted.sessionTotals.cost, 36.08 + 3.5, 'adopted child cost merged into the conversation')
sessionsAvailable = true

// 本地假服务器留到进程退出：宿主还有异步余额请求会晚到一两拍，
// 提前 close() 会让它们变成 fetch failed。unref 让监听句柄不阻塞退出。
server.unref()

/* ================================================================== *
 * 2. 客户端半边：用 __ModuleLoader__ 加载并跑 apply
 * ================================================================== */

console.log('\n[client] lib/client.js')

const source = read('lib/client.js')
ok(!source.includes('host.call('), 'no dynamic-sandbox host.call call site left')
ok(!source.includes('harness.'), 'no dynamic-sandbox harness.* left')
ok(!source.includes('styles.insert('), 'no dynamic-sandbox styles.insert left')
ok(!source.includes('cordis-panel'), 'no sidebar.footer.action shadow left')

let loaded = null
const fakeReact = { createElement(...args) { return { __element: true, args } } }
const windowStub = { __ModuleLoader__: { load(spec) { loaded = spec } } }
const documentStub = {
  baseURI: 'http://127.0.0.1:3080/',
  head: {
    children: [],
    appendChild(element) {
      element.parentNode = documentStub.head
      documentStub.head.children.push(element)
    },
    removeChild(element) {
      const at = documentStub.head.children.indexOf(element)
      if (at !== -1) documentStub.head.children.splice(at, 1)
      element.parentNode = null
    },
  },
  createElement(tag) {
    return {
      tagName: tag,
      textContent: '',
      parentNode: null,
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = value },
    }
  },
}
const requireStub = (name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
}
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'URL', source)(windowStub, documentStub, URL)

ok(loaded !== null, 'bundle called window.__ModuleLoader__.load')
eq(loaded.id, 'dsh-token-feiyong', 'loader spec id')

const clientModule = loaded.factory(requireStub)
eq(clientModule.name, 'dsh-token-feiyong', 'client export name')
eq(Array.isArray(clientModule.inject) && clientModule.inject.join(','), 'slots', 'client export inject')
eq(typeof clientModule.apply, 'function', 'client export apply')

const registrations = []
const slotsStub = {
  inject(name, callback) { callback() },
  register(spec, Component) {
    registrations.push({ spec, Component })
    return () => {}
  },
}
const clientEffects = []
const clientCtx = {
  get: (name) => (name === 'slots' ? slotsStub : undefined),
  effect(callback) {
    const off = callback()
    clientEffects.push(off)
    return off
  },
}
clientModule.apply(clientCtx)

eq(clientEffects.length, 1, 'client ctx.effect used for the stylesheet')
eq(typeof clientEffects[0], 'function', 'stylesheet effect returns a disposer')
eq(documentStub.head.children.length, 1, 'stylesheet element appended to document.head')
eq(documentStub.head.children[0].attrs['data-dsh-token-feiyong'], '', 'stylesheet carries its marker attribute')
ok(documentStub.head.children[0].textContent.includes('.tb-page'), 'stylesheet carries the panel CSS')
clientEffects[0]()
eq(documentStub.head.children.length, 0, 'disposer removes the stylesheet')

eq(registrations.length, 2, 'client slot registration count')
const bySlot = new Map(registrations.map((item) => [item.spec.name, item.spec]))
ok(bySlot.has('settings.section'), 'registers settings.section')
ok(bySlot.has('conversation.composer.dock'), 'registers conversation.composer.dock')
eq(bySlot.get('settings.section').id, 'token-billing', 'settings.section id')
eq(bySlot.get('settings.section').label, '费用统计', 'settings.section label')
eq(bySlot.get('conversation.composer.dock').id, 'token-billing', 'composer dock id')
ok(!bySlot.has('sidebar.footer.action'), 'does not shadow sidebar.footer.action')
ok(registrations.every((item) => typeof item.Component === 'function'), 'all registrations pass a component')

/* ---------------- 功能性回归：徽标必须自己轮询 ---------------- */

// 真实客户端的启动清单里没有 timer 模块（已核实），ctx.get('timer') 为 undefined。
// 最初 useBilling 只在 timer 服务存在时才轮询，于是徽标只渲染挂载那一帧——那时余额
// 还在异步获取中，永远显示「…」，而设置页因为会再次拉取所以正常。
// 这里用只实现 useState/useEffect 的迷你 React 真跑一遍 BillingMeter 的 effect。
ok(source.includes('window.setInterval(tick, intervalMs)'), 'bundle has the window.setInterval fallback')

const hookStates = []
let hookCursor = 0
const miniEffects = []
const miniReact = {
  createElement(type, props, ...children) { return { type, props, children } },
  useState(initial) {
    const index = hookCursor++
    if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial
    return [hookStates[index], (next) => { hookStates[index] = next }]
  },
  useEffect(callback) { miniEffects.push(callback) },
}

let loaded2 = null
const intervals = []
let intervalClears = 0
const windowStub2 = {
  __ModuleLoader__: { load(spec) { loaded2 = spec } },
  setInterval(callback, ms) { intervals.push({ callback, ms }); return 4242 },
  clearInterval(handle) { intervalClears += 1; void handle },
}
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'URL', source)(windowStub2, documentStub, URL)

const requireStub2 = (name) => {
  if (name === 'react') return miniReact
  throw new Error('unexpected require: ' + name)
}
const clientModule2 = loaded2.factory(requireStub2)
const registrations2 = []
const slotsStub2 = {
  inject(name, callback) { callback() },
  register(spec, Component) { registrations2.push({ spec, Component }); return () => {} },
}
clientModule2.apply({
  get: (name) => (name === 'slots' ? slotsStub2 : undefined),
  effect(callback) { callback() },
})

const meter = registrations2.find((item) => item.spec.name === 'conversation.composer.dock')?.Component
ok(typeof meter === 'function', 'composer badge component found')
miniEffects.length = 0
hookCursor = 0

const realFetch = globalThis.fetch
let pulled = 0
globalThis.fetch = async () => {
  pulled += 1
  return {
    ok: true,
    status: 200,
    json: async () => ({ config: { enabled: true }, phase: { offPeak: true }, balance: { ok: false }, store: {}, totals: {} }),
  }
}

meter({ sessionId: 's-test' })
eq(miniEffects.length, 1, 'badge registers exactly one effect')
const cleanup = miniEffects[0]()
eq(intervals.length, 1, 'badge starts its own polling without the timer service')
eq(intervals[0].ms, 3000, 'badge polls every 3000ms')
eq(pulled, 1, 'badge pulled a snapshot immediately on mount')

// 轮询回调真的会再拉取
intervals[0].callback()
await new Promise((resolve) => setTimeout(resolve, 0))
eq(pulled, 2, 'polling callback pulls again')

ok(typeof cleanup === 'function', 'effect returns a disposer')
cleanup()
eq(intervalClears, 1, 'disposer clears the interval')

/* ---------------- 按量付费：徽标仍然是金额 ---------------- */

/** 把渲染出来的元素树压成纯文本，用来断言徽标到底显示了什么。 */
const textOf = function (node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const item of node) textOf(item, out)
    return out
  }
  if (typeof node === 'object') {
    if (node.children !== undefined) textOf(node.children, out)
    return out
  }
  out.push(String(node))
  return out
}

hookStates.length = 0
hookCursor = 0
miniEffects.length = 0
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    config: { enabled: true, showBalance: true, currency: '\u00a5' },
    phase: {
      offPeak: false, dayLabel: '周一', clock: '10:00', offsetLabel: '北京时间',
      peakDaysText: '周一至周五', peakWindowsText: '09:00-12:00 / 14:00-18:00',
    },
    balance: { ok: true, kind: 'balance', label: '余额', providerLabel: 'DeepSeek', total: 32.31, granted: 5, toppedUp: 27.31 },
    store: { ready: true, savedAtText: '刚刚', path: 'ledger.json' },
    lastTurn: { cost: 0.012345, quota: 0, calls: 1, turn: 3, atText: '10:01', hit: 10, miss: 20, out: 30 },
    todayTotals: { calls: 2, cost: 1.41 },
    sessionTotals: { calls: 2, cost: 1.41, quota: 0, hit: 10, miss: 20, out: 30 },
    totals: { calls: 2, cost: 1.41, quota: 0 },
    children: [],
    byModel: [],
    quota: { muted: false, rate: 0, remaining: [] },
  }),
})

meter({ sessionId: 's-test' })
miniEffects[miniEffects.length - 1]()
await new Promise((resolve) => setTimeout(resolve, 0))
hookCursor = 0
const moneyElement = meter({ sessionId: 's-test' })
const moneyText = textOf(moneyElement, []).join('|')
ok(moneyText.includes('单次'), 'money badge keeps the 单次 metric')
ok(moneyText.includes('本对话'), 'money badge keeps the 本对话 metric')
ok(moneyText.includes('今日'), 'money badge keeps the 今日 metric')
ok(moneyText.includes('\u00a5'), 'money badge still prints money')
ok(!moneyText.includes('5小时'), 'money badge shows no quota windows')
ok(String(moneyElement.props.title).includes('单次花费'), 'money badge tooltip talks about money')

/* ---------------- 套餐制：徽标改说额度，不再出现金额 ---------------- */

hookStates.length = 0
hookCursor = 0
miniEffects.length = 0
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    config: { enabled: true, showBalance: true, currency: '\u00a5' },
    phase: {
      offPeak: true, dayLabel: '周一', clock: '20:00', offsetLabel: '北京时间',
      peakDaysText: '周一至周五', peakWindowsText: '09:00-12:00 / 14:00-18:00',
    },
    balance: {
      ok: true, kind: 'quota', label: '套餐额度', providerLabel: '火山方舟 Agent Plan', quotaText: '0.96%',
      quotaPeriods: [
        { label: '5h', used: 19.1137, total: 2000, percent: 0.9557, resetAt: '2026-09-18T05:13:12+08:00' },
        { label: 'weekly', used: 19.1137, total: 7000, percent: 0.2731, resetAt: '2026-09-21T00:00:00+08:00' },
        { label: 'monthly', used: 118.2357, total: 20000, percent: 0.5912, resetAt: '2026-10-10T23:59:59+08:00' },
      ],
    },
    store: { ready: true, savedAtText: '刚刚', path: 'ledger.json' },
    lastTurn: { cost: 0, quota: 12.5, calls: 1, turn: 3, atText: '20:01', hit: 10, miss: 20, out: 30 },
    todayTotals: { calls: 2, cost: 0 },
    sessionTotals: { calls: 2, cost: 0, quota: 25, hit: 10, miss: 20, out: 30 },
    totals: { calls: 2, cost: 0, quota: 25 },
    children: [],
    byModel: [],
    quota: {
      muted: true, rate: 0.0001,
      remaining: [
        { label: '5h', used: 19.1137, total: 2000, remaining: 1980.8863, percent: 0.9557, resetAt: '2026-09-18T05:13:12+08:00' },
        { label: 'weekly', used: 19.1137, total: 7000, remaining: 6980.8863, percent: 0.2731, resetAt: '2026-09-21T00:00:00+08:00' },
        { label: 'monthly', used: 118.2357, total: 20000, remaining: 19881.7643, percent: 0.5912, resetAt: '2026-10-10T23:59:59+08:00' },
      ],
    },
  }),
})

meter({ sessionId: 's-ark' })
miniEffects[miniEffects.length - 1]()
await new Promise((resolve) => setTimeout(resolve, 0))
hookCursor = 0
const quotaElement = meter({ sessionId: 's-ark' })
const quotaText = textOf(quotaElement, []).join('|')
ok(quotaText.includes('单次'), 'quota badge keeps the 单次 metric')
ok(quotaText.includes('12.5'), 'quota badge shows the quota burnt by the last turn')
ok(quotaText.includes('本对话'), 'quota badge keeps the 本对话 metric')
ok(quotaText.includes('25'), 'quota badge shows the quota burnt by the conversation')
ok(quotaText.includes('5小时'), 'quota badge names the 5h window')
ok(quotaText.includes('周额度'), 'quota badge names the weekly window')
ok(quotaText.includes('月额度'), 'quota badge names the monthly window')
ok(quotaText.includes('1981'), 'quota badge shows the remaining 5h quota')
ok(quotaText.includes('19882'), 'quota badge shows the remaining monthly quota')
ok(!quotaText.includes('\u00a5'), 'quota badge prints no money at all')
ok(String(quotaElement.props.title).includes('额度口径'), 'quota badge tooltip explains the quota basis')
ok(String(quotaElement.props.title).includes('5小时 已用 19.11/2000'), 'quota tooltip lists the window usage')
ok(String(quotaElement.props.title).split('5小时 已用').length === 2, 'the window list is not printed twice')

globalThis.fetch = realFetch
globalThis.fetch = realOutboundFetch

rmSync(home, { recursive: true, force: true })

console.log('\n' + String(passed) + ' checks passed\n')
