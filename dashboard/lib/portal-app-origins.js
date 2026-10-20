/**
 * What the portal API must allow for the Android/iOS portal app.
 *
 * A bundled Capacitor app serves its pages from a local origin with no port —
 * `https://localhost` on Android (androidScheme 'https'), `capacitor://localhost`
 * on iOS — while the API stays on the portal host. Without these origins in the
 * CORS allow-list the app's preflight gets no Access-Control-Allow-Origin and
 * every API call is blocked before it is sent, which presents as "correct
 * password won't log in": a CORS error, not an auth error.
 *
 * The app's origin is also cross-site to the API, so a SameSite=lax session
 * cookie is never stored or returned and login silently fails on the request
 * after /login. The app needs SameSite=none. But one cookie carries both the
 * portal and the admin (/observability) session, and the dashboard has no CSRF
 * token and accepts form posts: a SameSite=none admin cookie would ride along
 * on a form any website auto-submits, and CORS does not stop a form post. So:
 *
 *   - the global session cookie is always 'lax' (sessionCookieOptions);
 *   - only a portal login or setup whose Origin is one of the app origins, with
 *     PORTAL_APP_ENABLED on, widens THAT session to 'none'
 *     (widenPortalAppSession). That cookie lives in the app's own WebView,
 *     which only navigates to the API host;
 *   - a session touched anywhere outside /api/portal is put back to 'lax'
 *     (keepSessionsLaxOutsidePortalApi), so an admin login can never inherit
 *     an app session's 'none'.
 *
 * Kept as its own tiny module so the rules are unit-testable without booting
 * the Express app.
 */

const APP_ORIGINS = ['https://localhost', 'capacitor://localhost'];

// Vite dev server and local static server, for running the portal locally.
const LOCAL_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
];

/** PORTAL_APP_ENABLED: this deployment ships the bundled portal app. Off unless set. */
function isPortalAppEnabled(env = process.env) {
  const raw = typeof env.PORTAL_APP_ENABLED === 'string' ? env.PORTAL_APP_ENABLED.trim().toLowerCase() : '';
  return ['true', '1', 'yes', 'on'].includes(raw);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.portalUrl]  PORTAL_URL without a trailing slash
 * @param {string[]} [opts.websiteOrigins]  the public website's origins
 * @param {boolean} [opts.appEnabled]  add the app origins (isPortalAppEnabled)
 * @returns {string[]} the credentialed CORS allow-list for /api/portal
 */
function buildPortalCorsOrigins({ portalUrl, websiteOrigins = [], appEnabled = false } = {}) {
  const configured = [portalUrl, ...websiteOrigins].filter(
    (o) => typeof o === 'string' && o && o !== '*'
  );
  return [...new Set([...configured, ...LOCAL_DEV_ORIGINS, ...(appEnabled ? APP_ORIGINS : [])])];
}

/** express-session `cookie` for the dashboard's one global session. Always 'lax'. */
function sessionCookieOptions() {
  return {
    secure: true, // HTTPS only
    httpOnly: true, // Prevents client-side JS from accessing cookie
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  };
}

/**
 * Call right after a portal login/setup regenerates the session. Widens this
 * one session to SameSite=none when it was created by the bundled app.
 * @returns {boolean} whether the session was widened
 */
function widenPortalAppSession(req, env = process.env) {
  const origin = typeof req.get === 'function' ? req.get('origin') : undefined;
  if (!isPortalAppEnabled(env) || !APP_ORIGINS.includes(origin)) return false;
  req.session.cookie.sameSite = 'none';
  return true;
}

const PORTAL_API_PREFIX = '/api/portal';

/** Mounted straight after the session middleware: 'none' never leaves /api/portal. */
function keepSessionsLaxOutsidePortalApi(req, res, next) {
  const url = req.originalUrl || req.url || '';
  const inPortalApi = url === PORTAL_API_PREFIX || url.startsWith(`${PORTAL_API_PREFIX}/`) || url.startsWith(`${PORTAL_API_PREFIX}?`);
  if (!inPortalApi && req.session && req.session.cookie && req.session.cookie.sameSite === 'none') {
    req.session.cookie.sameSite = 'lax';
  }
  next();
}

module.exports = {
  APP_ORIGINS,
  buildPortalCorsOrigins,
  isPortalAppEnabled,
  keepSessionsLaxOutsidePortalApi,
  sessionCookieOptions,
  widenPortalAppSession,
};
