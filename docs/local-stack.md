# Run Rumi on a laptop (no Supabase account, no Docker)

Rumi talks to its database through Supabase's REST API, and to Redis for sessions and background
jobs. The local stack gives you both on your own machine, from plain programs:

```
bash infrastructure/local/up.sh          start everything, print the .env lines
bash infrastructure/local/down.sh        stop everything
bash infrastructure/local/down.sh --wipe stop, then delete all local data
```

It is for development, demos and testing. It is not for production: there are no backups, the
database trusts every local connection, and only part of Supabase is emulated (see [Limits](#limits)).

---

## What you need

| Tool | macOS (Homebrew) | Debian / Ubuntu |
|---|---|---|
| Node.js 22+ | `brew install node` | [nodejs.org](https://nodejs.org) |
| Postgres 17 (server, not only the client) | `brew install postgresql@17` | `sudo apt install postgresql-17` |
| PostgREST 12 or newer | `brew install postgrest` | a release binary, see below |
| Redis | `brew install redis` | `sudo apt install redis-server` |
| pgvector (optional) | `brew install pgvector` | `sudo apt install postgresql-17-pgvector` |

On Debian / Ubuntu, `postgresql-17` is in the standard repositories from Debian 13 and Ubuntu 25.04.
On older releases, add the PostgreSQL project's own apt repository first
([apt.postgresql.org](https://wiki.postgresql.org/wiki/Apt)), or the install fails with "unable to
locate package".

**PostgREST** is one static file. If your package manager does not have it, download the archive for
your system from [the PostgREST releases page](https://github.com/PostgREST/postgrest/releases)
(for example `postgrest-v12.2.3-linux-static-x86-64.tar.xz`), unpack it, and either put `postgrest` on
your `PATH`, set `POSTGREST_BIN=/path/to/postgrest`, or copy it to `.local-stack/bin/postgrest`
(a wipe deletes that copy).

You do not need to start Postgres or Redis yourself, and you do not need a system-wide database. The
stack runs its own private copies, so it will not touch a Postgres or Redis you already have.

Install Rumi's own dependencies as usual: `npm install && (cd bot && npm install)`.

---

## Start it

From the repo root:

```bash
bash infrastructure/local/up.sh
```

The first run takes a few seconds. It ends like this:

```
==> Ready. Put these lines in the .env at the repo root (also saved to .local-stack/local.env):

SUPABASE_URL=http://127.0.0.1:54331
SUPABASE_SERVICE_ROLE_KEY=<a long key starting with eyJ>
REDIS_URL=redis://127.0.0.1:63799
QUEUE_DRIVER=bullmq
# The dashboard and portal talk to Postgres directly (over its socket, no SSL):
SUPABASE_DB_HOST=<the stack's socket directory>
SUPABASE_DB_PORT=54329
SUPABASE_DB_USER=postgres
SUPABASE_DB_NAME=postgres
SUPABASE_DB_SSL=off
```

Copy those lines into `.env` at the repo root (start from `.env.template` if you have no `.env`
yet), replacing any existing lines with the same names. Then add the rest of what Rumi needs: at least
`OPENROUTER_API_KEY`, and the channel block (`CHANNEL_DRIVER=baileys` needs nothing else). The
`rumi setup` wizard can fill those in too; when it asks about the database, keep the values above.

Running `up.sh` again is safe. Whatever is already running is left alone, the schema is applied only
once, and you get the same block of `.env` lines again. The key is printed fresh each time, but every key it has
printed keeps working until you wipe the stack.

### Check it

```bash
node bin/rumi.js doctor
```

With the local stack you should see:

```
  ✅ Supabase — HTTP 200
  ✅ Rumi tables — the "users" table is already there
  ✅ Redis — PONG
```

The OpenRouter and channel lines depend on your own keys.

### Run the bot and the worker

```bash
node bot/whatsapp-bot.js            # or: node bin/rumi.js start
node bot/workers/sqs-worker.js      # in a second terminal, for background jobs
```

The worker handles lesson plans, coaching reports, quiz reports, video and exam grading. With
`QUEUE_DRIVER=bullmq` it takes its jobs from the local Redis (despite its name, it does not need AWS),
and logs `BullMQ queue driver selected` when it starts.

### Stop it

```bash
bash infrastructure/local/down.sh           # stop; your data stays in .local-stack/
bash infrastructure/local/down.sh --wipe    # stop and delete .local-stack/ (all teachers, all history)
```

`down.sh` only stops the processes `up.sh` started (it reads their pid files from the state dir).
`--wipe` deletes only the files and folders `up.sh` creates; if you put anything else in the state dir,
that stays, and so does the dir. `up.sh` refuses to use a state dir that already has other files in it
(apart from `bin/`), so a mistyped `RUMI_LOCAL_STATE_DIR` cannot lead to a wipe of the wrong folder.

---

## What each piece does

| Piece | Listens on | What it is for |
|---|---|---|
| Postgres | a unix socket in `.local-stack/pgsock/`, port 54329 | The database. No TCP port at all, so nothing outside your user account can connect. |
| PostgREST | `127.0.0.1:54330` | Turns the database into the same REST API Supabase serves. It checks every request's key. |
| REST proxy | `127.0.0.1:54331` (this is `SUPABASE_URL`) | Supabase serves that API under `/rest/v1/`; PostgREST serves it at `/`. The proxy (`infrastructure/local/rest-proxy.js`) strips the prefix. |
| Redis | `127.0.0.1:63799` | Sessions, message de-duplication, menus in progress, and the BullMQ job queues. Nothing is saved to disk. |

What `up.sh` sets up inside Postgres:

- **A Supabase compatibility shim** (`infrastructure/local/supabase-shim.sql`): the `anon`,
  `authenticated` and `service_role` roles, the `authenticator` role PostgREST logs in as, the `auth`
  and `extensions` schemas with `auth.role()` and `auth.uid()`, and the `exec_sql` helper that
  `npm run bootstrap:db` and `infrastructure/scripts/migrate.js` use (callable with the service key
  only). Like hosted Supabase, `anon` and `authenticated` get full privileges on every table in
  `public`, so Row Level Security is the only thing between those keys and the data, exactly as in
  production.
- **The schema**: `infrastructure/supabase/00_complete-schema.sql`, `01_rls-policies.sql` and
  `02_seed-data.sql`, applied in one transaction. If any statement fails, nothing is half-applied.
- **The key**: `SUPABASE_SERVICE_ROLE_KEY` is a JWT signed with a random secret kept in
  `.local-stack/jwt-secret`. `infrastructure/local/mint-jwt.js` makes it with Node's own crypto. To
  make an `anon` key for testing Row Level Security (it reads what the anon key of a hosted project
  would read, including every table that has RLS off):
  `node infrastructure/local/mint-jwt.js --secret-file .local-stack/jwt-secret --role anon`

To open a database shell, use the `psql` command `up.sh` prints at the end.

---

## Settings

All optional. Set them in the shell when you run `up.sh` **and** `down.sh`.

| Variable | Default | What it sets |
|---|---|---|
| `RUMI_LOCAL_STATE_DIR` | `.local-stack` in the repo root | Where data, logs, pid files and the secret live |
| `RUMI_LOCAL_PG_PORT` | `54329` | Postgres port (part of the socket name) |
| `RUMI_LOCAL_POSTGREST_PORT` | `54330` | PostgREST port |
| `RUMI_LOCAL_PROXY_PORT` | `54331` | The port in `SUPABASE_URL` |
| `RUMI_LOCAL_REDIS_PORT` | `63799` | The port in `REDIS_URL` |
| `RUMI_LOCAL_SOCKET_DIR` | `<state dir>/pgsock` | Where the Postgres socket goes |
| `PG_BIN` | found automatically | The directory with `postgres`, `initdb`, `pg_ctl` and `psql` |
| `POSTGREST_BIN` | `postgrest` on `PATH` | The PostgREST binary |
| `REDIS_SERVER_BIN` | `redis-server` on `PATH` | The Redis binary |

The default ports are chosen so they do not collide with a normal Postgres (5432), Redis (6379) or the
Supabase CLI's API and database (54321, 54322). If you change a port after the stack is running, run `down.sh` first, then
`up.sh`, then update `.env`.

---

## Limits

- **Only the REST API is emulated.** There is no Supabase Storage, Auth, Realtime or Edge Functions;
  any other path answers 404. Rumi does not use Supabase Storage (media goes to the R2 settings), so
  this is enough for the bot and the worker today.
- **Not for production.** Postgres accepts any connection on its socket without a password, nothing
  is backed up, and Redis keeps nothing across restarts.
- **The service key is as powerful as your user account.** `exec_sql` runs as the `postgres` role,
  which is a real superuser in the local database, so whoever holds `SUPABASE_SERVICE_ROLE_KEY` can
  run any command on your machine as you (for example through `COPY ... TO PROGRAM`). Everything
  listens on 127.0.0.1 only, so this is fine on your own laptop, but do not share the key or expose
  the ports. `up.sh` prints the key on every run, so it also ends up in your terminal scrollback and
  in the log of any CI job that runs `up.sh`.
- **pgvector is optional.** If it is installed, `up.sh` uses it. If not, the one `vector` column is
  created with a stand-in type (an array of numbers) and `up.sh` comments out the
  `CREATE EXTENSION "vector"` line of the schema for you. Everything works except similarity search
  over that column. If you install pgvector later, wipe the stack and start again to switch.
- **Real AI keys are still needed for real replies.** The stack replaces Supabase and Redis, not
  OpenRouter. With a dummy `OPENROUTER_API_KEY` the bot answers every message with its generic apology.
- **Schema changes are not re-applied.** The schema is applied once per state dir. After pulling a
  schema change, apply the new SQL with the `psql` command `up.sh` prints, or wipe and start again.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Postgres binaries (initdb, pg_ctl, psql) were not found` | Install the Postgres server. Homebrew's `libpq` has `psql` and `pg_ctl` but no server, so it is skipped. Or set `PG_BIN`. |
| `the postgrest binary was not found` | See [What you need](#what-you-need). |
| `port 54330 is taken by another program` | Something else uses that port. Pick another, for example `RUMI_LOCAL_POSTGREST_PORT=55330 bash infrastructure/local/up.sh`, and pass the same setting to `down.sh`. |
| `... is not empty and is not a Rumi local stack state dir` | `RUMI_LOCAL_STATE_DIR` points at a folder that already holds other files. Point it at a new or empty folder, or leave it unset. |
| `the Postgres socket path is too long` | macOS limits socket paths to about 100 bytes. Set `RUMI_LOCAL_SOCKET_DIR=/tmp/rumi-pgsock`. |
| `Postgres did not start` | Read `.local-stack/logs/postgres.log`. A data dir made by a different major version of Postgres will not start: `down.sh --wipe`, then `up.sh`. |
| `applying the schema failed` | Read `.local-stack/logs/schema.log`; the first `ERROR` line is the cause. Nothing was applied, so fix it and re-run `up.sh`. |
| Doctor says `the key was rejected (HTTP 401)` | The key in `.env` came from a stack you have since wiped. Copy the lines from `.local-stack/local.env` again. |
| Doctor shows Supabase ❌ with a connection error | The stack is not running (after a reboot, for example). Run `up.sh` again. |
| The bot logs `PGRST205` / "could not find the table" | PostgREST has an old view of the schema. Run `up.sh` again; it tells PostgREST to reload. |

Every piece writes a log to `.local-stack/logs/`.
