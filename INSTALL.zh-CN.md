# dsh-peer-chat 安装与回滚

给交付/运维用的说明书。目标只有一句：**装得像样、装得干净、装错了能原样退回去。**

本文对应的两个脚本在 `scripts\` 下，都是 Windows 上可直接跑的 `.ps1`（Windows PowerShell 5.1 / PowerShell 7+ 都验过）。

---

## 0. 交付物

```
dsh-peer-chat\
├─ scripts\
│  ├─ install-peer-chat.ps1        安装（幂等、带备份、失败回滚）
│  ├─ uninstall-peer-chat.ps1      卸载（幂等、字节级还原）
│  ├─ lib\peerchat-common.ps1      两个脚本共用的底层函数
│  └─ read-token.ps1               可选：给 tokenCommand 用的控制台取 token 助手
└─ INSTALL.md                      本文
```

插件本体（`index.js` / `client.js` / `package.json` / `README.md`）**只读**，安装过程一个字节都不改。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 系统 | Windows（脚本用 PowerShell；Linux 请手工照 §5 做） |
| Shell | Windows PowerShell 5.1 或 PowerShell 7+（本机实测 5.1.26100.9711） |
| Node | `>= 22.15.0`（插件 `engines` 声明） |
| profile | 已存在的目录 `<DSH_HOME>\profiles\<name>\`，含 `package.json` |
| 关键 | 该 `package.json` **必须有 `dsh.profile.bundles` 数组**（没有会被拒绝，见 §7-F4） |

本机常见的 profile 目录：

```
E:\dshsystem\dsh-home\profiles\web
```

---

## 2. 安装

### 2.1 默认参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `-Target` | 是（位置参数） | — | 要装的 profile 目录 |
| `-Source` | 否 | 本脚本的上一级（插件根） | 插件源码目录；只有源码不在默认位置时才给 |
| `-RemoveManualInsert` | 否 | 关 | 把 `cordis.patch.yml` 里手写的 peer-chat insert 注释掉（见 §8-坑2） |

### 2.2 一条命令

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install-peer-chat.ps1 `
     -Target E:\dshsystem\dsh-home\profiles\web
```

（机器上只装了 Windows PowerShell 时，把 `pwsh` 换成 `powershell` 即可。）

### 2.3 如果这个 profile 以前是"拷目录 + 手写 insert"装的

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install-peer-chat.ps1 `
     -Target E:\dshsystem\dsh-home\profiles\web -RemoveManualInsert
```

不加 `-RemoveManualInsert` 时脚本会**拒绝执行**并打印冲突行号——因为手写 insert 和 `dsh.profile.bundles` 同时存在会把插件挂载两次（§8-坑2）。

### 2.4 它到底改了什么

| # | 位置 | 动作 | 失败时 |
|---|---|---|---|
| 0 | `package.json` / `cordis.patch.yml` | 各复制一份 `<文件名>.bak-peerchat-<时间戳>` | — |
| 1 | `cordis.patch.yml` | **默认不动**；只有给了 `-RemoveManualInsert` 且确实存在手写 insert 时，才把那几行注释掉（保留原文，可肉眼还原） | 整体回滚 |
| 2 | `<profile>\node_modules\dsh-peer-chat` | 从 `-Source` 复制一份（已存在且内容一致则跳过；不一致则改名 `.bak-peerchat-<时间戳>` 后再复制） | 整体回滚 |
| 3 | `package.json` → `dependencies` | 写入 `"dsh-peer-chat": "file:E:/…/dsh-peer-chat"` | 整体回滚 |
| 4 | `package.json` → `dsh.profile.bundles` | 追加 `"dsh-peer-chat"`，**只加一次** | 整体回滚 |
| 5 | `<profile>\.dsh-peer-chat-install.json` | 安装记录（备份文件名、时间、源目录、待重启标记） | 整体回滚 |

真实输出（演练时的一段）：

```
[install] dsh-peer-chat installer -- 2026-10-29 04:46:41
[install] backup package.json    -> package.json.bak-peerchat-20261029-044641
[install] backup cordis.patch.yml -> cordis.patch.yml.bak-peerchat-20261029-044641
[install] copied plugin -> node_modules\dsh-peer-chat (11 files)
[install] package.json: add dependency, add bundle entry
[install] wrote package.json (UTF-8, no BOM)

