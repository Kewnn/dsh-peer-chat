# dsh-peer-chat · 中文说明

[English](./README.md) ｜ **中文**　·　安装：[中文](./INSTALL.zh-CN.md) ｜ [English](./INSTALL.md)　·　许可证：Apache-2.0

让一个 DSH 实例和另一个实例端到端对话：插件自己识别对端 web token，登录取 cookie，建或选一个会话，投递消息，
再从对端会话日志里取回回复。本机目标（`self`）直接作用于当前会话，不需要额外进程，也不需要第二套会话实现。

对端一律用**端口**标识：端口稳定、不用维护别名、重启也不变。

```js
peer_ask({ peer: '<port>', message: '只回 OK' })       // 监听该端口的任意实例
peer_ask({ peer: '127.0.0.1:<port>', message: '…' })   // 等价写法
peer_ask({ peer: 'self', message: '…' })               // 当前会话，本机路线
```

---

## 1. 解决什么问题

每个 DSH 进程各占一个端口，彼此默认不知道对方存在。本插件把这段补上：给另一个实例发消息、读它的回复、
或往它正在跑的回合里插话——**不用手动复制 token**，因为 token 每次重启都会变，插件会去对端日志里认。

## 2. 对端表

可选，但推荐：它告诉插件每个对端的 `DSH_HOME` 在哪，token 才能从对端日志里读出来。键就是端口。

```json
{
  "<port>": { "url": "http://127.0.0.1:<port>", "home": "<对端 DSH_HOME>" },
  "<port>": { "url": "http://127.0.0.1:<port>", "home": "<对端 DSH_HOME>" }
}
```

不写 `home` 就退回缓存的 token。面板里的「扫描对端」会探测本机端口段（默认 `3000-3200`），
把活着的实例显示成 `port-<端口>`，**自身的端口会被过滤掉**。

## 3. 工具

| 工具 | 作用 | 等回复 |
|---|---|---|
| `peer_token({ peer })` | 识别对端 token（只报前 6 位 + 来源） | — |
| `peer_list({ scan? })` | 列出对端，可选附带实时扫描 | — |
| `peer_modes({ peer })` | 读对端可用的模式（preset） | — |
| `peer_chains()` | 列出已保存的链路 | — |
| `peer_ask({ peer, message, preset?, sessionId?, cwd? })` | 建/选会话并投递，**等回复** | ✅ |
| `peer_send({ peer, sessionId, message, mode? })` | 发一条消息，**不等回复** | ❌ |
| `peer_steer({ peer, sessionId, message })` | 投递到当前回合的下一步边界 | ❌ |
| `peer_chain({ name \| steps, input?, mode? })` | 多跳链路，`{prev}` 传上一步回复 | 逐步 |
| `peer_tail({ peer, sessionId, n? })` | 读对端会话最近 n 条助手消息 | — |

## 4. 自带的会话工具

插件是自足的——装这一个，两层能力都有。

| 层 | 工具 |
|---|---|
| 本地会话 | `session_create` · `session_send` · `session_wait` · `list_sessions` |
| 预设与插话 | `session_spawn`（按预设建会话）· `session_steer`（插入运行中的回合） |
| 跨实例 | `peer_token` · `peer_list` · `peer_modes` · `peer_chains` · `peer_ask` · `peer_send` · `peer_steer` · `peer_chain` · `peer_tail` |

如果 profile 里已有别的插件提供 `session_spawn`，给本插件那行加 `config: { mergeSessionPlus: false }`，
避免重复注册同一个工具。

## 5. token 从哪来

优先级：

1. `config.token` 或环境变量 `PEER_TOKEN`
2. `<对端 home>/*.log` 里最后一处 `dsh web: http://127.0.0.1:<端口>/?token=…`
3. 对端表里缓存的 token

遇到 HTTP 401 会重扫日志；token 变了就重试一次并回写对端表。
想让对端把启动输出落盘，用仓库里的 `start-logged.cmd`（把输出 tee 到 `<DSH_HOME>\web-console.log`）。

## 6. 面板

侧栏 → 左下角入口：

- **对端**：`self`、对端表里的条目、以及「扫描对端」得到的 `port-<端口>`
- **模式**：所选对端可用的 preset
- **新建链路**：每行 = 对端（端口）+ 模式 + **消息内容**（留空＝按模式自动生成）
- **直接发送**：不走链路，把输入框内容直接发给第一个目标（填了模式会先建会话）；成功后 1 秒自动关面板

链路存在 `<DSH_HOME>\peer-chat\chains.json`。

## 7. 已知边界

- **会话的 `header.cwd` 不可变**，只能在创建时给定。本插件建会话一定会传 cwd（拿不到就用默认工作区），
  否则会话会落到 `sessions\_no-cwd`，前端点开会报 `session/not-found`。
- 对端 RPC `session/create` 的参数是**扁平对象**（`{ cwd?, agentPreset? }`），多包一层 `request` 会被忽略。
- 链路某一步解析出空消息时会兜一句默认消息，不会因为“运行输入为空”让整条链失败。

## 8. 开发

要求 Node ≥ 22.15（用到 `zlib` 的 zstd），以及较新的 DSH 版本。

```
pnpm install
node test/run-all.mjs
```

安装位置：`profiles/<profile>/local-plugins/dsh-peer-chat/`，用 `file:` 依赖装进来。
**不要**放 profile 外用 `link:` 挂——宿主 peer 解析不到，只会报 `did not activate`。

## 9. 许可证

Apache-2.0，见 [LICENSE](./LICENSE)。
