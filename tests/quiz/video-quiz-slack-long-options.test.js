'use strict';
/**
 * With the lesson quiz OFF, a v1.2.0 video quiz
 * question whose options exceed the 24-char row title is sent to a Slack (or
 * Discord) recipient as the stem alone plus a select whose options read
 * "A", "B", "C", "D" — the full option text rides only in the row
 * description. On main the body spelled every option out ("A. 5 red pencils
 * and 10 blue pencils"), so the Slack driver must draw that description or the
 * child sees "A / B / C / D" and nothing to choose between.
 */
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));
jest.mock('../../bot/shared/services/quiz/video-quiz-rate-limiter.service', () => ({ throttle: jest.fn().mockResolvedValue() }));
const captured = [];
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendInteractiveMessage: jest.fn(async (to, data) => { captured.push(data); return true; }),
  sendInteractiveButtons: jest.fn(async (to, body, buttons) => { captured.push({ body: { text: body }, buttons }); return true; }),
  sendMessage: jest.fn().mockResolvedValue(true),
}));
const posted = [];
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: jest.fn(async (m) => { posted.push(m); return { ok: true }; }) },
    conversations: { open: jest.fn(async () => ({ channel: { id: 'D1' } })), join: jest.fn() },
  })),
}), { virtual: true });

beforeAll(() => { process.env.SLACK_BOT_TOKEN = 'xoxb-test'; });

const render = require('../../bot/shared/services/quiz/video-quiz-render.service');
const sender = require('../../bot/shared/services/quiz/video-quiz-sender.service');

const OPTS = ['5 red pencils and 10 blue pencils', '8 red pencils and 15 blue pencils',
  '23 blue pencils, and 19 red pencils', '23 blue, 10 red, and 10 green pencils'];

test('a Slack child sees every option of a long-option v1.2.0 video question (flag off)', async () => {
  delete process.env.TRANSCRIPT_QUIZ_ENABLED;
  const q = {
    id: 'q1', question_text: 'What combination of pencils will make 43 pencils?',
    option_a: OPTS[0], option_b: OPTS[1], option_c: OPTS[2], option_d: OPTS[3],
    correct_option: 'C', explanation: '', option_feedback: null, media: {}, render_pattern: 'P1',
  };
  const msgs = render.build(q, { questionNumber: 1, totalQuestions: 5 });
  await sender.sendPhase('slack:U0TESTCHILD', msgs, 'interaction',
    { questionId: 'q1', sessionId: 's1', language: 'en', typedAnswers: false });
  expect(captured.length).toBe(1);
  const slack = require('../../bot/shared/services/messaging/slack-channel.service');
  await slack.sendInteractiveMessage('slack:U0TESTCHILD', captured[0]);
  expect(posted.length).toBe(1);
  const visible = JSON.stringify(posted[0].blocks.map((b) => {
    if (b.text) return b.text.text;
    return (b.elements || []).map((e) => (e.options || []).map((o) => o.text.text + (o.description ? ` ${o.description.text}` : '')));
  }));
  for (const o of OPTS) expect(visible).toContain(o);
});
