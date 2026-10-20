'use strict';
/**
 * The class report's "what to do tomorrow" box goes through the one LLM entry
 * point, as the `quiz.videoReport` job, and its prompt is written for any
 * deployment.
 *
 *   - getClientForModel(null, { job: 'quiz.videoReport' }) picks the client
 *     and the model (QUIZ_REPORT_MODEL, else the registry default); the call
 *     uses exactly that model and sends no field the API does not know.
 *   - the prompt names no country: a teacher anywhere gets advice about their
 *     own class, built from the questions the class actually missed.
 *
 * The network boundary (the LLM client) is the stand-in; the prompt builder,
 * the reply parsing and the shape check are the real ones.
 */

jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const mockCreate = jest.fn();
const mockGetClientForModel = jest.fn(() => ({
  client: { chat: { completions: { create: mockCreate } } },
  model: 'example/report-model',
  job: 'quiz.videoReport',
}));
jest.mock('../../bot/shared/services/llm-client', () => ({
  getClientForModel: (...a) => mockGetClientForModel(...a),
  getClient: jest.fn(() => { throw new Error('the report must not take the bare default client'); }),
}));

const report = require('../../bot/shared/services/quiz/video-quiz-report.service');

const HARDEST = [{
  question_text: 'Which of these is a fraction equal to one half?',
  wrong: 9, total: 14, top_wrong_text: '1/3', correct_text: '2/4',
  misconception: 'You picked the fraction with the smallest numbers.',
}];

const reteachReply = JSON.stringify({
  muddled: 'Many children picked 1/3 because it looked smallest and simplest.',
  board: 'Draw two equal bars on the board. Shade one half of the first bar. Split the second bar into four parts and shade two of them, then ask the class what they notice.',
  check: 'Ask: is 3/6 the same as one half? Show me with a drawing.',
});

beforeEach(() => {
  mockCreate.mockReset();
  mockGetClientForModel.mockClear();
});

describe('the guidance call goes through getClientForModel as quiz.videoReport', () => {
  test('client and model come from the job; the request carries only API fields', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: reteachReply } }] });

    const out = await report.generateGuidance({
      shareCodeId: 'sc-1', topic: 'Equivalent fractions', grade: '4', average: 52,
      finished: 14, started: 16, hardest: HARDEST, language: 'en', mode: 'reteach',
    });

    expect(mockGetClientForModel).toHaveBeenCalledWith(null, { job: 'quiz.videoReport' });
    expect(mockCreate).toHaveBeenCalled();
    const params = mockCreate.mock.calls[0][0];
    expect(params.model).toBe('example/report-model');
    expect(params).not.toHaveProperty('job');
    expect(out).toEqual(expect.objectContaining({ board: expect.stringContaining('two equal bars') }));
  });

  test('a failed call still lets the report go out without the box', async () => {
    mockCreate.mockRejectedValue(new Error('provider down'));
    const out = await report.generateGuidance({
      topic: 'Equivalent fractions', grade: '4', average: 52, finished: 14, started: 16,
      hardest: HARDEST, language: 'en', mode: 'reteach',
    });
    expect(out).toBeNull();
  });
});

describe('the guidance prompt is written for any deployment', () => {
  const digest = { topic_as_taught: 'Equivalent fractions with drawings', slos: [{ id: 'S1', statement: 'Find a fraction equal to one half' }] };
  const cases = [
    ['reteach, English', { hardest: HARDEST, language: 'en', mode: 'reteach', average: 52 }],
    ['secure, English', { hardest: [], language: 'en', mode: 'secure', average: 94, digest }],
    ['reteach, Urdu', { hardest: HARDEST, language: 'ur', mode: 'reteach', average: 52 }],
    ['secure, Urdu', { hardest: [], language: 'ur', mode: 'secure', average: 94, digest }],
  ];
  test.each(cases)('%s: no country, no fixed region', (_, ctx) => {
    const prompt = report.buildGuidancePrompt({
      topic: 'Equivalent fractions', grade: '4', finished: 14, started: 16, ...ctx,
    });
    expect(prompt).not.toMatch(/Pakistan|PKT|پاکستان/i);
    expect(prompt).toMatch(/teacher|استاد/);
  });
});
