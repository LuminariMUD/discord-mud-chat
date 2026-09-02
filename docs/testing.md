# Automated Testing

The test suite uses Node.js's built-in test runner. It runs without Discord credentials, a local configuration file, or a live MUD server.

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
