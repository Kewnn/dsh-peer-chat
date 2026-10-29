---
name: dsh-peer-chat
description: 跨 DSH 实例端到端对话插件：自动识别对端 web token，提供 8 个 peer_* 工具，并与 session-tools / session-plus 融合而非重造。
---

# dsh-peer-chat

跨 DSH 实例对话的一个插件：**自动识别对端 token**，登录取 cookie，建/选会话，投递消息，再轮询会话日志取回回复。本机目标（`self`）则直接复用已有的会话能力，不另起一套。

```
dsh-peer-chat/
├─ index.js      插件本体（cordis 插件：name / inject / apply）
├─ package.json  包声明（peer 只依赖 @deepseek-ai/cordis）
└─ README.md     本文
```

## 身份

- **DSH 插件，不是独立脚本**：导出 `name`/`inject`/`apply(ctx, config)`，用 `ctx.tools.register(...)` 注册八个 `peer_*` 工具，**不碰 `session_*` 命名**。
- **不注册任何服务/domain**（不会 `already open`）；参数用 JSON Schema 声明。
- 不 import 任何宿主内部包（只用 Node 内置模块）；`peerDependencies` 只声明 `@deepseek-ai/cordis`。
- 两条路线：**remote**（跨实例 HTTP）与 **local**（`self`，本机会话服务）；只做投递/取回复/插话，不代对端决策。
- 浏览器半侧 client.js：侧栏左下角「🐟 跨端对话」，点开弹层；面板可加行（勾选对端/端口 + 选模式）拼 A→B→C 链路并保存，数据/写入走 GET/POST /dsh-peer-chat-api。

## 输入

对端清单是 `peers.json`（默认 `<DSH_HOME>/peer-chat/peers.json`，其次本机历史路径 `E:\dshlaw\tools\dsh-peer\peers.json`；可用 `config.peersFile` 或 `PEER_CHAT_PEERS` 覆盖）。**也可以不写**：插件会自动扫本机带启动日志的 DSH home，从 `dsh web: …?token=…` 那行同时拿到 url 与 token（有限深度 + 4 秒预算，结果缓存 30 秒）。

```json
{
  "longer": { "url": "http://127.0.0.1:3090", "home": "E:\\dshlonger\\dsh-home", "token": "（缓存，可缺）" },
  "local1": { "local": true, "home": "E:\\dshsystem\\dsh-home" }
}
```

- `url` 必填（remote）；`home` 用来扫启动日志与解会话日志；`token` 只是缓存。
- `peer: "self"`（或 peers 条目 `local: true`）→ **同实例跨会话**（不联网），`home` 缺省取 `DSH_HOME`（也可用 `config.localHome`）。
- 插件级配置：`peersFile`、`token`（等同 `--token`）、`localHome`、`tokenCommand`、`chainsFile`。
- `peer` 也接受端口（`3080` / `3090` 都行）；默认按**名字**自动发现（扫 home 与启动日志），`peer_list({ scan: true })` 才额外扫端口段（401 签名，没令牌标 `none`）。

固定链路存 `<DSH_HOME>/peer-chat/chains.json`：`peer_chains` 增删、装载内置模板（`review-loop` / `relay` / `quick-ask`）、`export`/`import` 分享；跑用 `peer_chain({ name, input })`。面板里：模式**自动识别**（服务 → profile 声明）并可逐行切「自动/手动」，链路「运行」结果弹窗展示，另有「保存并发送」与导出/导入。

`tokenCommand`：自定义捞令牌命令，模板可写 `{peer}` `{url}` `{home}` `{port}`，取 stdout 最后一个 `token=…`：

```yaml
config:
  peersFile: E:\dshlaw\tools\dsh-peer\peers.json
  tokenCommand: powershell -NoProfile -ExecutionPolicy Bypass -File "E:\dshsystem\fmd\plugins\dsh-peer-chat\scripts\read-token.ps1" -Port {port}
```

`scripts/read-token.ps1`（随包附带）：按端口找对端进程 → `AttachConsole` 挂它的 cmd 窗口 → 读屏缓冲 → 捞 `dsh web: …?token=…` 那行。仅 Windows，且要求窗口还开着、那行还在回滚里。

