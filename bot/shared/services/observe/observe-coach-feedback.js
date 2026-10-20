/**
 * Coach-the-coach feedback (pure layer: prompt, validation, render).
 *
 * After the coach records their real debrief conversation with the teacher,
 * this layer turns the transcript into developmental feedback FOR THE COACH:
 * a warm praise line, two wins and one thing to try, judged internally against
 * an eight-key rubric of observable conversation behaviours (affirm first with
 * real evidence, one question and then silence, ONE improvement, the teacher's
 * own if-then commitment, the moves not the person).
 *
 * HARD RULE: the coach NEVER sees a score, rating or rubric internals. The
 * rubric booleans are stored on the row for research only.
 *
 * One prompt, language-parametric. The original deployment also carried a
 * separate prompt written natively in one market's language; it was dropped
 * here because its rules were identical to this one and it hard-wired that
 * market's language and vocabulary. A deployment that needs native-language
 * feedback passes the coach's language and gets the same rules.
 */

const { botName } = require('../../config/branding');

const MIN_TRANSCRIPT_CHARS = 150;

// The behaviours, in report order. The last key is the harm flag.
const RUBRIC_KEYS = [
  'opened_with_specific_praise', // a genuine, specific strength (not generic)
  'anchored_in_real_moment',     // feedback tied to a moment from THIS lesson
  'asked_and_waited',            // reflective question + space (teacher talk follows)
  'one_improvement_only',        // ONE improvement, no punch-list
  'moves_not_teacher',           // talked about the moves, never verdicts on the person
  'elicited_if_then',            // the teacher's OWN if-then commitment, not dictated
  'righting_reflex_held',        // didn't lecture, take over, or answer their own questions
  'disparaged_teacher',          // belittled, insulted or judged the teacher as a person
];

// The fixed value vocabulary the card is anchored on. Small on purpose: the
// model picks the ONE the coach's conversation embodied — or null.
const COACH_VALUES = {
  trust: 'Trust',
  respect: 'Respect',
  listening: 'Listening',
  growth: 'Growth',
  partnership: 'Partnership',
};

function normalizeCoachValue(v) {
  if (typeof v !== 'string') return null;
  const key = v.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(COACH_VALUES, key) ? key : null;
}

/**
 * THE HARM GATE.
 *
 * A tester role-played an abusive coach ("your class was very bad", "you don't
 * know how to teach at all") and the feedback came back with a WIN quoting the
 * insult as "concrete classroom evidence". The rubric had judged the debrief
 * correctly; the bug was a feedback shape that REQUIRED two wins, so the model
 * had to manufacture praise and the only concrete material was the abuse.
 *
 * Wins are never mandatory. When the coach disparaged the teacher, or made it
 * about the person rather than the teaching moves, we owe the coach honesty —
 * and the teacher, never to have that behaviour reinforced.
 */
function isHarmfulDebrief(rubric) {
  if (!rubric) return false;
  return rubric.disparaged_teacher === true || rubric.moves_not_teacher === false;
}

function _languageName(lang) {
  if (!lang || lang === 'en') return 'English';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || 'English';
  } catch (_) {
    return 'English';
  }
}

/**
 * @param {string} transcript  the debrief conversation, as transcribed
 * @param {object} [options]
 * @param {string} [options.coachName]  the coach's name, for the model only
 * @param {string} [options.language]   ISO code the feedback is written in (default 'en')
 */
