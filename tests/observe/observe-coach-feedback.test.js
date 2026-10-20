/**
 * Coach-the-coach feedback — the pure layer (prompt, validation, render).
 *
 * After the coach records their real debrief conversation with the teacher,
 * this layer turns the transcript into developmental feedback FOR THE COACH:
 * a warm praise line, two wins and one thing to try, judged internally against
 * an 8-key rubric. Three trust rules are enforced in code, not hoped for in a
 * prompt:
 *   1. THE HARM GATE — a coach who disparaged the teacher, or judged the person
 *      instead of the teaching moves, gets NO wins and NO praise; an honest
 *      concern is required. (The forced-two-wins shape once made a model quote
 *      an insult back to a coach as a "win".)
 *   2. NEVER A SCORE — no number-out-of-N, percentage or score reaches the coach.
 *   3. NEVER INVENTED — evidence is the coach's own words; nothing is made up.
 */

const {
  MIN_TRANSCRIPT_CHARS,
  RUBRIC_KEYS,
  COACH_VALUES,
  SCORE_PATTERNS,
  isHarmfulDebrief,
  normalizeCoachValue,
  buildCoachFeedbackPrompt,
  validateCoachFeedback,
  renderCoachFeedbackMessages,
} = require('../../bot/shared/services/observe/observe-coach-feedback');
const { observeStrings } = require('../../bot/shared/services/observe/observe-strings');

const S = observeStrings('en');

const goodRubric = () => ({
  opened_with_specific_praise: true,
  anchored_in_real_moment: true,
  asked_and_waited: false,
  one_improvement_only: true,
  moves_not_teacher: true,
  elicited_if_then: true,
  righting_reflex_held: false,
  disparaged_teacher: false,
});

// A rubric the model really produced for a deliberately abusive role-play.
const abusiveRubric = () => ({
  opened_with_specific_praise: false,
  anchored_in_real_moment: true,
  asked_and_waited: false,
  one_improvement_only: false,
  moves_not_teacher: false,
  elicited_if_then: false,
  righting_reflex_held: false,
  disparaged_teacher: true,
});

const healthy = () => ({
  praise_line: 'You opened by naming a real strength — that is how trust is built.',
  wins: [
    { behaviour: 'Opened with evidence-based praise', evidence: 'I liked how you used the counting sticks.' },
    { behaviour: 'Let the teacher name their own commitment', evidence: 'So what will you try on Monday?' },
  ],
  try: {
    move: 'Hold the silence after your question',
    evidence: 'You asked "how did it go?" and answered it yourself straight away.',
    instead: 'Next time, count to five in your head before you speak again.',
  },
  reflection_question: 'What happens to a teacher\'s thinking when you leave a silence unfilled?',
  value: 'listening',
  rubric: goodRubric(),
});

const harmful = () => ({
  praise_line: null,
  wins: [],
  concern: {
    what_happened: 'You opened by judging the teacher as a person — "you don\'t know how to teach at all".',
    why_it_matters: 'A teacher who feels attacked stops being honest with you, and the coaching stops working.',
    instead: 'Name what you saw, not who they are: "the children were talking during the explanation — what do you make of that?"',
  },
  try: { move: 'Talk about the moves, not the teacher', evidence: '"Your class is filthy."', instead: 'Describe one moment and ask what they make of it.' },
  reflection_question: 'What did the teacher need from you in that first minute?',
  value: null,
  rubric: abusiveRubric(),
});

describe('rubric', () => {
  test('eight keys, in report order, ending on the harm flag', () => {
    expect(RUBRIC_KEYS).toEqual([
      'opened_with_specific_praise', 'anchored_in_real_moment', 'asked_and_waited',
      'one_improvement_only', 'moves_not_teacher', 'elicited_if_then',
      'righting_reflex_held', 'disparaged_teacher',
    ]);
    expect(MIN_TRANSCRIPT_CHARS).toBeGreaterThan(50);
  });
});

describe('isHarmfulDebrief', () => {
  test('disparaged_teacher true → harmful', () => {
    expect(isHarmfulDebrief({ ...goodRubric(), disparaged_teacher: true })).toBe(true);
  });
  test('moves_not_teacher false → harmful (judged the person, not the moves)', () => {
    expect(isHarmfulDebrief({ ...goodRubric(), moves_not_teacher: false })).toBe(true);
  });
  test('the abusive role-play rubric → harmful; a good debrief → not', () => {
    expect(isHarmfulDebrief(abusiveRubric())).toBe(true);
    expect(isHarmfulDebrief(goodRubric())).toBe(false);
    expect(isHarmfulDebrief(null)).toBe(false);
  });
});

