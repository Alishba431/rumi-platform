#!/usr/bin/env bash
# =============================================================================
# Stop the Rumi local stack started by infrastructure/local/up.sh.
#
#   bash infrastructure/local/down.sh          stop the proxy, PostgREST, Redis, Postgres
#   bash infrastructure/local/down.sh --wipe   also delete the stack's data (pgdata, logs, keys)
#
# Uses the same RUMI_LOCAL_* settings as up.sh (state dir, ports). Only the
# processes recorded in the state dir are stopped; nothing else is touched.
# =============================================================================

set -eu

# shellcheck source=_lib.sh
. "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

WIPE=0
case "${1:-}" in
  --wipe) WIPE=1 ;;
  -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  '') ;;
  *) die "unknown argument: $1 (try --help)" ;;
esac

resolve_state_dir
if [ ! -d "$STATE_DIR" ]; then
  say "Nothing to stop: $STATE_DIR does not exist."
  exit 0
fi
[ -f "$STATE_DIR/$MARKER_NAME" ] || die "$STATE_DIR is not a Rumi local stack state dir (no $MARKER_NAME marker). Refusing to touch it."

step "Stopping the local stack in $STATE_DIR"
stop_pid "REST proxy" "$RUN_DIR/rest-proxy.pid" rest-proxy.js
stop_pid "PostgREST" "$RUN_DIR/postgrest.pid" postgrest
stop_pid "Redis" "$RUN_DIR/redis.pid" redis-server

if [ -f "$PGDATA_DIR/PG_VERSION" ]; then
  if find_pg_bin && "$PG_BIN_DIR/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    "$PG_BIN_DIR/pg_ctl" -D "$PGDATA_DIR" -m fast -w stop >/dev/null
    say "    Postgres: stopped"
  else
    say "    Postgres: not running"
  fi
fi

if [ "$WIPE" = "1" ]; then
  if [ -f "$PGDATA_DIR/postmaster.pid" ]; then
    die "Postgres still seems to be running ($PGDATA_DIR/postmaster.pid exists); not wiping."
  fi
  # Only what up.sh created (STATE_CHILDREN in _lib.sh), never the whole dir:
  # anything else in it was put there by someone else.
  for child in $STATE_CHILDREN; do
    rm -rf "${STATE_DIR:?}/$child"
  done
  rm -f "$STATE_DIR/bin/postgrest"
  rmdir "$STATE_DIR/bin" 2>/dev/null || true
  rm -f "$STATE_DIR/$MARKER_NAME"
  if rmdir "$STATE_DIR" 2>/dev/null; then
    say "    wiped $STATE_DIR"
  else
    say "    wiped the local stack; left $STATE_DIR in place because it holds files the stack did not create"
  fi
fi
say "Done."
