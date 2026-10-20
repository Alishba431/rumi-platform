/**
 * The test-paper tables, in all three places a deployment can get them from:
 * the consolidated schema (fresh installs), the RLS policies, and a versioned
 * migration (existing deployments). The migration must be additive — it runs
 * against databases holding real teachers' data.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'infrastructure', 'supabase');
const SCHEMA = fs.readFileSync(path.join(ROOT, '00_complete-schema.sql'), 'utf8');
const RLS = fs.readFileSync(path.join(ROOT, '01_rls-policies.sql'), 'utf8');
const MIGRATION_PATH = path.join(ROOT, 'migrations', 'V2.4.0__test_papers.sql');

const TABLES = ['test_paper_requests', 'test_papers'];

function tableBlock(sql, table) {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start === -1) return null;
  return sql.slice(start, sql.indexOf(');', start) + 2);
}

describe.each(TABLES)('%s', (table) => {
  it('is in the consolidated schema', () => {
    expect(tableBlock(SCHEMA, table)).not.toBeNull();
  });

  it('has RLS enabled with a service-role policy', () => {
    expect(RLS).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    expect(RLS).toMatch(new RegExp(`CREATE POLICY "service_role_${table}" ON ${table} FOR ALL USING \\(auth\\.role\\(\\) = 'service_role'\\);`));
  });

  it('the migration creates it with the same definition as the schema', () => {
    const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(tableBlock(migration, table)).toBe(tableBlock(SCHEMA, table));
  });
});

describe('the migration', () => {
  it('exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('is additive only', () => {
    const migration = fs.readFileSync(MIGRATION_PATH, 'utf8').replace(/--.*$/gm, '');
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
    expect(migration).not.toMatch(/\bALTER\s+TABLE\s+(?!test_paper)\w+/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bUPDATE\s+\w+\s+SET\b/i);
  });

  it('records its version', () => {
    const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(migration).toMatch(/INSERT INTO schema_versions \(version, description\)\s+VALUES \('2\.4\.0'/);
  });

  it('enables RLS on what it creates', () => {
    const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
    for (const table of TABLES) {
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    }
  });
});

describe('the shape the store relies on', () => {
  const papers = () => tableBlock(SCHEMA, 'test_papers');
  const requests = () => tableBlock(SCHEMA, 'test_paper_requests');

  it('a version points at the paper it was edited from, never itself', () => {
    expect(papers()).toMatch(/edited_from\s+UUID REFERENCES test_papers\(id\)/);
    expect(SCHEMA).toMatch(/test_papers_edited_from_not_self[\s\S]*CHECK \(edited_from IS NULL OR edited_from <> id\)/);
  });

  it('versions are numbered once per request', () => {
    expect(papers()).toMatch(/UNIQUE \(request_id, version\)/);
  });

  it('the request keeps the source text it was built from', () => {
    expect(requests()).toMatch(/source_text\s+TEXT NOT NULL/);
    expect(requests()).toMatch(/source_kind\s+TEXT NOT NULL[\s\S]*CHECK \(source_kind IN \('lesson_plan', 'textbook', 'upload'\)\)/);
  });

  it('never uses the word "assessment", which means reading assessment in this repo', () => {
    for (const t of TABLES) expect(tableBlock(SCHEMA, t)).not.toMatch(/assessment/i);
  });
});
