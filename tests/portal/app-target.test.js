/**
 * Portal app-target resolution.
 *
 * Two decisions the portal SPA makes that are correct on the web and WRONG
 * inside a Capacitor WebView, because the WebView serves the bundle from
 * https://localhost rather than the portal's own origin:
 *
 *   1. "Am I the portal or the marketing site?" — decided by sniffing
 *      `window.location.hostname.startsWith('portal.')`, which is false on
 *      localhost, so the app would open the marketing splash.
 *   2. "Where is the API?" — a relative '/api/portal' in prod builds, which
 *      resolves to https://localhost/api/portal in the app, where nothing is
 *      listening.
 *
 * Both live in a pure module so they're testable without a DOM or a browser.
 * Web behaviour must be unchanged — that's asserted here too.
 */

const {
  resolveIsPortal,
  resolveApiBaseUrl,
} = require('../../portal/src/lib/app-target.cjs');

describe('resolveIsPortal', () => {
  describe('native app (Capacitor)', () => {
    it('is the portal even though the hostname is localhost', () => {
      expect(resolveIsPortal({ isNative: true, hostname: 'localhost' })).toBe(true);
    });

    it('is the portal regardless of hostname', () => {
      expect(resolveIsPortal({ isNative: true, hostname: 'example.com' })).toBe(true);
    });
  });

  describe('explicit build flag', () => {
    it('treats appTarget "app" as the portal', () => {
      expect(resolveIsPortal({ appTarget: 'app', hostname: 'localhost' })).toBe(true);
    });

    it('does not let appTarget "web" override a portal subdomain', () => {
      expect(resolveIsPortal({ appTarget: 'web', hostname: 'portal.example.org' })).toBe(true);
    });
  });

  describe('web fallback (unchanged behaviour)', () => {
    it('is the portal on a portal.* subdomain', () => {
      expect(resolveIsPortal({ hostname: 'portal.example.org' })).toBe(true);
    });

    it('is NOT the portal on the bare marketing host', () => {
      expect(resolveIsPortal({ hostname: 'example.org' })).toBe(false);
    });

    it('is NOT the portal on localhost in a plain browser', () => {
      expect(resolveIsPortal({ hostname: 'localhost' })).toBe(false);
    });

    it('does not match a host that merely contains "portal."', () => {
      expect(resolveIsPortal({ hostname: 'myportal.example.com' })).toBe(false);
    });
  });
});

describe('resolveApiBaseUrl', () => {
  describe('native app (Capacitor)', () => {
    it('uses the configured absolute base URL', () => {
      expect(
        resolveApiBaseUrl({
          isNative: true,
          isProd: true,
          apiBaseUrl: 'https://portal.example.com/api/portal',
        })
      ).toBe('https://portal.example.com/api/portal');
    });

    it('throws when no absolute URL is configured — a relative path cannot work in the app', () => {
      expect(() => resolveApiBaseUrl({ isNative: true, isProd: true })).toThrow(
        /absolute API base URL/i
      );
    });

    it('rejects a relative configured value', () => {
      expect(() =>
        resolveApiBaseUrl({ isNative: true, isProd: true, apiBaseUrl: '/api/portal' })
      ).toThrow(/absolute API base URL/i);
    });

    it('strips a trailing slash so request paths do not double up', () => {
      expect(
        resolveApiBaseUrl({
          isNative: true,
          isProd: true,
          apiBaseUrl: 'https://portal.example.com/api/portal/',
        })
      ).toBe('https://portal.example.com/api/portal');
    });
  });

  describe('web (unchanged behaviour)', () => {
    it('uses the same-origin relative path in production', () => {
      expect(resolveApiBaseUrl({ isProd: true })).toBe('/api/portal');
    });

    it('uses the local dev server when not production', () => {
      expect(resolveApiBaseUrl({ isProd: false })).toBe('http://localhost:4000/api/portal');
    });

    it('still honours an explicit absolute override on the web', () => {
      expect(
        resolveApiBaseUrl({ isProd: true, apiBaseUrl: 'https://staging.example.com/api/portal' })
      ).toBe('https://staging.example.com/api/portal');
    });
  });
});
