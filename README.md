# dsh-peer-chat

**English** ｜ [中文](./README.zh-CN.md)　·　Install: [English](./INSTALL.md) ｜ [中文](./INSTALL.zh-CN.md)　·　License: Apache-2.0

Talk to another DSH instance end to end: **the plugin discovers the peer's web token on its own**, logs in for a
cookie, creates or picks a session, delivers the message, then polls the peer's session log for the reply.
Locally it acts on the current session (`self`) — no extra process, no extra copy of the session machinery.

Peers are addressed by **port** (`peer: 3090`), which is stable and needs no alias bookkeeping.

---

---

## 1. What it solves

Each DSH process listens on its own port and knows nothing about the others. This plugin lets two (or more)
instances message each other, read replies and steer a running turn — **without copying tokens by hand**.
The web token rotates on every restart; the plugin reads it from the peer's logs instead.

## 2. Addressing a peer: use the port

The port is the primary identifier; a name is only an optional alias.

```js
peer_ask({ peer: 3090, message: 'reply OK only' })        // the instance listening on 3090
peer_ask({ peer: '127.0.0.1:3090', message: '…' })        // equivalent
peer_ask({ peer: 'self', message: '…' })                  // the current session, local route
```

`peers.json` may be keyed by port (recommended — no aliases to maintain):

```json
{
  "3090": { "url": "http://127.0.0.1:3090", "home": "E:\\dshlonger\\dsh-home" },
  "3130": { "url": "http://127.0.0.1:3130", "home": "E:\\dshsystem\\dsh-home" }
}
```

`home` is where the token is read from (`<home>/*.log`). Provide it and token discovery is fully automatic;
without it the plugin falls back to the cached token.

> The panel's **Scan peers** button probes the loopback port range (default `3000-3200`) and lists whatever is
> alive as `port-<port>`; it never lists the instance's own port.

## 3. The nine tools

| Tool | Purpose | Waits for reply |
|---|---|---|
| `peer_token({ peer })` | Identify the peer token (first 6 chars + source only) | — |
| `peer_list({ scan? })` | List peers, optionally including a live scan | — |
| `peer_modes({ peer })` | Read the peer's available presets | — |
| `peer_chains()` | List saved chains | — |
| `peer_ask({ peer, message, preset?, sessionId?, cwd? })` | Create/pick a session, deliver, **wait** | ✅ |
| `peer_send({ peer, sessionId, message, mode? })` | Send a message, **do not wait** | ❌ |
| `peer_steer({ peer, sessionId, message })` | Deliver at the next step boundary | ❌ |
| `peer_chain({ name \| steps, input?, mode? })` | Multi-hop chain, `{prev}` carries the previous reply | per step |
| `peer_tail({ peer, sessionId, n? })` | Read the last n assistant messages of a peer session | — |

## 4. Session tooling included

The plugin is self-contained: installing it gives you both the session layer and the cross-instance layer.

| Layer | Tools |
|---|---|
| Local sessions | `session_create` · `session_send` · `session_wait` · `list_sessions` |
| Presets & steering | `session_spawn` (create by preset) · `session_steer` (talk into a running turn) |
| Cross-instance | `peer_token` · `peer_list` · `peer_modes` · `peer_chains` · `peer_ask` · `peer_send` · `peer_steer` · `peer_chain` · `peer_tail` |

If another plugin in your profile already provides `session_spawn`, set `config: { mergeSessionPlus: false }`
on this plugin's row to avoid a duplicate registration.

## 5. Where the token comes from

1. `config.token` / the `PEER_TOKEN` environment variable
2. the last `dsh web: http://127.0.0.1:<port>/?token=XXX` line in `<peer.home>/*.log`
3. the token cached in `peers.json`

On HTTP 401 the log is rescanned; if the token changed the plugin retries once and writes the new token back to
`peers.json`. To make a peer write its startup output to disk, launch it with `start-logged.cmd`
(`tee` into `<home>\web-console.log`).

## 6. Panel

Sidebar → bottom-left “🐟 跨端对话”:

- **Peers** — `self`, entries from `peers.json`, and `port-<port>` results from *Scan peers*
- **Modes** — presets available on the selected peer
- **New chain** — each row = peer (port) + mode + a **message content input** (empty = generated from the mode)
- **Send now** — skip the chain: send the typed text to the first target (with a mode it creates the session
  first). On success the panel closes itself after one second.

Chains live in `<DSH_HOME>\peer-chat\chains.json`.

## 7. Known edges

- **A session's `header.cwd` is immutable** — it can only be set when the session is created. This plugin always
  passes a cwd (falling back to a default workspace); otherwise the session lands in `sessions\_no-cwd` and the
  web UI answers `session/not-found`.
- The peer RPC `session/create` takes a **flat payload** `{ cwd?, agentPreset? }`; wrapping it in `request` is
  silently ignored.
- If a chain step resolves to an empty message, a default message is substituted — an empty *run input* no
  longer fails the whole chain.

## 8. Development

Requires Node ≥ 22.15 (for `zlib` zstd) and DSH ≥ `0.2.1-rc.2`.

```
pnpm install            # a single peer dependency: @deepseek-ai/cordis
node test/run-all.mjs   # bundled tests
```

Install location: `profiles/<profile>/local-plugins/dsh-peer-chat/`, wired in via a `file:` dependency.
Do **not** `link:` it from outside the profile — `@deepseek-ai/*` will not resolve and the host only reports
`did not activate`.
