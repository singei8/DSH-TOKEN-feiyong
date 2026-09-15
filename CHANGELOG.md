# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)；每个版本对应一次 GitHub Release。

## [1.3.0] — 2026-09-13

**新增内置官方价目表，并补上智谱 GLM 两个模型的单价。**

### 新增

- **内置官方价目表 `BUILTIN_PRICES`**：查找顺序变为
  `用户 provider/model → 用户 模型名 → 内置 provider/model → 内置 模型名 → default`。

  这一层是必需的：账本里存过的 `config.prices` 会整体替换**用户档位**，直接改代码默认值
  对已有安装无效（新模型仍会按 `default`，即 DeepSeek Flash 计价）。有了内置表，
  新版本补充的模型单价对老存档立即生效，而用户在设置页新增的同名档位优先级更高、可随时覆盖。
- **GLM-5.3-Flash**：输入 ¥0.8 / 输出 ¥2.8 / 缓存命中 ¥0.23（元/百万 tokens）。
- **GLM-4.7**：输入 ¥4 / 输出 ¥16 / 缓存命中 ¥0.8 —— 官方按输入长度分三档，取
  输入 `[32K, 200K)` 档；另两档（¥2/¥8/命中 ¥0.4、¥3/¥14/命中 ¥0.6）可在设置页新增同名档位覆盖。
- GLM 不分高峰 / 低谷，两套单价相同，所以时段不影响 GLM 计价。
- 设置页「按模型」的计价档一列，内置档显示为 `模型名（内置）`。

来源：<https://docs.bigmodel.cn/cn/guide/start/pricing>（2026-09-13 核对）。

### 实测

- 自检扩到 **134 项**：GLM 两档从内置表解析（`priceMatch = builtin`）、单价与费用算式、
  低谷时段同价、以及「用户同名档位覆盖内置表」。
- 真实宿主实测（对着一份只有 DeepSeek 两档的旧存档）：
  `zai-coding-cn/glm-5.3-flash`、`openai/glm-5.3-flash`、`openai/glm-4.7` 三条都正确解析到
  `builtin` 档，单价分别为 0.23/0.8/2.8 与 0.8/4/16。

> 说明：历史记录里的费用是调用当时按旧档位算好存下的，不会被回溯重算；新发生的调用按新档位计价。

## [1.2.0] — 2026-09-13

**侧边对话与子代理的花费并入所属主对话。**

better-sidebar 的「侧边对话」和内置子代理都跑在**子会话**里：会话头写着
`parentSession`，而 `llm/stream` 上报的是子会话自己的会话 id，于是花费落在另一个桶里，
看起来「没算进主对话」。现在按会话血缘归并。

### 新增

- **子会话归并**：读取时把「本会话 + 其全部子会话」合成「本对话」与「单次」。
  归属有两条来源：
  1. 运行中读宿主 `sessions` 服务的会话头 `parentSession`；
  2. 调用时把归属记进账本的 `lineage`（子会话结束后依然有效）。

  聚合本身仍按真实会话记录（`bySession` 语义不变），所以历史数据不受影响、也不会双重计数，
  `sessions` 明细里照样能看到每个子会话自己的花费。
- **历史子会话收养**：升级前就存在、如今已结束因而查不到归属的子会话，读它自己的会话日志
  `<DSH_HOME>/sessions/<工作区>/<会话 id>/session.v3.jsonl.zstd` 的**第一帧**，
  只解析第一行（会话头）里的 `parentSession`，**不读对话内容**；有界（最多 60 个会话、
  每个最多 4 帧），失败即跳过。
- **设置页**：新增「子会话：并入本对话 / 单独统计」开关，以及「本对话的子会话」明细表
  （每个子会话的次数、token 与费用）；徽标悬停提示也会列出子会话合计。

### 实测

- 自检扩到 **119 项**：归并口径、开关切换、`lineage` 落档、会话消失后仍归并、
  以及从会话日志收养历史子会话。
- 真实宿主（DSH Desktop）实测：主会话 `session-66113abe` 归并后 **643 次调用 /
  ¥4.77997596**，其中 4 个子会话合计 ¥2.01828156 —— 两个来自活会话注册表
  （`session-a5c703b6`、`session-59462b22`），两个来自会话日志收养
  （`263d927f`、`fdabed3b`，共 ¥1.81506736）。

## [1.1.2] — 2026-09-11

修复输入框下方徽标里的「余额 …」永远不更新（设置页却能看到余额）。

### 修复

