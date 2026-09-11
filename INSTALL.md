# 安装说明

本插件是**真实的 DSH 插件包**（npm 包形态，带 `dsh.bundle` 清单），不是动态 Cordis 包。
仓库里已经包含构建产物 `lib/`，**安装不需要编译**。

| 半边 | 文件 | 运行位置 |
| --- | --- | --- |
| 宿主 | `lib/index.js` | DSH 的 Node 进程（拦截模型调用、计费、余额、落盘） |
| 客户端 | `lib/client.js` | 浏览器（输入框下方徽标 + 设置页「费用统计」） |
| 构造 | `src/host.js` / `src/client.js` → `node scripts/build.mjs` | 改逻辑改 `src/`，重新构建 |
| 自检 | `node scripts/check.mjs` | 72 项：计价 / 分时 / 收口 / 落盘 / slot 注册 / 重入 |

---

## 方式一：插件市场（收录完成后，最省事）

打开 **设置 → 插件市场**，搜索 `token`、`费用` 或 `billing`，点卡片上的安装按钮。

市场会自己完成"加依赖 → 追加 bundle → 热挂载"整条链路，装完即用，不需要手动重启。

> 收录状态见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。条目合并进
> [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
> 之后市场才能搜到；在那之前请用方式二。

---

## 方式二：命令行安装

`dsh plugin` 是 profile 目录里 pnpm 的封装：它装包，并按包内 `dsh.bundle.patch`
声明的清单把包名追加进 profile 的 `dsh.profile.bundles`，profile 下次启动即挂载。

```powershell
# 从 npm（发布后可用）
dsh plugin --profile web add dsh-token-feiyong

# 从 GitHub 源码（仓库已含预构建 lib/，无需构建）
dsh plugin --profile web add github:singei8/DSH-TOKEN-feiyong

# 从本地克隆目录
git clone https://github.com/singei8/DSH-TOKEN-feiyong
dsh plugin --profile web add link:E:/path/to/DSH-TOKEN-feiyong
```

装完**重启 DSH**（新 bundle 在启动时进层叠配置）。

---

## 方式三：手动安装（完全可解释，等同方式二的产物）

1. 在 profile 目录建好包链接（`~/.dsh/profiles/web`）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-token-feiyong" `
  -Target "E:\path\to\DSH-TOKEN-feiyong"
```

2. 编辑 `~/.dsh/profiles/web/package.json`：`dependencies` 加一行
   `"dsh-token-feiyong": "link:E:/path/to/DSH-TOKEN-feiyong"`，
   并在 `dsh.profile.bundles` 数组末尾加 `"dsh-token-feiyong"`。

3. 重启 DSH。

> 也可以先跑 `pnpm install`，但 profile 里已有大量依赖，首次解析可能较慢；
> 直接建 junction 等价于 `link:` 的产物，且不触碰依赖图。

### 先不重启地验证（可选）

`web` profile 的 `patchReload` 是 `live`：profile 自己的 `cordis.patch.yml` 会被监听并实时重组。
临时在其中插入一行即可热挂载，不必重启：

```yaml
- insert:
    - id: token-feiyong
      name: 'dsh-token-feiyong'
```

⚠️ **验证完必须删掉这一行**：正式渠道（`dsh.profile.bundles`）会通过包自带的
`cordis.patch.yml` 提供同一条 `insert`，两处同时存在会重复挂载同一个插件，
`/dsh-token-feiyong/*` 路由会注册两次。

---

## 验证

| 检查项 | 期望 |
| --- | --- |
| 输入框下方 | 徽标：`● 低谷 · 单次 ¥… · 本对话 ¥… · 今日 ¥… · 余额 ¥…` |
| 设置页 | 左侧设置列表多出 **费用统计** |
| 悬停徽标 | 单次 / 本对话 / 今日明细、余额拆分、高峰规则、存档状态 |
| 页面启动清单 | 浏览器控制台执行 `__DSH_BOOT__.entries.some(e => e.id === 'dsh-token-feiyong')` → `true` |
| 宿主路由 | `curl -X POST -H "x-dsh-token-feiyong: 1" http://127.0.0.1:3080/dsh-token-feiyong/state` → JSON 快照 |
| 首次调用后 | 生成存档 `<DSH_HOME>/token-billing-ledger.json`（通常 `~/.dsh/token-billing-ledger.json`） |
| Host 日志 | 含 `[billing]` 前缀的行：`apply:` / `http: mounted 5 routes` / `store: ready` |

改过 `src/` 后跑一次 `node scripts/check.mjs`：它会真起一个 HTTP 服务把 5 条路由注册进去，
用真实请求跑通记账、分时计价、单次收口、落盘、配置保存与清空，并校验客户端 bundle 的
加载与 slot 注册。

---

## 前置条件与权限

- **必需**：DSH（`web` profile）。宿主需提供 `webServer` 与 `fs` / `settings`；
  客户端需提供 `slots`。缺失时对应功能降级并给出提示，不影响计费本身。
- **落盘**：账本写在 `~/.dsh/` 下（**工作区之外**），因此写入时按次请求
  `danger-full-access` 策略；否则会被默认的 `workspace-write` 挡下，
  表现为存档报 `file access denied under workspace-write mode`。
- **余额**：需要 `credentials`（默认引用 `DEEPSEEK_API_KEY`）、`shell`，以及能访问
  `https://api.deepseek.com`。这条**只读 GET** 同样按次以非沙箱方式执行。
- 插件不发送任何遥测；API Key 只进子进程环境变量，不写日志、不下发前端。

---

## 卸载

- 市场里点卸载；或从 profile 的 `dependencies` 与 `dsh.profile.bundles` 里移除，
  删掉 `node_modules/dsh-token-feiyong`，重启。
- 想同时清空历史数据，删除 `<DSH_HOME>/token-billing-ledger.json`。

卸载或停用之后，徽标与设置项都会消失，`/dsh-token-feiyong/*` 路由随 fiber 一并注销。

---

## 更新

```powershell
cd <你克隆的目录>
git pull          # lib/ 是提交进仓库的，不需要重新构建
```

然后重启 DSH。用 npm 安装的则等新版本发布后重新 `dsh plugin --profile web add dsh-token-feiyong@<版本>`。

---

## English quick start

A **real DSH plugin package** (npm shape with a `dsh.bundle` manifest), not a dynamic Cordis
package. Prebuilt `lib/` ships in the repo, so **no build step is needed to install**.

```powershell
dsh plugin --profile web add github:singei8/DSH-TOKEN-feiyong
```

Then restart DSH. After catalog intake you can also install it from the in-app plugin market
(search "token" / "billing"). Host half: `lib/index.js` (billing, balance, ledger over
`/dsh-token-feiyong/*`). Client half: `lib/client.js` (composer badge + settings section).
Rebuild with `node scripts/build.mjs`, self-test with `node scripts/check.mjs`.
