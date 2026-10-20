'use strict';
/**
 * The class link is channel-aware.
 *
 * A teacher forwards ONE message to their class; each child opens a chat with
 * the bot and sends the code. Which line can open that chat depends on where
 * the teacher (and so the class) is:
 *   - WhatsApp (a bare phone, Meta or Baileys): a wa.me link that pre-fills the
 *     code — needs this deployment's dialable number;
 *   - Matrix (`matrix:` / `mtx:` identifiers): a matrix.to link to the bot's
 *     account, plus the code to send — wa.me would open somebody's WhatsApp;
 *   - anything else, or no number / account configured: the code, and the bot's
 *     name to send it to.
 * joinInvite is the ONE place that decides; the video-quiz class link and the
 * lesson-quiz hand-off both use it.
 */

jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(), set: jest.fn().mockResolvedValue(true), delete: jest.fn(), setNX: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const { botName } = require('../../bot/shared/config/branding');
const share = require('../../bot/shared/services/quiz/video-quiz-share.service');
const { createMemorySupabase } = require('./helpers/memory-supabase');

const ENV_KEYS = ['WHATSAPP_BOT_NUMBER', 'REFERRAL_BOT_NUMBER', 'MATRIX_USER_ID'];
let saved;
beforeEach(() => {
  jest.clearAllMocks();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => { delete process.env[k]; });
});
afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
});

describe('joinInvite — one decision for every class link', () => {
  test('WhatsApp recipient with a bot number: wa.me link that pre-fills the code', () => {
    process.env.WHATSAPP_BOT_NUMBER = '+1 555 010 0000';
    expect(share.joinInvite({ code: 'ABC234', recipient: '15550101234' })).toEqual({
      kind: 'wa', link: 'https://wa.me/15550100000?text=QUIZ-ABC234', bot: botName, code: 'ABC234',
    });
  });

  test('WhatsApp recipient with no bot number: the code, never a dead wa.me link', () => {
    const inv = share.joinInvite({ code: 'ABC234', recipient: '15550101234' });
    expect(inv).toEqual({ kind: 'code', link: null, bot: botName, code: 'ABC234' });
  });

  test('Matrix recipient with the bot account set: matrix.to link plus the code', () => {
    process.env.MATRIX_USER_ID = '@quizbot:example.org';
    process.env.WHATSAPP_BOT_NUMBER = '15550100000';   // must not leak onto Matrix
    for (const recipient of ['matrix:@teacher:example.org', 'mtx:4711']) {
      expect(share.joinInvite({ code: 'ABC234', recipient })).toEqual({
        kind: 'matrix', link: 'https://matrix.to/#/@quizbot:example.org', bot: botName, code: 'ABC234',
      });
    }
  });

  test('Matrix recipient with no bot account: the code only', () => {
    process.env.WHATSAPP_BOT_NUMBER = '15550100000';
    expect(share.joinInvite({ code: 'ABC234', recipient: 'matrix:@teacher:example.org' }))
      .toEqual({ kind: 'code', link: null, bot: botName, code: 'ABC234' });
  });

  test('any other channel (Slack, Discord, an unknown prefix): the code only', () => {
    process.env.WHATSAPP_BOT_NUMBER = '15550100000';
    process.env.MATRIX_USER_ID = '@quizbot:example.org';
    for (const recipient of ['slack:U0123ABC', 'discord:918273645', 'teams:abc']) {
      expect(share.joinInvite({ code: 'ABC234', recipient }).kind).toBe('code');
      expect(share.joinInvite({ code: 'ABC234', recipient }).link).toBeNull();
    }
  });
});

