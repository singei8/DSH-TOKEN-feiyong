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
| `tarball` 字段 | Release 资产现为 `DSH-TOKEN-feiyong-v1.0.0.zip` | ❌ 需改成不带版本号的 `.tgz` |
| `dsh.bundle` 清单 + `cordis.patch.yml` | 都没有 | ❌ 待移植后一并加 |
| 仓库创建满 1 天 | `created_at = 2026-09-11T14:09:19Z` | ⏳ **2026-09-12 14:09 (UTC) 之后**才满足 |
| 真实可安装的代码 | `src/*.js` 是**动态 Cordis 包**的函数体（无 `import/export`，靠沙箱 `harness.*`） | ❌ 待移植 |
| npm 包 | 未发布 | ⏳ 可选 |
| 截图 | 无 | ⏳ 可选 |

**关键结论：现在的仓库还不能被收录。** 现有 `src/host.js` / `src/client.js` 是
`cordis_define` 的 `code.host` / `code.client` 函数体，只能在 DSH 进程内的沙箱里跑；
`package.json` 没有 `main` / `type` / `exports`，装上去导不出 `apply`。
所以「正规路径」的实质工作是**把动态包移植成真实插件包**。

---

## 四、移植设计：动态包 → 真实插件包

真实插件包的目标形态（对照已安装的 `dshmarket@1.45.1`）：

```
package.json          type:module, main:lib/index.js, exports{., ./client, ./cordis.patch.yml, ./package.json}
                      dsh.bundle.patch + dsh.client{platform:web} + peerDependencies
cordis.patch.yml      - insert: [{ id: dsh-token-feiyong, name: dsh-token-feiyong }]
lib/index.js          宿主半边（Node，ESM）
lib/client.js         浏览器半边（由 bundler 产出的 __ModuleLoader__ 包装）
screenshots.json      可选
```

### 4.1 宿主半边 `lib/index.js`

导出契约与 `dshmarket` 相同：

```js
export const name = 'dsh-token-feiyong'
export function apply(ctx, config) {
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => mountRoutes(hostCtx), 'dsh-token-feiyong: http routes')
  })
}
```

`src/host.js` 里可直接沿用、不用改的部分：

- `ctx.get('settings')`、`ctx.get('fs')`、`ctx.get('credentials')`、`ctx.get('shell')`
  —— 全是真实服务名（沙箱里也是从 ctx 取的）。
- `ctx.on('llm/stream', (options, next) => ...)`、`ctx.on('agent/turn-stopping', ...)`、
  `ctx.on('agent/inbox/claimed', ...)`、`ctx.on('api-session/status', (sessionId, running) => ...)`
  —— 事件与作用域过滤行为一致。
- 计费公式、价目表、档位（Flash / Pro）、高峰低谷判定、账本结构与上限、落盘结构 —— 全部照搬。

必须替换的部分：

| 动态包写法 | 真实插件写法 |
|---|---|
| `harness.handle('billing/state', fn)` 等 5 个方法 | `webServer` 上注册 5 条 HTTP 路由：`/dsh-token-feiyong/state`、`/save`、`/store`、`/balance`、`/reset` |
| 沙箱 RPC（Client→Host，仅 JSON） | 普通 `fetch`，`hostCtx.effect(...)` 返回的 disposer 负责注销路由 |
| `spec.sandboxPolicy = { mode: 'danger-full-access', ... }`（为绕开工作区沙箱无网络） | **删除**。真实宿主进程没有那层沙箱，余额探测直接用 `credentials` + 网络 |
| `console` 写宿主 stdout | 宿主侧 `ctx.logger` 或原样 `console` |

### 4.2 浏览器半边 `lib/client.js`

真实客户端半边**不是普通 ESM 模块**，而是被 harness 的浏览器模块加载器包装的工厂：

```js
window.__ModuleLoader__.load({ id: "dsh-token-feiyong", factory: (require) => {
  let react = require("react")
  let primitives = require("@deepseek-ai/dsh-client-ui-primitives")
  // ... CJS 风格 bundle ...
} })
```

