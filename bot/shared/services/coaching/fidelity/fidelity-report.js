'use strict';
/**
 * analysis_data.lp_fidelity → what the teacher reads.
 *
 *   fidelityState(lp)              the one outcome this blob represents
 *   fidelityChatLine(facts, lang)  the chat line sent after the report (coaching-messages catalog)
 *   buildFidelityReportSection(lp) the report's fidelity block: band, "N of M planned moves delivered", and one row per
 *                                  planned move — what the plan said, what the recording shows at [MM:SS], the verdict
 *
 * Each outcome has its own words. A recording without timings, an unreadable plan, no plan, and a grader failure are
 * different problems with different fixes, and none of them is ever shown as 0%.
 */
const { getCoachingMessage } = require('../../../config/coaching-messages');
const { PHASES, phaseLabel } = require('./fidelity-phases');

const DONE = new Set(['executed', 'substituted_equivalent', 'substituted_better']);

const VERDICT_LABEL = {
  executed: 'Done',
  substituted_equivalent: 'Done another way',
  substituted_better: 'Done a stronger way',
  partial: 'Partly',
  not_done: 'Not seen',
  not_adjudicable: 'Could not tell',
};

const BAND_LABEL = { high: 'High', partial: 'Partial', low: 'Low' };

const STATE_MESSAGE = {
  measured: 'fidelity_measured',
  lesson_mismatch: 'fidelity_lesson_mismatch',
  no_timings: 'fidelity_no_timings',
  recording_unusable: 'fidelity_recording_unusable',
  no_plan: 'fidelity_no_plan',
  plan_unreadable: 'fidelity_plan_unreadable',
  grader_failed: 'fidelity_grader_failed',
};

/**
 * @param {object|null} lp analysis_data.lp_fidelity
 * @returns {'measured'|'lesson_mismatch'|'no_timings'|'recording_unusable'|'no_plan'|'plan_unreadable'|'grader_failed'|null}
 */
function fidelityState(lp) {
  if (!lp || !lp.status) return null;
  if (lp.status === 'lp_absent') return 'no_plan';
  if (lp.status === 'lp_unparseable') return 'plan_unreadable';
  if (lp.status !== 'ok') return 'grader_failed';
  if (lp.unusable_guard === 'no_timestamps') return 'no_timings';
  if (lp.fidelity_pct == null) return 'recording_unusable';
  if (lp.moderators && lp.moderators.note === 'lesson_mismatch') return 'lesson_mismatch';
  return 'measured';
}