| 工具 | 必填 | 可选 |
|---|---|---|
| `peer_token` | `peer` | — |
| `peer_list` | — | `discover`（默认 true） |
| `peer_modes` | — | `peer` |
| `peer_chains` | — | `action`（list/add/remove/install-template/export/import）、`name`、`chain`、`template`、`peer`、`overwrite`、`json` |
| `peer_ask` | `message`（`peer` 省略 = 本端） | `sessionId`、`newSession`、`preset`、`cwd`、`timeoutMs` |
| `peer_chain` | — | `name` 或 `steps`、`input`、`mode`、`maxRetries`、`failurePattern`、`templates`、`timeoutMs`、`stopOnError` |
| `peer_steer` | `message`、`sessionId` | `peer` |
| `peer_tail` | `sessionId` | `peer`（省略 = 本端）、`n` |

`peer_ask` 的会话选择：给 `sessionId` 就续该会话；不给就新建。`sessionId` 与 `newSession:true` 同时给直接报错，不做二选一猜测。

`peer_steer` 是**插话**：只对已存在的会话，投到当前 turn 的 next-step 边界，不新开 turn；目标空闲时会唤醒它当场开一个 turn（不是静默排队，也不报错）。它是回执语义——只回「投递成功 + 用了哪种模式」，不等回复。

令牌来源（优先级从高到低）：`config.token` → `PEER_TOKEN` → `<home>` 下 `*.log` 里的启动行 → `tokenCommand` → `peers.json` 缓存。登录 401 时，插件会把「日志候选 + 缓存 + tokenCommand」合起来依次重试，谁先登上谁被写回缓存。

## 产出

`peer_token` → `{ peer, url, home, tokenPrefix, tokenLength, sourceKind, source, candidates[] }`，`tokenPrefix` 只有前 6 位，**永不回全文**；`sourceKind ∈ env | log | command | cache`；`candidates` 是各份日志给出的候选（同样只留前 6 位 + 日志路径），用来诊断「哪份日志的 token 才是活的」。只读；配了 `tokenCommand` 时会执行那条命令（不联网）。

`peer_ask` → `{ ok, peer, route, sessionId, created, createVia, deliverVia, degraded[], reply, timedOut, waitedMs, turnsBefore, tokenSourceKind, tokenSource }`。`route ∈ remote | local`；`createVia` / `deliverVia` 说明实际走了哪条；`degraded` 记降级原因。回复取「投递前最大 `turn` 之后」的 assistant 消息，等 `turn/end` 收工。

`peer_steer` → `{ ok, peer, route, sessionId, mode, accepted, deliveredVia, targetStatus, degraded[] }`。`mode ∈ steer | queue`：本机走 `session_steer` 时它会自己判断目标是否在跑，空闲就退化成排队，回执如实写 `queue` 与 `targetStatus`；远程一律 `steer`。

`peer_chain` → `{ ok, stoppedAt, steps[{ peer, mode, status, bytes, sessionId, reply, error? }], final, waitedMs }`。链路版：按 `steps` 顺序多跳，上一步回复附到下一步（消息里写 `{prev}` 则原位替换）。支持 `{sN}` / `{sN.json.foo}` 引用前面步骤（缺字段会报错）；`onFail:"skip"` 可跳过失败步。**模式 = 该步用哪个对端默认模式建会话**，优先级 `steps[i].mode > 顶层 mode > 对端默认`；无效模式报「未知模式」。**省略 `message` 时按该步模式自动生成**（审阅类模式走审阅模板，可用 `templates` 覆盖）；**返工判定交给模型**：审阅步最后一行写 `NEXT` 就进下一步，写 `REWORK` 就重跑上一步再复审（`maxRetries` 默认 2，`failurePattern` 可改用正则）。

`peer_chains` → `{ file, count, chains[{ name, description, mode, steps[] }], modes[] }`，面板排版：每条链路 + 步数 + 默认模式 + 每步 `peer / mode / 消息预览`，末尾附可用模式清单。`action: add/remove` 直接改 `chains.json`。

`peer_modes` → `{ source, count, modes[{ id, name, description, isDefault }] }`，按面板排版（标题 + 分隔线 + 对齐表格，★ = 默认模式）。省略 `peer` 读本机 `agentPresets`；给了 `peer` 则试对端 `agentPresets/list`。

`peer_list` → `{ peers: [{ name, url, home, origin, tokenPrefix, sourceKind }], roots[] }`，`origin ∈ peers.json | discovered`。只读；自动发现会扫盘（有预算上限），不联网。

`peer_tail` → `{ peer, sessionId, logFile, totalAssistant, messages: [{ turn, text }] }`，只读本地日志，不发请求。

