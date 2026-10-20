'use strict';
/**
 * The daily cap counts per SCHOOL day (SCHOOL_TIMEZONE), not per server or UTC
 * day: a teacher's evening and the next morning are two school days even when
 * they share a UTC date. Redis (the network boundary) is mocked at the raw
 * client — the OSS cache service has no script helper of its own, so the cap
 * runs its one Lua call on the service's ioredis client.
 */

const mockEval = jest.fn();
const mockRedis = { available: true };
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  isAvailable: () => mockRedis.available,
  redis: { eval: (...a) => mockEval(...a) },
}));

const DailyCap = require('../../bot/shared/services/quiz/quiz-daily-cap');

const saved = {};
beforeEach(() => {
  mockEval.mockReset();
  mockRedis.available = true;
  for (const k of ['SCHOOL_TIMEZONE', 'QUIZ_DAILY_CAP']) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const keyOf = (call) => call[2];

test('two instants on one UTC date but two school dates land in two cap buckets', async () => {
  process.env.SCHOOL_TIMEZONE = 'Asia/Tokyo';             // UTC+9
  mockEval.mockResolvedValue(1);
  const evening = new Date('2026-03-04T10:00:00Z');       // 19:00 on 4 Mar in school time
  const night = new Date('2026-03-04T16:00:00Z');         // 01:00 on 5 Mar in school time
  await DailyCap.claim('t-1', 'q-1', { now: evening });
  await DailyCap.claim('t-1', 'q-2', { now: night });
  expect(keyOf(mockEval.mock.calls[0])).toBe('quizcap:t-1:2026-03-04');
  expect(keyOf(mockEval.mock.calls[1])).toBe('quizcap:t-1:2026-03-05');
});

test('with no SCHOOL_TIMEZONE the school day is the UTC day', async () => {
  mockEval.mockResolvedValue(1);
  await DailyCap.claim('t-1', 'q-1', { now: new Date('2026-03-04T23:30:00Z') });
  expect(keyOf(mockEval.mock.calls[0])).toBe('quizcap:t-1:2026-03-04');
  expect(DailyCap.schoolDate(new Date('2026-03-04T23:30:00Z'))).toBe('2026-03-04');
});

test('the Lua call carries the quiz id, the cap and the ttl; a negative reply refuses', async () => {
  mockEval.mockResolvedValueOnce(-10);
  const r = await DailyCap.claim('t-1', 'q-11', { now: new Date('2026-03-04T08:00:00Z') });
  expect(r).toEqual({ allowed: false, count: 10, limit: 10 });
  const [script, nKeys, , quizId, cap] = mockEval.mock.calls[0];
  expect(script).toBe(DailyCap.CLAIM_LUA);
  expect(nKeys).toBe(1);
  expect(quizId).toBe('q-11');
  expect(cap).toBe(10);
});

test('Redis unavailable or erroring fails open', async () => {
  mockRedis.available = false;
  expect(await DailyCap.claim('t-1', 'q-1')).toEqual(expect.objectContaining({ allowed: true, degraded: true }));
  mockRedis.available = true;
  mockEval.mockRejectedValueOnce(new Error('NOSCRIPT'));
  expect(await DailyCap.claim('t-1', 'q-1')).toEqual(expect.objectContaining({ allowed: true, degraded: true }));
});
