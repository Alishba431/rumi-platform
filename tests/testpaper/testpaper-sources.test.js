/**
 * testpaper-sources — what a paper can be built from, as text.
 *
 * Three sources a fresh clone actually has (no government catalogue):
 *   1. the teacher's own lesson plans (their saved content, or the text of
 *      their PDF);
 *   2. textbooks loaded into textbooks / textbook_toc / textbook_pages (e.g.
 *      by the curriculum corpus importer);
 *   3. a chapter the teacher uploads (PDF, Word, plain text) or pastes.
 *
 * The database is an in-memory query builder; the PDF/Word parsers and the
 * HTTP fetch are mocked at their package boundary.
 */

const { createFakeDb } = require('./helpers/fake-db');

const TEACHER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const LONG = 'Plants make their own food in their leaves using sunlight, water and air. '.repeat(6);

let Sources;
let db;
let mockAxiosGet;
let mockPdfParse;
let mockMammoth;

function seed() {
  return {
    lesson_plans: [
      { id: 'lp-1', user_id: TEACHER, topic: 'How plants make food', grade: '4', subject: 'Science', content: { text: LONG }, pdf_url: null, created_at: '2026-09-20T10:00:00Z' },
      { id: 'lp-2', user_id: TEACHER, topic: 'Parts of a flower', grade: null, subject: null, content: null, pdf_url: 'https://files.example.org/lp-2.pdf', created_at: '2026-09-21T10:00:00Z' },
      { id: 'lp-3', user_id: TEACHER, topic: 'Fractions', grade: null, subject: null, content: null, pdf_url: null, created_at: '2026-09-22T10:00:00Z' },
      { id: 'lp-x', user_id: OTHER, topic: 'Not yours', content: { text: LONG }, created_at: '2026-09-23T10:00:00Z' },
    ],
    textbooks: [
      { id: 'tb-1', grade: 2, subject: 'math', curriculum: 'corpus', total_pages: 30 },
      { id: 'tb-2', grade: 5, subject: 'Science', curriculum: 'other', total_pages: 10 },
    ],
    textbook_toc: [
      { id: 't1', textbook_id: 'tb-1', chapter_number: 1, chapter_title: 'Numbers up to 999', page_start: 1, page_end: 2 },
      { id: 't2', textbook_id: 'tb-1', chapter_number: 2, chapter_title: 'Addition', page_start: 3, page_end: 3 },
      { id: 't3', textbook_id: 'tb-2', chapter_number: 1, chapter_title: 'Living things', page_start: 1, page_end: 1 },
    ],
    textbook_pages: [
      { id: 'p1', textbook_id: 'tb-1', textbook_page_number: 1, page_content: 'A 3-digit number has hundreds, tens and ones.' },
      { id: 'p2', textbook_id: 'tb-1', textbook_page_number: 2, page_content: 'We compare numbers with <, > and =.' },
      { id: 'p3', textbook_id: 'tb-1', textbook_page_number: 3, page_content: 'Adding two 3-digit numbers, carrying tens.' },
      { id: 'p9', textbook_id: 'tb-2', textbook_page_number: 1, page_content: 'Living things grow and breathe.' },
    ],
  };
}

beforeEach(() => {
  jest.resetModules();
  delete process.env.TESTPAPER_CURRICULUM;
  db = createFakeDb(seed());
  jest.doMock('../../bot/shared/config/supabase', () => db);
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  mockAxiosGet = jest.fn();
  jest.doMock('axios', () => ({ get: mockAxiosGet }));
  mockPdfParse = jest.fn();
  jest.doMock('pdf-parse', () => mockPdfParse, { virtual: true });
  mockMammoth = { extractRawText: jest.fn() };
  jest.doMock('mammoth', () => mockMammoth, { virtual: true });
  Sources = require('../../bot/shared/services/testpaper/testpaper-sources.service');
});

afterAll(() => { delete process.env.TESTPAPER_CURRICULUM; });

