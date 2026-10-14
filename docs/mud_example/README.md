# MUD integration examples

Choose the implementation that matches your codebase:

- **Duris:** use [duris/](duris/README.md), its native C++20 modules, and the
  petition/ptell hooks. That implementation exports one `petition` feed and has
  no game-chat ingress.
- **Other MUDs:** `discord_bridge.c` and `discord_bridge.h` here are a complete
  Linux/POSIX C89 transport sample. Supply a small adapter for your own channel
  and recipient policy. This is independently tested sample code, **not a build
  or verified patch of upstream LuminariMUD, CircleMUD, or another game**.

The sibling `comm.c`, `act.comm.c`, and `interpreter.c` files are clearly labeled
insertion recipes. They are not replacement game files or compilable upstream
patches. The old incomplete diff fragments, assumed game structs/admin commands,
manual JSON parser, and mismatched fixed buffers have been replaced.

## Build and verify the generic sample

Requirements: a C compiler, Python 3, Linux/POSIX sockets, and the
[cJSON](https://github.com/DaveGamble/cJSON) development library (tested with
1.7.19). cJSON supports ANSI C; this sample does not require C++20. On a Debian
or Ubuntu development machine, install `build-essential libcjson-dev` through
its normal package manager, then from this repository run:

```sh
cc -std=c89 -pedantic -Wall -Wextra -Werror -fsyntax-only docs/mud_example/discord_bridge.c
python3 scripts/test-generic-sample.py
SANITIZE=1 python3 scripts/test-generic-sample.py
```

The runner builds in a temporary directory and starts a separate C fixture
process. Python exchanges real socket records against it. It verifies ordinary
and emote records, arbitrary channels, extensions, UTF-8 fragmentation, escaping,
exact/oversized bounds, parser recovery, auth/heartbeat controls, one-way callback
selection, queue overflow, partial writes, EINTR/EAGAIN/EPIPE, fixed pulse budgets,
one-client policy, reconnect/reset, and shutdown. The echo callback in that test
is a fixture; your game must implement its own delivery adapter.

To link into a game, compile `discord_bridge.c` with your normal C flags and add
`-lcjson` at link time. The public header has no game dependencies. Leave the
endpoint disabled until your game's configuration explicitly calls
`init_discord_bridge`. Call input/output functions once per corresponding game
loop phase. Read the insertion recipes before adding accepted-command hooks.

## Adapter contract and transport

The wire protocol is [shared with the Node bridge](../protocol.md). `channel`
is the arbitrary, case-sensitive **MUD wire name**, such as `gossip`, `auction`,
or `Guild/Élite`; Discord channel IDs belong only in the Node configuration.
There is no mandatory greeting, auth acknowledgment, pong, or version field.
The module copies its optional token at startup. Use a protected environment
variable, never a hard-coded sample token. Empty/unset means no auth.

`on_chat` receives validated strings and an emote flag on the game thread. Its
strings live only until the callback returns. Enforce an explicit channel policy,
rate limits, recipient toggles and output escaping in that callback; never
interpret text as commands. Return 1 when accepted and 0 when rejected. A NULL
callback rejects all incoming chat while consuming auth/heartbeat controls.
The callback may enqueue output, but must not reinitialize, shut down or
recursively process the transport before returning.
Use NULL for a MUD-side one-way policy as well as setting
`direction: "mud_to_discord"` in Node. An omitted Node direction stays
bidirectional for generic peers.

Supply plain UTF-8 when exporting. The module preserves literal `@`, dollars,
quotes and backslashes; cJSON escapes controls inside JSON. Your game owns color
stripping, terminal-control removal, and visibility/redaction. Embedded raw or
decoded NULs are rejected on input because cJSON represents strings as C strings.
No character truncation or partial JSON is used to fit the record limit.

The listener binds **127.0.0.1 only**, accepts one client, and marks both sockets
nonblocking and close-on-exec. Local plaintext must have no Node auth token.
Remote/token use needs a certificate-validated TLS terminator forwarding to this
loopback listener; protect that host/backend boundary. Do not expose this sample
as remote plaintext or disable Node certificate verification.

Limits are 128..1,048,576 UTF-8 bytes per record before LF, 256 queued events,
and 4,194,308 retained wire bytes. The complete front event still counts during
partial writes. Input and output each use at most 32 syscalls / 64 KiB per pulse,
with four accept attempts. Oversized input is discarded through LF and later
records recover. Full/offline/unauthenticated output is dropped whole. Disconnect
and shutdown discard pending data without replay. Never shut the endpoint down
before a copyover exec that might fail; initialize it again after successful exec.

Status counters contain no text or tokens. `sent` means a whole record was handed
to the socket, `received` means the adapter accepted a chat event, `dropped` means
an outgoing event was discarded, and `rejected` counts invalid/disallowed input.
Disabled export calls are no-ops. These counters do not prove Discord delivery.
