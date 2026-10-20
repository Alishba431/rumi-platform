/**
 * Shared utilities for report data transformers.
 *
 * Bead: (Phase 1C-A2)
 */

const { logToFile } = require('../../../utils/logger');

/**
 * Format a date string to a readable format.
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date (e.g., "March 4, 2026")
 */
function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Extract fidelity section from analysis if present.
 *
 * Preferred: the MEASURED lesson-plan fidelity (analysis_data.lp_fidelity, LP_FIDELITY_ENABLED) — band, "N of M
 * planned moves delivered" and a per-move table, or a "not assessed" line saying why. Without it (the feature off,
 * or an older session) the legacy whole-lesson estimate is returned exactly as before.
 * @param {object} analysis - Enhanced analysis data
 * @returns {object|null} Fidelity section or null
 */
function extractFidelity(analysis) {
  if (analysis.lp_fidelity) {
    const { buildFidelityReportSection } = require('../fidelity/fidelity-report');
    return buildFidelityReportSection(analysis.lp_fidelity, analysis.language || 'en');
  }
  if (!analysis.fidelity_analysis) return null;

  return {
    score: analysis.fidelity_analysis.score || 0,
    maxScore: analysis.fidelity_analysis.max_score || 100,
    note: analysis.fidelity_analysis.note || 'Informational only',
    commentary: analysis.fidelity_analysis.overall_commentary || analysis.fidelity_analysis.note || '',
    evidence: analysis.fidelity_analysis.evidence || [],
    strengths: analysis.fidelity_analysis.strengths || [],
    gaps: analysis.fidelity_analysis.gaps || [],
  };
}

/**
 * Build partial report note from session flags.
 * @param {object} session - Session data
 * @returns {string|null} Partial note or null
 */
function buildPartialNote(session) {
  if (!session._isPartialReport) return null;

  const questionsCompleted = session._questionsAtCompletion || 0;

  if (session._isAutoCompleted) {
    return questionsCompleted > 0
      ? `Note: This report includes ${questionsCompleted}/3 reflective responses. The session was auto-completed after 12 hours of inactivity. Full insights require completing all reflection questions.`
      : `Note: This report is based on classroom audio analysis only. The reflective conversation was not completed (auto-completed after 12 hours of inactivity).`;
  }

  if (session._isUserRequestedEarly) {
    return questionsCompleted > 0
      ? `Note: This report includes ${questionsCompleted}/3 reflective responses. You requested early completion. Full insights require completing all reflection questions.`
      : `Note: This report is based on classroom audio analysis only. The reflective conversation was skipped at your request.`;
  }

  return null;
}

module.exports = { formatDate, extractFidelity, buildPartialNote };