## 步骤

包已按商城形状交付：`dsh.bundle.patch` + `cordis.patch.yml`（`id` 与包名一致）。

1. **装**（推荐；幂等、带备份与回滚）：

```powershell
pwsh -NoProfile -File E:\dshsystem\fmd\plugins\dsh-peer-chat\scripts\install-peer-chat.ps1 -Target <profile 目录>
```

脚本会备份 `package.json` / `cordis.patch.yml` → 复制插件 → 写 `file:` 依赖并加入 `dsh.profile.bundles`（UTF-8 无 BOM）。**不要再手写 `- insert:`**：会与 bundle 重复挂载，脚本检测到直接 `exit 3` 拒绝。

2. **生效**：重启目标实例（或挑它空闲时）；起来后工具表应出现 8 个 `peer_*` 工具，面板在左下角。

3. **卸载**：`scripts\uninstall-peer-chat.ps1 -Target <profile>`，与安装前字节级一致。

**分发给别人**：`npm publish` 后对方 `pnpm add dsh-peer-chat` 并加进 `dsh.profile.bundles`；或提交商城收录（`cordis.patch.yml` 已按契约写好）；或走 dsh-m 的 github 源。发布前补 `repository` / `homepage` / `bugs`。

**换机器**：什么都不配也行——自动扫本机带启动日志的 DSH home；想固定名字再写 `peers.json`。

## 验收

- **A1 识别**：`peer_token({ peer: 3090 })` → 回前 6 位 + 来源；回落 `cache` 也正常。
- **A2 只读**：`peer_tail({ peer: 3090, sessionId: "…", n: 3 })` → 3 条正文。
- **A3 跨实例**：`peer_ask({ peer: 3090, message: "只回 OK", newSession: true })` → `reply` 非空。
- **A4 本机**：`peer_ask({ peer: "self", message: "只回 OK" })` → `route: "local"`，`createVia` 显示走了哪条。
- **A5 从 cmd 读**：配好 `tokenCommand` 后 `peer_token` → `sourceKind: "command"`，`peer_ask` 遇到死令牌也能靠它自愈。
- **A6 链路**：`peer_chain({ mode: "fmd-review", steps: [{ peer: 3090, message: "…" }, { peer: 3130, message: "基于上一步：{prev}", mode: "fmd-fast" }] })` → 两步都 `ok`，第二步消息里能看到第一步回复，且第二步按 `fmd-fast` 建会话。
- **A7 插话**：`peer_steer({ peer: 3090, sessionId: "<对端会话 id>", message: "补一句：…" })` → 2.3 秒回 `accepted`，随后 `peer_tail` 能看到目标会话多出一条新 assistant 消息（实测 8.3 秒内出现，且目标原本空闲）。
- **A7b 模式自检**：`peer_modes()` → 面板出模式数与默认项。
- **A8 固定链路**：面板里加两条（`self`/端口 + 模式），保存后 `peer_chain({ name })` 跑通。
- **A9 机检**：`node E:\dshsystem\fmd\pipeline\tools\review-stage.mjs forge <文件>`，逐个出 VERDICT。

## 兼容矩阵与边界

| 装了谁 | 跨会话建 | 跨会话投 | 跨会话插 | 跨端 |
|---|---|---|---|---|
| session-tools | `session_create` | `session_send` | `sessionController.prompt(mode=steer)` | 本插件 HTTP |
| session-plus | `ctx.agents.create` + `sessionController.prompt` | `sessionController.prompt` | `session_steer` | 本插件 HTTP |
| 都没装 | `ctx.agents.create`（缺默认模型报错） | `sessionController.prompt` | `sessionController.prompt(mode=steer)` | 本插件 HTTP |

边界：跨会话归 session-tools / session-plus（本插件只调用不重造）；跨端归本插件。降级不静默，`createVia` / `deliverVia` / `degraded` 写清走了哪条。

## 反例

1. **401**：token 轮换但日志没更新；带 tee 重启对端或改 `peers.json`。最新日志不一定是活进程的 token，所以 401 后会把该 home 的日志候选逐个试，登上的写回缓存。
2. **日志缺失**：只剩显式令牌、缓存、`tokenCommand`（读 cmd 屏缓冲）；最后一条能在令牌已换时救回来，代价是窗口还开着。


3. **把插话当问答**：`accepted: true` 只代表进了 inbox；要回复用 `peer_tail`。空闲时插话会唤醒它开 turn。