describe('validateCoachFeedback — the harm gate (programmatic)', () => {
  test('THE REGRESSION: a harmful debrief with manufactured wins is rejected', () => {
    const abusive = {
      praise_line: 'You named clear, observable details from the lesson.',
      wins: [
        { behaviour: 'Named concrete classroom evidence', evidence: 'Your class is so filthy, no charts up.' },
        { behaviour: 'Called out how noise affected learning', evidence: "The children weren't even listening to you." },
      ],
      try: { move: 'Ask an open question', evidence: 'x', instead: 'y' },
      rubric: abusiveRubric(),
    };
    expect(() => validateCoachFeedback(abusive)).toThrow(/harm|wins/i);
  });

  test('harmful: even ONE win is rejected — never a compliment wrapped round an insult', () => {
    const withWin = { ...harmful(), wins: [{ behaviour: 'Was specific', evidence: 'Your class is filthy.' }] };
    expect(() => validateCoachFeedback(withWin)).toThrow(/wins must be EMPTY/);
  });

  test('harmful: a praise line is rejected', () => {
    expect(() => validateCoachFeedback({ ...harmful(), praise_line: 'Beautiful, direct work!' })).toThrow(/praise/i);
  });

  test('harmful: the concern is required, all three parts', () => {
    const noConcern = harmful();
    delete noConcern.concern;
    expect(() => validateCoachFeedback(noConcern)).toThrow(/concern required/);
    const partial = harmful();
    partial.concern.instead = '';
    expect(() => validateCoachFeedback(partial)).toThrow(/concern required/);
  });

  test('the gate fires on moves_not_teacher=false alone, even when disparaged_teacher is false', () => {
    const personal = { ...healthy(), rubric: { ...goodRubric(), moves_not_teacher: false } };
    expect(() => validateCoachFeedback(personal)).toThrow(/harmful debrief/);
  });

  test('a properly-shaped harmful feedback passes', () => {
    expect(() => validateCoachFeedback(harmful())).not.toThrow();
  });
});

describe('validateCoachFeedback — the normal shape', () => {
  test('a healthy debrief passes with a praise line, exactly 2 wins and 1 try', () => {
    expect(validateCoachFeedback(healthy())).toBe(true);
  });

  test('1 or 3 wins are rejected', () => {
    expect(() => validateCoachFeedback({ ...healthy(), wins: [healthy().wins[0]] })).toThrow(/exactly 2 wins/);
    const three = healthy();
    three.wins.push({ behaviour: 'x', evidence: 'y' });
    expect(() => validateCoachFeedback(three)).toThrow(/exactly 2 wins/);
  });

  test('each win needs behaviour + evidence; the try needs move + evidence; praise is required', () => {
    const noEvidence = healthy();
    noEvidence.wins[1].evidence = '';
    expect(() => validateCoachFeedback(noEvidence)).toThrow(/behaviour \+ evidence/);
    expect(() => validateCoachFeedback({ ...healthy(), try: { move: 'x' } })).toThrow(/try/);
    expect(() => validateCoachFeedback({ ...healthy(), praise_line: '' })).toThrow(/praise_line/);
  });

  test('every rubric key must be judged true/false — including disparaged_teacher', () => {
    const missing = healthy();
    delete missing.rubric.disparaged_teacher;
    expect(() => validateCoachFeedback(missing)).toThrow(/rubric incomplete: disparaged_teacher/);
    expect(() => validateCoachFeedback({ ...healthy(), rubric: undefined })).toThrow(/rubric missing/);
    expect(() => validateCoachFeedback(null)).toThrow(/feedback missing/);
  });

  test('the value is optional decoration: unknown values are normalised to null, never rejected', () => {
    const fb = { ...healthy(), value: 'Courage' };
    expect(validateCoachFeedback(fb)).toBe(true);
    expect(fb.value).toBeNull();
    expect(normalizeCoachValue(' Trust ')).toBe('trust');
    expect(Object.keys(COACH_VALUES)).toEqual(['trust', 'respect', 'listening', 'growth', 'partnership']);
  });
});

