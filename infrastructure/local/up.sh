#!/usr/bin/env bash
# =============================================================================
# Rumi local stack: Postgres + PostgREST + a /rest/v1 proxy + Redis.
# No Supabase account, no Docker. Local development only, never production.
#
#   bash infrastructure/local/up.sh        start (or re-check) everything
#   bash infrastructure/local/down.sh      stop everything
#   bash infrastructure/local/down.sh --wipe   stop and delete what up.sh created
#
# Settings (environment variables, all optional):
#   RUMI_LOCAL_STATE_DIR       where data, logs and pid files live (default ./.local-stack)
#   RUMI_LOCAL_PG_PORT         Postgres port, unix socket only (default 54329)
#   RUMI_LOCAL_POSTGREST_PORT  PostgREST on 127.0.0.1 (default 54330)
#   RUMI_LOCAL_PROXY_PORT      the SUPABASE_URL port on 127.0.0.1 (default 54331)
#   RUMI_LOCAL_REDIS_PORT      Redis on 127.0.0.1 (default 63799)
#   RUMI_LOCAL_SOCKET_DIR      Postgres socket dir (default <state>/pgsock)
#   PG_BIN                     directory with initdb / pg_ctl / psql
#   POSTGREST_BIN              path to the postgrest binary
#   REDIS_SERVER_BIN           path to redis-server
#
# Safe to run again: anything already running is left alone, and the schema is
# applied only once per state dir. See docs/local-stack.md.
# =============================================================================

set -eu

# shellcheck source=_lib.sh
. "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

case "${1:-}" in
  -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  '') ;;
  *) die "unknown argument: $1 (try --help)" ;;
esac

# ── 0. Tools ─────────────────────────────────────────────────────────────────
step "Checking tools"

command -v node >/dev/null 2>&1 || die "node is not on PATH. Install Node.js 22 or newer (nodejs.org)."

# Before anything is written there (chmod, marker): see _lib.sh.
refuse_foreign_state_dir

find_pg_bin || die "Postgres binaries (initdb, pg_ctl, psql) were not found.
  macOS:  brew install postgresql@17
  Debian/Ubuntu: sudo apt install postgresql-17   (binaries land in /usr/lib/postgresql/17/bin;
                 needs Debian 13 / Ubuntu 25.04+, or the apt.postgresql.org repository on older releases)
  Or set PG_BIN=/path/to/postgres/bin"
PG_MAJOR="$("$PG_BIN_DIR/pg_ctl" --version | sed 's/[^0-9]*\([0-9][0-9]*\).*/\1/')"
say "    Postgres: $PG_BIN_DIR (major version $PG_MAJOR)"
if [ "$PG_MAJOR" -lt 15 ] 2>/dev/null; then
  say "    warning: tested with Postgres 17; version $PG_MAJOR may not apply the schema"
fi

resolve_state_dir create
POSTGREST="${POSTGREST_BIN:-}"
if [ -z "$POSTGREST" ]; then
  if command -v postgrest >/dev/null 2>&1; then
    POSTGREST="$(command -v postgrest)"
  elif [ -x "$STATE_DIR/bin/postgrest" ]; then
    POSTGREST="$STATE_DIR/bin/postgrest"
  fi
fi
if [ -z "$POSTGREST" ] || [ ! -x "$POSTGREST" ]; then
  die "the postgrest binary was not found (looked at \$POSTGREST_BIN, PATH and $STATE_DIR/bin/postgrest).
  macOS:  brew install postgrest
  Any OS: download a release from https://github.com/PostgREST/postgrest/releases
          (one static file: e.g. postgrest-v12.x-macos-aarch64.tar.xz or postgrest-v12.x-linux-static-x86-64.tar.xz),
          unpack it, then put it on PATH or run:  POSTGREST_BIN=/path/to/postgrest bash infrastructure/local/up.sh"
fi
say "    PostgREST: $POSTGREST ($("$POSTGREST" --version 2>/dev/null | head -1))"

REDIS_SERVER="${REDIS_SERVER_BIN:-$(command -v redis-server 2>/dev/null || true)}"
[ -n "$REDIS_SERVER" ] && [ -x "$REDIS_SERVER" ] || die "redis-server was not found.
  macOS:  brew install redis
  Debian/Ubuntu: sudo apt install redis-server
  Or set REDIS_SERVER_BIN=/path/to/redis-server"
say "    Redis: $REDIS_SERVER"

mkdir -p "$SOCK_DIR" "$RUN_DIR" "$LOG_DIR" "$REDIS_DIR"
chmod 700 "$STATE_DIR" "$SOCK_DIR"
touch "$STATE_DIR/$MARKER_NAME"
say "    state dir: $STATE_DIR"

# A unix socket path longer than about 100 bytes fails on macOS.
SOCK_FILE="$SOCK_DIR/.s.PGSQL.$PG_PORT"
if [ "${#SOCK_FILE}" -gt 100 ]; then
  die "the Postgres socket path is too long (${#SOCK_FILE} bytes, the limit is about 100):
  $SOCK_FILE
  Set RUMI_LOCAL_SOCKET_DIR to a shorter directory, e.g. RUMI_LOCAL_SOCKET_DIR=/tmp/rumi-pgsock"
