'use strict';
/**
 * The vendored diagram engine carries its licences with it: the Inter fonts
 * ship with their SIL OFL 1.1 text and copyright notice (the licence requires
 * both to travel with redistributed copies), and a README says where every
 * third-party part comes from.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../bot/vendor/lp-v9');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the Inter fonts ship with the OFL 1.1 text and Inter\'s copyright line', () => {
  const fonts = fs.readdirSync(path.join(ROOT, 'fonts')).filter((f) => /^Inter-.*\.ttf$/.test(f));
  expect(fonts.length).toBeGreaterThan(0);
  const ofl = read('fonts/OFL.txt');
  expect(ofl.split('\n')[0]).toBe('Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)');
  expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
  expect(ofl).toContain('PERMISSION & CONDITIONS');
  expect(ofl).not.toMatch(/Scheherazade|SIL International\b.*Reserved/);
});

test('the README names the engine\'s licence and every third-party part', () => {
  const readme = read('README.md');
  expect(readme).toMatch(/Apache License 2\.0/);
  expect(readme).toMatch(/Inter[\s\S]*Open Font License 1\.1[\s\S]*fonts\/OFL\.txt/);
  expect(readme).toMatch(/OpenMoji[\s\S]*CC BY-SA 4\.0[\s\S]*ATTRIBUTION\.md/);
  expect(readme).toMatch(/KaTeX[\s\S]*MIT/);
  expect(readme).toContain('diagrams/assets/leaf_sketch.png');
  expect(fs.existsSync(path.join(ROOT, 'diagrams/assets/pictograms/ATTRIBUTION.md'))).toBe(true);
});
