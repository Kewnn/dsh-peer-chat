# dsh-peer-chat 架构说明

> 读者：第一次接手这个插件的人（维护 / 二次开发 / 排查线上问题）。
> 读完你应该能回答：面板点一下，代码里到底发生了什么；哪一步失败会看到什么字段。
>
> **行号快照**：2026-10-29 04:50 · `index.js` 2323 行 · `client.js` 488 行 · `README.md` 152 行。
> 这三个文件在活跃开发，行号会漂移。**每处都同时给了函数名**，按函数名搜是权威的。

---

## 1. 它解决什么问题

两个 DSH 实例（例如本机 3130 和另一个 3090）各自有会话、模型、工具。
本插件的职责只有一句话：**把一句话投到另一个实例里，再把那边最后一条回答取回来。**

它**不**负责：给对端建会话的策略、对端的模型选择、跨会话的通用能力（那些归 `session-tools` / `session-plus`）。

---

## 2. 三个半侧

| 半侧 | 文件 | 跑在哪 | 干什么 |
|---|---|---|---|
| 浏览器半侧 | `client.js` | 浏览器（`window.__ModuleLoader__`） | 侧栏入口 + 弹层面板 + 设置页；只通过 HTTP 说话 |
| 插件本体 | `index.js` | dsh web 的 Node 进程 | 注册 8 个 `peer_*` 工具 + 一条面板 HTTP 路由 |
| 对端实例 | 另一个 DSH | 另一台/另一个端口 | 收 `session/create`、`session/prompt`，把回答写进自己的会话日志 |
| 磁盘状态 | `peers.json` / `chains.json` / `sessions/*` | 本机与对端 home | 对端表、链路表、**回答的唯一真相来源** |

关键设计：**回答不是 HTTP 返回的，是从对端的会话日志里读的**。HTTP 只负责「投进去」。这也是唯一能保证「等到这一 turn 真的收工」的办法。

---

## 3. 数据流（一张图）

```
[用户点 🐟 跨端对话]
        │  client.js · SidebarAction → setOpen(true)
        ▼
[PeerDialog]  ──GET /dsh-peer-chat-api──►  registerPanelRoute(index.js:1601)
        │                                        │
        │                                        └─ snapshot(): peers + modes + chains + templates
        ▼
[PeerPanel]  渲染对端 / 模式 / 固定链路
        │
        ├─ 选对端 ──GET /dsh-peer-chat-api?peer=3090──► fetchModeRows(index.js:1589)
        │                                                  └─ remote: openSession → rpc('agentPresets/list')
        │                                                  └─ local : detectModes(index.js:1574)
        │
        ├─ 保存 ──POST {action:'save-chain'}──► validateChain → chains.json
        └─ 运行 ──POST {action:'run-chain'}───► runChain(index.js:967)
                                                      │
                                                      ▼
                                            runStep(index)  ← 每步：算消息 → 解析对端
                                                      │
                                                      ▼
                                            runAsk(index.js:858)
                                            ┌─────────┴──────────┐
                                    peer.local?              否则（remote）
                                            │                     │
                                            ▼                     ▼
                                   askLocal(809)           askRemote(747)
                                   createLocalSession      openSession(425)
                                    └ session_create         ├ resolveToken(365) 四级来源
                                      或 agents.create       ├ login()  取 cookie
                                   deliverLocal              └ 401 → 候选逐个重试 → 写回 peers.json
                                    └ session_send           rpc('session/create')
                                      或 prompt              rpc('session/prompt', mode:'queue')
                                            │                     │
                                            └────────┬────────────┘
                                                     ▼
                                    waitForReply(684)  ← 轮询对端会话日志
                                                     │
                                    findSessionLog(659) → decodeEvents(602) 逐帧 zstd
                                                     │
                                            summarize(): lastTurn / assistants / endedTurns
                                                     │
                                     出现 turn > before 的 assistant 且 turn 已 ended → 返回
                                                     ▼
                                     { ok, reply, timedOut, stoppedAt, steps[], final }
```

