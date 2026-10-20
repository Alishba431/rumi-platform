'use strict';
/**
 * The one phase vocabulary for lesson-plan fidelity. The extractor clamps every move's phase to this list, and the
 * report orders and labels moves by it, so a phase can never be spelled two ways (guided vs guided_practice) by two
 * readers of the same blob.
 */
const PHASES = ['warm_up', 'hook', 'recall', 'announce', 'explain', 'guided', 'independent', 'peer_review', 'exit', 'homework'];

const PHASE_LABEL = {
  warm_up: 'Warm-up',
  hook: 'Hook',
  recall: 'Recall',
  announce: 'Objective',
  explain: 'Explain',
  guided: 'Guided practice',
  independent: 'Independent work',
  peer_review: 'Peer review',
  exit: 'Exit check',
  homework: 'Homework',
};

// Spellings other readers have used for the same phases.
const ALIASES = {
  guided_practice: 'guided',
  independent_practice: 'independent',
  warmup: 'warm_up',
  exit_ticket: 'exit',
};

/** A known phase, an alias of one, or null. */
function canonicalPhase(phase) {
  if (typeof phase !== 'string') return null;
  const p = phase.trim().toLowerCase();
  if (PHASES.includes(p)) return p;
  return ALIASES[p] || null;
}

function phaseLabel(phase) {
  const p = canonicalPhase(phase);
  return p ? PHASE_LABEL[p] : '';
}

module.exports = { PHASES, PHASE_LABEL, canonicalPhase, phaseLabel };