describe('listSources', () => {
  it('lists the teacher\'s own lesson plans, newest first, and every loaded textbook', async () => {
    const s = await Sources.listSources(TEACHER);
    expect(s.lessonPlans.map((l) => l.id)).toEqual(['lp-3', 'lp-2', 'lp-1']);
    expect(s.textbooks.map((t) => t.id).sort()).toEqual(['tb-1', 'tb-2']);
    expect(s.textbooks.find((t) => t.id === 'tb-1')).toMatchObject({ grade: 2, subject: 'math', chapterCount: 2 });
  });

  it('never lists another teacher\'s lesson plans', async () => {
    const s = await Sources.listSources(TEACHER);
    expect(s.lessonPlans.map((l) => l.id)).not.toContain('lp-x');
  });

  it('TESTPAPER_CURRICULUM limits the textbooks to that curriculum', async () => {
    process.env.TESTPAPER_CURRICULUM = 'corpus';
    const s = await Sources.listSources(TEACHER);
    expect(s.textbooks.map((t) => t.id)).toEqual(['tb-1']);
  });

  it('filters by a subject the teacher named', async () => {
    const s = await Sources.listSources(TEACHER, { subject: 'science' });
    expect(s.textbooks.map((t) => t.id)).toEqual(['tb-2']);
    // A lesson plan matches on its subject or, when it has none, on its topic.
    expect(s.lessonPlans.map((l) => l.id)).toEqual(['lp-1']);
    expect(Sources.isEmpty(await Sources.listSources(TEACHER, { subject: 'history' }))).toBe(true);
  });

  it('a teacher with nothing gets an empty listing, not an error', async () => {
    db = createFakeDb({});
    jest.resetModules();
    jest.doMock('../../bot/shared/config/supabase', () => db);
    jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
    Sources = require('../../bot/shared/services/testpaper/testpaper-sources.service');
    const s = await Sources.listSources(TEACHER);
    expect(Sources.isEmpty(s)).toBe(true);
  });
});

describe('listChapters / loadTextbookContent', () => {
  it('lists a book\'s chapters in order', async () => {
    expect((await Sources.listChapters('tb-1')).map((c) => [c.number, c.title]))
      .toEqual([[1, 'Numbers up to 999'], [2, 'Addition']]);
  });

  it('assembles one chapter as page-marked text', async () => {
    const c = await Sources.loadTextbookContent('tb-1', [1]);
    expect(c.text).toBe('=== Page 1 ===\nA 3-digit number has hundreds, tens and ones.\n\n=== Page 2 ===\nWe compare numbers with <, > and =.');
    expect(c).toMatchObject({ subject: 'math', grade: 2, chapterTitle: 'Numbers up to 999', pageReference: '1-2' });
    expect(c.label).toBe('Math · Chapter 1: Numbers up to 999');
  });

  it('assembles a whole unit (several chapters) in chapter order', async () => {
    const c = await Sources.loadTextbookContent('tb-1', [2, 1]);
    expect(c.text.indexOf('=== Page 1 ===')).toBeLessThan(c.text.indexOf('=== Page 3 ==='));
    expect(c.chapterTitle).toMatch(/Chapters 1–2|Chapters 1, 2/);
  });

  it('a chapter with no text is INSUFFICIENT_SOURCE, never an empty paper', async () => {
    db.tables.textbook_pages = db.tables.textbook_pages.filter((p) => p.textbook_page_number !== 3);
    await expect(Sources.loadTextbookContent('tb-1', [2])).rejects.toMatchObject({ code: 'INSUFFICIENT_SOURCE' });
  });
});

