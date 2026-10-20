/**
 * testpaper-orchestrator — the /testpaper conversation, on any channel.
 *
 * Every pick is an interactive list or reply buttons through the messaging
 * facade: native on WhatsApp/Meta, a numbered menu on Baileys, Matrix, Slack
 * and Discord (whose numeric replies come back as the same list/button ids).
 * Multi-picks ("1,3", "1-4", "all") and typed mixes arrive as plain text.
 *
 * Real: the store, the sources, the session (memory fallback), question types,
 * the renderer and delivery. Mocked at the boundary: the database (in-memory
 * query builder), the channel facade, the queue, Redis, Chromium (the html-to-pdf
 * wrapper) and the PDF parser.
 */

const { createFakeDb } = require('./helpers/fake-db');

const TEACHER = { id: '00000000-0000-4000-8000-000000000001', preferred_language: 'en' };
const OTHER = '00000000-0000-4000-8000-000000000002';
const FROM = 'matrix:@teacher:example.org';
const TEXT = (s) => `${s} `.repeat(12);

let O;
let db;
let WA;
let queue;
let mockPdfParse;

function seed(extra = {}) {
  return {
    users: [{ id: TEACHER.id }, { id: OTHER }],
    lesson_plans: [
      { id: 'lp-1', user_id: TEACHER.id, topic: 'How plants make food', subject: 'Science', grade: '4', content: { text: TEXT('Plants make food in their leaves using sunlight, water and air.') }, created_at: '2026-09-20T10:00:00Z' },
      { id: 'lp-2', user_id: TEACHER.id, topic: 'Parts of a plant', subject: 'Science', grade: '4', content: { text: TEXT('Roots hold the plant and take in water; the stem carries it up.') }, created_at: '2026-09-21T10:00:00Z' },
      { id: 'lp-3', user_id: TEACHER.id, topic: 'Fractions', subject: 'Math', content: null, created_at: '2026-09-22T10:00:00Z' },
    ],
    textbooks: [{ id: 'tb-1', grade: 2, subject: 'math', curriculum: 'corpus' }],
    textbook_toc: [
      { id: 't1', textbook_id: 'tb-1', chapter_number: 1, chapter_title: 'Numbers up to 999', page_start: 1, page_end: 1 },
      { id: 't2', textbook_id: 'tb-1', chapter_number: 2, chapter_title: 'Adding', page_start: 2, page_end: 2 },
    ],
    textbook_pages: [
      { id: 'p1', textbook_id: 'tb-1', textbook_page_number: 1, page_content: TEXT('A 3-digit number has hundreds, tens and ones.') },
      { id: 'p2', textbook_id: 'tb-1', textbook_page_number: 2, page_content: TEXT('Add the ones first, then the tens, then the hundreds.') },
    ],
    ...extra,
  };
}