用一句话背下来：
**面板 → `/dsh-peer-chat-api` → `runChain` → `runStep` → `runAsk` →（对端 HTTP RPC ｜ 本机会话）→ `waitForReply` 读日志。**

---

## 4. 三条路线

| 路线 | 触发 | 建会话 | 投递 | 取回 |
|---|---|---|---|---|
| `remote`（跨端） | `peer` 是另一个实例（名字 / 端口） | 对端 HTTP `session/create` | 对端 HTTP `session/prompt`（`mode:'queue'`） | 读**对端 home** 的会话日志 |
| `local`（跨会话） | `peer:"self"` 或 peers 条目 `local:true` | `session_create` 工具 → 退到 `ctx.agents.create` | `session_send` → 退到 `sessionController.prompt` | 读**本机 home** 的会话日志 |
| `tailOnly`（只读） | 对端只有 `home`、没有 `url` | 不允许 | 不允许 | 只允许 `peer_tail` |

`tailOnly` 是桌面端的正经形态：Electron 内部服务没有对外的 web 端口，令牌在进程内存里，**只能读它的日志**。
走到 `peer_ask` / `peer_steer` 会明确报错（`runAsk` / `runSteer` 里的 `tailOnly` 分支），不会假装成功。

---

## 5. 工具清单（8 个）

注册位置都在 `apply()`（`index.js:1720`）里，逐个 `ctx.tools.register({ name, parameters, output, execute })`。

| 工具 | 必填 | 可选 | 干的事 | 有副作用吗 |
|---|---|---|---|---|
| `peer_token` | `peer` | — | 只报前 6 位 + 来源 + 全部候选 | 只读；配了 `tokenCommand` 会执行那条命令 |
| `peer_list` | — | `discover`（默认 true）`scan`（默认 false，额外扫端口段） | 列出对端（self / peers.json / 自动发现 / 端口扫描） | 只读；会扫盘（有预算上限），不联网建会话 |
| `peer_modes` | — | `peer` | 模式清单（= agent preset） | 只读；给 `peer` 时会登录对端 |
| `peer_ask` | `message` | `peer` `sessionId` `newSession` `preset` `cwd` `timeoutMs` | 投一条消息并**等回复** | **写**：对端/本机新建会话 + 投递 |
| `peer_chain` | —（`steps` 或 `name` 二选一） | `mode` `input` `maxRetries` `failurePattern` `templates` `timeoutMs` `stopOnError` | 多步链路，上一步回复喂下一步 | **写**：每一步都是一次 `peer_ask` |
| `peer_steer` | `message` `sessionId` | `peer` | 插话，**不等回复** | **写**：向已有会话投递 |
| `peer_tail` | `sessionId` | `peer` `n` | 取最近 n 条 assistant 正文 | 只读本地日志，不联网 |
| `peer_chains` | — | `action` `name` `chain` `template` `peer` `overwrite` `json` | 管固定链路（增删改/模板/导入导出） | **写** `chains.json` |

分工记忆法：**`ask` 要回复、`steer` 只要回执、`tail` 只读、`chains` 管账本。**

---

## 6. `peer_chains` 的 6 个 action

枚举在 `index.js:2121`（参数 schema）与 `execute` 的分支里。

| action | 必填 | 作用 | 失败时 |
|---|---|---|---|
| `list`（默认） | — | 列出 `chains.json` + 本机模式清单 | 文件不存在 → 空表 |
| `add` | `name` `chain` | 写入一条链路（`validateChain` 校验） | 同名且无 `overwrite:true` → 报「已存在」 |
| `remove` | `name` | 删除一条 | 不存在 → 报「没有链路」 |
| `install-template` | `template` | 装内置模板 `review-loop` / `relay` / `quick-ask` | 同名 → 报「已存在」（`installTemplate`，`index.js:1273`） |
| `export` | — | 原样吐出 `chains.json` 文本 | — |
| `import` | `json` | 合并导入（逐条 `validateChain`） | 有同名且无 `overwrite:true` → **整批不写**并列出冲突名 |

注意 `import` 是**全有或全无**：只要有一个冲突名，`conflicts` 非空就直接抛错，一条都不落盘。

