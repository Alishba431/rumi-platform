-- =============================================================================
-- V2.7.0 - exec_sql is callable by service_role only
-- The one-time exec_sql helper (SETUP.md) runs any SQL as postgres. Earlier
-- copies of it never revoked EXECUTE, and Postgres grants EXECUTE on a new
-- function to PUBLIC (Supabase also grants it to anon and authenticated). On
-- those databases, anyone with the project URL and the anon key could call
-- /rest/v1/rpc/exec_sql. This revokes it and checks that the revoke took.
-- =============================================================================

DO $$
BEGIN
  IF to_regprocedure('public.exec_sql(text)') IS NULL THEN
    RETURN;
  END IF;

  REVOKE EXECUTE ON FUNCTION public.exec_sql(text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;

  -- A REVOKE by a role that does not own the function only warns, so check.
  -- That happens when exec_sql is not the SECURITY DEFINER, postgres-owned
  -- version from SETUP.md.
  IF has_function_privilege('anon', 'public.exec_sql(text)', 'execute')
     OR has_function_privilege('authenticated', 'public.exec_sql(text)', 'execute') THEN
    RAISE EXCEPTION 'exec_sql is still callable by anon or authenticated. Recreate it with the definition in SETUP.md (Option A) in the Supabase SQL Editor, then run migrate.js again.';
  END IF;
END
$$;

-- V2.4.0__test_papers.sql used to record itself as version 2.8.0, which would
-- make migrate.js skip a real 2.8.0 migration. Remove that stray row; the
-- matching 2.4.0 row is written by migrate.js when it applies V2.4.0.
DELETE FROM schema_versions
WHERE version = '2.8.0'
  AND description = 'Test papers: test_paper_requests + test_papers (versions)';
