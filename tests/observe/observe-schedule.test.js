/**
 * The coach's schedule store, and the optional calendar invite on top of it.
 *
 * One upcoming visit per (coach, school, teacher): scheduling again moves it.
 * The calendar is a courtesy — OFF by default, and an outage (the HTTP call
 * is the network boundary, faked here) never blocks a save, a move or a cancel.
 */

const crypto = require('crypto');
const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockDb = createFakeSupabase({
  observation_schedules: [],
  coach_directory: [{ id: 'cd-1', leader_user_id: 'coach-1', full_name: 'Coach One', work_email: 'coach.one@example.org' }],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const Schedule = require('../../bot/shared/services/observe/observe-schedule.service');
const google = require('../../bot/shared/services/observe/google-calendar.client');
const Calendar = require('../../bot/shared/services/observe/observe-calendar.service');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const KEY_JSON = JSON.stringify({
  client_email: 'svc@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

const VISIT = (over = {}) => ({
  school_ext_id: 'SCH-1', school_id: 'school-1', teacher_ext_id: 't-1', teacher_name: 'Sam Taylor', school_name: 'Hill School', date: '2026-10-05', ...over,
});

function calendarOn() {
  process.env.OBSERVE_CALENDAR_ENABLED = 'true';
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = KEY_JSON;
  process.env.GOOGLE_CALENDAR_ID = 'visits@example.org';
}

function okFetch() {
  return jest.fn(async (url, init) => {
    if (String(url).includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (init.method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ id: 'evt-1' }) };
  });
}

describe('observe schedule store', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    mockDb.tables.observation_schedules.length = 0;
    delete process.env.OBSERVE_CALENDAR_ENABLED;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_CALENDAR_ID;
    delete process.env.GOOGLE_CALENDAR_SUBJECT;
    google._resetTokenCache();
    global.fetch = jest.fn(async () => { throw new Error('fetch must not be called'); });
  });
  afterAll(() => { global.fetch = realFetch; });

  test('save creates ONE upcoming visit; saving again moves it rather than adding a second', async () => {
    const first = await Schedule.saveSchedule('coach-1', VISIT());
    expect(first).toMatchObject({ status: 'upcoming', scheduled_for: '2026-10-05', school_id: 'school-1' });
    const moved = await Schedule.saveSchedule('coach-1', VISIT({ date: '2026-10-07' }));
    expect(moved.id).toBe(first.id);
    const upcoming = mockDb.tables.observation_schedules.filter((r) => r.status === 'upcoming');
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].scheduled_for).toBe('2026-10-07');
  });

  test('a malformed or rolled-over date is refused', async () => {
    await expect(Schedule.saveSchedule('coach-1', VISIT({ date: '2026-13-45' }))).rejects.toThrow(/invalid date/);
    await expect(Schedule.saveSchedule('coach-1', VISIT({ date: '5 Oct' }))).rejects.toThrow(/invalid date/);
    expect(Schedule.isValidDate('2026-02-29')).toBe(false);
    expect(Schedule.isValidDate('2028-02-29')).toBe(true);
  });

  test('listUpcoming is ascending, overdue first and flagged; only this coach, only upcoming', async () => {
    await Schedule.saveSchedule('coach-1', VISIT({ teacher_ext_id: 't-2', date: '2026-10-09' }));
    await Schedule.saveSchedule('coach-1', VISIT({ teacher_ext_id: 't-1', date: '2026-09-28' }));
    await Schedule.saveSchedule('coach-2', VISIT({ date: '2026-09-01' }));
    mockDb.tables.observation_schedules.push({ id: 'done-1', leader_user_id: 'coach-1', school_ext_id: 'SCH-1', teacher_ext_id: 't-9', scheduled_for: '2026-09-01', status: 'done' });
    const rows = await Schedule.listUpcoming('coach-1', { today: '2026-10-02' });
    expect(rows.map((r) => [r.teacher_ext_id, r.overdue])).toEqual([['t-1', true], ['t-2', false]]);
    expect(await Schedule.countUpcoming('coach-1')).toBe(2);
  });

  test('cancel and reschedule are scoped to the coach and to upcoming rows', async () => {
    const row = await Schedule.saveSchedule('coach-1', VISIT());
    expect(await Schedule.cancelById('coach-2', row.id)).toBe(false);
    expect(await Schedule.rescheduleById('coach-1', row.id, '2026-10-12')).toBe(true);
    expect((await Schedule.getUpcoming('coach-1', row.id)).scheduled_for).toBe('2026-10-12');
    expect(await Schedule.cancelById('coach-1', row.id)).toBe(true);
    expect(await Schedule.getUpcoming('coach-1', row.id)).toBeNull();
    expect(await Schedule.cancelById('coach-1', row.id)).toBe(false);   // second cancel is a no-op
    await expect(Schedule.rescheduleById('coach-1', row.id, 'soon')).rejects.toThrow(/invalid date/);
  });

  test('calendar OFF by default: no network call at all', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = KEY_JSON;
    process.env.GOOGLE_CALENDAR_ID = 'visits@example.org';
    await Schedule.saveSchedule('coach-1', VISIT());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('calendar ON: the coach is invited, the event id is kept, a move patches it, a cancel removes it', async () => {
    calendarOn();
    global.fetch = okFetch();
    const row = await Schedule.saveSchedule('coach-1', VISIT({ slot: '09:00' }));
    const insert = global.fetch.mock.calls.find(([u, i]) => i.method === 'POST' && String(u).includes('/events'));
    const event = JSON.parse(insert[1].body);
    expect(event.attendees).toEqual([{ email: 'coach.one@example.org' }]);
    expect(event.summary).toMatch(/Sam Taylor/);
    expect(event.start).toEqual({ dateTime: '2026-10-05T09:00:00', timeZone: 'UTC' });
    expect(mockDb.tables.observation_schedules.find((r) => r.id === row.id).calendar_event_id).toBe('evt-1');

    expect(await Schedule.rescheduleById('coach-1', row.id, '2026-10-06')).toBe(true);
    expect(global.fetch.mock.calls.some(([u, i]) => i.method === 'PATCH' && String(u).includes('/events/evt-1'))).toBe(true);

    expect(await Schedule.cancelById('coach-1', row.id)).toBe(true);
    expect(global.fetch.mock.calls.some(([u, i]) => i.method === 'DELETE' && String(u).includes('/events/evt-1'))).toBe(true);
    expect(mockDb.tables.observation_schedules.find((r) => r.id === row.id).calendar_event_id).toBeNull();
  });

  test('a day with no slot is booked as an all-day entry, never an invented time', () => {
    const event = Calendar._buildEvent({ teacher_name: 'Sam', school_name: '', scheduled_for: '2026-10-05' }, 'c@example.org');
    expect(event.start).toEqual({ date: '2026-10-05' });
    expect(event.summary).toBe('Observation: Sam');
  });

  test('a calendar OUTAGE never blocks scheduling', async () => {
    calendarOn();
    global.fetch = jest.fn(async () => { throw new Error('ECONNRESET'); });
    const row = await Schedule.saveSchedule('coach-1', VISIT());
    expect(row).toMatchObject({ status: 'upcoming' });
    expect(global.fetch).toHaveBeenCalled();
    expect(await Schedule.rescheduleById('coach-1', row.id, '2026-10-08')).toBe(true);
    expect(await Schedule.cancelById('coach-1', row.id)).toBe(true);
  });

  test('a coach with no directory row gets no invite, silently', async () => {
    calendarOn();
    global.fetch = okFetch();
    await Schedule.saveSchedule('coach-2', VISIT());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('the comma form turns the invite on for named coaches only', () => {
    process.env.OBSERVE_CALENDAR_ENABLED = 'coach-1, coach-3';
    expect(Calendar._enabledFor('coach-1')).toBe(true);
    expect(Calendar._enabledFor('coach-2')).toBe(false);
    process.env.OBSERVE_CALENDAR_ENABLED = 'false';
    expect(Calendar._enabledFor('coach-1')).toBe(false);
  });
});
