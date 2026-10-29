# dsh-peer-chat 术语表（中英对照）

> 用途：看代码、看返回值、看报错时，**同一个东西别用三种叫法**。
> 每行给：中文用词 · 英文/代码用词 · 一句话定义 · 出现在哪里（字段 / 函数 / 参数）。
> 行号快照：`index.js` 2323 行（2026-10-29 04:50），按函数名搜更稳。

---

## A. 核心实体

| 中文 | 英文 / 代码 | 定义 | 落点 |
|---|---|---|---|
| 对端 | peer | **另一个** DSH 目标：另一个实例、另一个端口，或 `self` 这个特殊值 | `peer` 参数；`resolvePeerTarget`（`index.js:149`） |
| 本端 | self | 当前这个实例里的**另一个会话**，不联网 | `peer:"self"`；`peer_list` 里 `origin:'self'` |
| 实例 | instance | 一个跑着的 DSH 进程（一个端口 / 一个桌面端） | 自动发现单位；`discoverPeers`（`index.js:238`） |
| 跨端 | remote | 走 HTTP 到**另一个实例**的路线 | `route:"remote"`；`askRemote`（`index.js:747`） |
| 跨会话 | local | 同一个进程内、**另一个 session** 的路线 | `route:"local"`；`askLocal`（`index.js:809`） |
| 链路 | chain | 一条**有序的步骤序列**，可存成 JSON 反复跑 | `chains.json`；`runChain`（`index.js:967`） |
| 步骤 | step | 链路里的一跳；最小是 `{ peer }` | `steps[]`；`runStep`（`runChain` 内） |
| 模式 | preset（= agent preset） | 新建会话时用哪套人设/工具/提示词 | `mode` / `preset` 参数；`agentPresets` 服务 |
| 返工 | rework | 审阅步判「不行」，回头重跑**上一步**再复审一次 | `steps[].rework`；`judgeVerdict`（`index.js:955`） |
| 串味 | context bleed | 非正式说法：上一步回复被**整段追加**进下一步消息，导致模型把旧任务当新任务 | `resolveStepMessage`（`index.js:934`）的「没写 `{prev}`」分支 |
| 广播 | broadcast | 同一句话发给多个对端。**当前没有专用工具**：用多步链路（每步一个 peer）或多次 `peer_ask` | `peer_chain` 的 `steps[]` |

## B. 连接与令牌

| 中文 | 英文 / 代码 | 定义 | 落点 |
|---|---|---|---|
| 令牌 | token | 对端 `dsh web` 启动时打印的登录凭证 | `peers.json.token`；`resolveToken`（`index.js:365`） |
| 令牌前缀 | tokenPrefix | 令牌**前 6 位**，用来核对是哪一枚，永不回全文 | `peer_token` 返回值 |
| 令牌来源 | sourceKind | `env` / `log` / `command` / `cache` 四选一 | `peer_token` 返回值枚举 |
| 启动行 | boot line | 日志里那行 `dsh web: http://…?token=…`，令牌的权威出处 | `tokenCandidates`（`index.js:293`） |
| 自动发现 | discovery | 扫本机目录 + 启动日志，认「带 `profiles/` 或名为 `dsh-home`」的目录 | `discoverPeers`；缓存 30s |
| 端口扫描 | port scan | 按 401 签名探回环端口段，默认 `3000-3200` | `probeLoopbackPorts`（`index.js:1365`）；`peer_list({ scan:true })` |
| 401 签名 | 401 signature | DSH 的特征：根路径**不带令牌**就回 401。扫描靠它认实例 | `probeLoopbackPorts` |
| 登录会话 | cookie | 令牌换来的 `name=value; …` 串，后续 RPC 都带它 | `login()`（`index.js:378`） |
| RPC 信封 | RPC envelope | `POST /api/<method>` + `{type:'client-request', rpcId, method, payload:{args}}` | `rpc()`（`index.js:389`） |
| 取令牌命令 | tokenCommand | 用户自备的「怎么把令牌捞出来」的命令模板，可用 `{peer}{url}{home}{port}` | `tokenFromCommand`（`index.js:341`） |
| 只读对端 | tailOnly | 只有 `home`、没有 `url` 的对端（典型是桌面端），**只准 `peer_tail`** | `normalizePeerEntry`；`index.js:861` 的报错 |

## C. 会话与日志

