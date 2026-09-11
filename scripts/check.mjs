/**
 * 自测：在没有 DSH 进程的情况下验证两半插件的契约与算法。
 *
 *   node scripts/check.mjs
 *
 * 覆盖：
 *   宿主  apply 后注册 5 条路由；路由只接受 POST + 自定义头；账本记账、
 *         分时计价（高峰/低谷各自单价）、配置保存、清空、内存存档落盘。
 *   客户端 lib/client.js 能被 __ModuleLoader__ 加载，导出 name/inject/apply，
 *         注册且只注册 settings.section 与 conversation.composer.dock，
 *         并且不再含动态沙箱遗留（host.call / cordis-panel）。
 *
 * 退出码 0 表示全部通过；任一条失败抛错并以非 0 退出。
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * 1. 宿主半边：真起 HTTP 服务，把路由注册进去
 * ================================================================== */

console.log('\n[host] lib/index.js')

const host = await import(new URL('../lib/index.js', import.meta.url).href)
eq(host.name, 'dsh-token-feiyong', 'export name')
eq(typeof host.apply, 'function', 'export apply')

const ROUTES = []
const registered = []
let requestHandler = null
const server = createServer((request, response) => {
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

/** 内存 fs，签名与 DSH 的 fs 服务一致（resolve / readText / writeText）。 */
const disk = new Map()
const fakeFs = {
  async resolve(path) { return path },
  async readText(target) {
    if (!disk.has(target)) throw new Error('ENOENT: ' + target)
    return disk.get(target)
  },
  async writeText(target, text) { disk.set(target, text) },
}
const STORE_PATH = join('C:\\Users\\test\\.dsh', 'token-billing-ledger.json')

const listeners = {}
const effects = []
const ctx = {
  on(event, callback) { (listeners[event] ??= []).push(callback) },
  get(name) {
    if (name === 'fs') return fakeFs
    if (name === 'settings') return { prepareDocument: async () => 'C:\\Users\\test\\.dsh\\settings.json' }
    return undefined
  },
  inject(_services, callback) { callback(ctx) },
  effect(callback, label) { effects.push(label); callback() },
  webServer,
  logger: { info() {}, warn() {} },
}

host.apply(ctx, { currency: '\u00a5' })
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
ok(typeof state.store.path === 'string' && state.store.path.endsWith('token-billing-ledger.json'), 'store path resolved')

/* ---------------- 存档落盘 ---------------- */

const stored = await call('store', { sessionId: 's-test' })
eq(stored.status, 200, 'POST store -> 200')
ok(disk.has(STORE_PATH), 'ledger flushed to disk at ' + STORE_PATH)
const payload = JSON.parse(disk.get(STORE_PATH))
eq(payload.version, 3, 'store version')
eq(payload.totals.calls, 4, 'store totals.calls')
ok(Array.isArray(payload.rows) && payload.rows.length === 4, 'store rows persisted')

/* ---------------- 可重入：apply 再次执行不得重复计数 ---------------- */

// 场景：补丁热重载（profile 的 patchReload: live）会让同一个模块实例再次 apply，
// 而 ESM 模块在进程内是复用的。若 apply 不复位内存聚合，loadStore 会把账本里的
// 聚合再并入一次，totals 翻倍——实测在真实宿主里出现过 calls 185 -> 382。
host.apply(ctx, { currency: '\u00a5' })
await new Promise((resolve) => setTimeout(resolve, 50))
const afterRemount = (await call('state', { sessionId: 's-test' })).payload
eq(afterRemount.totals.calls, 4, 'second apply does not double count totals')
near(afterRemount.totals.cost, payload.totals.cost, 'second apply does not double count cost')
eq(afterRemount.rows.length, 4, 'second apply keeps rows de-duplicated')
eq(afterRemount.store.path, STORE_PATH, 'second apply keeps the same store path')

/* ---------------- 配置保存 ---------------- */

const saved = await call('save', {
  sessionId: 's-test',
  config: { currency: 'CNY', offPeakRatio: 0.4, prices: { default: { cacheHit: 1, cacheMiss: 2, output: 3, cacheHitOff: 0.5, cacheMissOff: 1, outputOff: 1.5 } } },
})
eq(saved.status, 200, 'POST save -> 200')
eq(saved.payload.config.currency, 'CNY', 'saved currency')
eq(saved.payload.config.offPeakRatio, 0.4, 'saved offPeakRatio')
near(saved.payload.config.prices.default.cacheHit, 1, 'saved price override')

/* ---------------- 清空 ---------------- */

const cleared = await call('reset', { sessionId: 's-test' })
eq(cleared.status, 200, 'POST reset -> 200')
eq(cleared.payload.totals.calls, 0, 'reset clears totals')
eq(cleared.payload.rows.length, 0, 'reset clears rows')

server.close()

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

console.log('\n' + String(passed) + ' checks passed\n')
