/**
 * The portal app's identity and host come from ONE config, not from source.
 *
 * Every value an adopter changes to ship their own portal app — package id,
 * launcher label, the portal API host, OTA on/off — is read from the
 * environment, then from `portal/.env.app`, and has a neutral default. Both
 * capacitor.config.ts (plain Node at `cap sync` time) and app/build.gradle
 * (Gradle) read the same keys, so the APK's package id, label and App Links
 * host cannot disagree with what Capacitor was told.
 *
 * Why env-then-file: capacitor.config.ts is NOT run by Vite, so `.env.app` is
 * not loaded for it. Reading only process.env makes a local build silently see
 * `undefined` and drop every derived value (OTA off, no allowNavigation) while
 * still building green. CI sets real env vars, which must win over the file.
 */

const {
  DEFAULT_APP_ID,
  DEFAULT_APP_NAME,
  parseEnvFile,
  readAppConfig,
} = require('../../portal/src/lib/app-config.cjs');

describe('parseEnvFile', () => {
  it('reads KEY=value lines, ignoring comments and blanks', () => {
    expect(parseEnvFile('# a comment\n\nA=1\n  B = two words  \n')).toEqual({ A: '1', B: 'two words' });
  });

  it('strips one pair of surrounding quotes', () => {
    expect(parseEnvFile(`A="x"\nB='y'`)).toEqual({ A: 'x', B: 'y' });
  });

  // Vite reads the same file with dotenv, which ends an unquoted value at '#'.
  // Reading "1 # on" as the value would silently build with OTA off.
  it('drops an inline comment after an unquoted value, as dotenv does', () => {
    expect(parseEnvFile('PORTAL_APP_OTA=1 # on\nVITE_API_BASE_URL=https://portal.example.org/api/portal  # prod')).toEqual({
      PORTAL_APP_OTA: '1',
      VITE_API_BASE_URL: 'https://portal.example.org/api/portal',
    });
  });

  it('keeps a # inside quotes, and drops a comment after the closing quote', () => {
    expect(parseEnvFile(`A="x # y"  # note\nB='p#q'`)).toEqual({ A: 'x # y', B: 'p#q' });
  });

  it('agrees with readAppConfig: an inline comment does not switch OTA off', () => {
    const cfg = readAppConfig({ env: {}, envFileText: 'VITE_API_BASE_URL=https://portal.example.org/api/portal\nPORTAL_APP_OTA=1 # on\n' });
    expect(cfg.ota).toBe(true);
  });

  it('tolerates junk without throwing', () => {
    expect(parseEnvFile('not a pair\n=novalue\n')).toEqual({});
    expect(parseEnvFile(undefined)).toEqual({});
  });
});

describe('readAppConfig', () => {
  it('ships neutral defaults — no deployment is named in source', () => {
    const cfg = readAppConfig({ env: {}, envFileText: '' });
    expect(cfg.appId).toBe(DEFAULT_APP_ID);
    expect(cfg.appName).toBe(DEFAULT_APP_NAME);
    expect(DEFAULT_APP_ID).toBe('org.example.rumi.portal');
    expect(cfg.isPlaceholderId).toBe(true);
    expect(cfg.apiBaseUrl).toBeUndefined();
    expect(cfg.ota).toBe(false);
  });

  it('reads every value from .env.app when the environment is empty', () => {
    const cfg = readAppConfig({
      env: {},
      envFileText: [
        'VITE_API_BASE_URL=https://portal.example.org/api/portal',
        'PORTAL_APP_ID=org.school.portal',
        'PORTAL_APP_NAME="School Portal"',
        'PORTAL_APP_OTA=1',
      ].join('\n'),
    });
    expect(cfg).toMatchObject({
      apiBaseUrl: 'https://portal.example.org/api/portal',
      appId: 'org.school.portal',
      appName: 'School Portal',
      ota: true,
      isPlaceholderId: false,
    });
  });

  it('lets the environment win over the file (CI secrets beat a stale local file)', () => {
    const cfg = readAppConfig({
      env: { VITE_API_BASE_URL: 'https://ci.example.org/api/portal', PORTAL_APP_ID: 'org.ci.portal' },
      envFileText: 'VITE_API_BASE_URL=https://local.example.org/api/portal\nPORTAL_APP_ID=org.local.portal',
    });
    expect(cfg.apiBaseUrl).toBe('https://ci.example.org/api/portal');
    expect(cfg.appId).toBe('org.ci.portal');
  });

  it('treats a blank env var as unset, so it falls through to the file', () => {
    const cfg = readAppConfig({ env: { PORTAL_APP_NAME: '   ' }, envFileText: 'PORTAL_APP_NAME=From File' });
    expect(cfg.appName).toBe('From File');
  });

  it('turns OTA on only for an explicit 1', () => {
    for (const v of ['0', '', 'true', 'yes']) {
      expect(readAppConfig({ env: { PORTAL_APP_OTA: v }, envFileText: '' }).ota).toBe(false);
    }
    expect(readAppConfig({ env: { PORTAL_APP_OTA: '1' }, envFileText: '' }).ota).toBe(true);
  });

  it.each(['org example portal', 'portal', '1org.example', 'org..example', 'org.example.'])(
    'refuses an invalid package id %p loudly (a typo here is permanent once published)',
    (id) => {
      expect(() => readAppConfig({ env: { PORTAL_APP_ID: id }, envFileText: '' })).toThrow(/PORTAL_APP_ID/);
    }
  );

  it('reads portal/.env.app from disk when no text is passed', () => {
    // The live path capacitor.config.ts uses; absent file means defaults.
    expect(() => readAppConfig({ env: {} })).not.toThrow();
  });
});

describe('capacitor.config.ts uses the shared config, not literals', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs
    .readFileSync(path.join(__dirname, '../../portal/capacitor.config.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('takes appId and appName from readAppConfig()', () => {
    expect(src).toMatch(/readAppConfig\(\)/);
    expect(src).toMatch(/appId:\s*appConfig\.appId/);
    expect(src).toMatch(/appName:\s*appConfig\.appName/);
    expect(src).not.toMatch(/appId:\s*['"]/);
    expect(src).not.toMatch(/appName:\s*['"]/);
  });

  it('turns OTA on from the config flag only', () => {
    expect(src).toMatch(/appConfig\.ota\s*\?\s*resolveOtaUrl\(\{\s*isNative:\s*true,\s*apiBaseUrl\s*\}\)/);
  });
});
