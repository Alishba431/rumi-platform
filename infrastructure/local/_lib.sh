# Shared settings and helpers for infrastructure/local/up.sh and down.sh.
# Sourced, not run. Works with macOS bash 3.2 and Linux bash.

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LOCAL_DIR/../.." && pwd)"

# Every setting can be overridden from the environment.
STATE_DIR="${RUMI_LOCAL_STATE_DIR:-$REPO_ROOT/.local-stack}"
PG_PORT="${RUMI_LOCAL_PG_PORT:-54329}"
PGRST_PORT="${RUMI_LOCAL_POSTGREST_PORT:-54330}"
PROXY_PORT="${RUMI_LOCAL_PROXY_PORT:-54331}"
REDIS_PORT="${RUMI_LOCAL_REDIS_PORT:-63799}"

# The marker that tells down.sh --wipe this directory really is a local stack.
MARKER_NAME=".rumi-local-stack"

# Everything up.sh creates directly in the state dir (bin/ is handled apart:
# it may hold a postgrest copy the user put there). down.sh --wipe deletes
# these and nothing else, so a state dir pointed at the wrong place loses at
# most what the stack wrote into it.
STATE_CHILDREN="pgdata pgsock run logs redis jwt-secret postgrest.conf redis.conf local.env 00_complete-schema.local.sql"

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# Resolve STATE_DIR to an absolute path (creating it only when asked).
resolve_state_dir() {
  if [ "${1:-}" = "create" ]; then
    mkdir -p "$STATE_DIR" || die "cannot create the state dir $STATE_DIR"
  fi
  if [ -d "$STATE_DIR" ]; then
    STATE_DIR="$(cd "$STATE_DIR" && pwd)"
  fi
  PGDATA_DIR="$STATE_DIR/pgdata"
  SOCK_DIR="${RUMI_LOCAL_SOCKET_DIR:-$STATE_DIR/pgsock}"
  RUN_DIR="$STATE_DIR/run"
  LOG_DIR="$STATE_DIR/logs"
  REDIS_DIR="$STATE_DIR/redis"
  SECRET_FILE="$STATE_DIR/jwt-secret"
  PGRST_CONF="$STATE_DIR/postgrest.conf"
  REDIS_CONF="$STATE_DIR/redis.conf"
  ENV_FILE="$STATE_DIR/local.env"
}

# Refuse to adopt a directory that already holds something else. Without
# this, up.sh would drop the marker in e.g. ~/Documents and a later
# down.sh --wipe would trust it. Allowed: a missing or empty dir, one that
# already has the marker, or one holding only bin/ (docs/local-stack.md tells
# people to copy postgrest to <state dir>/bin before the first run).
refuse_foreign_state_dir() {
  local entries
  [ -d "$STATE_DIR" ] || return 0
  [ -f "$STATE_DIR/$MARKER_NAME" ] && return 0
  entries="$(ls -A "$STATE_DIR")"
  if [ -n "$entries" ] && [ "$entries" != "bin" ]; then
    die "$STATE_DIR is not empty and is not a Rumi local stack state dir (no $MARKER_NAME marker).
  Refusing to use it: down.sh --wipe would later delete files in it.
  Point RUMI_LOCAL_STATE_DIR at a new or empty directory, or leave it unset for ./.local-stack."
  fi
}

# Find a directory holding postgres, initdb, pg_ctl and psql (a client-only
# install such as Homebrew libpq has psql/pg_ctl but no server, so it is skipped).
# Order: $PG_BIN, then PATH, then the usual Homebrew / Debian / RHEL locations.
find_pg_bin() {
  local candidates d
  candidates="${PG_BIN:-}"
  if command -v pg_ctl >/dev/null 2>&1; then
    candidates="$candidates:$(dirname "$(command -v pg_ctl)")"
  fi
  for v in 17 16 15; do
    candidates="$candidates:/opt/homebrew/opt/postgresql@$v/bin:/usr/local/opt/postgresql@$v/bin:/usr/lib/postgresql/$v/bin:/usr/pgsql-$v/bin"
  done
  local IFS=':'
  for d in $candidates; do
    if [ -n "$d" ] && [ -x "$d/postgres" ] && [ -x "$d/pg_ctl" ] && [ -x "$d/initdb" ] && [ -x "$d/psql" ]; then
      PG_BIN_DIR="$d"
      return 0
    fi
  done
  return 1
}

# Is the process in this pid file alive, and is it the program we expect?
# (Guards against a stale pid file whose number now belongs to something else.)
pid_is_ours() {
  local pidfile="$1" pattern="$2" pid
  [ -f "$pidfile" ] || return 1
  pid="$(cat "$pidfile" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -q -- "$pattern"
}

# Exit 0 when something already listens on 127.0.0.1:<port>.
port_in_use() {
  node -e '
    const s = require("net").createServer();
    s.once("error", () => process.exit(0));
    s.listen(Number(process.argv[1]), "127.0.0.1", () => s.close(() => process.exit(1)));
  ' "$1"
}

# Wait until an HTTP URL answers with a status below 500 (about 15 s).
wait_http() {
  local url="$1" i=0
  while [ $i -lt 60 ]; do
    if node -e 'fetch(process.argv[1]).then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))' "$url" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}

# Exit 0 when Redis on 127.0.0.1:<port> answers PING with PONG.
redis_ping() {
  node -e '
    const sock = require("net").connect(Number(process.argv[1]), "127.0.0.1");
    let buf = "";
    sock.setTimeout(1000, () => process.exit(1));
    sock.on("connect", () => sock.write("PING\r\n"));
    sock.on("data", (d) => { buf += d; if (buf.includes("\r\n")) process.exit(buf.startsWith("+PONG") ? 0 : 1); });
    sock.on("error", () => process.exit(1));
  ' "$1"
}

# Send SIGTERM to a process we started and wait for it to exit (about 10 s).
stop_pid() {
  local name="$1" pidfile="$2" pattern="$3" pid i=0
  if ! pid_is_ours "$pidfile" "$pattern"; then
    rm -f "$pidfile"
    say "    $name: not running"
    return 0
  fi
  pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 40 ]; do
    sleep 0.25
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    say "    $name: did not stop after 10 s, sending SIGKILL to pid $pid"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
  say "    $name: stopped (pid $pid)"
}