fi

# ── 1. Postgres ──────────────────────────────────────────────────────────────
step "Postgres (unix socket $SOCK_DIR, port $PG_PORT)"

if [ ! -f "$PGDATA_DIR/PG_VERSION" ]; then
  say "    initialising a new data dir"
  "$PG_BIN_DIR/initdb" -D "$PGDATA_DIR" -U postgres --auth=trust -E UTF8 --locale=C \
    >"$LOG_DIR/initdb.log" 2>&1 || die "initdb failed, see $LOG_DIR/initdb.log"
fi

if "$PG_BIN_DIR/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
  RUNNING_PORT="$(sed -n '4p' "$PGDATA_DIR/postmaster.pid" 2>/dev/null || true)"
  if [ -n "$RUNNING_PORT" ] && [ "$RUNNING_PORT" != "$PG_PORT" ]; then
    die "Postgres from this state dir is already running on port $RUNNING_PORT, not $PG_PORT. Run down.sh first."
  fi
  say "    already running"
else
  # TCP is off (listen_addresses=''): only the socket in a 0700 dir accepts
  # connections, which is what makes --auth=trust acceptable here.
  "$PG_BIN_DIR/pg_ctl" -D "$PGDATA_DIR" -w -t 30 -l "$LOG_DIR/postgres.log" \
    -o "-p $PG_PORT -k '$SOCK_DIR' -c listen_addresses=''" start >/dev/null \
    || die "Postgres did not start, see $LOG_DIR/postgres.log"
  say "    started"
fi

psql_q() {
  "$PG_BIN_DIR/psql" -X -q -h "$SOCK_DIR" -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"
}

# ── 2. Schema ────────────────────────────────────────────────────────────────
step "Schema"

psql_q -f "$LOCAL_DIR/supabase-shim.sql" >"$LOG_DIR/shim.log" 2>&1 \
  || die "the Supabase shim failed, see $LOG_DIR/shim.log"
say "    Supabase shim applied (roles, auth.*, exec_sql)"

HAS_USERS="$(psql_q -tAc "select to_regclass('public.users') is not null")"
if [ "$HAS_USERS" = "t" ]; then
  say "    schema already applied (public.users exists), skipping 00/01/02"
else
  SCHEMA_DIR="$REPO_ROOT/infrastructure/supabase"
  SCHEMA_00="$STATE_DIR/00_complete-schema.local.sql"
  HAS_VECTOR="$(psql_q -tAc "select count(*) from pg_extension where extname = 'vector'")"
  if [ "$HAS_VECTOR" = "1" ]; then
    cp "$SCHEMA_DIR/00_complete-schema.sql" "$SCHEMA_00"
    say "    pgvector is installed"
  else
    # pgvector is not installed: comment out its CREATE EXTENSION line. The
    # shim already created a stand-in public.vector type for the one column.
    sed 's/^\(CREATE EXTENSION IF NOT EXISTS "vector"\)/-- [local stack: pgvector not installed] \1/' \
      "$SCHEMA_DIR/00_complete-schema.sql" >"$SCHEMA_00"
    grep -q '^-- \[local stack: pgvector not installed\]' "$SCHEMA_00" \
      || die "could not find the pgvector line in 00_complete-schema.sql; install pgvector or update up.sh"
    say "    pgvector not installed: using the real[] stand-in (no similarity search)"
  fi
  # One transaction for all three files: a failure leaves no half-applied schema.
  psql_q --single-transaction -f "$SCHEMA_00" \
    -f "$SCHEMA_DIR/01_rls-policies.sql" -f "$SCHEMA_DIR/02_seed-data.sql" \
    >"$LOG_DIR/schema.log" 2>&1 || die "applying the schema failed, see $LOG_DIR/schema.log"
  say "    applied 00_complete-schema.sql, 01_rls-policies.sql, 02_seed-data.sql"
fi

psql_q >/dev/null <<'SQL'
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;
-- The shim's default privileges cover tables created after it ran; this
-- covers a state dir whose schema was applied before they existed.
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
SQL
TABLES="$(psql_q -tAc "select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")"
say "    $TABLES tables in public"

