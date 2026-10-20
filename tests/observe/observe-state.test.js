/**
 * observe-state: one Redis key per coach holding where their observation is
 * (awaiting_audio → awaiting_form → awaiting_debrief_audio …), 2h TTL.
 */

jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  setexWithCeiling: jest.fn(async () => true),
  get: jest.fn(),
  delete: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const redis = require('../../bot/shared/services/cache/railway-redis.service');
const ObserveState = require('../../bot/shared/services/observe/observe-state.service');

describe('observe-state', () => {
  beforeEach(() => jest.clearAllMocks());

  test('setState writes JSON under observe:state:<userId> with a 2h TTL', async () => {
    await ObserveState.setState('u1', 'awaiting_audio', { boundTeacher: { teacher_name: 'Sam' } });
    const [key, ttl, payload] = redis.setexWithCeiling.mock.calls[0];
    expect(key).toBe('observe:state:u1');
    expect(ttl).toBe(7200);
    expect(JSON.parse(payload)).toMatchObject({ state: 'awaiting_audio', boundTeacher: { teacher_name: 'Sam' } });
  });

  test('getState accepts both the auto-parsed object and a raw JSON string', async () => {
    redis.get.mockResolvedValueOnce({ state: 'awaiting_form', sessionId: 's1' });
    expect(await ObserveState.getState('u1')).toEqual({ state: 'awaiting_form', sessionId: 's1' });
    redis.get.mockResolvedValueOnce('{"state":"awaiting_audio"}');
    expect(await ObserveState.getState('u1')).toEqual({ state: 'awaiting_audio' });
  });

  test('getState treats unreadable state as none instead of throwing', async () => {
    redis.get.mockResolvedValueOnce('{not json');
    expect(await ObserveState.getState('u1')).toBeNull();
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    expect(await ObserveState.getState('u1')).toBeNull();
  });

  test('clearState deletes the key', async () => {
    await ObserveState.clearState('u1');
    expect(redis.delete).toHaveBeenCalledWith('observe:state:u1');
  });
});
