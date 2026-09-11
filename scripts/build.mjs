/**
 * 构建脚本：把动态 Cordis 包的两个函数体转成真实插件包。
 *
 *   src/host.js   (cordis_define 的 code.host 函数体)  ->  lib/index.js
 *   src/client.js (cordis_define 的 code.client 函数体) ->  lib/client.js
 *
 * 变换是定点替换，每一处都断言命中，避免源文件改动后静默产出错误产物：
 *
 *   宿主半边
 *     1. 去掉描述「动态包」的首段注释，换成构建产物横幅
 *     2. return { apply(ctx) { ... } }  →  export function apply(ctx, rowConfig)
 *     3. harness.handle('billing/x', fn)  →  __register('billing/x', fn)
 *     4. 末尾挂载 webServer 路由（5 个方法 → /dsh-token-feiyong/<name>）
 *     5. 断言按次沙箱策略覆盖仍在（账本在工作区外、余额探测要联网，两处都不能删）
 *
 *   客户端半边
 *     1. 包进 window.__ModuleLoader__.load({ id, factory })，导出 name/inject/apply
 *     2. require('react') 供 React.createElement 使用
 *     3. host.call(m, a)  →  hostCall(m, a)（POST 到宿主路由）
 *     4. 去掉冒充 cordis-panel 的 sidebar.footer.action 注册
 *     5. 去掉只对动态沙箱有意义的「余额请求：沙箱」开关
 *
 * 用法：node scripts/build.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const write = (rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text, 'utf8')
  return text
}

/** 替换一次，未命中就抛错——静默不替换会产出看似正常的坏包。 */
function once(text, from, to, what) {
  const at = text.indexOf(from)
  if (at === -1) throw new Error('build: anchor not found (' + what + ')')
  if (text.indexOf(from, at + 1) !== -1) throw new Error('build: anchor not unique (' + what + ')')
  return text.slice(0, at) + to + text.slice(at + from.length)
}

/** 按行过滤，并断言删掉的正是预期行数。 */
function dropLines(lines, predicate, expected, what) {
  const kept = []
  let dropped = 0
  for (const line of lines) {
    if (predicate(line)) { dropped += 1; continue }
    kept.push(line)
  }
  if (dropped !== expected) {
    throw new Error('build: dropped ' + String(dropped) + ' lines, expected ' + String(expected) + ' (' + what + ')')
  }
  return kept
}

/** 去掉文件首个注释块（描述「动态包」的那段）。 */
function stripLeadingComment(text, what) {
  const end = text.indexOf('*/\n')
  if (end === -1) throw new Error('build: no leading comment block (' + what + ')')
  return text.slice(end + 3)
}

/* ------------------------------------------------------------------ *
 * 宿主半边
 * ------------------------------------------------------------------ */

const HOST_PREAMBLE = `/* ------------------------------------------------------------------ *
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

`

const HEADER_HOST = `/**
 * dsh-token-feiyong — 宿主半边（构建产物，请勿直接编辑）
 *
 * 由 scripts/build.mjs 从 src/host.js 生成；要改逻辑请改 src/host.js 后重新构建。
 * 这是 Node 侧的真实 cordis 插件：export name / export apply(ctx, rowConfig)。
 * 账本、价目表、高峰低谷判定与落盘结构见 README 与 docs/billing-explained.html。
 */

`

function buildHost() {
  let text = stripLeadingComment(read('src/host.js'), 'src/host.js')

  // 沙箱相关的两处【保留】：账本写在 ~/.dsh（工作区之外），余额探测要联网，
  // 两者都要在调用点显式覆盖默认的 workspace-write 策略，否则真实宿主里
  // 会以 "file access denied under workspace-write mode" 失败。
  if (!text.includes('spec.sandboxPolicy = { mode: \'danger-full-access\', workspaceRoot: spec.workdir }')) {
    throw new Error('build: shell sandboxPolicy override missing from src/host.js')
  }
  if (!text.includes("mode: 'danger-full-access',\n        workspaceRoot: storeDir,")) {
    throw new Error('build: fs.writeText sandbox override missing from src/host.js')
  }

  // 沙箱 RPC → 路由处理器登记。
  const handles = (text.match(/harness\.handle\(/g) ?? []).length
  if (handles !== 5) throw new Error('build: expected 5 harness.handle calls, found ' + String(handles))
  text = text.replace(/harness\.handle\(/g, '__register(')

  // 插件外形：动态包的 return { apply } → ESM 导出。
  text = once(
    text,
    '\nreturn {\n  apply(ctx) {\n',
    '\n' + HOST_PREAMBLE + "export const name = 'dsh-token-feiyong'\n"
      + '\n/**\n'
      + ' * 挂载计费拦截、单次收口、余额探测与账本存档。\n'
      + ' * @param {object} ctx 宿主上下文（cordis Context）。\n'
      + ' * @param {object} [rowConfig] cordis.yml 该行的 config，作为初始配置。\n'
      + ' */\n'
      + 'export function apply(ctx, rowConfig) {\n'
      + '  __resetState()\n'
      + '  if (rowConfig !== null && typeof rowConfig === "object") applyConfig(rowConfig)\n',
    'plugin wrapper',
  )

  // 末尾：挂载路由后再收口 apply。
  const tail = /\n {2}\},\n\}\n?$/
  if (!tail.test(text)) throw new Error('build: plugin tail anchor not found')
  text = text.replace(tail, '\n\n  __mountRoutes(ctx)\n}\n')

  return write('lib/index.js', HEADER_HOST + text)
}

