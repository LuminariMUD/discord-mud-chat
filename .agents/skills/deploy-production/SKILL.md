---
name: deploy-production
description: Deploy or update this MUD-to-Discord bridge in production, including release migrations, single-instance cutover, health checks, and recovery.
---

# Deploy the production bridge

Run the deployment through verification when invoked for a rollout. Work as the
bridge service owner on the intended host. Identify the deployment checkout,
branch, and supervisor from the request and running service. On a first install,
use the requested topology or the repository's single-fork PM2 configuration
for a local Node host. Resolve an ambiguous production target before changing it.

## Pull the release

Start with `git pull --ff-only` from the deployment branch's configured upstream.
For an in-place installation, pull in a temporary worktree so updating code or
dependencies cannot disturb the running bridge. From the deployment checkout,
use the following shell sequence, stopping on any failure. Retain the paths and
SHAs for the remaining steps.

```sh
set -e
previous=$(git rev-parse HEAD)
branch=$(git symbolic-ref --short HEAD)
remote=$(git config --get "branch.$branch.remote")
ref=$(git config --get "branch.$branch.merge")
scratch=$(mktemp -d)
release="$scratch/release"
git worktree add --detach "$release" "$previous"
git -C "$release" pull --ff-only "$remote" "$ref"
target=$(git -C "$release" rev-parse HEAD)
test "$target" = "$(git -C "$release" rev-parse FETCH_HEAD)"
git diff --name-status "$previous" "$target"
```

An ahead-only checkout can report a successful pull. The SHA check above
catches that case. Preserve local changes if the checkout has diverged or
tracked deployment files have local edits. Resolve the discrepancy before
cutover. If the intended release is already running and healthy, check for
pending configuration or migrations before deciding whether a restart is needed.

## Prepare and validate

- Read `docs/deploy.md`, `package.json`, and the changed files **in the pulled
  release**. Inspect release notes, config examples, scripts, and the Dockerfile
  or ecosystem file for changed prerequisites, build steps, and migrations.
  The bridge runs JavaScript directly. When enabling Discord news, follow
  `docs/discord-news.md` and apply `config/news-delivery.sql` to the dedicated
  MariaDB database as its schema owner before enabling intake or delivery.
  Ordinary chat and petition deployments do not require this database.
  For other migrations, establish prerequisites, pending versions, backup,
  recovery, and execution order. Keep production migrations for cutover.
- For Node, select or install the toolchain from `.nvmrc` and `packageManager`
  using the host's version manager. Verify `node --version` and `npm --version`
  against `engines`. In the candidate,
  run `npm ci --include=dev`, any required build, `npm run lint`, and
  `npm run test:coverage`. The tests use OpenSSL. For PM2, exercise the isolated
  supervisor fixture with `node scripts/check-pm2.js`. For Compose, verify
  the production image with `python3 scripts/test-container.py` on a local
  Linux Docker Engine. Matching CI results for the target SHA can supply
  checks that require tooling outside the deployment host. See `docs/testing.md`.
- Preserve the operator's protected `.env`, `config/config.json`, channel
  mappings, and CA mounts. On first install, initialize missing files from
  `.env.example` and the generic or Duris config example. Provision the actual
  token, channel IDs, and dedicated JSON endpoint before startup. Plaintext
  requires a literal loopback IP in the same network namespace and an unset
  `MUD_AUTH_TOKEN`. Remote endpoints require validated TLS. For Duris, verify
  the staff-only destination and the one-way `petition` mapping in `docs/duris.md`.
  A local `MUD_SERVER_PATH` can identify the peer for compatibility checks.
  Apply a native change only when the release requires it and the game rollout
  is in scope. Keep tokens and private message bodies out of output.

## Switch the single instance

Record the running revision or image ID, service settings, and baseline health.
Keep the previous release available and back up configuration or state that
will change in a service-owner-only location outside the checkout. For Compose,
retain a usable tag for the previous image before rebuilding. In the commands
below, use the existing service name and Compose project/files for this endpoint.
For Linux host loopback, include `-f docker-compose.yml -f docker-compose.host.yml`.
The base file alone is for a reachable TLS endpoint.

