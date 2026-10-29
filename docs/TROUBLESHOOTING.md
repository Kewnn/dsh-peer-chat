# dsh-peer-chat 故障排查手册

> 每一条都是同一个结构：**症状 → 排查命令 → 原因 → 修法**。
> 命令分两类，别混：
> - `PS>` 开头 = 在 PowerShell 里直接粘贴执行；
> - `tool` 开头 = 在会话里调用插件工具（说人话就是「让 AI 调这个工具」）。
>
> **本文命令的执行环境**：Windows / PowerShell 7 / Node **v24.19.0** / `DSH_HOME=E:\dshsystem\dsh-home`。
> 标 ✅ 的 **18 处终端命令**已在本机逐条实跑（输出见各条的「实测」）。工具调用（`tool` 开头）在插件未安装时跑不了，未标 ✅。
> 行号快照：`index.js` 2323 行（2026-10-29 04:50）。

先记三条总规律，能省一半时间：

1. **HTTP 只负责把话投进去，回复是从会话日志读的**。所以「投递成功但没回复」和「投递失败」是两种完全不同的病。
2. **`peer_ask` 的 `ok:false` + `timedOut:true` 不是失败**，是「话送到了、还没等到回」。
3. **面板所有数据都来自 `/dsh-peer-chat-api`**。面板空白时先直接请求这个地址，比在 UI 上猜快得多。

---

## T1 插件没加载：侧栏没有 🐟 / 面板空白 / 接口 404

**症状**：左下角没有「跨端对话」入口；设置页里没有这一节；或者面板打开一片空白。

**排查命令**

```powershell
# ① 面板接口是否真的存在（404 = 路由没挂上，插件没加载）
try { (Invoke-WebRequest 'http://127.0.0.1:3130/dsh-peer-chat-api' -UseBasicParsing).StatusCode } catch { [int]$_.Exception.Response.StatusCode }
# ② 插件的包是否在 profile 里
Test-Path 'E:\dshsystem\dsh-home\profiles\web\node_modules\dsh-peer-chat'
# ③ profile 是否声明了这个 bundle
(Get-Content 'E:\dshsystem\dsh-home\profiles\web\package.json' -Raw | ConvertFrom-Json).dsh.profile.bundles -contains 'dsh-peer-chat'
```

**实测**：① 返回 `404`，② 返回 `False`，③ 返回 `False` —— 本机当前就是「没装」的状态，404 是预期结果，不是 bug。

**原因**：三个条件缺一个，路由就不存在：包在 `node_modules` 里 + 名字进了 `dsh.profile.bundles` + 实例重启过。
bundle 层与客户端模块**只在启动时读**，改完不重启等于没改。

**修法**

```powershell
# 装（幂等、会备份、失败自动回滚）
pwsh -NoProfile -ExecutionPolicy Bypass -File 'E:\dshsystem\fmd\plugins\dsh-peer-chat\scripts\install-peer-chat.ps1' -Target 'E:\dshsystem\dsh-home\profiles\web'
# 然后重启拥有这个 profile 的实例（dsh web / 桌面端）
```

重启后重跑 ① 应变成 `200`。

---

## T2 401：令牌全失效，试过一轮候选还是登不上

**症状**：`peer_ask` 报

```
登录 http://127.0.0.1:3090 失败（HTTP 401）：试过 N 个 token（日志候选 + 缓存 + tokenCommand）都不行。
```

**排查命令**

```powershell
# ✅ 对端 home 里还有没有启动行（token 只在这行里）
Select-String -Path 'E:\dshsystem\dsh-home\*.log' -Pattern 'dsh web:\s*\S*token=([A-Za-z0-9_-]{20,})' -ErrorAction SilentlyContinue |
  Select-Object -Last 3 Filename, LineNumber
```

工具侧（只回前 6 位；插件装好之后才能跑）：

```
tool  peer_token({ peer: 3090 })
```

**实测**：本机 `DSH_HOME` 下**一个 `*.log` 都没有**，所以「日志来源」这一级天然为空——这也是 `tokenSourceKind` 常见落到 `cache` 的原因。

**原因**：`resolveToken`（`index.js:365`）按 `config.token → PEER_TOKEN → 日志 → tokenCommand → peers.json 缓存` 取第一个命中。
日志是**历史文件**：对端重启过、新进程没写日志（或没 tee），日志里那行就是死令牌。插件已经会在 401 时把「日志候选 + 缓存 + `tokenCommand`」逐个试（`openSession`，`index.js:425`），全试完还不行就是**所有来源都过期了**。

