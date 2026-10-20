/**
 * question-types — which kinds of question a subject supports, how many of
 * each, and reading the numbers a teacher types.
 *
 * The parsers came across from the generator this feature was ported from;
 * the catalogue did not. That one was keyed to a single country's primary
 * subjects, so here any subject name lands in one of five neutral families,
 * and a subject nobody planned for still gets a sensible paper.
 *
 * Pure functions, no I/O.
 */

const QT = require('../../bot/shared/services/testpaper/question-types');

describe('subject families', () => {
  it.each([
    ['English', 'language'],
    ['urdu', 'language'],
    ['Kiswahili', 'language'],
    ['French language', 'language'],
    ['Reading', 'language'],
    ['Math', 'maths'],
    ['Mathematics', 'maths'],
    ['Numeracy', 'maths'],
    ['General Science', 'science'],
    ['Biology', 'science'],
    ['Social Studies', 'social_studies'],
    ['History', 'social_studies'],
    ['geography', 'social_studies'],
    ['Art', 'general'],
    ['', 'general'],
    [null, 'general'],
  ])('%s → %s', (subject, family) => {
    expect(QT.familyOf(subject)).toBe(family);
  });

  it('ships no religious or single-country subject pack', () => {
    expect(Object.keys(QT.CATALOGUE).sort())
      .toEqual(['general', 'language', 'maths', 'science', 'social_studies']);
  });

  it('a subject nobody planned for still offers objective and subjective types', () => {
    const types = QT.forSubject('Music', 4);
    expect(types.some((t) => t.category === 'objective')).toBe(true);
    expect(types.some((t) => t.category === 'subjective')).toBe(true);
  });

  it('language subjects split their writing tasks by grade band', () => {
    const young = QT.forSubject('English', 1).map((t) => t.id);
    const older = QT.forSubject('English', 5).map((t) => t.id);
    expect(young).not.toContain('Essay Writing');
    expect(older).toContain('Essay Writing');
  });
});

describe('withCounts / defaultMix', () => {
  it('spreads a total with the remainder on the earlier types', () => {
    const out = QT.withCounts(['MCQs', 'True/False', 'Short Questions'], 10, 'Science', 4);
    expect(out.map((t) => t.count)).toEqual([4, 3, 3]);
  });

  it('tags every type with its category for the subject', () => {
    const out = QT.withCounts(['MCQs', 'Short Questions'], 4, 'Science', 4);
    expect(out).toEqual([
      { id: 'MCQs', count: 2, category: 'objective' },
      { id: 'Short Questions', count: 2, category: 'subjective' },
    ]);
  });

  it('a mix sums to the total asked for', () => {
    const mix = QT.defaultMix('Maths', 3, 15);
    expect(mix.reduce((s, t) => s + t.count, 0)).toBe(15);
  });
});

describe('presetMix', () => {
  it.each([['quick', 10], ['standard', 20], ['full', 30]])('%s paper holds %i questions', (preset, n) => {
    const mix = QT.presetMix(preset, 'Science', 5);
    expect(mix.reduce((s, t) => s + t.count, 0)).toBe(n);
  });

  it('a quick paper is objective only — fast to mark', () => {
    expect(QT.presetMix('quick', 'English', 3).every((t) => t.category === 'objective')).toBe(true);
  });

  it('a full paper carries at least one extended-answer type', () => {
    const ids = QT.presetMix('full', 'Maths', 5).map((t) => t.id);
    expect(ids.some((id) => QT.EXTENDED_TYPES.includes(id))).toBe(true);
  });

  it('an unknown preset is null, not a guess', () => {
    expect(QT.presetMix('huge', 'Maths', 5)).toBeNull();
  });
});

describe('parseMixText — a mix typed into chat', () => {
  it('reads counts against type names, loosely spelled', () => {
    const r = QT.parseMixText('5 MCQs, 3 true/false, 2 short questions', 'Science', 4);
    expect(r.ok).toBe(true);
    expect(r.types).toEqual([
      { id: 'MCQs', count: 5, category: 'objective' },
      { id: 'True/False', count: 3, category: 'objective' },
      { id: 'Short Questions', count: 2, category: 'subjective' },
    ]);
    expect(r.total).toBe(10);
  });

  it('accepts "type: n" and singular names', () => {
    const r = QT.parseMixText('mcq: 4\nfill in the blank: 2', 'Maths', 3);
    expect(r.ok).toBe(true);
    expect(r.types.map((t) => [t.id, t.count])).toEqual([['MCQs', 4], ['Fill in the Blanks', 2]]);
  });

  it('refuses a type the subject does not offer, naming it', () => {
    const r = QT.parseMixText('3 label the diagram', 'English', 4);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/label the diagram/i);
  });

  it('refuses a total over the ceiling rather than clamping', () => {
    const r = QT.parseMixText('40 MCQs, 20 true/false', 'Science', 4);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(String(QT.MAX_QUESTIONS));
  });

  it('refuses text with no counts at all', () => {
    expect(QT.parseMixText('lots of questions please', 'Science', 4).ok).toBe(false);
  });
});

// Ported unchanged from the source generator's own suite.
describe('parseQuestionCount', () => {
  it.each(['1', '15', '50'])('accepts %s', (raw) => {
    expect(QT.parseQuestionCount(raw)).toEqual({ ok: true, count: Number(raw) });
  });
  it.each(['', '0', '-5', '7.5', 'abc', '51', '999'])('refuses %p', (raw) => {
    expect(QT.parseQuestionCount(raw).ok).toBe(false);
  });
});

describe('parseTotalMarks', () => {
  it('blank is a choice: no budget', () => {
    expect(QT.parseTotalMarks('')).toEqual({ ok: true, marks: null });
  });
  it('accepts a number in range', () => {
    expect(QT.parseTotalMarks('50')).toEqual({ ok: true, marks: 50 });
  });
  it.each(['0', '1001', 'ten', '4.5'])('refuses %p', (raw) => {
    expect(QT.parseTotalMarks(raw).ok).toBe(false);
  });
});

describe('parsePerTypeCounts', () => {
  it('reads one box per picked type, positional', () => {
    const r = QT.parsePerTypeCounts(['MCQs', 'True/False'], { count_1: '4', count_2: '3' }, 'Science', 4);
    expect(r).toEqual({
      ok: true,
      total: 7,
      types: [
        { id: 'MCQs', count: 4, category: 'objective' },
        { id: 'True/False', count: 3, category: 'objective' },
      ],
    });
  });
  it('a blank box bounces, naming the type', () => {
    const r = QT.parsePerTypeCounts(['MCQs'], { count_1: '' }, 'Science', 4);
    expect(r.ok).toBe(false);
    expect(r.slot).toBe(1);
    expect(r.message).toMatch(/MCQs/);
  });
  it('checks the ceiling on the sum including seen questions', () => {
    const r = QT.parsePerTypeCounts(['MCQs'], { count_1: '45' }, 'Science', 4, 10);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/10 Seen \+ 45 Unseen/);
  });
});
