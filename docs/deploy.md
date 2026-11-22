# Deployment guide

Run one bridge process per MUD endpoint. Select the
[generic integration](mud_requires.md) or [Duris petition feed](duris.md), then
choose a network topology before starting Node. The bot needs outbound Discord
HTTPS/WebSocket access and a dedicated JSON connection to the MUD.

## Local Node

Use the Node LTS version in `.nvmrc` (26.13.1). The Node 24 LTS line is
also supported from 24.22.3. From this repository, install the declared npm
version and the locked dependencies:

```sh
npm install --global "$(node -p 'require("./package.json").packageManager')"
npm ci
cp config/config.example.json config/config.json
cp .env.example .env
```

For Duris use `config/config.duris.example.json`. Set the protected
`DISCORD_TOKEN` and channel **IDs**, and choose the dedicated JSON listener
address/port. Keep local config/environment files out of Git. The
[bot guide](setting_up_discord_bot.md) covers intents and staff-channel access.

Plaintext is allowed only to literal loopback IPs, with `MUD_AUTH_TOKEN` unset.
The local process must share that listener's network namespace. A remote or
private address, or a hostname including `localhost`, requires `mud_tls: true`.
Use a validated TLS listener/terminator and, where needed, `mud_tls_servername`
for the certificate DNS name. `NODE_EXTRA_CA_CERTS` supplies private CA trust at
process startup; do not disable certificate checks. MUD secrets belong only in
`MUD_AUTH_TOKEN`, never in configuration JSON.

```sh
npm run lint
npm run test:coverage
npm start
```

`npm start` logs into Discord and can send real messages; perform a live smoke
test only in the intended channel during rollout. Credential-free local checks
are documented under [testing](testing.md). `npm run dev` uses Node watch mode.

## PM2: one fork instance

The deployment smoke test uses PM2 7.1.2. Install it in your Node toolchain
if needed and run from the repository:

```sh
npm install --global pm2@7.1.2
pm2 start ecosystem.config.js
pm2 show mud-discord-chat
pm2 logs mud-discord-chat --lines 50
```

