#!/bin/sh
# Starts a throwaway local PostgreSQL + Redis for Saorsa development without Docker.
# Data lives in .data (git-ignored). Ports avoid clashing with system services.
set -eu
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.data"
PG_PORT="${SAORSA_DEV_PG_PORT:-${NEXCODE_DEV_PG_PORT:-${TEAMOS_DEV_PG_PORT:-55432}}}"
REDIS_PORT="${SAORSA_DEV_REDIS_PORT:-${NEXCODE_DEV_REDIS_PORT:-${TEAMOS_DEV_REDIS_PORT:-56379}}}"
mkdir -p "$DATA"

case "${1:-start}" in
  start)
    if [ ! -f "$DATA/pg/PG_VERSION" ]; then
      initdb -D "$DATA/pg" -U teamos --auth=trust --encoding=UTF8 >/dev/null
    fi
    if ! pg_ctl -D "$DATA/pg" status >/dev/null 2>&1; then
      # TCP only: the repository path may contain spaces and exceed the Unix socket path limit.
      LC_ALL=C pg_ctl -D "$DATA/pg" -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" -l "$DATA/pg.log" -w start >/dev/null
    fi
    for db in teamos teamos_test teamos_e2e; do
      psql -h 127.0.0.1 -p "$PG_PORT" -U teamos -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 \
        || createdb -h 127.0.0.1 -p "$PG_PORT" -U teamos "$db"
    done
    if ! redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
      redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$DATA" --daemonize yes --logfile "$DATA/redis.log" --save "" >/dev/null
    fi
    echo "postgres://teamos@127.0.0.1:$PG_PORT/teamos"
    echo "redis://127.0.0.1:$REDIS_PORT"
    ;;
  stop)
    pg_ctl -D "$DATA/pg" -m fast stop >/dev/null 2>&1 || true
    redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
    echo "stopped"
    ;;
  *)
    echo "usage: $0 [start|stop]" >&2
    exit 1
    ;;
esac
