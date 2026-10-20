/**
 * Remote-first OTA for the Android portal app.
 *
 * WHY. Without it, a one-line portal fix reaches app users only through a full
 * store release: build, sign, upload, review, staged rollout. Days. With
 * `PORTAL_APP_OTA=1` the WebView loads the SPA from the live portal, so a web
 * deploy is an instant update for every installed app, and the native shell
 * only needs a release when something genuinely native changes (Capacitor
 * upgrade, manifest, MainActivity, SDK bump).
 *
 * THE FAILURE MODE THIS GUARDS. A remote-first app has one new way to brick
 * itself: point the WebView at the wrong host, or at a host that stops
 * serving, and every user gets a blank shell — and a store rollback can't fix a
 * URL baked into a build users already have. So the rules are contract:
 *
 *   1. The OTA origin is DERIVED from the same VITE_API_BASE_URL the app
 *      already trusts for its data, so code and data cannot come from two hosts.
 *   2. It must be absolute and https — a WebView served over http is mixed
 *      content, and a relative path means "localhost".
 *   3. Web builds NEVER get a remote URL. The website already is the server.
 *   4. A missing/garbage config falls back to the BUNDLED assets rather than
 *      throwing. The bundle inside the APK is a known-good floor.
 *   5. It targets a /portal/ path, not the bare origin: the root of a portal
 *      host may redirect to a marketing site, which the WebView hands to the
 *      system browser and leaves the app on a grey screen.
 */

const {
  resolveOtaUrl,
  resolveApiBaseUrl,
} = require('../../portal/src/lib/app-target.cjs');

const API = 'https://portal-x.example.app/api/portal';

