# dsh-peer-chat

<p align="center"><b>English</b> ｜ <a href="README.zh-CN.md">中文</a></p>

> **Let one DSH instance talk to another.** No token copying, no extra process — peers are addressed by port.

## What it is

Each DSH process listens on its own port and knows nothing about its neighbours. This plugin connects them:
send a message to another instance, wait for its reply, or talk into a turn that is already running.

It is a single plugin with three layers built in — local session tools, preset/steering, and the cross-instance
`peer_*` tools — so one install covers the whole path.

## Features

- **Peers by port.** `peer: '<port>'` — stable across restarts, no alias bookkeeping.
- **Automatic token discovery.** The web token rotates on every restart; the plugin reads it from the peer's own
  logs and retries once if it turns out stale.
- **Ask or fire-and-forget.** `peer_ask` waits for the reply; `peer_send` returns on delivery; `peer_steer` drops
  the message at the next step boundary.
- **Chains.** `peer_chain` runs multiple hops and passes each reply forward.
- **Panel.** A sidebar entry to pick a peer, pick a mode, type a message and send — or build a chain visually.
- **Self-contained.** Session creation, preset mounting and steering ship with the plugin.

## Install

```powershell
# 1. copy the package under the profile
Copy-Item -Recurse .\dsh-peer-chat "$env:DSH_HOME\profiles\web\local-plugins\dsh-peer-chat"
# 2. wire it in (profile package.json)
#    "dsh-peer-chat": "file:./local-plugins/dsh-peer-chat"
cd "$env:DSH_HOME\profiles\web"; pnpm install
# 3. mount it (profile cordis.patch.yml)
#    - insert:
#        - id: dsh-peer-chat
#          name: dsh-peer-chat
# 4. restart DSH
```

Full steps, options and uninstall: [INSTALL.md](./INSTALL.md) ｜ [中文](./INSTALL.zh-CN.md)

## Usage

```js
// talk to whatever is listening on that port
peer_ask({ peer: '<port>', message: 'Summarize today's log in one line' })

// start a session with a specific mode on the peer
peer_ask({ peer: '<port>', preset: 'fmd-review', message: 'Review this diff' })

// fire and forget
peer_send({ peer: '<port>', sessionId: '<session>', message: 'FYI: build is green' })

// read recent replies
peer_tail({ peer: '<port>', sessionId: '<session>', n: 3 })
```

| Tool | Purpose | Waits for reply |
|---|---|---|
| `peer_token` | Resolve a peer token (prefix + source only) | — |
| `peer_list` | List peers, optionally with a live port scan | — |
| `peer_modes` | Presets available on a peer | — |
| `peer_chains` | Saved chains | — |
| `peer_ask` | Create/pick a session, deliver, wait | ✅ |
| `peer_send` | Deliver a message, move on | ❌ |
| `peer_steer` | Deliver at the next step boundary | ❌ |
| `peer_chain` | Multi-hop chain, `{prev}` carries the reply | per step |
| `peer_tail` | Read the last n assistant messages | — |

## Configuration

```yaml
- insert:
    - id: dsh-peer-chat
      name: dsh-peer-chat
      config:
        peersFile: <peers.json>          # optional peer table
        localHome: <DSH_HOME>            # this instance's home (token discovery)
        defaultWorkspace: <workspace>    # fallback cwd for new sessions
        discoverPorts: [3080, 3090, 3100, 3130]   # ports to probe when scanning
```

Peer table (`peers.json`) — keys are ports:

```json
{
  "<port>": { "url": "http://127.0.0.1:<port>", "home": "<peer DSH_HOME>" }
}
```

## Requirements

- Node ≥ 22.15 (uses `zlib` zstd)
- A recent DSH release (the peer line `0.2.1-rc`)

## License

[Apache-2.0](./LICENSE)