# ── 3. JWT secret ────────────────────────────────────────────────────────────
if [ ! -s "$SECRET_FILE" ]; then
  (umask 077 && node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' >"$SECRET_FILE")
fi
chmod 600 "$SECRET_FILE"

# ── 4. PostgREST ─────────────────────────────────────────────────────────────
step "PostgREST (http://127.0.0.1:$PGRST_PORT)"

SOCK_URI="$(printf '%s' "$SOCK_DIR" | sed 's/%/%25/g; s/ /%20/g')"
(umask 077 && cat >"$PGRST_CONF" <<EOF
# Written by infrastructure/local/up.sh; rewritten on every run.
db-uri = "postgres://authenticator@/postgres?host=$SOCK_URI&port=$PG_PORT"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "@$SECRET_FILE"
server-host = "127.0.0.1"
server-port = $PGRST_PORT
EOF
)

if pid_is_ours "$RUN_DIR/postgrest.pid" postgrest; then
  say "    already running (pid $(cat "$RUN_DIR/postgrest.pid"))"
else
  port_in_use "$PGRST_PORT" && die "port $PGRST_PORT is taken by another program. Set RUMI_LOCAL_POSTGREST_PORT to a free port."
  nohup "$POSTGREST" "$PGRST_CONF" >>"$LOG_DIR/postgrest.log" 2>&1 </dev/null &
  echo $! >"$RUN_DIR/postgrest.pid"
  wait_http "http://127.0.0.1:$PGRST_PORT/" || die "PostgREST did not come up, see $LOG_DIR/postgrest.log"
  say "    started (pid $(cat "$RUN_DIR/postgrest.pid"))"
fi

# ── 5. /rest/v1 proxy ────────────────────────────────────────────────────────
step "REST proxy (http://127.0.0.1:$PROXY_PORT/rest/v1 -> PostgREST)"

if pid_is_ours "$RUN_DIR/rest-proxy.pid" rest-proxy.js; then
  say "    already running (pid $(cat "$RUN_DIR/rest-proxy.pid"))"
else
  port_in_use "$PROXY_PORT" && die "port $PROXY_PORT is taken by another program. Set RUMI_LOCAL_PROXY_PORT to a free port."
  nohup node "$LOCAL_DIR/rest-proxy.js" --port "$PROXY_PORT" --target-port "$PGRST_PORT" \
    >>"$LOG_DIR/rest-proxy.log" 2>&1 </dev/null &
  echo $! >"$RUN_DIR/rest-proxy.pid"
  wait_http "http://127.0.0.1:$PROXY_PORT/rest/v1/" || die "the proxy did not come up, see $LOG_DIR/rest-proxy.log"
  say "    started (pid $(cat "$RUN_DIR/rest-proxy.pid"))"
fi

# ── 6. Redis ─────────────────────────────────────────────────────────────────
step "Redis (redis://127.0.0.1:$REDIS_PORT)"

cat >"$REDIS_CONF" <<EOF
# Written by infrastructure/local/up.sh; rewritten on every run.
port $REDIS_PORT
bind 127.0.0.1
daemonize yes
pidfile "$RUN_DIR/redis.pid"
logfile "$LOG_DIR/redis.log"
dir "$REDIS_DIR"
save ""
appendonly no
EOF

if pid_is_ours "$RUN_DIR/redis.pid" redis-server; then
  say "    already running (pid $(cat "$RUN_DIR/redis.pid"))"
else
  port_in_use "$REDIS_PORT" && die "port $REDIS_PORT is taken by another program. Set RUMI_LOCAL_REDIS_PORT to a free port."
  "$REDIS_SERVER" "$REDIS_CONF" || die "redis-server did not start, see $LOG_DIR/redis.log"
  i=0
  until redis_ping "$REDIS_PORT"; do
    i=$((i + 1))
    [ $i -lt 40 ] || die "Redis did not answer PING, see $LOG_DIR/redis.log"
    sleep 0.25
  done
  say "    started (pid $(cat "$RUN_DIR/redis.pid" 2>/dev/null || echo '?'))"
fi

# ── 7. Keys + a real round trip ──────────────────────────────────────────────
step "Keys"

SERVICE_KEY="$(node "$LOCAL_DIR/mint-jwt.js" --secret-file "$SECRET_FILE" --role service_role)"
SUPABASE_URL="http://127.0.0.1:$PROXY_PORT"

node -e '
  const [url, key] = process.argv.slice(1);
  fetch(`${url}/rest/v1/users?select=id&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
    .then(async (r) => {
      if (r.status === 200) process.exit(0);
      console.error(`GET /rest/v1/users answered HTTP ${r.status}: ${await r.text()}`);
      process.exit(1);
    }, (e) => { console.error(e.message); process.exit(1); });
' "$SUPABASE_URL" "$SERVICE_KEY" || die "the service_role key could not read public.users through the proxy"
say "    service_role key minted; GET /rest/v1/users through the proxy: HTTP 200"

(umask 077 && cat >"$ENV_FILE" <<EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY
REDIS_URL=redis://127.0.0.1:$REDIS_PORT
QUEUE_DRIVER=bullmq
# The dashboard and portal talk to Postgres directly (over its socket, no SSL):
SUPABASE_DB_HOST=$SOCK_DIR
SUPABASE_DB_PORT=$PG_PORT
SUPABASE_DB_USER=postgres
SUPABASE_DB_NAME=postgres
SUPABASE_DB_SSL=off
EOF
)

step "Ready. Put these lines in the .env at the repo root (also saved to $ENV_FILE):"
printf '\n'
cat "$ENV_FILE"
printf '\n'
say "Then: node bin/rumi.js doctor"
say "Postgres shell: $PG_BIN_DIR/psql -h '$SOCK_DIR' -p $PG_PORT -U postgres"
say "Stop with: bash infrastructure/local/down.sh   (add --wipe to delete all local data)"
