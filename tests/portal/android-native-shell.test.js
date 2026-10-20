/**
 * The Android native shell (portal/android/) — what must be true of the APK.
 *
 * None of these can ship over the air: they compile into the APK, so a mistake
 * here reaches teachers only through a new app release. Reading the Gradle,
 * manifest and Java files as text is deliberate — every failure below is a
 * one-line edit in exactly these files, and asserting on them catches it
 * before a 25-minute Android build does (or doesn't).
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_APP_ID } = require('../../portal/src/lib/app-config.cjs');

const ANDROID = path.join(__dirname, '../../portal/android');
const read = (p) => fs.readFileSync(path.join(ANDROID, p), 'utf8');
const stripXmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripCodeComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const gradleRaw = read('app/build.gradle');
const gradle = stripCodeComments(gradleRaw);

/** The body of a named buildTypes block. */
function buildTypeBlock(name) {
  const start = gradle.indexOf(`${name} {`, gradle.indexOf('buildTypes'));
  if (start === -1) return '';
  let depth = 0;
  for (let i = gradle.indexOf('{', start); i < gradle.length; i++) {
    if (gradle[i] === '{') depth++;
    if (gradle[i] === '}') {
      depth--;
      if (depth === 0) return gradle.slice(start, i + 1);
    }
  }
  return '';
}