function load(seedData = seed(), env = {}) {
  jest.resetModules();
  process.env.OPENROUTER_API_KEY = 'test-key';
  delete process.env.RUMI_FEATURE_TEST_PAPER;
  Object.assign(process.env, env);
  db = createFakeDb(seedData);
  jest.doMock('../../bot/shared/config/supabase', () => db);
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => ({
    set: jest.fn().mockResolvedValue(false), get: jest.fn().mockResolvedValue(null), delete: jest.fn().mockResolvedValue(true),
  }));
  WA = {
    sendMessage: jest.fn().mockResolvedValue(true),
    sendInteractiveMessage: jest.fn().mockResolvedValue(true),
    sendInteractiveButtons: jest.fn().mockResolvedValue(true),
    sendDocument: jest.fn().mockResolvedValue(true),
    downloadMedia: jest.fn(),
  };
  jest.doMock('../../bot/shared/services/whatsapp.service', () => WA);
  queue = { queueJob: jest.fn().mockResolvedValue('job-1') };
  jest.doMock('../../bot/shared/services/queue', () => queue);
  mockPdfParse = jest.fn();
  jest.doMock('pdf-parse', () => mockPdfParse, { virtual: true });
  jest.doMock('../../bot/shared/utils/html-to-pdf', () => ({ htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')) }));
  // As whatsapp-bot.js does at startup: the operator's RUMI_FEATURE_* switches.
  require('../../bot/shared/config/feature-availability').overrides.load(process.env);
  O = require('../../bot/shared/services/testpaper/testpaper-orchestrator.service');
}

afterEach(() => {
  delete process.env.RUMI_FEATURE_TEST_PAPER;
  jest.resetModules();
});

const lastList = () => WA.sendInteractiveMessage.mock.calls[WA.sendInteractiveMessage.mock.calls.length - 1][1];
const rowsOf = (list) => list.action.sections.flatMap((s) => s.rows);
const lastText = () => WA.sendMessage.mock.calls[WA.sendMessage.mock.calls.length - 1][1];
const pick = (id) => O.handleSelection({ user: TEACHER, from: FROM, id, language: 'en' });
const say = (text) => O.handleText({ user: TEACHER, from: FROM, text, language: 'en' });
const start = (args = '') => O.start({ user: TEACHER, from: FROM, args, language: 'en' });

describe('start', () => {
  it('offers every source the teacher has, an upload, and my papers', async () => {
    load();
    await start();
    const rows = rowsOf(lastList());
    expect(rows.map((r) => r.id)).toEqual(['tp_src_tb_0', 'tp_src_lp', 'tp_src_up', 'tp_mine']);
    expect(rows[0].title).toBe('Grade 2 · Math');
    // The count and the edition sit in the description, which a long subject cannot push out.
    expect(rows[0].description).toBe('2 chapters · corpus');
    expect(rows[1].title).toBe('My lesson plans (3)');
    // Meta's list limits: titles ≤ 24 characters, ≤ 10 rows.
    for (const r of rows) expect(r.title.length).toBeLessThanOrEqual(24);
  });

  it('with no material at all: an honest message, and an upload is welcome', async () => {
    load({ users: [{ id: TEACHER.id }] });
    await start();
    expect(WA.sendInteractiveMessage).not.toHaveBeenCalled();
    expect(lastText()).toMatch(/I don't have any material to build a test paper from yet/);
    expect(lastText()).toMatch(/won't make one up/);
    expect(queue.queueJob).not.toHaveBeenCalled();
  });

  it('a named subject with no material gets an honest message naming it', async () => {
    load();
    await start('history');
    expect(lastText()).toMatch(/for \*history\*/);
    expect(queue.queueJob).not.toHaveBeenCalled();
  });

  it('a named subject narrows the menu to its material', async () => {
    load();
    await start('science');
    expect(rowsOf(lastList()).map((r) => r.id)).toEqual(['tp_src_lp', 'tp_src_up', 'tp_mine']);
  });

  it('two editions of the same grade and subject are told apart', async () => {
    load(seed({
      textbooks: [{ id: 'tb-1', grade: 2, subject: 'math', curriculum: 'corpus' }, { id: 'tb-9', grade: 2, subject: 'math', curriculum: 'national-2024' }],
      textbook_toc: [...seed().textbook_toc, { id: 't9', textbook_id: 'tb-9', chapter_number: 1, chapter_title: 'Counting', page_start: 1, page_end: 1 }],
    }));
    await start('math');
    const books = rowsOf(lastList()).filter((r) => r.id.startsWith('tp_src_tb_'));
    expect(books.map((r) => r.description)).toEqual(['2 chapters · corpus', '1 chapter · national-2024']);
  });

  it('"my papers" as the argument goes straight to the list', async () => {
    load();
    await start('my papers');
    expect(lastText()).toMatch(/no test papers yet/);
  });

  it('switched off by the operator: says so, does nothing else', async () => {
    load(seed(), { RUMI_FEATURE_TEST_PAPER: 'off' });
    await start();
    expect(lastText()).toMatch(/not switched on/);
    expect(WA.sendInteractiveMessage).not.toHaveBeenCalled();
  });
});

describe('many loaded books', () => {
  // A K-8 set: one science book per grade, more than one list can show.
  function k8() {
    const textbooks = [];
    const toc = [];
    const pages = [];
    for (let g = 1; g <= 8; g += 1) {
      textbooks.push({ id: `sci-${g}`, grade: g, subject: 'science', curriculum: 'corpus' });
      toc.push({ id: `sci-t-${g}`, textbook_id: `sci-${g}`, chapter_number: 1, chapter_title: `Science ${g} chapter one`, page_start: 1, page_end: 1 });
      pages.push({ id: `sci-p-${g}`, textbook_id: `sci-${g}`, textbook_page_number: 1, page_content: TEXT(`Grade ${g} science text.`) });
    }
    return seed({ lesson_plans: [], textbooks, textbook_toc: toc, textbook_pages: pages });
  }

  it('every book stays reachable: a "Textbooks" row opens a numbered list of all of them', async () => {
    load(k8());
    await start('science');
    const rows = rowsOf(lastList());
    expect(rows.length).toBeLessThanOrEqual(10);
    const all = rows.find((r) => r.id === 'tp_src_books');
    expect(all).toMatchObject({ title: 'Textbooks (8)' });
    await pick('tp_src_books');
    expect(lastText()).toMatch(/8\. Grade 8 · Science/);
    expect(lastText()).toMatch(/\/testpaper science 8/);
    await say('8');
    expect(lastList().header).toMatch(/Grade 8 · Science/);
    expect(rowsOf(lastList())[0].id).toBe('tp_ch_1');
  });

  it('a number outside the book list asks again', async () => {
    load(k8());
    await start('science');
    await pick('tp_src_books');
    await say('12');
    expect(lastText()).toMatch(/Reply with the numbers from the list/);
  });

  it('a grade in the command narrows to that grade\'s books', async () => {
    load(k8());
    for (const args of ['science 8', 'science grade 8', 'grade 8 science', 'Science class 8']) {
      WA.sendInteractiveMessage.mockClear();
      await start(args);
      const books = rowsOf(lastList()).filter((r) => r.id.startsWith('tp_src_tb_'));
      expect(books.map((r) => r.title)).toEqual(['Grade 8 · Science']);
    }
  });

  // A K-12 set: 12 grades × 8 subjects, too many for one numbered message (Meta's text limit is 4096 characters).
  function k12() {
    const subjects = ['science', 'mathematics', 'english', 'social_studies', 'computer_science', 'general_knowledge', 'art', 'urdu'];
    const textbooks = [];
    const toc = [];
    for (let g = 1; g <= 12; g += 1) {
      for (const sub of subjects) {
        const id = `tb-${g}-${sub}`;
        textbooks.push({ id, grade: g, subject: sub, curriculum: 'national_2026_edition' });
        toc.push({ id: `t-${id}`, textbook_id: id, chapter_number: 1, chapter_title: `${sub} ${g} chapter one`, page_start: 1, page_end: 1 });
      }
    }
    return seed({ lesson_plans: [], textbooks, textbook_toc: toc, textbook_pages: [] });
  }

  it('a K-12 set too long for one message asks the subject first, then lists that subject\'s books', async () => {
    load(k12());
    await start();
    expect(rowsOf(lastList()).find((r) => r.id === 'tp_src_books')).toMatchObject({ title: 'Textbooks (96)' });
    await pick('tp_src_books');
    const subjects = lastText();
    expect(subjects.length).toBeLessThanOrEqual(4096);
    expect(subjects).toMatch(/which subject/i);
    const m = subjects.match(/(\d+)\. Mathematics \(12 books\)/);
    expect(m).not.toBeNull();
    await say(m[1]);
    const books = lastText();
    expect(books.length).toBeLessThanOrEqual(4096);
    expect(books).toMatch(/12\. Grade 12 · Mathematics/);
    expect(books).not.toMatch(/Science/);
    await say('12');
    expect(lastList().header).toMatch(/Grade 12 · Mathematics/);
  });

  it('many editions of one subject are narrowed by grade instead', async () => {
    const textbooks = [];
    const toc = [];
    for (let g = 1; g <= 12; g += 1) {
      for (let e = 1; e <= 8; e += 1) {
        const id = `sci-${g}-${e}`;
        textbooks.push({ id, grade: g, subject: 'science', curriculum: `edition-${e}-of-the-national-science-series` });
        toc.push({ id: `t-${id}`, textbook_id: id, chapter_number: 1, chapter_title: 'One', page_start: 1, page_end: 1 });
      }
    }
    load(seed({ lesson_plans: [], textbooks, textbook_toc: toc, textbook_pages: [] }));
    await start('science');
    await pick('tp_src_books');
    expect(lastText()).toMatch(/which grade/i);
    expect(lastText()).toMatch(/12\. Grade 12 \(8 books\)/);
    await say('12');
    expect(lastText().length).toBeLessThanOrEqual(4096);
    expect(lastText()).toMatch(/8\. Grade 12 · Science — 1 chapter · edition-8/);
  });

  it('a grade alone narrows every subject to that grade', async () => {
    load(k8());
    await start('7');
    expect(rowsOf(lastList()).filter((r) => r.id.startsWith('tp_src_tb_')).map((r) => r.title)).toEqual(['Grade 7 · Science']);
  });
});

describe('a one-chapter paper from a textbook', () => {
  it('book → chapter → size → language → queued, with the chapter\'s text stored', async () => {
    load();
    await start();
    expect(await pick('tp_src_tb_0')).toBe(true);
    expect(rowsOf(lastList()).map((r) => r.id)).toEqual(['tp_ch_1', 'tp_ch_2', 'tp_ch_all']);

    expect(await pick('tp_ch_1')).toBe(true);
    expect(rowsOf(lastList()).map((r) => r.id)).toEqual(['tp_mix_quick', 'tp_mix_standard', 'tp_mix_full']);

    expect(await pick('tp_mix_quick')).toBe(true);
    const langs = rowsOf(lastList()).map((r) => r.id);
    expect(langs[0]).toBe('tp_lang_en');
    expect(langs).toContain('tp_lang_ur');

    expect(await pick('tp_lang_en')).toBe(true);

    const [request] = db.tables.test_paper_requests;
    expect(request).toMatchObject({
      user_id: TEACHER.id, source_kind: 'textbook', subject: 'math', grade: '2', language: 'en', question_count: 10,
      source_ref: { textbookId: 'tb-1', chapterNumbers: [1] },
    });
    expect(request.source_text).toContain('=== Page 1 ===');
    expect(request.source_text).not.toContain('Add the ones first');
    const [paper] = db.tables.test_papers;
    expect(paper).toMatchObject({ request_id: request.id, version: 1, status: 'generating' });
    expect(queue.queueJob).toHaveBeenCalledWith(TEACHER.id, 'testpaper_generate',
      { paperId: paper.id, userId: TEACHER.id, to: FROM, chatLanguage: 'en' });
    expect(lastText()).toMatch(/Making your test paper — .*Numbers up to 999 · 10 questions · English/);
  });
});

describe('a whole-unit paper', () => {
  it('"all" (or 1-2 typed) covers every chapter, in order', async () => {
    load();
    await start();
    await pick('tp_src_tb_0');
    expect(await say('1-2')).toBe(true);
    await pick('tp_mix_standard');
    await pick('tp_lang_en');
    const [request] = db.tables.test_paper_requests;
    expect(request.source_ref.chapterNumbers).toEqual([1, 2]);
    expect(request.source_text).toMatch(/Page 1[\s\S]*Page 2/);
    expect(request.question_count).toBe(20);
  });

  it('a reply that is not a pick asks again rather than guessing', async () => {
    load();
    await start();
    await pick('tp_src_tb_0');
    expect(await say('9')).toBe(true);
    expect(lastText()).toMatch(/Reply with the numbers from the list/);
  });
});

describe('from the teacher\'s own lesson plans', () => {
  it('two plans and a typed mix', async () => {
    load();
    await start();
    await pick('tp_src_lp');
    expect(rowsOf(lastList()).map((r) => r.id)).toEqual(['tp_lp_0', 'tp_lp_1', 'tp_lp_2', 'tp_lp_all']);
    expect(await say('2,3')).toBe(true); // newest first: lp-2, lp-1
    expect(await say('5 MCQs, 3 true/false, 2 short questions')).toBe(true);
    await pick('tp_lang_en');
    const [request] = db.tables.test_paper_requests;
    expect(request).toMatchObject({ source_kind: 'lesson_plan', subject: 'Science', question_count: 10 });
    expect(request.source_ref.lessonPlanIds.sort()).toEqual(['lp-1', 'lp-2']);
    expect(request.question_types.map((q) => [q.id, q.count])).toEqual([['MCQs', 5], ['True/False', 3], ['Short Questions', 2]]);
  });

  it('a plan saved without content: honest message, nothing queued', async () => {
    load();
    await start();
    await pick('tp_src_lp');
    await pick('tp_lp_0'); // lp-3, "Fractions", no content
    await pick('tp_mix_quick');
    await pick('tp_lang_en');
    expect(queue.queueJob).not.toHaveBeenCalled();
    expect(db.tables.test_paper_requests || []).toHaveLength(0);
    expect(lastText()).toMatch(/saved without their content \(Fractions\)/);
  });
});

describe('from an uploaded chapter', () => {
  it('a PDF sent after "Send a chapter" becomes the source', async () => {
    load();
    await start();
    await pick('tp_src_up');
    expect(lastText()).toMatch(/Send me the chapter/);
    WA.downloadMedia.mockResolvedValue(Buffer.from('%PDF'));
    mockPdfParse.mockResolvedValue({ text: TEXT('The water cycle: evaporation, condensation, precipitation.') });
    const consumed = await O.handleDocument({ user: TEACHER, from: FROM, language: 'en', message: { document: { id: 'm1', mime_type: 'application/pdf', filename: 'water-cycle.pdf' } } });
    expect(consumed).toBe(true);
    await pick('tp_mix_quick');
    await pick('tp_lang_en');
    const [request] = db.tables.test_paper_requests;
    expect(request).toMatchObject({ source_kind: 'upload', source_ref: { filename: 'water-cycle.pdf' } });
    expect(request.source_text).toContain('The water cycle');
  });

  it('pasted text works the same way', async () => {
    load({ users: [{ id: TEACHER.id }] });
    await start();
    expect(await say(TEXT('Magnets attract iron and steel. Like poles repel and unlike poles attract.'))).toBe(true);
    expect(rowsOf(lastList())[0].id).toBe('tp_mix_quick');
  });

  it('after a refused subject, an uploaded chapter does not inherit that subject', async () => {
    load();
    await start('history'); // nothing for history → the upload is welcome
    WA.downloadMedia.mockResolvedValue(Buffer.from('%PDF'));
    mockPdfParse.mockResolvedValue({ text: TEXT('The water cycle: evaporation, condensation, precipitation.') });
    await O.handleDocument({ user: TEACHER, from: FROM, language: 'en', message: { document: { id: 'm1', mime_type: 'application/pdf', filename: 'water.pdf' } } });
    await pick('tp_mix_quick');
    await pick('tp_lang_en');
    // The model reads the subject from the chapter itself.
    expect(db.tables.test_paper_requests[0].subject).toBeNull();
  });

  it('a document nobody asked for is left to the other handlers', async () => {
    load();
    expect(await O.handleDocument({ user: TEACHER, from: FROM, language: 'en', message: { document: { id: 'm1', mime_type: 'application/pdf' } } })).toBe(false);
  });

  it.each([
    ['a classroom recording (audio/mpeg)', 'audio/mpeg', 'class-recording.mp3'],
    ['an m4a sent with no type', '', 'lesson.m4a'],
    ['a video', 'video/mp4', 'lesson.mp4'],
    ['a photo of a page', 'image/png', 'page.png'],
  ])('while a chapter is awaited, %s is left to the other handlers, never downloaded', async (_label, mimeType, filename) => {
    load({ users: [{ id: TEACHER.id }] });
    await start(); // no material → waiting for a chapter
    const taken = await O.handleDocument({ user: TEACHER, from: FROM, language: 'en', message: { document: { id: 'm1', mime_type: mimeType, filename } } });
    expect(taken).toBe(false);
    expect(WA.downloadMedia).not.toHaveBeenCalled();
    // Still waiting: the chapter sent next is taken.
    WA.downloadMedia.mockResolvedValue(Buffer.from('chapter'));
    expect(await O.handleDocument({ user: TEACHER, from: FROM, language: 'en', message: { document: { id: 'm2', mime_type: 'text/plain', filename: 'ch.txt' } } })).toBe(true);
  });

  it('a scan with no text says so instead of making a paper', async () => {
    load();
    await start();
    await pick('tp_src_up');
    WA.downloadMedia.mockResolvedValue(Buffer.from('%PDF'));
    mockPdfParse.mockResolvedValue({ text: '  ' });
    await O.handleDocument({ user: TEACHER, from: FROM, language: 'en', message: { document: { id: 'm1', mime_type: 'application/pdf', filename: 'scan.pdf' } } });
    expect(lastText()).toMatch(/could not find enough text/);
  });
});

describe('the paper language', () => {
  it('an Urdu paper is requested in Urdu', async () => {
    load();
    await start();
    await pick('tp_src_tb_0');
    await pick('tp_ch_1');
    await pick('tp_mix_quick');
    await pick('tp_lang_ur');
    expect(db.tables.test_paper_requests[0].language).toBe('ur');
  });
});

describe('my papers and editing', () => {
  async function withReadyPaper() {
    load();
    const Store = require('../../bot/shared/services/testpaper/testpaper-store.service');
    const request = await Store.createRequest({ userId: TEACHER.id, sourceKind: 'textbook', sourceText: TEXT('x'), sourceLabel: 'Math · Chapter 1: Numbers up to 999', subject: 'math', grade: '2', language: 'en' });
    const paper = await Store.createPaper({ requestId: request.id });
    await Store.markReady(paper.id, { title: 'Numbers — Chapter Test', examJson: { unseen: { objective: { MCQs: [{ question: 'q', options: ['a) 1'], marks: 1 }] } } }, questionCount: 1, totalMarks: 1 });
    return { Store, request, paper };
  }

  it('lists ready papers and re-sends the one picked, as stored', async () => {
    const { paper } = await withReadyPaper();
    await pick('tp_mine');
    const rows = rowsOf(lastList());
    expect(rows).toEqual([expect.objectContaining({ id: `tp_open_${paper.id}`, title: 'Numbers — Chapter Test' })]);
    await pick(`tp_open_${paper.id}`);
    expect(WA.sendDocument).toHaveBeenCalledTimes(2);
    expect(queue.queueJob).not.toHaveBeenCalled();
  });

  it('an edit request makes the next version and queues a revision', async () => {
    const { paper } = await withReadyPaper();
    await pick(`tp_edit_${paper.id}`);
    expect(lastText()).toMatch(/What should change\?/);
    expect(await say('make it easier and add two true/false questions')).toBe(true);
    const v2 = db.tables.test_papers.find((p) => p.version === 2);
    expect(v2).toMatchObject({ edited_from: paper.id, edit_instruction: 'make it easier and add two true/false questions', status: 'generating' });
    expect(queue.queueJob).toHaveBeenCalledWith(TEACHER.id, 'testpaper_revise', { paperId: v2.id, userId: TEACHER.id, to: FROM, chatLanguage: 'en' });
    expect(lastText()).toMatch(/version 2/);
  });

  it('a bare number or "ok" is not an edit request: asks again, makes no version', async () => {
    const { paper } = await withReadyPaper();
    await pick(`tp_edit_${paper.id}`);
    for (const stray of ['1', 'ok']) {
      expect(await say(stray)).toBe(true);
      expect(lastText()).toMatch(/Tell me what to change/);
    }
    expect(db.tables.test_papers.filter((p) => p.version === 2)).toHaveLength(0);
    expect(queue.queueJob).not.toHaveBeenCalled();
    // A real one-word request still goes through.
    expect(await say('easier')).toBe(true);
    expect(db.tables.test_papers.filter((p) => p.version === 2)).toHaveLength(1);
  });

  it('another teacher\'s paper id is refused', async () => {
    const { paper } = await withReadyPaper();
    await O.handleSelection({ user: { id: OTHER }, from: '15550100002', id: `tp_open_${paper.id}`, language: 'en' });
    expect(WA.sendDocument).not.toHaveBeenCalled();
    expect(lastText()).toMatch(/could not find that paper/);
  });
});

describe('switched off by the operator (RUMI_FEATURE_TEST_PAPER=off)', () => {
  // The operator switch, flipped while the bot runs (the admin toggle updates
  // the same cache): old buttons and half-finished conversations stop too.
  const switchOff = () => require('../../bot/shared/config/feature-availability').overrides.load({ RUMI_FEATURE_TEST_PAPER: 'off' });

  async function readyPaper() {
    const Store = require('../../bot/shared/services/testpaper/testpaper-store.service');
    const request = await Store.createRequest({ userId: TEACHER.id, sourceKind: 'upload', sourceText: TEXT('x'), language: 'en', questionCount: 1 });
    const paper = await Store.createPaper({ requestId: request.id });
    await Store.markReady(paper.id, { title: 'T', examJson: { unseen: {} }, questionCount: 1, totalMarks: 1 });
    return paper;
  }

  it('an Edit button from an earlier delivery queues no new job', async () => {
    load();
    const paper = await readyPaper();
    switchOff();
    expect(await pick(`tp_edit_${paper.id}`)).toBe(true);
    expect(lastText()).toMatch(/not switched on/);
    expect(await say('make it easier please')).toBe(false);
    expect(queue.queueJob).not.toHaveBeenCalled();
    expect(db.tables.test_papers).toHaveLength(1);
  });

  it('an edit asked for before the switch is not queued after it', async () => {
    load();
    const paper = await readyPaper();
    await pick(`tp_edit_${paper.id}`);
    switchOff();
    expect(await say('make it easier please')).toBe(false);
    expect(queue.queueJob).not.toHaveBeenCalled();
  });

  it('my papers and a re-send are refused', async () => {
    load();
    const paper = await readyPaper();
    switchOff();
    await O.showMyPapers({ user: TEACHER, from: FROM, language: 'en' });
    await pick('tp_mine');
    await pick(`tp_open_${paper.id}`);
    expect(WA.sendInteractiveMessage).not.toHaveBeenCalled();
    expect(WA.sendDocument).not.toHaveBeenCalled();
    expect(lastText()).toMatch(/not switched on/);
  });

  it('a conversation in progress stops: picks, text and documents are not taken', async () => {
    load();
    await start();
    await pick('tp_src_up');
    switchOff();
    expect(await say(TEXT('A pasted chapter about the water cycle and how rain forms.'))).toBe(false);
    expect(await O.handleDocument({ user: TEACHER, from: FROM, language: 'en', message: { document: { id: 'm1', mime_type: 'application/pdf', filename: 'ch.pdf' } } })).toBe(false);
    expect(WA.downloadMedia).not.toHaveBeenCalled();
    await pick('tp_mix_quick');
    expect(queue.queueJob).not.toHaveBeenCalled();
  });
});

describe('text outside the conversation', () => {
  it('is not consumed when no pick is pending', async () => {
    load();
    expect(await say('hello')).toBe(false);
  });

  it('a slash command always passes through', async () => {
    load();
    await start();
    await pick('tp_src_tb_0');
    expect(await say('/menu')).toBe(false);
  });

  it('"cancel" ends the conversation', async () => {
    load();
    await start();
    await pick('tp_src_tb_0');
    expect(await say('cancel')).toBe(true);
    expect(lastText()).toMatch(/no paper made/);
    expect(await say('1')).toBe(false);
  });

  it('owns only tp_ ids', () => {
    load();
    expect(O.isTestPaperId('tp_mix_quick')).toBe(true);
    expect(O.isTestPaperId('quiz_class_1')).toBe(false);
  });
});