function buildCoachFeedbackPrompt(transcript, options = {}) {
  const langName = _languageName(options.language);
  return `You are ${botName}, a warm coaching mentor for the people who coach teachers. A coach (${options.coachName || 'the coach'}) recorded their REAL debrief conversation with a teacher after observing a lesson. Read the transcript and coach THE COACH on how they coached.

SPEAK DIRECTLY TO THE COACH, in the SECOND PERSON ("you said…", "you asked…") — NEVER narrate them in the third person. Write ALL coach-facing text in ${langName}; keep evidence quotes verbatim, in the language actually spoken.

GENDER (mandatory): never assume the gender of the coach or the teacher. Refer to the teacher as "the teacher" or with they/them, and keep every sentence gender-neutral.

SPEAKERS: the transcript's speaker labels come from a classroom transcriber, so "Teacher" and "Student" only tell two voices apart — they are NOT the roles in this conversation. Work out from what is said which voice is the coach and which is the teacher.

First, silently judge the rubric (true/false each, internal only — never shown):
${RUBRIC_KEYS.map((k) => `- ${k}`).join('\n')}

THE HARD RULES (breaking any of these harms a real teacher):
1. If the coach DISPARAGED the teacher (insults, humiliation, "you don't know how to teach", "your class is filthy") or made it about the PERSON instead of the teaching moves — that is a HARMFUL debrief: "wins" MUST be an empty list, "praise_line" MUST be null, and "concern" MUST be filled honestly (what_happened + why it costs the teacher's trust + what to do instead). NEVER manufacture praise for cruelty, and never quote an insult as a strength.
2. If the debrief was respectful: exactly 2 wins, each quoting the coach's OWN words from this transcript as evidence, plus ONE thing to try. "concern" is null.
3. NEVER include any number, score, percentage or grade about the coach — no "N out of M", no ratings, anywhere.
4. If nothing clearly matches a field, use null/[] honestly — NEVER invent. A quote the coach never said destroys the trust this tool runs on.
5. "value": the ONE value the coach's conversation most embodied — ${Object.keys(COACH_VALUES).map((k) => `"${k}"`).join(' | ')} — or null if none is clearly visible. NEVER force one.
6. "try" is a COACHING move for the coach's NEXT DEBRIEF — how they ask, wait, listen, sequence praise, or draw out the teacher's own commitment (e.g. "hold the silence after your question", "let the teacher say the plan in their own words"). It is NEVER classroom-teaching advice — that belongs in the teacher's report, not here. "evidence" = the moment in THIS debrief that shows why (quote the coach); "instead" = what to do differently next time, offered as a choice, not an order.
7. "try" MUST target a behaviour the coach did NOT already do well — pick it from a rubric key you judged FALSE. NEVER suggest a behaviour you judged TRUE. If you judged "elicited_if_then" TRUE, do NOT tell them to "ask the teacher to name the step / make the plan / commit" — they did that; choose a different growth edge. If EVERY rubric key is TRUE, make "try" a subtle refinement of their strongest move, and its "evidence" MUST acknowledge they already do it.
8. "reflection_question": ONE short, open question for the coach to sit with before their next debrief — about how they coached, never about the teacher's lesson. Never yes/no, never leading, never a disguised instruction.

Return JSON with EXACTLY this structure:
{ "praise_line": "..." (or null if harmful), "wins": [ { "behaviour": "...", "evidence": "..." } ] (or [] if harmful), "concern": { "what_happened": "...", "why_it_matters": "...", "instead": "..." } (or null if not harmful), "try": { "move": "...", "evidence": "...", "instead": "..." }, "reflection_question": "...", "value": ${Object.keys(COACH_VALUES).map((k) => `"${k}"`).join('|')}|null, "rubric": { ${RUBRIC_KEYS.map((k) => `"${k}": true/false`).join(', ')} } }

TRANSCRIPT OF THE COACH'S DEBRIEF:
${transcript}`;
}

// ── Validation (programmatic gates) ────────────────────────────────────

// Anything that reads as a mark on the coach. Ordinary numbers inside a quote
// ("about minute 8", "two children") are not scores and pass.
const SCORE_PATTERNS = [
  /\d+\s*\/\s*\d+/,                                 // 6/8
  /\d+\s*%/,                                        // 75%
  /\b\d+\s+out\s+of\s+\d+\b/i,                      // 5 out of 7
  /\bscore[sd]?\s*(?:of|:|\s)\s*\d+/i,              // score: 4, scored 3
  /\b(?:rated|rating|grade[sd]?|marks?)\s*(?:of|:|\s)\s*\d+/i, // rated 3, mark 2
  /\bpercent(?:age)?\s*(?:of\s*)?\d+/i,
];

function _allFeedbackText(fb) {
  const parts = [fb.praise_line || '', fb.reflection_question || ''];
  for (const w of fb.wins || []) parts.push(w.behaviour || '', w.evidence || '');
  if (fb.concern) {
    parts.push(fb.concern.what_happened || '', fb.concern.why_it_matters || '', fb.concern.instead || '');
  }
  if (fb.try) parts.push(fb.try.move || '', fb.try.evidence || '', fb.try.instead || '');
  return parts.join('\n');
}

/**
 * Throws with a specific message on any shape or trust violation. The
 * message is fed back verbatim to the model on the one guided repair.
 */