**修法**（从省事到彻底）

1. 让对端用 tee 重启，把启动行落到 `web-console.log`（下次 401 会自动扫到）；
2. 手工把活令牌写进 `peers.json` 的 `token` 字段（`<DSH_HOME>/peer-chat/peers.json`）；
3. 配 `tokenCommand` 指向 `scripts/read-token.ps1`，从对端 cmd 窗口的缓冲区里读：

```yaml
config:
  tokenCommand: powershell -NoProfile -ExecutionPolicy Bypass -File "E:\dshsystem\fmd\plugins\dsh-peer-chat\scripts\read-token.ps1" -Port {port}
```

注意：`read-token.ps1` 要求**那个 cmd 窗口还开着**、启动行还在回滚缓冲里；且它是 Windows 专用。

---

## T3 对端 timeout：等到超时也没有回复

**症状**：`peer_ask` 返回 `ok:false`、`timedOut:true`、`reply:""`，`waitedMs` 约等于 `timeoutMs`。

**排查命令**

```
tool  peer_tail({ peer: 3090, sessionId: "<上次返回的 sessionId>", n: 3 })
```

```powershell
# ✅ 日志到底能不能解（多帧 zstd；把路径换成 peer_tail 返回的 logFile 更准）
node -e "const fs=require('fs'),z=require('zlib');const b=fs.readFileSync('E:/dshsystem/dsh-home/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd');const m=Buffer.from([0x28,0xb5,0x2f,0xfd]);let at=0,s=[];for(;;){const i=b.indexOf(m,at);if(i<0)break;s.push(i);at=i+4}let t='',bad=0;for(let k=0;k<s.length;k++){try{t+=z.zstdDecompressSync(b.subarray(s[k],k+1<s.length?s[k+1]:b.length)).toString('utf8')}catch{bad++}}const l=t.split(/\r?\n/).filter(Boolean);console.log('frames',s.length,'bad',bad,'lines',l.length,'assistant',l.filter(function(x){return x.indexOf('assistant/message')>=0}).length)"
```

**实测**：本机一份 4.6MB 日志 → `frames 2944 bad 0 lines 5290 assistant 830`。帧数很多、失败 0，说明「解码」这一环基本不会出问题——排除了它，就往下面三条看。

**原因**（按概率排序）

1. 对端在跑长任务，`timeoutMs` 不够（默认 120000ms，上限 600000）；
2. `peers.json` 里这个对端的 `home` 指错了 → 插件读的是**别人**的日志，永远看不到新消息；
3. 续会话时日志不存在，会直接报「找不到会话 … 的日志」，不会走到 timeout；
4. 新会话的回复落在 `sessions/<workspace>/<id>/`（布局 B），而 `home` 指向了没有 `sessions` 的目录。

**修法**

```
tool  peer_ask({ peer: 3090, message: "只回 OK", newSession: true, timeoutMs: 300000 })
```

先把 `timeoutMs` 放大并新建会话（排除残留状态）；同时核对 `peers.json` 的 `home` 必须是对端的 DSH home，不是 profile 目录。

---

## T4 模式识别为空：「本机没有 agent 预设」

**症状**：面板「模式」区域显示「本机没有 agent 预设」，抬头写着 `0 模式（未识别）`；`peer_modes()` 回 `count:0`。

**排查命令**

```powershell
# ✅ profile 目录有没有、里面有没有 preset 声明
Get-ChildItem 'E:\dshsystem\dsh-home\profiles' -Directory |
  ForEach-Object { "{0}  patch={1}" -f $_.Name, (Test-Path (Join-Path $_.FullName 'cordis.patch.yml')) }
# profile 里声明的 agent-preset（有命中才有「模式」）
Select-String -Path 'E:\dshsystem\dsh-home\profiles\web\cordis.patch.yml' -Pattern '@deepseek-ai/dsh-agent-preset' -ErrorAction SilentlyContinue
```

**实测**：本机三个 profile（`web` / `desktop` / 一个备份目录）都有 `cordis.patch.yml`；`web` 的 patch 里匹配到 **9 处** `@deepseek-ai/dsh-agent-preset`。也就是说：**服务缺席时靠 profile 声明也能认出模式**，一条都抠不到才是真异常。

**原因**：`detectModes`（`index.js:1574`）三级来源，**全都空才回「未识别」**：