describe('loadLessonPlanContent', () => {
  it('uses the saved content of the teacher\'s own plan', async () => {
    const c = await Sources.loadLessonPlanContent(['lp-1'], TEACHER);
    expect(c.text).toContain('Plants make their own food');
    expect(c).toMatchObject({ subject: 'Science', grade: '4', chapterTitle: 'How plants make food' });
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('reads a Rumi-made plan\'s stored text (content.plan_text) through the shared lesson-plan reader', async () => {
    db.tables.lesson_plans.push({ id: 'lp-4', user_id: TEACHER, topic: 'The water cycle', grade: '5', subject: 'Science', content: { plan_text: LONG, export_meta: 'gamma-export-v2' }, pdf_url: null, created_at: '2026-09-24T10:00:00Z' });
    const c = await Sources.loadLessonPlanContent(['lp-4'], TEACHER);
    expect(c.text).toContain('Plants make their own food');
    // The stored PDF text is the plan itself, not a field to be headed like a sectioned plan.
    expect(c.text).not.toMatch(/Plan text:/);
    expect(c.text).not.toContain('gamma-export-v2');
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('falls back to the text of the plan\'s PDF', async () => {
    mockAxiosGet.mockResolvedValue({ data: Buffer.from('%PDF-1.4') });
    mockPdfParse.mockResolvedValue({ text: `Parts of a flower. ${LONG}` });
    const c = await Sources.loadLessonPlanContent(['lp-2'], TEACHER);
    expect(mockAxiosGet).toHaveBeenCalledWith('https://files.example.org/lp-2.pdf', expect.objectContaining({ responseType: 'arraybuffer' }));
    expect(c.text).toContain('Parts of a flower.');
  });

  it('a plan saved with only its topic is INSUFFICIENT_SOURCE', async () => {
    await expect(Sources.loadLessonPlanContent(['lp-3'], TEACHER)).rejects.toMatchObject({ code: 'INSUFFICIENT_SOURCE' });
  });

  it('several plans make one source, each under its own heading', async () => {
    mockAxiosGet.mockResolvedValue({ data: Buffer.from('%PDF-1.4') });
    mockPdfParse.mockResolvedValue({ text: `Parts of a flower. ${LONG}` });
    const c = await Sources.loadLessonPlanContent(['lp-1', 'lp-2'], TEACHER);
    expect(c.text).toMatch(/=== Lesson: How plants make food ===[\s\S]*=== Lesson: Parts of a flower ===/);
  });

  it('a plan whose PDF cannot be fetched is skipped, the rest still used', async () => {
    mockAxiosGet.mockRejectedValue(new Error('403 expired link'));
    const c = await Sources.loadLessonPlanContent(['lp-1', 'lp-2'], TEACHER);
    expect(c.text).toContain('How plants make food');
    expect(c.skipped).toEqual(['Parts of a flower']);
  });

  it('another teacher\'s plan is never read', async () => {
    await expect(Sources.loadLessonPlanContent(['lp-x'], TEACHER)).rejects.toMatchObject({ code: 'INSUFFICIENT_SOURCE' });
  });
});

describe('extractUploadText', () => {
  it('reads a PDF', async () => {
    mockPdfParse.mockResolvedValue({ text: '  Chapter 4: The water cycle  ' });
    expect(await Sources.extractUploadText(Buffer.from('x'), 'application/pdf', 'ch4.pdf')).toBe('Chapter 4: The water cycle');
  });
  it('reads a Word document', async () => {
    mockMammoth.extractRawText.mockResolvedValue({ value: 'The water cycle' });
    expect(await Sources.extractUploadText(Buffer.from('x'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'ch4.docx')).toBe('The water cycle');
  });
  it('reads plain text', async () => {
    expect(await Sources.extractUploadText(Buffer.from('Evaporation and rain'), 'text/plain', 'notes.txt')).toBe('Evaporation and rain');
  });
  it('isChapterFile: PDF, Word and text by type or name; nothing else', () => {
    expect(Sources.isChapterFile('application/pdf', '')).toBe(true);
    expect(Sources.isChapterFile('', 'Chapter 3.DOCX')).toBe(true);
    expect(Sources.isChapterFile('text/plain', null)).toBe(true);
    expect(Sources.isChapterFile('audio/mpeg', 'class.mp3')).toBe(false);
    expect(Sources.isChapterFile('image/jpeg', 'page.jpg')).toBe(false);
    expect(Sources.isChapterFile('application/octet-stream', 'recording.m4a')).toBe(false);
  });

  it('an unsupported file type is UNSUPPORTED_FILE', async () => {
    await expect(Sources.extractUploadText(Buffer.from('x'), 'image/png', 'page.png')).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });
});

describe('flattenContent', () => {
  it('turns a structured lesson plan into readable text, headings included', () => {
    const text = Sources.flattenContent({ objectives: ['Name plant parts'], activities: [{ title: 'Leaf walk', steps: 'Collect leaves.' }] });
    expect(text).toMatch(/objectives/i);
    expect(text).toContain('Name plant parts');
    expect(text).toContain('Leaf walk');
    expect(text).toContain('Collect leaves.');
  });

  it('leaves out the fidelity feature\'s cached move list, which is derived from the plan, not plan text', async () => {
    const cache = {
      plan_hash: 'a3f1c9e0b2d4a3f1c9e0b2d4a3f1c9e0b2d4a3f1c9e0b2d4a3f1c9e0b2d4abcd',
      goal: 'Learners can add fractions with like denominators',
      model: 'example/model', extracted_at: '2026-10-02T10:00:00.000Z',
      moves: [{ id: 'm1', move: 'Teacher reviews halves with a paper strip' }, { id: 'm2', move: 'Pairs fold strips into quarters and compare' }],
    };
    expect(Sources.flattenContent({ fidelity_moves: cache })).toBe('');
    expect(Sources.flattenContent({ objectives: 'Add fractions', fidelity_moves: cache })).not.toMatch(/plan.hash|extracted.at|paper strip/i);
    // A plan row whose content is only that cache has no text to build a paper from.
    db.tables.lesson_plans.push({ id: 'lp-5', user_id: TEACHER, topic: 'Adding fractions', content: { fidelity_moves: cache }, pdf_url: null, created_at: '2026-09-25T10:00:00Z' });
    await expect(Sources.loadLessonPlanContent(['lp-5'], TEACHER)).rejects.toMatchObject({ code: 'INSUFFICIENT_SOURCE' });
  });
});