---

## 7. 面板 HTTP 接口

一条路由：`/dsh-peer-chat-api`（`registerPanelRoute`，`index.js:1601`），`kind:'exact'`，只吃 GET/POST。

| 请求 | 返回 |
|---|---|
| `GET /dsh-peer-chat-api` | `{ ok, peers[], modes[], modesSource, chains[], templates[] }` |
| `GET /dsh-peer-chat-api?peer=3090` | `{ ok, peer, source, count, modes[] }` |
| `POST {action:'save-chain', name, chain}` | 保存 + 回一份新快照（`changed`） |
| `POST {action:'remove-chain', name}` | 删除 + 新快照 |
| `POST {action:'install-template', template, name?, peer?, overwrite?}` | 装模板 + 新快照 |
| `POST {action:'import', json, overwrite?}` | 合并导入 + 新快照 |
| `POST {action:'export'}` | `{ ok, json, count }` |
| `POST {action:'run-chain', name, input}` | `{ ok, result }`（`result` 就是 `runChain` 的返回值） |

错误一律 `{ ok:false, error:"<单行原因>" }`，HTTP 400（参数/校验）或 500（读取快照时炸了）。
面板侧把这些 `error` 直接渲染成红字，所以**报错文案就是给用户看的**，别写内部堆栈。

---

## 8. 关键概念（落地到代码）

| 概念 | 含义 | 代码落点 |
|---|---|---|
| `self` | 本实例的另一个会话，不联网 | `resolvePeerTarget` 的 `raw === 'self'` 分支（`index.js:151`） |
| 跨端 / `remote` | 另一个 DSH 进程，走 HTTP | `askRemote`（`index.js:747`） |
| 跨会话 / `local` | 同进程、不同 session | `askLocal`（`index.js:809`） |
| 模式 = preset | 建会话时用哪个 agent preset | `preset` 参数 → 对端 `session/create` 的 `agentPreset`；本机走 `agentPresets.resolve` |
| 链路 | 一条有序的步骤序列，存成 JSON | `CHAIN_TEMPLATES`（`index.js:1247`）+ `validateChain`（`index.js:1296`） |
| 步骤 / step | 链路里的一跳：`{ peer, message?, mode?, sessionId?, timeoutMs?, onFail?, maxRetries? }` | `runStep`（`runChain` 内，`index.js:997` 附近） |
| `{input}` | 链路入口参数，替换成 `peer_chain({ input })` | `resolveStepMessage`（`index.js:934`） |
| `{prev}` | 上一步回复；写了就**原位替换**，没写就**追加到末尾** | 同上，含「（上一步回复）」兜底拼接 |
| `{sN}` / `{sN.json.field}` | 引用第 N 步回复 / 从它的 JSON 里取字段 | `applyStepRefs`（`index.js:902`）；缺步骤、非 JSON、缺字段都**报错不静默** |
| 返工 | 审阅步说「不行」就重跑上一步 | `judgeVerdict`（`index.js:955`）看回帖**最后一行** `NEXT` / `REWORK` |
| 自动消息 | 省略 `message` 时按模式生成 | `autoTemplateFor` + `MODE_TEMPLATES`（`index.js:885`） |
| 降级 | 换了实现路径但没失败 | `createVia` / `deliverVia` / `degraded[]` 三个字段如实写 |
| `tailOnly` | 只有 home、没有 url 的对端 | `normalizePeerEntry` 的「只有 home」分支 |

### 消息解析顺序（`resolveStepMessage`）

1. 显式 `message` 且不是 `__auto__` → 用它；
2. 否则查 `templates[mode]`（调用方传入的自定义模板）；
3. 否则 `autoTemplateFor(mode, index)`：模式名含 `review|audit|check|审` → 审阅模板；第 0 步 → 干活模板；其余 → 继续模板；
4. 然后依次替换 `{sN}` → `{input}` → `{prev}`。

`{prev}` 的两种行为是排查「链路串味」的第一现场：**写了占位符才是原位替换**，没写就是整段追加。

---

## 9. 令牌与登录

