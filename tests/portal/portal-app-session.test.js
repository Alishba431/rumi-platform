/**
 * The portal API must accept the app's origin, and its cookie must reach it —
 * without widening anything for the web or the admin dashboard.
 *
 * A bundled Capacitor app serves its pages from `https://localhost` (Android,
 * androidScheme 'https') or `capacitor://localhost` (iOS) while the API stays
 * on the portal host. Two server-side settings decide whether login works:
 *
 *   1. CORS. Without these origins the app's preflight gets no
 *      Access-Control-Allow-Origin and every API call is blocked before it is
 *      sent — which presents as "correct password won't log in", a CORS error
 *      rather than an auth error.
 *   2. The session cookie's SameSite. The app's origin is cross-site to the
 *      API, so a 'lax' cookie is never stored or returned and login silently
 *      fails on the request after /login. The app needs 'none'.
 *
 * One cookie carries both portal and admin sessions, and the dashboard has no
 * CSRF token, so 'none' on the global cookie would let any website post a form
 * with an admin's cookie attached. So the global cookie is always 'lax', and
 * 'none' is set per session, only on a portal login that comes from the app's
 * origin, only when PORTAL_APP_ENABLED is on. The runtime proof is in
 * portal-app-session-runtime.test.js.
 */

const fs = require('fs');
const path = require('path');

const {
  APP_ORIGINS,
  buildPortalCorsOrigins,
  isPortalAppEnabled,
  sessionCookieOptions,
} = require('../../dashboard/lib/portal-app-origins');

describe('buildPortalCorsOrigins', () => {
  it('includes the Capacitor app origins (no port, local scheme) when the app is enabled', () => {
    const origins = buildPortalCorsOrigins({ appEnabled: true });
    expect(APP_ORIGINS).toEqual(['https://localhost', 'capacitor://localhost']);
    for (const o of APP_ORIGINS) expect(origins).toContain(o);
  });

  it('leaves the app origins out of the credentialed allow-list when the app is not shipped', () => {
    const origins = buildPortalCorsOrigins({ portalUrl: 'https://portal.example.org' });
    for (const o of APP_ORIGINS) expect(origins).not.toContain(o);
  });

  it('keeps the configured portal + website origins and the local dev servers', () => {
    const origins = buildPortalCorsOrigins({
      portalUrl: 'https://portal.example.org',
      websiteOrigins: ['https://www.example.org', 'https://example.org'],
    });
    expect(origins).toEqual(
      expect.arrayContaining([
        'https://portal.example.org',
        'https://www.example.org',
        'https://example.org',
        'http://localhost:5173',
        'http://localhost:3000',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:3000',
      ])
    );
  });

  it('never allows a wildcard (credentials are on)', () => {
    expect(buildPortalCorsOrigins({ portalUrl: '*', appEnabled: true })).not.toContain('*');
  });

  it('skips an unset portal url rather than adding an empty origin', () => {
    expect(buildPortalCorsOrigins({ portalUrl: '' })).not.toContain('');
  });
});

describe('isPortalAppEnabled', () => {
  it('is off unless set', () => {
    expect(isPortalAppEnabled({})).toBe(false);
    expect(isPortalAppEnabled({ PORTAL_APP_ENABLED: '' })).toBe(false);
  });

  it.each([['true'], ['1'], ['yes'], ['on'], [' TRUE ']])('is on for PORTAL_APP_ENABLED=%p', (raw) => {
    expect(isPortalAppEnabled({ PORTAL_APP_ENABLED: raw })).toBe(true);
  });

  it.each([['false'], ['0'], ['no'], ['sometimes']])('is off for PORTAL_APP_ENABLED=%p', (raw) => {
    expect(isPortalAppEnabled({ PORTAL_APP_ENABLED: raw })).toBe(false);
  });
});

describe('sessionCookieOptions', () => {
  it('is lax, httpOnly and Secure whatever the environment says', () => {
    expect(sessionCookieOptions()).toEqual(
      expect.objectContaining({ sameSite: 'lax', httpOnly: true, secure: true })
    );
  });
});

describe('dashboard/index.js uses them', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../dashboard/index.js'), 'utf8');

  it('builds the portal CORS allow-list from buildPortalCorsOrigins, gated on the app opt-in', () => {
    expect(src).toMatch(/origin:\s*buildPortalCorsOrigins\(\{[^}]*appEnabled:\s*isPortalAppEnabled\(process\.env\)/);
  });

  it('takes the global session cookie from sessionCookieOptions, never from the environment', () => {
    expect(src).toMatch(/cookie:\s*sessionCookieOptions\(\)/);
    expect(src).not.toMatch(/SESSION_COOKIE_SAMESITE/);
  });

  it('mounts keepSessionsLaxOutsidePortalApi straight after the session middleware', () => {
    expect(src).toMatch(/app\.use\(session\([\s\S]*?\}\)\);\s*(\/\/[^\n]*\n\s*)*app\.use\(keepSessionsLaxOutsidePortalApi\);/);
  });
});
