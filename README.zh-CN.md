# AGY Chrome Use（Chrome 浏览器 REPL 插件）

[English](README.md) | **简体中文**

专为 **Google Antigravity（CLI / IDE / App）** 打造的有状态 Chrome 浏览器控制 MCP 插件（`cua_exec`）。优先接管你当前已打开的 Chrome 窗口，提供跨步持续可见的虚拟光标与 HUD 指示、抗遮挡语义树快照、一次授权长期免打扰以及安全的异常人工接管机制。

---

## 核心特性

- **Marketplace / GitHub 零构建开箱即用**：仓库已包含预编译运行产物（`dist/*.js`）与 [scripts/mcp-launcher.mjs](scripts/mcp-launcher.mjs)。通过 `agy plugin install` 或 Marketplace 安装时，首次启动会自动将运行时依赖自举安装至可写目录 `PLUGIN_DATA/runtime`（自动设置 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 跳过冗余浏览器下载，直接复用本机 Chrome）。
- **傻瓜式环境预检与一键安装**：安装脚本会提前校验 **Node.js（`>= 20`）**、`npm` 与 **Google Chrome**。条件不满足时拒绝安装并给出明确诊断；传入 `-AutoInstall` / `--auto-install` 或在交互确认后自动通过 `winget` / `Homebrew` / `apt` / `dnf` 安装缺失环境并验证 MCP 工具注册。
- **自动路由触发**：内置 [rules/AGENTS.md](rules/AGENTS.md) 与 [skills/cua-repl/SKILL.md](skills/cua-repl/SKILL.md)，当你在对话中贴入网址（`http://`/`https://`/`localhost`）、域名或要求操作网页 / 当前标签页时，自动调用本插件。
- **首次使用一次授权，后续永久生效**：首次调用 `cua_exec` 会拦截并返回 `AUTHORIZATION_REQUIRED`，经你确认后调用 `cua_authorize` 并持久化记录至 `PLUGIN_DATA/auth.json`，后续会话不再重复确认。
- **优先接管已有 Chrome 的连接策略**：
  1. 优先通过 CDP 附着已打开的 Chrome（默认探测 `AGY_CHROME_CDP_URL`=`http://127.0.0.1:9222` 或 Chrome 136+ 内置 `chrome://inspect/#remote-debugging` 通道）；通过内置通道连接时会在同一会话内保持授权连接，避免每轮交互重复弹窗请求许可。
  2. 若未开启远程调试，自动启动一个带独立持久化登录态的可见受管 Chrome 窗口（`PLUGIN_DATA/chrome-profile`）。
- **全程可见光标 HUD 与人机安全交接**：
  - 在操控浏览器的整个过程中（包括页面跳转、滚动、等待、连续多步 `cua_exec` 间隙），网页内虚拟光标与右上角 `AGY Chrome` 状态胶囊保持持续可见，不再因鼠标静止或步骤间隔而闪烁消失；
  - 遇到登录密码输入、短信/MFA 二次验证、验证码（CAPTCHA）或支付/删除等敏感确认时，立即停止操作并调用 `cua_reset({ scope: "control" })` 隐藏 HUD、交还控制权；回合结束时 `Stop` 钩子（[scripts/stop-hook.mjs](scripts/stop-hook.mjs)）也会自动隐藏页面 HUD。
- **多层安全边界与页面感知**：`worker_threads` + `node:vm` 隔离沙箱、`input[type="password"]` 字段自动脱敏为 `***`、穿透 Shadow DOM 进行节点提取与五点防遮挡校验（`[Occluded]`）、SSRF/危险协议与 3xx 重定向拦截、原生弹窗自动关闭与多标签页自动切换。

---

## 快速安装

### 方式 A：通过 Antigravity CLI 直接安装（零配置）

本机已装有 **Node.js `>= 20`**、`npm` 和 **Google Chrome** 时，直接运行：

```bash
agy plugin install https://github.com/Nexro920/AGY_ComputerUse
```

首次被 AGY 拉起时，`mcp-launcher.mjs` 会自动在可写的 `PLUGIN_DATA/runtime` 中补齐运行时依赖并启动 MCP 服务。

### 方式 B：免克隆傻瓜式一键安装（自动校验并可选安装 Node.js / Chrome）

**Windows（PowerShell）：**

交互式（先检查环境，缺依赖时询问是否自动 via `winget` 安装）：

```powershell
irm https://raw.githubusercontent.com/Nexro920/AGY_ComputerUse/main/scripts/bootstrap.ps1 | iex
```

无人值守一键自动安装（自动补全 Node.js LTS / Chrome + 构建 + 校验）：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Nexro920/AGY_ComputerUse/main/scripts/bootstrap.ps1))) -AutoInstall
```

**macOS / Linux（Bash）：**

交互式：

```bash
curl -fsSL https://raw.githubusercontent.com/Nexro920/AGY_ComputerUse/main/scripts/bootstrap.sh | bash
```

无人值守一键自动安装：

```bash
curl -fsSL https://raw.githubusercontent.com/Nexro920/AGY_ComputerUse/main/scripts/bootstrap.sh | bash -s -- --auto-install
```

### 方式 C：本地克隆仓库安装与卸载

```bash
git clone https://github.com/Nexro920/AGY_ComputerUse.git
cd AGY_ComputerUse
```

**Windows（PowerShell）：**

```powershell
# 仅执行前置环境检查（不写入文件）
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 -CheckOnly

