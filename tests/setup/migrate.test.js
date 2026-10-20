const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Mock @supabase/supabase-js before requiring the module
// virtual: true because supabase-js is not installed in root node_modules
// (it's a runtime dependency installed on the deployment server)
const mockFrom = jest.fn();
const mockClient = { from: mockFrom };
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockClient),
}), { virtual: true });

// Mock global.fetch for SQL execution
const originalFetch = global.fetch;

const { MigrationRunner } = require('../../infrastructure/scripts/migrate');
const { createClient } = require('@supabase/supabase-js');

describe('MigrationRunner', () => {
  let tmpDir;
  let runner;

  beforeEach(() => {
    // Create a temp directory with test migration files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rumi-migrations-'));

    // Write test SQL migration files
    fs.writeFileSync(path.join(tmpDir, 'V1.0.0__initial_schema.sql'), 'CREATE TABLE users (id UUID PRIMARY KEY);');
    fs.writeFileSync(path.join(tmpDir, 'V1.1.0__add_sessions.sql'), 'CREATE TABLE sessions (id UUID PRIMARY KEY);');
    fs.writeFileSync(path.join(tmpDir, 'V2.0.0__add_analytics.sql'), 'CREATE TABLE analytics (id UUID PRIMARY KEY);');
    // Non-migration file should be ignored
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Migrations');

    runner = new MigrationRunner({
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'test-key-123',
      migrationsDir: tmpDir,
    });

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  // ── Constructor ──
  describe('constructor', () => {
    it('accepts { supabaseUrl, supabaseKey, migrationsDir }', () => {
      const r = new MigrationRunner({
        supabaseUrl: 'https://example.supabase.co',
        supabaseKey: 'key-abc',
        migrationsDir: '/some/path',
      });

      expect(r.supabaseUrl).toBe('https://example.supabase.co');
      expect(r.supabaseKey).toBe('key-abc');
      expect(r.migrationsDir).toBe('/some/path');
    });

    it('creates a Supabase client with the provided URL and key', () => {
      new MigrationRunner({
        supabaseUrl: 'https://example.supabase.co',
        supabaseKey: 'key-abc',
        migrationsDir: '/some/path',
      });

      expect(createClient).toHaveBeenCalledWith(
        'https://example.supabase.co',
        'key-abc'
      );
    });
  });

  // ── getAppliedVersions() ──
  describe('getAppliedVersions()', () => {
    it('queries schema_versions table and returns array of version strings', async () => {
      const mockSelect = jest.fn().mockReturnValue({
        order: jest.fn().mockResolvedValue({
          data: [
            { version: '1.0.0' },
            { version: '1.1.0' },
          ],
          error: null,
        }),
      });

      mockFrom.mockReturnValue({ select: mockSelect });

      const versions = await runner.getAppliedVersions();

      expect(mockFrom).toHaveBeenCalledWith('schema_versions');
      expect(mockSelect).toHaveBeenCalledWith('version');
      expect(versions).toEqual(['1.0.0', '1.1.0']);
    });

    it('returns empty array when table has no rows', async () => {
      const mockSelect = jest.fn().mockReturnValue({
        order: jest.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
      });

      mockFrom.mockReturnValue({ select: mockSelect });

      const versions = await runner.getAppliedVersions();
      expect(versions).toEqual([]);
    });

    it('returns empty array and warns on error', async () => {
      const mockSelect = jest.fn().mockReturnValue({
        order: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'Table not found' },
        }),
      });

      mockFrom.mockReturnValue({ select: mockSelect });

      const versions = await runner.getAppliedVersions();
      expect(versions).toEqual([]);
      expect(console.warn).toHaveBeenCalled();
    });
  });

  // ── getPendingMigrations() ──
  describe('getPendingMigrations()', () => {
    it('scans migrationsDir for V*.sql files and filters out applied ones', async () => {
      // Mock getAppliedVersions to say V1.0.0 is already applied
      jest.spyOn(runner, 'getAppliedVersions').mockResolvedValue(['1.0.0']);

      const pending = await runner.getPendingMigrations();

      // Should only return V1.1.0 and V2.0.0
      expect(pending).toHaveLength(2);
      expect(pending[0]).toContain('V1.1.0');
      expect(pending[1]).toContain('V2.0.0');
    });

    it('sorts by version number correctly (V1.0.0 before V1.1.0 before V2.0.0)', async () => {
      jest.spyOn(runner, 'getAppliedVersions').mockResolvedValue([]);

      const pending = await runner.getPendingMigrations();

      expect(pending).toHaveLength(3);
      expect(pending[0]).toContain('V1.0.0');
      expect(pending[1]).toContain('V1.1.0');
      expect(pending[2]).toContain('V2.0.0');
    });

    it('skips already-applied versions', async () => {
      jest.spyOn(runner, 'getAppliedVersions').mockResolvedValue(['1.0.0', '1.1.0', '2.0.0']);

      const pending = await runner.getPendingMigrations();

      expect(pending).toHaveLength(0);
    });

    it('ignores non-V*.sql files', async () => {
      jest.spyOn(runner, 'getAppliedVersions').mockResolvedValue([]);

      const pending = await runner.getPendingMigrations();

      // README.md should not appear
      const filenames = pending.map(f => path.basename(f));
      expect(filenames).not.toContain('README.md');
    });
  });

  // ── applyMigration(file) ──
  describe('applyMigration(file)', () => {
    it('computes correct SHA-256 checksum of the file content', async () => {
      const filePath = path.join(tmpDir, 'V1.0.0__initial_schema.sql');
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const expectedChecksum = crypto
        .createHash('sha256')
        .update(fileContent)
        .digest('hex');

      // Mock fetch for SQL execution (success)
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      // Mock from('schema_versions').upsert()
      const mockUpsert = jest.fn().mockResolvedValue({ error: null });
      mockFrom.mockReturnValue({ upsert: mockUpsert });

      await runner.applyMigration(filePath);

      // Verify the checksum was recorded (in the description: see the next test)
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ description: expect.stringContaining(expectedChecksum) }),
        ]),
        expect.objectContaining({ ignoreDuplicates: true })
      );
    });

    it('reads SQL file and executes it via fetch', async () => {
      const filePath = path.join(tmpDir, 'V1.0.0__initial_schema.sql');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const mockUpsert = jest.fn().mockResolvedValue({ error: null });
      mockFrom.mockReturnValue({ upsert: mockUpsert });

      await runner.applyMigration(filePath);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.supabase.co/rest/v1/rpc/exec_sql',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            apikey: 'test-key-123',
          }),
        })
      );
    });

    it('records applied migration in schema_versions table', async () => {
      const filePath = path.join(tmpDir, 'V1.0.0__initial_schema.sql');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const mockUpsert = jest.fn().mockResolvedValue({ error: null });
      mockFrom.mockReturnValue({ upsert: mockUpsert });

      await runner.applyMigration(filePath);

      expect(mockFrom).toHaveBeenCalledWith('schema_versions');
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            version: '1.0.0',
          }),
        ]),
        expect.objectContaining({ ignoreDuplicates: true })
      );
    });

    // A deployment's schema_versions comes from 00_complete-schema.sql (fresh install) or
    // from V1.0.0__baseline.sql (older installs). The row is written through the REST API,
    // which rejects any column the table does not have, so every key must exist in both.
    it('records only columns that every schema_versions definition has', async () => {
      const root = path.resolve(__dirname, '../..');
      const columnsOf = (rel) => {
        const sql = fs.readFileSync(path.join(root, rel), 'utf-8');
        const body = sql.match(/CREATE TABLE IF NOT EXISTS schema_versions \(([\s\S]*?)\n\);/)[1];
        return body
          .split('\n')
          .map((line) => line.trim().split(/\s+/)[0])
          .filter((word) => word && /^[a-z_]+$/.test(word));
      };
      const fresh = columnsOf('infrastructure/supabase/00_complete-schema.sql');
      const baseline = columnsOf('infrastructure/supabase/migrations/V1.0.0__baseline.sql');
      const shared = fresh.filter((c) => baseline.includes(c));
      expect(shared).toEqual(expect.arrayContaining(['version', 'description', 'applied_at']));

      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      const mockUpsert = jest.fn().mockResolvedValue({ error: null });
      mockFrom.mockReturnValue({ upsert: mockUpsert });

      await runner.applyMigration(path.join(tmpDir, 'V1.1.0__add_sessions.sql'));

      const [[rows]] = mockUpsert.mock.calls;
      for (const key of Object.keys(rows[0])) expect(shared).toContain(key);
      expect(rows[0].description).toContain('V1.1.0__add_sessions.sql');
    });

    // V1.0.0, V2.4.0 and V2.9.0 insert their own schema_versions row (ON CONFLICT DO NOTHING). Recording that
    // version again must not turn an applied migration into a reported failure.
    it('a migration that records its own version still counts as applied', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      const duplicate = { message: 'duplicate key value violates unique constraint "schema_versions_pkey"' };
      const mockInsert = jest.fn().mockResolvedValue({ error: duplicate });
      const mockUpsert = jest.fn().mockResolvedValue({ error: null });
      mockFrom.mockReturnValue({ insert: mockInsert, upsert: mockUpsert });

      await expect(runner.applyMigration(path.join(tmpDir, 'V1.1.0__add_sessions.sql'))).resolves.toBeUndefined();
      expect(mockUpsert).toHaveBeenCalledWith(
        [expect.objectContaining({ version: '1.1.0' })],
        expect.objectContaining({ onConflict: 'version', ignoreDuplicates: true })
      );
    });

    it('throws when SQL execution fails', async () => {
      const filePath = path.join(tmpDir, 'V1.0.0__initial_schema.sql');

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'SQL syntax error',
      });

      await expect(runner.applyMigration(filePath)).rejects.toThrow();
    });
  });

  // ── run() ──
  describe('run()', () => {
    it('applies all pending migrations in order', async () => {
      jest.spyOn(runner, 'getAppliedVersions').mockResolvedValue([]);

      const appliedOrder = [];
      jest.spyOn(runner, 'applyMigration').mockImplementation(async (file) => {
        appliedOrder.push(path.basename(file));
      });

      const result = await runner.run();

      expect(appliedOrder).toEqual([
        'V1.0.0__initial_schema.sql',
        'V1.1.0__add_sessions.sql',
        'V2.0.0__add_analytics.sql',
      ]);
      expect(result.applied).toHaveLength(3);
    });

    it('continues on error and records in errors array', async () => {
      jest.spyOn(runner, 'getAppliedVersions').mockResolvedValue([]);

      jest.spyOn(runner, 'applyMigration').mockImplementation(async (file) => {
        if (path.basename(file).includes('V1.1.0')) {
          throw new Error('Migration V1.1.0 failed');
        }
      });

      const result = await runner.run();

      // V1.0.0 should succeed, V1.1.0 should fail, V2.0.0 should succeed
      expect(result.applied).toHaveLength(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        file: expect.stringContaining('V1.1.0'),
        error: expect.any(String),
      });
    });

    it('returns empty applied array when all migrations already applied', async () => {
      jest.spyOn(runner, 'getAppliedVersions').mockResolvedValue(['1.0.0', '1.1.0', '2.0.0']);

      const result = await runner.run();

      expect(result.applied).toEqual([]);
      expect(result.skipped).toHaveLength(3);
      expect(result.errors).toEqual([]);
    });

    it('returns result with applied, skipped, and errors arrays', async () => {
      jest.spyOn(runner, 'getAppliedVersions').mockResolvedValue(['1.0.0']);

      jest.spyOn(runner, 'applyMigration').mockImplementation(async () => {});

      const result = await runner.run();

      expect(result).toHaveProperty('applied');
      expect(result).toHaveProperty('skipped');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.applied)).toBe(true);
      expect(Array.isArray(result.skipped)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });
});