/* ------------------------------------------------------------------ *
 * 客户端半边
 * ------------------------------------------------------------------ */

const CLIENT_PREAMBLE = `/**
 * dsh-token-feiyong — 浏览器半边（构建产物，请勿直接编辑）
 *
 * 由 scripts/build.mjs 从 src/client.js 生成；要改逻辑请改 src/client.js 后重新构建。
 * 宿主按 package.json 的 exports["./client"] 与 dsh.client.platform 加载它。
 * 动态沙箱的 host.call 换成 POST /dsh-token-feiyong/<method>。
 */
window.__ModuleLoader__.load({ id: 'dsh-token-feiyong', factory: function (require) {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')

  /** 与宿主 UI 同基址解析，兼容根路径与非根路径部署。 */
  function apiUrl(path) {
    var relative = String(path).replace(/^\\/+/, '')
    if (typeof document === 'undefined') return '/' + relative
    return new URL(relative, document.baseURI).pathname
  }

  /** 客户端 -> 宿主；替代动态沙箱的 host.call 式 RPC。 */
  function hostCall(method, args) {
    var name = String(method).replace(/^billing\\//, '')
    return fetch(apiUrl('dsh-token-feiyong/' + name), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token-feiyong': '1' },
      body: JSON.stringify(args === undefined || args === null ? {} : args),
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (response.ok !== true) {
          var message = (payload !== null && typeof payload === 'object' && typeof payload.error === 'string')
            ? payload.error
            : 'HTTP ' + String(response.status)
          throw new Error(message)
        }
        return payload
      })
    })
  }

  /**
   * 注入一份样式表，返回注销函数。
   *
   * 动态沙箱里这是 runner 提供的 styles.insert；真实插件没有这个服务，自己挂一个
   * <style> 交给 ctx.effect 托管即可——类名都带 tb- 前缀，全局注入不会串味。
   */
  function installStyles(css) {
    if (typeof document === 'undefined' || document.head === null) return function () {}
    var element = document.createElement('style')
    element.setAttribute('data-dsh-token-feiyong', '')
    element.textContent = css
    document.head.appendChild(element)
    return function () {
      if (element.parentNode !== null) element.parentNode.removeChild(element)
    }
  }

`

const CLIENT_EPILOGUE = `  }

  exports.name = 'dsh-token-feiyong'
  exports.inject = ['slots']
  exports.apply = apply
  return module.exports
  }
})
`

function buildClient() {
  let text = stripLeadingComment(read('src/client.js'), 'src/client.js')

  // 只对动态沙箱有意义：这个开关控制余额探测是否绕开工作区沙箱。
  let lines = text.split('\n')
  lines = dropLines(lines, (line) => line.includes('editing.unconfinedBalance'), 2, 'unconfinedBalance chip')
  text = lines.join('\n')

  // 冒充 cordis-panel 只是动态包用来隐藏侧边栏底部 "Cordis Plugin" 行的手段；
  // 真实安装的插件没有那一行，留着反而会挡掉 Cordis 自己的审批 UI。
  lines = text.split('\n')
  const shadowAt = lines.findIndex((line) => line.includes("slots.inject('sidebar.footer.action'"))
  if (shadowAt === -1) throw new Error('build: sidebar.footer.action shadow not found')
  if (!lines[shadowAt + 1].includes('cordis-panel') || !lines[shadowAt + 2].trim().startsWith('})')) {
    throw new Error('build: sidebar.footer.action shadow has unexpected shape')
  }
  lines.splice(shadowAt, 3)
  text = lines.join('\n')

  // 沙箱 RPC → HTTP。
  const calls = (text.match(/host\.call\(/g) ?? []).length
  if (calls !== 5) throw new Error('build: expected 5 host.call sites, found ' + String(calls))
  text = text.replace(/host\.call\(/g, 'hostCall(')

  // 沙箱自带的 styles 注册器 → 自建 <style> 注入。
  const styleInserts = (text.match(/styles\.insert\(/g) ?? []).length
  if (styleInserts !== 1) throw new Error('build: expected 1 styles.insert site, found ' + String(styleInserts))
  text = text.replace(/styles\.insert\(/g, 'installStyles(')

  // 插件外形：动态包的 return { apply } → 加载器工厂。
  text = once(text, 'return {\n  apply(ctx) {\n', CLIENT_PREAMBLE + '  function apply(ctx) {\n', 'client wrapper')

  const tail = /\n {2}\},\n\}\n?$/
  if (!tail.test(text)) throw new Error('build: client tail anchor not found')
  text = text.replace(tail, '\n' + CLIENT_EPILOGUE)

  return write('lib/client.js', text)
}

/* ------------------------------------------------------------------ */

const host = buildHost()
const client = buildClient()
console.log('lib/index.js   ' + String(Buffer.byteLength(host, 'utf8')) + ' bytes')
console.log('lib/client.js  ' + String(Buffer.byteLength(client, 'utf8')) + ' bytes')
