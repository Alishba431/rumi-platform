'use strict';
/**
 * Share-code guessing.
 *
 * A code is 6 characters from a 30-letter alphabet, and a hit files a child
 * into another class's report. So wrong codes are counted per sender in Redis:
 * after JOIN_GUESS_LIMIT misses inside the window the sender is answered with
 * silence — no lookup, no reply — until the window passes. Codes are drawn
 * from crypto.randomInt, not Math.random.
 *
 * Driven through the real beginFromCode / Invite.resolveInvite on an in-memory
 * database; only Redis and the send are stand-ins.
 */

const crypto = require('crypto');

jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
const mockKv = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async (k) => (mockKv.has(k) ? mockKv.get(k) : null)),
  set: jest.fn(async (k, v) => { mockKv.set(k, v); return true; }),
  setNX: jest.fn(async (k, v) => { if (mockKv.has(k)) return false; mockKv.set(k, v); return true; }),
  delete: jest.fn(async (k) => { mockKv.delete(k); return true; }),
  incr: jest.fn(async (k) => { const n = Number(mockKv.get(k) || 0) + 1; mockKv.set(k, n); return n; }),
  expire: jest.fn(async () => true),
  isAvailable: () => true,
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const redisService = require('../../bot/shared/services/cache/railway-redis.service');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const share = require('../../bot/shared/services/quiz/video-quiz-share.service');
const { createMemorySupabase } = require('./helpers/memory-supabase');

const CHILD = '15550100071';
const OTHER = '15550100072';
const WRONG = ['ABCDEF', 'BCDEFG', 'CDEFGH', 'DEFGHJ', 'EFGHJK', 'FGHJKL', 'GHJKLM'];

function memDb() {
  return createMemorySupabase({
    users: [{ id: 't1', name: 'Teacher Example', phone_number: '15550100001' }],
    quizzes: [{ id: 'q1', topic: 'Magnets', video_id: null, quiz_source: 'transcript', teacher_id: 't1', meta: {} }],
    quiz_share_codes: [],
    students: [],
    quiz_sessions: [],
  }, { defaults: { quiz_share_codes: { active: true, report_sent_at: null, uses_count: 0 } } });
}

const shareCodeReads = () => supabase.from.mock.calls.filter((c) => c[0] === 'quiz_share_codes').length;

beforeEach(() => { jest.clearAllMocks(); mockKv.clear(); });

describe('wrong share codes are limited per sender', () => {
  test('the 6th wrong code inside the window gets no lookup and no reply', async () => {
    const mem = memDb();
    supabase.from.mockImplementation(mem.from);
    for (const code of WRONG.slice(0, 5)) {
      expect(await share.beginFromCode(CHILD, code)).toBe(true);
    }
    expect(shareCodeReads()).toBe(5);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(5);   // "that code has expired"
    // The miss counter expires with the window.
    expect(redisService.expire).toHaveBeenCalledWith(expect.stringContaining(CHILD), share.JOIN_GUESS_WINDOW_SECS);

    jest.clearAllMocks();
    expect(await share.beginFromCode(CHILD, WRONG[5])).toBe(true);   // ours, and silent
    expect(shareCodeReads()).toBe(0);
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
  });

  test('a real code is also refused while the sender is held, and another sender is not affected', async () => {
    const mem = memDb();
    supabase.from.mockImplementation(mem.from);
    const minted = await share.mintCode({ quizId: 'q1', userId: 't1', videoId: null, language: 'en' });
    for (const code of WRONG.slice(0, 5)) await share.beginFromCode(CHILD, code);

    jest.clearAllMocks();
    await share.beginFromCode(CHILD, minted.code);
    expect(shareCodeReads()).toBe(0);
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();

    // A different child's first wrong code is still looked up and answered.
    await share.beginFromCode(OTHER, WRONG[6]);
    expect(shareCodeReads()).toBe(1);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('a right code does not count as a miss', async () => {
    const mem = memDb();
    supabase.from.mockImplementation(mem.from);
    await share.mintCode({ quizId: 'q1', userId: 't1', videoId: null, language: 'en' });
    const { code } = mem.table('quiz_share_codes')[0];
    // What follows a right code (name and class) is not under test here.
    await share.beginFromCode(CHILD, code).catch(() => {});
    expect(redisService.incr).not.toHaveBeenCalled();
  });
});

describe('codes come from crypto', () => {
  test('mintCode draws every character with crypto.randomInt, never Math.random', async () => {
    const mem = memDb();
    supabase.from.mockImplementation(mem.from);
    const ri = jest.spyOn(crypto, 'randomInt');
    const mr = jest.spyOn(Math, 'random');
    try {
      const minted = await share.mintCode({ quizId: 'q1', userId: 't1', videoId: null, language: 'en' });
      expect(minted.code).toMatch(/^[ABCDEFGHJKLMNPQRTUVWXYZ2346789]{6}$/);
      expect(ri).toHaveBeenCalledTimes(6);
      expect(mr).not.toHaveBeenCalled();
    } finally {
      ri.mockRestore();
      mr.mockRestore();
    }
  });
});