- **徽标余额停在「…」**：`useBilling` 只在客户端提供 `timer` 服务时才轮询
  （`ctx.get('timer')`），而真实客户端的启动清单里**没有 timer 模块** ——
  于是徽标只渲染挂载那一帧，而那一帧的余额还在异步获取中，就永远显示「…」；
  设置页因为会再次拉取所以正常。现在没有 timer 服务时退回浏览器 `setInterval`
  （仍随 effect 注销一并清理）。

### 实测

`scripts/check.mjs` 扩到 **96 项**，新增一个真正的功能回归：用只实现
`useState`/`useEffect` 的迷你 React 渲染徽标、执行它的 effect，断言它自己起了
3000ms 轮询、挂载即拉一次、轮询回调会再拉、卸载时清理掉 interval。

同时确认服务端已经在提供修好的 bundle：启动清单里该插件的 URL `rev` 由
`d2132e10bdf01024-66` 变为 `23bad5ee4809`，取回内容与本地构建一致 ——
客户端半边是按请求从磁盘读的，所以**这一项只需刷新页面，不必重启**。

## [1.1.1] — 2026-09-11

修复真实宿主里徽标显示「存档异常」的问题。1.1.0 虽然把插件改成了真实插件包，
但 I/O 层仍照搬动态沙箱的写法 —— 而那几个服务在根级插件里根本拿不到。

### 修复

- **「存档异常」/ `fs 服务不可用`**：`fs`、`credentials`、`shell` 是由 `dsh-fs-local`、
  `dsh-credentials-local`、`dsh-shell` 等**按作用域**提供的服务，挂在 profile 根级的插件
  `ctx.get(...)` 拿到的是 `undefined`（动态沙箱那份 ctx 由 runner 包装过，所以那时能用）。
  现在账本改用 `node:fs` 直接读写 `<DSH_HOME>/token-billing-ledger.json`，
  **路径与旧版一致，历史账本继续沿用**。
- **余额**：不再起 PowerShell 子进程，改用 `fetch` 调 `/user/balance`（20 秒超时）；
  凭据按 `env` → `credentials` 服务 → `<DSH_HOME>/.credentials.yaml` 的 `refs` 段依次尝试。
  密钥只进请求头，不写日志、不下发前端。

### 变更

- `scripts/build.mjs` 不再生成宿主半边：`lib/index.js` 成为**直接维护的来源文件**
  （真实插件要用 `node:fs`/`fetch` 并挂 HTTP 路由，无法从沙箱函数体变换得到）。
  `src/host.js` 保留为动态包时代的历史参考，不再参与构建。
- `scripts/check.mjs` 扩到 **87 项**：新增 `node:fs` 落盘（在临时 `DSH_HOME` 下）、
  `fetch` 取余额（本地假端点，并校验 `Authorization` 确实来自 `.credentials.yaml`
  的 `refs` 值而非其它字段），以及「宿主半边不得再向 ctx 索要 `fs`/`settings`/`shell`」
  的回归守卫。

### 实测

真实宿主（DSH Desktop，`web` profile）验证通过：`store.error` 为空、`store.path` =
`C:\Users\chen\.dsh\token-billing-ledger.json`、账本写入成功并读回历史（190 → 191/192 笔，
无重复计数），余额 `via=fetch:file` 取回 **¥27.59 CNY**。

## [1.1.0] — 2026-09-11

**从动态 Cordis 包改造成真实插件包**，安装方式随之改变（见 [INSTALL.md](INSTALL.md)）。
计费口径、价目表与界面行为与 1.0.0 一致。

### 变更

- **改为真实插件包**：`src/host.js` / `src/client.js` 仍是人类可读的源码，`scripts/build.mjs`
  把它们定点变换成 `lib/index.js`（宿主半边，`export name` / `export apply(ctx, rowConfig)`）
  与 `lib/client.js`（客户端半边，`window.__ModuleLoader__` 工厂，导出 `name` / `inject` / `apply`）。
  两者都提交进仓库，安装方无需构建。
- **宿主↔客户端通信换成 HTTP 路由**：5 个 `harness.handle('billing/*')` 方法改为
  `webServer` 上的 `POST /dsh-token-feiyong/{state,save,store,balance,reset}`，由 `ctx.effect` 注销；
  请求必须带 `x-dsh-token-feiyong: 1` 头（跨源页面无法在无预检的情况下伪造），非 POST 返回 405。
- **`styles.insert` 换成自建 `<style>` 注入**，交 `ctx.effect` 托管（真实插件没有沙箱提供的
  `styles` 对象）。
- **移除**冒充 `sidebar.footer.action` 的 `cordis-panel` 注册：那只是动态包用来隐藏侧边栏底部
  "Cordis Plugin" 行的手段；真实插件没有那一行，留着反而会挡掉 Cordis 自己的审批 UI。
- **移除**设置页的「余额请求：沙箱 / 非沙箱」开关（仅动态沙箱语境下有意义）。

