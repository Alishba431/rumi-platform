'use strict';
/**
 * The vendored diagram engine never starts a process.
 *
 * `circuit` is a quiz figure type and its spec is model-written, and the copy
 * the bot ships used to keep a dev-only `engine: "schemdraw"` branch that built
 * a Python script from the spec's labels and ran it with execFileSync. The
 * branch is gone: `engine` is ignored and the built-in drawing is the only one.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../bot/vendor/lp-v9');
const { renderDiagram } = require('../../bot/vendor/lp-v9/diagrams');
const MANIFEST = require('../../bot/vendor/lp-v9/diagrams/types_manifest.json');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : jsFiles(p);
    return d.name.endsWith('.js') ? [p] : [];
  });
}

test('no file in the engine requires child_process', () => {
  const offenders = jsFiles(ROOT).filter((f) => /child_process|execFileSync|execSync|\bspawn\(/.test(fs.readFileSync(f, 'utf8')));
  expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
});

test('engine:"schemdraw" draws exactly the built-in circuit', () => {
  const spec = { type: 'circuit', layout: 'series', cells: [{ kind: 'battery', label: 'Battery', value: '6 V' }, { kind: 'lamp', label: 'Lamp' }], lang: 'en' };
  expect(renderDiagram({ ...spec, engine: 'schemdraw' })).toBe(renderDiagram(spec));
});

test('the roster no longer offers an engine key for circuit', () => {
  const entry = MANIFEST.types.find((t) => t.type === 'circuit');
  expect(entry.optional).not.toContain('engine');
  expect(entry.limits.join('\n')).not.toMatch(/schemdraw/);
});