describe('validateCoachFeedback — no score ever reaches the coach', () => {
  const leaks = [
    ['an N/M mark', 'You hit 6/8 of the moves.'],
    ['a percentage', 'About 75% of your talk was questions.'],
    ['N out of M', 'You did 5 out of 7 behaviours.'],
    ['a score label', 'Score: 4'],
    ['a rating', 'rated 3 on listening'],
  ];
  test.each(leaks)('rejects %s anywhere in the feedback', (_label, text) => {
    const inPraise = { ...healthy(), praise_line: text };
    expect(() => validateCoachFeedback(inPraise)).toThrow(/leaks a score/);
    const inTry = healthy();
    inTry.try.instead = text;
    expect(() => validateCoachFeedback(inTry)).toThrow(/leaks a score/);
    const inQuestion = { ...healthy(), reflection_question: text };
    expect(() => validateCoachFeedback(inQuestion)).toThrow(/leaks a score/);
  });

  test('ordinary small numbers in a quote (a time, "two children") are not scores', () => {
    const fb = healthy();
    fb.wins[0].evidence = 'At about minute 8 you said: "two children answered first".';
    expect(validateCoachFeedback(fb)).toBe(true);
    expect(SCORE_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });
});

describe('buildCoachFeedbackPrompt — the language-parametric prompt', () => {
  const TRANSCRIPT = 'Teacher: Thank you for coming in today. I liked how you used the counting sticks. '
    + 'Student: Thanks. I think most of them understood. Teacher: What will you try on Monday?';
  const p = buildCoachFeedbackPrompt(TRANSCRIPT, { coachName: 'Sam' });

  test('carries the transcript and every rubric key', () => {
    expect(p).toContain(TRANSCRIPT);
    for (const k of RUBRIC_KEYS) expect(p).toContain(k);
  });

  test('instructs the harm gate: empty wins, null praise, a filled concern', () => {
    expect(p).toMatch(/DISPARAGED/);
    expect(p).toMatch(/"wins" MUST be an empty list/);
    expect(p).toMatch(/"praise_line" MUST be null/);
    expect(p).toMatch(/"concern" MUST be filled/);
  });

  test('forbids any number or score, and invention — the coach\'s OWN words are quoted', () => {
    expect(p).toMatch(/NEVER include any number, score, percentage or grade/);
    expect(p).toMatch(/NEVER invent/);
    expect(p).toMatch(/quoting the coach's OWN words/);
  });

  test('pins the try to a behaviour judged FALSE — never re-suggest one already done', () => {
    expect(p).toMatch(/rubric key you judged FALSE/i);
    expect(p).toMatch(/NEVER suggest a behaviour you judged TRUE/i);
  });

  test('speaks in the second person and keeps both adults gender-neutral', () => {
    expect(p).toMatch(/SECOND PERSON/);
    expect(p).toMatch(/they\/them/);
    expect(p).not.toMatch(/\b(she|her|hers|he|him|his)\b/i);
  });

  test('warns that the transcriber\'s speaker labels are only two voices, not roles', () => {
    expect(p).toMatch(/speaker labels/i);
  });

  test('writes the feedback in the requested language (English by default)', () => {
    expect(p).toMatch(/Write ALL coach-facing text in English/);
    expect(buildCoachFeedbackPrompt('x', { language: 'fr' })).toMatch(/in French/);
  });

  test('speaks of "the coach" — no deployment-specific role names or language', () => {
    expect(p).not.toMatch(/\bofficer\b/i);
    expect(p).toMatch(/coach THE COACH/);
  });
});

describe('renderCoachFeedbackMessages', () => {
  test('healthy: a praise bubble, then the card — 2 ticks, the try, the action plan, the question', () => {
    const [praise, card] = renderCoachFeedbackMessages(healthy(), S);
    expect(praise).toBe(healthy().praise_line);
    expect((card.match(/✓/g) || [])).toHaveLength(2);
    expect(card).toContain('Hold the silence after your question');
    expect(card).toContain(S.coach_card_action_label);
    expect(card).toContain('count to five');
    expect(card).toContain(S.coach_card_reflect_label);
    expect(card).toContain(S.coach_card_closing);
    expect(card).not.toMatch(/\d+\s*\/\s*\d+|%/);
  });

  test('harmful: opens with the honest opener, names it, no ticks, still gives the move', () => {
    const msgs = renderCoachFeedbackMessages(harmful(), S);
    expect(msgs[0]).toBe(S.coach_concern_opener);
    const all = msgs.join('\n');
    expect(all).not.toMatch(/✓/);
    expect(all).not.toContain(S.coach_card_wins_label);
    expect(all).toMatch(/judging the teacher as a person/);
    expect(all).toMatch(/stops being honest/);
    expect(all).toMatch(/Talk about the moves/);
    expect(all).toContain(S.coach_concern_closing);
  });

  test('stays under the 4096-character message cap without splitting an emoji', () => {
    const fb = healthy();
    fb.try.evidence = '🌱'.repeat(3000);
    const [, card] = renderCoachFeedbackMessages(fb, S);
    expect(card.length).toBeLessThanOrEqual(4096);
    expect(card.endsWith(S.coach_card_closing)).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(card)).toBe(false);
  });
});
