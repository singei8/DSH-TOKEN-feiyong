# 开发备忘录

> **新会话开场只做三件事**：① 读完这一页 ② `git log --oneline -5` 看当前版本与线上状态 ③ 需要时**定向 grep**。
> **禁止**整文件通读 `lib/index.js`（约 2300 行 / 100 KB）、`lib/client.js`（1000 行）、`scripts/check.mjs`（1000 行）——
> 那一次就是几万 token。要看哪一段就 `grep -n` 定位再 `read` 十几行。
> 本文件是唯一入口；`README.md`/`INSTALL.md`/`CHANGELOG.md` 面向用户，本文件面向维护者。

## 0. 一句话

DSH 插件：**逐笔算钱**（DeepSeek / 智谱 GLM，按官方价目表 + 高峰低谷），
**方舟 Agent Plan 套餐按官方 AFP 抵扣系数算额度**（不计钱）。

仓库：`E:\Desktop\harness\deepseek\DSH插件\DSH-TOKEN-feiyong`　线上：`github.com/singei8/DSH-TOKEN-feiyong`
安装形态：junction 到 `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-token-feiyong`（指向仓库本身）。

## 1. 文件地图（改哪里 → 连带做什么）

| 路径 | 作用 | 改完必须 |
|---|---|---|
| `lib/index.js` | **宿主半边**（直接维护，非构建产物）：HTTP 路由、拦截 `llm/stream` 记帐、余额/套餐探测、`node:fs` 账本 | **重启 DSH**；跑自检 |
| `src/client.js` | 客户端源码（徽标 + 设置页，`React.createElement`，无 JSX/TS） | 跑 `node scripts/build.mjs` |
| `lib/client.js` | 客户端**构建产物**（`__ModuleLoader__.load` 工厂） | 别手改；页面刷新即生效 |
| `scripts/build.mjs` | 定点替换 + 锚点断言（锚点对不上会报错） | — |
| `scripts/check.mjs` | 自检 **237 项**：假 ctx + 真 HTTP + 迷你 React（含设置页真渲染） | — |
| `package.json` | `version` + `dsh.bundle`/`dsh.client`/`exports` | 改版本号 |
| `cordis.patch.yml` | 安装清单（一行 `insert`） | — |
| `README.md` / `INSTALL.md` / `docs/PUBLISHING.md` | 用户文档，**多处写着自检条数** | 条数变了要全局同步 |
| `CHANGELOG.md` | 每个版本一段（版本 = 一次 Release） | 发版必写 |

## 2. 不变量（禁令，都是踩过的）

1. **根级插件 ctx 看不到作用域服务**（`fs`/`shell`/`credentials`/`settings` 都是 `undefined`）→ 用 `node:fs`、`fetch`、`child_process`。只 `ctx.get('credentials')`/`ctx.get('sessions')` 是允许且只用它俩。
2. **自检不许打真网络**：宿主半边外部 HTTP 一律拦成假响应；本地假服务器 `server.unref()` 留到进程退出（提前 close 会让晚到的异步余额请求变成 `fetch failed`）。
3. **套餐制 provider**：`cost = 0` + `quota`（AFP）双字段；判据 `resolveBalanceProfileFrom().kind === 'ark-plan'`（即 `isQuotaProfile`）。
4. **`TokenUsage` 是互斥口径**：`inputTokens` = 缓存未命中、`cacheReadTokens` = 命中、`cacheWriteTokens` = 写入、`outputTokens` 已含 `reasoningTokens`（别重复计）。
5. **余额档位按「该会话最近一次调用的 provider/model」解析**，顺序：用户 `balanceProfiles` → 内置 provider → 模型名前缀（`glm*`/`deepseek*`）→ 用户改过的默认地址（只对 DeepSeek 系）→ `null`。**没有档位就不显示任何金额**，不许顶替别家数字。
6. **子会话**（侧边对话 / 子代理）按会话头 `parentSession` 并入主对话的「本对话/单次」；`bySession` 仍分开记（不双计）。
7. **junction 卸载**用 `cmd /c rmdir "<路径>"`；`Remove-Item -Recurse` 会把**源目录**删掉。
8. **Windows/PowerShell**：别用内联 `node -e`（引号与 CJK 会被 PS 弄坏）→ 写脚本文件；PS 读 JSON 要 strip BOM；`npm`/`pnpm` 被 ExecutionPolicy 拦时用 `cmd /c npm ...`。
9. **退出码不可全信**：PS 管道里 git/node 的 stderr 会让 `$LASTEXITCODE = 1`；先看输出再判成败。
10. **`check.mjs` 的 `near()` 要求 1e-9 精度**：断言里要么写精确表达式，要么改成范围判断。

## 3. 命令速查

