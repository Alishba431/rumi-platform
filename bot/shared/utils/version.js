/**
 * The running Rumi version: bot/package.json, bumped with the root
 * package.json at every release. The single source for /health, the boot
 * banner, the console and the update check. (A separate VERSION file used to
 * override it and was never bumped past 1.1.0.)
 */
function rumiVersion() {
  return require('../../package.json').version;
}

module.exports = { rumiVersion };
