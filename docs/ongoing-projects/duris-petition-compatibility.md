# Duris petition feed and MUD compatibility implementation plan

Status: in progress; Phases 0-4 implemented and verified at the command boundary;
Phase 5 artifacts and local/PM2 checks are published. Full game/save/copyover
acceptance passes; its review chunk is being published. Local container
verification remains blocked by Docker socket access.
Date: 2026-10-14.

## Mission and agreed scope

Make this bridge work with the local Duris checkout at `/home/staging/duris`
while preserving its existing compatibility with other MUDs that implement its
JSON protocol. Deliver the supporting integration code, documentation, sample
configuration, and regression coverage together.

The initial Duris integration has one channel, `petition`, and one chat
direction: **Duris -> Discord**. The user explicitly selected both accepted
`petition` messages and staff `ptell` replies for that feed. The destination is
a **staff-visible-only Discord channel**, managed through Discord permissions.
Discord posts must never become game chat or execute game commands.

The bridge must continue supporting bidirectional chat for other MUDs. This is
not a migration of the whole application to an outbound-only bot. Duris's
`nchat`, `jchat`, tells, guild chat, auction system, and other channels are outside
this initial rollout. Additional Duris channels require a later explicit scope
change; no dormant routes for them are needed now.

This document is the implementation handoff. Checked items are completed and
verified as recorded below; unchecked items remain required work.

## Current handoff (2026-10-14)