```powershell
cd "E:\Desktop\harness\deepseek\DSH插件\DSH-TOKEN-feiyong"

# 自检（降噪：只看失败与结论）
node scripts/check.mjs > $env:TEMP\chk.txt 2>$null
Select-String -Path $env:TEMP\chk.txt -Pattern 'FAIL|checks passed'

# 客户端构建（改 src/client.js 后必跑；产物 lib/client.js）
node scripts/build.mjs

# 宿主半边语法检查
node --check lib/index.js

# 真机冒烟（真 arkcli：读套餐 + 解析 AFP 系数；账本写临时 DSH_HOME）
node scripts/dev/live-ark.mjs "$PWD"

# AFP 对账：把控制台当天按模型 token 回放给发布代码，与控制台比（比值=1 才对）
node scripts/dev/replay-afp.mjs "$PWD" 2026-09-18

# 逐笔回放（账本里某个模型的全部调用 ↔ 控制台 5h 快照）
node scripts/dev/replay-bucket.mjs "$PWD"

# 发布：打包 → tag → push → Release → 上传 → 校验 SHA256（网络不稳时用）
node scripts/dev/push-retry.mjs "$PWD" "$PWD\dsh-token-feiyong.tgz" 150 vX.Y.Z

# 看线上跑的是不是本地这份客户端（rev 变了说明内容变了）
node -e "fetch('http://127.0.0.1:3080/').then(r=>r.text()).then(t=>console.log(t.match(/\"id\":\"dsh-token-feiyong\",\"url\":\"([^\"]+)\"/)[1]))"
```

> `scripts/dev/*` 是**本机开发脚本**（已 gitignore，不进公开仓库）：`live-ark.mjs` 真机冒烟、
> `replay-afp.mjs`/`replay-bucket.mjs` 真实数据对账、`gh-release.mjs` 建 Release、`push-retry.mjs` 带重试的发布。
> 它们的共同脚手架见第 8 节；发版前记得把 `gh-release.mjs` 顶部的 TAG/NOTES 改成本次版本。

## 4. 官方依据（别再抓一遍）

**AFP 抵扣规则**（文本 + 系数表）：

```
GET https://www.volcengine.com/api/doc/getDocDetail?LibraryID=82379&DocumentID=2516283&lang=zh
→ Result.MDContent 是 markdown（含表格）；规则文档 = 2516283，限时活动 = 2533565
```

```
AFP = (输入 token × 输入系数 + 输出 token × 输出系数) / 10,000
输入 token = 缓存命中 + 未命中 + 写入（三类都算，已用 plan-details 与账本逐日核对）
```

| 模型（前缀匹配，已归一化 `.`/`_` → `-`） | 系数 | 备注 |
|---|---|---|
| `auto` | 0.5 | 活动至 2026-11-08 |
| `doubao-seed-2-0-mini` | 0.25 | |
| `doubao-seed-2-0-lite` / `deepseek-v4-flash` / `glm-5-3-flash` | 0.5 | glm-5.3-flash 8/28–9/11 五折 |
| `doubao-seed-2-1-turbo` / `doubao-seed-evolving` / `minimax-m3` | 2.5 | |
| `kimi-k2-7-code` / `glm-5-3` | 4.5 | |
| `deepseek-v4-pro` | 5.5 | |
| `kimi-k2-8-preview` | 8 | 9/17–9/30 六折 → 4.8 |
| `kimi-k3` | 10 | |
| `doubao-embedding-vision` | 0.5 | 向量化 |
| `deepseek-v4-1-flash` | 2.5 | 9/15–9/28 活动；**实测有效系数 1.0**（文档写 1.25） |

实测校准法（比值 1.0000）：同批调用回放 → `832,517 token ↔ 83.2517 AFP`；整天 12 模型 → `532.9309 ↔ 532.9246`。

**arkcli**（与插件共用同一份 SSO）：

```powershell
arkcli usage plan --format json                 # 套餐快照：items[].periods[] {label,used,total,percent,reset_at}
arkcli usage plan-details --start <日> --end <日> --format json   # 按模型 token（单位 Tokens，不是 AFP）
```
解析时从**第一个 `{` 开始**（CLI 会在 stdout/stderr 混入「发现新版本」等字样）。

**余额接口**（实测口径）：

| 供应商 | 请求 | 解析 |
|---|---|---|
| DeepSeek | `GET https://api.deepseek.com/user/balance`（`Bearer <key>`） | `balance_infos[0].total_balance / granted_balance / topped_up_balance` |
| 智谱 GLM | `GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report`（裸 key） | `data.balance / rechargeAmount / giveAmount` |
| 智谱配额 | `GET /api/monitor/usage/quota/limit` | `data.limits[].{remaining,number}` |
| 方舟套餐 | 本地 `arkcli usage plan` | 见上 |

## 5. 发布清单（版本 = 一次 Release）

