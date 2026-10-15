# Duris staff Discord feed: names replaced with Someone

Date: 2026-10-15.
Status: correction implemented and locally verified in both repositories;
review and live rollout remain open (2026-10-15).
Scope: fix the native server at `/home/staging/duris`, synchronize the bridge's
sample/tests/docs, and verify the requirements in both project documents.

## Correction progress

- [x] Replace native export redaction with real sender and target names.
- [x] Expand native and Node regressions and full-game acceptance.
- [x] Update native help/operator docs and the copied sample with provenance.
- [x] Run native build/format, relevant regressions, sample and bridge checks.
- [x] Reconcile the compatibility plan and inspect deployment/audience evidence.
- [ ] Complete review and production rollout, then verify corrected live events.

The native fix is commit `e3c72ff54e6bd8412b4af2c77b999ef3125167fd`,
[Duris PR #102](https://github.com/LuminariMUD/Duris/pull/102). It removes
`public_name()` and the non-trusted reply-sender substitution, using
`GET_NAME(sender)` and `GET_NAME(target)` through the existing bounded
`plain_text()` conversion. Native command authorization and recipient visibility
are unchanged. The bridge's copied modules, help patch and operator guide now
carry the same behavior; the Node relay itself needed no change.

Verification passed in the current worktrees: native build/format, command/Node
integration and copied-sample checks both normally and with ASan/UBSan, and the
isolated full-game journey through save/reload, failed/successful copyover,
disconnect, disabled endpoint and shutdown. The native matrix covers five
concealment affects on ordinary/staff petitioners and reply sender/target/both
combinations, wizard invisibility and mortal fog. Node checks hidden-player
petitions and replies with both participants hidden. Full-game assertions keep
`Someone` for the in-game player's hidden-staff reply and require the actual
staff name in Discord. The original source would fail these name assertions.

All 112 bridge coverage tests pass on Node 24.18.0, 26.8.1 and 26.11.1; native
privacy/output/lifecycle/help checks, generic sample sanitizer checks, PM2 and
container smoke tests also pass. See the
[current compatibility handoff](duris-petition-compatibility.md#current-handoff-2026-10-15)
for commands, coverage, sample provenance and read-only deployment evidence.

The audience was inspected using Discord's API without sending messages.
`@everyone` is denied, the bot can view/send, and the owner confirmed Morfos's
explicit member access is intended. Administrator roles (including bots) retain
their Discord-wide access. No permission change is needed for the confirmed
intended audience. The existing live listener and bridge are connected, but
the running native binary has not been updated by this work. Native `AGENTS.md`
requires owner permission for production operational actions; live smoke-test
messages have not been sent. That rollout gate remains explicit.

The investigation below records the original behavior and its evidence; it is
not a description of the corrected exporter.

## Original finding

The speaker was **Pane**. The native petition and chat logs both contain the
exact reported text with that name. The original Duris exporter deliberately removed the name in its
Discord export when the character has a concealment flag; the Node bridge
receives the already-redacted name and displays it unchanged.

This is a requirements error in the original integration. The owner has
confirmed that the destination is private to staff and that names must always
be included. That requirement applies to petitioners, staff reply senders, and
reply targets, regardless of in-game concealment. Character names here mean
the native `GET_NAME(character)`, not account names or Discord usernames.

The earlier plan explicitly required concealed identities to remain concealed
in Discord. That decision is superseded by the owner's requirement above.
Existing passing tests encode the old decision and therefore do not establish
correctness for this requirement.

## Incident evidence

Reported Discord content, displayed at 2:51 AM:

```text
mud_chat: Someone: could use skills and epic skills real quick
```

The matching native records are:

```text
/home/staging/duris/logs/log/petition:2
Wed Oct 14 23:51:09 2026::(Pane) petitioned (could use skills and epic skills real quick).

/home/staging/duris/logs/log/chat:39
Wed Oct 14 23:51:09 2026::Pane petitioned 'could use skills and epic skills real quick'
```

Those timestamps are quoted as stored. They have no timezone suffix; the
Discord excerpt has no date or timezone. The three-hour clock difference is
consistent with a viewer timezone difference but was not independently
verified. The exact text match identifies the native event as a petition,
rather than a `ptell` reply.

The local bridge configuration maps only `petition` to its Discord destination,
with `direction: "mud_to_discord"`, and connects to `127.0.0.1:8183`.
`logs/app.log` records login as `mud_chat#3260`, discovery of `#petition`, and a
successful Duris connection at `2026-10-14T17:48:25.943Z`. The staff-only audience
is the owner's stated configuration; Discord role/channel permissions were not
independently fetched during this investigation.

The log records retain the real name but do not record the character's effects
at the time of this petition. No historical wire capture was available. We can
identify the sender and reproduce the redaction mechanism, but cannot establish
which concealment flag Pane had at that moment. Current player state would not
prove historical state.

## Where the original exporter lost the name

Inspected revisions:

- Bridge: `799afaf86e426b1a1b840faad07ff5e8d36e84a1`.
- Native Duris: `8dc2249dc72beff33ecdab880f28d1c7439a824f`.

Both worktrees were clean before this documentation change. The bridge's copied
[native exporter](../mud_example/duris/net/discord_petition.c) and
`/home/staging/duris/src/net/discord_petition.c` are byte-identical, SHA-256
`b148fa15f95d1b1806578017408f07f7f1c443575549e3c6cf911326be549f92`.
These are source observations, not an attestation of the running game's build.

1. Native `src/cmd/actcomm.c:282` calls
   `discord_petition_export(ch, argument)` once for an accepted petition.
   The exporter receives the real character pointer. Native audit lines at
   297-299 and staff GMCP at 328 use `GET_NAME(ch)` independently.
2. Native `src/net/discord_petition.c:16-23` defines `public_name()`. It returns
   the literal `"Someone"` for any of the states in the table below. The affect
   checks apply to ordinary players as well as staff.
3. The same file at 106-109 selects that name before text conversion. Reply
   senders also have a separate `target && !IS_TRUSTED(sender)` redaction, and
   reply targets pass through `public_name(target)`.
4. At 114-120 the exporter constructs a reply's `sender -> target` label and
   publishes the already-redacted name. The JSON record has no alternate field
   retaining the original name.
5. [src/bridge.js:247-250](../../src/bridge.js) formats ordinary messages as
   `${messageData.name}: ${messageData.message}`.
   [src/discord-delivery.js](../../src/discord-delivery.js) splits and sends that
   content with mention parsing disabled. Neither substitutes `Someone`.

| Condition | Original effect on the exported name |
| --- | --- |
| `IS_TRUSTED(character)` and `GET_WIZINVIS(character) > 0` | Petitioner, reply sender, or reply target becomes `Someone`. |
| `AFF_INVISIBLE` | Same, including ordinary players. |
| `AFF_HIDE` | Same, including ordinary players. |
| `AFF_WRAITHFORM` | Same, including ordinary players. |
| `AFF2_CONCEALMENT` | Same, including ordinary players. |
| `AFF3_ECTOPLASMIC_FORM` | Same, including ordinary players. |
| A reply sender for whom `IS_TRUSTED(sender)` is false | Reply sender becomes `Someone`, independently of the above flags; this includes staff using mortal fog. |

Thus ordinary petitions can become `Someone: ...`; replies can become
`Someone -> Player: ...`, `Staff -> Someone: ...`, or
`Someone -> Someone: ...`. The real character name is available before export:
native `src/core/utils.h:399` defines `GET_NAME(ch)` as `ch->player.name`.

Changing the bot's Discord permissions, nickname, or channel mapping cannot
recover a name already removed by the native exporter. There is no current
configuration switch to disable this redaction.

## Why the original implementation and tests allowed it

The [original implementation plan](duris-petition-compatibility.md) used to say to
"preserve concealed identities in the feed" and requires a hidden staff sender
to appear as `Someone -> Player`. The native exporter comment explains its
assumption: Discord has no in-game observer privilege. Native
`docs/network/DISCORD_BRIDGE.md:36-44` expands that assumption to concealed
players and targets, and to staff using mortal fog.

The behavior entered native Duris in commit
`3a9045d2d10b9cbf6b5bcb2e99220aeb2c09da29` (PR #84, accepted petition exports).
It was copied into this repository's integration sample and described in the
[operator guide](../duris.md), [sample README](../mud_example/duris/README.md),
and [help integration patch](../mud_example/duris/integration.patch).

The native privacy decision, `docs/adr/0003-player-privacy-chat-snoop-addresses.md`,
explicitly permits petitions and staff actions to be audited. It does not
require concealing their character names from the staff feed. Existing native
petition and reply audit calls already include those names. The implementation
applied player-facing visibility assumptions to this separate staff audience.

At investigation time, tests actively required redaction:

- Native `tests/async/discord_petition_export_harness.cpp:316-346` expects
  `Someone` for concealed staff petitions/replies, mortal-fog replies, and a
  concealed reply target.
- [scripts/testing/duris-integration.js:131-134](../../scripts/testing/duris-integration.js)
  expects `Someone -> Player: Hidden staff reply` at the Node delivery boundary.
- Native `tests/async/test_discord_game_journey.py:174-180` expects a hidden staff
  reply to be anonymous both to the in-game player and to the Discord sink.
  Those two audience expectations must be separated in the correction.

## Original investigation verification

The existing native/Node integration passed on the inspected worktrees:

```sh
python3 scripts/test-duris.py --duris /home/staging/duris
```

It compiled the real exporter and exact production petition/ptell command
bodies, exercised native socket delivery, and ran the Node bridge with an
in-memory Discord destination. Its existing concealment assertions passed,
confirming the current unwanted behavior rather than proving a fix.

A second, temporary extension of that same native harness used an ordinary
level-10 synthetic character named `Probeplayer`. With no concealment, the wire
name was `Probeplayer`. Setting each of `AFF_INVISIBLE`, `AFF_HIDE`,
`AFF_WRAITHFORM`, `AFF2_CONCEALMENT`, and `AFF3_ECTOPLASMIC_FORM` separately
produced `Someone` for a petition containing the reported text. In every case,
the native petition audit and staff GMCP retained `Probeplayer`. All assertions
passed. The probe and binary were created under Duris `bin/tests/` and removed
after execution; native source and player data were unchanged.

No live Discord messages were sent, no live bridge connection was displaced,
and no service was restarted. The tests used isolated native endpoints and a
mock Discord destination. No full-game journey was rerun for this investigation.

## Correction requirements and acceptance criteria

Items 1-4 and the local checks in item 5 are complete. Live rollout in item 5
remains open. The implementation follows these requirements:

1. Use `GET_NAME(sender)` and, for replies, `GET_NAME(target)` as the inputs to
   the existing bounded `plain_text()` conversion. Remove `public_name()` and
   the separate non-trusted reply-sender substitution. No new visibility option
   is needed for this staff-only feed.
2. Preserve accepted-command checks, native per-recipient output, GMCP, audit
   logging, text/control sanitization, bounds, one-way delivery, and endpoint
   behavior. In-game players may still see a concealed staff member as
   `Someone`; the staff Discord feed must carry the actual character name.
3. Change the native harness, Node integration driver, and full-game journey
   assertions to require real names in exported petitions and both reply
   positions. Cover ordinary concealed petitioners as well as trusted staff,
   wizard invisibility, every listed affect, mortal-fog replies, and both reply
   participants concealed together. Retain the native player's existing
   concealed-reply expectation.
4. Update the native operator documentation and help entries, then refresh this
   repository's copied native module, integration patch, tested revision/hashes
   in the sample manifest, sample README, and operator guide. The original plan
   remains historical evidence; this report records the superseding requirement.
5. Verify the focused native regression, cross-repository Node integration,
   copied-sample checks, and isolated full-game journey; run the native build
   and formatting checks for the C++ change. On rollout, verify an accepted
   concealed petition and concealed staff reply in the staff channel, with
   real sender and target names and existing game behavior preserved.

For the reported event, the intended Discord content is:

```text
Pane: could use skills and epic skills real quick
```

Fixing export will affect future events. The existing Discord post cannot
recover the original name from its payload; this incident can be attributed
only because the native audit record retained it. Historical message editing
or reposting is outside this investigation.
