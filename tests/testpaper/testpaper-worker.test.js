/**
 * testpaper.worker — the queued job that writes, stores and delivers a paper.
 *
 * End to end inside the process: the real store (on an in-memory query
 * builder), the real generator, renderer and delivery. Only the boundaries are
 * mocked — the model at llm-client's client, Chromium at the html-to-pdf wrapper, the
 * channel at the messaging facade.
 */

const { createFakeDb } = require('./helpers/fake-db');

const TEACHER = '00000000-0000-4000-8000-000000000001';
const CHAPTER = `=== Page 1 ===\n${'A 3-digit number has hundreds, tens and ones. 345 has 3 hundreds, 4 tens and 5 ones. '.repeat(4)}`;

const PAPER_JSON = {
  title: 'Numbers up to 999 — Chapter Test',
  unseen: {
    objective: { MCQs: [{ main_question: 'Choose', question: 'In 345, which digit is in the tens place?', options: ['a) 3', 'b) 4', 'c) 5'], marks: 1, lines: 0, answer: 'b) 4', blooms: 'Remember' }] },
    subjective: { 'Short Questions': [{ main_question: 'Answer', question: 'How many hundreds are in 345?', marks: 2, lines: 2, answer: '3', blooms: 'Remember' }] },
  },
};

let Worker;
let Store;
let db;
let WA;
let mockCreate;

function reply(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } };
}

