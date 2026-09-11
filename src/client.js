/*
 * DSH-TOKEN-feiyong — Client half
 * ============================================================
 * 这是 DSH「动态 Cordis 包」（dynamic package）的 Client half 半体，
 * 整个文件就是 cordis_define 参数 code.client 的**函数体本身**：
 * 开头是注释，随后直接 `return { apply(ctx) { ... } }`，没有 import/export，也不是可单独 node 运行的模块。
 *
 * 用法：把本文件内容整体作为 code.client 传给 cordis_define，再用 cordis_run 激活。
 * 平台：Client（浏览器）— 设置页「费用统计」与输入框下方徽标。
 */

/* DSH Token Billing — Client half v13：单次 / 本对话 / 今日 / 余额。 */
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const FLASH_MODELS = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']
const PRO_MODELS = ['deepseek-v4-pro']
const PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const timerService = ctx.get('timer')

    const CSS = [
      '.tb-page{display:flex;flex-direction:column;gap:12px;font-size:12px;color:var(--dsw-alias-label-primary);max-width:920px}',
      '.tb-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.tb-title{font-weight:600;font-size:15px}',
      '.tb-badge{padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}',
      '.tb-badge-off{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.tb-badge-peak{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.tb-badge-bal{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.tb-spacer{flex:1}',
      '.tb-banner{border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);border-radius:8px;padding:6px 10px;font-size:11px;line-height:1.6}',
      '.tb-banner-err{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:6px 10px;font-size:11px;line-height:1.6}',
      '.tb-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}',
      '.tb-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px}',
      '.tb-card-title{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.tb-card-value{font-size:15px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}',
      '.tb-card-value-err{font-size:11px;font-weight:400;color:var(--dsw-alias-state-warn-primary);margin-top:2px;white-space:normal;line-height:1.5}',
      '.tb-card-sub{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.tb-section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.tb-scroll{max-height:260px;overflow:auto}',
      '.tb-table{width:100%;border-collapse:collapse;font-size:11px}',
      '.tb-table th{text-align:left;color:var(--dsw-alias-label-secondary);font-weight:500;padding:3px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.tb-table td{padding:3px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.tb-num{text-align:right;font-variant-numeric:tabular-nums}',
      '.tb-cost{color:var(--dsw-alias-state-success-primary)}',
      '.tb-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.tb-field{display:flex;flex-direction:column;gap:3px}',
      '.tb-field-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.tb-input{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 7px;font-size:12px;width:100%;box-sizing:border-box}',
      '.tb-input:disabled{opacity:.7}',
      '.tb-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;font-size:12px;padding:4px 10px;white-space:nowrap}',
      '.tb-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}',
      '.tb-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-weight:600}',
      '.tb-btn:disabled{opacity:.5;cursor:default}',
      '.tb-note{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.7}',
      '.tb-notice{font-size:11px;color:var(--dsw-alias-state-success-primary)}',
      '.tb-empty{font-size:11px;color:var(--dsw-alias-label-secondary);padding:6px 0}',
      '.tb-meter{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums;line-height:1.4}',
      '.tb-meter b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.tb-meter .tb-sep{opacity:.45}',
      '.tb-state{font-weight:600}',
      '.tb-state-peak{color:var(--dsw-alias-state-error-primary)}',
      '.tb-state-off{color:var(--dsw-alias-state-success-primary)}',
      '.tb-dot{width:6px;height:6px;border-radius:50%;display:inline-block;background:var(--dsw-alias-state-error-primary)}',
      '.tb-dot-off{background:var(--dsw-alias-state-success-primary)}',
      '.tb-chip{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;font-size:12px;padding:4px 10px}',
      '.tb-chip-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}',
      '.tb-price-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-2)}',
      '.tb-triple{display:grid;grid-template-columns:44px 1fr 1fr 1fr;gap:6px;align-items:center}',
      '.tb-tag{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.tb-num-input{text-align:right}',
      '.tb-price-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:8px}',
    ].join('')

    ctx.effect(function () { return styles.insert(CSS) })

    function describe(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message.length > 0) return error.message
      return String(error)
    }

    function stateLabel(phase) { return phase.offPeak ? '低谷' : '高峰' }
    function stateClass(phase) { return phase.offPeak ? 'tb-state-off' : 'tb-state-peak' }
    function bareModel(key) { const parts = String(key).split('/'); return parts[parts.length - 1] }
    function isKnownModel(key) {
      const bare = bareModel(key)
      return FLASH_MODELS.indexOf(bare) !== -1 || PRO_MODELS.indexOf(bare) !== -1
    }
    function tierLabel(row) {
      if (row.priceMatch === 'model' || row.priceMatch === 'exact') return row.priceKey === undefined ? '—' : row.priceKey
      const bare = bareModel(row.key)
      if (FLASH_MODELS.indexOf(bare) !== -1) return 'Flash 档（默认）'
      if (PRO_MODELS.indexOf(bare) !== -1) return 'Pro 档（默认）'
      return '默认档'
    }

    function fmtInt(value) {
      const numeric = Math.round(Number(value) || 0)
      const text = String(Math.abs(numeric))
      let out = ''
      for (let index = 0; index < text.length; index += 1) {
        if (index > 0 && (text.length - index) % 3 === 0) out += ','
        out += text.charAt(index)
      }
      return (numeric < 0 ? '-' : '') + out
    }

    function fmtRate(value, currency) {
      const numeric = Number(value)
      const amount = Number.isFinite(numeric) ? numeric : 0
      const symbol = typeof currency === 'string' && currency.length > 0 ? currency : '\u00a5'
      return symbol + (Math.round(amount * 10000) / 10000)
    }

    function fmtMoney(value, currency) {
      const numeric = Number(value)
      const amount = Number.isFinite(numeric) ? numeric : 0
      const symbol = typeof currency === 'string' && currency.length > 0 ? currency : '\u00a5'
      const abs = Math.abs(amount)
      if (abs >= 100) return symbol + amount.toFixed(2)
      if (abs >= 1) return symbol + amount.toFixed(3)
      if (abs >= 0.01) return symbol + amount.toFixed(4)
      if (amount === 0) return symbol + '0'
      return symbol + amount.toFixed(6)
    }

    function fmtTok(value) {
      const numeric = Number(value) || 0
      if (numeric >= 100000000) return (numeric / 100000000).toFixed(2) + '亿'
      if (numeric >= 10000) return (numeric / 10000).toFixed(1) + '万'
      return String(Math.round(numeric))
    }

    function balanceSymbol(balance, fallback) {
      if (balance !== null && balance !== undefined && typeof balance.currency === 'string' && balance.currency.length > 0) {
        if (balance.currency === 'CNY') return '\u00a5'
        if (balance.currency === 'USD') return '$'
        return balance.currency + ' '
      }
      return fallback
    }

    function priceTip(row, currency) {
      const peak = row.pricePeak
      const off = row.priceOff
      if (peak === undefined || off === undefined) return undefined
      return '计价档：' + row.priceKey + '（' + tierLabel(row) + '）'
        + '\n高峰：命中 ' + fmtRate(peak.cacheHit, currency) + ' / 未命中 ' + fmtRate(peak.cacheMiss, currency) + ' / 输出 ' + fmtRate(peak.output, currency) + '（每百万 tokens）'
        + '\n低谷：命中 ' + fmtRate(off.cacheHit, currency) + ' / 未命中 ' + fmtRate(off.cacheMiss, currency) + ' / 输出 ' + fmtRate(off.output, currency) + '（每百万 tokens）'
    }

    function parseWindows(text) {
      const out = []
      const parts = String(text === undefined || text === null ? '' : text).split(/[,，;；\s]+/)
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index].trim()
        if (part.length === 0) continue
        const matched = /^(\d{1,2}:\d{1,2})\s*-\s*(\d{1,2}:\d{1,2})$/.exec(part)
        if (matched === null) continue
        out.push({ start: matched[1], end: matched[2] })
      }
      return out
    }

    function windowsText(windows) {
      if (!Array.isArray(windows)) return '09:00-12:00, 14:00-18:00'
      const parts = []
      for (let index = 0; index < windows.length; index += 1) {
        const window = windows[index]
        if (window === null || typeof window !== 'object') continue
        parts.push(String(window.start) + '-' + String(window.end))
      }
      return parts.join(', ')
    }

    function toDraft(config) {
      const prices = {}
      const source = (config !== null && config !== undefined && config.prices !== null && typeof config.prices === 'object') ? config.prices : {}
      const keys = Object.keys(source)
      for (let index = 0; index < keys.length; index += 1) {
        const row = source[keys[index]]
        prices[keys[index]] = {
          cacheHit: String(row.cacheHit === undefined ? 0 : row.cacheHit),
          cacheMiss: String(row.cacheMiss === undefined ? 0 : row.cacheMiss),
          output: String(row.output === undefined ? 0 : row.output),
          cacheHitOff: String(row.cacheHitOff === undefined ? 0 : row.cacheHitOff),
          cacheMissOff: String(row.cacheMissOff === undefined ? 0 : row.cacheMissOff),
          outputOff: String(row.outputOff === undefined ? 0 : row.outputOff),
        }
      }
      if (Object.keys(prices).length === 0) {
        prices['default'] = { cacheHit: '0', cacheMiss: '0', output: '0', cacheHitOff: '0', cacheMissOff: '0', outputOff: '0' }
      }
      return {
        enabled: config.enabled !== false,
        currency: (config !== null && config !== undefined && typeof config.currency === 'string') ? config.currency : '\u00a5',
        utcOffsetMinutes: String(config.utcOffsetMinutes === undefined ? 480 : config.utcOffsetMinutes),
        peakDays: Array.isArray(config.peakDays) ? config.peakDays.slice() : [1, 2, 3, 4, 5],
        peakWindowsText: windowsText(config.peakWindows),
        offPeakRatio: String(config.offPeakRatio === undefined ? 0.5 : config.offPeakRatio),
        showBalance: config.showBalance !== false,
        unconfinedBalance: config.unconfinedBalance !== false,
        persist: config.persist !== false,
        credentialRef: typeof config.credentialRef === 'string' ? config.credentialRef : 'DEEPSEEK_API_KEY',
        balanceUrl: typeof config.balanceUrl === 'string' ? config.balanceUrl : 'https://api.deepseek.com/user/balance',
        prices: prices,
      }
    }

    function fromDraft(draft) {
      const prices = {}
      const keys = Object.keys(draft.prices)
      for (let index = 0; index < keys.length; index += 1) {
        const key = String(keys[index]).trim()
        if (key.length === 0) continue
        const row = draft.prices[keys[index]]
        prices[key] = {
          cacheHit: Number(row.cacheHit) || 0,
          cacheMiss: Number(row.cacheMiss) || 0,
          output: Number(row.output) || 0,
          cacheHitOff: Number(row.cacheHitOff) || 0,
          cacheMissOff: Number(row.cacheMissOff) || 0,
          outputOff: Number(row.outputOff) || 0,
        }
      }
      if (Object.keys(prices).length === 0) {
        prices['default'] = { cacheHit: 0, cacheMiss: 0, output: 0, cacheHitOff: 0, cacheMissOff: 0, outputOff: 0 }
      }
      return {
        enabled: draft.enabled === true,
        currency: draft.currency,
        utcOffsetMinutes: Number(draft.utcOffsetMinutes),
        peakDays: draft.peakDays,
        peakWindows: parseWindows(draft.peakWindowsText),
        offPeakRatio: Number(draft.offPeakRatio),
        showBalance: draft.showBalance === true,
        unconfinedBalance: draft.unconfinedBalance === true,
        persist: draft.persist === true,
        credentialRef: draft.credentialRef,
        balanceUrl: draft.balanceUrl,
        prices: prices,
      }
    }

    function useBilling(sessionId, intervalMs, onError) {
      const [state, setState] = React.useState(null)
      const [box] = React.useState(function () { return { onError: onError } })
      box.onError = onError
      const pull = function () {
        return host.call('billing/state', { sessionId: sessionId }).then(function (next) {
          if (next !== null && typeof next === 'object') setState(next)
          return next
        }).catch(function (error) {
          if (typeof box.onError === 'function') box.onError(error)
          return null
        })
      }
      React.useEffect(function () {
        let alive = true
        const tick = function () { if (alive) pull() }
        tick()
        let dispose = null
        if (timerService !== undefined && timerService !== null && typeof timerService.interval === 'function') {
          try { dispose = timerService.interval(tick, intervalMs) } catch (error) { dispose = null }
        }
        /* 没有 timer 服务时退回浏览器定时器。
           真实客户端的组合里并不保证有 timer（启动清单里就没有），而这里只拉一次的话，
           徽标会永远停在挂载那一帧——那时余额还在异步获取中，于是永远是「…」，
           而设置页因为会再次拉取所以能显示。 */
        if (dispose === null && typeof window !== 'undefined' && typeof window.setInterval === 'function') {
          const handle = window.setInterval(tick, intervalMs)
          dispose = function () { window.clearInterval(handle) }
        }
        return function () {
          alive = false
          if (typeof dispose === 'function') {
            try { dispose() } catch (error) { /* 已释放 */ }
          }
        }
      }, [sessionId])
      return { state: state, setState: setState, pull: pull }
    }

    function card(title, value, sub, isError) {
      return React.createElement('div', { className: 'tb-card', key: title },
        React.createElement('div', { className: 'tb-card-title' }, title),
        React.createElement('div', { className: isError === true ? 'tb-card-value-err' : 'tb-card-value' }, value),
        sub === undefined ? null : React.createElement('div', { className: 'tb-card-sub' }, sub))
    }

    function cards(items) { return React.createElement('div', { className: 'tb-cards' }, items) }

    function table(columns, rows, emptyText) {
      if (rows.length === 0) return React.createElement('div', { className: 'tb-empty' }, emptyText)
      const head = React.createElement('tr', null, columns.map(function (column, index) {
        return React.createElement('th', { key: String(index), className: column.num ? 'tb-num' : null }, column.label)
      }))
      return React.createElement('div', { className: 'tb-scroll' },
        React.createElement('table', { className: 'tb-table' },
          React.createElement('thead', null, head),
          React.createElement('tbody', null, rows)))
    }

    function field(label, value, onChange, hint) {
      return React.createElement('label', { className: 'tb-field', key: label },
        React.createElement('span', { className: 'tb-field-label' }, label),
        React.createElement('input', {
          className: 'tb-input',
          value: value,
          onChange: function (event) { onChange(event.target.value) },
        }),
        hint === undefined ? null : React.createElement('span', { className: 'tb-field-label' }, hint))
    }

    function BillingMeter(props) {
      const sessionId = (props !== null && props !== undefined && typeof props.sessionId === 'string' && props.sessionId.length > 0)
        ? props.sessionId
        : null
      const billing = useBilling(sessionId, 3000, null)
      const state = billing.state
      if (state === null) return null
      const config = state.config
      if (config.enabled === false) return null
      const phase = state.phase
      const balance = state.balance
      const store = (state.store === undefined || state.store === null) ? null : state.store
      const lastTurn = (state.lastTurn === undefined || state.lastTurn === null) ? null : state.lastTurn
      const today = (state.todayTotals === undefined || state.todayTotals === null) ? state.totals : state.todayTotals
      const session = state.sessionTotals
      const showBalance = config.showBalance !== false
      const balanceOk = balance !== undefined && balance !== null && balance.ok === true
      const storeBroken = config.persist !== false && store !== null
        && (store.ready !== true || (typeof store.error === 'string' && store.error.length > 0))
      const tipLines = [
        '当前时段：' + stateLabel(phase) + '（' + phase.dayLabel + ' ' + phase.clock + '）',
        '高峰规则：' + phase.peakDaysText + ' ' + phase.peakWindowsText + '（' + phase.offsetLabel + '）',
      ]
      if (lastTurn === null) {
        tipLines.push('单次花费：还没有完成一轮提问')
      } else {
        tipLines.push('单次花费（上一次提问，含该轮全部调用）：' + fmtMoney(lastTurn.cost, config.currency))
        tipLines.push('  时间 ' + lastTurn.atText + (lastTurn.turn > 0 ? ' · 第 ' + String(lastTurn.turn) + ' 轮' : '')
          + ' · ' + String(lastTurn.calls) + ' 次调用'
          + ' · 命中 ' + fmtTok(lastTurn.hit) + ' / 未命中 ' + fmtTok(lastTurn.miss) + ' / 输出 ' + fmtTok(lastTurn.out))
      }
      tipLines.push('本对话总花费 ' + fmtMoney(session.cost, config.currency)
        + '（命中 ' + fmtTok(session.hit) + ' / 未命中 ' + fmtTok(session.miss) + ' / 输出 ' + fmtTok(session.out) + ' tokens，' + String(session.calls) + ' 次调用）')
      tipLines.push('今日总花费 ' + fmtMoney(today.cost, config.currency) + '（' + String(today.calls) + ' 次调用）')
      if (showBalance) {
        if (balanceOk) {
          tipLines.push('账户余额 ' + fmtMoney(balance.total, balanceSymbol(balance, config.currency))
            + '（赠金 ' + fmtMoney(balance.granted, balanceSymbol(balance, config.currency))
            + ' / 充值 ' + fmtMoney(balance.toppedUp, balanceSymbol(balance, config.currency)) + '）')
        } else if (balance !== undefined && balance !== null && typeof balance.error === 'string' && balance.error.length > 0) {
          tipLines.push('余额获取失败：' + balance.error)
        } else {
          tipLines.push('余额获取中…')
        }
      }
      if (storeBroken) {
        tipLines.push('⚠ 数据存档异常：' + (store.ready !== true ? '未初始化' : store.error))
      } else if (store !== null && typeof store.savedAtText === 'string' && store.savedAtText.length > 0) {
        tipLines.push('数据存档：已保存 ' + store.savedAtText)
      }
      tipLines.push('（在 设置 → 费用统计 中可关闭此徽标）')
      const children = [
        React.createElement('span', { className: 'tb-dot' + (phase.offPeak ? ' tb-dot-off' : '') }),
        React.createElement('span', { className: 'tb-state ' + stateClass(phase) }, stateLabel(phase)),
        React.createElement('span', { className: 'tb-sep' }, '·'),
        React.createElement('span', null, '单次 '),
        React.createElement('b', null, lastTurn === null ? '—' : fmtMoney(lastTurn.cost, config.currency)),
        React.createElement('span', { className: 'tb-sep' }, '·'),
        React.createElement('span', null, '本对话 '),
        React.createElement('b', null, fmtMoney(session.cost, config.currency)),
        React.createElement('span', { className: 'tb-sep' }, '·'),
        React.createElement('span', null, '今日 '),
        React.createElement('b', null, fmtMoney(today.cost, config.currency)),
      ]
      if (showBalance) {
        children.push(React.createElement('span', { className: 'tb-sep' }, '·'))
        children.push(React.createElement('span', null, '余额 '))
        children.push(React.createElement('b', null, balanceOk
          ? fmtMoney(balance.total, balanceSymbol(balance, config.currency))
          : '…'))
      }
      if (storeBroken) {
        children.push(React.createElement('span', { className: 'tb-sep' }, '·'))
        children.push(React.createElement('span', { className: 'tb-state tb-state-peak' }, '存档异常'))
      }
      return React.createElement('div', { className: 'tb-meter', title: tipLines.join('\n') }, children)
    }

    function BillingPanel() {
      const [draft, setDraft] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [confirmClear, setConfirmClear] = React.useState(false)
      const billing = useBilling(null, 2500, function (error) {
        setNotice('读取账单失败：' + describe(error))
      })
      const state = billing.state

      if (state === null) {
        return React.createElement('div', { className: 'tb-page' },
          React.createElement('div', { className: 'tb-title' }, '费用统计'),
          React.createElement('div', { className: 'tb-empty' }, '正在读取账本…' + (notice.length > 0 ? ' ' + notice : '')))
      }

      const config = state.config
      const phase = state.phase
      const balance = (state.balance === undefined || state.balance === null) ? null : state.balance
      const store = (state.store === undefined || state.store === null) ? null : state.store
      const lastTurn = (state.lastTurn === undefined || state.lastTurn === null) ? null : state.lastTurn
      const editing = draft !== null ? draft : toDraft(config)
      const priceKeys = Object.keys(editing.prices)
      const total = state.totals
      const today = (state.todayTotals === undefined || state.todayTotals === null) ? state.totals : state.todayTotals
      const hitRate = (total.hit + total.miss) > 0 ? (total.hit / (total.hit + total.miss) * 100) : 0
      const balanceSymbolText = balanceSymbol(balance, config.currency)
      const enabled = config.enabled !== false
      const storeBroken = config.persist !== false && store !== null
        && (store.ready !== true || (typeof store.error === 'string' && store.error.length > 0))

      const disarmClear = function () { setConfirmClear(false) }
      const change = function (patch) { setDraft(Object.assign({}, editing, patch)) }
      const changePrice = function (key, name, value) {
        const prices = Object.assign({}, editing.prices)
        prices[key] = Object.assign({}, prices[key])
        prices[key][name] = value
        setDraft(Object.assign({}, editing, { prices: prices }))
      }
      const renameKey = function (from, to) {
        const clean = String(to).slice(0, 90)
        const prices = {}
        for (let index = 0; index < priceKeys.length; index += 1) {
          const key = priceKeys[index]
          if (key === from) {
            if (clean.length > 0) prices[clean] = editing.prices[key]
          } else {
            prices[key] = editing.prices[key]
          }
        }
        if (Object.keys(prices).length === 0) prices['default'] = { cacheHit: '0', cacheMiss: '0', output: '0', cacheHitOff: '0', cacheMissOff: '0', outputOff: '0' }
        setDraft(Object.assign({}, editing, { prices: prices }))
      }
      const removeKey = function (key) {
        if (priceKeys.length <= 1) return
        const prices = {}
        for (let index = 0; index < priceKeys.length; index += 1) {
          if (priceKeys[index] !== key) prices[priceKeys[index]] = editing.prices[priceKeys[index]]
        }
        if (prices['default'] === undefined) prices['default'] = { cacheHit: '0', cacheMiss: '0', output: '0', cacheHitOff: '0', cacheMissOff: '0', outputOff: '0' }
        setDraft(Object.assign({}, editing, { prices: prices }))
      }
      const addKey = function (name) {
        const prices = Object.assign({}, editing.prices)
        let key = String(name)
        let suffix = 1
        while (prices[key] !== undefined) {
          suffix += 1
          key = String(name) + '-' + suffix
        }
        prices[key] = { cacheHit: '0', cacheMiss: '0', output: '0', cacheHitOff: '0', cacheMissOff: '0', outputOff: '0' }
        setDraft(Object.assign({}, editing, { prices: prices }))
      }
      const toggleDay = function (day) {
        const days = Array.isArray(editing.peakDays) ? editing.peakDays.slice() : []
        const at = days.indexOf(day)
        if (at === -1) days.push(day)
        else days.splice(at, 1)
        days.sort(function (left, right) { return left - right })
        change({ peakDays: days })
      }
      const fillOffPeak = function () {
        const ratio = Number(editing.offPeakRatio)
        const use = (Number.isFinite(ratio) && ratio >= 0) ? ratio : 0.5
        const round = function (value) { return Math.round(value * 10000) / 10000 }
        const prices = {}
        for (let index = 0; index < priceKeys.length; index += 1) {
          const key = priceKeys[index]
          const row = editing.prices[key]
          prices[key] = Object.assign({}, row, {
            cacheHitOff: String(round((Number(row.cacheHit) || 0) * use)),
            cacheMissOff: String(round((Number(row.cacheMiss) || 0) * use)),
            outputOff: String(round((Number(row.output) || 0) * use)),
          })
        }
        setDraft(Object.assign({}, editing, { prices: prices }))
      }
      const submit = function (nextDraft, message) {
        disarmClear()
        setBusy(true)
        setNotice('')
        host.call('billing/save', { sessionId: null, config: fromDraft(nextDraft) }).then(function (next) {
          if (next !== null && typeof next === 'object') billing.setState(next)
          setDraft(null)
          setBusy(false)
          setNotice(message)
        }).catch(function (error) {
          setBusy(false)
          setNotice('保存失败：' + describe(error))
        })
      }
      const save = function () { submit(editing, '配置已保存并写入存档') }
      const toggleEnabled = function () {
        const next = Object.assign({}, editing, { enabled: !editing.enabled })
        submit(next, next.enabled ? '已启用' : '已关闭')
      }
      const flushStore = function () {
        disarmClear()
        setBusy(true)
        setNotice('')
        host.call('billing/store', { sessionId: null }).then(function (next) {
          if (next !== null && typeof next === 'object') billing.setState(next)
          setBusy(false)
          setNotice('已写入存档')
        }).catch(function (error) {
          setBusy(false)
          setNotice('写入存档失败：' + describe(error))
        })
      }
      const refreshBalance = function () {
        disarmClear()
        setBusy(true)
        setNotice('')
        host.call('billing/balance', { sessionId: null, force: true }).then(function (next) {
          if (next !== null && typeof next === 'object') billing.setState(next)
          setBusy(false)
          setNotice('余额已刷新')
        }).catch(function (error) {
          setBusy(false)
          setNotice('余额刷新失败：' + describe(error))
        })
      }
      const clearLedger = function () {
        if (confirmClear !== true) {
          setConfirmClear(true)
          setNotice('再次点击「确认清空」将删除全部累计、单次记录与明细，且不可恢复')
          return
        }
        setConfirmClear(false)
        setBusy(true)
        setNotice('')
        host.call('billing/reset', { scope: 'all', sessionId: null }).then(function (next) {
          if (next !== null && typeof next === 'object') billing.setState(next)
          setBusy(false)
          setNotice('账本与累计已清空，并写入存档')
        }).catch(function (error) {
          setBusy(false)
          setNotice('清空失败：' + describe(error))
        })
      }

      const requestRows = state.rowsAll.map(function (row) {
        return React.createElement('tr', { key: String(row.seq) },
          React.createElement('td', null, row.time),
          React.createElement('td', null, row.model),
          React.createElement('td', { className: 'tb-num' }, fmtInt(row.hit)),
          React.createElement('td', { className: 'tb-num' }, fmtInt(row.miss)),
          React.createElement('td', { className: 'tb-num' }, fmtInt(row.out)),
          React.createElement('td', { className: row.offPeak ? 'tb-state-off' : 'tb-state-peak' }, row.offPeak ? '低谷' : '高峰'),
          React.createElement('td', { className: 'tb-num tb-cost' }, fmtMoney(row.cost, config.currency)))
      })

      const modelRows = state.byModel.map(function (row) {
        const tip = priceTip(row, config.currency)
        const unknown = row.priceMatch === 'default' && !isKnownModel(row.key)
        return React.createElement('tr', { key: row.key },
          React.createElement('td', null, row.key),
          React.createElement('td', { className: unknown ? 'tb-warn' : null, title: tip },
            unknown ? tierLabel(row) + ' · 未知模型' : tierLabel(row)),
          React.createElement('td', { className: 'tb-num' }, fmtInt(row.calls)),
          React.createElement('td', { className: 'tb-num' }, fmtInt(row.hit)),
          React.createElement('td', { className: 'tb-num' }, fmtInt(row.miss)),
          React.createElement('td', { className: 'tb-num' }, fmtInt(row.out)),
          React.createElement('td', { className: 'tb-num tb-cost' }, fmtMoney(row.cost, config.currency)))
      })

      const balanceCard = (function () {
        if (config.showBalance === false) return card('账户余额', '已关闭', '在下方打开')
        if (balance === null) return card('账户余额', '读取中…')
        if (balance.ok !== true) return card('账户余额', (balance.error === undefined || balance.error === null || balance.error.length === 0) ? '获取失败' : balance.error, '点“刷新余额”重试', true)
        return card('账户余额', fmtMoney(balance.total, balanceSymbolText),
          '赠金 ' + fmtMoney(balance.granted, balanceSymbolText) + ' · 充值 ' + fmtMoney(balance.toppedUp, balanceSymbolText))
      })()

      const storeCard = (function () {
        if (config.persist === false) return card('数据存档', '已关闭', '重启后会重置')
        if (store === null || store.ready !== true) {
          return card('数据存档', '初始化中…', store !== null && typeof store.path === 'string' && store.path.length > 0 ? store.path : '正在定位存档路径')
        }
        if (typeof store.error === 'string' && store.error.length > 0) return card('数据存档', '写入失败', store.error, true)
        return card('数据存档', store.savedAtText !== undefined && store.savedAtText.length > 0 ? '已保存 ' + store.savedAtText : '待写入',
          '含历史累计 · ' + store.path)
      })()

      const numInput = function (key, name) {
        return React.createElement('input', {
          className: 'tb-input tb-num-input',
          value: editing.prices[key][name],
          onChange: function (event) { changePrice(key, name, event.target.value) },
        })
      }

      const priceBlocks = priceKeys.map(function (key) {
        const isDefault = key === 'default'
        const used = state.byModel.filter(function (row) { return row.priceKey === key })
        const rowOf = function (tag, first, second, third) {
          return React.createElement('div', { className: 'tb-triple' },
            React.createElement('span', { className: 'tb-tag' }, tag),
            numInput(key, first),
            numInput(key, second),
            numInput(key, third))
        }
        const hint = isDefault
          ? '默认档 = Flash 价格，覆盖 ' + FLASH_MODELS.join(' / ') + '，也是未知模型的兜底'
          : (used.length === 0 ? '当前无模型套用此档' : '当前套用：' + used.map(function (row) { return row.key }).join('、'))
        return React.createElement('div', { className: 'tb-price-card', key: key },
          React.createElement('div', { className: 'tb-head' },
            React.createElement('input', {
              className: 'tb-input',
              value: key,
              disabled: isDefault,
              onChange: function (event) { renameKey(key, event.target.value) },
            }),
            React.createElement('span', { className: 'tb-spacer' }),
            React.createElement('button', {
              className: 'tb-btn',
              disabled: isDefault || priceKeys.length <= 1,
              onClick: function () { removeKey(key) },
            }, '删除')),
          React.createElement('div', { className: 'tb-triple' },
            React.createElement('span', { className: 'tb-field-label' }, ''),
            React.createElement('span', { className: 'tb-field-label' }, '命中输入'),
            React.createElement('span', { className: 'tb-field-label' }, '未命中输入'),
            React.createElement('span', { className: 'tb-field-label' }, '输出')),
          rowOf('高峰', 'cacheHit', 'cacheMiss', 'output'),
          rowOf('低谷', 'cacheHitOff', 'cacheMissOff', 'outputOff'),
          React.createElement('div', { className: 'tb-card-sub' }, hint))
      })

      const known = state.knownModels.filter(function (key) { return editing.prices[key] === undefined })
      const knownChips = known.length === 0 ? null : React.createElement('div', { className: 'tb-head' },
        React.createElement('span', { className: 'tb-field-label' }, '已见模型：'),
        known.map(function (key) {
          return React.createElement('button', { className: 'tb-btn', key: key, onClick: function () { addKey(key) } }, '+ ' + key)
        }))

      const dayChips = WEEK_LABELS.map(function (label, index) {
        const day = index + 1
        const on = Array.isArray(editing.peakDays) && editing.peakDays.indexOf(day) !== -1
        return React.createElement('button', {
          className: 'tb-chip' + (on ? ' tb-chip-on' : ''),
          key: 'day-' + day,
          onClick: function () { toggleDay(day) },
        }, label)
      })

      return React.createElement('div', { className: 'tb-page' },
        React.createElement('div', { className: 'tb-head' },
          React.createElement('span', { className: 'tb-title' }, '费用统计'),
          React.createElement('span', { className: 'tb-badge ' + (enabled ? (phase.offPeak ? 'tb-badge-off' : 'tb-badge-peak') : '') },
            enabled ? (stateLabel(phase) + ' · ' + phase.dayLabel + ' ' + phase.clock) : '已关闭'),
          balance !== null && balance.ok === true
            ? React.createElement('span', { className: 'tb-badge tb-badge-bal' }, '余额 ' + fmtMoney(balance.total, balanceSymbolText))
            : null),
        React.createElement('div', { className: 'tb-head' },
          React.createElement('button', { className: 'tb-chip' + (enabled ? ' tb-chip-on' : ''), disabled: busy, onClick: toggleEnabled },
            enabled ? '插件：已启用' : '插件：已关闭'),
          React.createElement('button', { className: 'tb-chip' + (editing.showBalance ? ' tb-chip-on' : ''), onClick: function () { change({ showBalance: !editing.showBalance }) } },
            editing.showBalance ? '余额显示：开' : '余额显示：关'),
          React.createElement('button', { className: 'tb-chip' + (editing.unconfinedBalance ? ' tb-chip-on' : ''), onClick: function () { change({ unconfinedBalance: !editing.unconfinedBalance }) } },
            editing.unconfinedBalance ? '余额请求：非沙箱' : '余额请求：沙箱'),
          React.createElement('button', { className: 'tb-chip' + (editing.persist ? ' tb-chip-on' : ''), onClick: function () { change({ persist: !editing.persist }) } },
            editing.persist ? '数据存档：开' : '数据存档：关'),
          React.createElement('span', { className: 'tb-spacer' }),
          React.createElement('button', { className: 'tb-btn', disabled: busy, onClick: function () { disarmClear(); billing.pull() } }, '刷新'),
          React.createElement('button', { className: 'tb-btn', disabled: busy, onClick: refreshBalance }, '刷新余额'),
          React.createElement('button', { className: 'tb-btn', disabled: busy, onClick: flushStore }, '立即存档'),
          React.createElement('button', { className: 'tb-btn tb-btn-primary', disabled: busy, onClick: save }, busy ? '处理中…' : '保存'),
          React.createElement('button', { className: 'tb-btn', disabled: busy, onClick: function () { disarmClear(); setDraft(null); setNotice('已重新载入') } }, '重新载入'),
          React.createElement('button', { className: 'tb-btn' + (confirmClear ? ' tb-btn-danger' : ''), disabled: busy, onClick: clearLedger },
            confirmClear ? '确认清空' : '清空账本')),
        storeBroken
          ? React.createElement('div', { className: 'tb-banner-err' },
            '数据存档异常，累计可能无法保留：' + (store.ready !== true ? '尚未初始化完成' : store.error)
              + (store !== null && typeof store.path === 'string' && store.path.length > 0 ? '（' + store.path + '）' : ''))
          : null,
        enabled ? null : React.createElement('div', { className: 'tb-banner' },
          '插件已关闭：输入框下方的费用徽标不再显示，也不再请求账户余额。计费只在后台继续记录（数据不丢），重新开启后立即可见。'),
        React.createElement('div', { className: 'tb-section-title' }, '账户'),
        React.createElement('div', { className: 'tb-cards' }, [
          balanceCard,
          storeCard,
          card('当前时段', React.createElement('span', { className: stateClass(phase) }, stateLabel(phase)),
            phase.dayLabel + ' ' + phase.clock + ' · ' + phase.peakDaysText + ' ' + phase.peakWindowsText),
          card('单次花费', lastTurn === null ? '—' : fmtMoney(lastTurn.cost, config.currency),
            lastTurn === null ? '还没有完成一轮提问' : (lastTurn.atText + ' · ' + String(lastTurn.calls) + ' 次调用' + (lastTurn.turn > 0 ? ' · 第 ' + String(lastTurn.turn) + ' 轮' : ''))),
          card('今日花费', fmtMoney(today.cost, config.currency), today.calls + ' 次调用'),
        ]),
        React.createElement('div', { className: 'tb-section-title' }, '累计（含历史存档，不随重启重置）'),
        cards([
          card('总花费', fmtMoney(total.cost, config.currency), total.calls + ' 次调用'),
          card('缓存命中输入', fmtInt(total.hit), '命中率 ' + hitRate.toFixed(1) + '%'),
          card('缓存未命中输入', fmtInt(total.miss)),
          card('缓存写入', fmtInt(total.write), '按未命中单价计费'),
          card('输出', fmtInt(total.out)),
          card('低谷调用', fmtInt(total.offPeakCalls), '高峰 ' + fmtInt(total.calls - total.offPeakCalls) + ' 次'),
        ]),
        React.createElement('div', { className: 'tb-section-title' }, '按模型（悬停「计价档」可看该档两套单价）'),
        table([
          { label: '模型' }, { label: '计价档' }, { label: '次数', num: true }, { label: '命中', num: true },
          { label: '未命中', num: true }, { label: '输出', num: true }, { label: '费用', num: true },
        ], modelRows, '尚无调用记录'),
        React.createElement('div', { className: 'tb-section-title' }, '最近请求'),
        table([
          { label: '时间' }, { label: '模型' }, { label: '命中', num: true },
          { label: '未命中', num: true }, { label: '输出', num: true }, { label: '时段' }, { label: '费用', num: true },
        ], requestRows, '尚无调用记录'),
        React.createElement('div', { className: 'tb-section-title' }, '计价口径'),
        React.createElement('div', { className: 'tb-head' },
          field('币种符号', editing.currency, function (value) { change({ currency: value.slice(0, 4) }) }, '如 ¥ / $'),
          field('时区偏移（分钟）', editing.utcOffsetMinutes, function (value) { change({ utcOffsetMinutes: value }) }, '北京时间 = 480'),
          field('凭据引用', editing.credentialRef, function (value) { change({ credentialRef: value }) }, '默认 DEEPSEEK_API_KEY'),
          field('余额接口', editing.balanceUrl, function (value) { change({ balanceUrl: value }) }),
          field('低谷比例（批量填充用）', editing.offPeakRatio, function (value) { change({ offPeakRatio: value }) }, '0.5 = 五折'),
          React.createElement('button', { className: 'tb-btn', onClick: fillOffPeak }, '低谷 = 高峰 × 比例')),
        React.createElement('div', { className: 'tb-head' },
          React.createElement('span', { className: 'tb-field-label' }, '高峰星期：'),
          dayChips),
        React.createElement('div', { className: 'tb-head' },
          field('高峰时间段（逗号分隔，可多段）', editing.peakWindowsText, function (value) { change({ peakWindowsText: value }) }, '例：09:00-12:00, 14:00-18:00；当前 ' + phase.peakDaysText + ' ' + phase.peakWindowsText + '（' + phase.offsetLabel + '）')),
        React.createElement('div', { className: 'tb-section-title' }, '每百万 tokens 单价（高峰 / 低谷各一套）'),
        React.createElement('div', { className: 'tb-price-grid' }, priceBlocks),
        React.createElement('div', { className: 'tb-head' },
          React.createElement('button', { className: 'tb-btn', onClick: function () { addKey('new-model') } }, '+ 新增模型')),
        knownChips,
        React.createElement('div', { className: 'tb-note' },
          '状态栏徽标：单次 = 上一轮提问（从你发出指令到回答完成）产生的全部费用，不累计；本对话 = 当前对话的累计费用；今日 = 当天累计。',
          '单次口径：以「一轮提问」为界，包含该轮内所有模型调用（含重试与压缩）；子代理属于另一个会话，不计入本对话。',
          '计价档：官方只有两档 —— Flash（deepseek-flash / 旧名 deepseek-v4-flash 共用）与 Pro（deepseek-v4-pro）；默认档就是 Flash 价格。',
          '时段口径与官方一致：高峰 = 北京时间周一至周五 09:00-12:00、14:00-18:00，其余为低谷；低谷单价 = 高峰的一半。来源：' + PRICING_SOURCE,
          '数据存档：明细 + 累计 + 单次记录 + 全部配置自动写盘，更新/重启后合并读回；异常会在告警条与徽标提示。',
          '存档路径：' + (store !== null && typeof store.path === 'string' && store.path.length > 0 ? store.path : '（初始化中）')),
        notice.length > 0 ? React.createElement('div', { className: 'tb-notice' }, notice) : null)
    }

    slots.inject('settings.section', function () {
      return slots.register({ name: 'settings.section', id: 'token-billing', order: 30, label: '费用统计' }, BillingPanel)
    })

    slots.inject('conversation.composer.dock', function () {
      return slots.register({ name: 'conversation.composer.dock', id: 'token-billing', order: 1 }, BillingMeter)
    })

    slots.inject('sidebar.footer.action', function () {
      return slots.register({ name: 'sidebar.footer.action', id: 'cordis-panel' }, function () { return null })
    })
  },
}
