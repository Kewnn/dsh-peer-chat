# 安装

[English](./INSTALL.md) ｜ **中文**　·　返回 [README](./README.zh-CN.md)

一条装法：**把包放进 profile → 用 `file:` 依赖声明 → 加一行 patch → 重启。**

## 1. 放好文件

```
<profile>\local-plugins\dsh-peer-chat\
  index.js  client.js  package.json  cordis.patch.yml  icon.svg
  vendor\…                    内置会话层与预设/插话层
  README.md  INSTALL.md  LICENSE
```

```powershell
Copy-Item -Recurse .\dsh-peer-chat "$env:DSH_HOME\profiles\web\local-plugins\dsh-peer-chat"
```

包要留在 profile **里面**。从别的目录用 `link:` 挂载，宿主依赖会解析不到。

## 2. 声明依赖

`<profile>\package.json`：

```jsonc
{
  "dependencies": {
    "dsh-peer-chat": "file:./local-plugins/dsh-peer-chat"
  }
}
```

安装前先停服务，避免模块目录被占用：

```powershell
Get-NetTCPConnection -LocalPort <端口> -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
cd "$env:DSH_HOME\profiles\web"
pnpm install
& "<启动脚本>" --no-open
```

## 3. 挂载

在 `<profile>\cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-peer-chat
      name: dsh-peer-chat
```

## 4. 重启

插件模块在启动时加载，安装或更新后都需要重启。

## 5. 验证

```
① 启动日志里没有 "did not activate" / "import failed"
② peer_list({ scan: true }) 能列出真正在跑的对端
③ peer_ask({ peer: '<端口>', message: 'ok' }) 能拿到回复
```

## 配置（可选）

```yaml
- insert:
    - id: dsh-peer-chat
      name: dsh-peer-chat
      config:
        peersFile: <peers.json>          # 对端表
        localHome: <DSH_HOME>            # 本机 home，用于识别 token
        defaultWorkspace: <工作区>        # 新建会话的兜底工作目录
        discoverPorts: [3080, 3090, 3100, 3130]
```

对端表——键是端口：

```json
{
  "<端口>": { "url": "http://127.0.0.1:<端口>", "home": "<对端 DSH_HOME>" }
}
```

`home` 用来读对端日志找当前 token；不填就用缓存里的。

## 卸载

```powershell
cd "$env:DSH_HOME\profiles\web"
pnpm remove dsh-peer-chat
# 再从 cordis.patch.yml 删掉 "- id: dsh-peer-chat" 那段
Remove-Item -Recurse -Force .\node_modules\dsh-peer-chat
```

## 环境要求

- Node ≥ 22.15

| DSH 版本 | 支持情况 |
|---|---|
| `0.2.1-rc.2` | 支持 |
| `0.2.1-rc.3` | 支持 |
| `0.2.1-rc.4` | 支持（当前测试基线） |
