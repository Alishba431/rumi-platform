/**
 * Loads the crypto package matrix-bot-sdk ITSELF encrypts with.
 *
 * matrix-bot-sdk@0.8.0 has a hard dependency on its own copy of
 * `@matrix-org/matrix-sdk-crypto-nodejs` (0.4.0, `engines.node >= 22`), which
 * npm installs nested under `node_modules/matrix-bot-sdk/node_modules/`. That
 * copy is the real crypto engine: CryptoClient/RustEngine require it from
 * there. A bare `require('@matrix-org/matrix-sdk-crypto-nodejs')` from our own
 * code would instead find whatever copy sits at the top of node_modules (an
 * earlier version of this repo added one, 0.6.6, Node 24+, as an optional
 * dependency only to read the StoreType enum) -- so on a host where that copy
 * was skipped, Matrix refused to start although encryption would have worked.
 *
 * Resolving from matrix-bot-sdk's own directory follows Node's normal lookup
 * from there: the nested copy when present, the top-level one if npm ever
 * dedupes it. Either way it is the copy the SDK uses.
 *
 * Has no dependencies of its own, so `rumi doctor` can probe the same thing the
 * bot loads without pulling in the bot's logger or the SDK.
 */

const path = require('path');

function loadSdkCryptoModule() {
  const sdkDir = path.dirname(require.resolve('matrix-bot-sdk'));
  // eslint-disable-next-line global-require, import/no-dynamic-require -- lazy native module, resolved from the SDK
  return require(require.resolve('@matrix-org/matrix-sdk-crypto-nodejs', { paths: [sdkDir] }));
}

module.exports = { loadSdkCryptoModule };