1. `package.json` 升 `version`；`CHANGELOG.md` 加一段（写清「为什么改」+ 实测证据）。
2. 文档里的自检条数全局同步：`README.md` / `INSTALL.md` / `docs/PUBLISHING.md` / `CHANGELOG.md`。
3. `node scripts/build.mjs && node scripts/check.mjs`（必须 0 退出）。
4. 打包：`cmd /c "npm pack --silent"` → 改名 **`dsh-token-feiyong.tgz`（不带版本号）**（`latest/download` 需要）。
5. `git add -A && git commit` → `git tag -a vX.Y.Z -m "..."` → `git push origin main` → `git push origin vX.Y.Z`。
6. GitHub Release（无 `gh` CLI，用 REST API）：令牌取 `git credential fill`（不落盘）；
   `POST /repos/singei8/DSH-TOKEN-feiyong/releases` → 资产传 `https://uploads.github.com/.../releases/<id>/assets?name=dsh-token-feiyong.tgz`。
7. 校验：下载 `https://github.com/singei8/DSH-TOKEN-feiyong/releases/latest/download/dsh-token-feiyong.tgz`，SHA256 必须与本地一致。
8. 通知用户：**改过 host 半边 → 重启 DSH**；只改客户端 → 刷新页面。

**网络预案**：`github.com` / `uploads.github.com` 会连不上（而 `api.github.com` 正常）→
用后台重试脚本（每 20 秒一次，最多 N 分钟）；`push --force origin <tag>` 要先确保**本地 tag 已存在**，
否则报 `src refspec ... does not match any`。

## 6. 关键路径

| 东西 | 位置 |
|---|---|
| 账本 | `%USERPROFILE%\.dsh\token-billing-ledger.json`（`version:3`，明细只留最近 `MAX_ROWS=300` 行，聚合独立持久化） |
| DSH 配置 | `%USERPROFILE%\.dsh\settings.yaml`（provider `volc-ark-coding` = 方舟 Agent Plan） |
| 凭据 | `%USERPROFILE%\.dsh\.credentials.yaml` 的 `refs` 段（`DEEPSEEK_API_KEY` / `BIGMODEL_API_KEY` / `VOLC_ARK_CODING_API_KEY`） |
| 会话日志 | `<DSH_HOME>\sessions\<工作区>\<会话id>\session.v3.jsonl.zstd`（只读第一帧拿 `parentSession`） |
| 客户端产物 URL | `/plugins/??dsh-token-feiyong/client.js&rev=<hash>`（rev 变了说明内容变了） |
| 本地 GUI | `http://127.0.0.1:3080`（改客户端后刷新即可，服务器每次从磁盘读文件） |

## 7. 症状 → 病根（快速对照）

| 症状 | 病根 |
|---|---|
| 徽标余额一直 `…` | 客户端拿不到 `timer` 服务 → 用 `window.setInterval` 兜底 |
| 徽标「存档异常」/ 日志 `fs 服务不可用` | 宿主半边误用 `ctx.get('fs')` → 必须 `node:fs` |
| 切到 GLM 却显示 DeepSeek 余额 | 档位没按 provider 分流 / 内置档位盖掉用户自定义 |
| 自检偶发退出码 1、日志 `fetch failed` | 自检真打了网络，或假服务器过早 close |
| 设置页白屏 / 崩溃 | 客户端变量名写串（如 `session` vs `sessionQuota`）→ 已有真渲染用例兜住 |
| `applyConfig` 存不进去 | 新配置项没加进 `applyConfig` 的白名单（曾把 `bigmodel`/`ark-plan` 静默改成 `auto`） |
| 额度数字明显偏高 | 模型名版本号没匹配上系数表（如 `doubao-seed-2-1-turbo-260628`）→ 用前缀匹配 |

## 8. 未来脚本放哪（已定）

`scripts/dev/`（**已加入 `.gitignore`**，不进公开仓库）；一次性脚本放 `%TEMP%`。两个最值得复用的配方：

- **假宿主脚手架**（复用于任何「直接跑发布代码」的验证）：`mkdtempSync` 出临时 `DSH_HOME` → `import` 仓库的
  `lib/index.js` → 造 `ctx { on, get, inject(cb→cb(ctx)), effect, webServer.register, logger }` →
  `apply(ctx, {currency:'¥', utcOffsetMinutes:480})` → 起本地 `http` 把路由接上 → 用 `fetch` POST 调 `/dsh-token-feiyong/*`。
  `inject` 一定要把 ctx 传给回调（不传会在挂路由时崩）。
- **AFP 对账**：`arkcli usage plan` 拿控制台 used，`arkcli usage plan-details` 拿按模型 token，
  把 token 当 `cacheReadTokens` 喂给 `emit({provider:'volc-ark-coding', model: name}, usage)`，
  比较 `state.sessionTotals.quota` 与控制台差值；比值应 ≈ 1。

## 9. 省钱规则（给我自己）

1. 先本文件 + `git log`，再 **grep 定位**，最后才 read（一次 ≤ 50 行）。
2. 自检输出重定向到文件，只 grep `FAIL|checks passed`（237 行输出 ≈ 2k token/次）。
3. 改完先跑 `build.mjs` + `check.mjs`，再考虑真机验证；真机验证聚焦**比值**而不是打印全量 JSON。
4. 官方文档只查第 4 节的文档 ID / API，不要重新搜索。
5. 一次把问题问清（含选项与推荐），不要来回试探。
