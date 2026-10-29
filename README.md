# dsh-peer-chat

<p align="center"><b>English</b> ｜ <a href="README.zh-CN.md">中文</a></p>

> **Let one DSH instance talk to another.** No token copying, no extra process — peers are addressed by port.

## What it is

Each DSH process listens on its own port and knows nothing about its neighbours. This plugin connects them:
send a message to another instance, wait for its reply, or talk into a turn that is already running.

The plugin carries everything the path needs: session creation, preset mounting and steering come with it, so one
install is enough.

## Features

- **Peers by port.** `peer: '<port>'` — stable across restarts, no alias bookkeeping.
- **Automatic token discovery.** The web token rotates on every restart; the plugin reads it from the peer's own
  logs and retries once if it turns out stale.
- **Ask or fire-and-forget.** `peer_ask` waits for the reply; `peer_send` returns on delivery; `peer_steer` drops
  the message at the next step boundary.
- **Chains.** `peer_chain` runs multiple hops and passes each reply forward. Steps that target the same peer **steer into the session opened by the first step** instead of starting a new turn (override per step with `deliver: 'ask'`).
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

### When the peer asks a question with options

Interactive choice cards cannot be answered by text, so `peer_ask` detects when the peer stopped on one
(`ask_user_question` / a `show_view` with options) and reports it instead of silently timing out:

```
⏸ peer stopped on a choice (ask_user_question): Which base image should I use?
  A. slim
  B. full
Reply with a letter: peer_send({ peer: '<port>', sessionId: '<session>', message: 'A' })
```

The same information is on the result as `pendingQuestion: { tool, question, options[] }`, so a caller can decide
on its own.

If you control the peer's presets, prefer **plain-text choices** (`A. …  B. …`) over cards: they can be answered
by a normal `peer_send`, no card state is involved.

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

| DSH release | Status |
|---|---|
| `0.2.1-rc.2` | supported |
| `0.2.1-rc.3` | supported |
| `0.2.1-rc.4` | supported (current test target) |

Anything older than `0.2.1-rc.2` is untested: the plugin relies on the `0.2.1-rc` peer surface.

## License

[Apache-2.0](./LICENSE)
