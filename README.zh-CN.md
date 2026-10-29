# dsh-peer-chat

<p align="center"><a href="README.md">English</a> ｜ <b>中文</b></p>

> **让一个 DSH 实例直接和另一个实例对话。** 不用复制 token，不用另起进程——对端用端口标识。

## 这是什么

每个 DSH 进程各占一个端口，彼此默认不知道对方存在。这个插件把它们连起来：给另一个实例发消息、等它的回复、
或者往它正在跑的回合里插话。

整条链路需要的能力都在插件里：建会话、挂预设、插话都随插件带，装一次就够。

## 功能

- **对端用端口**：`peer: '<端口>'`，重启不变，不用维护别名。
- **token 自动识别**：web token 每次重启都变，插件自己去对端日志里认；失效会自动重试一次。
- **三种投递方式**：`peer_ask` 等回复、`peer_send` 只投递、`peer_steer` 投到当前回合的下一步边界。
- **链路**：`peer_chain` 多跳执行，上一步的回复传给下一步。
- **面板**：侧栏入口，选对端、选模式、写消息就能发；也能可视化拼链路。
- **自足**：建会话、挂预设、插话能力都随插件带。

## 安装

```powershell
# 1. 复制到 profile
Copy-Item -Recurse .\dsh-peer-chat "$env:DSH_HOME\profiles\web\local-plugins\dsh-peer-chat"
# 2. 声名依赖（profile 的 package.json）
#    "dsh-peer-chat": "file:./local-plugins/dsh-peer-chat"
cd "$env:DSH_HOME\profiles\web"; pnpm install
# 3. 挂载（profile 的 cordis.patch.yml）
#    - insert:
#        - id: dsh-peer-chat
#          name: dsh-peer-chat
# 4. 重启 DSH
```

完整步骤、配置项与卸载：[INSTALL.zh-CN.md](./INSTALL.zh-CN.md) ｜ [English](./INSTALL.md)

## 用法

```js
// 发给那个端口上的实例
peer_ask({ peer: '<端口>', message: '用一句话总结今天的日志' })

// 指定模式，在对端新建会话
peer_ask({ peer: '<端口>', preset: 'fmd-review', message: '审一下这个改动' })

// 只投递，不等回复
peer_send({ peer: '<端口>', sessionId: '<会话>', message: '构建已通过' })

// 读最近几条回复
peer_tail({ peer: '<端口>', sessionId: '<会话>', n: 3 })
```

| 工具 | 作用 | 等回复 |
|---|---|---|
| `peer_token` | 识别对端 token（只报前缀与来源） | — |
| `peer_list` | 列出对端，可附带端口扫描 | — |
| `peer_modes` | 对端可用的模式 | — |
| `peer_chains` | 已保存的链路 | — |
| `peer_ask` | 建/选会话并投递，等回复 | ✅ |
| `peer_send` | 投递消息后立即返回 | ❌ |
| `peer_steer` | 投递到当前回合的下一步边界 | ❌ |
| `peer_chain` | 多跳链路，`{prev}` 传上一步 | 逐步 |
| `peer_tail` | 读最近 n 条助手消息 | — |

### 对方弹出选择题怎么办

选择题卡片没法用文本回答，所以 `peer_ask` 会**识别出“对端停在选择题上”**（`ask_user_question`，
或带 options 的 `show_view`）并直接告诉你，而不是干等到超时：

```
⏸ 对方停在选择题上（ask_user_question）：基础镜像用哪个？
  A. slim
  B. full
回一个字母即可：peer_send({ peer: '<端口>', sessionId: '<会话>', message: 'A' })
```

同一个信息也在返回值的 `pendingQuestion: { tool, question, options[] }` 里，调用方可以自行决定。

如果你能控制对端的模式，建议让它输出**纯文字选择题**（`A. … B. …`）而不是卡片——那样普通
`peer_send` 就能回答，不涉及任何卡片状态。

## 配置

```yaml
- insert:
    - id: dsh-peer-chat
      name: dsh-peer-chat
      config:
        peersFile: <peers.json>          # 可选：对端表
        localHome: <DSH_HOME>            # 本机 home（用于读日志识别 token）
        defaultWorkspace: <工作区>        # 新建会话的兜底 cwd
        discoverPorts: [3080, 3090, 3100, 3130]   # 扫描时探测的端口
```

对端表（`peers.json`），键是端口：

```json
{
  "<端口>": { "url": "http://127.0.0.1:<端口>", "home": "<对端 DSH_HOME>" }
}
```

## 环境要求

- Node ≥ 22.15（用到 `zlib` 的 zstd）

| DSH 版本 | 支持情况 |
|---|---|
| `0.2.1-rc.2` | 支持 |
| `0.2.1-rc.3` | 支持 |
| `0.2.1-rc.4` | 支持（当前测试基线） |

低于 `0.2.1-rc.2` 的版本未验证：插件依赖 `0.2.1-rc` 的 peer 面。

## 许可证

[Apache-2.0](./LICENSE)
