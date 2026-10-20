/**
 * A known advisory we ship on purpose is written down, with the reason.
 *
 * matrix-bot-sdk uses the deprecated `request` HTTP client, which has a
 * critical advisory and no fixed release. Anyone running `npm audit` in bot/
 * sees it, so SECURITY.md must say why it is accepted. When the SDK drops
 * `request` this test stops applying on its own (the lockfile no longer has
 * it) and the paragraph can go.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('accepted dependency advisories are documented', () => {
  const lock = JSON.parse(read('bot/package-lock.json'));
  const shipsRequest = Boolean(lock.packages['node_modules/request']);

  (shipsRequest ? it : it.skip)('SECURITY.md explains the request advisories matrix-bot-sdk brings in', () => {
    const security = read('SECURITY.md');
    const section = security.split(/^## /m).find((s) => s.startsWith('Accepted dependency advisories'));
    expect(section).toBeDefined();
    for (const pkg of ['request', 'form-data', 'tough-cookie', 'request-promise', 'sanitize-html', 'matrix-bot-sdk']) {
      expect(section).toContain(`\`${pkg}\``);
    }
    expect(section).toMatch(/MATRIX_HOMESERVER_URL/);
    expect(section).toMatch(/github\.com\/turt2live\/matrix-bot-sdk\/issues\/90/);
  });
});
