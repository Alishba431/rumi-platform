'use strict';
/**
 * The class in the class report is what the CHILDREN typed at the join's
 * class step, so it is untrusted text. It used to reach the report HTML through
 * the trusted-chrome path (classesLine returned it as is), and the page is
 * rendered by the server's headless browser: a class typed as
 * `<img src=x onerror=…>` became live markup. It is escaped now, in both
 * report languages, like every other field on the page.
 */

const renderReport = require('../../bot/shared/templates/video-quiz-report.template');

const PAYLOAD = "<img src=x onerror=fetch('//example.invalid')>";

const base = (language, classes) => ({
  topic: 'Plant life cycle', teacherName: 'Teacher Example', classes,
  started: 2, finished: 2, average: 75,
  students: [{ name: 'Child One', correct: 3, total: 4, pct: 75 }],
  hardest: [], unfinished: [], generatedAt: '2 Oct 2026', language,
});

describe('class report: the class a child typed is escaped', () => {
  test.each(['en', 'ur'])('a single class in %s', (language) => {
    const html = renderReport(base(language, [PAYLOAD]));
    expect(html).not.toContain('<img src=x');
    expect(html).toMatch(/&lt;(<span[^>]*>)?img\b/);
  });

  test.each(['en', 'ur'])('several classes in %s', (language) => {
    // Digit-free on purpose: a class with a digit in it is read as that number.
    const html = renderReport(base(language, ['Blue', PAYLOAD, '<script>alert(document.domain)</script>']));
    expect(html).not.toMatch(/<img src=x|<script>alert/);
    expect(html).toMatch(/&lt;(<span[^>]*>)?script/);
    expect(html).toMatch(/&lt;(<span[^>]*>)?img\b/);
  });

  test('an ampersand in a class is escaped once', () => {
    const html = renderReport(base('en', ['Blue & Green']));
    expect(html).toContain('Blue &amp; Green');
    expect(html).not.toContain('&amp;amp;');
  });
});
