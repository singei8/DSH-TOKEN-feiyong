# 收录与发布：让别人搜到 → 一键安装

本文是 `DSH-TOKEN-feiyong` 走 DSH 官方插件收录路径的完整设计。
收录方式不是猜的：规则来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
的 `contributing.md`，分发链路是在本机已安装的插件市场 `dshmarket@1.45.1`
（`~/.dsh/profiles/web/node_modules/dshmarket`）源码里逐步核对的。

---

## 一、分发链路：一个插件是怎么被"搜到"的

```
作者仓库 (github.com/singei8/DSH-TOKEN-feiyong)
        │  PR 只加一个文件：data/plugins/<owner>__<repo>.yml
        ▼
awesome-dsh-plugin/awesome-dsh-plugin   ← 收录库（唯一数据源）
        │  合并后由 CI 生成两个 README，并构建站点
        ▼
plugins.json / readmes.json / updates.json
        │  发布到 https://awesome-dsh-plugin.com  (GitHub Pages + CDN)
        │  同时快照成 npm 包 dsh-plugin-catalog（中国大陆走这个镜像）
        ▼
dshmarket（插件市场，宿主进程内）每次打开都拉目录（带 ETag/304 校验）
        ▼
用户在「设置 → 插件市场」里搜索 → 卡片 → 一键安装
        │  dsh plugin add <仓库地址>      或      tarball: 指向的预构建 .tgz
        ▼
写入 ~/.dsh/profiles/web/package.json 的 dependencies + dsh.profile.bundles
装完热挂载（hot-mount），无需重启
```

要点：**收录库是唯一入口**，自己发 npm 包、自己发 Release 都不会让任何人"搜到"你。
npm 包与 Release 只影响安装体验，不影响能否被搜到。

---

## 二、收录的硬性要求（CI 按序检查）

按 `contributing.md` 的「What CI checks」，一个 PR 依次跑：

| # | 检查项 | 说明 |
|---|---|---|
| 1 | 每个 PR 最多 3 条 | 最先检查，早于任何网络请求 |
| 2 | `dsh.bundle` | 从仓库 `package.json` 读取（根包，或 `packages/`·`plugins/`·`apps/` 子包）。**只声明 `dsh.client` 会失败** |
| 3 | 仓库年龄 | **创建满 1 天**才可提 |
| 4 | `awesome-lint` + 站点构建 | 双语一致性、分隔符、日期、截图 |

人工评审另外看：代码是否名副其实、分类是否贴切、是否真实可用、是否与已有条目重复、
源码有无可疑之处、PR 是否动了无关条目、**是否纯聚合包**（只有依赖清单不单独收录）。

列出即非安全审查——收录不等于审计。

### 条目文件（PR 里唯一要加的东西）

文件名必须是 `<owner>__<repo>.yml`：

```yaml
url: https://github.com/singei8/DSH-TOKEN-feiyong
name: singei8/DSH-TOKEN-feiyong
category: usage
description:
  en: Per-turn token cost meter for DeepSeek Harness with peak/off-peak pricing, account balance, and a local ledger.
  zh: DSH 逐笔 token 计费面板：按官方价目表分时计价，含账户余额、单次与本对话花费，数据本地持久化。
```

- `url` 必须**严格等于** `https://github.com/owner/repo`（收录端拒绝其他形式）。
- 只有 `description.en` 必填；`zh` 写不了可以留空，维护者会补。
- 描述里含 `": "`（冒号+空格）必须加引号，否则 YAML 当成嵌套键。中文全角冒号无此问题。
- 描述必须与实际代码相符，不能有营销词、不能夸大——这是被打回的首要原因。
- `category` 候选：`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools`
  `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security`
  `remote` `market` `fun`。本插件选 **`usage`**（用量统计）；分类选不精准不会被拒，
  维护者会直接改。

### `dsh.bundle` 清单（必要条件）

`package.json`：

```jsonc
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // ← 必须，缺它就无法 dsh plugin add
    "client": { "platform": "web" }                // 仅当带浏览器 UI 时需要
  }
}
```

仓库根目录同时要有 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-token-feiyong
      name: dsh-token-feiyong
