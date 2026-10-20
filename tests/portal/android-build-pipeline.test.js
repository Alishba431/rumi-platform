/**
 * The Android build pipeline must not depend on a human typing the right flag.
 *
 * `vite build --mode app` is the step that loads portal/.env.app and bakes the
 * absolute VITE_API_BASE_URL into the bundle. Forget the flag and the build
 * still succeeds — with a WEB-mode bundle that throws at first render inside
 * the app: a white screen on every launch. So:
 *
 *   1. The native build is a named script, not a remembered flag.
 *   2. An app-mode build with no absolute https API url REFUSES to build
 *      (assertAppBuildConfig, called from vite.config.ts), rather than
 *      producing an APK that white-screens.
 *   3. CI builds a debug APK through the same scripts on every PR that touches
 *      portal/**, and checks the bundle really is app-mode.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'portal/package.json'), 'utf8'));
const { assertAppBuildConfig } = require('../../portal/src/lib/app-build-guard.cjs');

describe('the native build is a named command', () => {
  it('build:app builds in app mode', () => {
    expect(pkg.scripts['build:app']).toMatch(/vite build --mode app/);
  });

  it('the plain build script stays web-mode (one codebase, two targets)', () => {
    expect(pkg.scripts.build).not.toMatch(/--mode\s+app/);
  });

  it('android:sync builds the app bundle before syncing the native project', () => {
    expect(pkg.scripts['android:sync']).toMatch(/npm run build:app\s*&&\s*cap sync android/);
  });

  it.each([
    ['android:debug', /android:sync[\s\S]*assembleDebug/],
    ['android:release', /android:sync[\s\S]*assembleRelease[\s\S]*bundleRelease|android:sync[\s\S]*bundleRelease[\s\S]*assembleRelease/],
  ])('%s goes through android:sync', (name, re) => {
    expect(pkg.scripts[name]).toMatch(re);
  });
});

describe('assertAppBuildConfig — an app-mode build without a usable API url fails', () => {
  it('passes a web build untouched, whatever the env', () => {
    expect(() => assertAppBuildConfig({ mode: 'production', env: {} })).not.toThrow();
    expect(() => assertAppBuildConfig({ mode: 'development', env: {} })).not.toThrow();
  });

  it('passes an app build with an absolute https API url', () => {
    expect(() =>
      assertAppBuildConfig({ mode: 'app', env: { VITE_API_BASE_URL: 'https://portal.example.org/api/portal' } })
    ).not.toThrow();
  });

  it.each([
    ['unset', {}],
    ['blank', { VITE_API_BASE_URL: '  ' }],
    ['relative', { VITE_API_BASE_URL: '/api/portal' }],
    ['plain http', { VITE_API_BASE_URL: 'http://portal.example.org/api/portal' }],
    ['garbage', { VITE_API_BASE_URL: 'portal' }],
  ])('refuses an app build whose VITE_API_BASE_URL is %s', (_label, env) => {
    expect(() => assertAppBuildConfig({ mode: 'app', env })).toThrow(/VITE_API_BASE_URL/);
  });

  it('is wired into vite.config.ts with the env Vite loaded for the mode', () => {
    const vite = fs.readFileSync(path.join(REPO, 'portal/vite.config.ts'), 'utf8');
    expect(vite).toMatch(/assertAppBuildConfig\(\{\s*mode,\s*env:\s*loadEnv\(mode,/);
  });
});

describe('CI builds a debug APK for portal changes', () => {
  const WORKFLOW = path.join(REPO, '.github/workflows/portal-android-debug.yml');
  const wf = fs.existsSync(WORKFLOW) ? fs.readFileSync(WORKFLOW, 'utf8') : '';

  it('the workflow exists', () => {
    expect(wf).not.toBe('');
  });

  it('runs on pull requests that touch portal/**', () => {
    expect(wf).toMatch(/pull_request:[\s\S]*paths:[\s\S]*['"]portal\/\*\*['"]/);
  });

  it('builds through the package scripts and assembles a debug APK', () => {
    expect(wf).toMatch(/npm run android:sync/);
    expect(wf).toMatch(/assembleDebug/);
    expect(wf).toMatch(/upload-artifact/);
  });

  it('verifies the bundle is app-mode before assembling', () => {
    expect(wf).toMatch(/grep[^\n]*dist\/assets/);
  });

  it('pins JDK 21 (Capacitor 8 requires it)', () => {
    expect(wf).toMatch(/java-version:\s*['"]?21/);
  });

  it('runs Node 22 or newer (the Capacitor 8 CLI refuses older Node)', () => {
    const m = wf.match(/node-version:\s*['"]?(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(22);
  });

  it('uses no secrets — a debug build can run on any branch', () => {
    expect(wf).not.toMatch(/secrets\./);
  });
});

describe('the documented path uses the scripts', () => {
  const doc = fs.readFileSync(path.join(REPO, 'portal/ANDROID.md'), 'utf8');

  it('portal/ANDROID.md tells the reader to run the named scripts', () => {
    expect(doc).toMatch(/npm run android:debug/);
    expect(doc).toMatch(/npm run android:release/);
  });

  it('does not present a bare `vite build --mode app` as the step', () => {
    expect(/^\s*(npx )?vite build --mode app\s*$/m.test(doc)).toBe(false);
  });
});