describe('identity — the package id is the adopter\'s, never a literal in source', () => {
  it('applicationId comes from the shared config (PORTAL_APP_ID), not a hardcoded string', () => {
    expect(gradle).toMatch(/applicationId\s+portalAppId\b/);
    expect(gradle).not.toMatch(/applicationId\s+["']/);
    expect(gradle).toMatch(/['"]PORTAL_APP_ID['"]/);
  });

  it('falls back to the same neutral default the Node side uses', () => {
    expect(gradle).toContain(`'${DEFAULT_APP_ID}'`);
  });

  it('reads config from the environment first, then portal/.env.app', () => {
    expect(gradle).toMatch(/System\.getenv\(/);
    expect(gradle).toMatch(/\.env\.app/);
  });

  it('the launcher label comes from PORTAL_APP_NAME', () => {
    expect(gradle).toMatch(/['"]PORTAL_APP_NAME['"]/);
    expect(gradle).toMatch(/appLabel\s*:\s*portalAppName/);
  });

  it('the release build type carries NO applicationIdSuffix', () => {
    expect(buildTypeBlock('release')).not.toBe('');
    expect(buildTypeBlock('release')).not.toMatch(/applicationIdSuffix/);
  });

  it('debug builds install beside the release app under a .debug suffix', () => {
    expect(buildTypeBlock('debug')).toMatch(/applicationIdSuffix\s+["']\.debug["']/);
  });

  it('a release build refuses the placeholder package id (pick your id once)', () => {
    // A store identifies an app by package id permanently. Publishing the
    // example id would lock an adopter to a placeholder forever.
    expect(gradle).toMatch(/isPlaceholderAppId/);
    expect(gradle).toMatch(/org\.example\./);
    expect(gradle).toMatch(/Release/);
    expect(gradle).toMatch(/GradleException/);
  });

  it('signs releases from PORTAL_* environment only — no literal passwords', () => {
    for (const k of ['PORTAL_KEYSTORE_PATH', 'PORTAL_KEYSTORE_PASSWORD', 'PORTAL_KEY_ALIAS', 'PORTAL_KEY_PASSWORD']) {
      expect(gradle).toContain(k);
    }
    expect(gradle).not.toMatch(/storePassword\s+['"]/);
    expect(gradle).not.toMatch(/keyPassword\s+['"]/);
  });

  it('versionCode is configurable and numeric by default', () => {
    expect(gradle).toMatch(/PORTAL_APP_VERSION_CODE/);
    expect(gradle).toMatch(/versionCode\s+portalVersionCode/);
  });
});

describe('AndroidManifest — App Links intent filter', () => {
  const manifest = stripXmlComments(read('app/src/main/AndroidManifest.xml'));
  const activity = (manifest.match(/<activity[\s\S]*?<\/activity>/) || [''])[0];
  const filters = activity.match(/<intent-filter[\s\S]*?<\/intent-filter>/g) || [];
  const appLinks = filters.find((f) => /android\.intent\.action\.VIEW/.test(f)) || '';
  const dataPaths = [...appLinks.matchAll(/android:path="([^"]*)"/g)].map((m) => m[1]).sort();

  it('declares a VIEW filter on MainActivity with autoVerify', () => {
    expect(activity).toMatch(/android:name="\.MainActivity"/);
    expect(appLinks).toMatch(/<intent-filter[^>]*android:autoVerify="true"/);
  });

  it('is browsable from other apps (chat apps, the browser)', () => {
    expect(appLinks).toMatch(/android:name="android\.intent\.category\.DEFAULT"/);
    expect(appLinks).toMatch(/android:name="android\.intent\.category\.BROWSABLE"/);
  });

  it('claims https on the build-configured host only', () => {
    const schemes = [...appLinks.matchAll(/android:scheme="([^"]*)"/g)].map((m) => m[1]);
    const hosts = [...appLinks.matchAll(/android:host="([^"]*)"/g)].map((m) => m[1]);
    expect(schemes).toEqual(['https']);
    expect(hosts).toEqual(['${deepLinkHost}']);
  });

  it('claims exactly /portal/dashboard and /portal/login — nothing broader', () => {
    expect(dataPaths).toEqual(['/portal/dashboard', '/portal/login']);
    expect(manifest).not.toMatch(/android:path(Prefix|Pattern|AdvancedPattern|Suffix)=/);
  });

  it('keeps the launcher entry and singleTask (links reuse the running app)', () => {
    expect(activity).toMatch(/android\.intent\.category\.LAUNCHER/);
    expect(activity).toMatch(/android:launchMode="singleTask"/);
  });

  it('asks only for INTERNET', () => {
    const perms = [...manifest.matchAll(/uses-permission\s+android:name="([^"]+)"/g)].map((m) => m[1]);
    expect(perms).toEqual(['android.permission.INTERNET']);
  });
});

describe('build.gradle — the App Links host comes from VITE_API_BASE_URL', () => {
  it('supplies the deepLinkHost manifest placeholder', () => {
    expect(gradle).toMatch(/manifestPlaceholders[\s\S]*deepLinkHost/);
  });

  it('fails the build loudly when no https host can be derived', () => {
    expect(gradle).toMatch(/['"]VITE_API_BASE_URL['"]/);
    expect(gradle).toMatch(/preBuild/);
    expect(gradle).toMatch(/No https host for Android App Links/);
  });
});

describe('@capacitor/app — hands links and the back key to the web code', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../portal/package.json'), 'utf8'));
  const major = (v) => String(v || '').replace(/^[^\d]*/, '').split('.')[0];

  it('is a dependency at the same major as @capacitor/core and /android', () => {
    expect(pkg.dependencies['@capacitor/app']).toBeDefined();
    expect(major(pkg.dependencies['@capacitor/app'])).toBe(major(pkg.dependencies['@capacitor/core']));
    expect(major(pkg.dependencies['@capacitor/android'])).toBe(major(pkg.dependencies['@capacitor/core']));
  });

  it('is registered in the native project (cap sync output is committed)', () => {
    expect(read('capacitor.settings.gradle')).toMatch(/include ':capacitor-app'/);
    expect(read('app/capacitor.build.gradle')).toMatch(/implementation project\(':capacitor-app'\)/);
  });
});

describe('session persistence — a force-close must not log the teacher out', () => {
  // The portal's session cookie is persistent (7-day Max-Age), but Android's
  // WebView keeps cookies in memory and flushes on its own schedule. A
  // swipe-away kills the process before that flush, so the next launch starts
  // with an empty cookie jar. Flushing in onPause persists it the moment the
  // app is backgrounded. Real acceptance is on a device; this guards against a
  // regression to the empty `extends BridgeActivity {}` stub.
  const javaDir = path.join('app/src/main/java', ...DEFAULT_APP_ID.split('.'));
  const code = stripCodeComments(read(path.join(javaDir, 'MainActivity.java')));

  it('lives in the neutral namespace package', () => {
    expect(code).toMatch(new RegExp(`^\\s*package\\s+${DEFAULT_APP_ID.replace(/\./g, '\\.')};`, 'm'));
    expect(gradle).toMatch(new RegExp(`namespace\\s*=\\s*["']${DEFAULT_APP_ID.replace(/\./g, '\\.')}["']`));
  });

  it('overrides onPause and calls super', () => {
    expect(code).toMatch(/@Override\s+public\s+void\s+onPause\s*\(\s*\)/);
    expect(code).toMatch(/super\.onPause\s*\(\s*\)/);
  });

  it('flushes the WebView CookieManager to disk', () => {
    expect(code).toMatch(/CookieManager\.getInstance\s*\(\s*\)\s*\.flush\s*\(\s*\)/);
  });
});

describe('backup — the session cookie never leaves the device in a cloud backup', () => {
  // The app's whole state is a 7-day session cookie in the WebView's store
  // (app_webview). The Capacitor template's allowBackup="true" would copy it
  // into the user's cloud backup and restore it onto another device.
  const manifest = stripXmlComments(read('app/src/main/AndroidManifest.xml'));
  const application = (manifest.match(/<application[^>]*>/) || [''])[0];

  it('turns app backup off', () => {
    expect(application).toMatch(/android:allowBackup="false"/);
  });
});

describe('no generated or secret files are committed', () => {
  const gitignore = read('.gitignore');

  it.each(['keystore.properties', '*.jks', '*.keystore', 'app/src/main/assets/public', 'local.properties'])(
    'android/.gitignore excludes %s',
    (entry) => {
      expect(gitignore.split('\n').map((l) => l.trim())).toContain(entry);
    }
  );

  it('portal/.gitignore excludes .env.app (it carries a deployment host)', () => {
    const portalIgnore = fs.readFileSync(path.join(__dirname, '../../portal/.gitignore'), 'utf8');
    expect(portalIgnore.split('\n').map((l) => l.trim())).toContain('.env.app');
  });
});
