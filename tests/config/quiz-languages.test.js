const QuizLanguages = require('../../bot/shared/config/quiz-languages');

// The languages a lesson quiz can be WRITTEN in are the deployment's, from
// QUIZ_LANGUAGES — the language ask lists exactly these, in this order.
describe('quiz-languages', () => {
  const saved = process.env.QUIZ_LANGUAGES;
  afterEach(() => {
    if (saved === undefined) delete process.env.QUIZ_LANGUAGES; else process.env.QUIZ_LANGUAGES = saved;
  });

  it('defaults to English only (no language ask)', () => {
    delete process.env.QUIZ_LANGUAGES;
    expect(QuizLanguages.quizLanguages()).toEqual(['en']);
    expect(QuizLanguages.asksLanguage()).toBe(false);
  });

  it('reads the configured list in order, de-duplicated, unknown codes dropped', () => {
    process.env.QUIZ_LANGUAGES = ' ur, en ,ur,xx, fr';
    expect(QuizLanguages.quizLanguages()).toEqual(['ur', 'en', 'fr']);
    expect(QuizLanguages.asksLanguage()).toBe(true);
    expect(QuizLanguages.isQuizLanguage('fr')).toBe(true);
    expect(QuizLanguages.isQuizLanguage('es')).toBe(false);
  });

  it('a list with nothing usable falls back to English rather than to no language', () => {
    process.env.QUIZ_LANGUAGES = 'xx,,';
    expect(QuizLanguages.quizLanguages()).toEqual(['en']);
  });

  it('describes a language for pickers and prompts', () => {
    expect(QuizLanguages.getLanguage('ur')).toEqual({
      code: 'ur', direction: 'rtl', languageTitle: 'اردو', languageDescription: 'Urdu',
    });
    expect(QuizLanguages.getLanguage('en').direction).toBe('ltr');
    expect(QuizLanguages.getLanguage('zz')).toBeUndefined();
  });
});
