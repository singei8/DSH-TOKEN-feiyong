/**
 * 构建脚本：把动态 Cordis 包的客户端函数体转成真实插件的浏览器半边。
 *
 *   src/client.js  (cordis_define 的 code.client 函数体)  ->  lib/client.js
 *
 * 宿主半边不在这里生成。`lib/index.js` 是直接维护的来源文件：真实插件要用
 * node:fs 读写账本、用 fetch 拉余额，并对客户端暴露 HTTP 路由，这些无法从
 * 「沙箱函数体」变换得到（详见 lib/index.js 顶部说明）。本脚本只负责客户端
 * 半边，因为那一侧的差异是纯包装：工程格式不同，逻辑完全一致。
 *
 * 变换是定点替换，每一处都断言命中，避免源文件改动后静默产出错误产物：
 *
 *   1. 包进 window.__ModuleLoader__.load({ id, factory })，导出 name/inject/apply
 *   2. require('react') 供 React.createElement 使用
 *   3. host.call(m, a)  →  hostCall(m, a)（POST 到宿主路由）
 *   4. styles.insert(CSS)  →  installStyles(CSS)（自建 <style>，交 ctx.effect 托管）
 *   5. 去掉冒充 cordis-panel 的 sidebar.footer.action 注册
 *   6. 去掉只对动态沙箱有意义的「余额请求：沙箱」开关
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
  // 真实安装的插件没有那一行。
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

const client = buildClient()
console.log('lib/client.js  ' + String(Buffer.byteLength(client, 'utf8')) + ' bytes')
console.log('lib/index.js   宿主半边是直接维护的来源文件，本脚本不生成')