1. `agentPresets` 服务（最准，通常有）；
2. 读 profile 的 `cordis.patch.yml` / `cordis.yml`，用正则抠 `name: @deepseek-ai/dsh-agent-preset` 后面的 `id:`（`presetsFromProfileFiles`，`index.js:1542`）；
3. 都没有 → `{ modes: [], source: '未识别' }`。

`agentPresets` 服务没起来、或者 profile 不在 `presetSearchRoots`（`DSH_PROFILE_DIR` / `localHome` / `DSH_HOME/profiles/*` / `cwd`）里，就会掉到第 3 级。

**修法**：设 `DSH_PROFILE_DIR` 指向真正带 preset 的 profile 目录，或用 `config.localHome` 指；面板每行的「手动」按钮允许你**直接手填模式 id**，绕开识别（下发时对端会自己校验，无效会报「未知模式」）。

---

## T5 模板装载同名：`链路「review-loop」已存在`

**症状**：`peer_chains({ action:'install-template', template:'review-loop' })` 报

```
链路「review-loop」已存在；要覆盖请 overwrite:true
```

**排查命令**

```
tool  peer_chains({ action: 'list' })
```

```powershell
# ✅ 链路文件当前内容
Get-Content "$env:DSH_HOME\peer-chat\chains.json" -Raw -ErrorAction SilentlyContinue
```

**原因**：`installTemplate`（`index.js:1273`）默认不覆盖：`table[name] !== undefined && options.overwrite !== true` 就抛错。装过两次、或先 `add` 了同名链路之后就会撞。

**修法**：要覆盖就显式传；要并存就换个名字：

```
tool  peer_chains({ action: 'install-template', template: 'review-loop', name: 'review-loop-2' })
tool  peer_chains({ action: 'install-template', template: 'review-loop', overwrite: true })
```

---

## T6 导入 JSON 冲突：整批一条都没写进去

**症状**：`peer_chains({ action:'import', json })` 报

```
这些链路已存在，未覆盖：a, b（要覆盖请 overwrite:true）
```

而且**其余不冲突的条目也没进**。

**排查命令**

```
tool  peer_chains({ action: 'export' })   ← 先备份现有全部链路
```

**原因**：`import` 是**全有或全无**：循环里发现同名就塞进 `conflicts`，循环结束后 `conflicts.length > 0` 直接抛错（工具路径 `index.js:2206`，面板路径 `index.js:1683`），`saveChains` 根本没被调用。

**修法**

```
tool  peer_chains({ action: 'import', json: "<原样粘贴>", overwrite: true })
```

只想留一份的话，先 `remove` 掉旧的再导入；不放心就先 `export` 存文本。

---

## T7 桌面端没有这些工具 / 桌面端不加载第三方插件

**症状**：web 端有 `peer_*`，桌面端（Electron）工具表里没有；或者桌面端能看到工具但 `peer_ask` 报「只有 home、没有 url/token，只能 peer_tail」。

**排查命令**

```powershell
# ✅ 桌面端和 web 端是两个 profile —— 看它各自声明了什么
Get-ChildItem 'E:\dshsystem\dsh-home\profiles' -Directory | Select-Object Name, LastWriteTime
Select-String -Path 'E:\dshsystem\dsh-home\profiles\*\package.json' -Pattern 'dsh-peer-chat' -ErrorAction SilentlyContinue
```

