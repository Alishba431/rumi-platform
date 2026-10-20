'use strict';
/**
 * The quiz language is a deployment setting, not a fixed pair.
 *
 * QUIZ_LANGUAGES lists the languages a lesson quiz can be written in (default
 * `en`). The language ask lists exactly those, the subject rule only ever picks
 * one of them, and the teacher is asked only when there is a real choice.
 * QUIZ_SUBJECT_LANGUAGE lets a deployment fix a subject's language
 * (`islamiat:ur`); a language lesson (Urdu, English) is quizzed in that language
 * whenever it is a quiz language. Lesson dates are written in SCHOOL_TIMEZONE.
 */

const ENV = ['QUIZ_LANGUAGES', 'QUIZ_SUBJECT_LANGUAGE', 'SCHOOL_TIMEZONE'];
const saved = {};
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const L = require('../../bot/shared/services/quiz/transcript-quiz-language');

describe('the language ask lists QUIZ_LANGUAGES', () => {
  test('three configured languages give three buttons, the rule language first, each titled in its own name', () => {
    process.env.QUIZ_LANGUAGES = 'en,ur,fr';
    const buttons = L.languageAskButtons('q-1', 'fr');
    expect(buttons.map((b) => b.id)).toEqual(['tq_lang_fr_q-1', 'tq_lang_en_q-1', 'tq_lang_ur_q-1']);
    expect(buttons.map((b) => b.title)).toEqual(['Français', 'English', 'اردو']);
  });

  test('a rule language that is not configured does not appear; the first configured one leads', () => {
    process.env.QUIZ_LANGUAGES = 'en,fr';
    expect(L.languageAskButtons('q-2', 'ur').map((b) => b.id)).toEqual(['tq_lang_en_q-2', 'tq_lang_fr_q-2']);
  });

  test('the button prefix parses back for any configured code', () => {
    process.env.QUIZ_LANGUAGES = 'en,ta-IN';
    const [, second] = L.languageAskButtons('3f2a', 'en');
    expect(second.id).toBe('tq_lang_ta-IN_3f2a');
    expect(L.parseLanguageButton(second.id)).toEqual({ language: 'ta-IN', quizId: '3f2a' });
    expect(L.parseLanguageButton('tq_lang_xx_3f2a')).toBeNull();
  });
});

describe('needsLanguageAsk', () => {
  test('one configured language (the default) never asks', () => {
    expect(L.needsLanguageAsk('maths')).toBe(false);
    process.env.QUIZ_LANGUAGES = 'fr';
    expect(L.needsLanguageAsk('science')).toBe(false);
  });

  test('two languages ask for an ordinary subject', () => {
    process.env.QUIZ_LANGUAGES = 'en,ur';
    expect(L.needsLanguageAsk('maths')).toBe(true);
  });

  test('a language lesson in a configured language is not asked', () => {
    process.env.QUIZ_LANGUAGES = 'en,ur';
    expect(L.needsLanguageAsk('urdu')).toBe(false);
    expect(L.needsLanguageAsk('English')).toBe(false);
  });

  test('a language lesson whose language is not configured is asked like any other', () => {
    process.env.QUIZ_LANGUAGES = 'en,fr';
    expect(L.needsLanguageAsk('urdu')).toBe(true);
  });

  test('QUIZ_SUBJECT_LANGUAGE fixes a subject, and is empty by default', () => {
    process.env.QUIZ_LANGUAGES = 'en,ur';
    expect(L.needsLanguageAsk('islamiat')).toBe(true);
    process.env.QUIZ_SUBJECT_LANGUAGE = 'islamiat:ur, sst:ur';
    expect(L.needsLanguageAsk('Islamiyat')).toBe(false);
    expect(L.needsLanguageAsk('Social Studies')).toBe(false);
    expect(L.quizLanguageFor('islamiat', 'en')).toBe('ur');
  });
});

describe('quizLanguageFor picks only configured languages', () => {
  test('default deployment: everything is English', () => {
    expect(L.quizLanguageFor('urdu', 'ur')).toBe('en');
    expect(L.quizLanguageFor('maths', 'ur')).toBe('en');
  });

  test('the lesson language when it is configured, the first configured language otherwise', () => {
    process.env.QUIZ_LANGUAGES = 'fr,en';
    expect(L.quizLanguageFor('maths', 'en-GB')).toBe('en');
    expect(L.quizLanguageFor('maths', 'fr')).toBe('fr');
    expect(L.quizLanguageFor('maths', 'mixed')).toBe('fr');
    expect(L.quizLanguageFor('science', null)).toBe('fr');
  });
});

describe('languageName', () => {
  test('names a language in English from the registry, with a neutral fallback', () => {
    expect(L.languageName('ur')).toBe('Urdu');
    expect(L.languageName('fr')).toBe('French');
    expect(L.languageName('zz')).toBe('the lesson\'s own language');
  });
});

describe('formatLessonDate is in school time', () => {
  test('the same instant is a different school date east of Greenwich', () => {
    const iso = '2026-03-04T20:00:00Z';
    expect(L.formatLessonDate(iso, 'en')).toBe('4 Mar');
    process.env.SCHOOL_TIMEZONE = 'Asia/Tokyo';
    expect(L.formatLessonDate(iso, 'en')).toBe('5 Mar');
    expect(L.formatLessonDate(iso, 'en', { year: true })).toBe('5 Mar 2026');
  });
});
