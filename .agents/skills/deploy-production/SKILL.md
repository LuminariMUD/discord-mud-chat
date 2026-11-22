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
For Compose, take the project, working directory and ordered file list from
the running container's Compose labels. Keep the site's overrides and determine
the effective container user before checking mount permissions.

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
An up-to-date checkout alone does not establish what is deployed. Check the
running image's revision label or compare its packaged files to the release.

## Prepare and validate

Record the running revision or image ID, service settings, and baseline health.

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
  supervisor fixture with `node scripts/check-pm2.js`. Matching CI results for
  the target SHA can supply the lint and coverage checks when the deployment
  host runs the bridge entirely in Docker. See `docs/testing.md`.
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
- For Compose, build a separate candidate from the pulled worktree while the
  running service stays up. Follow **Update an existing Compose deployment**
  in `docs/deploy.md` for the candidate tag and revision label. Test that exact
  image locally with `python3 scripts/test-container.py --image IMAGE_ID`.
  If build steps cannot resolve the registry and the Linux host can, retry
  with `docker-compose.build-host.yml` added only to the build command.

## Switch the single instance

Keep the previous release available and back up configuration or state that
will change in a service-owner-only location outside the checkout. For Compose,
retain a tag for the running image ID before cutover. Use the existing service
name and Compose project/files in the commands below. On a first install with a
Linux host-loopback MUD, use `docker-compose.host.yml` with the base file.

1. Serialize the cutover with other deploys. Verify the live checkout is still
   on `$branch` at `$previous` and check `git status --short` for changes that
   would enter the release or be overwritten. For an update, confirm the service
   still runs the process or container recorded before staging. Stop the bridge
   with `pm2 stop mud-discord-chat`, `docker compose stop mud-discord-chat`, or
   its existing service manager. Wait for the old instance to exit. Queued
   events have no durable replay. On first install, confirm that no other
   bridge owns the endpoint.
2. In the deployment checkout run `git merge --ff-only --no-overwrite-ignore "$target"`.
   Verify `git rev-parse HEAD` equals the tested SHA. Apply required config
   changes while retaining site values.
3. Follow the release's ordering for dependencies, builds, and migrations.
   Verify each migration result. On a partial failure, check which migrations
   committed before retrying.
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
   - **Compose.** Check the protected files and logs mount using the effective
     UID/GID. Run `docker compose config --quiet` and tag the tested candidate ID
     with the live service's resolved image name. Run any pending image-based
     migration using that image and its dedicated command. Start the bridge with
     `docker compose up -d --no-build --pull never --no-deps mud-discord-chat`.
     Use the live project and files and verify the running image ID.

## Verify or recover

Check that the supervisor owns exactly one stable bridge process for the
selected release. Poll a **GET** to `/health` through startup and the configured
reconnect delay, with a bounded deadline. For Node, use
`curl -fsS --max-time 5 "http://127.0.0.1:$port/health"`, setting `port` to
the service's effective `HEALTH_PORT` (default 3000). Under Compose, probe
inside the container.

```sh
docker compose exec -T mud-discord-chat sh -c 'wget -T 5 -qO- "http://127.0.0.1:${HEALTH_PORT:-3000}/health"'
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
recorded supervisor settings. For Compose, retag the retained image under the
restored service's image name and use the same `up` command as cutover. Verify
the restored image ID and health. For a failed first install, leave the service
stopped and report the failing step.

Remove the temporary worktree and build files after use. After a verified
Compose cutover or recovery, remove the candidate tag and retain the rollback
tag. Report the previous and final revision or image ID, migrations applied,
health, and whether the rollout succeeded or needed recovery.
