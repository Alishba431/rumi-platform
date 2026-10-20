'use strict';
/**
 * The teacher PDF of a quiz with no recording.
 *
 * The sheet opens on "What you taught" and closes on "Made from your lesson
 * recording". A plan quiz (lp_generated) was written from a lesson plan —
 * nobody heard the lesson — so both lines would state something untrue about
 * the document in the teacher's hand: its sheet says "What you planned" and
 * "Made from your lesson plan". A topic quiz has no plan either: "What this
 * quiz covers" and "Made from the topic you chose". The transcript sheet is
 * unchanged. Every footer ends on the deployment's name (config/branding).
 */
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({ htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')) }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));

const { htmlToPdf } = require('../../bot/shared/utils/html-to-pdf');
const render = require('../../bot/shared/templates/transcript-quiz-teacher.template');
const Gen = require('../../bot/shared/services/quiz/transcript-quiz-generate.service');

const DIGEST = { subject: 'maths', slos: [{ id: 'S1', statement_en: 'Add with carrying', statement_ur: 'جمع', taught_level: 'apply' }] };
const Q = [{
  slo_id: 'S1', level: 'apply', question: 'What is 146 + 27?', options: ['173', '163', '1613'], correct_index: 0, explanation: 'Ones first.',
}];
// An Urdu sheet sets every Latin run ("quiz", the bot's name) in its own LTR
// isolate; the words a teacher reads are the text with those spans unwrapped.
const unwrapLtr = (html) => html.replace(/<span class="ltr">([^<]*)<\/span>/g, '$1');
const base = {
  topic: 'Adding with carrying', teacherName: 'Sam Rivera', grade: '2', date: '22 Sep 2026', link: 'https://wa.me/1?text=QUIZ-X',
  digest: DIGEST, questions: Q, lessonSummary: 'You planned column addition with 146 + 27.',
};

describe.each(['en', 'ur'])('the %s sheet', (lang) => {
  test('a plan sheet names the lesson PLAN — never "taught" as a heading, never the recording', () => {
    const html = render({ ...base, language: lang, contentLanguage: lang, quizSource: 'lp_generated' });
    if (lang === 'en') {
      expect(html).toContain('What you planned');
      expect(html).toContain('Made from your lesson plan');
      expect(html).not.toContain('What you taught');
    } else {
      expect(html).toContain('آپ کے سبق کا منصوبہ');
      expect(html).toContain('lesson plan');
      expect(html).not.toContain('آپ نے کیا پڑھایا');
    }
    expect(html).not.toMatch(/recording|ریکارڈنگ/i);
  });

  test('a topic sheet says what the quiz covers — never taught, never planned, never the recording', () => {
    const html = unwrapLtr(render({ ...base, language: lang, contentLanguage: lang, quizSource: 'topic' }));
    if (lang === 'en') {
      expect(html).toContain('What this quiz covers');
      expect(html).toContain('Made from the topic you chose');
      expect(html).not.toMatch(/What you (taught|planned)/);
    } else {
      expect(html).toContain('یہ quiz کس بارے میں ہے');
      expect(html).not.toContain('آپ نے کیا پڑھایا');
      expect(html).not.toContain('آپ کے سبق کا منصوبہ');
    }
    expect(html).not.toMatch(/recording|ریکارڈنگ/i);
  });

  test('the footer carries the deployment\'s name, and the marks are the deployment\'s own files', () => {
    const { botName } = require('../../bot/shared/config/branding');
    const { brandMark } = require('../../bot/shared/templates/quiz-brand');
    const html = unwrapLtr(render({ ...base, language: lang, contentLanguage: lang }));
    expect(html).toContain(`· ${botName}`);
    expect(html).toContain(`<img class="hero-mark" src="data:image/png;base64,${brandMark('onDark')}" alt="${botName}">`);
    expect(html).toContain(`<img class="mark-img" src="data:image/png;base64,${brandMark('onLight')}" alt="${botName}">`);
  });

  test('a transcript sheet is what it always was', () => {
    const html = render({ ...base, language: lang, contentLanguage: lang });
    expect(html).toMatch(lang === 'en' ? /Made from your lesson recording/ : /ریکارڈنگ سے تیار/);
  });
});

test('renderPdf hands the row’s quiz_source to the template', async () => {
  await Gen.renderPdf({
    quiz: { topic: 'Adding with carrying', language: 'en', quiz_source: 'lp_generated' },
    questions: Q, digest: DIGEST, teacherName: 'Sam Rivera', grade: '2', lessonSummary: '', language: 'en', date: '22 Sep', link: 'x',
  });
  expect(htmlToPdf.mock.calls[0][0]).toContain('Made from your lesson plan');
});
