# MUD bridge wire protocol

The Node bridge is a TCP/TLS **client**. The MUD supplies a dedicated JSON
**server** endpoint; a Telnet, GMCP, or WebSocket gameplay port is not that
endpoint. There is no version negotiation or mandatory greeting.

## Framing and chat

Send one UTF-8 JSON object per record, terminated by an actual LF byte (`0x0a`).
Escape newlines inside JSON strings. Records may span socket reads, including
inside a UTF-8 character, and several records may arrive in one read. The bridge
also accepts CRLF and ignores whitespace-only records. It drops malformed JSON
and non-object values, then continues with the next record.

```json
{"channel":"gossip","name":"Ayla","message":"Hello","emoted":0}
{"channel":"Guild/Élite","name":"Zoë","message":"你好 🔥"}
{"channel":"gossip","name":"Ayla","message":"Ayla waves.","emoted":1}
```

`channel`, `name`, and `message` must be strings. Missing or non-string fields
are rejected, including an emote without a string `name`. If present, `emoted`
must be a finite number. Channel names are arbitrary and case-sensitive.
Optional extra fields are tolerated. Only numeric `emoted: 1`
selects emote presentation: send `message` without the author prefix. Ordinary
records display `name: message`. The bridge does not add italics. Every Discord
send disables mention parsing (`allowedMentions: { parse: [] }`).

For MUD-to-Discord traffic, every mapping with the matching `mud` name receives
the record; repeated mappings are not deduplicated. Deliveries are admitted in
configuration order and serialized within each Discord destination. Destinations
drain independently, so send completion order across destinations is not fixed.
For Discord-to-MUD traffic, only the first mapping with the matching `discord`
ID is selected. Discord authors use their nickname or account username; their
stable account ID is used for rate limiting. The wire object has `name`,
`channel`, and `message`, with no required `emoted` field. Configured emoji
stripping applies in this direction. Discord mentions are sanitized.

## Mapping direction

Each `channels` entry can set `direction`:

| Value | MUD to Discord | Discord to MUD |
| --- | --- | --- |
| Omitted or `"both"` | Allowed | Allowed |
| `"mud_to_discord"` | Allowed | Blocked |

```json
{"discord":"STAFF_CHANNEL_ID","mud":"petition","direction":"mud_to_discord"}
```

Unknown values (including `null`, booleans, and misspellings) fail configuration
loading and direct `ChatBridge` construction. A blocked first-match mapping does
not fall through to another mapping. Ignored posts neither write chat nor
consume rate-limit state or increment `discordToMud`. Authentication and
heartbeats still run. MUD fan-out and duplicate mapping semantics are unchanged.
Channel names remain generic; `petition` has no special meaning in this bridge.

## Controls and transport

With `MUD_AUTH_TOKEN` set and `mud_tls: true`, the bridge sends this first after
the TLS connection is established (the example token is synthetic):

```json
{"channel":"auth","name":"bot","message":"fixture-token"}
```

Every 240 seconds while connected, it sends:

```json
{"channel":"heartbeat","name":"bot","message":"ping"}
```

Both objects are followed by LF. No auth acknowledgment or pong is required.
Peers should consume controls separately from chat. Do not map `auth` or
`heartbeat` to Discord destinations: the legacy Node receiver matches channel
names without a separate reserved-channel filter. A chat direction restriction
must still allow outgoing controls.

Plaintext is allowed only to literal loopback addresses (for example,
`127.0.0.1` or `::1`), with no auth token. `localhost` is not a literal address.
Remote endpoints require `mud_tls: true` and certificate validation;
`mud_tls_servername` can select the certificate hostname when connecting by IP.
MUD tokens come only from the environment, never from configuration JSON.
The bridge refuses to send auth on an unencrypted connection.

## Limits, disconnects, and delivery

`mud_max_record_bytes` defaults to 1,048,576 bytes. For valid UTF-8 input the
bridge measures each record before LF, including any trailing CR. The exact
limit is accepted. Oversized complete records are dropped; oversized unfinished
records are discarded through the next LF. Later records remain usable.
Disconnects reset the input buffer and UTF-8 decoder so fragments never cross
connections.

`largest_printable_string` limits incoming Discord content by JavaScript string
length (UTF-16 code units), before sanitization. It is separate from the MUD
wire-byte limit. Neither setting is Discord's per-post content limit.

Discord [limits message content to 2000 characters](https://docs.discord.com/developers/resources/message#create-message).
The bridge formats the author/reply prefix first, then splits the complete text
into at most 2000 UTF-16 code units per post, without splitting a Unicode code
point. Short messages keep their existing formatting. Lone surrogates become
U+FFFD; empty/whitespace-only emotes and whitespace-only chunks do not create
posts. Other content is preserved, including mentions (with parsing disabled on
every part). A later event for the same destination cannot interleave its parts.

The Discord delivery queue admits at most 256 events and 4 MiB of formatted
UTF-8 content globally across destinations. Each mapping delivery is an event;
its full content counts until all parts finish, including while a send is in
flight. Capacity overflow drops the whole new delivery before sending its first
part. A failed send drops remaining parts of that event and continues to the
next event. It never retries an uncertain API send. Shutdown discards pending
events and starts no further sends; already-issued requests may still settle.

Delivery is best effort: no durable queue, record ID, delivery acknowledgment,
or exactly-once guarantee exists. Failed Discord sends are logged, not replayed.
Reconnect attempts use the fixed `mud_retry_delay`, not exponential backoff.
Health reports socket/Discord connection state, not authenticated delivery.
`messages.mudToDiscord` counts resolved Discord send promises (one per successful
part, not per source event); `messages.discordToMud` counts accepted client write
calls, not confirmed game receipt. `droppedMessages.mudToDiscord` counts discarded
delivery events per mapped destination, once per event, including uncertain
in-flight events at shutdown. An event can therefore contribute successful parts
and one drop. Syntax/schema errors and unmapped/unavailable channels are rejected
before admission and do not count as queued delivery drops. Diagnostics omit
message bodies and API request/error objects.

## Implementation status

This document initially freezes the behavior at bridge revision
`ba1682f3e010f5b06be50b9b1d16a1d5c37b1737`. The shared
[fixture corpus](../test/fixtures/mud-protocol/README.md) and bridge tests cover
ordinary and emote records, extensions, arbitrary channels, escaping, Unicode
fragmentation, byte limits, recovery, and mapping order.

The [Duris project](ongoing-projects/duris-petition-compatibility.md) records the
implemented native endpoint and petition/ptell hooks, with PRs and executable
verification. This branch adds chat schema validation and bounded Discord
delivery. Bounded MUD socket writes, complete interoperability, cross-repository
tests, and tested deployment/sample instructions remain separate work.
