# Automated Testing

The test suite uses Node.js's built-in test runner. It runs without Discord credentials, a local configuration file, or a live MUD server.
It requires `openssl` on PATH to generate temporary certificates for real TLS
tests. Keys and certificates are created in a temporary directory and removed
after the tests; no repository or system trust-store changes are needed.

## Commands

- `npm test` runs all tests.
- `npm run test:coverage` runs all tests and enforces minimum coverage of 95% for lines, 90% for branches, and 85% for functions.
- `npm run lint` checks the application and test code with ESLint.
- `npm audit --audit-level=high` fails on high or critical dependency vulnerabilities.

## Continuous integration

The GitHub Actions workflow in `.github/workflows/test.yml` runs for pull requests, pushes to `main`, and manual dispatches. It validates Node.js 24.18.0 and 26.8.1, then builds the production Docker image after both test jobs pass.

## Coverage

Tests cover:

- Discord-to-MUD and MUD-to-Discord message relay
- Mention and emoji sanitization
- Message guards and per-channel rate limiting
- Authentication, heartbeat, retry, and shutdown behavior
- Health endpoint status and counters
- Configuration token precedence
- Winston console integration
- Runtime dependency composition and signal handling
- Shared JSON wire fixtures, channel direction, and invalid chat schema recovery
- Ordered Unicode-safe Discord chunking, global event/byte queue bounds, failed
  sends, shutdown races, and body-free diagnostics
- Bounded socket writes, drain handling, interrupted-write counts, and no replay
- An independent fixture server process over actual TCP and validated TLS,
  certificate/hostname rejection, auth ordering, Unicode fragmentation,
  malformed/oversized recovery, reconnect, and a peer that stops reading

`test/fixtures/mud-protocol/records.json` is a language-independent corpus for
other peers. `test/discord-delivery.test.js` uses controlled send promises to
verify that later events cannot interleave parts, slow destinations remain
independent, and queued memory stays bounded. Existing bridge assertions await
serial delivery before checking content/counts; no real Discord credentials are
used. Native Duris and full cross-repository checks are tracked in the
[project handoff](ongoing-projects/duris-petition-compatibility.md).

Run the generic network checks alone with
`node --test test/protocol-integration.test.js`. They start
`scripts/testing/protocol-peer.js` in a separate process with no application or
Duris imports. The Node client uses the real transport, relay, and health code
with an in-memory Discord sink. TLS tests add their temporary CA through the
transport's existing test injection seam, retaining `rejectUnauthorized: true`
and real hostname checks. These tests do not establish that an upstream MUD
codebase or the Duris game is integrated; native checks are separate.
