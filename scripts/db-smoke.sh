#!/bin/sh
# Smoke test: a row written on the primary shows up on the replica, and the replica refuses writes.
# Run from the repo root (Git Bash on Windows): sh scripts/db-smoke.sh
set -e

primary() { docker compose exec -T pg-primary psql -U postgres -d closing_bell -tAc "$1"; }
replica() { docker compose exec -T pg-replica psql -U postgres -d closing_bell -tAc "$1"; }
fail()    { echo "   FAIL: $1"; exit 1; }

echo "1. Replica is in recovery (standby) mode"
[ "$(replica 'SELECT pg_is_in_recovery()')" = "t" ] || fail "replica is not a standby"

echo "2. Primary sees the replica streaming"
primary "SELECT state FROM pg_stat_replication" | grep -q streaming || fail "no streaming replica"

echo "3. Write on primary, read on replica"
primary "INSERT INTO users (id, email, name) VALUES (999999, 'smoke@example.com', 'Smoke Test')" >/dev/null
sleep 1  # async replication: give the replica a moment to replay the WAL
got="$(replica 'SELECT email FROM users WHERE id = 999999')"
primary "DELETE FROM users WHERE id = 999999" >/dev/null
[ "$got" = "smoke@example.com" ] || fail "row did not reach the replica"

echo "4. Replica rejects writes"
replica "INSERT INTO users (id, email, name) VALUES (1, 'x', 'x')" 2>&1 | grep -q "read-only transaction" \
  || fail "replica accepted a write"

echo "All checks passed."