1. Serialize the cutover with other deploys. Verify the live checkout is still
   on `$branch` at `$previous` and check `git status --short` for changes that
   would enter the release or be overwritten. For an update, stop the bridge
   with `pm2 stop mud-discord-chat`, `docker compose stop mud-discord-chat`, or
   its existing service manager. Wait for the old instance to exit. Queued
   events have no durable replay. On first install, confirm that no other
   bridge owns the endpoint.
2. In the deployment checkout run `git merge --ff-only --no-overwrite-ignore "$target"`.
   Verify `git rev-parse HEAD` equals the tested SHA. Apply required config
   changes while retaining site values.
3. Install, build, migrate, and start using the active supervisor. Follow the
   release's ordering for any migrations and verify each result. On a partial
   failure, check which migrations committed before retrying.
   - **PM2 or supervised Node.** Run `npm ci` in the deployment checkout
     (include dev dependencies for any build that requires them) and build
     there if needed. Apply any pending migrations. For the supplied PM2
     declaration, run `pm2 startOrRestart ecosystem.config.js --only mud-discord-chat --update-env`
     under the service account with its intended environment and PM2 home.
     PM2 merges environment variables on restart. If an update or rollback
     removes a variable from PM2's environment, delete only the stopped bridge
     entry (`pm2 delete mud-discord-chat`) and recreate it from its recorded
     declaration in the corrected service environment with
     `pm2 start ecosystem.config.js --only mud-discord-chat`.
     Preserve site-specific supervisor settings and verify one fork.
     For another Node service, start its existing unit with
     the same working directory, environment, and `npm start` or Node entrypoint.
   - **Compose.** Check the protected files and the logs mount permissions for
     container UID/GID 1001. Run `docker compose config --quiet`, then
     `docker compose build mud-discord-chat`. The Dockerfile installs locked
     production dependencies. Run any image-based migration using its dedicated
     command before `docker compose up -d --no-deps mud-discord-chat`.
     Include the selected project and file options on every Compose command.

## Verify or recover

Check that the supervisor owns exactly one stable bridge process for the
selected release. Poll a **GET** to `/health` through startup and the configured
reconnect delay, with a bounded deadline. For Node, use
`curl -fsS --max-time 5 "http://127.0.0.1:$port/health"`, setting `port` to
the service's effective `HEALTH_PORT` (default 3000). Under Compose, probe
inside the container.

```sh
docker compose exec -T mud-discord-chat sh -c 'wget -qO- "http://127.0.0.1:${HEALTH_PORT:-3000}/health"'
```

Require HTTP 200 with both `connections.mud` and `connections.discord` true.
Inspect restart and drop counters and recent sanitized errors. Report live
delivery only if observed. When the user requests a live smoke message, use the
intended destination and mapping direction. A Duris feed is outbound only.
For a first PM2 deployment that must survive reboot, use the host's startup
service and save the verified process list as the deployment user. Follow the
`pm2 startup` procedure in `docs/deploy.md` if that service needs provisioning.

If an update fails after the old instance has stopped, stop any replacement.
If `$previous` was the running release and the branch still points to `$target`,
check for conflicting local changes and use `git reset --keep "$previous"` on
the deployment branch. Restore the matching config and follow
the migration's recovery procedure before starting older code against changed
state. For a Discord news rollback, turn off Duris submission before closing
intake, disable both `news.enabled` and `news.send`, and retain the database.
If recovery requires a destructive restore without authorization, keep
the writer stopped and report the recovery point. For Node, rerun the prior
release's locked install and build as applicable and start it with the
recorded supervisor settings. For Compose, select the retained image and run
`docker compose up -d --no-build --no-deps mud-discord-chat`. Verify the recovered
instance with the same health checks. For a failed first install, leave the
service stopped and report the failing step.

Clean up with `git worktree remove "$release"` and `rmdir "$scratch"` after use.
Report the previous and final revision, migrations applied, supervisor, health,
and whether the rollout succeeded, rolled back, or still needs intervention.
