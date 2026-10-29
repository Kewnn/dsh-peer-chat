# Install

**English** ｜ [中文](./INSTALL.zh-CN.md)　·　Back to [README](./README.md)

One install path: **copy the package into the profile → declare it with a `file:` dependency → mount one patch
row → restart.**

## 1. Copy the package

```
<profile>\local-plugins\dsh-peer-chat\
  index.js  client.js  package.json  cordis.patch.yml  icon.svg
  vendor\…                    built-in session layer and preset/steer layer
  README.md  INSTALL.md  LICENSE
```

```powershell
Copy-Item -Recurse .\dsh-peer-chat "$env:DSH_HOME\profiles\web\local-plugins\dsh-peer-chat"
```

Keep the package **inside** the profile. Mounting it from another directory via `link:` leaves its host
dependencies unresolvable.

## 2. Declare the dependency

`<profile>\package.json`:

```jsonc
{
  "dependencies": {
    "dsh-peer-chat": "file:./local-plugins/dsh-peer-chat"
  }
}
```

Install with the server stopped, so the module directory is not locked:

```powershell
Get-NetTCPConnection -LocalPort <port> -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
cd "$env:DSH_HOME\profiles\web"
pnpm install
& "<start script>" --no-open
```

## 3. Mount it

Append to `<profile>\cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-peer-chat
      name: dsh-peer-chat
```

## 4. Restart

Plugin modules load at startup; a restart is required after installing or updating.

## 5. Verify

```
① the startup log contains no "did not activate" / "import failed"
② peer_list({ scan: true }) lists the peers that are actually running
③ peer_ask({ peer: '<port>', message: 'ok' }) returns a reply
```

## Configuration (optional)

```yaml
- insert:
    - id: dsh-peer-chat
      name: dsh-peer-chat
      config:
        peersFile: <peers.json>          # peer table
        localHome: <DSH_HOME>            # this instance's home, used for token discovery
        defaultWorkspace: <workspace>    # fallback working directory for new sessions
        discoverPorts: [3080, 3090, 3100, 3130]
```

Peer table — keys are ports:

```json
{
  "<port>": { "url": "http://127.0.0.1:<port>", "home": "<peer DSH_HOME>" }
}
```

`home` lets the plugin read that peer's logs to find the current token. Without it the cached token is used.

## Uninstall

```powershell
cd "$env:DSH_HOME\profiles\web"
pnpm remove dsh-peer-chat
# remove the "- id: dsh-peer-chat" insert block from cordis.patch.yml
Remove-Item -Recurse -Force .\node_modules\dsh-peer-chat
```

## Requirements

- Node ≥ 22.15

| DSH release | Status |
|---|---|
| `0.2.1-rc.2` | supported |
| `0.2.1-rc.3` | supported |
| `0.2.1-rc.4` | supported (current test target) |
