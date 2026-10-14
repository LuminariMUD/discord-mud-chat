# Bridge behavior and requirements

This describes the implemented Node bridge. The [wire protocol](protocol.md)
is authoritative for peer interoperability; the [project handoff](ongoing-projects/duris-petition-compatibility.md)
records Duris work and remaining acceptance gates.

## Runtime and configuration

The project requires Node >=24.18.0 and npm >=12.0.1, installs from
`package-lock.json`, and uses discord.js 14, Winston, dotenv and emoji-regex.
`src/index.js` composes `ChatBridge`, `MudClient`, health and logging. Tests use
the Node built-in runner, not Jest. Configuration is `config/config.json` plus
the environment; see [README](../README.md) for fields.

`DISCORD_TOKEN` is the bot credential. `MUD_AUTH_TOKEN` is optional and sourced
only from the environment; legacy JSON MUD tokens are ignored. `HEALTH_PORT`
and `LOG_LEVEL` control operations. Bitly options are reserved and do not enable
URL shortening.

## Relay invariants

- Generic mappings default to bidirectional; `both` is explicit bidirectional
  and `mud_to_discord` blocks Discord chat. Unknown directions fail startup and
  direct bridge construction. A blocked first match cannot fall through.
- MUD channel names are arbitrary and case-sensitive. MUD events fan out to all
  matching mappings, including duplicates; Discord posts use the first match.
- Chat fields are validated. Ordinary output is `name: message`; numeric
  `emoted: 1` omits the prefix and does not add italics. Extra fields are tolerated.
- Discord output includes the prefix before splitting at code-point boundaries
  into <=2000 UTF-16 units. Sends are ordered per destination; destinations drain
  independently. Every part disables mention parsing.
- Discord ingress ignores bots, missing members/IDs, empty/oversized text and
  unmapped/one-way channels. It sanitizes mass/user mentions, optionally strips
  emoji, and rate-limits by stable user ID and MUD channel.
- Auth precedes chat on a newly established TLS socket. Heartbeats remain valid
  in one-way mode. There is no mandatory auth acknowledgment/pong/version change.

Duris is an adapter, not a special mode in the Node application. It publishes
only accepted petitions and staff replies through a dedicated endpoint and
independently discards all incoming chat. See [Duris](duris.md). Generic games
retain both directions and their own channels; see [MUD requirements](mud_requires.md).

## Limits and failures

The shared record limit is measured in serialized UTF-8 bytes before LF, default
1 MiB. Both directions reject whole oversized records; unfinished inbound
records are discarded through the next delimiter. Connection loss resets
framing state. Malformed records do not stop subsequent valid records.

Discord delivery retains at most 256 events / 4 MiB of formatted UTF-8 content,
including in-flight events. MUD writes retain at most 256 writes / 4 MiB of wire
bytes, account for socket buffering, and reject additional writes after
backpressure until drain. A false socket write result is already accepted and
must not be replayed. Failures and shutdown discard pending work; there is no
durable history or exactly-once guarantee. Discord API library behavior is not
a substitute for application delivery bounds.

Reconnects use fixed `mud_retry_delay`, with the existing finite/infinite error
retry policy. Clean closes reconnect as documented in the protocol. SIGINT and
SIGTERM stop listeners/timers/transports; PM2 uses signal shutdown. One active
process per endpoint avoids duplicate relay and competing clients.

## Transport, health and logs

Only literal loopback IPs permit plaintext. Remote/private addresses and
hostnames require certificate-validated TLS. Tokens require TLS even on
loopback. An explicit server name supports IP connections with DNS certificates;
private CAs use `NODE_EXTRA_CA_CERTS`. Never weaken certificate validation.

Health binds to `127.0.0.1` and reports connectivity plus successful-post,
accepted-write and drop counters. Connectivity is not authentication or delivery
proof; accepted writes are not confirmed game receipt. Logs omit relay bodies
and tokens. File logs rotate by size with seven files per transport; PM2 logs
need their own retention policy. No SLA, latency, throughput or memory target is
claimed without a measured deployment workload.

## Validation and deployment

`npm run lint` and `npm run test:coverage` retain minimum coverage thresholds of
95% lines, 90% branches and 85% functions. Generic TCP/TLS tests use a separate
fixture process; native, sample and deployment checks are opt-in. The CI Node
matrix and container job remain in `.github/workflows/test.yml`.
See [testing](testing.md) for exact commands and evidence boundaries.

Use the [deployment guide](deploy.md) for local Node, one PM2 fork instance, and
explicit container loopback/TLS topology. The application does not implement
Discord-to-game command execution, dynamic admin commands, a web dashboard,
database history, or multi-worker delivery coordination.
