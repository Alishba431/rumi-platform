'use strict';
/**
 * The failure copy of a quiz born of a LESSON PLAN (or of a typed topic).
 *
 * `tqCouldNotMake` says "this lesson's recording" and "the transcript didn't
 * carry enough". Sent to a teacher who never recorded anything — whose quiz was
 * to be written from a lesson plan the bot made for them — it names a state
 * that does not exist, and every field report it produces sends the next
 * engineer at the wrong layer.
 *
 * So the LP path gets its own three reasons, each naming what actually went
 * wrong: the plan could not be opened, it could not be read, the questions did
 * not come out.
 */
const { UX_STRINGS, resolveUx } = require('../../bot/shared/config/ux-strings');
// Every catalogue language the copy is written in (en + ur).
const { CATALOGUE_LANGUAGES: LANGUAGE_OFFER } = require('../../bot/shared/config/ux-strings');
const { genderedTeacherForms } = require('../../bot/shared/services/quiz/transcript-quiz-pedagogy');

const LP_KEYS = ['tqFailedLpSource', 'tqFailedLpSourceUnusable', 'tqFailedLpModel', 'tqFailedLpAuthor', 'tqFailedLpKeyConflict', 'tqFailedLpKeyDisagreement'];
const cp = (s) => [...String(s)].length;

describe('LP-born quiz failure copy', () => {
  test.each(LP_KEYS)('%s exists in every offered language', (key) => {
    expect(UX_STRINGS[key]).toBeDefined();
    for (const lang of LANGUAGE_OFFER) {
      expect(typeof UX_STRINGS[key][lang]).toBe('string');
      expect(UX_STRINGS[key][lang].trim().length).toBeGreaterThan(0);
    }
  });

  test.each(LP_KEYS)('%s names the lesson plan, never a recording or a transcript', (key) => {
    for (const lang of LANGUAGE_OFFER) {
      const s = UX_STRINGS[key][lang];
      expect(s.toLowerCase()).toContain('lesson plan');
      expect(s.toLowerCase()).not.toMatch(/recording|transcript/);
      // Urdu has its own words for both, and they are just as wrong here.
      expect(s).not.toMatch(/ریکارڈنگ|آواز کی فائل/);
    }
  });

  test.each(LP_KEYS)('%s is gender-neutral about the teacher, in both languages', (key) => {
    for (const lang of LANGUAGE_OFFER) {
      const s = UX_STRINGS[key][lang];
      expect(s).not.toMatch(/\b(she|her|hers|herself|he|him|his|himself)\b/i);
      expect(genderedTeacherForms(s, lang)).toEqual([]);
    }
  });

  test.each(LP_KEYS)('%s fits a WhatsApp body and takes no parameters', (key) => {
    for (const lang of LANGUAGE_OFFER) {
      expect(cp(UX_STRINGS[key][lang])).toBeLessThanOrEqual(1024);
      // resolveUx throws on a missing param, so this also proves the copy has
      // no {placeholder} the failure path would have to fill.
      expect(() => resolveUx(key, { language: lang })).not.toThrow();
    }
  });

  test('the three say three DIFFERENT things — one shared fallback is what misdirected the last fix cycle', () => {
    for (const lang of LANGUAGE_OFFER) {
      const texts = LP_KEYS.map((k) => UX_STRINGS[k][lang]);
      expect(new Set(texts).size).toBe(LP_KEYS.length);
      // and none of them is the transcript copy wearing a new key
      expect(texts).not.toContain(UX_STRINGS.tqCouldNotMake[lang]);
    }
  });
});

describe('the plan quiz row status in /quiz', () => {
  test('tqRowFailedLp exists in both languages, does not promise a retry /quiz cannot give, and is gender-neutral', () => {
    for (const lang of LANGUAGE_OFFER) {
      const s = UX_STRINGS.tqRowFailedLp[lang];
      expect(typeof s).toBe('string');
      expect(s.toLowerCase()).not.toMatch(/retry|tap|دوبارہ/);
      expect(genderedTeacherForms(s, lang)).toEqual([]);
      // status half of a 72-code-point row description
      expect(cp(s)).toBeLessThanOrEqual(30);
    }
  });
});

