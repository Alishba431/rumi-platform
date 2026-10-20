/**
 * paper-generation — source material in, a test paper's question tree out.
 *
 * The model call is mocked at llm-client's client, so the model registry,
 * prompt assembly and every post-processing step run on their live path. What is pinned:
 *   * the prompt is assembled in the right order (safety last) and carries the
 *     subject family's guidance, the paper's language and the teacher's counts;
 *   * the neutral prompt pack carries no single-country or gendered text;
 *   * thin source material gets an honest refusal, never an invented paper —
 *     before the model is asked when there is nothing to send, and when the
 *     model itself says the source cannot support a paper;
 *   * the failure codes the orchestrator turns into teacher messages.
 */

const PROMPTS = require('../../bot/shared/services/testpaper/testpaper-prompts.json');

let Gen;
let mockCreate;

const CHAPTER = [
  '=== Page 1 ===',
  'Numbers up to 999. A 3-digit number has hundreds, tens and ones.',
  'In 345 the digit 3 is in the hundreds place, 4 in the tens place and 5 in the ones place.',
  '=== Page 2 ===',
  'We compare numbers using <, > and =. 452 > 425 because 5 tens are more than 2 tens.',
  'Exercise: Write the number that comes just after 399. Round 47 to the nearest ten.',
].join('\n');

const PAPER = {
  title: 'Numbers up to 999 — Chapter Test',
  unseen: {
    objective: {
      MCQs: [
        { main_question: 'Choose the correct option', question: 'In 345, which digit is in the tens place?', options: ['a) 3', 'b) 4', 'c) 5', 'd) 0'], marks: 1, lines: 0, answer: 'b', blooms: 'Remember' },
      ],
      'True/False': [
        { main_question: 'Write True or False', question: '452 is greater than 425.', marks: 1, lines: 0, answer: 'True', blooms: 'Understand' },
      ],
    },
    subjective: {
      'Short Questions': [
        { main_question: 'Answer the following', question: 'Round 47 to the nearest ten.', marks: 2, lines: 2, answer: '50', blooms: 'Apply' },
      ],
    },
  },
};

function reply(content, extra = {}) {
  return { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 400, total_tokens: 1300 }, ...extra };
}

const BASE_ARGS = {
  grade: 2,
  subject: 'Math',
  language: 'en',
  sourceText: CHAPTER,
  sourceLabel: 'Chapter 1 · Numberland (pages 1-2)',
  contentSource: 'unseen',
  questionTypes: [
    { id: 'MCQs', count: 1, category: 'objective' },
    { id: 'True/False', count: 1, category: 'objective' },
    { id: 'Short Questions', count: 1, category: 'subjective' },
  ],
};

beforeEach(() => {
  jest.resetModules();
  process.env.OPENROUTER_API_KEY = 'test-key';
  delete process.env.TESTPAPER_MODEL;
  delete process.env.LLM_PROVIDER;
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
  Gen = require('../../bot/shared/services/testpaper/paper-generation.service');
});

afterEach(() => jest.resetModules());

describe('the prompt pack', () => {
  const all = Object.values(PROMPTS).join('\n');

  // Country, city and partner names are caught repo-wide by the hygiene gate
  // (which scans this JSON too); these are the content checks it does not make.
  it.each([
    /\bAli\b/, /Alice/, /Islamiat|PBUH|Surah/i, /\b(he|him|his|she|her)\b/i,
  ])('carries no %s', (re) => {
    expect(all).not.toMatch(re);
  });

  it('tells the model to refuse rather than invent when the source is thin', () => {
    expect(PROMPTS['tp.system']).toMatch(/insufficient_source/);
  });

  it('has guidance for every subject family the catalogue knows', () => {
    const { CATALOGUE } = require('../../bot/shared/services/testpaper/question-types');
    for (const family of Object.keys(CATALOGUE)) {
      expect(PROMPTS[`tp.subject.${family}`]).toEqual(expect.any(String));
    }
  });
});