`resolveToken`（`index.js:365`）四级优先级，从高到低：

1. `config.token`（等同 `--token`）→ 2. `PEER_TOKEN` 环境变量 → 3. `<peerHome>/*.log` 里的启动行 `dsh web: http://…?token=…` → 4. `tokenCommand` 的输出 → 5. `peers.json` 里缓存的 `token`

`tokenCandidates`（`index.js:293`）会把**每份日志**的最后一条启动行都留成候选，因为「最新写的日志」不一定属于「正在跑的那个进程」。

`openSession`（`index.js:425`）的 401 自愈：把「日志候选 + 缓存 + `tokenCommand`」合成一张候选表逐个试，**谁先登上就把谁写回 `peers.json`**。
显式令牌（`config.token` / `PEER_TOKEN`）不参与重试——用户既然指定了，就尊重它。

登录 = `GET <base>/?token=…`（`redirect:'manual'`），从 `set-cookie` 里拼出 `name=value; …`，之后所有 RPC 都带这个 cookie。
RPC 信封固定：`POST <base>/api/<method>`，body `{ type:'client-request', rpcId, method, payload:{ args } }`，读 `result.ok` / `result.value`；HTTP 401 单独标记成 `error.unauthorized`。

---

## 10. 会话日志是唯一真相

```
<home>/sessions/<sessionId>/session.v4.jsonl.zstd                  ← 布局 A
<home>/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd      ← 布局 B
```

`findSessionLog`（`index.js:659`）先试 A 再扫 B，两种都要支持：本机自建会话常是 A，跨端/工作区会话常是 B。

`decodeEvents`（`index.js:602`）的两个硬约束：

- **多帧**：文件是「zstd 帧首尾相接」，不是单个压缩流。所以按魔数 `28 b5 2f fd` 找到每一帧的起点，逐帧 `zstdDecompressSync`，再拼起来按行 `JSON.parse`。
- **容错**：半截帧（对端正在写）解不出来就跳过，坏行也跳过。宁可少一条，不要整份失败。

`waitForReply`（`index.js:684`）的结束条件：出现 `turn > before` 的 assistant 正文，**且**该 turn 已经收到 `turn/end`；否则每 1500ms 再读一次，到点前 4 秒仍未收工就把已有正文交出去（此时 `timedOut` 的判定由 `reply === ''` 决定）。

本机实测（`--E-dshsystem-Documents-deepseek-harness-default-workspace--` 下一个 4.6MB 日志）：**2944 帧、0 帧失败、5290 行 JSON、830 条 `assistant/message`**。这个量级说明「整份读完再筛」是可行的，不需要增量读。

---

## 11. 落盘文件

| 文件 | 默认位置 | 谁写 | 说明 |
|---|---|---|---|
| `peers.json` | `<DSH_HOME>/peer-chat/peers.json` | 用户 + 401 自愈时写回 `token` | 也可用 `config.peersFile` / `PEER_CHAT_PEERS` 覆盖 |
| `chains.json` | `<DSH_HOME>/peer-chat/chains.json` | `peer_chains` 与面板 | 原子写（临时文件 + rename） |
| 会话日志 | `<home>/sessions/…/session.v4.jsonl.zstd` | DSH 自己 | 只读，永不修改 |
| 安装记录 | `<profile>/.dsh-peer-chat-install.json` | `scripts/install-peer-chat.ps1` | 记原始备份，卸载时用它做真还原 |

`atomicWriteText`（`index.js:111`）先写 `<file>.<pid>.<ts>.tmp` 再 `renameSync`，避免断电留半截 JSON。

---

## 12. 函数地图（找代码用）

