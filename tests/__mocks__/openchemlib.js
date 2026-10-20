/**
 * openchemlib stub for the ROOT test suite.
 *
 * bot/vendor/lp-v9/diagrams/types/molecule.js loads openchemlib lazily and
 * optionally, to turn a SMILES string into a 2D structural formula. The package
 * is declared nowhere and is not installed, so in production a molecule always
 * falls back to a formula card; that is why `molecule` is not a lesson-quiz
 * figure type. The stub keeps a test that reaches the engine's molecule path
 * from resolving whatever happens to be installed on the machine.
 *
 * The stub does NOT draw chemistry. `moleculeFromSmiles` throws a named error,
 * the loud-not-silent choice: a test that genuinely needs a rendered molecule
 * fails on "openchemlib is stubbed" rather than passing over an empty <svg>.
 */
const stubbed = (what) => () => {
  throw new Error(`openchemlib is STUBBED in the root test suite (${what}) — run this against the bot's real dependency`);
};

const Molecule = {
  fromSmiles: stubbed('Molecule.fromSmiles'),
  fromMolfile: stubbed('Molecule.fromMolfile'),
};

module.exports = { Molecule, __stub: true };
module.exports.default = module.exports;
