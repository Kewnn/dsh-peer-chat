# dsh-peer-chat

**English** ｜ [中文](./README.zh-CN.md)　·　Install: [English](./INSTALL.md) ｜ [中文](./INSTALL.zh-CN.md)　·　License: Apache-2.0

Let one DSH instance talk to another, end to end: the plugin resolves the peer's web token by itself, signs in,
creates or picks a session, delivers the message, then reads the reply from the peer's session log. Locally it
operates on the current session (`self`) — no extra process and no second session stack.

Peers are addressed by **port**. A port is stable, needs no alias bookkeeping, and survives restarts:

```js
peer_ask({ peer: '<port>', message: 'reply OK only' })      // any instance listening on that port
peer_ask({ peer: '127.0.0.1:<port>', message: '…' })        // equivalent
peer_ask({ peer: 'self', message: '…' })                    // current session, local route
```

---

## 1. What it solves

Every DSH process listens on its own port and knows nothing about its neighbours. This plugin closes that gap:
message another instance, read its reply, or steer its running turn — **without copying tokens by hand**, because
the web token rotates on every restart and is discovered from the peer's logs instead.

## 2. Peer table

Optional, but recommended: it tells the plugin where each peer's `DSH_HOME` lives so token discovery can read
that peer's logs. Keys are ports.

```json
{
  "<port>": { "url": "http://127.0.0.1:<port>", "home": "<peer DSH_HOME>" },
  "<port>": { "url": "http://127.0.0.1:<port>", "home": "<peer DSH_HOME>" }
}
```

Without a `home`, the plugin falls back to a cached token. The panel's **Scan peers** action probes the loopback
port range (default `3000-3200`) and lists whatever is alive as `port-<port>`; the instance's own port is filtered
out.

## 3. Tools

| Tool | Purpose | Waits for reply |
|---|---|---|
| `peer_token({ peer })` | Resolve the peer token (first 6 chars + source only) | — |
| `peer_list({ scan? })` | List peers, optionally with a live scan | — |
| `peer_modes({ peer })` | Read the peer's available presets | — |
| `peer_chains()` | List saved chains | — |
| `peer_ask({ peer, message, preset?, sessionId?, cwd? })` | Create or pick a session, deliver, **wait** | ✅ |
| `peer_send({ peer, sessionId, message, mode? })` | Send a message, **do not wait** | ❌ |
| `peer_steer({ peer, sessionId, message })` | Deliver at the next step boundary | ❌ |
| `peer_chain({ name \| steps, input?, mode? })` | Multi-hop chain; `{prev}` carries the previous reply | per step |
| `peer_tail({ peer, sessionId, n? })` | Read the last n assistant messages of a peer session | — |

## 4. Session tooling included

The plugin is self-contained — installing it provides both layers.

| Layer | Tools |
|---|---|
| Local sessions | `session_create` · `session_send` · `session_wait` · `list_sessions` |
| Presets and steering | `session_spawn` (create by preset) · `session_steer` (talk into a running turn) |
| Cross-instance | `peer_token` · `peer_list` · `peer_modes` · `peer_chains` · `peer_ask` · `peer_send` · `peer_steer` · `peer_chain` · `peer_tail` |

If another plugin in the profile already provides `session_spawn`, set `config: { mergeSessionPlus: false }`
on this plugin's row to avoid a duplicate registration.

## 5. Token discovery

Priority:

1. `config.token` or the `PEER_TOKEN` environment variable
2. the last `dsh web: http://127.0.0.1:<port>/?token=…` line in `<peer home>/*.log`
3. the token cached in the peer table

On HTTP 401 the logs are rescanned; if the token changed the request is retried once and the peer table is
updated. To make a peer announce its token on disk, start it with the bundled `start-logged.cmd` (it tees the
startup output into `<DSH_HOME>\web-console.log`).

## 6. Panel

Sidebar → bottom-left entry:

- **Peers** — `self`, entries from the peer table, and `port-<port>` results from *Scan peers*
- **Modes** — presets available on the selected peer
- **New chain** — one row per step: peer (port) + mode + **message content** (empty = generated from the mode)
- **Send now** — bypass the chain: send the typed text to the first target; with a mode it creates the session
  first. On success the panel closes itself after one second.

Chains are stored in `<DSH_HOME>\peer-chat\chains.json`.

## 7. Known edges

- **A session's `header.cwd` is immutable** — it can only be set when the session is created. This plugin always
  passes a cwd (falling back to a default workspace); otherwise the session lands in `sessions\_no-cwd` and the
  web UI answers `session/not-found`.
- The peer RPC `session/create` takes a **flat payload** (`{ cwd?, agentPreset? }`); wrapping it in `request` is
  silently ignored.
- A chain step that resolves to an empty message falls back to a default one, so an empty run input does not fail
  the whole chain.

## 8. Development

Requires Node ≥ 22.15 (for `zlib` zstd) and a recent DSH release.

```
pnpm install
node test/run-all.mjs
```

Install location: `profiles/<profile>/local-plugins/dsh-peer-chat/`, wired in through a `file:` dependency.
Do not `link:` it from outside the profile — host peers will not resolve and the host only reports
`did not activate`.

## 9. License

Apache-2.0. See [LICENSE](./LICENSE).
