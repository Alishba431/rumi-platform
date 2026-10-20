'use strict';
/**
 * "Select all that apply" questions no longer wait for a Meta Flow: a child
 * answers one by typing every right letter ("A C") on any channel. The author
 * is asked for them by default; QUIZ_ALLOW_MULTI=off is the one way to stop it.
 */
jest.mock('../../bot/shared/services/quiz/transcript-quiz-llm', () => ({ completeJson: jest.fn() }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const { completeJson } = require('../../bot/shared/services/quiz/transcript-quiz-llm');
const Author = require('../../bot/shared/services/quiz/transcript-quiz-author.service');
const Multi = require('../../bot/shared/services/quiz/transcript-quiz-multi');

const DIGEST = { subject: 'science', grade_band: '6-8', slos: [{ id: 'S1', statement: 'Name the states of matter', taught_level: 'understand' }] };
const promptOf = async () => {
  await Author.author({ digest: DIGEST, transcript: 'the lesson', language: 'en' });
  return completeJson.mock.calls[completeJson.mock.calls.length - 1][0].prompt;
};

beforeEach(() => {
  delete process.env.QUIZ_ALLOW_MULTI;
  completeJson.mockReset().mockResolvedValue({ json: { questions: [] }, model: 'm', costUsd: 0, latencyMs: 1 });
});
afterAll(() => { delete process.env.QUIZ_ALLOW_MULTI; });

test('on by default: the author is offered select-all questions', async () => {
  expect(await promptOf()).toMatch(/SELECT ALL THAT APPLY/);
});

test.each(['off', 'false', '0'])('QUIZ_ALLOW_MULTI=%s: never', async (v) => {
  process.env.QUIZ_ALLOW_MULTI = v;
  expect(await promptOf()).not.toMatch(/SELECT ALL THAT APPLY/);
});

test('no Flow id is read or needed', () => {
  process.env.QUIZ_MULTI_FLOW_ID = 'flow-123';
  expect(Multi.multiFlowId()).toBe('');
  delete process.env.QUIZ_MULTI_FLOW_ID;
});
