/**
 * The menu never dead-ends a coach.
 *
 * The pending lists belong to the debrief step. When that module is absent (a
 * deployment, or a branch, without it) or a lookup throws, the coach still gets
 * the menu — just without pending rows. And if the menu itself fails, /observe
 * falls back to the capture prompt: the recording is the product.
 *
 * observe-debrief.service is deliberately NOT mocked here.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockDb = createFakeSupabase({
  users: [{ id: 'coach-1', role: 'coach', preferred_language: 'en', preferences: { observe_onboarded: true } }],
  leader_schools: [{ id: 'ls-1', leader_user_id: 'coach-1', school_id: 'school-1', school_ext_id: 'SCH-1', school_name: 'Hill School' }],
  observation_schedules: [],
  coaching_sessions: [],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const mockRedis = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  setexWithCeiling: jest.fn(async (k, ttl, v) => { mockRedis.set(k, v); return true; }),
  get: jest.fn(async (k) => (mockRedis.has(k) ? JSON.parse(mockRedis.get(k)) : null)),
  delete: jest.fn(async (k) => mockRedis.delete(k)),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
}));

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const Menu = require('../../bot/shared/services/observe/observe-menu.service');
const { handleObserveCommand } = require('../../bot/shared/handlers/observe-command.handler');

const coach = () => mockDb.tables.users[0];

describe('menu degradation', () => {
  beforeEach(() => { jest.clearAllMocks(); mockRedis.clear(); process.env.OBSERVE_ENABLED = 'true'; });

  test('no debrief step available: pending is empty and the menu still opens', async () => {
    expect(await Menu.loadPending('coach-1')).toEqual([]);
    expect(await handleObserveCommand(coach(), '15550100001', '/observe')).toBe(true);
    const rows = WhatsAppService.sendInteractiveMessage.mock.calls[0][1].action.sections.flatMap((s) => s.rows);
    expect(rows.map((r) => r.id)).toEqual(['observe_menu_new', 'observe_menu_sched', 'observe_menu_plan']);
  });

  test('the menu failing falls back to the capture prompt', async () => {
    WhatsAppService.sendInteractiveMessage.mockRejectedValueOnce(new Error('channel down'));
    expect(await handleObserveCommand(coach(), '15550100001', '/observe')).toBe(true);
    expect(WhatsAppService.sendMessage.mock.calls.pop()[1]).toMatch(/record the lesson on your phone/);
  });
});
