/**
 * The observe FRAMEWORK PACK.
 *
 * One observation pipeline, many rubrics, selected by config:
 *   OBSERVE_FRAMEWORK=teach   (default — the public TEACH classroom observation tool)
 *   OBSERVE_FRAMEWORK=hots    (higher-order thinking skills, 16 indicators)
 *   OBSERVE_FRAMEWORK=mewaka  (lesson-stage rubric, 25 indicators)
 *
 * The pack contract (what the observe pipeline consumes):
 *   key          the rubric key
 *   domains      { key: { title, indicators: [{ id, name }] } } — the shape the
 *                draft prefill, the coach's edit form and the teacher report speak
 *   domainOrder  the order the coach reviews domains in
 *   scaleOptions [{ id, title }] — the rating scale; its ids bound every clamp
 *   computeScores(analysis)  totals IN the domains shape, stamping
 *                self-describing titles so the teacher report never needs to
 *                know the rubric
 *   module       the framework object handed to analyzePedagogy
 *
 * Why a wrapper rather than the framework modules as they are: the coach edits
 * a rating per indicator, so every pack must produce the same per-indicator
 * domains shape. MEWAKA already does. TEACH (areas → elements, holistic 1-5)
 * and HOTS (areas → indicators) get an observe module whose prompt asks for
 * that shape; TEACH also mirrors its scores back into the `areas` shape so the
 * existing TEACH hero-report adapter renders it unchanged.
 */

const teach = require('../coaching/frameworks/teach-framework');
const hots = require('../coaching/frameworks/hots-framework');
const mewaka = require('../coaching/frameworks/mewaka-framework');

const OBSERVE_FRAMEWORK_KEYS = ['teach', 'hots', 'mewaka'];
const DEFAULT_FRAMEWORK = 'teach';

const SCALE_0_3 = [
  { id: '0', title: '0 · Not seen' },
  { id: '1', title: '1 · Rarely' },
  { id: '2', title: '2 · Often enough' },
  { id: '3', title: '3 · Strongly' },
];

const SCALE_1_5 = [
  { id: '1', title: '1 · Low' },
  { id: '2', title: '2 · Low–medium' },
  { id: '3', title: '3 · Medium' },
  { id: '4', title: '4 · Medium–high' },
  { id: '5', title: '5 · High' },
];

function boundsOf(scale) {
  const ids = scale.map((o) => Number(o.id));
  return { min: Math.min(...ids), max: Math.max(...ids) };
}

/** Generic domains-shape scorer: clamps to the pack's scale, never NaN. */
function computeDomainScores(analysis, domains, frameworkKey, scale) {
  const { min, max: scaleMax } = boundsOf(scale);
  const container = (analysis.domains = analysis.domains || {});
  let marks = 0;
  let max = 0;
  for (const [key, spec] of Object.entries(domains)) {
    const dom = (container[key] = container[key] || {});
    const byId = {};
    (dom.indicators || []).forEach((i) => { byId[String(i.id)] = i; });
    let dTotal = 0;
    for (const specInd of spec.indicators) {
      const ind = byId[String(specInd.id)];
      const raw = Number((ind || {}).score);
      const score = Number.isFinite(raw) && ind && ind.score !== null ? Math.max(min, Math.min(scaleMax, raw)) : min;
      if (ind) ind.score = score;
      dTotal += score;
    }
    // Same field names as mewaka.computeScores — every downstream consumer
    // (hero report adapter, PDF transformer) already reads these.
    dom.domain_score = dTotal;
    dom.domain_max = spec.indicators.length * scaleMax;
    dom.area_score = dTotal;
    dom.area_max = dom.domain_max;
    dom.title = spec.title;   // self-describing — the report reads THIS
    marks += dTotal;
    max += dom.domain_max;
  }
  analysis.scores = {
    overall_marks: marks,
    overall_max_marks: max,
    overall_percentage: max > 0 ? parseFloat(((marks / max) * 100).toFixed(1)) : 0,
  };
  analysis.framework = frameworkKey;
  return analysis;
}

/**
 * The shared observe analysis prompt. Asks for the per-indicator domains shape
 * with evidence tied to a real moment — and an honest "not seen" rather than a
 * made-up quote, because the coach signs off on this and the teacher reads it.
 */
