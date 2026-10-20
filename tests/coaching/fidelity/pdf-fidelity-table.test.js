'use strict';
/**
 * The coaching PDF (the report the default frameworks deliver) draws the measured fidelity block: the band, "N of M
 * planned moves delivered", the status line, and — new — the per-move table (planned move · what the recording shows
 * at [MM:SS] · verdict). The deployment fork computed that table and never drew it; it is the most useful thing in the
 * block. PDFKit is not installed for the root suite, so a recording fake document stands in for it; the drawing code
 * itself runs.
 */
jest.mock('pdfkit', () => function FakePDF() {}, { virtual: true });
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const PDFReportService = require('../../../bot/shared/services/pdf-report.service');
const { buildFidelityReportSection } = require('../../../bot/shared/services/coaching/fidelity/fidelity-report');

function fakeDoc() {
  const texts = [];
  let pages = 1;
  const doc = {
    y: 0,
    texts,
    get pages() { return pages; },
    fontSize() { return doc; }, fillColor() { return doc; }, font() { return doc; }, strokeColor() { return doc; },
    lineWidth() { return doc; }, moveTo() { return doc; }, lineTo() { return doc; }, stroke() { return doc; },
    roundedRect() { return doc; }, rect() { return doc; }, fill() { return doc; }, fillAndStroke() { return doc; },
    addPage() { pages += 1; return doc; },
    heightOfString(s, opts = {}) { const w = opts.width || 400; return Math.ceil((String(s).length * 4) / w + 1) * 10; },
    widthOfString(s) { return String(s).length * 4; },
    text(s, x, y, opts = {}) { texts.push(String(s)); doc.y = (y || doc.y) + doc.heightOfString(s, opts); return doc; },
  };
  return doc;
}

const mv = (id, phase, verdict, text, evidence) => ({ move_id: id, phase, text, verdict, counted: true, credit: verdict === 'executed' ? 1 : 0, evidence, evidence_translation: '' });

const LP = {
  status: 'ok', source: 'linked', fidelity_pct: 50, band: 'partial', narrative: 'The teacher modelled the method; no exit check.',
  not_assessed: [], strengths: [], moderators: { note: '' },
  moves: [
    mv('m1', 'explain', 'executed', 'Explain with paper fraction strips', '[00:50] Everyone take one paper strip'),
    mv('m2', 'exit', 'not_done', 'Collect a one-question exit ticket', ''),
  ],
};

describe('PDF · measured fidelity block', () => {
  test('draws the band, the count, the status line and one row per planned move with its moment', () => {
    const doc = fakeDoc();
    const end = PDFReportService._drawFidelitySection(doc, buildFidelityReportSection(LP), 100);
    const all = doc.texts.join('\n');
    expect(all).toContain('Did the lesson follow the plan?');
    expect(all).toContain('Partial');
    expect(all).toContain('1 of 2 planned moves delivered');
    expect(all).toContain('Explain with paper fraction strips');
    expect(all).toContain('[00:50] Everyone take one paper strip');
    expect(all).toContain('Collect a one-question exit ticket');
    expect(all).toContain('Not seen');
    expect(all).toContain('Done');
    expect(all).not.toMatch(/\*|📋/); // chat markup and emoji never reach the PDF font
    expect(all).toMatch(/AI grader/); // the honest caveat travels with the number
    expect(end).toBeGreaterThan(100);
  });

  test('a credited move with no quoted moment says so (never "no moment found" beside a "Done")', () => {
    const doc = fakeDoc();
    const lp = { ...LP, moves: [{ ...LP.moves[0], evidence: '', unquoted: true }] };
    PDFReportService._drawFidelitySection(doc, buildFidelityReportSection(lp), 100);
    const all = doc.texts.join('\n');
    expect(all).toContain('Credited, but no moment was quoted');
    expect(all).not.toContain('No moment found in the recording');
  });

  test('a long plan paginates instead of running off the page', () => {
    const many = { ...LP, moves: Array.from({ length: 30 }, (_, i) => mv(`m${i + 1}`, 'guided', 'executed', `Planned move number ${i + 1} with a reasonably long description of the step`, `[${String(i).padStart(2, '0')}:10] the teacher says the step out loud to the class`)) };
    const doc = fakeDoc();
    PDFReportService._drawFidelitySection(doc, buildFidelityReportSection(many), 400);
    expect(doc.pages).toBeGreaterThan(1);
    expect(doc.texts.filter((t) => t === 'Planned move').length).toBe(doc.pages); // header repeated on each page
  });

  test('not assessed: the reason, no score and no table — never 0%', () => {
    const doc = fakeDoc();
    PDFReportService._drawFidelitySection(doc, buildFidelityReportSection({ status: 'ok', fidelity_pct: null, unusable_guard: 'no_timestamps', recording_unusable: true, moves: [] }), 100);
    const all = doc.texts.join('\n');
    expect(all).toContain('Did the lesson follow the plan?');
    expect(all).toMatch(/speech timings/);
    expect(all).not.toContain('Planned move');
    expect(all).not.toMatch(/\b0\/100\b|0%/);
  });

  test('the legacy estimate (feature off) still draws through the old layout', () => {
    const doc = fakeDoc();
    PDFReportService._drawFidelitySection(doc, { score: 85, maxScore: 100, note: 'n', commentary: 'Followed the plan.', evidence: [], strengths: [], gaps: [] }, 100);
    const all = doc.texts.join('\n');
    expect(all).toContain('Fidelity to Lesson Plan');
    expect(all).toContain('85/100');
  });
});