[verify] package.json encoding       OK  (UTF-8, no BOM)
[verify] dependencies.dsh-peer-chat  OK  (file:E:/dshsystem/fmd/plugins/dsh-peer-chat)
[verify] dsh.profile.bundles         OK  (exactly 1 entry)
[verify] pre-existing rows kept      OK  (2 dependencies, 2 bundles)
[verify] node_modules\dsh-peer-chat  OK  (11 files)
[verify] cordis.patch.yml            OK  (no active manual insert)

[install] PASS
[install] RESTART REQUIRED: bundle layers and the client module are read at boot only.
```

二次执行是**真幂等**：认定已装好就一行不写（`package.json` 的 SHA256 不变，输出 `left untouched`）。

---

## 3. 验证

### 3.1 重启前先看组合结果（不启动实例）

`dsh` 的 dump 会把 `dsh.profile.bundles` 里每个 bundle 自己的 patch 展开成最终配置树，不启动服务：

```powershell
dsh --profile web --dump-default-config | Select-String 'dsh-peer-chat'
```

期望：出现 **一行** `- id: dsh-peer-chat`，且 dump 的注释标明它来自 `node_modules\dsh-peer-chat\cordis.patch.yml`。

- 出现两行 → 还有手写 insert 残留（§7-F3）
- 一行都没有 → bundles 没写进去，或 `node_modules` 里没有这个包（§7-F1）

> `--dump-default-config` 只展开 bundle 层，不含 profile 自己的 `cordis.patch.yml`；想看含用户层的完整树用 `--dump-config`。dump 不会运行应用参数，也不会启动服务。

### 3.2 重启实例

改的是 profile 的 `package.json` 和 `node_modules`，**不会被热重载**，必须重启拥有这个 profile 的实例（`dsh web` / 桌面端）。

### 3.3 界面

重启后侧栏/设置里应出现插件面板入口（`client.js` 注册的那个）。这是**客户端**是否加载成功的唯一判据。

### 3.4 工具

面板是客户端的事，工具是服务端的事，两个都验：

| 调用 | 期望 |
|---|---|
| `peer_list` | 返回对端清单（名字 / url / home / token 前 6 位 / 来源），**不是** "未知工具"或 404 |
| `peer_token` | 返回 token 前缀与来源（不发网络请求） |

`peer_list` 返回空列表 ≠ 安装失败：那是"还没配 peers、也没自动发现到对端"，见 §7-F6。

### 3.5 日志

启动日志里不应出现：

```
profile bundle "dsh-peer-chat" declares no dsh.bundle …
cannot resolve profile bundle "dsh-peer-chat" …
```

出现即 §7-F1 / F4。

---

## 4. 卸载

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-peer-chat.ps1 `
     -Target E:\dshsystem\dsh-home\profiles\web
```

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `-Target` | 是（位置参数） | — | 要清理的 profile 目录 |
| `-RestoreBackup` | 否 | 关 | 把安装时记录的备份**整文件**盖回去，而不是逐行摘除 |

默认行为（推荐）：逐行摘掉 `dependencies` / `bundles` 里的那一行，然后和"安装前备份"比对；**如果安装后你没改过别的，就把原始字节写回**——真还原，不是重新序列化。你后来装的别的插件不会被牵连。

`-RestoreBackup` 的代价是：安装之后你对 `package.json` / `cordis.patch.yml` 做的任何其它改动都会丢。所以脚本还原完 patch 仍会把手写 insert 注释掉（否则还原出一个"有 insert、没插件包"的必崩状态）。

同样幂等：没装过就输出 `nothing to do` 并 `exit 0`。

---

## 5. 手工回滚（不完全信任脚本时的兜底）

全部在 profile 目录里做，三条：

```powershell
# 1. 找回备份（时间戳选安装前那个）
Get-ChildItem 'E:\dshsystem\dsh-home\profiles\web' -Filter '*.bak-peerchat*' | Sort-Object LastWriteTime

