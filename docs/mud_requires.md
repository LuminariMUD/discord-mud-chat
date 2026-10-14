# MUD integration requirements

The MUD supplies a dedicated JSON **server** endpoint; Node connects as its
client. A player Telnet/TLS, GMCP, or WebSocket endpoint is a different protocol.
Use the [shared protocol](protocol.md) as the wire contract.

For Duris, use the [native petition guide](duris.md) and
[matching C++20 sample](mud_example/duris/README.md). For other MUDs, use the
[generic Linux/POSIX C89/cJSON sample](mud_example/README.md) with an adapter for
your own channel, permission, rendering and lifecycle rules. The generic harness
is not an upstream LuminariMUD/CircleMUD build or a claim of live compatibility.

## Wire and controls

Send complete UTF-8 JSON objects terminated by LF. TCP reads can fragment inside
UTF-8 characters or contain several records. Escape controls inside JSON; do not
hand-concatenate names/text. Tolerate unknown optional fields for compatibility.

```json
{"channel":"gossip","name":"Ayla","message":"Hello","emoted":0}
{"channel":"auction","name":"Ayla","message":"Ayla raises a hand.","emoted":1}
```

Chat requires string `channel`, `name`, and `message`; optional `emoted` is a
finite number. Numeric 1 means emote presentation, without added italics.
Channel names are arbitrary and case-sensitive; Node's config holds Discord IDs.
Discord ingress has the same strings and does not require `emoted`.

Consume `auth` and `heartbeat` independently of chat. Optional auth is sent first
after validated TLS, and heartbeat `ping` is sent every 240 seconds. Neither
requires an acknowledgment. Never broadcast controls to players. With a token,
reject chat before authentication; do not compare a truncated or NUL-prefixed
secret. Keep tokens in protected environment variables and omit them from logs.

Both sides enforce the configured record byte limit (default 1 MiB before LF).
Accept the exact boundary; discard a whole oversized record, or discard through
LF if it is unfinished, then recover. Malformed JSON/schema must not prevent
later valid records. Reset buffers, decoder/auth state and queued writes on
connection loss. Never concatenate a previous connection's partial record with
a new one.

## Game boundary

Capture each selected, accepted player command once, after its rejection checks
and outside recipient loops. Preserve permission checks, recipient toggles,
echo, logging, GMCP and native visibility. Disabled or overloaded bridge output
must not block or suppress native delivery. Strip game color markup/terminal
controls at this boundary using the game's own parser; preserve valid UTF-8 and
literal `@`, dollars and JSON-sensitive punctuation.

For generic bidirectional chat, implement a narrow adapter for chosen wire
channels such as `gossip`, `auction`, or `gratz`. Apply native recipient policy,
length/rate limits and output escaping. Treat author/content as data, use literal
format strings, and never dispatch it through the command interpreter or a
privileged fake character. Keep adapter output separate from player-command
exports to avoid loops; usernames are not a reliable origin marker.

Node mappings are bidirectional when `direction` is omitted or `both`. Set
`mud_to_discord` for one-way mappings, and enforce the same rule at the MUD
endpoint. The generic sample disables chat callbacks when `on_chat` is NULL.
Duris has no chat callback/dispatcher at all and publishes only accepted
petition/ptell events to its single staff feed.

## Network and lifecycle

Keep plaintext on literal loopback. Remote access requires a valid TLS listener
or a certificate-validated terminator forwarding only to the protected loopback
backend. Node refuses plaintext tokens and remote/private-address plaintext.
Container loopback is a separate namespace unless explicitly shared; see
[deployment](deploy.md).

Use nonblocking sockets, bounded input/output storage, finite per-pulse work,
and partial-write offsets. Count retained whole events during partial sends.
Reject extra clients without replacing the active one. Handle EINTR/EAGAIN/EOF
and errors without busy loops or blocking the game. Check descriptor bounds if
using select; the supplied implementations use poll instead. Drop whole events
on overflow/disconnect, count losses, and do not replay uncertain partial sends.

Mark sockets close-on-exec. Initialize the listener after successful game
copyover and leave it usable if exec fails. Close on ordinary shutdown. Add
lifecycle checks specific to your game; a unit test of close-on-exec alone does
not prove player saves or session recovery.

## Evidence before rollout

Run [generic and native checks](testing.md) appropriate to the chosen sample.
Verify rejected and accepted commands, both selected directions, scope/privacy,
fragmentation and escaping, exact/oversized recovery, slow peers, bounded queues,
reconnect, and successful/failed copyover in an isolated game. Verify the intended
Discord audience during an authorized rollout. Record revisions and distinguish
sample tests, game integration and real Discord checks. Do not infer upstream
compatibility solely from a name in a sample configuration.