### 修复

- **重复计数**：`apply` 会在不重启进程的情况下被再次执行（profile 的 `patchReload: live`），
  而 ESM 模块实例在进程内复用——原先 `loadStore` 会把账本聚合再次并入已在内存的聚合。
  实测在真实宿主里 `calls` 从 185 涨到 382。现在 `apply` 先复位内存聚合再读账本。
- **存档写入被沙箱拒绝**：账本位于 `<DSH_HOME>`（工作区之外），写入与余额探测都必须按次请求
  `danger-full-access` 策略，否则报 `file access denied under workspace-write mode`。

### 新增

- `cordis.patch.yml`：`dsh.bundle.patch` 清单，`dsh plugin add` 据此把本插件追加进
  `dsh.profile.bundles`。
- `package.json` 补齐 `type` / `main` / `exports` / `dsh.bundle` / `dsh.client.platform` 清单。
- `scripts/check.mjs`：**72 项自检**。真起一个 HTTP 服务注册 5 条路由，用真实请求跑通
  记账、高峰/低谷单价（含周末判档）、单次收口、账本落盘、配置保存与清空，并校验客户端 bundle
  的加载、`ctx.effect` 样式托管、两个 slot 的注册与「不再冒充 cordis-panel」。
- `docs/PUBLISHING.md`：官方收录方式（awesome-dsh-plugin）与发布设计。

## [1.0.0] — 2026-09-11

首个公开版本。

### 新增

- **逐笔计费**：拦截 `llm/stream`，读取供应商上报的 `TokenUsage`，按「缓存命中输入 / 缓存未命中输入 / 输出」三类分别计价；缓存写入按未命中单价兜底。
- **高峰 / 低谷分时计价**：高峰 = 北京时间**周一至周五 09:00–12:00、14:00–18:00**，其余为低谷；低谷单价为高峰的一半（与官方规则一致）。
- **多档单价**：按 `provider/model` 精确匹配 → 模型名 → 默认档；设置页可新增 / 重命名 / 删除档位，`default` 档作为兜底。
- **输入框徽标**：`● 时段 · 单次 · 本对话 · 今日 · 余额`；高峰红字、低谷绿字，悬停看明细。
- **设置页「费用统计」**：账户余额、单次花费、今日、累计、按模型（显示实际套用的计价档与两套有效单价）、最近请求、单价与时段配置。
- **账户余额**：读取本地凭据调用 DeepSeek `/user/balance`，展示余额 / 赠金 / 充值拆分。
- **数据落盘**：明细 + 累计总额 + 按日 / 按模型 / 按会话聚合 + 单次记录 + 全部配置写入 `<DSH_HOME>/token-billing-ledger.json`；插件更新或 DSH 重启后**合并读回**，累计不回退。
- **总开关**：一键启用 / 关闭（关闭后隐藏徽标并停止余额请求；计费仍在后台继续记录，不丢数据）。
- **计费逻辑可视化页**：`docs/billing-explained.html`（流程图 / 公式 / 逐笔回放 / 交互计算器）。

### 说明

- 价格与时段口径核对于 **2026-09-11**，来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>。
- 无编译、无依赖；作为动态 Cordis 包加载，安装方式见 [INSTALL.md](INSTALL.md)。

### 已知边界

- 子代理（subagent）属于另一个会话，单独累计，不计入主会话的「本对话」。
- 失败调用若没有 `usage` 上报则无法计费。
- 明细窗口保留最近 300 条；累计类聚合独立持久化，不受窗口滚动影响。
- 多个 DSH 进程共用同一 `DSH_HOME` 时会互相覆盖同一份存档。

## 计划中

按内部审核清单，尚未实施的可选项：

| 编号 | 内容 |
| --- | --- |
| A1 | 单次流内多 `usage` 块按 attempt 拆分（避免少计费） |
| A2 | 失败调用也落一条 `cost=0` 的记录，便于区分"没调用"与"调用失败" |
| B3 | 多 DSH 进程共享存档的防覆盖（按实例分文件 + 启动合并） |
| B5 | 写盘节流（当前为每笔调用后写一次，带写入中合并） |
| C2 | 余额请求改用 `curl` argv 直调，不经 PowerShell 解释器 |
| C4 | 余额低于阈值时徽标标红告警 |
| D3 | 合并徽标与设置页的两个轮询器 |
| D5 | 导出 CSV / JSON 便于对账 |
| E1 | 清理已无入口的按会话清空分支 |
| E2 | 内置「计费自检」按钮（用合成用量校验公式） |

欢迎在 [Issues](https://github.com/singei8/DSH-TOKEN-feiyong/issues) 里提出偏好或补充。