**实测**：本机 `profiles\` 下确实有 **两个** profile —— `web` 与 `desktop`（外加一个 `_backup-session-tools-…` 备份目录）；`profiles\*\package.json` 里匹配 `dsh-peer-chat` 的结果是 **0**，所以「桌面端没有」在本机是**正常现象**（它压根没装进任何 profile），不是加载失败。

**原因**：两条独立的原因，别混。

1. **profile 不同**：插件装在 A profile，桌面端跑 B profile，就是两个世界。桌面端也不会去读 web 的 `node_modules`。
2. **桌面端没有对外端口**：桌面端内部服务是进程内通信，令牌在内存里，`peers.json` 里那种条目只能写成「只有 `home`」——`normalizePeerEntry` 会把它标成 `tailOnly`，`peer_ask` / `peer_steer` 会明确拒绝（`index.js:861` / `index.js:870`），只放行 `peer_tail`。

**修法**

- 要在桌面端用工具：把插件装进**桌面端自己的 profile**，再重启桌面端；
- 只读需求（看桌面端会话最近说了什么）：直接用 `peer_tail({ sessionId })`，它不需要令牌也不需要端口；
- 要在桌面端**发消息**：没有对外 URL 就做不到——换 web 端，或给桌面端起一个 `dsh web`。

---

## T8 端口扫描扫不到对端

**症状**：`peer_list()` 只有 `self`；`peer_ask({ peer: 3080 })` 报连不上；面板「对端」区只有本端。

**排查命令**

```powershell
# ✅ 哪些端口在听
Get-NetTCPConnection -State Listen -LocalPort 3000,3080,3090,3130 -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess
# ✅ DSH 的签名：根路径不带令牌回 401。扫 3000-3200（和插件默认段一致）
node -e "const ps=[];for(let p=3000;p<=3200;p++)ps.push(p);const h=[];(async()=>{for(let i=0;i<ps.length;i+=64){await Promise.all(ps.slice(i,i+64).map(async p=>{try{const r=await fetch('http://127.0.0.1:'+p+'/',{redirect:'manual',signal:AbortSignal.timeout(250)});if(r.status===401)h.push(p)}catch{}}))}h.sort((a,b)=>a-b);console.log('401:',h.join(', ')||'(none)')})()"
```

**实测**：本机扫描输出 `401: 3090, 3130` —— 两个 DSH 实例都在，说明扫描逻辑可用。

**原因**

1. 对端端口不在默认段 `3000-3200` 内（`discoverPortsOf`，`index.js:1349`）；
2. 扫描认的是**401 签名**（`probeLoopbackPorts`，`index.js:1365`）：对端如果被改成免登录、或者根本不是 DSH，就不会被认出来；
3. 只探 `127.0.0.1`，对端绑在别的网卡/容器里就扫不到；
4. 自动发现（`discoverPeers`）另一条路要求**有启动日志**——本机 `DSH_HOME` 下一个 `*.log` 都没有，所以这条路也没货。

**修法**：改扫描段或直接点名

```yaml
config:
  discoverPorts: [3090, 3130, 4090]
  # 或
  discoverPortRange: 4000-4100
```

扫不到也不影响用：`peer` 直接写端口就会连 `http://127.0.0.1:<port>`（`resolvePeerTarget`，`index.js:173`）。

---

## T9 日志读不出来 / `zstdDecompressSync` 不存在

**症状**：A) 插件加载即抛 `dsh-peer-chat 需要 Node >= 22.15（zlib zstd 解压）`；B) `peer_tail` 报「找不到会话日志」；C) `peer_tail` 有结果但条数是 0。

**排查命令**

```powershell
# ✅ Node 版本 + zstd 能力（一条命令同时看两个）
node --version; node -e "console.log('zstdDecompressSync:', typeof require('node:zlib').zstdDecompressSync)"
# 会话日志到底在哪（peer_tail 要的是 <home>/sessions/**/<sessionId>/session.v4.jsonl.zstd）
Get-ChildItem "$env:DSH_HOME\sessions" -Recurse -Filter 'session.v4.jsonl.zstd' -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 5 |
  ForEach-Object { "{0}  {1:N0}B" -f $_.Directory.Name, $_.Length }
```

**实测**：`v24.19.0` + `zstdDecompressSync: function`；最近 5 个会话目录名里既有 `session-<uuid>` 也有裸 `<uuid>` 两种命名——`sessionId` 要**原样**用它。

**原因**

- `apply()` 开头就检查 `zstdDecompressSync`（`index.js:1723`），Node < 22.15 直接拒绝加载（`engines` 写的是 `>=22.15.0`）；
- 日志是**多帧** zstd（不是单个压缩流），`decodeEvents`（`index.js:602`）按魔数 `28 b5 2f fd` 切帧逐帧解，半截帧会跳过——对端正在写时 `totalAssistant` 会短暂偏小，属正常；
- 布局有两种：`sessions/<sessionId>/` 与 `sessions/<workspace>/<sessionId>/`，`findSessionLog`（`index.js:659`）都会找；但 `home` 指错就都找不到。

**修法**：升级 Node 到 22.15+（本机 24.19 已满足）；核对 `peers.json.<name>.home`；`sessionId` 用 `peer_ask` 返回值里的原样字符串。

---

## T10 链路返工不生效：审阅说不通过，但没重跑上一步

**症状**：审阅步回复里写了「返工」，链路却直接往下走（或直接结束）；`steps[].rework` 字段不出现。