| 中文 | 英文 / 代码 | 定义 | 落点 |
|---|---|---|---|
| 会话 | session | 一段连续对话的容器，有全局唯一 id | `sessionId` |
| 会话日志 | session log | 会话落盘的唯一真相：`session.v4.jsonl.zstd` | `findSessionLog`（`index.js:659`） |
| 帧 | frame | zstd 压缩块。日志是**多帧首尾相接**，不是单个压缩流 | `ZSTD_MAGIC`；`decodeEvents`（`index.js:602`） |
| 轮次 | turn | 一问一答的编号，日志里每条事件都带 `data.turn` | `turn`；`lastTurnOf` |
| 收工 | turn end | 该轮结束事件 `turn/end`；等到它才算「回复完整」 | `waitForReply`（`index.js:684`） |
| 摘要 | summarize | 把事件流压成 `{ lastTurn, assistants, endedTurns }` | `summarize` |
| 投递 | deliver | 把消息塞进目标会话（不等回复） | `deliverVia` |
| 插话 | steer | 投到**当前 turn 的下一步边界**，不新开 turn；目标空闲会唤醒它 | `mode:'steer'`；`peer_steer` |
| 排队 | queue | 正常投递模式，等价「当一条新消息处理」 | `mode:'queue'`；`askRemote` |
| 回执 | receipt | 插话只回「投递成功 + 用了哪种模式」，**不含回复内容** | `accepted` / `mode` / `targetStatus` |

## D. 返回值字段（排错时最常查）

| 字段 | 含义 | 怎么读 |
|---|---|---|
| `ok` | 成功与否 | 链路里 = 没有任何一步 `failed`（`skipped` 不算失败） |
| `timedOut` | 等到超时也没拿到正文 | `ok:false + timedOut:true` = **话送到了**，别当投递失败 |
| `waitedMs` | 实际等了多久 | 贴近 `timeoutMs` 说明在等回复；很小说明提前失败 |
| `created` | 是否本次新建会话 | `createVia` 会写清走哪条路 |
| `createVia` | 建会话实际走的实现 | 排查降级看这个，不要猜 |
| `deliverVia` | 投递实际走的实现 | 同上 |
| `degraded[]` | 降级原因原文 | 空数组 = 一路顺畅 |
| `stoppedAt` | 链路在第几步中断（从 1 数） | 与 `steps[].index` 对齐 |
| `status` | 步骤状态：`ok` / `failed` / `skipped` / `rework` | `skipped` = 该步 `onFail:'skip'` 生效 |
| `bytes` | 该步回复的 UTF-8 字节数 | 为 0 且 `failed` → 没产出 |
| `reworks` | 整条链一共返工了几次 | 顶层汇总字段 |

## E. 宿主概念（装插件才会碰到）

| 中文 | 英文 / 代码 | 定义 | 落点 |
|---|---|---|---|
| 配置档 | profile | 一套 DSH 配置（`profiles/web`、桌面端各一个），决定加载什么 | `dsh.profile.bundles` |
| 组合包 | bundle | profile 清单里的一个条目；插件自带的 `dsh.bundle.patch` 由它应用 | `package.json` 的 `dsh.bundle.patch` |
| 槽位 | slot | 宿主预留的 UI 座位（`sidebar.footer.action` 等） | `client.js` 的 `slots.inject` |
| 注入 | inject | 向槽位登记组件；`exports.inject = ['slots']` 声明依赖 | `apply(ctx)`（`index.js:1720`） |
| 面板路由 | panel route | 浏览器半侧唯一的数据通道 `/dsh-peer-chat-api` | `registerPanelRoute`（`index.js:1601`） |

## F. 消息变量（写链路时只用这五个）

| 写法 | 含义 | 边界行为 |
|---|---|---|
| `{input}` | 链路入口参数（`peer_chain({ input })`） | 无 `input` → 替换成空串 |
| `{prev}` | 上一步的回复 | **写了才原位替换**；没写就把「（上一步回复）」整段追加到末尾 |
| `{sN}` | 第 N 步的回复（N 从 1 数） | 第 N 步还没结果 → **报错**，不塞空串 |
| `{sN.json.foo}` | 从第 N 步回复的 JSON 里取字段，支持 `[0]` 下标 | 不是 JSON / 没这个字段 → **报错** |
| `NEXT` / `REWORK` | 审阅步的**最后一行**指令 | `NEXT|PASS|继续|下一个|通过` → 前进；`REWORK|返工|打回` → 返工 |

---

## G. README 用词统一建议（**只是建议，本次没有改 README**）

同一份 README 里对「工具数量」有三种说法，对「怎么装」有两种说法，新用户会直接踩坑。
下面按「README 位置 → 现状 → 建议 → 依据」列，逐条可核。
**复核时间 2026-10-29 04:55**：其中两项在并行编辑里已经改好了，标 ✅ 免得重复改；其余仍待处理（本次没有动 README）。

