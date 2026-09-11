# 安装说明

本插件是 **DSH 动态 Cordis 插件**，**没有 exe / msi 安装包，也不需要编译**：
`src/host.js` 与 `src/client.js` 的内容本身就是 `cordis_define` 参数的 `code.host` / `code.client`（函数体）。
所以"安装"= 把这两段代码定义进你的 DSH，并激活它。

---

## 方式一：让你的 DSH Agent 自己装（推荐，三步）

直接在 DSH 里对新会话说（可整段复制）：

> 请用 web_fetch 读取下面两个文件，把内容分别作为 `code.host` 和 `code.client` 调用 `cordis_define`，
> 然后用 `cordis_run`（模式 `run`）激活，并把返回的 pluginId / packageId 告诉我：
>
> - https://raw.githubusercontent.com/singei8/DSH-TOKEN-feiyong/main/src/host.js
> - https://raw.githubusercontent.com/singei8/DSH-TOKEN-feiyong/main/src/client.js
>
> 如果读取失败，我会直接把两个文件内容贴给你。

Agent 会依次调用 `cordis_define` → `cordis_run`。**客户端半体需要你在界面里点一次"允许"**（一次性授权；勾双勾可授权该插件的后续版本）。

网络不通时用方式二。

---

## 方式二：手动安装

1. 从 [Releases](https://github.com/singei8/DSH-TOKEN-feiyong/releases) 下载 `DSH-TOKEN-feiyong-v1.0.0.zip`，或 `git clone` 本仓库；
2. 打开 `src/host.js` 与 `src/client.js`，**全文**复制；
3. 在 DSH 中让 Agent 调用 `cordis_define`：
   - `plugin`: `{ "kind": "new", "idPrefix": "tokbil" }`（前缀可自定，3–6 个小写字母；实际 ID 由宿主分配）
   - `name`: `DSH-TOKEN-feiyong`
   - `code.host`: `src/host.js` 全文
   - `code.client`: `src/client.js` 全文
4. 用返回的 `pluginId` / `packageId` 调用 `cordis_run`（模式 `run`）；
5. 界面出现授权请求时点"允许"。

---

## 验证

| 检查项 | 期望 |
| --- | --- |
| 输入框下方 | 出现徽标：`● 低谷 · 单次 ¥… · 本对话 ¥… · 今日 ¥… · 余额 ¥…` |
| 设置页 | 左侧设置列表多出 **费用统计** |
| 悬停徽标 | 显示单次/本对话/今日明细、余额拆分、高峰规则、存档状态 |
| 首次调用后 | 生成存档文件 `<DSH_HOME>/token-billing-ledger.json`（通常 `~/.dsh/token-billing-ledger.json`） |
| Host 日志 | 含 `[billing]` 前缀的行：`apply:` / `balance ok` / `store: ready` 等 |

---

## 前置条件与权限

- **必需**：DSH（DeepSeek Harness）；宿主需提供 `slots`（客户端 UI）与 `llm`（拦截计费）。
- **余额**：需要 `credentials`（凭据引用，默认 `DEEPSEEK_API_KEY`）、`shell`，以及能访问 `https://api.deepseek.com`。
  工作区沙箱默认没有网络权限，插件会把这条**只读 GET** 以"非沙箱"方式执行（可在设置页关闭）。
- **落盘**：需要 `fs` 与 `settings`（用于定位 DSH 主目录）。缺失时对应功能降级并给出提示，**不影响计费本身**。
- 插件不发送任何遥测；API Key 只进子进程环境变量、不写日志、不下发前端。

---

## 卸载

1. 让 Agent 调用 `cordis_undefine`，传入安装时返回的 `pluginId`（或调用 `cordis_stop` 仅停用）；
2. 如需彻底清除数据，删除 `<DSH_HOME>/token-billing-ledger.json`。

停用或删除插件后，它对界面的所有占用（徽标、设置页、被遮蔽的入口）都会自动恢复。

---

## 更新

```powershell
cd <你克隆的目录>
git pull
```

然后重复"方式一/方式二"的定义与激活步骤（每次都是新增一个不可变的 Package，旧版本仍可回滚）。

---

## English quick start

This is a **dynamic Cordis plugin for DSH** — there is no installer and no build step.
`src/host.js` / `src/client.js` **are** the bodies of `cordis_define`'s `code.host` / `code.client`.

Fastest path: ask your DSH agent to `web_fetch` the two raw files and pass them to `cordis_define`,
then activate with `cordis_run`. Approve the client half once in the UI.