# 预检通过后安装并校验 MCP 握手
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1

# 自动通过 winget 补齐缺失依赖后安装
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 -AutoInstall

# 卸载插件（默认保留 auth.json 与浏览器登录态；加 -PurgeData 一并清理）
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 -Uninstall
```

**macOS / Linux（Bash）：**

```bash
# 仅执行前置环境检查
bash ./scripts/install-local.sh --check-only

# 预检通过后安装并校验 MCP 握手
bash ./scripts/install-local.sh

# 自动通过 Homebrew / apt / dnf 补齐缺失依赖后安装
bash ./scripts/install-local.sh --auto-install

# 卸载插件（加 --purge-data 一并删除持久化数据）
bash ./scripts/install-local.sh --uninstall
```

---

## 首次使用与连接模式说明

1. 安装完成后，直接在 AGY 对话中发送带网页需求的指令，例如：`打开 https://github.com 并查看热门项目`。
2. 首次执行 `cua_exec` 时，AGY 会弹出一次授权确认；同意后即永久保存在 `PLUGIN_DATA/auth.json`，后续不再询问。
3. **关于两种 Chrome 连接模式的体验差异**：
   - **模式 1：独立调试端口窗口（推荐，零重复弹窗、无“在设置中关闭”横幅）**  
     运行项目自带脚本开启一个独立 Profile 的调试窗口，可长期登录常用系统并在不同会话间无缝复用：
     - Windows：`powershell -ExecutionPolicy Bypass -File .\scripts\launch-chrome-debug.ps1`
     - macOS / Linux：`bash ./scripts/launch-chrome-debug.sh`
   - **模式 2：Chrome 136+ `chrome://inspect/#remote-debugging`（直接复用你日常主 Chrome）**  
     在主 Chrome 地址栏打开 `chrome://inspect/#remote-debugging` 并开启开关后，插件可直接附着当前标签页。  
     > **提示**：Chrome 136+ 出于安全机制，在 `chrome://inspect/#remote-debugging` 通道首次连接时会弹出“允许远程调试”确认框，并在窗口顶部显示 `“自动测试软件正在控制 Chrome [在"设置"中关闭]”` 提示条；该提示条由 Chrome 内核控制（即使对话结束、MCP 已断开或隐藏 HUD 后仍会保留，直到你在 Chrome 点击 `×` 或关闭远程调试开关）。本插件已在同一 MCP 会话周期内保持该通道连接不主动断开，避免多轮对话中重复弹出确认框；如需彻底断开，可调用 `cua_reset({ scope: "browser" })`。
   - **模式 3：自动受管窗口（开箱兜底）**  
     未开启以上任一远程调试时，插件会自动启动独立的持久化 Chrome 窗口（`PLUGIN_DATA/chrome-profile`），登录状态同样跨会话保留。

---

## MCP 工具与 `cua.*` REPL API 一览

### 注册的 MCP 工具

| 工具名称 | 作用 |
|---|---|
| `cua_exec` | 在持久化 JS REPL 中执行多步 `async` 脚本（支持 `cua.*`、跨步 `state`、`includeSnapshot`、`includeScreenshot`、`timeoutMs`） |
| `cua_authorize` | 记录一次性用户使用授权（`{"confirm": true}`） |
| `cua_status` | 查看授权状态、当前连接模式（`attached-cdp` / `managed-profile` / `disconnected`）及已打开标签页列表 |
| `cua_reset` | 重置范围：`repl`（清空变量）、`page`（当前页跳回 `about:blank`）、`control`（立即隐藏 HUD 并交还人工操作，不关闭受管窗口）、`browser`（彻底断开 CDP / 关闭受管浏览器） |

### 常用 `cua.*` 脚本方法

- **导航与标签页**：`goto(url, { reload?, currentTab? })`、`back()`、`forward()`、`reload()`、`tabs()`、`newTab(url?)`、`switchTab(indexOrText)`、`closeTab(index?)`、`attach(cdpUrl?)`
- **页面感知**：`snapshot({ viewportOnly?, maxNodes?, includeText? })`、`screenshot({ fullPage?, format? })`、`text()`、`url()`、`title()`
- **拟人化交互**：`click(target, opts?)`、`clickAt(x, y)`、`dblclick(target)`、`hover(target)`、`type(target, text, opts?)`、`press(key)`、`scroll(dirOrDelta, amount?)`、`drag(from, to)`、`select(target, value)`
- **同步等待**：`waitText(text, timeoutMs?)`、`waitUrl(substring, timeoutMs?)`、`sleep(ms)`

---

## 开发与校验

```bash
npm install
npx tsc --noEmit
npm test

# 若已安装 Antigravity CLI，可执行严格插件规范校验
agy plugin validate --strict .
```
