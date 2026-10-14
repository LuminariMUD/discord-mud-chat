# Duris petition feed

This integration publishes **accepted petitions and staff `ptell` replies** to
one staff-only Discord channel. Discord posts never become game chat or game
commands. Other channels and private tells are outside this integration.
Native permission checks, recipient toggles, echo, logs, and GMCP still run as
before, including when the bridge is disabled, offline, or full.

The Node bridge is a client of a dedicated JSON listener. Do not point it at a
Duris Telnet, TLS gameplay, GMCP, or WebSocket port. The native listener is
optional, disabled by default, and bound only to `127.0.0.1:8181` when enabled.
Use a single Node bridge process for that endpoint.

## Prepare the checkouts

Use a reviewed Duris revision containing the endpoint and both hooks. The
[sample README](mud_example/duris/README.md) records the tested native revision
and offers a small patch plus copied modules for its clean pre-integration base.
It also explains how to verify drift. Do not apply that patch to a checkout
already containing the hooks.

From a local Duris development checkout with its usual dependencies installed:

```sh
make -C src
./scripts/format.sh --check
python3 tests/async/test_discord_bridge_runtime.py
python3 tests/async/test_discord_petition_export.py
```

From the bridge checkout, with Node >=24.18.0, npm >=12.0.1, and OpenSSL installed:

```sh
npm ci
npm run lint
npm run test:coverage
python3 scripts/test-duris.py --duris /path/to/duris
python3 scripts/check-duris-sample.py --duris /path/to/duris
```

The opt-in runners compile under Duris's `bin/tests/`, use synthetic players,
and send to an in-memory Discord sink. They require no real account/token and
change no running service. They verify the production command boundary;
full-game/save/copyover evidence is tracked separately in the
[implementation handoff](ongoing-projects/duris-petition-compatibility.md).

## Staff channel and local configuration

Create a dedicated text channel with View Channel denied to `@everyone` and
allowed only for the intended staff roles and the bot. Review all role/member
overrides: another role can grant access. Give the bot View Channel, Send
Messages and Read Message History; Administrator is unnecessary. Test visibility
using an ordinary non-staff account and the intended staff roles before rollout.
Follow the [bot setup guide](setting_up_discord_bot.md) for the application and
intents. Channel privacy determines the audience; both the mapping direction
and native endpoint independently block incoming game chat.

From the bridge repository root, when preparing the deployment configuration:

```sh
cp config/config.duris.example.json config/config.json
cp .env.example .env
```

Replace `STAFF_PETITION_CHANNEL_ID` with the staff channel's ID. Keep exactly
one mapping, with `mud: "petition"` and `direction: "mud_to_discord"`. Set the
bot token as `DISCORD_TOKEN` in the protected environment. For this same-host
plaintext example, leave `MUD_AUTH_TOKEN` unset; tokens require TLS in Node.
Do not store tokens in `config/config.json`.

In the environment of the **isolated/local Duris process being tested**, set:

```sh
export DURIS_DISCORD_ENABLED=TRUE
export DURIS_DISCORD_PORT=8181
export DURIS_DISCORD_MAX_RECORD_BYTES=1048576
unset DURIS_DISCORD_AUTH_TOKEN
```

Start/restart that process through the checkout's normal local procedure, then
run `npm start` in the bridge checkout when a real Discord rollout is intended.
Invalid native settings or a port conflict close this optional listener and log
a startup warning without stopping gameplay. Authentication is unnecessary for
same-host plaintext; the loopback boundary is its trust boundary.

## Remote TLS and containers

For a remote Node host, terminate TLS on the Duris host and forward only to
`127.0.0.1:8181`. Use a certificate trusted by Node, configure `mud_tls: true`,
and set `mud_tls_servername` to the certificate's DNS name when connecting by
IP. A private CA can be supplied through `NODE_EXTRA_CA_CERTS` before Node starts.
Never disable certificate verification. Set the same protected shared token as
`DURIS_DISCORD_AUTH_TOKEN` for Duris and `MUD_AUTH_TOKEN` for Node; the token
crosses the local plaintext backend, so secure that host and terminator.

`127.0.0.1` inside a normal Docker container is the container, not the host MUD.
Use a shared network namespace for local plaintext, or connect to the remote
validated TLS endpoint. Follow the explicit topology in the
[deployment guide](deploy.md); do not substitute a host-gateway/private address
with `mud_tls: false`. Health remains loopback-only in the Node process's network
namespace. PM2 must run one fork-mode instance, with no overlapping workers.

## Verify delivery and interpret health

During the requested staff-channel rollout, submit one accepted in-game
petition and one authorized staff `ptell` reply. Expected content is:

```text
Player: I need help with a stuck character.
Staff -> Player: I am checking that now.
```

A concealed staff sender is `Someone -> Player`; concealed target names are also
redacted. Duris markup and terminal controls are removed, while literal dollars,
quotes, backslashes, `@` and valid Unicode survive. Long events split into
ordered Discord posts of at most 2000 UTF-16 units, with mention parsing disabled
on every part. A short event produces one post per accepted command, regardless
of staff recipient count or player echo. In-game petition/ptell help discloses
the optional staff feed.

An ordinary post in this Discord channel must produce no game output, no chat
write, and no increase in `messages.discordToMud`. Heartbeat controls remain
normal and do not count as chat. Rejected petitions and unrelated game channels
must not produce feed posts.

Inspect `http://127.0.0.1:3000/health` from the Node host/network namespace.
`connections.mud` means the socket is connected, not that Duris authenticated it
or Discord received content. `messages.mudToDiscord` counts successful Discord
posts, so a split event increments it multiple times. `droppedMessages` contains
incomplete deliveries separately. Native minute-level diagnostics report socket,
auth, queue, sent/drop/rejection counts without bodies or tokens. See
[protocol semantics](protocol.md) for all limits and counter definitions.

## Outages, copyover, rollback and troubleshooting

Delivery is bounded and best effort. Duris queues at most 256 events / 4,194,308
wire bytes. Offline, unauthenticated, oversized, and overflow events are dropped
whole. Node separately bounds pending Discord delivery. Neither side has durable
history or replays uncertain partial sends after reconnect. Native petitions and
replies continue through these failures.

A successful game copyover closes the bridge sockets on exec, recreates the
listener, and lets Node reconnect. A failed exec leaves the old listener usable.
Ordinary shutdown closes it. The project's full-game lifecycle acceptance gate
must pass in an isolated server before relying on deployment-level copyover.

To roll back delivery, stop the single Node process. To disable the native
endpoint as well, unset `DURIS_DISCORD_ENABLED` or set it to `FALSE`, then restart
through the normal local procedure. Configuration is read on initialization,
not hot-reloaded by editing a file. Native petition/ptell operation continues.
Restart with the feature disabled and repeat a local petition/reply check.

- **No socket connection:** check enabled settings, port conflicts, and that
  Node shares the listener's loopback namespace or uses its TLS terminator.
- **TLS failure:** check CA trust, certificate expiry/name and the configured
  server name. A gameplay TLS port is still the wrong endpoint.
- **Connected but no posts:** check native authentication state, the single
  `petition` mapping, cached channel access, bot permissions and drop counters.
  Health connectivity alone does not prove delivery.
- **Duplicate posts:** stop extra Node instances and duplicate mappings; do not
  add export hooks inside recipient loops.
- **Unexpected game behavior:** disable the optional feed and preserve normal
  native delivery while diagnosing. Capture count-only diagnostics and sanitized
  configuration; never paste tokens or private petition bodies into logs/issues.