function validateCoachFeedback(fb) {
  if (!fb || typeof fb !== 'object') throw new Error('feedback missing');
  // The value is optional decoration — normalise, never reject.
  fb.value = normalizeCoachValue(fb.value);

  // Rubric first — the harm gate is derived from it, so it must be complete.
  if (!fb.rubric || typeof fb.rubric !== 'object') throw new Error('rubric missing');
  for (const key of RUBRIC_KEYS) {
    if (typeof fb.rubric[key] !== 'boolean') {
      throw new Error(`rubric incomplete: ${key} must be judged true/false`);
    }
  }

  if (isHarmfulDebrief(fb.rubric)) {
    // The coach mistreated the teacher. We do NOT congratulate that — not with
    // a manufactured win, not with a warm opener wrapped round it. This is a
    // gate in code, not a prompt we hope the model obeys.
    if (Array.isArray(fb.wins) && fb.wins.length > 0) {
      throw new Error('harmful debrief: wins must be EMPTY — never praise a coach for mistreating a teacher');
    }
    if (fb.praise_line) {
      throw new Error('harmful debrief: no celebratory praise_line — lead with the concern');
    }
    const c = fb.concern;
    if (!c || !c.what_happened || !c.why_it_matters || !c.instead) {
      throw new Error('harmful debrief: concern required (what_happened + why_it_matters + instead)');
    }
  } else {
    if (!fb.praise_line) throw new Error('feedback needs a praise_line');
    if (!Array.isArray(fb.wins) || fb.wins.length !== 2) {
      throw new Error('feedback needs exactly 2 wins');
    }
    for (const w of fb.wins) {
      if (!w || !w.behaviour || !w.evidence) throw new Error('each of the 2 wins needs behaviour + evidence');
    }
  }

  if (!fb.try || !fb.try.move || !fb.try.evidence) {
    throw new Error('feedback needs one try with move + evidence');
  }

  const text = _allFeedbackText(fb);
  for (const rx of SCORE_PATTERNS) {
    if (rx.test(text)) throw new Error(`feedback leaks a score on the coach (${rx})`);
  }
  return true;
}

// ── Render: a warm praise bubble, then the card ────────────────────────

const MESSAGE_CAP = 4096;

// Truncate on code POINTS, never UTF-16 units, so an emoji's surrogate pair is
// never split into a lone surrogate (which a channel may reject outright).
function _capped(text, closing) {
  if (text.length <= MESSAGE_CAP) return text;
  const tail = closing ? `\n…\n${closing}` : '…';
  const budget = MESSAGE_CAP - tail.length;
  let kept = '';
  for (const ch of Array.from(text)) {
    if (kept.length + ch.length > budget) break;
    kept += ch;
  }
  return kept + tail;
}

const _squash = (lines) => lines
  .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
  .join('\n')
  .trim();

/**
 * @returns {[string, string]} [opening message, card message]
 */
function renderCoachFeedbackMessages(fb, S) {
  // The harmful path: no celebration card, no ticks, no manufactured praise.
  // An honest, warm concern that names what happened, says why it costs the
  // teacher's trust, and gives the move. Still never a score.
  if (isHarmfulDebrief(fb.rubric)) {
    const c = fb.concern || {};
    const hard = _squash([
      `💬 *${S.coach_concern_title}*`,
      '',
      c.what_happened || '',
      '',
      c.why_it_matters || '',
      '',
      `🎯 *${S.coach_card_try_label}: ${fb.try.move}*`,
      c.instead || fb.try.instead || '',
      '',
      S.coach_concern_closing,
    ]);
    return [S.coach_concern_opener, _capped(hard, S.coach_concern_closing)];
  }

  const winLines = fb.wins
    .map((w) => `✓ *${w.behaviour}*\n_"${w.evidence}"_`)
    .join('\n\n');

  // The same three headings the coach just used with the teacher, now about
  // their own coaching, then ONE question to sit with.
  const actionBlock = fb.try.instead
    ? ['', `📋 *${S.coach_card_action_label}*`, fb.try.instead]
    : [];
  const reflectBlock = fb.reflection_question
    ? ['', `❓ *${S.coach_card_reflect_label}*`, `_"${fb.reflection_question}"_`]
    : [];

  const card = _squash([
    `🌟 *${S.coach_card_title}*`,
    '',
    `💪 *${S.coach_card_wins_label}*`,
    winLines,
    '',
    `🌱 *${S.coach_card_try_label}: ${fb.try.move}*`,
    fb.try.evidence,
    ...actionBlock,
    ...reflectBlock,
    '',
    S.coach_card_closing,
  ]);

  return [fb.praise_line, _capped(card, S.coach_card_closing)];
}

module.exports = {
  MIN_TRANSCRIPT_CHARS,
  RUBRIC_KEYS,
  COACH_VALUES,
  SCORE_PATTERNS,
  normalizeCoachValue,
  isHarmfulDebrief,
  buildCoachFeedbackPrompt,
  validateCoachFeedback,
  renderCoachFeedbackMessages,
};