describe('deliverClassLink uses the channel-aware line', () => {
  function memWithTeacher() {
    return createMemorySupabase({
      users: [{ id: 't1', name: 'Teacher Example' }],
      quizzes: [{ id: 'q1', topic: 'Adjectives' }],
      quiz_share_codes: [],
    });
  }
  const sent = () => WhatsAppService.sendMessage.mock.calls.map((c) => c[1]).join('\n---\n');

  test('a teacher on Matrix forwards a matrix.to link and the code, never wa.me', async () => {
    process.env.MATRIX_USER_ID = '@quizbot:example.org';
    process.env.WHATSAPP_BOT_NUMBER = '15550100000';
    supabase.from.mockImplementation(memWithTeacher().from);
    await share.deliverClassLink({ quizId: 'q1', userId: 't1', videoId: null, language: 'en' }, 'matrix:@teacher:example.org');
    const text = sent();
    expect(text).toContain('https://matrix.to/#/@quizbot:example.org');
    expect(text).toMatch(/QUIZ-[A-Z0-9]{6}/);
    expect(text).not.toContain('wa.me');
  });

  test('the class report finds the teacher in the same chat: the share code records it', async () => {
    process.env.MATRIX_USER_ID = '@quizbot:example.org';
    const mem = memWithTeacher();
    supabase.from.mockImplementation(mem.from);
    await share.deliverClassLink({ quizId: 'q1', userId: 't1', videoId: 'v1', language: 'en' }, 'mtx:15550100001');
    const { data: code } = await mem.from('quiz_share_codes').select('teacher_to').eq('teacher_user_id', 't1').maybeSingle();
    expect(code.teacher_to).toBe('mtx:15550100001');
    // Never on the quiz row, which every teacher sent this video shares.
    const { data: quiz } = await mem.from('quizzes').select('meta').eq('id', 'q1').maybeSingle();
    expect((quiz.meta || {}).teacher_to).toBeUndefined();
  });

  test('a WhatsApp teacher with no bot number gets the code to forward, not a dead link', async () => {
    supabase.from.mockImplementation(memWithTeacher().from);
    await share.deliverClassLink({ quizId: 'q1', userId: 't1', videoId: null, language: 'en' }, '15550101234');
    const text = sent();
    expect(text).toMatch(/QUIZ-[A-Z0-9]{6}/);
    expect(text).toContain(botName);
    expect(text).not.toContain('wa.me');
  });

  test('a WhatsApp teacher with a bot number gets the wa.me link (unchanged)', async () => {
    process.env.WHATSAPP_BOT_NUMBER = '15550100000';
    supabase.from.mockImplementation(memWithTeacher().from);
    await share.deliverClassLink({ quizId: 'q1', userId: 't1', videoId: null, language: 'en' }, '15550101234');
    expect(sent()).toMatch(/https:\/\/wa\.me\/15550100000\?text=QUIZ-[A-Z0-9]{6}/);
  });
});

describe('the report promise names the school\'s own quiet hours', () => {
  const mem = () => createMemorySupabase({
    users: [{ id: 't1', name: 'Teacher Example' }],
    quizzes: [{ id: 'q1', topic: 'Adjectives' }],
    quiz_share_codes: [],
  });
  const sent = () => WhatsAppService.sendMessage.mock.calls.map((c) => c[1]).join('\n---\n');
  let savedQuiet;
  beforeEach(() => { savedQuiet = process.env.QUIET_HOURS; });
  afterEach(() => { if (savedQuiet === undefined) delete process.env.QUIET_HOURS; else process.env.QUIET_HOURS = savedQuiet; });

  test('QUIET_HOURS=22-6: the report waits until 6:00, and the teacher is told so', async () => {
    process.env.QUIET_HOURS = '22-6';
    supabase.from.mockImplementation(mem().from);
    await share.deliverClassLink({ quizId: 'q1', userId: 't1', videoId: null, language: 'en' }, '15550101234');
    expect(sent()).toMatch(/at 6:00 if that falls at night/);
    expect(sent()).not.toMatch(/7 ?am/i);
  });

  test('QUIET_HOURS=off: no night-time promise at all', async () => {
    process.env.QUIET_HOURS = 'off';
    supabase.from.mockImplementation(mem().from);
    await share.deliverClassLink({ quizId: 'q1', userId: 't1', videoId: null, language: 'en' }, '15550101234');
    expect(sent()).toMatch(/about 12 hours after the first student starts/);
    expect(sent()).not.toMatch(/at night/);
  });
});