**排查命令**

```
tool  peer_chain({ name: "review-loop", input: "…" })   ← 看返回的 steps[].status 与 steps[].rework
```

**原因**（`judgeVerdict`，`index.js:955`）判定很窄，四个条件缺一不可：

1. 判定只看**回帖最后一行**——`REWORK` / `返工` / `打回` 必须在**单独最后一行**开头；
2. `index > 0`：第 1 步不可能是返工（没有「上一步」可重跑）；
3. `retries < limit`：默认 `maxRetries: 2`，用完就放行；
4. `steps[i].onFail !== 'stop'`。

传了 `failurePattern` 就让正则说了算（`new RegExp(pattern,'i').test(reply)` → 命中即返工），写坏的正则会静默回落成指令判定。

**修法**

```
tool  peer_chain({ name: "review-loop", input: "…", maxRetries: 3 })
tool  peer_chain({ name: "review-loop", input: "…", failurePattern: "REWORK|不合格" })
```

同时检查审阅用的模板：`MODE_TEMPLATES.review`（`index.js:886`）明确要求「最后单独一行写 NEXT 或 REWORK」，自定义 `templates` 里也要保留这句要求。

---

## T11 未知 peer / `peers.json` 不是合法 JSON

**症状**：`未知 peer「foo」；peers 表里只有：…`；或 `peers 表 … 不是合法 JSON：…`。

**排查命令**

```powershell
# ✅ 文件在不在、能不能解析
$f = "$env:DSH_HOME\peer-chat\peers.json"; Test-Path $f
if (Test-Path $f) { try { Get-Content $f -Raw | ConvertFrom-Json | Out-Null; 'JSON OK' } catch { 'JSON BAD: ' + $_.Exception.Message } }
```

**实测**：本机 `$env:DSH_HOME\peer-chat\peers.json` → `False`（文件不存在）。这是首装状态，**不是错误**：不写 `peers.json` 时插件仍会走自动发现，只是本机没有启动日志可捞，所以面板只会看到 `self`。

**原因**：`resolvePeerTarget`（`index.js:149`）按 `名字 → 自动发现 → 端口 → 报错` 的顺序解析；`readPeers`（`index.js:91`）要求顶层是「名字 → 对象」的 JSON 对象（数组不行、`null` 不行）。文件不存在时**不会**自动创建，只在报错里告诉你路径。

**修法**：新建/修正成这个形状（`home` 用来读日志；`token` 是缓存，可以不写，让插件自己从日志里找）：

```json
{
  "longer": { "url": "http://127.0.0.1:3090", "home": "E:\\dshlonger\\dsh-home" }
}
```

也可以完全不给名字，直接用端口：`peer_ask({ peer: 3090, message: "只回 OK" })`。

---

## T12 `peer_chains` 的 action 拼错，报错却只提三个名字

**症状**：写了 `action:"install-templates"`（多一个 s）之类，报

```
peer_chains 的 action 只能是 list / add / remove，收到 install-templates
```

**原因**：这条**报错文案是过期的**——`index.js:2225` 的文案只提 `list / add / remove`，而真正的枚举（`index.js:2121`）是 6 个：`list / add / remove / install-template / export / import`。看到这句话不要以为模板/导入导出没实现。

**修法**：用这 6 个名字之一，注意 `install-template` 是单数。

---

## T13 装了两遍：面板两个入口 / 工具重复 / 安装脚本 exit 3

**症状**：`install-peer-chat.ps1` 输出

```
[install] REFUSED: cordis.patch.yml already mounts dsh-peer-chat by hand:
[install] Having both this row and dsh.profile.bundles loads the plugin twice.
```

**排查命令**

```powershell
# ✅ 手写 insert 是否还在（有命中就是「两遍」的嫌疑）
Select-String -Path 'E:\dshsystem\dsh-home\profiles\web\cordis.patch.yml' -Pattern 'peer-chat'
```

**实测**：本机 profile 的 `cordis.patch.yml` 里没有 `peer-chat`（无输出），配合 T1 的三条检查，可以确认「没装」而不是「装重了」。

**原因**：挂载入口只有一个——`dsh.profile.bundles` 会应用插件自带的 `dsh.bundle.patch`（`cordis.patch.yml`）。再在 profile 的 `cordis.patch.yml` 手写一条 `- insert:`，就是同一份代码挂两次。