// migrate.js skips any version already in schema_versions, so a migration that records a version
// other than its own (left behind by a rename) makes the real migration of that version a silent no-op.
describe('migration files', () => {
  const dir = path.resolve(__dirname, '../../infrastructure/supabase/migrations');

  // Two files with one version: after the first applies, migrate.js skips the second as already applied,
  // so its tables are never created on an upgraded database.
  it('no two migrations share a version', () => {
    const seen = {};
    const dupes = [];
    for (const file of fs.readdirSync(dir).filter((f) => /^V\d+\.\d+\.\d+__.*\.sql$/.test(f))) {
      const version = file.match(/^V(\d+\.\d+\.\d+)__/)[1];
      if (seen[version]) dupes.push(`${seen[version]} and ${file}`);
      else seen[version] = file;
    }
    expect(dupes).toEqual([]);
  });

  it('each migration records only its own version in schema_versions', () => {
    const wrong = [];
    for (const file of fs.readdirSync(dir).filter((f) => /^V\d+\.\d+\.\d+__.*\.sql$/.test(f))) {
      const own = file.match(/^V(\d+\.\d+\.\d+)__/)[1];
      const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
      const re = /INSERT INTO schema_versions[^;]*?VALUES\s*\(\s*'([^']+)'/gi;
      let m;
      while ((m = re.exec(sql))) if (m[1] !== own) wrong.push(`${file} records ${m[1]}`);
    }
    expect(wrong).toEqual([]);
  });
});
