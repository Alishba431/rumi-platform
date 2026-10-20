'use strict';
/**
 * Every model-written or teacher-typed field on the teacher sheet, and every
 * label in a figure, is text, never markup.
 *
 * The sheet and the figure PNG are printed by the server's browser, so a field
 * that carried `</text><script>` or `"><img onerror>` into the page would run
 * there. Each field below gets all three payloads (and a bare `&`); the page
 * must carry no raw `<script` / `<img` and must carry `&amp;`. Replacing the
 * template's or the engine's esc() with the identity turns these red.
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const render = require('../../bot/shared/templates/transcript-quiz-teacher.template');
const { renderFigureSvg } = require('../../bot/shared/services/quiz/transcript-quiz-figure');

const BAD = 'Salt & water </text><script>alert(1)</script> "><img src=x onerror=alert(1)>';
const BAD_UR = `نمک & پانی </text><script>alert(1)</script> "><img src=x onerror=alert(1)>`;

const NO_RAW = /<script|<img(?![^>]*class="(hero-mark|mark-img)")/;

function sheet(language, bad) {
  return render({
    topic: bad, teacherName: bad, date: bad, lessonSummary: bad,
    digest: {
      subject: 'science', checks_summary: bad,
      slos: [{ id: 'S1', statement_en: bad, statement_ur: bad, statement: bad, taught_level: 'understand' }],
    },
    questions: [{
      external_id: 'tq:quiz-1:S1:1', slo_id: 'S1',
      question_text: bad, option_a: bad, option_b: `${bad} two`, option_c: `${bad} three`,
      correct_option: 'A', explanation: bad,
    }],
    language, contentLanguage: language,
  });
}

// One field at a time, so losing the escape on any single field goes red.
const FIELDS = ['topic', 'teacherName', 'date', 'lessonSummary', 'checks_summary', 'slo', 'question_text', 'option'];
function oneField(language, field, bad) {
  const ok = 'plain text';
  const pick = (f) => (f === field ? bad : ok);
  return render({
    topic: pick('topic'), teacherName: pick('teacherName'), date: pick('date'), lessonSummary: pick('lessonSummary'),
    digest: {
      subject: 'science', checks_summary: pick('checks_summary'),
      slos: [{ id: 'S1', statement_en: pick('slo'), statement_ur: pick('slo'), statement: pick('slo'), taught_level: 'understand' }],
    },
    questions: [{
      external_id: 'tq:quiz-1:S1:1', slo_id: 'S1', question_text: pick('question_text'),
      option_a: pick('option'), option_b: 'second', option_c: 'third', correct_option: 'A',
    }],
    language, contentLanguage: language,
  });
}

describe.each([['en', BAD], ['ur', BAD_UR]])('the %s teacher sheet', (language, bad) => {
  test.each(FIELDS)('the %s field is escaped', (field) => {
    const html = oneField(language, field, bad);
    expect(html).not.toMatch(NO_RAW);
    expect(html).toMatch(/&lt;(<span[^>]*>)?script/);
    expect(html).toContain('&amp;');
  });

  test('carries no raw <script or <img from any field', () => {
    const html = sheet(language, bad);
    expect(html).not.toMatch(NO_RAW);
    expect(html).not.toContain('</text><script>');
  });

  test('escapes & and the angle brackets', () => {
    const html = sheet(language, bad);
    expect(html).toContain('&amp;');
    expect(html).toMatch(/&lt;(<span[^>]*>)?script/);
    expect(html).toMatch(/&lt;(<span[^>]*>)?img/);
  });

  test('a figure carrying the payload in its labels stays inert inside the sheet', () => {
    // Short labels, one payload each, so the figure lays out (a long label is
    // refused as unreadable before it is drawn).
    const w = language === 'ur' ? 'نمک' : 'Salt';
    const svg = renderFigureSvg({
      type: 'flow', direction: 'tb',
      steps: [
        { title: `${w} & x`, lines: ['</text><script>'] },
        { title: `${w} "><img src=x>`, lines: [`${w}`] },
        { title: `${w}`, lines: ['<script>alert</script>'] },
      ],
    }, language);
    expect(svg).toMatch(/^<svg/);
    expect(svg).not.toMatch(/<script|<img/);
    expect(svg).toContain('&amp;');
    const html = render({
      topic: 'Mixtures', teacherName: 'Teacher Example', digest: { slos: [] },
      questions: [{ question_text: 'Which?', option_a: 'a', option_b: 'b', correct_option: 'A', figureSvg: svg }],
      language, contentLanguage: language,
    });
    expect(html).not.toMatch(NO_RAW);
  });
});
