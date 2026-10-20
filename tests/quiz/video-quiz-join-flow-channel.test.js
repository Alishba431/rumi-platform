'use strict';
/**
 * The name-and-class join Flow is an optional extra on the Meta driver.
 *
 * A child who opens a class link and is new to the bot is asked their name and
 * class. On Meta, with STUDENT_JOIN_FLOW_ID published, an English quiz opens the
 * one-screen Flow; everywhere else — Baileys, Matrix, any other language, no
 * asset — the child is asked in chat. A Flow is never attempted where the
 * channel cannot draw one.
 */

jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async () => null), set: jest.fn().mockResolvedValue(true), delete: jest.fn(),
  setNX: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendFlow: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));
jest.mock('../../bot/shared/services/region-features.service', () => ({
  isVideoQuizzesEnabled: jest.fn().mockResolvedValue(true),
}));

const { createMemorySupabase } = require('./helpers/memory-supabase');
const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const share = require('../../bot/shared/services/quiz/video-quiz-share.service');

const ENV = ['STUDENT_JOIN_FLOW_ID', 'CHANNEL_DRIVER'];
let saved;
const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.STUDENT_JOIN_FLOW_ID = 'flow-join-example';
  const mem = createMemorySupabase({
    quiz_share_codes: [{
      id: 'sc-1', code: 'LESSN2', quiz_id: 'q-1', video_id: null, teacher_user_id: 't1',
      teacher_name: 'Teacher Example', topic: 'Fractions', language: 'en', active: true, expires_at: future,
    }],
    users: [{ id: 't1', phone_number: '15550109999', name: 'Teacher Example' }],
    students: [],
  });
  supabase.from.mockImplementation(mem.from);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('Meta, English quiz, asset published: the Flow opens', async () => {
  process.env.CHANNEL_DRIVER = 'meta';
  expect(await share.beginFromCode('15550100001', 'LESSN2')).toBe(true);
  expect(WhatsAppService.sendFlow).toHaveBeenCalledWith('15550100001', expect.objectContaining({ flowId: 'flow-join-example' }));
});

test.each([
  ['a Baileys deployment', 'baileys', '15550100001'],
  ['a Matrix child', 'meta', 'matrix:@child:example.org'],
])('%s is asked in chat, never sent a Flow', async (_, driver, recipient) => {
  process.env.CHANNEL_DRIVER = driver;
  expect(await share.beginFromCode(recipient, 'LESSN2')).toBe(true);
  expect(WhatsAppService.sendFlow).not.toHaveBeenCalled();
  expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(recipient, expect.stringContaining('Fractions'));
});
