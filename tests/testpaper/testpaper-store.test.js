/**
 * testpaper-store — the request, its versions, and "my papers".
 *
 * Against an in-memory query builder, so the real chains run. Pinned:
 *   * versions number 1, 2, 3 within a request and point at their parent;
 *   * a ready paper is never rewritten — an edit is a new row;
 *   * "my papers" lists one entry per request, showing its latest READY
 *     version (a failed or in-flight edit never hides the paper that works);
 *   * every read is owner-checked: one teacher can never fetch another's paper.
 */

const { createFakeDb } = require('./helpers/fake-db');

let Store;
let db;

const TEACHER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

const REQUEST = {
  userId: TEACHER,
  sourceKind: 'textbook',
  sourceRef: { textbookId: 'tb-1', chapterNumbers: [1] },
  sourceLabel: 'Grade 2 Math · Chapter 1',
  sourceText: 'Numbers up to 999…',
  subject: 'Math',
  grade: '2',
  language: 'en',
  contentSource: 'unseen',
  questionTypes: [{ id: 'MCQs', count: 5, category: 'objective' }],
  questionCount: 5,
};

beforeEach(() => {
  jest.resetModules();
  db = createFakeDb({ users: [{ id: TEACHER }, { id: OTHER }] });
  jest.doMock('../../bot/shared/config/supabase', () => db);
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  Store = require('../../bot/shared/services/testpaper/testpaper-store.service');
});

async function readyPaper(requestId, extra = {}) {
  const paper = await Store.createPaper({ requestId, ...extra });
  await Store.markReady(paper.id, {
    title: `Paper v${paper.version}`, examJson: { unseen: {} }, questionCount: 5, totalMarks: 5,
    tokenData: { model: 'm', inputTokens: 1, outputTokens: 2 },
  });
  return paper;
}

describe('createRequest', () => {
  it('writes the ask with its source text, in the schema\'s column names', async () => {
    const req = await Store.createRequest(REQUEST);
    expect(db.tables.test_paper_requests[0]).toMatchObject({
      id: req.id, user_id: TEACHER, source_kind: 'textbook', source_text: 'Numbers up to 999…',
      subject: 'Math', grade: '2', language: 'en', content_source: 'unseen', question_count: 5,
      source_ref: { textbookId: 'tb-1', chapterNumbers: [1] },
    });
  });
});

describe('versions', () => {
  it('number from 1 within a request and point at their parent', async () => {
    const req = await Store.createRequest(REQUEST);
    const v1 = await readyPaper(req.id);
    const v2 = await Store.createPaper({ requestId: req.id, editedFrom: v1.id, editInstruction: 'easier' });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(db.tables.test_papers.find((p) => p.id === v2.id)).toMatchObject({
      edited_from: v1.id, edit_instruction: 'easier', status: 'generating',
    });
  });

  it('markReady fills the row; markFailed records a code, never touching a ready row', async () => {
    const req = await Store.createRequest(REQUEST);
    const v1 = await readyPaper(req.id);
    expect(db.tables.test_papers[0]).toMatchObject({ status: 'ready', title: 'Paper v1', model: 'm', input_tokens: 1 });

    await Store.markFailed(v1.id, 'BAD_JSON', 'x');
    expect(db.tables.test_papers[0].status).toBe('ready');

    const v2 = await Store.createPaper({ requestId: req.id, editedFrom: v1.id });
    await Store.markFailed(v2.id, 'MODEL_UNAVAILABLE', '503');
    expect(db.tables.test_papers[1]).toMatchObject({ status: 'failed', error_code: 'MODEL_UNAVAILABLE' });
  });

  it('markReady never rewrites a ready paper (a duplicate job cannot replace what the teacher has)', async () => {
    const req = await Store.createRequest(REQUEST);
    const v1 = await readyPaper(req.id);
    await Store.markReady(v1.id, { title: 'Rewritten', examJson: { unseen: {} }, questionCount: 1, totalMarks: 1, tokenData: { model: 'other' } });
    expect(db.tables.test_papers[0]).toMatchObject({ status: 'ready', title: 'Paper v1', model: 'm' });
  });
});

describe('getPaper', () => {
  it('returns the paper with its request for its owner', async () => {
    const req = await Store.createRequest(REQUEST);
    const v1 = await readyPaper(req.id);
    const got = await Store.getPaper(v1.id, TEACHER);
    expect(got.paper.id).toBe(v1.id);
    expect(got.request.source_text).toBe('Numbers up to 999…');
  });

  it('returns null for anyone else', async () => {
    const req = await Store.createRequest(REQUEST);
    const v1 = await readyPaper(req.id);
    expect(await Store.getPaper(v1.id, OTHER)).toBeNull();
  });
});

describe('listPapers — "my papers"', () => {
  it('one entry per request, newest first, showing the latest ready version', async () => {
    const a = await Store.createRequest(REQUEST);
    const a1 = await readyPaper(a.id);
    const a2 = await readyPaper(a.id, { editedFrom: a1.id });
    const failedEdit = await Store.createPaper({ requestId: a.id, editedFrom: a2.id });
    await Store.markFailed(failedEdit.id, 'BAD_JSON', '');

    const b = await Store.createRequest({ ...REQUEST, sourceLabel: 'Whole unit', subject: 'Science' });
    await readyPaper(b.id);

    const list = await Store.listPapers(TEACHER);
    expect(list.map((p) => [p.sourceLabel, p.version])).toEqual([['Whole unit', 1], ['Grade 2 Math · Chapter 1', 2]]);
    expect(list[1]).toMatchObject({ paperId: a2.id, requestId: a.id, versionCount: 2, title: 'Paper v2' });
  });

  it('a request with no ready version is not listed', async () => {
    const req = await Store.createRequest(REQUEST);
    await Store.createPaper({ requestId: req.id });
    expect(await Store.listPapers(TEACHER)).toEqual([]);
  });

  it('never lists another teacher\'s papers', async () => {
    const req = await Store.createRequest({ ...REQUEST, userId: OTHER });
    await readyPaper(req.id);
    expect(await Store.listPapers(TEACHER)).toEqual([]);
  });
});
