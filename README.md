# MUD–Discord Chat Bridge

A Node.js bridge between a MUD's dedicated JSON endpoint and Discord text
channels. Generic mappings are bidirectional by default; individual mappings
can export MUD chat only.

Choose an integration path:

- [Generic MUD integration](docs/mud_requires.md) and the
  [tested C89/cJSON sample](docs/mud_example/README.md).
- [Duris petition feed](docs/duris.md): accepted petitions and staff `ptell`
  replies to one staff-only channel, with game ingress disabled at both ends.
- [Shared wire protocol](docs/protocol.md), [deployment](docs/deploy.md),
  [Discord bot setup](docs/setting_up_discord_bot.md), and [tests](docs/testing.md).

A MUD's name in an example is not evidence that its upstream source was tested.
The generic sample has an independent executable harness; Duris has native
command and cross-repository tests. Verification and remaining acceptance gates
are recorded in the [project handoff](docs/ongoing-projects/duris-petition-compatibility.md).

## Quick start

Use Node >=24.18.0 and npm >=12.0.1 (`.nvmrc` selects the project Node version).
Prepare a bot through the setup guide and a MUD **JSON listener**, separate from
player Telnet/TLS/GMCP/WebSocket ports.

```sh
git clone https://github.com/LuminariMUD/discord-mud-chat.git
cd discord-mud-chat
npm ci
cp config/config.example.json config/config.json
cp .env.example .env
```

For Duris, copy `config/config.duris.example.json` instead. Set `DISCORD_TOKEN`
in the protected environment or `.env`. Edit the connection and Discord channel
IDs in `config/config.json`, then run `npm start`. Use `npm run dev` for Node's
watch mode. Never commit the local config or tokens.

## Configuration

```json
{
  "mud_name": "Your MUD",
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
    { "discord": "GOSSIP_CHANNEL_ID", "mud": "gossip" },
    { "discord": "AUCTION_CHANNEL_ID", "mud": "auction", "direction": "both" }
  ]
}
```

| Setting | Meaning |
| --- | --- |
| `mud_ip`, `mud_port` | Dedicated JSON endpoint, not a player port. |
| `mud_tls` | Certificate-validated TLS; required for non-literal-loopback addresses. |
| `mud_tls_servername` | Certificate DNS name when connecting by IP. |
| `mud_max_record_bytes` | Maximum serialized UTF-8 record bytes before LF, in either direction; default 1 MiB. |
| `mud_retry_delay` | Fixed reconnect delay in milliseconds; no exponential backoff. |
| `mud_retry_count`, `mud_infinite_retries` | Error retry policy; see the exact [protocol behavior](docs/protocol.md). |
| `rate_limit_per_channel` | Discord ingress rate per stable user ID and MUD channel; default 10/s. |
| `strip_emoji` | Strip custom/Unicode emoji from Discord names/content before MUD ingress. |
| `largest_printable_string` | Maximum incoming Discord content length in UTF-16 units before sanitization. |
| `enable_bitly` | Reserved; URL shortening is not implemented. |
| `channels[].direction` | Omitted/`both` permits both directions; `mud_to_discord` blocks Discord chat. Unknown values fail startup. |

Mappings use case-sensitive MUD names and Discord **IDs**. MUD events fan out to
all matching mappings; Discord posts use only the first matching mapping. A
blocked first mapping never falls through. Auth and heartbeat controls still run
in one-way mode. Avoid duplicate mappings unless duplicate posts are intended.

Plaintext is allowed only to literal loopback IPs, with no MUD token. A hostname
such as `localhost`, a private network address, or a remote host requires TLS.
Set the optional token through `MUD_AUTH_TOKEN` only; JSON token fields are
ignored. Private CA trust uses `NODE_EXTRA_CA_CERTS` before Node starts. Never
disable certificate verification. See the deployment guide for containers,
whose loopback is normally separate from the host MUD.

## Delivery and operations

The wire is one UTF-8 JSON object plus LF per record:

```json
{"channel":"gossip","name":"Ayla","message":"Hello","emoted":0}
```

Ordinary Discord content is `name: message`; numeric `emoted: 1` sends only the
message, with no automatic italics. Long output is split at Unicode code-point
boundaries after formatting, and every part disables mention parsing. Discord
ingress sanitizes mass/user mentions and applies stable-user rate limits.

Delivery is bounded and best effort. There is no durable queue or replay across
outages. Successful Discord posts and accepted MUD writes have separate health
counters from drops; none proves game receipt. Read the
[protocol](docs/protocol.md) for byte/count bounds, backpressure, and recovery.

Run **one process** using local Node, PM2 fork mode, or Docker. Do not scale PM2
workers or overlap rolling deployments for one endpoint. The
[deployment guide](docs/deploy.md) covers loopback/TLS topology, stop-before-start
updates, and rollback.

`http://127.0.0.1:3000/health` reports connection state and counters. It is bound
to loopback and unauthenticated; inspect it in the process's network namespace.
`HEALTH_PORT` selects another port. `LOG_LEVEL` controls Winston output.
`logs/app.log` and `logs/error.log` rotate by size (10 MiB, up to seven files
per transport), not by elapsed days. Private bodies and tokens do not belong in
diagnostics or issue reports.

```sh
npm run lint
npm run test:coverage
npm audit --audit-level=high
```

See [testing](docs/testing.md) for sample, native, PM2 and container checks. See
[bridge requirements](docs/bridge_requires.md) for implementation boundaries.

## LuminariMUD ecosystem

- [LuminariMUD game server](https://github.com/LuminariMUD/Luminari-Source)
- [Sage lore and world building](https://github.com/LuminariMUD/sage)
- [Luminari web client](https://github.com/LuminariMUD/luminariweb)
- [InterMUD-3 client](https://github.com/LuminariMUD/Intermud3)
- [Wilderness editor](https://github.com/LuminariMUD/wildeditor)
- [Mudlet interface](https://github.com/LuminariMUD/LuminariGUI)

Issues and pull requests are welcome in this repository. ISC license; see
[LICENSE.txt](LICENSE.txt).
