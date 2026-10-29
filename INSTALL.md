# Install (dsh-peer-chat)

Short version: **put the package under the profile's `local-plugins/`, wire it in with a `file:` dependency,
add one patch row, restart.**

Chinese: [INSTALL.zh-CN.md](./INSTALL.zh-CN.md)　｜　Overview: [README.md](./README.md)　｜　License: Apache-2.0

## 0. Prerequisites

- DSH `0.2.1-rc.4` (the package declares peers for the `0.2.1-rc` line)
- Node ≥ 22.15 (the plugin uses `zlib` zstd)
- Paths below are examples — adjust to your machine:
  - checkout: `E:\dshsystem\deepseek-harness`
  - profile: `E:\dshsystem\dsh-home\profiles\web`

## 1. Place the files

```
<profile>\local-plugins\dsh-peer-chat\
  index.js  client.js  package.json  cordis.patch.yml  icon.svg
  vendor\session-tools\…      ← local session tools (vendored)
  vendor\session-plus.js      ← session_spawn / session_steer (vendored)
  README.md  INSTALL.md  LICENSE
```

```powershell
Copy-Item -Recurse .\dsh-peer-chat "$env:DSH_HOME\profiles\web\local-plugins\dsh-peer-chat"
```

> ⚠️ Do **not** `link:` the package from outside the profile: its `@deepseek-ai/*` peers will not resolve and
> the host only reports `did not activate / import failed`.

## 2. Declare the dependency (`file:`)

`<profile>\package.json`:

```jsonc
{
  "dependencies": {
    "dsh-peer-chat": "file:./local-plugins/dsh-peer-chat"
  }
}
```

Install — **stop the server first**, otherwise `node_modules` is locked and pnpm fails halfway:

```powershell
# 1) stop the instance on 3130
Get-NetTCPConnection -LocalPort 3130 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# 2) install
cd "$env:DSH_HOME\profiles\web"
pnpm install --registry https://registry.npmmirror.com
# 3) start again
& "E:\dshsystem\DSHSY.cmd" --no-open
```

## 3. Mount it

Append to `<profile>\cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-peer-chat
      name: dsh-peer-chat
```

> If you also run a standalone `dsh-session-plus`, add `config: { mergeSessionPlus: false }` to this row,
> otherwise `session_spawn` is registered twice.

## 4. Restart

Plugin modules load at startup — editing files (or tool schemas) requires a restart.

## 5. Smoke test (three steps)

```
① startup log has no "did not activate" / "import failed"
② in any session ask: do you have peer_list / peer_ask / peer_send / session_spawn?  → all should exist
③ peer_list({ scan: true }) lists live instances; peer_ask({ peer: <port>, message: 'ok' }) returns a reply
```

## 6. Configuration (optional)

```yaml
- insert:
    - id: dsh-peer-chat
      name: dsh-peer-chat
      config:
        peersFile: E:\dshlaw\tools\dsh-peer\peers.json   # peer table
        localHome: E:\dshsystem\dsh-home                 # this instance's DSH_HOME (token discovery)
        defaultWorkspace: E:\dshsystem\Documents\deepseek-harness\default-workspace
        mergeSessionTools: true                          # mount vendor/session-tools
        mergeSessionPlus: true                           # mount vendor/session-plus
        discoverPorts: [3080, 3090, 3100, 3130]          # optional: scan this list instead of 3000-3200
```

`peers.json` — key by **port** (recommended):

```json
{
  "3090": { "url": "http://127.0.0.1:3090", "home": "E:\\dshlonger\\dsh-home" },
  "3130": { "url": "http://127.0.0.1:3130", "home": "E:\\dshsystem\\dsh-home" }
}
```

## 7. Where the token comes from

Priority: `config.token` / `PEER_TOKEN` → last `dsh web: …/?token=…` line in `<peer.home>/*.log` →
cached token in `peers.json`. On 401 the log is rescanned and `peers.json` is updated.

Make a peer log its startup output with `start-logged.cmd` (`tee` into `<home>\web-console.log`).

## 8. Uninstall

Three steps — skipping any of them leaves the plugin half-loaded:

```powershell
# ① drop the dependency
cd "$env:DSH_HOME\profiles\web"
pnpm remove dsh-peer-chat
# ② remove the "- id: dsh-peer-chat" insert block from cordis.patch.yml
# ③ delete the installed copy
Remove-Item -Recurse -Force .\node_modules\dsh-peer-chat
```

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| `did not activate / import failed` | linked from outside the profile, or dependencies not installed |
| `session_spawn` registered twice | a standalone `dsh-session-plus` is installed → set `mergeSessionPlus: false` |
| HTTP 401 from a peer | stale token — let the peer log its startup, or pass `PEER_TOKEN` |
| Whole web UI breaks, `client bundle not found` | `package.json` `files` list is missing `client.js` |
| Sessions land in `sessions\_no-cwd`, UI says `session/not-found` | the session was created without a cwd (this plugin always passes one) |
