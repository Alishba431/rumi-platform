/**
 * testpaper-session — where a teacher is in the /testpaper conversation.
 *
 * Redis-backed so a redeploy mid-conversation does not lose the place, with
 * an in-memory fallback, the same convention as pending-options.js. Redis is
 * mocked at the cache service.
 */

let Session;
let store;
let redisUp;

beforeEach(() => {
  jest.resetModules();
  store = new Map();
  redisUp = true;
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => ({
    set: jest.fn(async (k, v, ttl) => { if (!redisUp) return false; store.set(k, { v, ttl }); return true; }),
    get: jest.fn(async (k) => (redisUp && store.has(k) ? JSON.parse(store.get(k).v) : null)),
    delete: jest.fn(async (k) => { store.delete(k); return true; }),
  }));
  Session = require('../../bot/shared/services/testpaper/testpaper-session.service');
  Session._resetForTests();
});

it('saves and reads a state per teacher, with a TTL', async () => {
  await Session.save('u1', { step: 'pick_chapters', textbookId: 'tb-1' });
  expect(await Session.get('u1')).toMatchObject({ step: 'pick_chapters', textbookId: 'tb-1' });
  expect(await Session.get('u2')).toBeNull();
  expect([...store.values()][0].ttl).toBe(Session.TTL_SECONDS);
});

it('survives Redis being down, in memory', async () => {
  redisUp = false;
  await Session.save('u1', { step: 'pick_mix' });
  expect(await Session.get('u1')).toMatchObject({ step: 'pick_mix' });
});

it('clear forgets the state everywhere', async () => {
  await Session.save('u1', { step: 'pick_mix' });
  await Session.clear('u1');
  expect(await Session.get('u1')).toBeNull();
});

it('update merges into the current state', async () => {
  await Session.save('u1', { step: 'pick_mix', source: { kind: 'textbook' } });
  await Session.update('u1', { step: 'pick_language', mix: 'quick' });
  expect(await Session.get('u1')).toMatchObject({ step: 'pick_language', mix: 'quick', source: { kind: 'textbook' } });
});
