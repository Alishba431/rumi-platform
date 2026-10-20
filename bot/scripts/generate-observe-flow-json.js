#!/usr/bin/env node
/**
 * Generate the editable observation form (a Meta WhatsApp Flow) from the
 * configured framework pack — the single source of truth for domains,
 * indicators and the rating scale.
 *
 *   node bot/scripts/generate-observe-flow-json.js                 # default pack (TEACH)
 *   OBSERVE_FRAMEWORK=hots node bot/scripts/generate-observe-flow-json.js
 *   node bot/scripts/generate-observe-flow-json.js --out /tmp/form.json
 *
 * It writes docs/flows/observe-form-flow.json, the asset `rumi setup`
 * registers as "Observe Form". The shipped asset is the default TEACH pack; a
 * deployment that sets OBSERVE_FRAMEWORK=hots or mewaka regenerates it with
 * the same variable and re-registers / re-publishes it. Only Meta deployments
 * need it — every other channel reviews the ratings in the chat form.
 *
 * Design:
 * - Pure data_exchange flow: INIT returns the first screen's prefill, every
 *   "Next" returns the next screen's prefill (routes/observe-form-endpoint.js).
 *   Forward-only routing.
 * - One screen per domain, ids DOMAIN_1..DOMAIN_N (observe-framework
 *   formScreens, which the endpoint reads too).
 * - Per indicator: RadioButtonsGroup r_<id> bound to ${data.scale} (the pack's
 *   scale, served by the endpoint, so the labels can never disagree with the
 *   clamp) + TextArea ev_<id> (evidence) + TextArea imp_<id> (improvement).
 *   Field names use underscores (A1.1 → A1_1) — dots are not valid names.
 * - Static copy comes from observe-strings (English by default).
 */

const fs = require('fs');
const path = require('path');
const { getObservePack, formScreens } = require('../shared/services/observe/observe-framework');
const { t } = require('../shared/services/observe/observe-strings');

const OUT_DEFAULT = path.resolve(__dirname, '../../docs/flows/observe-form-flow.json');

const fid = (id) => String(id).replace(/\./g, '_');

// Meta caps RadioButtonsGroup labels at 30 chars; clip at a word boundary
// (a mid-word cut reads as a bug). The full name goes in `description`.
function clipLabel(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  const cut = str.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 5 ? cut.slice(0, sp) : cut).replace(/[\s—·,-]+$/, '')}…`;
}

const SCALE_ITEMS = { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } };

/**
 * @param {object} pack  observe framework pack (getObservePack())
 * @param {{lang?: string}} [opts]
 * @returns {object} the Flow JSON
 */
function buildObserveFlow(pack = getObservePack(), { lang = 'en' } = {}) {
  const fw = pack.key.toUpperCase();
  const s = (key, vars = {}) => t(lang, key, { fw, ...vars });
  const list = formScreens(pack);
  const total = list.length;

  const screens = list.map(({ id, domainKey }, idx) => {
    const d = pack.domains[domainKey];
    const n = idx + 1;
    const isLast = idx === total - 1;
    const data = { scale: { type: 'array', items: SCALE_ITEMS, __example__: pack.scaleOptions } };
    const initValues = {};
    const payload = { _screen: id };
    const children = [
      { type: 'TextHeading', text: `${n}. ${d.title}`.slice(0, 80) },
      { type: 'TextBody', text: s('flow_screen_body', { n, total }) },
    ];

    for (const ind of d.indicators) {
      const f = fid(ind.id);
      children.push({
        type: 'RadioButtonsGroup',
        name: `r_${f}`,
        label: clipLabel(`${ind.id} — ${ind.name}`, 30),
        description: String(ind.name).slice(0, 300),
        required: false,
        'data-source': '${data.scale}',
      });
      children.push({
        type: 'TextArea',
        name: `ev_${f}`,
        label: s('flow_evidence_label').slice(0, 20),
        'helper-text': s('flow_evidence_help', { id: ind.id }).slice(0, 80),
        required: false,
      });
      children.push({
        type: 'TextArea',
        name: `imp_${f}`,
        label: s('flow_improve_label').slice(0, 20),
        'helper-text': s('flow_improve_help', { id: ind.id }).slice(0, 80),
        required: false,
      });
      initValues[`r_${f}`] = `\${data.s_${f}}`;
      initValues[`ev_${f}`] = `\${data.e_${f}}`;
      initValues[`imp_${f}`] = `\${data.i_${f}}`;
      data[`s_${f}`] = { type: 'string', __example__: pack.scaleOptions[0].id };
      data[`e_${f}`] = { type: 'string', __example__: 'What the coach saw…' };
      data[`i_${f}`] = { type: 'string', __example__: 'One next step…' };
      payload[`r_${f}`] = `\${form.r_${f}}`;
      payload[`ev_${f}`] = `\${form.ev_${f}}`;
      payload[`imp_${f}`] = `\${form.imp_${f}}`;
    }

    children.push({
      type: 'Footer',
      label: (isLast ? s('flow_submit') : s('flow_next')).slice(0, 35),
      'on-click-action': { name: 'data_exchange', payload },
    });

    return {
      id,
      title: s('flow_screen_title', { n, total }).slice(0, 30),
      data,
      layout: {
        type: 'SingleColumnLayout',
        children: [{ type: 'Form', name: `form_${n}`, 'init-values': initValues, children }],
      },
    };
  });

  screens.push({
    id: 'SUCCESS',
    title: s('flow_success_title').slice(0, 30),
    terminal: true,
    data: { session_id: { type: 'string', __example__: '00000000-0000-0000-0000-000000000000' } },
    layout: {
      type: 'SingleColumnLayout',
      children: [
        { type: 'TextHeading', text: s('flow_success_heading') },
        { type: 'TextBody', text: s('flow_success_body') },
        {
          type: 'Footer',
          label: s('flow_done').slice(0, 35),
          'on-click-action': { name: 'complete', payload: { observe_action: 'submitted', session_id: '${data.session_id}' } },
        },
      ],
    },
  });

  const routing_model = {};
  list.forEach(({ id }, i) => { routing_model[id] = [i < total - 1 ? list[i + 1].id : 'SUCCESS']; });
  routing_model.SUCCESS = [];

  return { version: '6.3', data_api_version: '3.0', routing_model, screens };
}

function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--out');
  const out = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : OUT_DEFAULT;
  const pack = getObservePack();
  const flow = buildObserveFlow(pack);
  fs.writeFileSync(out, `${JSON.stringify(flow, null, 2)}\n`);
  console.log(`wrote ${out} (${pack.key} pack, ${flow.screens.length} screens)`);
}

if (require.main === module) main();

module.exports = { buildObserveFlow, clipLabel, fid };
