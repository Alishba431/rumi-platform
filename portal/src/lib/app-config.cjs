/**
 * The Android app's identity and host — one config for every build step.
 *
 * Everything an adopter changes to ship their own portal app lives here:
 *
 *   VITE_API_BASE_URL  absolute https url of the portal API
 *                      (e.g. https://portal.example.org/api/portal)
 *   PORTAL_APP_ID      Android package id, e.g. org.yourschool.portal
 *   PORTAL_APP_NAME    launcher label
 *   PORTAL_APP_OTA     1 = load the SPA from the live portal (see app-target.cjs)
 *
 * Each is read from the environment first, then from `portal/.env.app`, then
 * a neutral default. app/build.gradle reads the same keys in the same order, so
 * the APK's package id, label and App Links host cannot disagree with what
 * Capacitor was told.
 *
 * Why the file read: capacitor.config.ts is plain Node at `cap sync` time —
 * Vite is not involved, so `.env.app` is NOT loaded for it. Reading only
 * process.env makes a local build silently see `undefined` and drop every
 * derived value (OTA off, no allowNavigation) while still building green. The
 * environment wins so CI, which sets real values, is never overridden by a
 * stale local file.
 *
 * Kept as CommonJS with no imports beyond fs/path so the same file is testable
 * under the repo's Jest runner (same as app-target.cjs).
 */

const fs = require('fs');
const path = require('path');

/** Placeholder package id. Fine for a debug build; a release refuses it. */
const DEFAULT_APP_ID = 'org.example.rumi.portal';
const DEFAULT_APP_NAME = 'Rumi Portal';
const ENV_APP_PATH = path.join(__dirname, '..', '..', '.env.app');

// Java package name: two or more dot-separated identifiers.
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** KEY=value lines → object. Comments (whole-line or inline), blanks and junk are skipped. */
function parseEnvFile(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    // Same as Vite's dotenv: a quoted value is taken whole ('#' and all), an
    // unquoted one ends at '#' (an inline comment).
    const quoted = m[2].match(/^(['"])(.*)\1\s*(?:#.*)?$/);
    out[m[1]] = quoted ? quoted[2] : m[2].replace(/#.*$/, '').trim();
  }
  return out;
}

function readEnvAppFile() {
  try {
    return fs.readFileSync(ENV_APP_PATH, 'utf8');
  } catch {
    // No .env.app (a web build, or CI supplying values as env) — fine.
    return '';
  }
}

/**
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]  usually process.env
 * @param {string} [opts.envFileText]  contents of .env.app (read from disk if omitted)
 * @returns {{apiBaseUrl: string|undefined, appId: string, appName: string, ota: boolean, isPlaceholderId: boolean}}
 */
function readAppConfig({ env = process.env, envFileText } = {}) {
  const file = parseEnvFile(envFileText === undefined ? readEnvAppFile() : envFileText);
  const pick = (key) => {
    const fromEnv = env[key];
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
    const fromFile = file[key];
    return typeof fromFile === 'string' && fromFile.trim() ? fromFile.trim() : undefined;
  };

  const appId = pick('PORTAL_APP_ID') || DEFAULT_APP_ID;
  // A store identifies an app by package id permanently, so a typo here is not
  // a warning — it is a listing you can never update. Fail the build.
  if (!PACKAGE_RE.test(appId)) {
    throw new Error(
      `PORTAL_APP_ID "${appId}" is not a valid Android package id ` +
        '(two or more dot-separated identifiers, e.g. org.yourschool.portal).'
    );
  }

  return {
    apiBaseUrl: pick('VITE_API_BASE_URL'),
    appId,
    appName: pick('PORTAL_APP_NAME') || DEFAULT_APP_NAME,
    ota: pick('PORTAL_APP_OTA') === '1',
    isPlaceholderId: appId.startsWith('org.example.'),
  };
}

module.exports = { DEFAULT_APP_ID, DEFAULT_APP_NAME, parseEnvFile, readAppConfig };