function words(text) {
  return String(text || '').replace(/\[\d{1,3}:\d{2}\]/g, ' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * The grader glosses each quote in the plan's language. When the lesson was taught in that language the gloss only
 * repeats the quote, so it is dropped when most of its words are the quote's own.
 */
function usefulGloss(evidence, gloss) {
  if (!gloss) return '';
  const g = words(gloss);
  if (!g.length) return '';
  const q = new Set(words(evidence));
  const shared = g.filter((w) => q.has(w)).length;
  return shared / g.length >= 0.8 ? '' : gloss;
}

function counts(lp) {
  const counted = ((lp && lp.moves) || []).filter((m) => m && m.counted);
  return { counted, delivered: counted.filter((m) => DONE.has(m.verdict)).length, total: counted.length };
}

/**
 * @param {{state:string, delivered?:number, total?:number, band?:string}} facts
 * @param {string} language
 * @returns {string|null}
 */
function fidelityChatLine(facts, language = 'en') {
  const key = facts && STATE_MESSAGE[facts.state];
  if (!key) return null;
  const bandWords = facts.band ? getCoachingMessage(`fidelity_band_${facts.band}`, language) : '';
  return getCoachingMessage(key, language)
    .replace('{{delivered}}', String(facts.delivered ?? ''))
    .replace('{{total}}', String(facts.total ?? ''))
    .replace('{{band}}', bandWords);
}

/** The chat line for a stored blob (null when fidelity never ran). */
function fidelityChatLineFor(lp, language = 'en') {
  const state = fidelityState(lp);
  if (!state) return null;
  const { delivered, total } = counts(lp);
  return fidelityChatLine({ state, delivered, total, band: lp.band || null }, language);
}

/**
 * The report's fidelity block. `measured` sections carry the score and the per-move table; every other state carries
 * only its status line (no score, no table — "not assessed", never 0%).
 * @param {object} lp analysis_data.lp_fidelity
 * @param {string} [language]
 * @returns {object|null}
 */
function buildFidelityReportSection(lp, language = 'en') {
  const state = fidelityState(lp);
  if (!state) return null;
  const statusLine = fidelityChatLineFor(lp, language);
  const measured = state === 'measured' || state === 'lesson_mismatch';
  if (!measured) {
    return {
      measured: false, state, statusLine, source: lp.source || null,
      score: null, maxScore: 100, band: null, bandLabel: null,
      note: '', commentary: '', perAction: [], strengths: [], gaps: [], notAssessedCount: 0,
    };
  }

  const { counted, delivered, total } = counts(lp);
  const order = (m) => { const i = PHASES.indexOf(m.phase); return i === -1 ? PHASES.length : i; };
  const rows = counted
    .map((m, i) => ({ m, i }))
    .sort((a, b) => order(a.m) - order(b.m) || a.i - b.i)
    .map(({ m }) => ({
      phase: m.phase,
      phaseLabel: phaseLabel(m.phase),
      text: m.text || '',
      verdict: m.verdict,
      verdictLabel: VERDICT_LABEL[m.verdict] || m.verdict,
      evidence: m.evidence || '',
      evidenceTranslation: usefulGloss(m.evidence, m.evidence_translation),
      unquoted: !!m.unquoted,
    }));

  return {
    measured: true,
    state,
    statusLine,
    source: lp.source || null,
    score: lp.fidelity_pct,
    maxScore: 100,
    band: lp.band || null,
    bandLabel: BAND_LABEL[lp.band] || null,
    lowConfidence: !!lp.low_confidence,
    note: `${delivered} of ${total} planned moves delivered`,
    commentary: lp.narrative || '',
    perAction: rows,
    strengths: (lp.strengths || []).map((s) => s.text).filter(Boolean),
    gaps: counted.filter((m) => m.verdict === 'not_done').map((m) => m.text).filter(Boolean),
    notAssessedCount: (lp.not_assessed || []).length,
  };
}

/**
 * What the teacher's voice note may know about fidelity. The voice prompt serialises the whole analysis, so the
 * measured blob (its percentage, every run's percentage, the per-move rows) and the model's legacy whole-lesson
 * estimate both leave the dump; the voice gets the band in words and the move count instead. One grading's
 * percentage carries a few points of wobble, and a number read aloud sounds like a verdict.
 * @param {object} analysis enhanced analysis
 * @param {string} [language]
 * @returns {{analysis: object, lessonPlanFidelity: object|null}}
 */
function projectForVoice(analysis, language = 'en') {
  const lp = analysis && analysis.lp_fidelity;
  if (!lp) return { analysis, lessonPlanFidelity: null };
  const { lp_fidelity: _measured, fidelity_analysis: _estimate, ...rest } = analysis;
  const state = fidelityState(lp);
  if (state !== 'measured' && state !== 'lesson_mismatch') {
    return { analysis: rest, lessonPlanFidelity: { assessed: false, reason: state } };
  }
  const { delivered, total } = counts(lp);
  return {
    analysis: rest,
    lessonPlanFidelity: {
      assessed: true,
      band: lp.band || null,
      band_words: lp.band ? getCoachingMessage(`fidelity_band_${lp.band}`, language) : null,
      planned_moves_delivered: `${delivered} of ${total}`,
      lesson_mismatch: state === 'lesson_mismatch',
    },
  };
}

module.exports = {
  fidelityState, fidelityChatLine, fidelityChatLineFor, buildFidelityReportSection, projectForVoice, VERDICT_LABEL, BAND_LABEL,
};