function buildObservePrompt({ rubricName, domains, scale, transcript, metadata = {} }) {
  const { min, max } = boundsOf(scale);
  const domainLines = Object.entries(domains).map(([key, d]) => {
    const inds = d.indicators
      .map((i) => `    { "id": ${JSON.stringify(i.id)}, /* ${i.name} */ "score": ${min}-${max}, "evidence": "…", "improvement": "…" }`)
      .join(',\n');
    return `  "${key}": { /* ${d.title} */ "indicators": [\n${inds}\n  ] }`;
  }).join(',\n');
  const count = Object.values(domains).reduce((n, d) => n + d.indicators.length, 0);
  const scaleText = scale.map((o) => o.title).join(', ');
  return `A coach sent a recording of a lesson${metadata.teacherName ? ` taught by ${metadata.teacherName}` : ''}. `
    + `Read the transcript and rate ALL ${count} ${rubricName} indicators.\n\n`
    + 'Rules:\n'
    + `- Score each indicator ${min}-${max} (${scaleText}).\n`
    + '- "evidence": cite a REAL moment from the lesson — quote the teacher\'s own words where possible. '
    + 'If the transcript holds no evidence for an indicator, say honestly that the moment was not visible — never invent evidence.\n'
    + '- "improvement": one small, practical next step.\n'
    + '- Refer to the teacher as "the teacher" or by first name, with they/them pronouns.\n'
    + '- Keys must stay EXACTLY as given.\n\n'
    + 'Return JSON with EXACTLY this structure:\n'
    + `{\n"domains": {\n${domainLines}\n},\n`
    + '"summary": "warm 2-3 sentence overall summary",\n'
    + '"strengths": [ { "title": "…", "evidence": "…", "anchor_indicator": "<id>" } ],\n'
    + '"focus_area": { "title": "…", "why": "…", "try": "…" }\n}\n\n'
    + `TRANSCRIPT:\n${transcript}`;
}

const OBSERVER_SYSTEM_PROMPT = 'You are an experienced classroom observer helping a coach prepare feedback for a teacher. '
  + 'Your tone is warm and encouraging — a colleague, not an inspector. Every observation must be tied to a '
  + 'real moment in the lesson. Always answer in valid JSON.';

// ── TEACH, normalised to the domains shape ─────────────────────────────────
// Time on Task is its own one-indicator domain, then the three areas with one
// indicator per element — 10 ratings on 1-5, max 50, the tool's own total.
let _teachDomains = null;
function teachDomains() {
  if (_teachDomains) return _teachDomains;
  const { areas } = teach.getScoringConstants();
  const out = { time_on_task: { title: 'Time on Task', indicators: [{ id: 'T', name: 'Time on task' }] } };
  for (const [key, area] of Object.entries(areas)) {
    out[key] = { title: area.displayName, indicators: area.elements.map((e) => ({ id: e.id, name: e.name })) };
  }
  _teachDomains = out;
  return out;
}

function computeTeachScores(analysis) {
  computeDomainScores(analysis, teachDomains(), 'teach', SCALE_1_5);
  // Mirror into the TEACH areas shape (teach-adapter / PDF transformer read it).
  const doms = analysis.domains;
  const tot = ((doms.time_on_task || {}).indicators || [])[0];
  analysis.time_on_task = { score: tot ? tot.score : 1, evidence: tot ? (tot.evidence || '') : '' };
  analysis.areas = {};
  for (const key of Object.keys(teach.getScoringConstants().areas)) {
    const dom = doms[key] || {};
    analysis.areas[key] = {
      elements: (dom.indicators || []).map((i) => ({ id: i.id, name: i.name, holistic_score: i.score })),
      area_score: dom.area_score,
      area_max: dom.area_max,
    };
  }
  return analysis;
}

const teachObserveModule = {
  name: 'teach',
  version: 'observe-1.0',
  displayName: 'TEACH (Observation)',
  maxMarks: 50,
  jsonMode: true,
  hasDebrief: false,
  hasLPBonus: false,
  getSystemPrompt: () => OBSERVER_SYSTEM_PROMPT,
  buildAnalysisPrompt: (transcript, metadata = {}) => buildObservePrompt({
    rubricName: 'TEACH', domains: teachDomains(), scale: SCALE_1_5, transcript, metadata,
  }),
  computeScores: computeTeachScores,
  getScoringConstants: () => ({ ...teach.getScoringConstants(), domains: teachDomains() }),
  getPerformanceBand: teach.getPerformanceBand,
};

