/**
 * One version, read from package.json. bot/VERSION was last bumped at 1.1.0
 * and every reader preferred it, so a 2.x deployment told /health, the boot
 * banner, the console and the update check that it was 1.1.0. The file is
 * gone; nothing may read a VERSION file again.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('the version has one source', () => {
  it('has no bot/VERSION file', () => {
    expect(fs.existsSync(path.join(ROOT, 'bot/VERSION'))).toBe(false);
  });

  it.each(['bot/whatsapp-bot.js', 'bot/console/routes/pages.js', 'dashboard/index.js'])(
    '%s reads no VERSION file',
    (rel) => {
      expect(read(rel)).not.toMatch(/['"](?:\.\.\/)*VERSION['"]/);
    },
  );

  it('rumiVersion() is the bot package version, which is the release version', () => {
    const { rumiVersion } = require('../../bot/shared/utils/version');
    const botPkg = JSON.parse(read('bot/package.json'));
    const rootPkg = JSON.parse(read('package.json'));
    expect(rumiVersion()).toBe(botPkg.version);
    expect(botPkg.version).toBe(rootPkg.version);
  });

  // The dashboard deploys with dashboard/ as its root (dashboard/railway.toml),
  // where ../package.json is absent, so /health falls back to its own
  // package.json. That copy has to move in lockstep or the dashboard reports
  // an old release.
  it('dashboard/package.json (and its lockfile) carry the same version', () => {
    const rootPkg = JSON.parse(read('package.json'));
    const dashPkg = JSON.parse(read('dashboard/package.json'));
    const dashLock = JSON.parse(read('dashboard/package-lock.json'));
    expect(dashPkg.version).toBe(rootPkg.version);
    expect(dashLock.version).toBe(rootPkg.version);
    expect(dashLock.packages[''].version).toBe(rootPkg.version);
  });
});