describe('resolveOtaUrl — where the native shell loads its web assets', () => {
  describe('native builds load from the live portal', () => {
    it('derives the web origin from the configured API URL', () => {
      expect(resolveOtaUrl({ isNative: true, apiBaseUrl: API })).toBe(
        'https://portal-x.example.app/portal/login'
      );
    });

    it('ignores query strings and fragments', () => {
      expect(
        resolveOtaUrl({ isNative: true, apiBaseUrl: 'https://portal.example.org/api/portal?v=2#x' })
      ).toBe('https://portal.example.org/portal/login');
    });

    it('preserves an explicit non-default port', () => {
      expect(
        resolveOtaUrl({ isNative: true, apiBaseUrl: 'https://staging.example.org:8443/api/portal' })
      ).toBe('https://staging.example.org:8443/portal/login');
    });
  });

  describe('never lands on a possibly-redirecting root', () => {
    it('targets a /portal path, not the bare origin', () => {
      const url = resolveOtaUrl({ isNative: true, apiBaseUrl: API });
      expect(new URL(url).pathname).toMatch(/^\/portal\//);
      expect(url).not.toBe(new URL(url).origin);
    });
  });

  describe('falls back to the bundled assets rather than bricking', () => {
    it('returns null when no API URL is configured', () => {
      expect(resolveOtaUrl({ isNative: true })).toBeNull();
    });

    it('returns null for a relative API path', () => {
      expect(resolveOtaUrl({ isNative: true, apiBaseUrl: '/api/portal' })).toBeNull();
    });

    it('returns null for an unparseable URL', () => {
      expect(resolveOtaUrl({ isNative: true, apiBaseUrl: 'not a url' })).toBeNull();
    });

    it('refuses plain http (a WebView over http is mixed content)', () => {
      expect(
        resolveOtaUrl({ isNative: true, apiBaseUrl: 'http://portal.example.org/api/portal' })
      ).toBeNull();
    });

    it('never throws, whatever it is handed', () => {
      const junk = [undefined, null, '', '   ', 'ftp://x/y', '://', 42, {}];
      for (const apiBaseUrl of junk) {
        expect(() => resolveOtaUrl({ isNative: true, apiBaseUrl })).not.toThrow();
      }
    });
  });

  describe('web builds are never remote-loaded', () => {
    it('returns null on the web even with an absolute API URL', () => {
      expect(resolveOtaUrl({ isNative: false, apiBaseUrl: API })).toBeNull();
    });

    it('defaults to non-native when isNative is omitted', () => {
      expect(resolveOtaUrl({ apiBaseUrl: API })).toBeNull();
    });
  });

  describe('the OTA origin and the API origin cannot drift apart', () => {
    it('agrees with resolveApiBaseUrl on the host', () => {
      for (const url of [API, 'https://portal.example.org/api/portal', 'https://staging.example.org:8443/api/portal']) {
        const ota = resolveOtaUrl({ isNative: true, apiBaseUrl: url });
        const api = resolveApiBaseUrl({ isNative: true, apiBaseUrl: url });
        expect(new URL(ota).origin).toBe(new URL(api).origin);
      }
    });
  });
});

/**
 * Under OTA, a native shell serving the WEB bundle must not throw.
 *
 * OTA silently changes which bundle runs inside the native shell. Bundled, it is
 * the app-mode bundle carrying an absolute VITE_API_BASE_URL. Under OTA the
 * WebView fetches whatever the portal serves the WEB — built with plain
 * `npm run build`, where VITE_API_BASE_URL is undefined. Capacitor still
 * injects its global, so isNativeApp() is still true. If resolveApiBaseUrl()
 * insisted on an absolute URL for every native page it would throw at first
 * render: a white screen on every launch the moment OTA is switched on.
 *
 * So the rule is not "native ⇒ absolute URL". It is "no usable origin ⇒
 * absolute URL".
 */
describe('OTA: native shell running the web bundle', () => {
  const HOST = 'portal.example.org';
  const ota = { isNative: true, isProd: true, apiBaseUrl: undefined, origin: `https://${HOST}` };

  it('does NOT throw when the page was served by the portal', () => {
    expect(() => resolveApiBaseUrl(ota)).not.toThrow();
  });

  it('uses the same-origin relative path, exactly as the web build does', () => {
    expect(resolveApiBaseUrl(ota)).toBe('/api/portal');
  });

  it('still prefers an explicit absolute URL when the build has one', () => {
    expect(resolveApiBaseUrl({ ...ota, apiBaseUrl: `https://${HOST}/api/portal` })).toBe(
      `https://${HOST}/api/portal`
    );
  });

  it('throws for a bundled app at https://localhost with no absolute URL', () => {
    expect(() =>
      resolveApiBaseUrl({ isNative: true, isProd: true, origin: 'https://localhost' })
    ).toThrow(/absolute API base URL/);
  });

  it('throws for the iOS capacitor:// scheme too', () => {
    expect(() =>
      resolveApiBaseUrl({ isNative: true, isProd: true, origin: 'capacitor://localhost' })
    ).toThrow(/absolute API base URL/);
  });

  it('throws for an http origin (never a legitimate portal host)', () => {
    expect(() =>
      resolveApiBaseUrl({ isNative: true, isProd: true, origin: 'http://10.0.2.2:8080' })
    ).toThrow(/absolute API base URL/);
  });
});

/**
 * Under OTA, an unreachable portal must not leave the teacher on a raw WebView
 * error page. Found on the emulator: with the portal down at launch the app
 * showed Android's "Webpage not available / net::ERR_CONNECTION_REFUSED".
 * Capacitor does NOT fall back to the bundled assets by itself; it loads
 * `server.errorPath` from the bundled local server (https://localhost/<file>).
 * Navigating from there to the bundled app at https://localhost/ is an
 * off-origin navigation once server.url is set, and was handed to the system
 * browser — also verified on the emulator. So the page offers a Retry that
 * reloads the portal itself, the app's own host.
 */
describe('OTA: an unreachable portal shows a bundled retry page', () => {
  const fs = require('fs');
  const path = require('path');
  const PORTAL = path.join(__dirname, '../../portal');
  const config = fs
    .readFileSync(path.join(PORTAL, 'capacitor.config.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const FALLBACK = path.join(PORTAL, 'public/ota-fallback.html');
  const html = () => fs.readFileSync(FALLBACK, 'utf8');

  it('sets server.errorPath together with server.url, never on its own', () => {
    expect(config).toMatch(/otaUrl\s*\?\s*\{\s*url:\s*otaUrl,\s*errorPath:\s*`ota-fallback\.html\?u=\$\{encodeURIComponent\(otaUrl\)\}`\s*\}/);
  });

  it('ships the page in the bundle (portal/public/ is copied to dist/)', () => {
    expect(fs.existsSync(FALLBACK)).toBe(true);
  });

  it('retries the portal url it was given, and only an https one', () => {
    expect(html()).toMatch(/URLSearchParams\(location\.search\)\.get\(['"]u['"]\)/);
    expect(html()).toMatch(/protocol\s*===\s*['"]https:['"]/);
    expect(html()).toMatch(/location\.replace\(/);
  });

  it('never navigates to the bundled origin (that leaves the app)', () => {
    expect(html()).not.toMatch(/location\.(replace|assign)\(\s*['"]\//);
  });

  it('loads nothing from the network (it must work offline)', () => {
    expect(html()).not.toMatch(/(src|href)\s*=\s*["']https?:/i);
  });
});