# 2. 盖回去（示例：换成你实际看到的文件名）
Copy-Item '.\package.json.bak-peerchat-20261029-044641' '.\package.json' -Force
Copy-Item '.\cordis.patch.yml.bak-peerchat-20261029-044641' '.\cordis.patch.yml' -Force

# 3. 删副本、删安装记录
Remove-Item '.\node_modules\dsh-peer-chat' -Recurse -Force
Remove-Item '.\.dsh-peer-chat-install.json' -Force
```

然后重启实例。注意 **别用 `Set-Content -Encoding utf8` 改 `package.json`**（§8-坑1）。

---

## 6. 什么情况下会打断正在跑的实例

| 操作 | 是否热重载 | 说明 |
|---|---|---|
| 正常安装（不带 `-RemoveManualInsert`） | 否 | 只写 `package.json` / `node_modules`，要重启才生效 |
| 安装带 `-RemoveManualInsert`、卸载 | **会** | 会写 `cordis.patch.yml`；该文件被 dsh 监听，一写就热重载，**正在跑的会话会被打断** |

所以：要动 `cordis.patch.yml` 的时候，**先停实例**或挑空闲时做，别在正在干活的会话里跑。

---

## 7. 常见失败

| # | 现象 | 原因 | 处理 |
|---|---|---|---|
| F1 | 重启后工具 404 / 面板没有入口 | 包没落到 `node_modules`、或 `bundles` 没写进去、或启动时被 skip | `--dump-default-config` 看有没有那一行；看 `<profile>\node_modules\dsh-peer-chat\package.json` 是否存在；重跑安装脚本（幂等） |
| F2 | 启动直接崩，日志是 JSON 解析错误 | `package.json` 带 UTF-8 BOM（历史坑，§8-坑1） | 重跑安装脚本会自动改成无 BOM；急用就手工：`$t=[IO.File]::ReadAllText($p); [IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding($false)))` |
| F3 | 工具注册两遍 / 面板出现两份 | `cordis.patch.yml` 手写 insert 与 `bundles` 并存（§8-坑2） | `-RemoveManualInsert` 重跑，或自己删掉那几行 |
| F4 | 脚本拒绝：`no dsh.profile.bundles list` | 该 profile 的 `package.json` 没有 `dsh.profile.bundles` | 先补 profile 基础清单（如 `"dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base"]}}`），或改用 `dsh plugin --profile <name> add <包>` 建 profile |
| F5 | 桌面端：服务端工具正常，但面板/入口不出现 | 插件清单 `dsh.client.platform` 固定为 `"web"`（DSH 里该字段的注释就是 "the Web consumer selects `web`"），桌面消费端不选它 → 客户端模块不注入 | 这是**插件清单层面**的问题，安装脚本不改插件清单；要桌面端可用得由插件作者补声明 |
| F6 | `peer_list` 返回空 | 没配 peers、也没自动发现到对端 | 不是安装问题：配 `peers.json` / 给对端 token，或先起第二个实例 |

退出码：

| 码 | 含义 |
|---|---|
| 0 | 成功（卸载时"无事可做"也是 0） |
| 2 | 前置检查拒绝，**一个字节都没写**（目录不对、没有 `package.json`、没有 `bundles`、源目录不对） |
| 3 | 发现手写 insert 冲突，**一个字节都没写** |
| 4 | 写后自检失败，**已整体回滚** |
| 5 | 未预期的 IO 错误（回滚也没走完，按 §5 手工来） |

---

## 8. 两个历史坑，脚本为什么长这样

### 坑1：`Set-Content -Encoding utf8` 写出 BOM → 应用启动崩溃

Windows PowerShell 5.1 的 `-Encoding utf8` 是**带 BOM 的 UTF-8**。`package.json` 开头多出 `EF BB BF`，JSON 解析直接报错，实例起不来。

本脚本的处理：

- 写文件一律 `[IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`，**从不**用 `Set-Content` / `Out-File` / `>` 重定向；
- 写前写后都查 BOM（发现旧文件带 BOM 会顺手去掉并在输出里说一声）；
- 先写临时文件 → 校验 → 再 `File.Replace` 顶上去，避免"写到一半"的半截文件；
- 顺带一条：**这几个 `.ps1` 自身是纯 ASCII**。因为 Windows PowerShell 5.1 把无 BOM 的 `.ps1` 当 ANSI 解码，脚本里放中文会被解成乱码（编码类事故的另一种形态）。中文说明只写在本文里。

### 坑2：手写 insert 与 `bundles` 同时存在 → 插件加载两次

DSH 的组合规则是：`package.json` 的 `dsh.profile.bundles` 里每个包，都会展开它自己 `package.json` 里 `dsh.bundle.patch` 指向的 patch（本插件的 `cordis.patch.yml` 里就有一行 `- insert: - id: dsh-peer-chat`），最后再叠 profile 自己的 `cordis.patch.yml`。

所以：

- **正确姿势**：只往 `dsh.profile.bundles` 加一项，插件靠自带的 patch 挂上；
- **错误姿势**：bundle 项 + 手写 insert 各来一份 → 同一个 id 被 insert 两次 → 工具重复注册、面板两份、甚至启动报错。

本脚本因此**从不**往 `cordis.patch.yml` 写 insert；发现已有手写 insert 就拒绝（`exit 3`），给了 `-RemoveManualInsert` 才把那几行**注释掉**（不是删掉——留痕，可肉眼还原）。如果那个 insert 块里只有这一条，连 `- insert:` 头一起注释，并补一行 `[]`，保证这个文件仍是合法的空 entry 列表。

---

## 9. 演练记录（本次实测）

临时 profile：`E:\dshsystem\caches\temp\peer-probe\install-test`（最小 `package.json` + 空 patch），子脚本一律通过 `powershell.exe -NoProfile -File` 当独立进程跑，共 **56 条断言全过**：

| 阶段 | 断言 | 结果 |
|---|---|---|
| 1 首次安装 | 退出码 0；`package.json` 无 BOM；依赖值正确；bundle 项恰好 1 条；全文 `"dsh-peer-chat"` 恰好 2 处；原有 2 条依赖 / 2 条 bundle 未丢；副本 11 个文件齐全；patch 未被改动 | PASS |
| 1 差异 | 只追加：+1 依赖行、+1 数组元素、相邻行仅补一个逗号 | PASS |
| 2 再装一次 | 退出码 0；`package.json` SHA256 不变；bundle 仍 1 条 | PASS |
| 3 卸载 | 退出码 0；`package.json` / `cordis.patch.yml` **字节级**还原；副本与安装记录删除 | PASS |
| 4 再卸一次 | 退出码 0，`nothing to do` | PASS |
| 5 手写 insert 场景 | 首次安装 `exit 3` 且未写入；`-RemoveManualInsert` 后 patch 无活跃 insert、仍留注释行、补 `[]`；卸载后 `package.json` 字节级还原、patch 无活跃 insert | PASS |
| 6 坏输入 | 目录不存在 → `exit 2`；缺 `dsh.profile.bundles` → `exit 2` 且目录内无新增文件 | PASS |
| 边界（额外） | `dependencies:{}` + `bundles:[]` 能装能还原；旧副本内容不一致时先改名为 `.bak-peerchat-*` 再复制，卸载时把旧副本**原样放回** | PASS |

完整日志：`E:\dshsystem\caches\temp\peer-probe\rehearsal.log`，演练脚本：`E:\dshsystem\caches\temp\peer-probe\run-rehearsal.ps1`（可重跑）。

---

## 10. 边界

- 只动**一个** profile 目录里的那几处；不改插件本体，不改 `cordis.yml`，不动 `pnpm-lock.yaml`。
- 不在 `package.json` 里写死任何机器相关路径以外的配置：`peersFile` / `token` / `localHome` / `tokenCommand` 这些留给 profile 层自己覆盖。
- 不替你重启，不替你改插件清单（比如 F5 的 `dsh.client.platform`）。
- 不做 `pnpm install`：`file:` 依赖与直接拷贝的副本指向同一份源码，下次它自己做安装时会把副本重新接回目录，二者不冲突。
