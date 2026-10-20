'use strict';
/**
 * The vendored engine reads as a library of this repository: no notes from
 * the process that built it (lane names, tools and scratch files that were
 * never vendored, the one lesson it was debugged on), and no regional default
 * currency.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../bot/vendor/lp-v9');
const { renderDiagram } = require('../../bot/vendor/lp-v9/diagrams');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return files(p);
    return /\.(js|json)$/.test(d.name) ? [p] : [];
  });
}

const RESIDUE = [
  /LANE L\d/, /\bL1's\b/, /\bL[12]\b(?! norm)/, /render_lp(_html)?\.js/, /lint_lp\.js/, /scratchpad\//,
  /G10 determinants/, /The expert's printed/,
];

test.each(RESIDUE.map((r) => [String(r), r]))('no vendored file mentions %s', (_, rx) => {
  const hits = files(ROOT).filter((f) => rx.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  expect(hits).toEqual([]);
});

test('money has no default currency: a bare value is written bare', () => {
  const svg = renderDiagram({ type: 'money', lang: 'en', items: [{ value: 20, kind: 'coin' }] });
  expect(svg).not.toMatch(/Rs/);
  expect(svg).toMatch(/>20</);
});

test('money still writes the currency the caller gives', () => {
  const svg = renderDiagram({ type: 'money', lang: 'en', currency: '$', items: [{ value: 20, kind: 'coin' }] });
  expect(svg).toMatch(/>\$ 20</);
});