describe('failureCopyKey — the failure copy is picked by the quiz SOURCE', () => {
  const { failureCopyKey } = require('../../bot/shared/services/quiz/transcript-quiz-generate.service');

  test('a plan quiz (lp_generated) gets the reason that actually fired', () => {
    expect(failureCopyKey('source_missing', 'lp_generated')).toBe('tqFailedLpSource');
    expect(failureCopyKey('source_unusable', 'lp_generated')).toBe('tqFailedLpSourceUnusable');
    expect(failureCopyKey('model_failed', 'lp_generated')).toBe('tqFailedLpModel');
    expect(failureCopyKey('validator_failed', 'lp_generated')).toBe('tqFailedLpAuthor');
  });

  test('a topic quiz never gets the plan copy or the recording copy', () => {
    for (const reason of ['source_unusable', 'model_failed', 'validator_failed', 'something_new']) {
      const key = failureCopyKey(reason, 'topic');
      expect(LP_KEYS).not.toContain(key);
      expect(key).not.toBe('tqCouldNotMake');
      for (const lang of LANGUAGE_OFFER) expect(UX_STRINGS[key][lang].toLowerCase()).not.toMatch(/recording|transcript|lesson plan/);
    }
  });

  test('a transcript quiz gets tqCouldNotMake ONLY when the recording is the problem — our failures say they were ours', () => {
    expect(failureCopyKey('source_unusable', 'transcript')).toBe('tqCouldNotMake');
    expect(failureCopyKey('model_failed', 'transcript')).toBe('tqCouldNotMakeModel');
    expect(failureCopyKey('validator_failed', 'transcript')).toBe('tqCouldNotMakeAuthor');
    expect(failureCopyKey('validator_failed', undefined)).toBe('tqCouldNotMakeAuthor');
    // The recording is gone: said as that, never as a thin transcript.
    expect(failureCopyKey('session_missing', 'transcript')).toBe('tqCouldNotMakeSessionGone');
    // A reason with no sentence of its own is no evidence about the recording.
    expect(failureCopyKey('something_new', 'transcript')).toBe('tqCouldNotMakeModel');
  });

  test('a plan-quiz reason nobody wrote copy for falls back rather than throwing at send time', () => {
    expect(failureCopyKey('something_new', 'lp_generated')).toBe('tqFailedLpAuthor');
  });
});

// ── the hand-off caption: "planned" for a plan, the topic for a topic, never "taught" ───

describe('the hand-off caption by source', () => {
  const PARAMS = { lesson: 'x'.repeat(300), n: 8 };

  test.each(['tqHandoffIntroLp', 'tqHandoffIntroTopic'])('%s exists in every offered language, fills, fits a caption and is gender-neutral', (key) => {
    for (const lang of LANGUAGE_OFFER) {
      const s = resolveUx(key, { language: lang, params: PARAMS });
      expect(s.trim().length).toBeGreaterThan(0);
      expect(cp(s)).toBeLessThanOrEqual(1024);
      expect(UX_STRINGS[key][lang]).not.toMatch(/\b(she|her|hers|herself|he|him|his|himself)\b/i);
      expect(genderedTeacherForms(UX_STRINGS[key][lang], lang)).toEqual([]);
    }
  });

  test('neither the plan nor the topic caption says the lesson was taught — the transcript caption still does', () => {
    for (const key of ['tqHandoffIntroLp', 'tqHandoffIntroTopic']) {
      expect(UX_STRINGS[key].en).not.toMatch(/taught/i);
      expect(UX_STRINGS[key].ur).not.toMatch(/پڑھایا|سکھایا/);
    }
    expect(UX_STRINGS.tqHandoffIntroTopic.en).not.toMatch(/planned/i);
    expect(UX_STRINGS.tqHandoffIntro.en).toMatch(/what you taught/);
  });

  test('handoffIntroKey picks the caption by the quiz source', () => {
    const { handoffIntroKey } = require('../../bot/shared/services/quiz/quiz-sources');
    expect(handoffIntroKey('lp_generated')).toBe('tqHandoffIntroLp');
    expect(handoffIntroKey('topic')).toBe('tqHandoffIntroTopic');
    expect(handoffIntroKey('transcript')).toBe('tqHandoffIntro');
    expect(handoffIntroKey(undefined)).toBe('tqHandoffIntro');
  });
});