| README 位置 | 现状 | 建议 | 依据 |
|---|---|---|---|
| 第 3 行（front-matter `description`） | ✅ 已是「提供 **8 个** peer_* 工具」 | 无需再改；但 `package.json` 第 4 行的同一句只列了 7 个（漏 `peer_chains`），建议两处都列全 | 源码 8 处 `name: 'peer_`：`peer_token / peer_list / peer_modes / peer_ask / peer_chain / peer_steer / peer_chains / peer_tail` |
| 第 19 行 | 「注册**八个** `peer_*` 工具」（数目正确） | 建议改成阿拉伯数字「**8 个**」，与第 3、117 行统一写法 | 同上 |
| 第 117 行 | ✅ 已是「应出现 **8 个** `peer_*` 工具」 | 无需再改 | 同上 |
| 第 58 行（`peer_chains` 行） | 可选参数只写 `action(list/add/remove)`、`name`、`chain` | 补成 6 个 action：`list / add / remove / install-template / export / import`，并补 `template` / `overwrite` / `json` | `index.js:2121` 的 `enum`；`peer_chains` 的 `execute` 分支 |
| 第 41 行 | 已写「装载内置模板、`export`/`import`」 | 保留——它与第 58 行**自相矛盾**，改完 58 行就一致了 | 同上 |
| 第 56 行（`peer_list` 行） | 可选参数只写 `discover` | 补 **`scan`**（默认 false，额外扫端口段） | `peer_list` 的 `parameters`（`index.js:1990-1991`）；第 39 行已经用到 `scan:true`，两处要对齐 |
| 第 101 行 | 「**patch 一行**」（手写 `- insert:`） | 改成「跑 `scripts/install-peer-chat.ps1`」；手写 insert 是**错的** | 安装脚本检测到手写 insert 会拒绝执行并以 `exit 3` 退出，因为「手写 insert + bundle 条目 = 挂载两次」 |
| 第 13 行（目录树） | 只有 `index.js` / `package.json` / `README.md` 三项 | 补 `client.js`（浏览器半侧）、`cordis.patch.yml`、`scripts/`、`preview.html` | 插件根目录实际内容 |
| 第 131–132 行 | 两个条目都编号 **A7**（「A7 插话」与「A7 模式自检」） | 后者改成 A8，后续顺延 | 编号重复，验收时无法引用 |
| 第 146–152 行（反例） | 编号 **1、2、6** | 改成 1、2、3（或补齐 3–5） | 中间三条缺失 |
| 全文 | 「对端 / 本端 / 跨端 / 跨会话 / 插话」混用中英（`peer` / `remote` / `local` / `steer`） | 统一成：**首次出现写「中文（English/代码名）」**，之后只用中文 | 本表 A/B/C 三组即该映射的出处 |

另有两处源码注释同样是过期计数，建议顺手同步（不属于 README）：

| 文件 | 位置 | 现状 | 建议 |
|---|---|---|---|
| `index.js` | 第 4 行 | 「三个工具（统一 peer_ 前缀…）」 | 8 个 |
| `cordis.patch.yml` | 第 7 行 | 「装载后注册四个工具」 | 8 个 |

---

## H. 命名约定（写新代码时照这个来）

1. **工具名**：`peer_` 前缀 + 动词/名词，全部小写，用下划线（`peer_ask` 不写 `peerAsk`）。
2. **工具参数**：camelCase，且**同一个概念全插件同名**——对端永远叫 `peer`，会话永远叫 `sessionId`，等时长永远叫 `timeoutMs`。
3. **返回字段**：camelCase；`ok` 永远是最外层第一个布尔；「实际走了哪条路」永远叫 `createVia` / `deliverVia`，不要新造 `usedCreate` 之类的同义词。
4. **错误文案**：**单行**（`errorLine` 会砍到 160 字符），结构是「对象 + 现象 + 该去哪儿改」：
   `登录 <url> 失败（HTTP 401）：… 请手工更新 <文件> 里 <名字> 的 token`。
5. **中英对照**：新术语先加进本表再来写代码，别让 README、报错、字段名各说各话。

---

## I. 速查卡（30 秒版）

- `peer` = 对端，`self` = 本端跨会话，`remote` = 真跨实例，`local` = 同进程跨会话。
- `mode` = 建会话用的 preset；`chain` = 步骤序列；`step` = 一跳。
- 回复从**日志**读：`session.v4.jsonl.zstd`，**多帧** zstd，等到 `turn/end` 才算完。
- 四个变量：`{input}` 入口、`{prev}` 上一步、`{sN}` 第 N 步、`NEXT/REWORK` 返工信。
- 令牌四级：`config.token` → `PEER_TOKEN` → 日志启动行 → `tokenCommand` → `peers.json` 缓存。
- 只看不写 → `peer_tail`；要回复 → `peer_ask`；只要回执 → `peer_steer`；管账本 → `peer_chains`。