| 函数 | 行号 | 职责 |
|---|---|---|
| `resolvePeerTarget` | 149 | 名字 / 端口 / `self` → 统一的目标对象 |
| `discoverPeers` | 238 | 扫盘找本机其它实例（深度 + 时间预算，缓存 30s） |
| `tokenCandidates` | 293 | 每份日志的最后一条启动行 → 候选表 |
| `tokenFromCommand` | 341 | 跑 `tokenCommand`，取 stdout 里最后一个 `token=…` |
| `resolveToken` | 365 | 四级优先级合成一个 token |
| `openSession` | 425 | 登录 + 401 候选重试 + 写回缓存 |
| `decodeEvents` | 602 | 逐帧 zstd → 事件数组 |
| `findSessionLog` | 659 | 两种目录布局里找日志 |
| `waitForReply` | 684 | 轮询到「新 turn 且已收工」 |
| `askRemote` | 747 | 跨端：建/续会话 → 投递 → 等回复 |
| `askLocal` | 809 | 跨会话：同一套语义，走本机会话服务 |
| `runAsk` | 858 | 按目标分派 remote / local / tailOnly |
| `MODE_TEMPLATES` | 885 | 三种内置消息模板 |
| `applyStepRefs` | 902 | `{sN}` / `{sN.json.x}` 求值 |
| `resolveStepMessage` | 934 | 决定这一步到底发什么 |
| `judgeVerdict` | 955 | `NEXT` / `REWORK` 判定 |
| `runChain` | 967 | 链路主循环（含返工） |
| `steerRemote` / `steerLocal` | 1132 / 1164 | 插话，回执语义 |
| `CHAIN_TEMPLATES` | 1247 | 三个内置链路模板 |
| `installTemplate` | 1273 | 装模板（同名保护） |
| `validateChain` | 1296 | 链路归一化 + 校验 |
| `probeLoopbackPorts` | 1365 | 扫回环端口，认 401 签名 |
| `detectModes` | 1574 | 模式三级来源：服务 → profile 声明 → 未识别 |
| `fetchModeRows` | 1589 | 取某个目标的模式清单 |
| `registerPanelRoute` | 1601 | `/dsh-peer-chat-api` 全部逻辑 |
| `apply` | 1720 | 注册 8 个工具 + 面板路由 |

浏览器半侧（`client.js`）：`SidebarAction`(452) / `PeerDialog`(437) / `PeerPanel`(258) / `ChainEditor`(81) / `Select`(72)，以及四个 `slots.inject`（463 起）。

---

## 13. 失败语义（读返回值就够定位）

| 字段 | 什么时候有 | 怎么读 |
|---|---|---|
| `ok:false` + `timedOut:true` | 投递成功但没等到回复 | **不是**投递失败；用 `peer_tail` 看后续 |
| `ok:false` + `error` | 投递前就炸了（登录/建会话/未知模式） | `error` 是单行原因 |
| `stoppedAt` | 链路中断 | 从 1 开始数的步号 |
| `steps[].status` | `ok` / `failed` / `skipped` / `rework` | `skipped` = 该步 `onFail:'skip'` 生效 |
| `steps[].rework` | 该步是返工产物 | 数字 = 第几次返工 |
| `degraded[]` | 换了实现路径 | 数组里是原因原文，空数组 = 没降级 |
| `createVia` / `deliverVia` | 每次 `peer_ask` | 「实际走了哪条」，排查降级看这两个字段而不是猜 |

`runChain` 的 `ok` 判定：**所有步骤都不是 `failed`**。`skipped` 不算失败。

---

## 14. 想加东西时的四个入口

1. **加一个工具**：`apply()` 里再 `ctx.tools.register(...)`，`parameters` 用原始 JSON Schema（不要 `defineTool`），`output.schema` + `render` 决定终端怎么显示。
2. **加一个面板 action**：`registerPanelRoute` 的 POST 分支加一个 `else if (action === '…')`，收尾统一 `send(200, {...await snapshot(), changed: action})`，这样面板不用额外刷新。
3. **加一个链路模板**：`CHAIN_TEMPLATES` 加一项 `{ id, description, steps[] }`；`peer_chains(install-template)` 和面板的模板按钮会自动出现。
4. **加一种令牌来源**：`resolveToken` 里插一级，同时把 `kind` 取名（`env|log|command|cache` 之外要同步 `peer_token` 的 `output.schema` 枚举）。

改完的自检：`node --check index.js && node --check client.js`，再重启 dsh web 让新代码和客户端 bundle 生效。