describe('buildSystemPrompt', () => {
  it('assembles role, subject guidance, format, answer key, final task — safety last', () => {
    const s = Gen.buildSystemPrompt({ subject: 'Mathematics' });
    const order = ['tp.system', 'tp.subject.maths', 'tp.format.exam', 'tp.answer_key', 'tp.task.final', 'tp.safety']
      .map((k) => s.indexOf(PROMPTS[k]));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(s.endsWith(PROMPTS['tp.safety'])).toBe(true);
  });

  it('a subject nobody planned for gets the general guidance', () => {
    expect(Gen.buildSystemPrompt({ subject: 'Music' })).toContain(PROMPTS['tp.subject.general']);
  });
});

describe('buildUserPrompt', () => {
  it('carries the source, the counts, the grade and the language', () => {
    const u = Gen.buildUserPrompt({ ...BASE_ARGS, language: 'ur' });
    expect(u).toContain(CHAPTER);
    expect(u).toContain('Unseen Objective questions — 1 MCQs, 1 True/False');
    expect(u).toContain('Unseen Subjective questions — 1 Short Questions');
    expect(u).toContain('exactly 3 questions');
    expect(u).toContain('**Grade:** 2');
    expect(u).toMatch(/Write the WHOLE paper in Urdu/);
  });

  it('says so when the grade is unknown rather than printing undefined', () => {
    const u = Gen.buildUserPrompt({ ...BASE_ARGS, grade: null });
    expect(u).not.toContain('undefined');
    expect(u).toMatch(/\*\*Grade:\*\* not stated/);
  });

  it('adds the marks budget only when one was set', () => {
    expect(Gen.buildUserPrompt({ ...BASE_ARGS, totalMarks: 20 })).toMatch(/worth 20 marks/);
    expect(Gen.buildUserPrompt(BASE_ARGS)).not.toMatch(/marks in total/);
  });
});