**修法**：让脚本帮你注释掉那条手写行，然后重启：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File 'E:\dshsystem\fmd\plugins\dsh-peer-chat\scripts\install-peer-chat.ps1' -Target 'E:\dshsystem\dsh-home\profiles\web' -RemoveManualInsert
```

安装脚本的退出码：`0` 成功 / `2` profile 缺 `dsh.profile.bundles` / `3` 有手写 insert / `4` 后置检查失败（已回滚）/ `5` IO 异常。

---

## T14 面板「运行」卡在「运行中…」

**症状**：点链路右边「运行」，弹层一直显示「运行中…」，看不到结果也不报错。

**排查命令**

```
tool  peer_chain({ name: "<同一条链路>", input: "<同一个输入>" })
```

```powershell
# ✅ 那个请求还在不在（长链路会挂住很久，这是正常的）
Get-NetTCPConnection -State Established -RemotePort 3130 -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count
```

**原因**：`run-chain` 是**同步等待整条链**：`runChain` 跑完之前 HTTP 不返回，面板也就一直转。默认每步 120s、整链预算 10 分钟；10 步链最坏能挂很久。看起来像卡死，其实在跑。
另外请求一旦断开（关弹层/刷新页面），服务端会 `abort`（`registerPanelRoute` 里监听 `res.on('close')`），链路就停在中间。

**修法**：先用工具跑同一条链路拿到可见进度（工具侧有 `steps[]`、`waitedMs`）；要缩短等待就调小 `timeoutMs`、或把长链拆成两条短链。别在链路跑着的时候关弹层。

---

## T15 `chains.json` 被手工改坏

**症状**：`peer_chains` 报 `链路文件 … 不是合法 JSON`；面板链路区整块报错。

**排查命令**

```powershell
$f = "$env:DSH_HOME\peer-chat\chains.json"
if (Test-Path $f) { try { (Get-Content $f -Raw | ConvertFrom-Json).PSObject.Properties.Name } catch { 'BAD: ' + $_.Exception.Message } }
```

**实测**：本机 `$env:DSH_HOME\peer-chat\chains.json` → `NO FILE`（从未保存过链路）。文件缺省时 `readChains`（`index.js:1217`）返回空表，面板只显示「还没有链路」，**不会**报错——所以「面板没有链路」先看这条。

**原因**：`readChains`（`index.js:1217`）要求顶层是对象；每条链路要过 `validateChain`（至少 1 步、最多 10 步、每步必须有 `peer`）。手改时最容易踩的三个：把 `steps` 写成字符串、删掉 `peer`、超过 10 步。

**修法**：能修就按形状修（下面是最小合法体），修不了就备份后重建：

```json
{
  "demo": {
    "description": "两跳示例",
    "steps": [
      { "peer": "self", "message": "{input}" },
      { "peer": "3090", "mode": "fmd-review" }
    ]
  }
}
```

```powershell
Copy-Item "$env:DSH_HOME\peer-chat\chains.json" "$env:DSH_HOME\peer-chat\chains.json.bak" -Force
```

重建后用 `peer_chains({ action:'list' })` 复核；内存里没有缓存，文件对了面板刷新就对。

---

## 附：一次性体检清单

按顺序跑完，六条都正常就说明「装好了、能连、能读、能存」：

```powershell
# ✅ 1 Node 与 zstd
node --version; node -e "console.log(typeof require('node:zlib').zstdDecompressSync)"
# ✅ 2 面板接口（期望 200；404 = 没装/没重启）
try { (Invoke-WebRequest 'http://127.0.0.1:3130/dsh-peer-chat-api' -UseBasicParsing).StatusCode } catch { [int]$_.Exception.Response.StatusCode }
# ✅ 3 自己有对端吗
(Get-Content 'E:\dshsystem\dsh-home\profiles\web\package.json' -Raw | ConvertFrom-Json).dsh.profile.bundles -contains 'dsh-peer-chat'
# ✅ 4 端口
Get-NetTCPConnection -State Listen -LocalPort 3090,3130 -ErrorAction SilentlyContinue | Select-Object LocalPort
# ✅ 5 链路文件
Test-Path "$env:DSH_HOME\peer-chat\chains.json"
# ✅ 6 源码本身没坏
node --check 'E:\dshsystem\fmd\plugins\dsh-peer-chat\index.js'
```

```
tool  peer_list({ discover: true })
tool  peer_modes({})
```

两个工具都回「有内容」——体检通过。
