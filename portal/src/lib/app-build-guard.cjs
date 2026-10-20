/**
 * Refuse to build an app bundle that would white-screen.
 *
 * `vite build --mode app` bakes VITE_API_BASE_URL into the bundle the APK
 * ships. Without an absolute https url the build still succeeds — and the app
 * then throws at first render (resolveApiBaseUrl in app-target.cjs), because a
 * relative path resolves to https://localhost where nothing is listening. Loud
 * at runtime is not enough: the wrong bundle should be unbuildable.
 *
 * Called from vite.config.ts with the env Vite loaded for the mode (which
 * includes portal/.env.app for `--mode app`). Web builds are never affected.
 */

function assertAppBuildConfig({ mode, env = {} } = {}) {
  if (mode !== 'app') return;
  const raw = typeof env.VITE_API_BASE_URL === 'string' ? env.VITE_API_BASE_URL.trim() : '';
  let ok = false;
  try {
    const url = new URL(raw);
    // https only: the app's WebView is an https origin, so an http API is
    // mixed content, and a Secure session cookie is never sent over http.
    ok = url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      'App build needs an absolute https VITE_API_BASE_URL (in portal/.env.app or the environment), ' +
        `e.g. https://portal.example.org/api/portal. Got: ${raw || '(unset)'}`
    );
  }
}

module.exports = { assertAppBuildConfig };
