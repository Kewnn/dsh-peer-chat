# dsh-peer-chat · 中文说明

跨 DSH 实例对话插件：**自动识别对端 token** → 登录取 cookie → 建/选会话 → 投递消息 → 轮询会话日志取回回复。
本机目标（`self`）直接复用已有的会话能力，不另起一套。

许可证：**Apache-2.0**（见 [LICENSE](./LICENSE)）　｜　安装：[INSTALL.zh-CN.md](./INSTALL.zh-CN.md)

---

## 1. 它解决什么

DSH 一个进程一个端口，彼此默认不知道对方存在。本插件让两个（或多个）实例能互相发消息、取回复、插话，
并且**不需要手工复制 token**——token 每次重启都会变，插件会自己去日志里认。

## 2. 对端怎么指：用端口

对端标识优先用**端口**，名字只是可选的别名。

```js
peer_ask({ peer: 3090, message: '只回 OK' })        // 指向本机 3090 端口的实例
peer_ask({ peer: '127.0.0.1:3090', message: '…' })  // 等价写法
peer_ask({ peer: 'self', message: '…' })            // 本端当前会话
```

`peers.json` 里也可以直接用端口做键（推荐，避免维护别名）：

```json
{
  "3090": { "url": "http://127.0.0.1:3090", "home": "E:\\dshlonger\\dsh-home" },
  "3130": { "url": "http://127.0.0.1:3130", "home": "E:\\dshsystem\\dsh-home" }
}
```

`home` 是用来读对端日志找 token 的；给它就能全自动，没有就退回 `cache`。

> 面板里的「扫描对端」会按端口段探测活着的实例（默认 `3000-3200`），
> 扫到的直接以 `port-<端口>` 出现，**不会显示自己这个端口**。

## 3. 九个工具

| 工具 | 作用 | 等回复 |
|---|---|---|
| `peer_token({ peer })` | 识别对端 token（只报前 6 位 + 来源） | — |
| `peer_list({ scan? })` | 列出对端（含扫描结果） | — |
| `peer_modes({ peer })` | 读对端可用模式（preset） | — |
| `peer_chains()` | 列出保存的链路 | — |
| `peer_ask({ peer, message, preset?, sessionId?, cwd? })` | 建/选会话并投递，**等回复** | ✅ |
| `peer_send({ peer, sessionId, message, mode? })` | 发一条消息，**不等回复** | ❌ |
| `peer_steer({ peer, sessionId, message })` | 插到当前 turn 的下一步边界 | ❌ |
| `peer_chain({ name \| steps, input?, mode? })` | 多跳链路，`{prev}` 传上一步 | 逐步 |
| `peer_tail({ peer, sessionId, n? })` | 读对端会话最近 n 条正文 | — |

## 4. 与 session-tools / session-plus 的关系

本插件不重复造轮子，仓库里已经 vendor 了两套：

```
vendor/session-tools/…    本地会话工具（session_create / send / wait / list_sessions）
vendor/session-plus.js    按预设建会话（session_spawn）+ 运行中插话（session_steer）
```

装一个插件 = 同时得到上面这些 + `peer_*`。若你又单独装了 `dsh-session-plus`，
给本插件那行加 `config: { mergeSessionPlus: false }`，否则 `session_spawn` 会重复注册。

## 5. token 从哪来

优先级：

1. `config.token` / 环境变量 `PEER_TOKEN`
2. `<peer.home>` 下 `*.log` 里最后一处 `dsh web: http://127.0.0.1:<端口>/?token=XXX`
3. `peers.json` 里缓存的 token

401 时会重扫日志，token 变了就重试一次并回写 `peers.json`。
想让对端把启动输出去写盘：用它仓库里的 `start-logged.cmd`（`tee` 到 `<home>\web-console.log`）。

## 6. 面板

浏览器左侧栏左下角「🐟 跨端对话」→ 弹层：

- **对端**：显示 `self` + `peers.json` 里的 + 「扫描对端」扫到的 `port-<端口>`
- **模式**：该对端可用的 preset 列表
- **新建链路**：每行 = 对端（端口）+ 模式 + **消息内容输入框**（留空＝按模式自动生成）
- **直接发送**：不走链路，把输入框内容直接发给第一个目标（填了模式就新建会话再发）；成功 1 秒后自动关面板

链路存在 `<DSH_HOME>\peer-chat\chains.json`。

## 7. 几个已知边界

- **会话的 `header.cwd` 不可变**，只能在创建时给定；所以本插件建会话时一定会传 cwd（拿不到就用默认工作区），
  否则会话会落到 `sessions\_no-cwd`，前端点开会 `session/not-found`。
- 对端 RPC `session/create` 的参数是**扁平对象** `{ cwd?, agentId?, agentPreset? }`，多包一层 `request` 会被忽略。
- 链路某步消息解析为空时会兜一句默认消息，不会因为“运行输入为空”而整条失败。

## 8. 开发

要求：Node ≥ 22.15（用到 `zlib` 的 zstd）、DSH `0.2.1-rc.2` 以上。

```
pnpm install          # 只有一个 peer：@deepseek-ai/cordis
node test/run-all.mjs # 自带测试
```

插件位于 `profiles/<profile>/local-plugins/dsh-peer-chat/`，用 `file:` 依赖装进 node_modules；
**不要**放 profile 外用 `link:` 挂（`@deepseek-ai/*` 解析不到，宿主只会报 `did not activate`）。
