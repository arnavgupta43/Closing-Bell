#!/bin/sh
# Replica entrypoint. On the first start, copy the primary; after that, just run.
set -e

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Empty data dir: cloning the primary with pg_basebackup"
  # -R writes standby.signal + primary_conninfo, so Postgres starts as a read-only standby.
  # -S streams through the slot the primary created for us.
  pg_basebackup -h pg-primary -U replicator -D "$PGDATA" -R -S replica_1 -X stream -P
  chmod 700 "$PGDATA"
fi

# Hand over to the image's normal entrypoint. It sees an existing data dir and skips initdb.
exec docker-entrypoint.sh postgres
