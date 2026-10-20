/**
 * S1-metaflow — the editable form's Flow JSON is GENERATED from the framework
 * pack (scripts/generate-observe-flow-json.js), and the shipped asset
 * docs/flows/observe-form-flow.json is the default (TEACH) pack's output.
 * These tests pin the generator to the pack and to the endpoint's bindings, so
 * a rubric change or a hand-edit of the asset fails CI, not a coach's form.
 */

const fs = require('fs');
const path = require('path');

const { buildObserveFlow } = require('../../bot/scripts/generate-observe-flow-json');
const { getObservePack, formScreens, OBSERVE_FRAMEWORK_KEYS } = require('../../bot/shared/services/observe/observe-framework');
const { FLOW_CONFIGS } = require('../../bot/scripts/setup/flow-configs');

jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({}));

const ASSET = path.join(__dirname, '../../docs/flows/observe-form-flow.json');
const fid = (id) => String(id).replace(/\./g, '_');

function withFramework(key, fn) {
  const prev = process.env.OBSERVE_FRAMEWORK;
  process.env.OBSERVE_FRAMEWORK = key;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.OBSERVE_FRAMEWORK; else process.env.OBSERVE_FRAMEWORK = prev;
  }
}

// Every ${data.x} a screen reads must be declared in that screen's data, and
// every ${form.x} a payload sends must be a field on that screen.
function bindingsOf(node, kind, out = new Set()) {
  const rx = new RegExp(`\\$\\{${kind}\\.([A-Za-z0-9_]+)\\}`, 'g');
  const walk = (v) => {
    if (typeof v === 'string') { let m; while ((m = rx.exec(v)) !== null) out.add(m[1]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(node);
  return out;
}

function fieldNames(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((n) => fieldNames(n, out));
  else if (node && typeof node === 'object') {
    if (node.name && node.type && node.type !== 'Form') out.add(node.name);
    Object.values(node).forEach((v) => fieldNames(v, out));
  }
  return out;
}

function components(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => components(n, out));
  else if (node && typeof node === 'object') {
    if (node.type) out.push(node);
    Object.values(node).forEach((v) => components(v, out));
  }
  return out;
}

function validate(flow, pack) {
  const problems = [];
  const ids = flow.screens.map((s) => s.id);
  const expected = formScreens(pack).map((s) => s.id);
  if (JSON.stringify(ids) !== JSON.stringify([...expected, 'SUCCESS'])) problems.push(`screens ${ids}`);
  if (flow.data_api_version !== '3.0') problems.push('data_api_version');
  for (const id of Object.keys(flow.routing_model)) if (!ids.includes(id)) problems.push(`routing ${id}`);
  for (const s of flow.screens) {
    const declared = new Set(Object.keys(s.data || {}));
    for (const b of bindingsOf(s.layout, 'data')) if (!declared.has(b)) problems.push(`${s.id}: undeclared data.${b}`);
    const names = fieldNames(s.layout);
    for (const b of bindingsOf(s.layout, 'form')) if (!names.has(b)) problems.push(`${s.id}: unknown form.${b}`);
    if (s.title.length > 30) problems.push(`${s.id}: title > 30`);
    const comps = components(s.layout).filter((c) => !['SingleColumnLayout', 'Form'].includes(c.type));
    if (comps.length > 50) problems.push(`${s.id}: ${comps.length} components`);
    for (const c of comps) {
      if (c.type === 'RadioButtonsGroup' && c.label.length > 30) problems.push(`${s.id}: radio label ${c.label}`);
      if (c.type === 'RadioButtonsGroup' && (c.description || '').length > 300) problems.push(`${s.id}: description`);
      if (c.type === 'TextArea' && c.label.length > 20) problems.push(`${s.id}: textarea label`);
      if (c.type === 'TextArea' && (c['helper-text'] || '').length > 80) problems.push(`${s.id}: helper-text`);
      if (c.type === 'Footer' && c.label.length > 35) problems.push(`${s.id}: footer label`);
      if (c.type === 'TextHeading' && c.text.length > 80) problems.push(`${s.id}: heading`);
    }
  }
  return problems;
}

describe('generate-observe-flow-json', () => {
  test.each(OBSERVE_FRAMEWORK_KEYS)('the %s pack builds a valid, forward-only form', (key) => {
    withFramework(key, () => {
      const pack = getObservePack();
      const flow = buildObserveFlow(pack);
      expect(validate(flow, pack)).toEqual([]);

      const screens = formScreens(pack);
      const routing = {};
      screens.forEach((s, i) => { routing[s.id] = [i < screens.length - 1 ? screens[i + 1].id : 'SUCCESS']; });
      routing.SUCCESS = [];
      expect(flow.routing_model).toEqual(routing);

      // Every indicator: a rating bound to the pack scale, evidence, improvement,
      // pre-filled from the endpoint's s_/e_/i_ bindings and sent back as r_/ev_/imp_.
      screens.forEach(({ id, domainKey }) => {
        const screen = flow.screens.find((s) => s.id === id);
        const form = screen.layout.children.find((c) => c.type === 'Form');
        const footer = form.children.find((c) => c.type === 'Footer');
        expect(footer['on-click-action'].name).toBe('data_exchange');
        expect(footer['on-click-action'].payload._screen).toBe(id);
        for (const ind of pack.domains[domainKey].indicators) {
          const f = fid(ind.id);
          const rating = form.children.find((c) => c.name === `r_${f}`);
          expect(rating['data-source']).toBe('${data.scale}');
          expect(form.children.find((c) => c.name === `ev_${f}`).type).toBe('TextArea');
          expect(form.children.find((c) => c.name === `imp_${f}`).type).toBe('TextArea');
          expect(form['init-values']).toMatchObject({ [`r_${f}`]: `\${data.s_${f}}`, [`ev_${f}`]: `\${data.e_${f}}`, [`imp_${f}`]: `\${data.i_${f}}` });
          expect(footer['on-click-action'].payload[`r_${f}`]).toBe(`\${form.r_${f}}`);
        }
        expect(screen.data.scale.__example__).toEqual(pack.scaleOptions);
      });

      const success = flow.screens.find((s) => s.id === 'SUCCESS');
      expect(success.terminal).toBe(true);
      const done = success.layout.children.find((c) => c.type === 'Footer');
      expect(done['on-click-action']).toMatchObject({ name: 'complete', payload: { observe_action: 'submitted' } });
    });
  });

  test('the shipped asset is the default (TEACH) pack, byte-for-byte what the generator writes', () => {
    const expected = withFramework('teach', () => `${JSON.stringify(buildObserveFlow(getObservePack()), null, 2)}\n`);
    expect(fs.readFileSync(ASSET, 'utf8')).toBe(expected);
  });

  test('the endpoint\'s prefill fills exactly the data each screen declares', () => {
    const { buildScreenPrefill } = require('../../bot/shared/services/observe/observe-draft.service');
    const flow = JSON.parse(fs.readFileSync(ASSET, 'utf8'));
    const pack = withFramework('teach', () => getObservePack());
    for (const { id, domainKey } of formScreens(pack)) {
      const declared = Object.keys(flow.screens.find((s) => s.id === id).data).sort();
      const served = withFramework('teach', () => Object.keys(buildScreenPrefill({ domains: {} }, domainKey)).sort());
      expect(declared).toEqual(served);
    }
  });

  test('registered with rumi setup as an endpoint Flow behind OBSERVE_FORM_FLOW_ID', () => {
    const cfg = FLOW_CONFIGS.find((c) => c.envVar === 'OBSERVE_FORM_FLOW_ID');
    expect(cfg).toMatchObject({ name: 'Observe Form', type: 'endpoint', endpointPath: '/api/flows/observe-form' });
    expect(path.resolve(cfg.jsonPath)).toBe(path.resolve(ASSET));
  });
});