The supplied config explicitly uses `instances: 1` and `exec_mode: "fork"`.
PM2 sends its normal shutdown signal, which the app handles. The previous
`shutdown_with_message` setting has been removed because the application handles
SIGINT/SIGTERM, not IPC shutdown messages. PM2's
[ecosystem settings](https://pm2.keymetrics.io/docs/usage/application-declaration/)
describe these options.

Do not use `-i max`, scale workers, cluster mode, or a rolling reload for this
feed. Extra instances can duplicate Discord delivery and compete for the native
listener. For an update or rollback, stop the existing process before starting
its replacement. Use named commands so other PM2 applications are unaffected:

```sh
pm2 stop mud-discord-chat
# Update/review the checkout and install its lockfile dependencies while stopped.
npm ci
pm2 restart mud-discord-chat --update-env
```

The template has a daily restart at 04:00 in the host timezone; remove
`cron_restart` if that interruption is unwanted. It is not log rotation.
Winston rotates its own files by size; configure PM2 log retention separately.
To persist this deployment, use `pm2 startup`, review its generated command for
the intended user/host, then `pm2 save`. Do not run those system changes as a test.

`node scripts/check-pm2.js` verifies the template's one-instance startup, restart,
health and graceful stop with a synthetic Discord sink and a temporary PM2 home.
It does not change the operator's PM2 process list or install a startup service.

## Docker: choose the namespace explicitly

The image pins Node 26.13.1 on Alpine 3.24 by digest and installs production
dependencies from the lockfile. Its build context includes only the manifests,
runtime source, and checked-in configuration templates. The image defaults to
UID/GID 1001. Check the effective Compose `user` when a site override is present.
Prepare the read-only config mount and writable logs directory for that user
before starting Compose. No health port is published.

Use the startup examples below for first installs. For a running bridge, follow
[Update an existing Compose deployment](#update-an-existing-compose-deployment).

### Linux host MUD on loopback

Use Docker's [host network mode](https://docs.docker.com/engine/network/drivers/host/)
so container Node can reach the host's `127.0.0.1:8181` listener. This recipe is
for Linux Docker Engine. Health also stays on host loopback; ensure its port is
available. There is no `ports:` mapping in this topology.

```sh
docker compose -f docker-compose.yml -f docker-compose.host.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.host.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.host.yml ps
docker compose -f docker-compose.yml -f docker-compose.host.yml exec mud-discord-chat \
  wget -qO- http://127.0.0.1:3000/health
```

Set `mud_ip: "127.0.0.1"`, `mud_tls: false`, and leave `MUD_AUTH_TOKEN` unset.
Do not replace loopback with a host-gateway/private address using plaintext.
If the MUD itself is in a container, either share its network namespace explicitly
or use its validated TLS endpoint; the host-network recipe alone does not join
another container's private loopback.

### Remote TLS endpoint

Use the default Compose network with a reachable TLS endpoint, `mud_tls: true`,
and a matching trusted certificate. Its `127.0.0.1` is the Node container itself,
so the default local plaintext sample is not a host-MUD configuration.
A TLS terminator on the MUD host must forward only to the protected native
loopback backend. Keep any shared token in both processes' protected environments.

```sh
docker compose config --quiet
docker compose up -d --build
docker compose exec mud-discord-chat wget -qO- http://127.0.0.1:3000/health
```

For a private CA, mount its public certificate read-only into the container and
set `NODE_EXTRA_CA_CERTS` to the **container** path. A host-only path in `.env`
will not work. Keep TLS verification enabled. An HTTPS-intercepting build proxy
can supply its CA through the optional BuildKit secret, without baking it into
image layers:

```sh
docker build --secret id=proxy_ca,src=/path/to/proxy-ca.pem -t mud-discord-chat:local .
```

The ordinary build needs no secret. Preserve your environment's configured
proxy and registry credentials; do not print them for debugging.

For a first install, run `python3 scripts/test-container.py`. It builds
the actual image and uses host networking to connect container Node to an
independent loopback peer outside the container. The real app uses sample config,
a fake Discord sink and a private ephemeral health port; it sends no Discord API
requests. It requires access to the **local** Docker Engine socket. Results and
any environment limitations belong in the project handoff, not in a claim of
live Discord validation.

### Update an existing Compose deployment

Reuse the running container's Compose project, working directory and ordered
configuration files, including any site override. Compose records these as
`com.docker.compose.project`, `com.docker.compose.project.working_dir` and
`com.docker.compose.project.config_files` labels. Record the active container ID,
image ID, configured image name and baseline health. The checkout's Git revision
can be newer than the running image.

Build and test a separate candidate while the current container stays up. Use
the pulled release's copies of tracked Compose files and keep local overrides
in place. Set `--project-directory` to the live checkout so relative site paths
and `.env` still resolve there. In this Bash example, `release` is the pulled
worktree, `scratch` is its temporary parent, and the current directory is the
live checkout. Adjust the project name and file list to match the installation.

```bash
live=$PWD
service=mud-discord-chat
revision=$(git -C "$release" rev-parse HEAD)
candidate="mud-discord-chat:candidate-$revision-$$"
cat > "$scratch/candidate.yml" <<'YAML'
services:
  mud-discord-chat:
    image: ${BRIDGE_CANDIDATE_IMAGE:?}
    build:
      context: ${BRIDGE_RELEASE_DIR:?}
      labels:
        org.opencontainers.image.revision: ${BRIDGE_RELEASE_SHA:?}
YAML

build_compose=(docker compose -p discord --project-directory "$live"
  -f "$release/docker-compose.yml" -f "$live/docker-compose.override.yml")
BRIDGE_CANDIDATE_IMAGE="$candidate" BRIDGE_RELEASE_DIR="$release" BRIDGE_RELEASE_SHA="$revision" \
  "${build_compose[@]}" -f "$scratch/candidate.yml" build "$service"
candidate_id=$(docker image inspect --format '{{.Id}}' "$candidate")
python3 "$release/scripts/test-container.py" --image "$candidate_id"
```

If the builder cannot resolve the npm registry and the Linux host can, add
`-f "$release/docker-compose.build-host.yml"` to the build command. This uses
host networking for build steps. For a standalone smoke build, the equivalent
is `python3 scripts/test-container.py --build-network host`. These options leave
the running service's network and TLS verification intact. On a first install
that needs the override, use it with `docker compose build`, then start the
service with the runtime files and `up -d --no-build --pull never`.

Keep a rollback tag for the old image ID with `docker image tag`. After the
candidate passes, stop just `mud-discord-chat` with the live Compose files and
wait for it to exit. Promote the reviewed checkout and validate the live
configuration with `docker compose config --quiet`.
Find the target image name with `docker compose config --images mud-discord-chat`,
and tag the tested `candidate_id` with that name. Run any pending migrations
using the reviewed release. For image-based migrations, use the tested image.
Then start the service with
`docker compose up -d --no-build --pull never --no-deps mud-discord-chat`.
Use the live project and file list for each of these commands. Verify that
exactly one bridge instance is running, its image ID matches the candidate and
its health check passes. Existing best-effort queued events may be lost on stop.

For rollback, stop the failed replacement, restore any required configuration
and migration state, and tag the retained image with the image name resolved
by the restored Compose configuration. Use the same `up` command and verify the
restored image ID and health. After promotion or recovery, remove the staging
tag with `docker image rm "$candidate"`. Keep the service and rollback tags.

## Health, logs and troubleshooting

Health binds to `127.0.0.1`, defaults to port 3000, and returns 200 only when the
MUD and Discord connections are marked connected; otherwise it returns 503.
`HEALTH_PORT` changes the listener and the Compose probe. It is not proof of MUD
authentication or end delivery. Inspect it from the process's own namespace, or
place authentication/TLS in front of it for remote monitoring.

`messages.mudToDiscord` counts resolved Discord posts, including each split
part; `messages.discordToMud` counts accepted writes, not confirmed game receipt.
`droppedMessages` counts discarded/interrupted work separately. Controls and
posts blocked by direction do not count as chat. Read [protocol](protocol.md)
for exact semantics.

Winston writes console output, `logs/app.log`, and `logs/error.log`. File
transports rotate at 10 MiB with up to seven files each, not seven days.
`LOG_LEVEL` selects verbosity. Do not paste tokens, private petition bodies, or
whole environment dumps into diagnostics.

- **Discord login fails:** check the token and enabled Message Content/Server
  Members intents. Presence is not requested by this application.
- **Channel missing/no posts:** verify IDs, View Channel/Send Messages access,
  mappings, native auth state, and drop counters. For Duris, verify a staff-only
  audience before any real event.
- **MUD connection fails:** verify the dedicated JSON port and namespace. Check
  TLS trust/name/expiry for remote endpoints; a gameplay TLS listener is still
  the wrong protocol.
- **Duplicates:** stop extra processes and duplicate mappings; verify the native
  export hook runs once per accepted command.
- **Unhealthy container:** inspect application logs and its in-container health
  endpoint. Restarting repeatedly does not fix a wrong network namespace.

To roll back, stop the single bridge instance and restore the previous reviewed
checkout/configuration. For Duris, optionally disable its endpoint and restart
through the normal local procedure; native petitions and replies continue. Keep
real Discord verification separate from credential-free tests.