- Bridge work starts at `ba1682f3e010f5b06be50b9b1d16a1d5c37b1737` on
  `codex/duris-petition-compatibility`, based on `main`. Phase 0 is the first
  review chunk: [PR #30](https://github.com/LuminariMUD/discord-mud-chat/pull/30),
  commit `9f47f99`. Phase 1 is on `codex/duris-one-way-mappings`, stacked on it:
  [PR #31](https://github.com/LuminariMUD/discord-mud-chat/pull/31), implementation
  commit `f8487c8` (subsequent commits update this handoff).
- Duris transport is on `codex/duris-discord-endpoint`, based on `master` at
  `7156b32431394a12a5a726d1158e1968dd89b3c7`: implementation commit
  `03c316b4d`, [PR #83](https://github.com/LuminariMUD/Duris/pull/83). Stack the
  command-hook branch/PR on this branch (now implemented as recorded below). Follow its `AGENTS.md`. No local
  environment, player data, or running service was changed.
- Baseline bridge: Node 26.11.1; run the required npm with
  `npx --yes --package=npm@12.0.1 npm <command>` (shell npm is 11.20.0).
  `npm ci`, lint, all 77 tests, coverage, and high-level dependency audit pass.
  Coverage: 98.53% lines, 91.28% branches, 91.59% functions; no vulnerabilities.
- Baseline Duris: `make -C src`, `./scripts/format.sh --check`, and the five
  existing regression commands listed below all pass (chat privacy, game-loop
  phases, WebSocket runtime, word renderer, output profiles).
- Phase 0 adds `docs/protocol.md` and reusable JSON fixtures under
  `test/fixtures/mud-protocol/`. Tests exercise byte-wise UTF-8 fragmentation,
  coalescing, escaping, malformed records, exact/oversized byte boundaries,
  auth/heartbeat wire output, case-sensitive fan-out, duplicate mappings, and
  first-match ingress. Existing transport tests pin generic loopback/TLS
  configuration using injected sockets; live certificate tests remain Phase 4.
- Phase 0 validation: lint and all 81 tests pass; coverage is 98.53% lines,
  91.61% branches, 91.59% functions. `git diff --check` passes.
- Phase 1 implements shared validation in `config/load-config.js` and direct
  `ChatBridge` construction, then blocks ingress immediately after the first
  mapping match. Tests capture writes, counters, and rate-limit state for
  one-way, mixed, duplicate, default, invalid, TLS-auth, and loopback cases.
- Phase 1 validation: lint and all 88 tests pass on Node 26.11.1; coverage is
  98.55% lines, 92.15% branches, 91.67% functions. The coverage suite also passes
  locally on both CI versions (24.18.0 and 26.8.1), using npm 12.0.1.
- Phase 2: dedicated native endpoint, environment settings, lifecycle hooks,
  count-only diagnostics, and `docs/network/DISCORD_BRIDGE.md` are implemented.
  The endpoint is disabled by default and binds only 127.0.0.1. It uses its own
  zero-timeout `poll` during the connection phase (no `FD_SET` for its sockets),
  then flushes in the output phase. Work is capped at 4 accepts, 32 read/write
  attempts and 64 KiB per direction per pulse; output holds at most 256 events
  and 4,194,308 wire bytes. Only auth/heartbeat controls are consumed; chat is
  discarded. `discord_bridge_publish()` expects plain UTF-8 and serializes only
  `petition`; Phase 3 calls it through the native conversion helper.
- Phase 2 validation: full `make -C src`, formatting, new
  `python3 tests/async/test_discord_bridge_runtime.py`, all five existing
  regressions, and `test_command_latency_runtime.py` pass. The new runner builds
  under `bin/tests/` and uses real loopback sockets. Linker wrappers force short
  writes/EINTR/EAGAIN/EPIPE. It covers authentication, exact/oversized records,
  Unicode, overflow, extra clients, high/invalid descriptors, parser/queue reset,
  no partial replay, ordinary shutdown, and real successful/failed exec.
  Full game copyover/save journeys remain Phase 6; the exec test alone is not
  evidence of the complete game lifecycle. Initial strict-build EAGAIN alias
  warnings were fixed; the required formatter also corrected pre-existing drift
  in the touched `comm.c` file.
- Phase 3 is implemented on Duris `codex/duris-petition-exports`, commit
  `b2de29cbf`, [PR #84](https://github.com/LuminariMUD/Duris/pull/84), stacked
  on #83. Accepted `do_petition` and `do_ptell` each call
  `discord_petition_export` once before native delivery and outside recipient
  loops. It uses `AnsiString`/UTF-8 conversion, removes terminal control
  sequences, bounds input by native buffers, and preserves plain dollars.
  Explicit concealment states redact sender/target names; non-trusted reply
  senders are also `Someone`. See `docs/network/DISCORD_BRIDGE.md` for predicates.
  Petition and staff ptell help entries now disclose the optional feed.
- Phase 3 validation: full build and formatting pass. The production-command
  harness `test_discord_petition_export.py` passes normally and with
  `SANITIZE=1` (ASan/UBSan). It executes exact command bodies with production
  character types/parser, synthetic players, boundary delivery/log/visibility
  stubs, and real conversion/serialization/socket I/O. Accepted/rejected,
  zero/one/multiple staff, echo on/off, concealment, Unicode/escapes/control
  stripping, max buffers, overflow, disconnect, and disabled cases pass.
  The native endpoint suite and the five existing baseline regressions also pass.
  Additional real output integration (say/tell/guild/reply/act/paging/snoop) and
  flat-file help catalog/runtime tests pass. A pre-existing missing `<algorithm>`
  include in the output integration harness was fixed to run that test.
- Phase 4a is on bridge `codex/bounded-discord-delivery`, based on
  `codex/duris-one-way-mappings`, commit `4678c70`,
  [PR #32](https://github.com/LuminariMUD/discord-mud-chat/pull/32).
  It validates chat strings/optional numeric
  emotes, splits formatted content into <=2000 UTF-16 units at code-point
  boundaries, and serializes delivery per Discord destination. Queues hold at
  most 256 delivery events / 4 MiB of UTF-8 content globally, including active
  events. Failure drops the remaining parts of that event without replay;
  shutdown cancels queued work. Health counts successful posts and adds a
  separate event-drop counter. Error logs omit input/API request bodies.
  Existing relay content/count assertions remain, with waits for serial sends;
  cross-destination completion order is now explicitly independent.
- Phase 4a validation: lint and all 98 tests pass on Node 26.11.1/npm 12.0.1.
  Coverage also passes on both CI Node versions (24.18.0 and 26.8.1), using
  npm 12.0.1, with all 98 tests passing on each.
  Coverage: 98.69% lines, 93.18% branches, 92.24% functions; the new delivery
  module has 100% coverage across all three metrics. Tests include slow sends,
  event and UTF-8 byte limits, surrogate boundaries, mentions, failure mid-event,
  synchronous send errors, shutdown races, and subsequent-record recovery.
- Phase 4b is on `codex/bounded-mud-writes`, commit `e997462`,
  [PR #33](https://github.com/LuminariMUD/discord-mud-chat/pull/33), stacked on
  Phase 4a. MUD writes
  require an established connection, have a serialized-record limit, and hold
  at most 256 pending writes / 4 MiB including socket-buffered bytes. A false
  socket write is accepted once; subsequent records are rejected until drain.
  Pending callbacks settle once across close/replacement/shutdown, without
  replay or stale connection state changes. Health adds rejected/interrupted
  chat writes separately from accepted writes; controls are excluded.
- Phase 4b verification: the focused five-test independent network suite passes
  on Node 26.11.1. A separate generic fixture server exchanges the old format
  over real TCP and validated TLS, tests auth first, default bidirectionality,
  one-way exclusion, bytewise UTF-8 fragmentation, malformed/oversized recovery,
  reconnect and paused-reader backpressure. Fresh temporary test certificates
  prove trust/hostname rejection before auth. No Duris files or credentials are
  required. Lint and all 111 tests pass on Node 26.11.1. The coverage suite also
  passes on both CI versions (24.18.0 and 26.8.1), using npm 12.0.1. Aggregate
  coverage is 98.77% lines / 94.80% branches / 94.31% functions. The final TLS
  test additionally checks the exact trust/hostname error codes.
- Phase 4c is on `codex/duris-node-integration` in both repositories, stacked
  on bridge Phase 4b and native Phase 3. Bridge commit `4ce1c6b` is
  [PR #34](https://github.com/LuminariMUD/discord-mud-chat/pull/34).
  Native commit `68c5e7d1b` is
  [PR #85](https://github.com/LuminariMUD/Duris/pull/85).
  The native harness adds optional stdio
  controls for an external Node driver; its ordinary regression mode remains
  standalone. The bridge's `python3 scripts/test-duris.py --duris /path/to/duris`
  invokes it with a configurable checkout path. Real commands, conversion,
  serialization and listener connect to the actual Node transport/relay and
  an in-memory Discord sink through a fragmentation/fault-injection proxy.
  Both command labels, concealment, native output/audit counts, color/Unicode,
  long posts/mentions, rejected/other events, malformed/oversized recovery,
  reconnect and disconnect/disable rollback pass. Injected Discord posts produce
  controls only; direct forged chat changes neither dispatch nor native delivery
  counts, and Discord-to-MUD accepted/drop counters stay zero.
- Phase 4c verification: full native `make -C src`, changed/whole-file formatting,
  standalone native command regressions and the cross-repository runner pass.
  Cross-repository tests also pass with ASan/UBSan and both CI Node versions
  (24.18.0 and 26.8.1), in addition to 26.11.1. These are
  production-command harnesses with synthetic players and boundary stubs;
  they do not establish full game boot/save/copyover behavior.
- Phase 5 is on bridge `codex/mud-integration-samples`, based on
  Phase 4c: implementation commit `912736c`,
  [PR #35](https://github.com/LuminariMUD/discord-mud-chat/pull/35).
  It supplies the Duris JSON template/operator guide, byte-identical
  native module copies and an exact integration patch with a drift/build runner.
  The generic example is now a standalone Linux/POSIX C89/cJSON transport with
  an explicit game callback, bounded records/queues/pulse work, whole-event
  drops and no replay; malformed old fragments are labeled insertion recipes.
  Generic adapters retain arbitrary channels and bidirectional capability.
- Phase 5 verification: the generic socket/fault harness and native
  sample hash/drift/clean-base patch/compiled-copy/Node checks all pass, normally
  and under ASan/UBSan. Local generic and Duris sample configurations pass the
  real application smoke test with a synthetic Discord sink. PM2 6.0.14's isolated
  one-process startup/restart/health/graceful-stop test passes. PM2 previously
  requested IPC shutdown although the app handles signals; its template now
  explicitly selects fork mode and normal signal shutdown.
- Phase 5 final checks: lint and all 111 Node tests pass on Node 26.11.1 with
  npm 12.0.1, with 98.77% lines / 94.80% branches / 94.31% functions covered;
  dependency audit reports zero vulnerabilities. JSON templates validate
  through the production loader, local documentation links resolve, and default
  plus host-network Compose configurations parse with synthetic environment
  settings. The generic C89 sample has its own sanitizer CI job; the existing
  container job now invokes the image/host-loopback runner instead of build-only.
- Docker verification is unavailable in this executor: the local daemon is
  running, but `/var/run/docker.sock` is root:docker mode 0660; uid 10014 belongs
  only to `staging`, and `sudo -n -l` denies sudo. No daemon, group, socket mode,
  or system service was changed. The Dockerfile/build/topology gate must still
  be run with authorized local Docker access; local socket tests or Compose
  parsing alone do not satisfy it. The checked-in runner is
  `python3 scripts/test-container.py`.
- Next: publish the full-game acceptance PRs, finish the local container gate
  after authorized Docker access is restored, then audit implementation
  completion. Environment recovery was requested; the current runner still
  fails at `docker info` with socket permission denied. No live Discord messages
  were sent; permission/audience checks remain a later requested rollout gate.
- Phase 6 is on `codex/duris-game-acceptance` in both repositories,
  based on bridge #35 and native #86. Native acceptance commit `8d183de95` is
  [PR #87](https://github.com/LuminariMUD/Duris/pull/87).
  A new disposable full-game journey uses
  real account/character creation, saves/reload, failed exec and successful
  copyover with the actual Node relay. The first run exposed native input dollar
  doubling that the direct-command harness had missed. A focused regression
  failed before the fix and passes afterward: the exporter now applies native
  `delete_doubledollar()` to its converted copy, preserving command arguments,
  recipient behavior and audit logs.
- The dollar fix is published independently as native commit `68053767e`,
  [PR #86](https://github.com/LuminariMUD/Duris/pull/86), stacked on #85.
  Full normal/flat-file builds, formatting, command regressions, ASan/UBSan
  plus Node integration, endpoint, privacy, phase, WebSocket and output checks
  pass. The bridge's native samples now match acceptance revision `8d183de95`
  (the production modules are identical to the dollar-fix revision); their checker also
  extracts the production dollar-unescaping function for executable tests.
- Phase 6 full-game verification passes with
  `python3 scripts/test-duris.py --duris /home/staging/duris --full-game`:
  a fresh flat-file build, two synthetic accounts, real gameplay sockets and the
  actual Node relay exercise both event types, zero online staff, echo off,
  concealed staff, dollar escaping, rejected commands, unrelated say/tell,
  blocked Discord posts and direct forged ingress. A deliberately invalid staged
  executable forces actual failed `execl`; original player sockets, acknowledged
  saves, native delivery and the same bridge connection remain usable. Successful
  exec preserves player sockets, reloads saved players, recreates the listener,
  and reconnects Node. Both commands work after copyover, after stopping Node,
  and after a disabled restart; native audit entries remain present exactly once.
  Normal shutdown and later save/reload pass. This is a complete game process
  with a minimal flat-file world, not a live Discord or production-database test.
- Phase 6 bridge verification: lint and all 111 coverage tests pass with unchanged
  98.77% lines / 94.80% branches / 94.31% functions. Updated native sample copies
  pass hash/drift/clean-base patch/compiled-copy/Node checks normally and under
  ASan/UBSan. Full native build, whole-file formatting and all five baseline
  regressions pass after the dollar fix.
- Additional Phase 5 evidence: [CI run 38587090639](https://github.com/LuminariMUD/discord-mud-chat/actions/runs/38587090639)
  passed at bridge `6bb754c`. The inspected container job log confirms the actual
  Dockerfile build, application smoke, host-loopback peer, health and one-way
  relay all passed on its Ubuntu Linux runner. Both Node jobs and the generic
  sanitizer job passed too. This is separate from the unavailable Docker socket
  in this executor; no local Docker success is claimed.
- Git policy for this project: commit and push each verified chunk, open focused
  ready-for-review PRs, stack dependent changes, and leave merging to review.
  No release tags until a tested release is actually being prepared.


## Evidence from the current repositories

Inspected bridge revision: `57a8c5838df0f9200df16084fceb71df18790a3f`.
Inspected Duris revision: `7156b32431394a12a5a726d1158e1968dd89b3c7`.
Duris paths in this document are relative to `/home/staging/duris`.

| Area | Observed implementation | Consequence for the plan |
| --- | --- | --- |
| Bridge protocol | [src/bridge.js](../../src/bridge.js) exchanges UTF-8 JSON records terminated by LF. Chat fields are `channel`, `name`, `message`, and optional numeric `emoted`. | Preserve this wire format and server/client roles. A Duris name or configuration change alone cannot supply the missing server endpoint. |
| Mapping behavior | `relayMudRecord()` fans out to matching MUD mappings; `handleDiscordMessage()` selects the first matching Discord mapping. There is no direction setting. | Add an optional direction setting with the old behavior as its default. Preserve existing matching and fan-out semantics. |
| Transport | [src/mud-client.js](../../src/mud-client.js) permits plaintext only to literal loopback IPs; remote connections and authentication tokens require certificate-validated TLS. | Keep these rules. Duris gameplay TLS does not make its gameplay port a JSON bridge endpoint. |
| Control messages | The bridge sends optional `auth` first after TLS connection, then `heartbeat` / `ping` every 240 seconds. It does not require an authentication acknowledgment or pong. | One-way chat still needs an incoming control parser on Duris. Do not introduce a mandatory handshake for existing peers. |
| Duris network stack | `src/net/comm.c` owns Telnet, TLS, WebSocket, and the phased game loop. `src/net/websocket.c` implements a framed, session-oriented protocol. No dedicated Discord JSON listener was found in the inspected source. | Add a dedicated nonblocking listener. Do not connect this bridge to a player port or scrape player sessions. |
| Duris chat JSON | `src/core/json_utils.c` builds GMCP chat with `channel`, `sender`, `text`, and sometimes `alignment`; `src/net/gmcp.c` delivers it per recipient. | This is not the bridge wire format. Hook accepted commands once, rather than relaying every recipient's GMCP output. |
| Petitions | `src/cmd/actcomm.c::do_petition()` checks NPC, silence, petition-block, petition-toggle, and empty-input conditions before delivery. It sends the petitioner and eligible staff their native output and GMCP. | Export only accepted messages, once per command, even when no staff are online. Keep all native checks and delivery unchanged. |
| Staff replies | `src/cmd/actwiz.c::do_ptell()` validates its target, sends a private reply, and copies it to staff monitoring petitions. Its GMCP records also use `petition`; staff copies include a `sender -> target` label. | Include accepted replies in the same feed, identifying the target. Do not accidentally export all private tells. |
| Visibility and privacy | `docs/adr/0003-player-privacy-chat-snoop-addresses.md` permits petition/staff audit logging and protects other conversation. Native `ptell` output can conceal the staff sender as `Someone`. | Use the staff-only destination selected by the user, preserve concealed identities in the feed, and avoid a global chat/log interception hook. |
| Duris implementation language | `src/Makefile` compiles `.c` files as C++20 and already links cJSON, SSL, and crypto libraries. `src/net/ansi.h` understands Duris color markup. | Reuse native facilities. The Circle/Luminari C89 sample is not a drop-in Duris module. |
| Existing examples | [docs/mud_example/discord_bridge.c](../mud_example/discord_bridge.c) has hand-written JSON parsing, a 4096-byte I/O buffer, and an 8192-byte serialization buffer, despite a larger advertised record limit. Companion `.c` files contain incomplete integration fragments. | Repair and test generic examples as well as adding a Duris example. Do not present these fragments as complete compilable source files. |
| Existing tests | [test/bridge.test.js](../../test/bridge.test.js), [test/mud-client.test.js](../../test/mud-client.test.js), and the remaining suite cover generic relay, framing, Unicode, TLS, retries, health, and shutdown. | Extend these tests; retain their assertions for existing behavior. Add executable native integration tests for Duris. |

Planning originally had no build/test baseline. The execution baseline above
now supersedes that limitation. No live MUD session or Discord delivery has
been tested; isolated native and real-service checks remain later gates.

## Design decisions and compatibility boundaries

### Keep one protocol and add direction to mappings

Use the current JSON-over-TCP/TLS protocol for Duris. Implement the Duris server
endpoint in Duris and keep its channel semantics there. Do not add a MUD brand
switch, mandatory protocol version, WebSocket adapter, or general plugin system.

Add `direction` to individual entries in `channels`:

| Value | MUD -> Discord | Discord -> MUD |
| --- | --- | --- |
| Omitted, or `"both"` | Allowed | Allowed |
| `"mud_to_discord"` | Allowed | Blocked |

Reject unknown direction values rather than silently enabling bidirectional
relay. Validate through normal startup and direct `ChatBridge` construction.
Do not impose Duris channel names, message limits, color rules, or staff policy
on generic integrations.

Preserve arbitrary case-sensitive channel names, the existing mapping shape,
ordinary `name: message` formatting, and current `emoted: 1` behavior (message
content without the author prefix; currently not automatic italics). Preserve
emoji options, stable-user rate limiting, retries, environment-only MUD tokens,
literal-loopback/TLS rules, health endpoints, and graceful shutdown. Extra
optional JSON fields must remain tolerable. Well-formed legacy records must not
need new fields or acknowledgments.

The direction check must occur before a Discord chat write or associated rate
limit/counter mutation. A blocked first-match mapping must not fall through to
another mapping and leak the same post into the game. Existing generic fan-out
and first-match behavior stay unchanged when `direction` is absent.

### Enforce one-way operation at both ends

Duris publishes only `channel: "petition"`. Its bridge endpoint accepts only
the protocol's authentication and heartbeat controls. Incoming chat records,
including `petition`, are discarded with a bounded diagnostic/counter. There is
no path from that endpoint into `command_interpreter`, `do_petition`, `do_ptell`,
or player broadcast functions.

This permits heartbeat and optional authentication traffic from the Node client
without permitting Discord-originated chat. Discord's channel permissions
establish the audience; they are not the mechanism enforcing the direction.

### Publish once from the accepted command paths

Add one export call in the successful branch of `do_petition()` and one in the
successful branch of `do_ptell()`, outside their recipient loops. Capture the
accepted text and labels before local scratch buffers can change. The hooks must
work with zero, one, or many staff recipients and with player echo disabled.

Preserve native command authorization, player feedback, petition logs, staff
toggles, terminal output, GMCP, and existing visibility decisions. Do not hook
`send_to_char`, `gmcp_comm_channel`, `send_to_gods`, or the log writer globally.

Use the existing schema for both event types:

```json
{"channel":"petition","name":"Player","message":"I need help with a stuck character.","emoted":0}
{"channel":"petition","name":"Staff -> Player","message":"I am checking that now.","emoted":0}
```

Each object above is a separate wire record followed by an actual LF byte.
The reply label is presentation text, not a command or authenticated identity.
Keep staff invisibility/concealment conservative: a hidden staff sender is
`Someone -> Player` in the external feed. Do not assume that every member of a
Discord staff role has the highest in-game visibility privilege. Define and test
the native visibility predicates used by this redaction without inventing a
logged-in bot character.

Strip Duris color markup and terminal controls at the Duris export boundary,
using its existing ANSI/Unicode facilities with bounded output. Preserve valid
UTF-8, punctuation, literal `@`, and JSON escapes. Construct records with cJSON;
do not concatenate raw names/text into JSON or reuse the sample's `@` color
stripper. Preserve dollar escaping for native `act()` output independently from
the plain text exported to Discord.

### Keep transport work bounded and independent of gameplay

The new endpoint is disabled by default. When enabled, its initial plaintext
listener binds to `127.0.0.1` on configurable port 8181, separate from all player
ports. The Phase 2 implementation provides this listener. Accept one
active bridge client and reject extra clients without replacing the active one.

Use nonblocking I/O, bounded input/output queues, per-pulse work budgets, and
partial-write offsets. Handle fragmented/coalesced records, split UTF-8,
`EINTR`, `EAGAIN`, EOF, and oversized-record recovery. Check descriptor bounds
before using `FD_SET`. Never block the game thread on the bridge or Discord.

Integrate readiness/reads into the connection phase and writes into the output
phase described by `docs/network/GAME_LOOP_PHASES.md`. Keep ownership on the
game thread and preserve phase order. Reset parsing, authentication, and queue
state on disconnect. Mark the new sockets close-on-exec: successful copyover
recreates the listener and the bridge reconnects; failed copyover must leave the
old process usable. Test both paths and ordinary shutdown.

For remote deployment, use a certificate-validated TLS terminator forwarding
only to the loopback endpoint, with the existing auth record when a token is
configured. Store server/client secrets in environment variables, never sample
JSON. A local plaintext example must leave the auth token unset. Never disable
certificate verification or weaken Node's transport checks to make Duris work.

Delivery remains bounded, best-effort chat delivery. Do not introduce a database
or promise durable/exactly-once delivery across outages. Under normal operation,
one accepted command creates one logical event. During overflow/disconnection,
drop whole events with observable counts; never queue unbounded petition text,
replay a partial record on a new connection, or automatically replay uncertain
Discord sends. Existing Duris petition logs remain the native audit record.

## Implementation sequence

### Phase 0 - Freeze the existing contract

- [x] Record current test/lint results and both source revisions before editing.
      Use the repository toolchain and separate existing failures from regressions.
- [x] Add a small shared fixture corpus under `test/fixtures/mud-protocol/` for
      ordinary records, emotes, arbitrary channels, auth, heartbeat, escaping,
      Unicode, malformed input, and record boundaries.
- [x] Pin existing generic inbound first-match/outbound fan-out behavior and
      generic loopback/TLS configurations without any Duris settings.
- [x] Write `docs/protocol.md` describing the actual wire contract, control
      records, byte limits, and delivery guarantees. Distinguish current behavior
      from requirements documents that describe unimplemented features.

Gate: the unchanged bridge passes its baseline tests; fixtures describe actual
behavior and can be consumed by independent peers. No claim that every named
MUD has been tested follows from passing generic protocol fixtures.

### Phase 1 - Add the optional one-way mapping

- [x] Update `config/load-config.js` and `src/bridge.js` as needed to validate
      and enforce `direction`, including direct bridge construction.
- [x] Leave existing configuration defaults and generic examples bidirectional.
- [x] Add tests proving `mud_to_discord` forwards MUD messages but performs no
      Discord chat writes, increments no Discord-to-MUD counter, and does not
      consume rate-limit state for ignored Discord posts.
- [x] Test mixed mappings, missing direction, explicit `both`, invalid values,
      and existing duplicate/fan-out semantics. Authentication and heartbeats
      must still work with a one-way mapping.

Gate: existing generic bidirectional tests pass unchanged; one-way tests assert
actual captured socket writes, not merely the presence of a configuration key.

### Phase 2 - Implement the Duris endpoint and lifecycle

- [x] Add `src/net/discord_bridge.c` and `.h` in Duris, following its C++20 style
      and using its existing cJSON dependency. Add the object in `src/Makefile`.
- [x] Add non-secret settings to Duris `.env.example`: enable flag, listener
      port, record-byte limit, and an optional environment-only token setting.
      Document exact names/defaults together with the implementation. Do not edit
      the local `.env`, credentials, player data, or running deployment.
- [x] Wire initialization, bounded polling/flushing, shutdown, and copyover
      behavior through `src/net/comm.c`; touch `src/persistence/copyover.c` only
      if the existing lifecycle needs explicit integration.
- [x] Implement a bounded newline-record parser, cJSON validation, optional
      authentication before export, heartbeat consumption, and rejection of all
      incoming chat. Unknown controls must not trigger broadcasts or crash.
- [x] Add a native executable harness using real endpoint code and loopback
      sockets, including short writes, extra clients, authentication failure,
      invalid descriptors, queue overflow, reconnect, and disabled operation.

Gate: the server builds with the endpoint disabled and enabled; a real protocol
client can connect and consume an exported fixture without player login.
Forged incoming chat cannot affect any player or execute any command.

### Phase 3 - Connect petitions and staff replies

- [x] Add the two accepted-command hooks in `src/cmd/actcomm.c::do_petition()`
      and `src/cmd/actwiz.c::do_ptell()`. Keep rejection branches and native
      output behavior unchanged.
- [x] Implement plain text conversion, reply target labels, concealed-sender
      redaction, and full-record serialization with bounds derived from actual
      Duris name/text buffers. Do not confuse `MAX_INPUT_LENGTH` with wire-record
      size or silently truncate a JSON record to fit a small fixed buffer.
- [x] Test real command paths with NPC/blocked/silenced/disabled/empty petitions,
      and missing, self, NPC, invisible/ineligible, or disconnected reply targets.
      Only accepted commands may produce bridge events.
- [x] Test zero/one/many online staff, echo on/off, normal/hidden staff senders,
      quotes, backslashes, dollars, color markup, Unicode, and an unavailable
      bridge. Each accepted command exports once regardless of recipient count.
- [x] Assert other channels, ordinary tells, staff echoes, and `send_to_gods()`
      notifications never enter the petition feed.

Gate: petitions and `ptell` replies reach the fixture client once per accepted
command, preserve native recipient behavior, and never expose an unselected
channel. Existing privacy/output regressions continue passing.

### Phase 4 - Verify complete relay and transport limits

- [x] Add schema checks where malformed records currently interpolate missing
      or non-string fields into Discord output. Keep well-formed old records and
      optional extra fields compatible.
- [x] Handle Discord's 2000-character content limit after including the author
      or reply label. Preserve existing short-message formatting; split long
      messages in order at safe Unicode boundaries with bounded queueing and
      `allowedMentions: { parse: [] }` on every part. The limit is documented in
      the [Discord Create Message API](https://docs.discord.com/developers/resources/message#create-message).
- [x] Exercise `MudClient`/`ChatBridge` write backpressure and disconnects;
      contain any required fixes to generic transport behavior. Keep control
      writes distinct from prohibited Discord chat writes in one-way mode.
- [x] Test the real Duris endpoint with the actual Node transport and a fake
      Discord client. Include the two command exports, Unicode fragmentation,
      malformed/oversized records followed by valid ones, reconnect, and an
      injected Discord post that produces no game chat.
- [x] Define health/counter meanings accurately: socket connectivity is not
      proof of authentication or delivery; one split event may create multiple
      Discord posts. Count only successful sends using the existing counter
      semantics, and report drops without logging petition bodies or tokens.

Gate: executable cross-repository tests demonstrate the requested flow and its
negative direction. Generic TCP/TLS peers still pass the same contract suite.

### Phase 5 - Ship usable documentation and examples

| Artifact | Required content |
| --- | --- |
| `config/config.duris.example.json` | A separate Duris template with exactly one `petition` mapping and `direction: "mud_to_discord"`; placeholder Discord ID; no secrets. |
| `docs/duris.md` | Local checkout integration/build steps, dedicated listener setup, both event types, staff-only Discord permissions, no Discord-to-game replies, health, troubleshooting, outage behavior, copyover, and rollback. |
| `docs/protocol.md` | Shared protocol, control/chat distinction, optional direction semantics, byte/character limits, backward compatibility, and exact sample records. |
| `docs/mud_example/duris/` | Matching native module source/header plus a small integration patch or exact hook snippets for the inspected Duris layout. Include a README with the tested Duris revision, build instructions, and how to check sample drift. Do not copy entire game files. |
| `docs/mud_example/README.md` and existing generic examples | Explain target codebase assumptions and integration points. Repair unsafe manual JSON handling, mismatched buffer limits, overflow recovery, and incomplete/misleading file fragments. Document any JSON-library prerequisite; do not require C++20 from unrelated MUDs. |
| `README.md`, `docs/mud_requires.md`, `docs/bridge_requires.md` | Link generic and Duris paths separately. Document direction defaults and remove stale claims such as automatic emote italics, exponential reconnect backoff, or queues that the current code does not implement. Keep generic channel examples. |
| `docs/deploy.md`, `docs/setting_up_discord_bot.md`, `.env.example` | Staff-channel visibility setup, validated TLS/token examples, single active bridge instance, and working local/PM2/container networking instructions. Remove PM2 cluster guidance that would duplicate this feed. |
| `docs/testing.md` and test/example runners | Commands for the generic suite, native harness, and cross-repository checks. Make Duris paths configurable; generic tests must not require `/home/staging/duris` or real Discord credentials. |
| Duris network docs and petition/ptell help entries | Explain that accepted petitions and replies may also reach the staff Discord feed, while native recipients/toggles and other channel privacy remain unchanged. Record tested lifecycle/configuration details. |

Keep the generic example locations usable for existing readers. Prefer tested
sample code to prose-only pseudocode. Verify native samples against the Duris
build or harness and generic samples against an independent protocol harness;
clearly distinguish a sample harness from a build of upstream LuminariMUD.

For Docker, `127.0.0.1` inside a container is not the host MUD. Provide and test
an explicit same-network-namespace deployment or a TLS-accessible endpoint.
Do not recommend remote plaintext addresses to bypass the existing guard.
Keep the health endpoint's current loopback exposure.

Gate: follow the Duris guide from sample files on a clean local test setup,
check every new command/path, and reproduce the generic guide with a non-Duris
fixture peer. No sample or documentation change silently enables game ingress.

### Phase 6 - Acceptance and rollout

- [ ] Run the matrix below and record source revisions, commands, outcomes, and
      any environmental limitations. A mock transport alone is insufficient for
      native listener/copyover claims.
- [x] In an isolated local Duris test instance, confirm accepted petitions and
      staff replies preserve game behavior and reach the Node test sink.
- [ ] During the later requested deployment, use the staff-only Discord channel
      for a small real-service smoke test of both event types. Confirm an
      ordinary Discord post never reaches Duris. The planning task itself does
      not send messages or change a running service.
- [ ] Start with one enabled endpoint and one Node process. Verify the configured
      Discord audience and that no other channel mapping is present.
- [x] Exercise rollback: stop the Node bridge or disable the Duris endpoint and
      restart using the normal local procedure. Native petition/ptell behavior
      must continue. Keep generic deployment defaults unchanged.

## Proposed Duris bridge configuration

The Phase 1 bridge enforces `direction`; the Duris endpoint and command hooks
exist on the Phase 3 branch. The endpoint must also be enabled in Duris.
Node/native command-boundary integration, local/PM2 sample deployment and full
isolated-game acceptance are verified. Container execution passed on an isolated
CI Linux runner; execution in this workspace remains blocked by daemon access.

```json
{
  "mud_name": "Duris",
  "mud_ip": "127.0.0.1",
  "mud_port": 8181,
  "mud_tls": false,
  "mud_tls_servername": "",
  "mud_max_record_bytes": 1048576,
  "mud_retry_count": 50,
  "mud_retry_delay": 30000,
  "mud_infinite_retries": true,
  "rate_limit_per_channel": 10,
  "strip_emoji": true,
  "enable_bitly": false,
  "largest_printable_string": 65535,
  "channels": [
    {
      "discord": "STAFF_PETITION_CHANNEL_ID",
      "mud": "petition",
      "direction": "mud_to_discord"
    }
  ]
}
```

The operator supplies the bot token through `DISCORD_TOKEN` and makes the target
channel visible only to the intended staff and bot. In this local plaintext
example, `MUD_AUTH_TOKEN` is unset. A remote example must use validated TLS and
document the TLS terminator's trust boundary and optional shared token.

## Verification matrix

| Requirement | Authoritative evidence required |
| --- | --- |
| Legacy configurations still work | Existing tests plus fixtures with no `direction`, arbitrary channel names, ordinary/emote records, inbound first-match and outbound fan-out, and both chat directions. |
| One-way mode is effective | Captured real/fake socket writes contain permitted controls only after a Discord post; `discordToMud` stays zero; a forged chat record at the Duris endpoint causes no game output or command dispatch. |
| Both requested event types work | Executable `do_petition` and `do_ptell` cases produce the correct `petition` record and author/target label exactly once with zero, one, and multiple staff online. |
| Rejected commands stay rejected | Negative command cases produce no exported record and retain their existing in-game feedback. |
| Scope and staff visibility are preserved | No other channel exports; hidden staff labels are redacted; native output/GMCP and privacy regressions pass; Discord's destination permissions are checked at rollout. |
| Framing and text are correct | Real sockets with split/coalesced UTF-8, escaped newlines, CRLF/blank lines, malformed objects, exact byte limits, oversized recovery, color markup, dollars, mentions, and Unicode-safe Discord chunk boundaries. |
| Network handling cannot stall gameplay | Native short-write/backpressure and per-pulse budget tests; bounded-memory overflow; one-client policy; EOF/error recovery; disabled listener; ordinary shutdown and successful/failed copyover. |
| Existing transport protection remains | Generic loopback TCP, validated TLS, bad-certificate rejection, server-name handling, optional auth before chat, no plaintext tokens, heartbeat, retries, stale-socket isolation, and shutdown tests. |
| Independent MUDs remain supported | A generic fixture server in a separate process exchanges the old format in both directions with no Duris files, channel allowlist, or mandatory new fields. Test the repaired generic C sample separately. |
| Documentation and samples are usable | Example JSON parses; samples match the implementation; native sample builds; generic sample round-trips; documented local/PM2/container instructions use a valid transport topology. |

Expected bridge checks after implementation, from `/home/staging/discord`:

```sh
npm ci
npm run lint
npm test
npm run test:coverage
```

Retain the coverage thresholds in `package.json` (95% lines, 90% branches, 85%
functions), the supported Node versions in `.github/workflows/test.yml`, and
the existing dependency-audit/container checks. Run the container check when
validating the documented container topology. Do not require external CI to
substitute for local verification.

Expected Duris checks after native changes, from `/home/staging/duris`:

```sh
make -C src
./scripts/format.sh --check
python3 tests/async/test_chat_log_privacy.py
python3 tests/async/test_game_loop_phase_contract.py
python3 tests/async/test_websocket_runtime.py
python3 tests/async/test_word_output_style.py
python3 tests/async/test_output_profiles.py
```

Add focused `tests/async/test_discord_bridge_runtime.py` and
`tests/async/test_discord_petition_export.py` runners (proposed names), following
the existing executable-harness conventions. Place compiled artifacts under
`bin/`, use synthetic players and temporary sockets, and exercise the actual
native implementation. Add a cross-repository runner with a configurable Duris
source path and a fake Discord sink. Real live Discord validation is a separate
rollout check, not a requirement for running the generic test suite.

## Completion criteria for implementation

- [ ] Duris exports accepted petitions and staff `ptell` replies to the single
      staff-only Discord destination, once per accepted command in normal
      operation, with correct sender/target text and no other channel exports.
- [ ] Discord-originated chat cannot enter Duris, while authentication and
      heartbeat controls continue working.
- [ ] Existing generic MUD configurations remain bidirectional by default and
      pass independent interoperability/regression checks without Duris present.
- [ ] Native gameplay, petition permissions, recipient behavior, logging,
      rendering, lifecycle, and visibility remain correct with the bridge
      enabled, disabled, disconnected, and overloaded.
- [ ] Supporting docs and both Duris/generic sample code are accurate, tested,
      linked, and shipped with the changes; no unsupported MUD is advertised as
      live-tested merely because it has a name in an example.
- [ ] Verification records distinguish unit tests, native integration tests,
      generic interoperability, and real Discord rollout checks. Any remaining
      unverified required behavior keeps implementation completion open.

The implementation can proceed in small changes: generic direction support,
Duris transport, petition/ptell hooks, then integration tests and documentation.
The documentation and examples remain part of completion, not optional follow-up
work. No pending channel-selection decision remains for this initial scope.
