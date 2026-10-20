/**
 * One Node policy, stated the same way everywhere: Node 22 or newer (Node 20
 * reached end-of-life in April 2026, and matrix-bot-sdk itself requires 22),
 * tested in CI on 22 and 24. Matrix end-to-end encryption runs on the same
 * floor: matrix-bot-sdk encrypts with its own nested crypto package (Node 22+),
 * so nothing may tell an operator it needs Node 24.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Node version policy', () => {
  it.each(['package.json', 'bot/package.json', 'dashboard/package.json'])('%s declares engines.node >=22', (rel) => {
    expect(JSON.parse(read(rel)).engines.node).toBe('>=22.0.0');
  });

  it('CI tests on Node 22 and 24', () => {
    expect(read('.github/workflows/ci.yml')).toMatch(/node-version: \[22, 24\]/);
  });

  it.each(['ci.yml', 'deploy.yml', 'fresh-clone-smoke.yml'])('%s pins no end-of-life Node', (file) => {
    const pins = [...read(`.github/workflows/${file}`).matchAll(/node-version:\s*'?(\d+)'?\s*$/gm)].map((m) => Number(m[1]));
    for (const major of pins) expect(major).toBeGreaterThanOrEqual(22);
  });

  it.each(['ci.yml', 'deploy.yml', 'fresh-clone-smoke.yml'])('%s has no stale Node 20 label or comment', (file) => {
    expect(read(`.github/workflows/${file}`)).not.toMatch(/Node(\.js)? 20\b/);
  });

  it.each(['README.md', 'SETUP.md', 'AGENTS.md', 'docs/local-stack.md'])('%s states the same minimum', (rel) => {
    expect(read(rel)).not.toMatch(/Node(\.js)? 20\+/);
  });

  it.each([
    'README.md',
    '.env.template',
    'docs/channels/matrix.md',
    'bot/shared/config/feature-availability.js',
    'bot/shared/services/messaging/matrix-connection.js',
    'bot/scripts/setup/doctor.js',
    'bot/scripts/setup/interactive-setup.js',
  ])('%s does not claim Matrix encryption needs Node 24', (rel) => {
    expect(read(rel)).not.toMatch(/Node\s*(>=\s*)?24(\+| or newer)/);
  });

  it('bot/package.json does not pull in a second, top-level crypto package', () => {
    const pkg = JSON.parse(read('bot/package.json'));
    const all = { ...pkg.dependencies, ...pkg.optionalDependencies };
    expect(all).not.toHaveProperty('@matrix-org/matrix-sdk-crypto-nodejs');
  });

  // install.sh is the documented front door, and engines alone only warns, so
  // these checks are what actually stop a Node 20 install.
  it.each(['install.sh', 'infrastructure/local/up.sh'])('%s refuses Node older than 22', (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/20 or newer/);
    expect(src).not.toMatch(/-lt 20\b/);
    expect(src).toMatch(/22 or newer/);
  });
});
