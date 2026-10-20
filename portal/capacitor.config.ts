import type { CapacitorConfig } from '@capacitor/cli';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveOtaUrl } = require('./src/lib/app-target.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readAppConfig } = require('./src/lib/app-config.cjs');

/**
 * Package id, label, API host and OTA switch — from the environment, then
 * `.env.app`, then neutral defaults (src/lib/app-config.cjs). This file is
 * plain Node at `cap sync` time, so Vite's `.env.app` loading does not apply
 * here; readAppConfig() reads the file itself.
 */
const appConfig = readAppConfig();
const apiBaseUrl = appConfig.apiBaseUrl;

/**
 * Remote-first OTA origin, or undefined to use the assets bundled in the APK.
 *
 * OPT-IN, not default: `PORTAL_APP_OTA=1` turns it on for a build. A build
 * without it loads its bundled assets, so OTA can be rolled out one build at a
 * time and switched off by rebuilding rather than by an emergency patch.
 *
 * Derived from VITE_API_BASE_URL — the same value the app uses for its API —
 * so there is one configured host, not two that can disagree.
 */
const otaUrl: string | null = appConfig.ota ? resolveOtaUrl({ isNative: true, apiBaseUrl }) : null;

/**
 * Hosts the WebView may navigate to WITHOUT handing off to the system browser.
 *
 * A bundled app runs on `https://localhost`, so every link to the portal API's
 * own origin is a CROSS-ORIGIN navigation — and Capacitor's default is to treat
 * any off-origin navigation as an external site and pass it to the browser.
 * The browser holds none of the WebView's session cookies, so the request
 * arrives unauthenticated and the portal answers 401 "Not authenticated".
 * That is not a `target="_blank"` problem: it happens with no target at all.
 *
 * Derived from VITE_API_BASE_URL so the allowlist can never drift from the
 * host actually being called.
 *
 * Returns [] when unset or unparseable rather than throwing: this runs at
 * native build time, and a throw here fails the build for a value that is
 * legitimately absent in a web build.
 */
function allowedNavigationHosts(raw?: string): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const { hostname, protocol } = new URL(raw.trim());
    // https only — a WebView navigating over http is mixed content.
    if (protocol !== 'https:' || !hostname) return [];
    return [hostname];
  } catch {
    return [];
  }
}

const navHosts = allowedNavigationHosts(apiBaseUrl);

/**
 * The portal Android app: a WebView wrap of the teacher portal SPA.
 *
 * appId is chosen ONCE. A store identifies an app by package id permanently;
 * changing it later creates a second, unrelated listing that cannot upgrade
 * the first. The default `org.example.rumi.portal` is a placeholder — release
 * builds refuse it (android/app/build.gradle).
 *
 * `hostname: 'localhost'` is why the portal needs the app-target logic:
 * hostname-sniffing to decide "am I the portal?" is false in the WebView.
 *
 * `loggingBehavior: 'production'` is deliberate — Capacitor's Android bridge
 * can exhaust memory on unbounded console output.
 */
const config: CapacitorConfig = {
  appId: appConfig.appId,
  appName: appConfig.appName,
  webDir: 'dist',
  loggingBehavior: 'production',
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
    // Keep in-app navigations to the configured API host in the WebView instead
    // of handing them to the browser (which has no session cookie → 401).
    // Omitted entirely when empty, so a web build is unaffected.
    ...(navHosts.length ? { allowNavigation: navHosts } : {}),
    // Remote-first OTA: the WebView loads the SPA from the live portal instead
    // of the copy bundled in the APK, so a web deploy updates every installed
    // app on next launch. If the origin can't be derived this stays undefined
    // and Capacitor uses the bundled assets — a known-good floor rather than a
    // blank shell. The bundled build still ships and still must be correct: it
    // is what runs whenever OTA is off. If the portal is unreachable at launch,
    // Capacitor does not fall back by itself — without errorPath the
    // teacher gets Android's raw "Webpage not available". errorPath is served
    // from the bundled assets (https://localhost/ota-fallback.html): a "can't
    // reach the portal" page whose Retry reloads the portal url passed in ?u=.
    ...(otaUrl ? { url: otaUrl, errorPath: `ota-fallback.html?u=${encodeURIComponent(otaUrl)}` } : {}),
  },
  plugins: {
    // @capacitor/app hands tapped App Links to the web code (`appUrlOpen`, see
    // AppLinkListener) and owns the hardware back key. Its back handler starts
    // OFF here, in the APK, and BackButtonHandler switches it on at runtime
    // (toggleBackButtonHandler). So back-key behaviour ships over the air, and
    // a portal rolled back to a bundle without that component leaves the back
    // key at Android's default. Left on with no web listener, the plugin would
    // instead go back in WebView history and, at the first page, do nothing —
    // the app could not be left with back.
    App: {
      disableBackButtonHandler: true,
    },
  },
};

export default config;
