#!/bin/sh
# Runs once, on the primary's first start. Lets the replica connect and stream WAL.
set -e

# pg_hba's "all" databases does not cover replication connections; they need their own line.
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '$REPLICATION_PASSWORD';

-- The slot makes the primary keep WAL until the replica has replayed it,
-- so a replica that was stopped for a while can catch up instead of being rebuilt.
SELECT pg_create_physical_replication_slot('replica_1');
SQL
