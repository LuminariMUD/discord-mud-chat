#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
fixture=$(mktemp -d)
pid=""
cleanup() {
    if [[ -n "$pid" ]]; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    rm -rf -- "$fixture"
}
trap cleanup EXIT

mariadb-install-db --no-defaults --datadir="$fixture/data" \
    --auth-root-authentication-method=normal --skip-test-db > "$fixture/setup.log" 2>&1 || {
    cat "$fixture/setup.log" >&2
    exit 1
}
mariadbd --no-defaults --user="$(id -un)" --datadir="$fixture/data" --skip-networking \
    --socket="$fixture/db.sock" --pid-file="$fixture/db.pid" --log-error="$fixture/server.log" &
pid=$!
db=(mariadb --no-defaults --user=root --socket="$fixture/db.sock")
for ((attempt = 0; attempt < 100; attempt++)); do
    if "${db[@]}" -e 'CREATE DATABASE discord_news_test' 2>/dev/null; then break; fi
    sleep 0.1
done
"${db[@]}" discord_news_test < config/news-delivery.sql || {
    cat "$fixture/server.log" >&2
    exit 1
}
export TEST_NEWS_DB_SOCKET="$fixture/db.sock"
if (( $# )); then
    "$@"
else
    node --test test/news-*.test.js
fi
