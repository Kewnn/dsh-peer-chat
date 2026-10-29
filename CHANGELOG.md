# Changelog

All notable changes to **dsh-peer-chat** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [2.3.1] — 2026-10-29

### Fixed
- Chain no longer stops at the first step when that step merely timed out while its session is still
  running: the step is recorded as `sent` and the chain continues, so later steps can still steer into it.

## [2.3.0] — 2026-10-29

### Added
- **Automatic steering inside chains.** Steps that target the same peer now steer into the session opened by
  the first step instead of starting a new turn. Override per step with `deliver: 'ask'`.
- Per-step `deliver` field is reported in results and rendered as `（插话）` / `（已投递·仍在跑）`.

### Fixed
- Steer replies are captured by watching for a new assistant message (a steer lands inside the *same* turn,
  so waiting for a finished turn never returned anything).

## [2.2.0] — 2026-10-29

### Added
- `peer_ask` detects when the peer stopped on an interactive choice card (`ask_user_question`, or a
  `show_view` with options) and returns `pendingQuestion: { tool, question, options[] }`.
  The rendered output lists the options as plain text (`A. … B. …`) and tells the caller how to answer
  with `peer_send`.

### Fixed
- Pending-question detection uses `callId` + `tool/result` instead of "was there a user message afterwards" —
  a plain text message does not resolve a card.

## [2.1.1] — 2026-10-29

### Added
- Panel **Send now** button: send the typed text straight to the first target (creates the session first
  when a mode is selected) and close the panel one second after success.

### Fixed
- `session_create` / session creation always sets the session working directory, so new sessions never land
  in `sessions\_no-cwd` (which made the web UI answer `session/not-found`).
- Cross-instance `session/create` is called with the flat payload the host expects.

## [2.1.0] — 2026-10-29

### Added
- `peer_send` — deliver a message into an existing session without waiting for the reply.
- Peer addressing by **port** (`peer: '<port>'`); `peers.json` keyed by port.
- Port scanning lists live instances as `port-<port>` and filters out the caller's own port.

## [2.0.0] — 2026-10-29

### Added
- First release: `peer_token`, `peer_list`, `peer_modes`, `peer_chains`, `peer_ask`, `peer_steer`,
  `peer_chain`, `peer_tail`.
- Bundled session layer (`session_create` / `send` / `wait` / `list_sessions`) and preset/steer layer
  (`session_spawn` / `session_steer`).
- Automatic web-token discovery from peer logs, with a single retry and cache write-back on HTTP 401.
- Sidebar panel to pick a peer, pick a mode, type a message and send — or build a chain visually.

[2.3.1]: https://github.com/Kewnn/dsh-peer-chat/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/Kewnn/dsh-peer-chat/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/Kewnn/dsh-peer-chat/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/Kewnn/dsh-peer-chat/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/Kewnn/dsh-peer-chat/compare/v2.0.0...v2.1.0
