'use strict';
/**
 * The REAL KaTeX, when the bot's dependencies are installed.
 *
 * The root suite maps `katex` (and `katex/contrib/mhchem`) to the functional
 * stubs in tests/__mocks__/ — the root job runs before `bot/ npm ci`, so the
 * package may not be there. A suite that asks what only real KaTeX can answer
 * (is this a valid expression? does the card carry an `mfrac`?) loads it from
 * bot/node_modules instead, and SKIPS when it is not installed rather than
 * failing on the stub:
 *
 *   const { mockRealKatexDir, describeKatex } = require('./helpers/real-katex');
 *   if (mockRealKatexDir) {
 *     jest.mock('katex', () => jest.requireActual(`${mockRealKatexDir}/dist/katex.js`));
 *     jest.mock('katex/contrib/mhchem', () => jest.requireActual(`${mockRealKatexDir}/dist/contrib/mhchem.js`));
 *   }
 *
 * (`mock`-prefixed so a jest.mock factory may read it.)
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', '..', 'bot', 'node_modules', 'katex');
const mockRealKatexDir = fs.existsSync(path.join(DIR, 'dist', 'katex.js')) ? fs.realpathSync(DIR) : null;

/** `describe` with the real KaTeX installed, `describe.skip` without it. */
const describeKatex = mockRealKatexDir ? describe : describe.skip;
/** `test` with the real KaTeX installed, `test.skip` without it. */
const testKatex = mockRealKatexDir ? test : test.skip;

module.exports = { mockRealKatexDir, describeKatex, testKatex };
