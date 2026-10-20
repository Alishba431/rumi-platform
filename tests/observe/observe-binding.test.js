/**
 * Multi-flight binding: whose recording is this?
 *
 * A coach's classroom-length recording with nothing armed is PARKED (a FIFO in
 * one Redis key, 6h) and the coach is asked one question. Scheduled teachers
 * come first, then the roster; "another teacher" opens the picker; "this is a
 * debrief" only when a debrief is waiting; "my own lesson" only for leaders
 * who also teach; "not an observation" drops it. The OLDEST parked recording
 * binds first and the question re-asks for the next. A double tap or an
 * identical re-send never creates a second session.
 *
 * Runs the real router → binding → capture against the fakes.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', preferred_language: 'en', phone_number: '15550100001' },
    { id: 'head-1', role: 'principal', preferred_language: 'en', phone_number: '15550100009' },
    { id: 't-a', name: 'Avery Stone', phone_number: '15550100201', school_id: 'school-1', role: 'teacher' },
    { id: 't-b', name: 'Blake Reed', phone_number: '15550100202', school_id: 'school-1', role: 'teacher' },
    { id: 't-c', name: 'Casey Park', phone_number: '15550100203', school_id: 'school-1', role: 'teacher' },
  ],
  leader_schools: [{ id: 'ls-1', leader_user_id: 'coach-1', school_id: 'school-1', school_ext_id: 'SCH-1', school_name: 'Hill School' }],
  observation_schedules: [],
  coaching_sessions: [],
  chat_sessions: [],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const mockRedis = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  setexWithCeiling: jest.fn(async (k, ttl, v) => { mockRedis.set(k, { v, ttl }); return true; }),
  get: jest.fn(async (k) => { if (!mockRedis.has(k)) return null; const { v } = mockRedis.get(k); try { return JSON.parse(v); } catch (_) { return v; } }),
  setNX: jest.fn(async (k, v, ttl) => { if (mockRedis.has(k)) return false; mockRedis.set(k, { v, ttl }); return true; }),
  delete: jest.fn(async (k) => mockRedis.delete(k)),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
  getMediaInfo: jest.fn(async () => ({ file_size: 100 })),
  downloadMedia: jest.fn(async () => Buffer.from('x')),
}));
jest.mock('../../bot/shared/services/coaching/coaching-job-queue.service', () => ({ queueTranscription: jest.fn(async () => true) }));
const mockCoaching = { initiateCoachingSession: jest.fn(async () => true) };
jest.mock('../../bot/shared/services/coaching-orchestrator.service', () => mockCoaching);
const mockPending = { debriefs: [] };
const mockDebrief = {
  listPendingDebriefs: jest.fn(async () => mockPending.debriefs),
  startDebriefFromAudio: jest.fn(async () => true),
};
jest.mock('../../bot/shared/services/observe/observe-debrief.service', () => mockDebrief);

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const Debrief = mockDebrief;
const { routeLeaderAudio } = require('../../bot/shared/services/observe/observe-audio-router');
const { handleObserveInteractive } = require('../../bot/shared/handlers/observe-interactive.handler');

const FROM = '15550100001';
const user = (id = 'coach-1') => mockDb.tables.users.find((u) => u.id === id);
const send = (audioId, over = {}) => routeLeaderAudio({
  user: user(over.userId), from: FROM, audioId, sessionId: 'chat-1', durationSeconds: 1800, sha256: over.sha256 || `sha-${audioId}`, mimeType: 'audio/ogg',
});
const lastList = () => {
  const calls = WhatsAppService.sendInteractiveMessage.mock.calls;
  return calls.length ? calls[calls.length - 1][1] : null;
};
const rows = (p = lastList()) => p.action.sections.flatMap((s) => s.rows);
const rowFor = (re, p) => rows(p).find((r) => re.test(r.title));
const texts = () => WhatsAppService.sendMessage.mock.calls.map((c) => c[1]);
const tap = (id, u = user()) => handleObserveInteractive(u, FROM, id);
const parked = () => {
  const e = mockRedis.get('observe:parked:coach-1');
  return e ? JSON.parse(e.v) : [];
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.clear();
  mockPending.debriefs = [];
  mockDb.tables.coaching_sessions.length = 0;
  mockDb.tables.observation_schedules.length = 0;
  process.env.OBSERVE_ENABLED = 'true';
});

describe('parking an unbound recording', () => {
  test('classroom-length audio with nothing armed is parked (6h) and the coach is asked whose it is', async () => {
    expect(await send('m-1')).toBe(true);
    expect(parked()).toEqual([expect.objectContaining({ audioId: 'm-1', sha256: 'sha-m-1', durationSeconds: 1800, mimeType: 'audio/ogg', sessionId: 'chat-1' })]);
    expect(mockRedis.get('observe:parked:coach-1').ttl).toBe(6 * 3600);
    const payload = lastList();
    expect(payload.body).toMatch(/Whose observation is this/);
    const titles = rows(payload).map((r) => r.title);
    expect(titles).toEqual(['Avery Stone', 'Blake Reed', 'Casey Park', 'Another teacher', 'Not an observation']);
    for (const r of rows(payload)) { expect(r.id).toMatch(/^observe_bind_/); expect(r.title.length).toBeLessThanOrEqual(24); }
    expect(mockDb.tables.coaching_sessions).toHaveLength(0);
  });

  test('scheduled teachers come first; "this is a debrief" only when one is waiting; "my own lesson" only for a leader who teaches', async () => {
    mockDb.tables.observation_schedules.push({ id: 'v-1', leader_user_id: 'coach-1', school_ext_id: 'SCH-1', teacher_ext_id: 't-c', teacher_name: 'Casey Park', school_name: 'Hill School', scheduled_for: '2026-10-02', status: 'upcoming' });
    mockPending.debriefs = [{ id: 'obs-old', created_at: '2026-09-30T10:00:00Z', teacher_name: 'Blake Reed' }];
    await send('m-1');
    const titles = rows().map((r) => r.title);
    expect(titles[0]).toBe('📋 Casey Park');
    expect(titles.filter((x) => /Casey Park/.test(x))).toHaveLength(1);
    expect(titles).toContain('🎙 This is a debrief');
    expect(titles).not.toContain('My own lesson');

    jest.clearAllMocks();
    await routeLeaderAudio({ user: user('head-1'), from: '15550100009', audioId: 'm-h', sessionId: 'chat-9', durationSeconds: 1800 });
    expect(rows().map((r) => r.title)).toContain('My own lesson');
  });

  test('TWO recordings before binding → two distinct sessions, the right teacher on each, oldest first', async () => {
    await send('m-1');
    await send('m-2');
    expect(parked().map((p) => p.audioId)).toEqual(['m-1', 'm-2']);

    await tap(rowFor(/Avery Stone/).id);
    expect(parked().map((p) => p.audioId)).toEqual(['m-2']);
    expect(texts().some((s) => /Attached to Avery Stone's observation/.test(s))).toBe(true);
    // re-asked for the next one, with the next recording's own ids
    const second = lastList();
    await tap(rowFor(/Blake Reed/, second).id);
    expect(parked()).toEqual([]);

    const sessions = mockDb.tables.coaching_sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => [s.audio_id, s.user_id, s.observer_user_id])).toEqual([
      ['m-1', 't-a', 'coach-1'], ['m-2', 't-b', 'coach-1'],
    ]);
    expect(sessions[0].id).not.toBe(sessions[1].id);
  });

  test('a double tap (or a webhook retry) creates exactly one session — never binds the next recording', async () => {
    await send('m-1');
    await send('m-2');
    // The second recording is queued behind the open question, not asked twice.
    expect(WhatsAppService.sendInteractiveMessage).toHaveBeenCalledTimes(1);
    expect(texts().pop()).toMatch(/answer the question above first/i);
    const first = rowFor(/Avery Stone/).id;
    await tap(first);
    await tap(first);
    expect(mockDb.tables.coaching_sessions).toHaveLength(1);
    expect(parked().map((p) => p.audioId)).toEqual(['m-2']);
    expect(texts().some((s) => /already have this recording/.test(s))).toBe(true);
    // the re-ask for m-2 carries its own ids
    expect(rowFor(/Avery Stone/).id).not.toBe(first);
  });

  test('an identical re-send is answered "already got this one" — parked or already bound', async () => {
    await send('m-1');
    await send('m-1');   // same media id while parked (webhook retry)
    expect(parked()).toHaveLength(1);
    await tap(rowFor(/Avery Stone/).id);
    jest.clearAllMocks();
    await send('m-9', { sha256: 'sha-m-1' });   // same bytes, new upload
    expect(texts()[0]).toMatch(/already have this recording \(Avery Stone\)/);
    expect(parked()).toEqual([]);
    expect(mockDb.tables.coaching_sessions).toHaveLength(1);
  });

  test('"Another teacher" opens the picker; the teacher picked there gets the parked recording', async () => {
    await send('m-1');
    await tap(rowFor(/Another teacher/).id);
    // one school → straight to its teachers
    const picker = lastList();
    expect(rows(picker).map((r) => r.id)).toContain('observe_vt_b_t-c');
    await tap('observe_vt_b_t-c');
    expect(mockDb.tables.coaching_sessions).toEqual([expect.objectContaining({ audio_id: 'm-1', user_id: 't-c' })]);
    expect(parked()).toEqual([]);
  });

  test('"Not listed" in that picker captures it unbound (and the coach is asked who it was)', async () => {
    await send('m-1');
    await tap(rowFor(/Another teacher/).id);
    await tap('observe_vskip');
    expect(mockDb.tables.coaching_sessions).toEqual([expect.objectContaining({ audio_id: 'm-1', user_id: 'coach-1' })]);
  });

  test('"This is a debrief" → pick the observation → handed to the debrief step with the parked media', async () => {
    mockPending.debriefs = [{ id: 'obs-old', created_at: '2026-09-30T10:00:00Z', teacher_name: 'Blake Reed' }];
    await send('m-1');
    await tap(rowFor(/This is a debrief/).id);
    const pick = rows()[0];
    expect(pick.title).toMatch(/Blake Reed/);
    await tap(pick.id);
    expect(Debrief.startDebriefFromAudio).toHaveBeenCalledWith(
      user(), FROM, 'm-1', { state: 'awaiting_debrief_audio', sessionId: 'obs-old' }, { mimeType: 'audio/ogg' },
    );
    expect(parked()).toEqual([]);
    expect(mockDb.tables.coaching_sessions).toHaveLength(0);
  });

  test('"My own lesson" hands it to the leader\'s own coaching; "Not an observation" drops it', async () => {
    await routeLeaderAudio({ user: user('head-1'), from: FROM, audioId: 'm-h', sessionId: 'chat-9', durationSeconds: 1800 });
    await tap(rowFor(/My own lesson/).id, user('head-1'));
    expect(mockCoaching.initiateCoachingSession).toHaveBeenCalledWith('head-1', 'chat-9', 'm-h', FROM, 1800);

    await send('m-1');
    await tap(rowFor(/Not an observation/).id);
    expect(parked()).toEqual([]);
    expect(texts().pop()).toMatch(/carry on as normal/);
    expect(mockDb.tables.coaching_sessions).toHaveLength(0);
  });

  test('a tap after the park expired says so plainly', async () => {
    await send('m-1');
    const id = rowFor(/Avery Stone/).id;
    mockRedis.delete('observe:parked:coach-1');
    await tap(id);
    expect(texts().pop()).toMatch(/no longer held/);
    expect(mockDb.tables.coaching_sessions).toHaveLength(0);
  });

  test('the park holds a few recordings, then asks the coach to answer first', async () => {
    for (let i = 1; i <= 6; i += 1) await send(`m-${i}`);
    expect(parked()).toHaveLength(5);
    expect(texts().pop()).toMatch(/Answer the question above first/);
  });
});
