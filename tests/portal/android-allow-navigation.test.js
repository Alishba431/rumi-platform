/**
 * The WebView must keep portal navigations in-app.
 *
 * A bundled app runs on `https://localhost`. A link to the portal API's own
 * origin (a PDF, a certificate) is therefore a CROSS-ORIGIN navigation, and
 * Capacitor hands those to the system browser by default. The browser carries
 * none of the WebView's cookies → no session → 401 "Not authenticated". It is
 * not a `target="_blank"` problem: the hand-off happens with no target at all.
 *
 * The allowlist is DERIVED from VITE_API_BASE_URL rather than hardcoded, so a
 * staging build allows staging and a production build allows production, and
 * neither can drift from the host the app actually calls.
 *
 * capacitor.config.ts compiles into the APK: a change here reaches users only
 * through a new app release, not via OTA.
 */

const fs = require('fs');
const path = require('path');

const CONFIG = path.resolve(__dirname, '../../portal/capacitor.config.ts');
const src = () => fs.readFileSync(CONFIG, 'utf8');

/**
 * Evaluate the real allowedNavigationHosts() from capacitor.config.ts against a
 * supplied value. It is TypeScript, so strip its two annotations and run it,
 * rather than testing a copy of the logic.
 */
function loadAllowNavigation(raw) {
  const fnMatch = src().match(/function allowedNavigationHosts\([\s\S]*?\n\}/);
  if (!fnMatch) throw new Error('allowedNavigationHosts() not found in capacitor.config.ts');
  const js = fnMatch[0]
    .replace(/\(\s*raw\?\s*:\s*string\s*\)/, '(raw)')
    .replace(/\)\s*:\s*string\[\]\s*\{/, ') {');
  // eslint-disable-next-line no-new-func
  return new Function('raw', `${js}; return allowedNavigationHosts(raw);`)(raw);
}

describe('allowNavigation is derived from the configured API host', () => {
  it('allows the configured portal host', () => {
    expect(loadAllowNavigation('https://portal-staging.example.app/api/portal')).toEqual(['portal-staging.example.app']);
    expect(loadAllowNavigation('https://portal.example.edu/api/portal')).toEqual(['portal.example.edu']);
  });

  it('is a HOSTNAME, never a full url with a path', () => {
    // Capacitor matches hostnames; passing a url silently matches nothing,
    // which would look configured and still hand off to the browser.
    const [host] = loadAllowNavigation('https://portal.example.edu/api/portal');
    expect(host).not.toMatch(/^https?:/);
    expect(host).not.toContain('/');
  });

  it('returns [] when VITE_API_BASE_URL is absent (a web build)', () => {
    expect(loadAllowNavigation(undefined)).toEqual([]);
  });

  it('refuses a non-https host — a WebView on http is mixed content', () => {
    expect(loadAllowNavigation('http://insecure.example/api')).toEqual([]);
  });

  it('returns [] rather than throwing on an unparseable value', () => {
    expect(loadAllowNavigation('not-a-url')).toEqual([]);
    expect(loadAllowNavigation('   ')).toEqual([]);
  });
});

describe('one resolved value feeds OTA and the allowlist', () => {
  it('derives BOTH from the same apiBaseUrl', () => {
    const s = src();
    expect(s).toMatch(/const apiBaseUrl = appConfig\.apiBaseUrl/);
    expect(s).toMatch(/allowedNavigationHosts\(apiBaseUrl\)/);
  });

  it('does not hardcode any deployment host', () => {
    expect(src()).not.toMatch(/allowNavigation:\s*\[\s*['"]/);
  });

  it('keeps loggingBehavior at production', () => {
    // Capacitor's Android bridge can exhaust memory on unbounded console output.
    expect(src()).toMatch(/loggingBehavior:\s*'production'/);
  });
});
