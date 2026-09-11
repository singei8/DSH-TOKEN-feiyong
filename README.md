# DSH-TOKEN-feiyong

> DeepSeek Harness 的 **token 计费 / 费用统计** 插件。
> 按官方价目表逐笔计算每次模型调用的花费，显示账户余额，并把账本与配置持久化到本地。

一句话：**把「这次调用花了多少钱」算清楚，并记住它。**

**下载 / 安装**：[最新版本 Releases](https://github.com/singei8/DSH-TOKEN-feiyong/releases/latest) ·
安装步骤见 [INSTALL.md](INSTALL.md) · 版本记录见 [CHANGELOG.md](CHANGELOG.md) ·
收录与发布设计见 [docs/PUBLISHING.md](docs/PUBLISHING.md)

> 这是一个**真实的 DSH 插件包**（npm 包形态，带 `dsh.bundle` 清单），不是动态 Cordis 包。
> 仓库已含预构建的 `lib/`，**安装不需要编译**：
>
> ```powershell
> dsh plugin --profile web add github:singei8/DSH-TOKEN-feiyong
> ```
>
> 然后重启 DSH。收录进官方目录后，也能在 **设置 → 插件市场** 里搜到并一键安装。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 🧮 **逐笔计费** | 拦截每一次模型调用，读取供应商上报的 `TokenUsage`，按「缓存命中输入 / 缓存未命中输入 / 输出」三类分别计价 |
| 🕘 **高峰 / 低谷** | 高峰 = 北京时间 **周一至周五 09:00–12:00、14:00–18:00**，其余为低谷；低谷单价为高峰的一半（与官方规则一致） |
| 🏷️ **多档单价** | 单价按「`provider/model` 精确匹配 → 模型名 → 默认档」匹配，每个模型可单独定价；设置页可增删档位 |
| 📊 **输入框徽标** | 输入框下方常驻：`● 高峰 · 单次 ¥0.012 · 本对话 ¥1.410 · 今日 ¥1.410 · 余额 ¥32.31`，鼠标悬停看明细 |
| ⚙️ **设置页「费用统计」** | 侧边栏 设置 → 费用统计：账户、单次、今日、累计、按模型（含实际计价档）、最近请求、单价与时段配置 |
| 💰 **账户余额** | 读取本地凭据调用 DeepSeek `/user/balance`，显示余额、赠金、充值拆分 |
| 💾 **数据落盘** | 明细 + 累计 + 单次记录 + 全部配置写入本地存档；插件更新 / DSH 重启后**合并读回**，累计不回退 |
| 🔘 **总开关** | 一键启用 / 关闭（关闭后隐藏徽标并停止余额请求，但计费仍在后台记录，不丢数据） |

### 徽标长这样

```
● 高峰 · 单次 ¥0.012345 · 本对话 ¥1.410481 · 今日 ¥1.410481 · 余额 ¥32.31
```

- **单次** = **上一轮提问**的总花费（从你发出指令到回答完成，含该轮全部模型调用）。不累计，每轮覆盖。
- **本对话** = 当前会话的累计花费（同一 `sessionId` 的所有调用）。
- **今日** = 当天累计（按设置的时区切日）。

---

## 安装（在 DSH 里启用）

本插件是**真实插件包**，由两半组成：宿主半边 `lib/index.js`（Node 进程里记账、探测余额、落盘），
客户端半边 `lib/client.js`（浏览器里的徽标与设置页）。两半通过 `/dsh-token-feiyong/*` 的 HTTP 路由通信。

```powershell
# 三种渠道任选其一
dsh plugin --profile web add github:singei8/DSH-TOKEN-feiyong   # GitHub 源码
dsh plugin --profile web add dsh-token-feiyong                  # npm（发布后）
dsh plugin --profile web add link:E:/path/to/DSH-TOKEN-feiyong   # 本地克隆目录
```

`dsh plugin` = profile 目录里 pnpm 的封装：装包之后，它会读包内的 `dsh.bundle.patch` 清单，
把包名追加进 profile 的 `dsh.profile.bundles`。**装完重启 DSH**，插件随启动挂载。

收录进 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 之后，
也可以在 **设置 → 插件市场** 里搜索（`token` / `billing` / `费用`）一键安装，那条路径会热挂载、无需重启。

> 详细步骤、手动安装（不依赖 pnpm）、不重启的热挂载验证方法、卸载与更新，
> 以及验证清单都在 [INSTALL.md](INSTALL.md)。

源码在 `src/`，构建产物在 `lib/`（两者都提交进仓库，所以安装方无需构建）：

```powershell
node scripts/build.mjs   # 只重建客户端半边：src/client.js -> lib/client.js
node scripts/check.mjs   # 87 项自检：真起 HTTP 服务跑通记账、分时计价、收口、node:fs 落盘、fetch 余额、slot 注册、重入
```

插件对宿主能力是**可选依赖**：`webServer`、`llm`、`credentials`、`shell`、`fs`、`settings` 任一缺失时，对应功能降级并在界面上说明，不会让整个插件挂掉。

---

## 计价口径（官方）

价格与时段取自官方文档 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>（本项目于 2026-09-11 核对）：

| 档位 | 对应模型 | 输入·缓存命中 | 输入·缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| Flash（默认档） | `deepseek-flash`、旧名 `deepseek-v4-flash` | 低谷 **0.02** / 高峰 **0.04** | 低谷 **1** / 高峰 **2** | 低谷 **4** / 高峰 **8** |
| Pro | `deepseek-v4-pro` | 低谷 **0.15** / 高峰 **0.30** | 低谷 **4.5** / 高峰 **9** | 低谷 **13.5** / 高峰 **27** |

单位：元 / 百万 tokens。**高峰时段为北京时间周一至周五 9:00–12:00、14:00–18:00，其余为空闲（低谷）时段；空闲价为高峰价的一半。**

### 公式

```
单次调用费用 =
  ( 命中输入 tokens × 命中单价
  + (未命中输入 tokens + 缓存写入 tokens) × 未命中单价
  + 输出 tokens × 输出单价 ) ÷ 1,000,000

本对话总费用 = Σ 单次调用费用     （同一 sessionId 的全部调用）
```

四个计数的来源（**互不重叠**，相加即完整用量）：

| 计数字段 | 含义 |
| --- | --- |
| `usage.cacheReadTokens` | 命中上下文缓存的部分，按缓存价计费 |
| `usage.inputTokens` | **已剔除命中部分**的未命中输入 |
| `usage.cacheWriteTokens` | 缓存写入，DeepSeek 目前恒为 0，仍按未命中单价兜底 |
| `usage.outputTokens` | 输出，**已包含** `reasoningTokens`，不重复计 |

想看可视化讲解与逐笔回放：打开 [`docs/billing-explained.html`](docs/billing-explained.html)（内含流程图、公式、计算器；页面里的数据是演示数据）。

---

## 配置项

设置页 → **费用统计**：

- **开关**：插件启用/关闭、余额显示、数据存档
- **计价参数**：币种符号、时区偏移（北京时间 = 480）、高峰星期（七选多）、高峰时间段（可多段，逗号分隔）、低谷比例（仅用于「低谷 = 高峰 × 比例」批量填充）
- **单价表**：每个档位独立设置「高峰 / 低谷」两套（命中 / 未命中 / 输出），可新增档位、重命名、删除
- **账户**：凭据引用（默认 `DEEPSEEK_API_KEY`）、余额接口地址
- **操作**：刷新、刷新余额、立即存档、保存、重新载入、清空账本（二次确认）

---

## 数据与隐私

- **全部本地**：插件不发送任何遥测；除余额查询外不发起任何网络请求。
- **API Key**：仅由 Host 侧按 `env` → `credentials` 服务 → `<DSH_HOME>/.credentials.yaml` 的 `refs` 段解析，只用于那条余额查询请求的 `Authorization` 头；**不进入命令行参数、不写入日志、不下发到前端**。
- **余额查询**：用 `fetch` 对 `https://api.deepseek.com/user/balance` 发起一条只读 GET，20 秒超时；不经过任何子进程。
- **存档路径**：`<DSH_HOME>/token-billing-ledger.json`（例如 `~/.dsh/token-billing-ledger.json`），格式见 [`examples/ledger.sample.json`](examples/ledger.sample.json)。

---

## 已知边界

- **子代理**（subagent）是另一个会话，单独累计，不计入主会话的「本对话」。
- **失败的调用**若没有 `usage` 上报，无法计费，因此不产生记录。
- 明细窗口保留最近 **300** 条；累计总额、按日/按模型/按会话聚合是**独立持久化**的，不会因明细滚动而回退。
- 统计只覆盖本机、本 DSH 实例；多个 DSH 进程共用同一 `DSH_HOME` 时会互相覆盖同一个存档文件。
- 高峰/低谷按**每次调用发生的时刻**判定；一次提问跨越 12:00 时，前后两笔可能分别按高峰与低谷计价。

---

## 常见问题

**Q：余额一直是 `…`？**
A：看设置页「账户余额」卡片给出的原因。常见是：凭据引用名不对（检查 `<DSH_HOME>/.credentials.yaml` 的 `refs` 段）、宿主进程访问不了 `https://api.deepseek.com`、或接口地址被改错。Host 日志里搜 `[billing]` 可看到具体结果。

**Q：存档显示异常？**
A：设置页顶部会出现红色告警条，徽标上也会出现「存档异常」；把鼠标悬停在徽标上可以看到具体错误。

**Q：单位对不上官方账单？**
A：本插件算的是「按列表价推得的理论费用」，用来对齐量级与趋势。官方实际扣费还涉及赠金优先抵扣等规则。

**Q：怎么改插件名？**
A：仓库名即项目名；插件在 DSH 里的显示名由 `lib/index.js` 的 `export const name` 与 `cordis.patch.yml` 里的行 `name` 决定，两处一致即可。

---

## 目录结构

```
DSH-TOKEN-feiyong/
├─ lib/                         # 提交进仓库的产物，安装方无需构建
│  ├─ index.js                  # 宿主半边（直接维护：HTTP 路由 / node:fs 账本 / fetch 余额）
│  └─ client.js                 # 客户端半边（构建产物：__ModuleLoader__ 工厂，导出 name/inject/apply）
├─ src/
│  ├─ client.js                 # 客户端半边源码（动态包函数体，构建输入）
│  └─ host.js                   # 动态包时代的宿主半边，历史参考，不再参与构建
├─ scripts/
│  ├─ build.mjs                 # 定点变换 + 断言：src/client.js -> lib/client.js
│  └─ check.mjs                 # 自检 87 项：真起 HTTP 服务跑通路由、记账、分时、node:fs 落盘、fetch 余额、slot
├─ cordis.patch.yml             # dsh.bundle.patch：把本插件插入 profile 的层叠配置
├─ docs/
│  ├─ billing-explained.html    # 「本对话」计费逻辑可视化：流程图 / 公式 / 逐笔回放 / 计算器
│  └─ PUBLISHING.md             # 官方收录方式与发布设计（awesome-dsh-plugin）
├─ examples/
│  └─ ledger.sample.json        # 本地存档格式示例
├─ INSTALL.md                   # 安装 / 验证 / 卸载 / 更新说明
├─ CHANGELOG.md                 # 版本记录
├─ LICENSE                      # MIT
└─ package.json                 # 含 dsh.bundle / dsh.client 清单与 exports
```

---

## License

[MIT](LICENSE)

---

## English summary

**DSH-TOKEN-feiyong** is a billing/cost-stats plugin for [DeepSeek Harness](https://github.com/deepseek-harness) (DSH), packaged as a regular DSH plugin bundle.

- Hooks the `llm/stream` waterfall, reads provider-reported `TokenUsage`, and prices each call with per-million-token rates split into **cache-hit input / cache-miss input / output**.
- Applies the official DeepSeek peak/off-peak rule (peak = Mon–Fri 09:00–12:00 & 14:00–18:00 Beijing time; off-peak is half price).
- Shows a compact badge under the composer (`single turn · this conversation · today · balance`) and a full **Settings → 费用统计** page.
- Persists the ledger, aggregates and configuration to `<DSH_HOME>/token-billing-ledger.json` and merges it back on restart, so totals never regress.
- Everything is local. The API key is never written to logs, never passed on a command line, and never sent to the browser.

Install with `dsh plugin --profile web add github:singei8/DSH-TOKEN-feiyong`, then restart DSH.
Host half `lib/index.js` serves `/dsh-token-feiyong/*`; client half `lib/client.js` registers the
composer badge and the settings section. `src/` is the source, `lib/` is the committed build
(`node scripts/build.mjs`), and `node scripts/check.mjs` runs the 72-check self-test.
