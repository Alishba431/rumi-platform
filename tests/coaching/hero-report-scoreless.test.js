/**
 * The hero report, scoreless — the version a TEACHER receives from an
 * observation. The teacher must never see a score, so `scoreless: true`
 * renders the report without the headline percentage, the marks line, the
 * per-domain scorecard or the trend sparkline, and skips the trend lookup.
 * `beforeRender(vm)` lets the caller check (or scrub) every string before a
 * pixel is drawn. Without the option the report is exactly as before.
 */

const mockHtml = [];
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({
  htmlToImage: jest.fn(async (html) => { mockHtml.push(html); return Buffer.from('PNG'); }),
}));
jest.mock('../../bot/shared/services/coaching/report-v2/narrative.service', () => ({
  generateReportNarrative: jest.fn(async () => ({
    topic: 'Counting to twenty',
    affirmation: 'You made every child feel heard.',
    score_framing: 'Your 62% is a stage.',
    journey_note: 'You peaked at 70%.',
    moments: [{ title: 'Sticks', quote: 'Show me', why: 'Every hand busy.' }],
  })),
}));
const mockTrend = jest.fn(async () => [
  { date: '2026-09-01', pct: 55 }, { date: '2026-09-20', pct: 70 },
]);
jest.mock('../../bot/shared/services/coaching/coaching-trend.service', () => ({ loadTrendData: (...a) => mockTrend(...a) }));
jest.mock('../../bot/shared/services/coaching/report-v2/score-adapter.service', () => ({
  buildScoreViewModel: () => ({ overall: 62, marks: 31, max: 50, groups: [{ name: 'Questioning', score: 6, max: 10, pct: 60 }] }),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const { generateHeroReport } = require('../../bot/shared/services/coaching/report-v2/hero-report.service');

const SESSION = { id: 's1', user_id: 't1', created_at: '2026-10-02T09:00:00Z', transcript_text: 'lesson' };

describe('generateHeroReport({ scoreless })', () => {
  beforeEach(() => { mockHtml.length = 0; mockTrend.mockClear(); });

  test('default render still carries the score (unchanged behaviour)', async () => {
    await generateHeroReport(SESSION, { framework: 'teach' }, { teacherName: 'Sam Taylor' });
    expect(mockHtml[0]).toContain('62%');
    expect(mockHtml[0]).toContain('31/50');
    expect(mockTrend).toHaveBeenCalled();
  });

  test('scoreless render has no percentage, no ratio, no scorecard, no trend', async () => {
    await generateHeroReport(SESSION, { framework: 'teach' }, { teacherName: 'Sam Taylor', scoreless: true });
    const html = mockHtml[0].replace(/<style>[\s\S]*?<\/style>/g, '');
    const text = html.replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/\d+\s*%/);
    expect(text).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(html).not.toContain('class="hscore"');
    expect(html).not.toContain('sc-row');
    expect(mockTrend).not.toHaveBeenCalled();
    expect(text).toContain('You made every child feel heard.');
  });

  test('beforeRender sees the view model and may scrub it; a throw stops the render', async () => {
    const seen = [];
    await generateHeroReport(SESSION, { framework: 'teach' }, {
      teacherName: 'Sam Taylor',
      scoreless: true,
      beforeRender: (vm) => { seen.push({ affirmation: vm.narrative.affirmation, score: vm.score }); vm.narrative = { ...vm.narrative, affirmation: 'Scrubbed.' }; },
    });
    expect(seen[0].affirmation).toBe('You made every child feel heard.');
    expect(seen[0].score).toBeNull();
    expect(mockHtml[0]).toContain('Scrubbed.');

    mockHtml.length = 0;
    await expect(generateHeroReport(SESSION, { framework: 'teach' }, {
      scoreless: true, beforeRender: () => { throw new Error('blocked'); },
    })).rejects.toThrow('blocked');
    expect(mockHtml).toHaveLength(0);
  });
});