```

### 依赖写法（预发布版本陷阱）

官方 `@deepseek-ai/*` 必须写进 `peerDependencies`，且范围**必须带显式预发布分支**，
否则静默排除 harness 的所有预发布构建，用户会遇到 `ERESOLVE`：

```jsonc
// ❌ 看起来宽，实际静默排除所有 0.1.0-* 预发布
"peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.2.0" }

// ✅ 在 0.1.0 元组上带预发布标签的显式分支
"peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0" }
```

### 预构建 tarball（强烈建议）

不发 npm 时，把预构建 `.tgz` 挂到 GitHub Release，并用 `tarball:` 指向它：

```yaml
tarball: https://github.com/singei8/DSH-TOKEN-feiyong/releases/latest/download/dsh-token-feiyong.tgz
```

- 必须是 GitHub Release 托管的 **https `.tgz`**（`.zip` 不行，列表不给无法担保来源的下载链接）。
- `latest/download/` 只在请求时解析 `latest`，**文件名按字面取**。资产名里带版本号的话，
  提交当天有效、下次发版就 404。所以要么资产名不带版本（如上），要么钉住 tag：

```yaml
tarball: https://github.com/singei8/DSH-TOKEN-feiyong/releases/download/v1.2.0/dsh-token-feiyong-1.2.0.tgz
```

### npm 发布（可选，但与收录无关）

- 发 npm 能让市场展示并按下载量排序，**发不发都不影响收录**。
- 已发布包的 `repository` 字段必须指回被收录的那个仓库，否则两者不关联。
- **不要**在条目 yml 里手写 `npm:` 键，会被校验拒绝；映射从 registry 自动采集。
- 发 npm 的好处：预构建安装可跳过 `allowBuilds` 构建授权。

### 截图（可选）

在自己仓库 `package.json` 旁放 `screenshots.json`，列 1–8 张图：

```jsonc
["assets/screenshot-1.png", "assets/screenshot-2.png"]
```

- 相对路径相对该文件本身，不能以 `/` 开头、不能含 `..`。
- 绝对 URL 也行，但必须是 GitHub 托管的 https（`raw.githubusercontent.com` 等），第三方图床会被拒。
- 不声明也行，市场会从 README 自动抽取。

---

## 三、本仓库现状与差距

| 门槛 | 现状 | 状态 |
|---|---|---|
| `dsh-plugin` topic | 仓库原来的 8 个 topic 里没有它 | ✅ 已于 2026-09-11 补上 |
| 真实可安装的代码 | `lib/index.js` + `lib/client.js`（`src/` 为源码，`scripts/build.mjs` 构建） | ✅ 已移植 |
| `dsh.bundle` 清单 + `cordis.patch.yml` | `package.json` 含 `dsh.bundle` / `dsh.client` / `exports` | ✅ 已就绪 |
| `tarball` 字段 | Release 资产 `dsh-token-feiyong.tgz`（**不带版本号**，最新为 v1.2.0） | ✅ 已发布 |
| 仓库创建满 1 天 | `created_at = 2026-09-11T14:09:19Z` | ⏳ **2026-09-12 14:09 (UTC) 之后**才满足 |
| 条目文件 | `data/plugins/singei8__DSH-TOKEN-feiyong.yml`（内容见下） | ⏳ 待提 PR |
| npm 包 | 未发布 | ⏳ 可选，不影响收录 |

**移植已完成并验证**：`node scripts/check.mjs` 87 项自检全过（真起 HTTP 服务跑通 5 条路由、
记账、高峰/低谷单价含周末判档、单次收口、账本落盘、配置保存与清空、客户端 bundle 加载与
slot 注册、apply 重入不重复计数）。真实宿主里也实测通过：热挂载后 `POST /dsh-token-feiyong/state`
返回 200，`__DSH_BOOT__.entries` 含本插件，服务出的 `client.js` 与本地构建逐字节一致。

---

## 四、移植设计：动态包 → 真实插件包（已完成）

已完成形态：

```
package.json          type:module, main:lib/index.js, exports{., ./client, ./cordis.patch.yml, ./package.json}
                      dsh.bundle.patch + dsh.client{platform:web}
cordis.patch.yml      - insert: [{ id: dsh-token-feiyong, name: dsh-token-feiyong }]
lib/index.js          宿主半边（Node，ESM，无 import）
lib/client.js         浏览器半边（window.__ModuleLoader__ 工厂，require('react')）
src/                  人类可读源码：两个动态包函数体
scripts/build.mjs     定点变换 + 逐处断言
scripts/check.mjs     87 项自检
```

与最初设计的差异（都是实测后修正的）：

- **不能依赖按作用域提供的服务**：最初照搬了动态版对 `fs` / `credentials` / `shell` 的调用，
  但插件挂在 profile 根级，看不见这些由 `dsh-fs-local` / `dsh-credentials-local` 按作用域
  提供的服务——真实宿主里表现为徽标「存档异常 / fs 服务不可用」。现在账本走 `node:fs`、
  余额走 `fetch`，凭据从 `<DSH_HOME>/.credentials.yaml` 的 `refs` 段读，不再需要这些服务。
- **`apply` 必须可重入**：profile 的 `patchReload: live` 会让同一模块实例再次 `apply`，
  而 ESM 模块在进程内复用；原先 `loadStore` 会把账本聚合再并入一次（实测 `calls` 185 → 382）。
  现在 `apply` 先复位内存聚合。
- **`styles.insert` 要用自建 `<style>` 替代**，交 `ctx.effect` 托管（真实插件没有沙箱的 `styles`）。
- **`dsh.client` 只需 `platform: web`**：`lib/client.js` 只 `require('react')`，
  由 harness 的浏览器模块加载器提供；不需要声明 `@deepseek-ai/dsh-client-*` 模块。
- **不需要 `peerDependencies`**：两侧代码都不 import 任何 npm 包，
  也就不存在官方文档警告的预发布 `ERESOLVE` 陷阱。

真实插件包的目标形态（对照已安装的 `dshmarket@1.45.1`）：

```
package.json          type:module, main:lib/index.js, exports{., ./client, ./cordis.patch.yml, ./package.json}
                      dsh.bundle.patch + dsh.client{platform:web} + peerDependencies
cordis.patch.yml      - insert: [{ id: dsh-token-feiyong, name: dsh-token-feiyong }]
lib/index.js          宿主半边（Node，ESM）
lib/client.js         浏览器半边（由 bundler 产出的 __ModuleLoader__ 包装）
screenshots.json      可选
```

### 4.1 实际改了哪些地方

宿主半边（`src/host.js` → `lib/index.js`）：

| 动态包写法 | 真实插件写法 |
| --- | --- |
| `return { apply(ctx) { … } }` | `export const name` + `export function apply(ctx, rowConfig)` |
| `harness.handle('billing/state', fn)` 等 5 处 | `webServer.register({ kind: 'exact', path, handler })`，由 `ctx.effect` 注销 |
| 沙箱 RPC（仅 JSON 往返） | `POST` + `x-dsh-token-feiyong: 1` 头校验；非 POST 405、无头 403、坏 JSON 400 |
| `ctx.get('settings')`、`ctx.get('fs')`、`ctx.get('credentials')`、`ctx.get('shell')` | **原样保留**（服务名与行为一致） |
| `ctx.on('llm/stream')`、`ctx.on('agent/*')`、`ctx.on('api-session/status')` | **原样保留**（事件与作用域过滤一致） |
| `ctx.get('fs')` / `ctx.get('credentials')` / `ctx.get('shell')` | **换成** `node:fs` 与 `fetch`（根级插件看不到这些按作用域提供的服务） |
| 模块级聚合一进到底 | 新增 `__resetState()`：`apply` 先复位内存聚合再读账本，热重载不重复计数 |

客户端半边（`src/client.js` → `lib/client.js`）：

| 动态包写法 | 真实插件写法 |
| --- | --- |
| 沙箱全局 `React` | `require('react')`（由 harness 的浏览器模块加载器提供） |
| 沙箱全局 `host.call(m, a)` | `hostCall(m, a)` → `fetch('/dsh-token-feiyong/<m>')` |
| 沙箱全局 `styles.insert(CSS)` | 自建 `<style>` 注入，交 `ctx.effect` 托管 |
| `ctx.get('slots')` / `ctx.get('timer')` | **原样保留**（`exports.inject = ['slots']`） |
| 注册 `sidebar.footer.action` 冒充 `cordis-panel` | **删除**（动态包专用手段，留着会挡掉 Cordis 审批 UI） |
| 整个文件就是函数体 | 包进 `window.__ModuleLoader__.load({ id, factory })`，导出 `name` / `inject` / `apply` |

### 4.2 自测与实测结果

`node scripts/check.mjs` —— **87 项全过**：

1. 宿主 `apply` 后注册 5 条 exact 路由，且在 `ctx.effect` 内挂载（可注销）。
2. 真起 HTTP 服务验证：`POST /state` 200、缺自定义头 403、GET 405、坏 JSON 400。
3. 计价与分时：周一 10:00（北京）判高峰、20:00 判低谷、周六判低谷；
   Pro 档走专用价目表（0.30 / 9 / 27 与 0.15 / 4.5 / 13.5），Flash 落 `default` 档（0.04 / 2 / 8）。
4. 单次收口：`api-session/status(running=false)` 关闭本轮，`lastTurn` 汇总正确。
5. 落盘：`store` 路由触发写盘，`version=3`，累计与明细都写入。
6. 配置：`save` 覆盖币种 / 低谷比例 / 单价并可读回；`reset` 清空累计与明细。
7. 客户端：`__ModuleLoader__.load` 被调用、导出 `name` / `inject` / `apply`、
   样式经 `ctx.effect` 托管且可注销、注册且**仅**注册 `settings.section` 与 `conversation.composer.dock`。
8. 重入：连续 `apply` 两次，`totals` 不翻倍（回归下面那个实测 bug）。

真实宿主（DSH Desktop，`web` profile）实测：

- 借 profile 的 live patch 热挂载后，`POST /dsh-token-feiyong/state` 返回 200；
  读回账本 `<DSH_HOME>/token-billing-ledger.json`，**路径与动态版一致**，历史自然延续。
- `__DSH_BOOT__.entries` 含
  `{"id":"dsh-token-feiyong","url":"/plugins/??dsh-token-feiyong/client.js&rev=…"}`；
  该 URL 取回的 bundle 与本地构建**逐字节一致**（仅多一行 harness 追加的 sourceMappingURL）。
- 分时判定正确：周五 22:49（北京）报「低谷」。


## 五、提交收录的完整步骤

前两步已完成（✅），现在只等仓库满 1 天就能提 PR。

1. ✅ 完成移植，`node scripts/check.mjs` 87 项全过，`main` 已推到
   `github.com/singei8/DSH-TOKEN-feiyong`。
2. ✅ 打 tag、发 Release（最新 v1.2.0），资产名始终不带版本号：
   <https://github.com/singei8/DSH-TOKEN-feiyong/releases/latest/download/dsh-token-feiyong.tgz>
   （已验证可下载，SHA256 与本地构建一致）。
3. ⏳ 等仓库创建满 1 天：**2026-09-12 14:09 UTC 之后**。
4. Fork `awesome-dsh-plugin/awesome-dsh-plugin`，新建分支，**只加一个文件**
   `data/plugins/singei8__DSH-TOKEN-feiyong.yml`：

```yaml
url: https://github.com/singei8/DSH-TOKEN-feiyong
name: singei8/DSH-TOKEN-feiyong
category: usage
tarball: https://github.com/singei8/DSH-TOKEN-feiyong/releases/latest/download/dsh-token-feiyong.tgz
description:
  en: Per-turn token cost meter for DeepSeek Harness: official rate card with peak/off-peak pricing, account balance, single-turn and per-conversation totals (side-chat and subagent child sessions fold into the conversation that started them), persisted to a local ledger.
  zh: DSH 逐笔 token 计费插件：按官方价目表分时计价（缓存命中 / 未命中 / 输出），含账户余额、单次与本对话花费，侧边对话与子代理的花费并入所属主对话，数据本地持久化。
```

5. （可选预览）`npm ci && node scripts/generate-readme.mjs` —— 不改 README 也能提。
6. 开 PR。CI 若报错会明确指出改什么，在同一分支推送修复即可，无需重开 PR。
7. 合并后站点自动重建，几十秒到几分钟后即可在市场搜到并一键安装。

### 时间线

| 时间 | 动作 | 状态 |
|---|---|---|
| 2026-09-11 | `dsh-plugin` topic、移植宿主/客户端两半、构建 `lib/` | ✅ |
| 2026-09-11 | `.tgz` Release（`dsh-token-feiyong.tgz`）、`dsh.bundle` 清单与 `cordis.patch.yml` | ✅ |
| 2026-09-11 | 真实宿主实测：热挂载、路由 200、账本读回、客户端清单与 bundle 一致 | ✅ |
| 2026-09-12 14:09 UTC 后 | 提收录 PR | ⏳ |
| 合并后 | 市场可搜到，一键安装 | ⏳ |

---

## 六、参考

- 收录规则原文：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>
- 目录数据：`data/plugins/<owner>__<repo>.yml` → <https://awesome-dsh-plugin.com/plugins.json>
- 目录 npm 镜像：`dsh-plugin-catalog`
- 真实插件包范例（本机已装）：`dshmarket@1.45.1`、`dsh-better-sidebar@0.19.1`
- 官方价目表：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