describe('generateExam', () => {
  it('asks the registry\'s model for JSON and returns the cleaned tree', async () => {
    mockCreate.mockResolvedValue(reply(JSON.stringify(PAPER)));
    const out = await Gen.generateExam(BASE_ARGS);

    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe('google/gemini-2.5-pro');
    expect(call.response_format).toEqual({ type: 'json_object' });
    expect(call.messages[0].role).toBe('system');
    expect(out.questionCount).toBe(3);
    expect(out.title).toBe('Numbers up to 999 — Chapter Test');
    // An MCQ answer given as a bare letter is rewritten to the option itself.
    expect(out.examJson.unseen.objective.MCQs[0].answer).toBe('b) 4');
    expect(out.tokenData).toMatchObject({ inputTokens: 900, outputTokens: 400, model: 'google/gemini-2.5-pro' });
  });

  it('when no subject was given, returns the subject the model read from the source', async () => {
    mockCreate.mockResolvedValue(reply(JSON.stringify({ ...PAPER, subject: 'Science' })));
    const out = await Gen.generateExam({ ...BASE_ARGS, subject: null });
    expect(out.subject).toBe('Science');
    expect(mockCreate.mock.calls[0][0].messages[1].content).toMatch(/top-level "subject"/);
  });

  it('TESTPAPER_MODEL moves the model without a restart', async () => {
    mockCreate.mockResolvedValue(reply(JSON.stringify(PAPER)));
    process.env.TESTPAPER_MODEL = 'openai/gpt-4.1';
    await Gen.generateExam(BASE_ARGS);
    expect(mockCreate.mock.calls[0][0].model).toBe('openai/gpt-4.1');
  });

  it('refuses before calling the model when there is no real source text', async () => {
    await expect(Gen.generateExam({ ...BASE_ARGS, sourceText: 'Fractions' }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_SOURCE' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('passes on the model\'s own verdict that the source cannot support a paper', async () => {
    mockCreate.mockResolvedValue(reply('{"insufficient_source": true, "reason": "The text is only a list of activity titles."}'));
    await expect(Gen.generateExam(BASE_ARGS))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_SOURCE', reason: 'The text is only a list of activity titles.' });
  });

  it('an outage is MODEL_UNAVAILABLE, not bad output', async () => {
    mockCreate.mockRejectedValue(new Error('503 upstream'));
    await expect(Gen.generateExam(BASE_ARGS)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('an empty reply cut off at the length limit is TRUNCATED', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: {} });
    await expect(Gen.generateExam(BASE_ARGS)).rejects.toMatchObject({ code: 'TRUNCATED' });
  });

  it('unreadable output is BAD_JSON', async () => {
    mockCreate.mockResolvedValue(reply('Here is your paper! Question 1: ...'));
    await expect(Gen.generateExam(BASE_ARGS)).rejects.toMatchObject({ code: 'BAD_JSON' });
  });

  it('valid JSON with no questions is NO_QUESTIONS', async () => {
    mockCreate.mockResolvedValue(reply('{"title":"x","unseen":{"objective":{}}}'));
    await expect(Gen.generateExam(BASE_ARGS)).rejects.toMatchObject({ code: 'NO_QUESTIONS' });
  });

  it('enforces the marks budget by dropping whole questions', async () => {
    mockCreate.mockResolvedValue(reply(JSON.stringify(PAPER)));
    const out = await Gen.generateExam({ ...BASE_ARGS, totalMarks: 2 });
    expect(Gen.totalMarksOf(out.examJson)).toBeLessThanOrEqual(2);
    expect(out.marksRemoved).toBe(1);
  });

  it('strips image keys the model was told not to write', async () => {
    const withImage = JSON.parse(JSON.stringify(PAPER));
    withImage.unseen.objective.MCQs[0].image = 'Black and white drawing of…';
    mockCreate.mockResolvedValue(reply(JSON.stringify(withImage)));
    const out = await Gen.generateExam(BASE_ARGS);
    expect(out.examJson.unseen.objective.MCQs[0].image).toBeUndefined();
  });
});

describe('revisePaper', () => {
  it('sends the current paper, the request and the source; returns the new tree', async () => {
    const revised = JSON.parse(JSON.stringify(PAPER));
    revised.unseen.objective['True/False'].push({ main_question: 'Write True or False', question: '399 + 1 = 400.', marks: 1, lines: 0, answer: 'True', blooms: 'Apply' });
    mockCreate.mockResolvedValue(reply(JSON.stringify(revised)));

    const out = await Gen.revisePaper({
      examJson: PAPER, instruction: 'Add one more true/false question', sourceText: CHAPTER,
      grade: 2, subject: 'Math', language: 'en',
    });

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain(PROMPTS['tp.revise.system']);
    expect(call.messages[0].content.endsWith(PROMPTS['tp.safety'])).toBe(true);
    expect(call.messages[1].content).toContain('Add one more true/false question');
    expect(call.messages[1].content).toContain('In 345, which digit is in the tens place?');
    expect(call.messages[1].content).toContain(CHAPTER);
    expect(out.questionCount).toBe(4);
    expect(out.changed).toBe(true);
  });

  it('reports an unchanged paper and the model\'s note when the request could not be done', async () => {
    mockCreate.mockResolvedValue(reply(JSON.stringify({ ...PAPER, note: 'The chapter has no fractions to ask about.' })));
    const out = await Gen.revisePaper({ examJson: PAPER, instruction: 'Add fraction questions', sourceText: CHAPTER, grade: 2, subject: 'Math', language: 'en' });
    expect(out.changed).toBe(false);
    expect(out.note).toBe('The chapter has no fractions to ask about.');
  });
});

// Ported from the source generator's suite: the count plan and the seen cap.
describe('planCounts / trimSeen', () => {
  it('unseen: every question is new', () => {
    expect(Gen.planCounts({ contentSource: 'unseen', questionCount: 10, questionTypes: [] }))
      .toMatchObject({ total: 10, seenTarget: 0, unseenTarget: 10 });
  });
  it('seen: exactly the total, lifted from the book', () => {
    expect(Gen.planCounts({ contentSource: 'seen', questionCount: 6 }))
      .toMatchObject({ total: 6, seenTarget: 6, unseenTarget: 0, questionTypes: [] });
  });
  it('both with a seen count: seen + typed', () => {
    const types = [{ id: 'MCQs', count: 4, category: 'objective' }];
    expect(Gen.planCounts({ contentSource: 'both', questionTypes: types, seenCount: 3 }))
      .toMatchObject({ total: 7, seenTarget: 3, unseenTarget: 4 });
  });
  it('trims seen questions beyond the cap, in tree order', () => {
    const tree = { seen: { objective: { MCQs: [{ question: 'a' }, { question: 'b' }, { question: 'c' }] } } };
    expect(Gen.trimSeen(tree, 2)).toBe(1);
    expect(tree.seen.objective.MCQs.map((q) => q.question)).toEqual(['a', 'b']);
  });
});