React / react-dom / `@deepseek-ai/dsh-client-*` 由 loader 提供（external），
所以需要一个 bundler（tsdown/rolldown/webpack 皆可，产出该包装格式）来构建 `lib/client.js`。

`src/client.js` 里可直接沿用、不用改的部分：

- `slots.inject('settings.section', ...)` + `slots.register({ name:'settings.section', id:'token-billing', order:30, label:'费用统计' }, BillingPanel)`
  —— 与真实 API 同形（真实写法是 `ctx.slots.inject`）。
- `slots.inject('conversation.composer.dock', ...)` + `register({ ..., id:'token-billing', order:1 }, BillingMeter)`
  —— 输入框下方徽标，原样保留。
- 全部 React 组件（107 处 `React.createElement`）、CSS 变量与主题 token、表格与卡片渲染逻辑。

必须替换 / 删除的部分：

| 动态包写法 | 真实插件写法 |
|---|---|
| `host.call('billing/state', args)` 等 5 处 | `fetch('/dsh-token-feiyong/state', ...)` 等 |
| `ctx.get('slots')` / `ctx.get('timer')` | 模块级 `export const inject = ['slots']`，`apply(ctx)` 里直接用 `ctx.slots` |
| `React.createElement` 取全局 React | bundle 内 `require('react')`；写 TSX 也行，构建时转 |
| `slots.inject('sidebar.footer.action', ...)` 注册 id `cordis-panel` 返回 `null` | **删除** |

最后一条要特别说明：冒充 `cordis-panel` 只是动态插件时代的临时手段——动态包会在侧边栏底部
留一行 "Cordis Plugin"，而真实安装的插件没有那一行，不需要隐藏它。
更糟的是它会把 Cordis 插件自己的审批/卸载 UI 一并挡掉。移植时应当去掉。

### 4.3 移植后的自测清单

1. `dsh plugin add` 或写进 profile 的 `dependencies` + `dsh.profile.bundles`，热挂载成功。
2. 设置里出现「费用统计」；`conversation.composer.dock` 徽标显示 `时段 · 单次 · 本对话 · 今日 · 余额`。
3. 发一轮对话，账本文件追加一行，徽标数字随之变化。
4. 改一次单价并保存，重启后仍生效（`configDirty` 逻辑）。
5. 卸载/停用后徽标与设置项消失，无残留路由。
6. 侧边栏底部**不再**出现 "Cordis Plugin" 行（本就该没有）。

---

## 五、提交收录的完整步骤

1. 完成第四节移植，自测通过，`main` 推到 `github.com/singei8/DSH-TOKEN-feiyong`。
2. 打 tag、发 Release，资产名不带版本号：`dsh-token-feiyong.tgz`（`tar -czf`，POSIX 路径）。
3. 等仓库创建满 1 天：**2026-09-12 14:09 UTC 之后**。
4. Fork `awesome-dsh-plugin/awesome-dsh-plugin`，新建分支，**只加一个文件**
   `data/plugins/singei8__DSH-TOKEN-feiyong.yml`（内容见第二节）。
5. （可选预览）`npm ci && node scripts/generate-readme.mjs` —— 不改 README 也能提。
6. 开 PR。CI 若报错会明确指出改什么，在同一分支推送修复即可，无需重开 PR。
7. 合并后站点自动重建，几十秒到几分钟后即可在市场搜到并一键安装。

### 时间线

| 时间 | 动作 |
|---|---|
| 现在 | 移植宿主/客户端两半，构建 `lib/`，本地自测 |
| 移植完成 | 发 `.tgz` Release，补 `dsh.bundle` 清单与 `cordis.patch.yml` |
| 2026-09-12 14:09 UTC 后 | 提收录 PR |
| 合并后 | 市场可搜到，一键安装 |

---

## 六、参考

- 收录规则原文：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>
- 目录数据：`data/plugins/<owner>__<repo>.yml` → <https://awesome-dsh-plugin.com/plugins.json>
- 目录 npm 镜像：`dsh-plugin-catalog`
- 真实插件包范例（本机已装）：`dshmarket@1.45.1`、`dsh-better-sidebar@0.19.1`
- 官方价目表：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