// ── HOTS, normalised to the domains shape ──────────────────────────────────
let _hotsDomains = null;
function hotsDomains() {
  if (_hotsDomains) return _hotsDomains;
  const { areas } = hots.getScoringConstants();
  const out = {};
  for (const [key, area] of Object.entries(areas)) {
    out[key] = { title: area.displayName, indicators: area.indicators.map((i) => ({ id: i.id, name: i.name })) };
  }
  _hotsDomains = out;
  return out;
}

const hotsObserveModule = {
  name: 'hots',
  version: 'observe-1.0',
  displayName: 'HOTS (Observation)',
  maxMarks: 48,
  jsonMode: true,
  hasDebrief: false,
  hasLPBonus: false,
  getSystemPrompt: () => OBSERVER_SYSTEM_PROMPT,
  buildAnalysisPrompt: (transcript, metadata = {}) => buildObservePrompt({
    rubricName: 'HOTS', domains: hotsDomains(), scale: SCALE_0_3, transcript, metadata,
  }),
  computeScores: (analysis) => computeDomainScores(analysis, hotsDomains(), 'hots', SCALE_0_3),
  getScoringConstants: () => ({ domains: hotsDomains(), scaleMax: 3 }),
  getPerformanceBand: hots.getPerformanceBand,
};

// ── MEWAKA already speaks the domains shape: the real module passes through ─
let _mewakaDomains = null;
function mewakaDomains() {
  if (_mewakaDomains) return _mewakaDomains;
  const { domains } = mewaka.getScoringConstants();
  const out = {};
  for (const [key, d] of Object.entries(domains)) {
    out[key] = { title: d.displayName, indicators: d.indicators.map((i) => ({ id: i.id, name: i.text })) };
  }
  _mewakaDomains = out;
  return out;
}

function frameworkKey() {
  const raw = String(process.env.OBSERVE_FRAMEWORK || '').trim().toLowerCase();
  return OBSERVE_FRAMEWORK_KEYS.includes(raw) ? raw : DEFAULT_FRAMEWORK;
}

function getObservePack() {
  const key = frameworkKey();
  if (key === 'hots') {
    const domains = hotsDomains();
    return {
      key, domains, domainOrder: Object.keys(domains), scaleOptions: SCALE_0_3,
      computeScores: hotsObserveModule.computeScores, module: hotsObserveModule,
    };
  }
  if (key === 'mewaka') {
    const domains = mewakaDomains();
    return {
      key, domains, domainOrder: Object.keys(domains), scaleOptions: SCALE_0_3,
      computeScores: (analysis) => {
        mewaka.computeScores(analysis);
        for (const [k, d] of Object.entries(domains)) {
          if (analysis.domains && analysis.domains[k]) analysis.domains[k].title = d.title;
        }
        analysis.framework = 'mewaka';
        return analysis;
      },
      module: mewaka,
    };
  }
  const domains = teachDomains();
  return {
    key: 'teach', domains, domainOrder: Object.keys(domains), scaleOptions: SCALE_1_5,
    computeScores: computeTeachScores, module: teachObserveModule,
  };
}

/** {min, max} of the active pack's rating scale. */
function scaleBounds(pack = getObservePack()) {
  return boundsOf(pack.scaleOptions);
}

/**
 * The editable form's screens: one per domain, in review order, with ids
 * DOMAIN_1..DOMAIN_N. The published Meta Flow (generated from the pack) and
 * its data_exchange endpoint both read this, so a screen id always means the
 * same domain on both sides.
 * @returns {Array<{id: string, domainKey: string}>}
 */
function formScreens(pack = getObservePack()) {
  return pack.domainOrder.map((domainKey, i) => ({ id: `DOMAIN_${i + 1}`, domainKey }));
}

module.exports = {
  getObservePack, scaleBounds, formScreens, OBSERVE_FRAMEWORK_KEYS, DEFAULT_FRAMEWORK, computeDomainScores,
};
