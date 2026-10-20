/**
 * A page served from a real host must never call localhost.
 *
 * `resolveApiBaseUrl` used to fall back to `http://localhost:4000/api/portal`
 * whenever `isProd` was false. `isProd` is Vite's `import.meta.env.PROD`, which
 * Vite derives from NODE_ENV at BUILD time — so a staging service that sets
 * `NODE_ENV=staging` (not the literal "production") ships a bundle whose login
 * preflight goes to http://localhost:4000, a host that does not exist for the
 * user. Production only escapes because its service happens to say
 * NODE_ENV=production; that is luck, not design.
 *
 * The localhost fallback exists for `vite dev`, where the page is served from
 * localhost:5173 and the API runs separately on :4000. The signal for "am I a
 * developer" is therefore WHERE THE PAGE CAME FROM, not what NODE_ENV said at
 * build time. A page served by a real remote host is served by something that
 * also serves the API, so same-origin `/api/portal` is correct.
 */

const { resolveApiBaseUrl } = require('../../portal/src/lib/app-target.cjs');

const STAGING = 'https://portal-staging.example.com';
const PROD = 'https://portal.example.com';

describe('a real host never resolves to localhost', () => {
  it('uses the same-origin path when isProd is false but the host is real', () => {
    expect(resolveApiBaseUrl({ isProd: false, origin: STAGING })).toBe('/api/portal');
  });

  it('does the same for production hosts', () => {
    expect(resolveApiBaseUrl({ isProd: true, origin: PROD })).toBe('/api/portal');
  });

  it('never returns a localhost URL to a page served from a real host', () => {
    for (const isProd of [true, false]) {
      for (const origin of [STAGING, PROD, 'https://school.example.org']) {
        expect(resolveApiBaseUrl({ isProd, origin })).not.toMatch(/localhost/);
      }
    }
  });

  it('an explicit absolute URL still wins', () => {
    expect(
      resolveApiBaseUrl({ isProd: false, origin: STAGING, apiBaseUrl: `${PROD}/api/portal` })
    ).toBe(`${PROD}/api/portal`);
  });
});

describe('local development is unchanged', () => {
  it('still points at the local API server when served from the dev server', () => {
    expect(resolveApiBaseUrl({ isProd: false, origin: 'http://localhost:5173' })).toBe(
      'http://localhost:4000/api/portal'
    );
  });

  it('handles 127.0.0.1 the same way', () => {
    expect(resolveApiBaseUrl({ isProd: false, origin: 'http://127.0.0.1:5173' })).toBe(
      'http://localhost:4000/api/portal'
    );
  });

  it('falls back to the dev API when there is no origin at all (SSR/tests)', () => {
    expect(resolveApiBaseUrl({ isProd: false })).toBe('http://localhost:4000/api/portal');
  });

  it('a prod build with no origin still uses the relative path', () => {
    expect(resolveApiBaseUrl({ isProd: true })).toBe('/api/portal');
  });
});

describe('no page hardcodes the dev API host', () => {
  // Every portal request must go through getApiBaseUrl(); a page that builds
  // its own `http://localhost:4000` reaches a machine the teacher doesn't have
  // as soon as it runs inside the app. src/lib/ is exempt: it is the one place
  // that decides (app-target.cjs).
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '../../portal/src');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (p !== path.join(SRC, 'lib')) walk(p); }
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
    }
  })(SRC);

  it.each(files.map((f) => [path.relative(SRC, f), f]))('%s has no literal localhost:4000', (_rel, file) => {
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/localhost:4000/);
  });
});
