# Native Duris petition sample

These four `net/discord_*` files are byte-for-byte copies of the production
Duris modules at tested revision
`68c5e7d1beda17ad47a51dc10c3d07d08b8ba11f`. They use Duris's **C++20** build,
cJSON/crypto libraries, character types and ANSI/Unicode utilities. Do not mix
these with the generic C89 sample one directory above.

`integration.patch` contains only the build, lifecycle, accepted-command hooks,
and petition/ptell help changes. It targets Duris base revision
`7156b32431394a12a5a726d1158e1968dd89b3c7`. It includes the formatter corrections
required in the touched `comm.c` file; no complete game files are copied here.
`manifest.json` records both revisions, patch paths, and sample hashes.

Prefer the native reviewed branch/PRs when available; it also carries executable
regression harnesses. To integrate these samples into a clean checkout of the
specified base, from the bridge repository root:

```sh
# Set this to a disposable checkout or your new work branch, not a running tree.
DURIS_CHECKOUT=/path/to/duris
cp docs/mud_example/duris/net/discord_* "$DURIS_CHECKOUT/src/net/"
git -C "$DURIS_CHECKOUT" apply --check "$PWD/docs/mud_example/duris/integration.patch"
git -C "$DURIS_CHECKOUT" apply "$PWD/docs/mud_example/duris/integration.patch"
make -C "$DURIS_CHECKOUT/src"
```

The patch will not apply again to a checkout that already contains the hooks.
Do not force it or insert another call: accepted `do_petition` and `do_ptell`
each export once, outside recipient loops. Poll in the connection phase, flush
in the output phase, initialize on game-loop startup, and shut down only on the
ordinary shutdown path. Close-on-exec recreates the listener after copyover;
failed exec leaves the original endpoint usable.

The endpoint is disabled by default. When enabled it exports only accepted
petitions and staff replies, strips native color/terminal controls, and redacts
concealed names. It consumes auth/heartbeat controls and discards all incoming
chat. Its loopback listener is separate from gameplay ports. Follow the
[Duris operator guide](../../duris.md) for configuration and rollback; the staff
Discord audience is enforced by Discord permissions.

## Check drift and execute the copied modules

Use a checkout containing the native command harness (tested revision above),
with its history available for the base/target patch check:

```sh
python3 scripts/check-duris-sample.py --duris /path/to/duris
SANITIZE=1 python3 scripts/check-duris-sample.py --duris /path/to/duris
```

The checker verifies hashes and compares every copied module to the checkout,
applies the patch to a temporary copy of the recorded base files and compares
its result to the tested revision. It then compiles the **sample copies** with
native headers and exact production command bodies, runs the native regression
harness, and runs the real Node/native integration against that binary. Compiled
artifacts stay under Duris's `bin/tests/` and are removed after the run. No game
state, environment file, production service, or Discord API is touched.

When native modules/hooks change, regenerate the copies and patch from reviewed
commits, update both revisions/hashes, and rerun this check. A matching hash alone
is not a substitute for compiling and exercising the sample. Full isolated game
boot/save/copyover acceptance remains a distinct check in the project handoff.