beforeEach(() => {
  jest.resetModules();
  process.env.OPENROUTER_API_KEY = 'test-key';
  delete process.env.TESTPAPER_MODEL;
  db = createFakeDb({ users: [{ id: TEACHER }] });
  jest.doMock('../../bot/shared/config/supabase', () => db);
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  mockCreate = jest.fn();
  // The model call is mocked at llm-client's client (a real file, mocked the
  // same non-virtual way by every suite) rather than at the openai package,
  // whose mixed virtual/real mocking across suites made results depend on
  // which suites shared a Jest worker.
  jest.doMock('../../bot/shared/services/llm-client', () => ({
    getClient: () => ({ chat: { completions: { create: mockCreate } } }),
    getDefaultModel: () => 'openai/gpt-4o',
  }));
  jest.doMock('../../bot/shared/utils/html-to-pdf', () => ({ htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')) }));
  WA = {
    sendDocument: jest.fn().mockResolvedValue(true),
    sendMessage: jest.fn().mockResolvedValue(true),
    sendInteractiveButtons: jest.fn().mockResolvedValue(true),
  };
  jest.doMock('../../bot/shared/services/whatsapp.service', () => WA);
  Store = require('../../bot/shared/services/testpaper/testpaper-store.service');
  Worker = require('../../bot/workers/testpaper.worker');
});

async function queuedPaper(overrides = {}) {
  const request = await Store.createRequest({
    userId: TEACHER, sourceKind: 'textbook', sourceRef: { textbookId: 'tb-1', chapterNumbers: [1] },
    sourceLabel: 'Math · Chapter 1: Numbers up to 999', sourceText: CHAPTER, subject: 'math', grade: '2',
    language: 'en', questionTypes: [{ id: 'MCQs', count: 1, category: 'objective' }, { id: 'Short Questions', count: 1, category: 'subjective' }],
    questionCount: 2, ...overrides,
  });
  const paper = await Store.createPaper({ requestId: request.id });
  return { request, paper };
}

describe('switched off by the operator', () => {
  it('a job queued before RUMI_FEATURE_TEST_PAPER=off is not run: no model call, the teacher is told', async () => {
    const { paper } = await queuedPaper();
    require('../../bot/shared/config/feature-availability').overrides.load({ RUMI_FEATURE_TEST_PAPER: 'off' });
    const out = await Worker.process({ action: 'generate', paperId: paper.id, userId: TEACHER, to: 'matrix:@t:example.org', chatLanguage: 'en' });
    expect(out).toEqual({ skipped: 'switched_off' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(db.tables.test_papers[0]).toMatchObject({ status: 'failed', error_code: 'SWITCHED_OFF' });
    expect(WA.sendMessage.mock.calls[0][1]).toMatch(/not switched on/);
    expect(WA.sendDocument).not.toHaveBeenCalled();
  });
});

describe('generate', () => {
  it('writes the paper, marks it ready and delivers paper + key', async () => {
    mockCreate.mockResolvedValue(reply(PAPER_JSON));
    const { paper } = await queuedPaper();
    await Worker.process({ action: 'generate', paperId: paper.id, userId: TEACHER, to: 'matrix:@t:example.org', chatLanguage: 'en' });

    const row = db.tables.test_papers[0];
    expect(row).toMatchObject({ status: 'ready', title: 'Numbers up to 999 — Chapter Test', question_count: 2, total_marks: 3, model: 'google/gemini-2.5-pro' });
    expect(WA.sendDocument).toHaveBeenCalledTimes(2);
    expect(WA.sendDocument.mock.calls[0][0]).toBe('matrix:@t:example.org');
    // The model was given the stored source text, not a re-read of the book.
    expect(mockCreate.mock.calls[0][0].messages[1].content).toContain('345 has 3 hundreds');
  });

  it('an upload with no stated subject gets the subject the model read from it', async () => {
    mockCreate.mockResolvedValue(reply({ ...PAPER_JSON, subject: 'Science' }));
    const { paper } = await queuedPaper({ sourceKind: 'upload', subject: null });
    await Worker.process({ action: 'generate', paperId: paper.id, userId: TEACHER, to: '15550100001' });
    expect(db.tables.test_paper_requests[0].subject).toBe('Science');
    expect(WA.sendDocument.mock.calls[0][2]).toMatch(/^TestPaper_Science_/);
  });

  it('is idempotent: a redelivered job for a ready paper does nothing', async () => {
    mockCreate.mockResolvedValue(reply(PAPER_JSON));
    const { paper } = await queuedPaper();
    const job = { action: 'generate', paperId: paper.id, userId: TEACHER, to: '15550100001' };
    await Worker.process(job);
    await Worker.process(job);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(WA.sendDocument).toHaveBeenCalledTimes(2);
  });

  it('a source the model judges too thin is an honest message, never a paper', async () => {
    mockCreate.mockResolvedValue(reply({ insufficient_source: true, reason: 'the text only lists activity names' }));
    const { paper } = await queuedPaper();
    await Worker.process({ action: 'generate', paperId: paper.id, userId: TEACHER, to: '15550100001' });

    expect(db.tables.test_papers[0]).toMatchObject({ status: 'failed', error_code: 'INSUFFICIENT_SOURCE' });
    expect(WA.sendDocument).not.toHaveBeenCalled();
    expect(WA.sendMessage.mock.calls[0][1]).toMatch(/can't build a fair paper from Math · Chapter 1: Numbers up to 999 — the text only lists activity names/);
  });

  it('a model outage fails the version and apologises', async () => {
    mockCreate.mockRejectedValue(new Error('503'));
    const { paper } = await queuedPaper();
    await Worker.process({ action: 'generate', paperId: paper.id, userId: TEACHER, to: '15550100001' });
    expect(db.tables.test_papers[0]).toMatchObject({ status: 'failed', error_code: 'MODEL_UNAVAILABLE' });
    expect(WA.sendMessage.mock.calls[0][1]).toMatch(/could not be made/);
  });

  it('a paper id that is not the teacher\'s is ignored', async () => {
    const { paper } = await queuedPaper();
    await Worker.process({ action: 'generate', paperId: paper.id, userId: '00000000-0000-4000-8000-0000000000ff', to: '15550100001' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(WA.sendDocument).not.toHaveBeenCalled();
  });
});

describe('revise', () => {
  async function readyV1() {
    mockCreate.mockResolvedValueOnce(reply(PAPER_JSON));
    const { request, paper } = await queuedPaper();
    await Worker.process({ action: 'generate', paperId: paper.id, userId: TEACHER, to: '15550100001' });
    WA.sendDocument.mockClear();
    return { request, v1: paper };
  }

  it('makes the next version from the request and delivers it', async () => {
    const { request, v1 } = await readyV1();
    const v2Json = JSON.parse(JSON.stringify(PAPER_JSON));
    v2Json.unseen.objective.MCQs.push({ question: 'In 345, which digit is in the ones place?', options: ['a) 3', 'b) 5'], marks: 1, answer: 'b) 5' });
    mockCreate.mockResolvedValueOnce(reply(v2Json));

    const v2 = await Store.createPaper({ requestId: request.id, editedFrom: v1.id, editInstruction: 'add one MCQ' });
    await Worker.process({ action: 'revise', paperId: v2.id, userId: TEACHER, to: '15550100001' });

    const revisePrompt = mockCreate.mock.calls[1][0].messages[1].content;
    expect(revisePrompt).toContain('add one MCQ');
    expect(revisePrompt).toContain('In 345, which digit is in the tens place?');
    const row = db.tables.test_papers.find((p) => p.id === v2.id);
    expect(row).toMatchObject({ status: 'ready', version: 2, question_count: 3 });
    expect(db.tables.test_papers.find((p) => p.id === v1.id).question_count).toBe(2);
    expect(WA.sendDocument.mock.calls[0][2]).toMatch(/_v2\.pdf$/);
  });

  it('an edit that changes nothing is said so, and no duplicate version is kept', async () => {
    const { request, v1 } = await readyV1();
    mockCreate.mockResolvedValueOnce(reply({ ...PAPER_JSON, note: 'the chapter has no fractions' }));
    const v2 = await Store.createPaper({ requestId: request.id, editedFrom: v1.id, editInstruction: 'add fractions' });
    await Worker.process({ action: 'revise', paperId: v2.id, userId: TEACHER, to: '15550100001' });

    expect(db.tables.test_papers.find((p) => p.id === v2.id)).toMatchObject({ status: 'failed', error_code: 'UNCHANGED' });
    expect(WA.sendDocument).not.toHaveBeenCalled();
    expect(WA.sendMessage.mock.calls.pop()[1]).toMatch(/left the paper as it was — the chapter has no fractions/);
  });
});
