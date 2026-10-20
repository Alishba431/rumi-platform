-- =============================================================================
-- Supabase compatibility shim for a plain local Postgres (infrastructure/local)
-- =============================================================================
-- Gives a bare Postgres the few things a Supabase project has out of the box,
-- so 00/01/02 in infrastructure/supabase/ apply unchanged and PostgREST can
-- serve them:
--   * the roles anon, authenticated, service_role (BYPASSRLS) and the
--     authenticator login role PostgREST connects as
--   * the schemas extensions and auth, with auth.role() and auth.uid() reading
--     the JWT claims PostgREST puts in request.jwt.claims
--   * Supabase's default privileges: service_role, anon and authenticated
--     get every table and sequence the schema files create, so Row Level
--     Security is the only guard, as on a hosted project
--   * the exec_sql RPC that infrastructure/scripts/bootstrap-db.js and
--     migrate.js call (the same definition SETUP.md asks Supabase users to
--     paste), callable by service_role only
--   * pgvector when it is installed, otherwise a stand-in `vector` type
--
-- Local development only. Safe to run more than once. Run as the postgres
-- superuser: psql -U postgres -v ON_ERROR_STOP=1 -f supabase-shim.sql
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END
$$;

GRANT anon, authenticated, service_role TO authenticator;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

GRANT USAGE ON SCHEMA public, extensions, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role(), auth.uid() TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
-- Hosted Supabase grants these to anon and authenticated too and relies on
-- RLS. Mirror it, so a local anon key sees exactly what it would see in
-- production (a table with RLS off is readable here as it is there).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;

-- pgvector: the schema has one vector column (and a CREATE EXTENSION line that
-- up.sh comments out when the extension is not installed). Without pgvector,
-- a real[] domain stands in, so the column exists but similarity search does not.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'vector'
  ) THEN
    CREATE DOMAIN public.vector AS real[];
  END IF;
END
$$;

-- exec_sql: the helper bootstrap-db.js / migrate.js / the setup wizard use.
-- Same definition as infrastructure/scripts/exec-sql-helper.js. It runs any
-- SQL as postgres, so EXECUTE is revoked from PUBLIC (Postgres's default for
-- new functions) and from anon and authenticated (Supabase's default).
CREATE OR REPLACE FUNCTION public.exec_sql(query text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$ BEGIN EXECUTE query; END; $$;

ALTER FUNCTION public.exec_sql(text) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.exec_sql(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;

NOTIFY pgrst, 'reload schema';
