/**
 * jest.doMock for a package that only bot/node_modules has (aws-sdk,
 * playwright-core, …).
 *
 * The root suite mocks these by bare name with { virtual: true } — needed for
 * the CI job that runs before bot deps install. But when they ARE installed,
 * the source under test resolves the package to a real bot/node_modules path,
 * which the bare-name virtual mock is not keyed by. Whether the bare name still
 * wins depends on what earlier test files in the same Jest worker resolved —
 * an order-dependent flake (a "mocked" SQS queue or Chromium turned out to be
 * the real one). This mocks both keys.
 *
 * @param {string} name     package name, e.g. 'aws-sdk'
 * @param {Function} factory jest.doMock factory
 */
const path = require('path');

const BOT_SOURCE_DIR = path.join(__dirname, '..', '..', 'bot', 'shared', 'utils');

function mockBotDependency(name, factory) {
  jest.doMock(name, factory, { virtual: true });
  let resolved = null;
  try {
    resolved = require.resolve(name, { paths: [BOT_SOURCE_DIR] });
  } catch (_) { /* bot deps not installed: the virtual mock is the only one */ }
  if (resolved) jest.doMock(resolved, factory);
}

module.exports = { mockBotDependency };
