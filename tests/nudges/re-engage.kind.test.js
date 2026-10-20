'use strict';
/**
 * The `re_engage` nudge kind — "a teacher who went quiet" — driven end to end
 * through the REAL sweeper, store, kind and address lookup over a stateful
 * in-memory Supabase. Only the two network boundaries are mocked: the database
 * client and the messaging facade's `sendMessage`.
 *
 * The rules under test:
 *   cohort        registered teachers whose last message is older than
 *                 TEACHER_NUDGES_QUIET_MINUTES (default 20 h) and newer than the
 *                 lookback (default 14 days).
 *   once a spell  at most one row per teacher per local day, and never a second
 *                 nudge for the same quiet spell: a sent nudge remembers the
 *                 last_message_at it was about; until the teacher writes again
 *                 that value is unchanged and nobody is nudged twice.
 *   24-hour rule  on the Meta WhatsApp Cloud driver a free-form message is only
 *                 allowed inside the 24-hour customer-service window, so outside
 *                 it the row is skipped `window_closed` (no template). Other
 *                 drivers have no such rule.
 *   quiet hours   nothing is booked at night, and a row reached at night is
 *                 skipped `quiet_hours`.
 *   honest fails  a send that returns false is `failed`, never `sent`.
 */

// Mocked at the client library (the network boundary): the real config/supabase.js loads and
// exports this in-memory client.
jest.mock('@supabase/supabase-js', () => {
  const { createMemorySupabase } = require('../fixtures/memory-supabase');
  const memory = createMemorySupabase({}, { unique: { teacher_nudges: ['user_id', 'nudge_date', 'kind'] } });
  return { createClient: () => memory };
});
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn() }));

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-03-10T10:00:00.000Z'); // 10:00 local (UTC default)
const hoursBefore = (h, from = NOW) => new Date(from.getTime() - h * HOUR).toISOString();
const later = (h) => new Date(NOW.getTime() + h * HOUR);

const ENV_KEYS = [
  'TEACHER_NUDGES_ENABLED', 'TEACHER_NUDGES_QUIET_MINUTES', 'TEACHER_NUDGES_LOOKBACK_DAYS',
  'TEACHER_NUDGES_TZ', 'TEACHER_NUDGES_QUIET_HOURS', 'TEACHER_NUDGES_MAX_PER_TICK',
  'CHANNEL_DRIVER', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET',
];
const saved = {};

let ctx;
function load() {
  jest.isolateModules(() => {
    const sweeper = require('../../bot/shared/services/nudges/teacher-nudges.sweeper');
    const kind = require('../../bot/shared/services/nudges/re-engage.kind');
    sweeper.register(kind);
    ctx = {
      sweeper,
      kind,
      supabase: require('../../bot/shared/config/supabase'),
      send: require('../../bot/shared/services/whatsapp.service').sendMessage,
    };
  });
  ctx.send.mockReset();
  ctx.send.mockResolvedValue(true);
  return ctx;
}

const TEACHER = { id: 'teacher-1', first_name: 'Sam', phone_number: '15550001111', registration_completed: true };

function seedTeacher(over = {}, channels = null) {
  const user = { ...TEACHER, last_message_at: hoursBefore(21), ...over };
  ctx.supabase.tables.users.push(user);
  const rows = channels || [{ user_id: user.id, channel: 'whatsapp', channel_user_id: user.phone_number, is_primary: true, last_message_at: hoursBefore(24 * 30) }];
  ctx.supabase.tables.user_channels.push(...rows);
  return user;
}
const nudges = () => ctx.supabase.rows('teacher_nudges');
const userRow = (id) => ctx.supabase.rows('users').find((u) => u.id === id);

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.TEACHER_NUDGES_ENABLED = 'true';
  process.env.CHANNEL_DRIVER = 'meta';
  load();
  ctx.supabase.reset({ users: [], user_channels: [], teacher_nudges: [] });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('re_engage — cohort', () => {
  it('a teacher quiet for 21 h is booked and nudged once, with a warm free-text message', async () => {
    seedTeacher();
    const out = await ctx.sweeper.runSweep({ now: NOW });

    expect(out).toMatchObject({ booked: 1, claimed: 1, sent: 1 });
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [to, text] = ctx.send.mock.calls[0];
    expect(to).toBe('15550001111');
    expect(text).toMatch(/^Hi Sam 👋/);
    expect(text).toMatch(/lesson plan/);
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toMatchObject({
      kind: 're_engage',
      nudge_date: '2026-03-10',
      status: 'sent',
      context: expect.objectContaining({ last_message_at: hoursBefore(21), channel: 'whatsapp' }),
    });
  });

  it.each([
    ['spoke 2 h ago (not quiet yet)', { last_message_at: hoursBefore(2) }],
    ['has been quiet for 20 days (past the lookback)', { last_message_at: hoursBefore(24 * 20) }],
    ['is not registered', { registration_completed: false }],
    ['has never written in', { last_message_at: null }],
  ])('a teacher who %s is not booked', async (_label, over) => {
    seedTeacher(over);
    await ctx.sweeper.runSweep({ now: NOW });
    expect(nudges()).toHaveLength(0);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('honours TEACHER_NUDGES_QUIET_MINUTES and TEACHER_NUDGES_LOOKBACK_DAYS', async () => {
    process.env.TEACHER_NUDGES_QUIET_MINUTES = '60';
    process.env.TEACHER_NUDGES_LOOKBACK_DAYS = '1';
    seedTeacher({ last_message_at: hoursBefore(2) });
    seedTeacher({ id: 'teacher-2', phone_number: '15550002222', last_message_at: hoursBefore(30) });
    await ctx.sweeper.runSweep({ now: NOW });
    expect(nudges().map((n) => n.user_id)).toEqual(['teacher-1']);
  });

  it('a Slack teacher who is active on Slack is not treated as quiet because the users row is stale', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-real';
    process.env.SLACK_SIGNING_SECRET = 'test-signing-not-real';
    seedTeacher({ phone_number: null, last_message_at: hoursBefore(24 * 5) }, [
      { user_id: 'teacher-1', channel: 'slack', channel_user_id: 'U0TEST01', is_primary: true, last_message_at: hoursBefore(1) },
    ]);
    await ctx.sweeper.runSweep({ now: NOW });
    expect(nudges()).toHaveLength(0);
  });
});

describe('re_engage — once per quiet spell', () => {
  it('the next tick the same day books nothing and sends nothing', async () => {
    seedTeacher();
    await ctx.sweeper.runSweep({ now: NOW });
    await ctx.sweeper.runSweep({ now: new Date(NOW.getTime() + 5 * 60 * 1000) });
    expect(nudges()).toHaveLength(1);
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  it('the next local day, still silent: the same quiet spell is never nudged again', async () => {
    process.env.CHANNEL_DRIVER = 'baileys'; // no 24 h rule, so only the spell guard can stop it
    seedTeacher();
    await ctx.sweeper.runSweep({ now: NOW });
    await ctx.sweeper.runSweep({ now: later(24) });
    await ctx.sweeper.runSweep({ now: later(48) });
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(nudges()).toHaveLength(1);
  });

  it('a teacher who spoke again after the nudge can be nudged in a later quiet spell', async () => {
    process.env.CHANNEL_DRIVER = 'baileys';
    seedTeacher();
    await ctx.sweeper.runSweep({ now: NOW });
    expect(ctx.send).toHaveBeenCalledTimes(1);

    // They write in at NOW+1h, then go quiet again for 21 h.
    userRow('teacher-1').last_message_at = later(1).toISOString();
    const next = later(22);
    await ctx.sweeper.runSweep({ now: next });

    expect(ctx.send).toHaveBeenCalledTimes(2);
    const second = nudges().find((n) => n.nudge_date === '2026-03-11');
    expect(second).toMatchObject({ status: 'sent', context: expect.objectContaining({ last_message_at: later(1).toISOString() }) });
  });

  it('a teacher who writes in between booking and sending is skipped active_again', async () => {
    seedTeacher();
    await ctx.kind.prepare(NOW);
    expect(nudges()).toHaveLength(1);

    userRow('teacher-1').last_message_at = new Date(NOW.getTime() + 60 * 1000).toISOString();
    await ctx.sweeper.runSweep({ now: new Date(NOW.getTime() + 2 * 60 * 1000) });

    expect(ctx.send).not.toHaveBeenCalled();
    expect(nudges()[0]).toMatchObject({ status: 'skipped', skip_reason: 'active_again' });
  });
});

describe('re_engage — the 24-hour window', () => {
  it('Meta driver, inside 24 h: sent', async () => {
    seedTeacher({ last_message_at: hoursBefore(23) });
    await ctx.sweeper.runSweep({ now: NOW });
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(nudges()[0].status).toBe('sent');
  });

  it('Meta driver, outside 24 h: skipped window_closed, nothing sent, no template', async () => {
    seedTeacher({ last_message_at: hoursBefore(30) });
    await ctx.sweeper.runSweep({ now: NOW });
    expect(ctx.send).not.toHaveBeenCalled();
    expect(nudges()[0]).toMatchObject({ status: 'skipped', skip_reason: 'window_closed' });
  });

  it('Meta driver, a window_closed spell is not rebooked every day', async () => {
    seedTeacher({ last_message_at: hoursBefore(30) });
    await ctx.sweeper.runSweep({ now: NOW });
    await ctx.sweeper.runSweep({ now: later(24) });
    expect(nudges()).toHaveLength(1);
  });

  it('a non-Meta driver (Baileys), outside 24 h: sent', async () => {
    process.env.CHANNEL_DRIVER = 'baileys';
    seedTeacher({ last_message_at: hoursBefore(30) });
    await ctx.sweeper.runSweep({ now: NOW });
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(nudges()[0].status).toBe('sent');
  });

  it('on a Meta deployment, a teacher reached on Slack has no 24-hour rule', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-real';
    process.env.SLACK_SIGNING_SECRET = 'test-signing-not-real';
    seedTeacher({ phone_number: null, last_message_at: hoursBefore(24 * 5) }, [
      { user_id: 'teacher-1', channel: 'slack', channel_user_id: 'U0TEST01', is_primary: true, last_message_at: hoursBefore(30) },
    ]);
    await ctx.sweeper.runSweep({ now: NOW });
    expect(ctx.send).toHaveBeenCalledWith('slack:U0TEST01', expect.stringMatching(/^Hi Sam/));
    expect(nudges()[0]).toMatchObject({ status: 'sent', context: expect.objectContaining({ channel: 'slack' }) });
  });
});

describe('re_engage — quiet hours and failures', () => {
  it('nothing is booked during quiet hours', async () => {
    seedTeacher({ last_message_at: hoursBefore(21, new Date('2026-03-10T23:00:00Z')) });
    await ctx.sweeper.runSweep({ now: new Date('2026-03-10T23:00:00Z') });
    expect(nudges()).toHaveLength(0);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('a row reached during quiet hours is skipped quiet_hours', async () => {
    seedTeacher({ last_message_at: hoursBefore(21, new Date('2026-03-10T20:55:00Z')) });
    await ctx.kind.prepare(new Date('2026-03-10T20:55:00Z'));
    await ctx.sweeper.runSweep({ now: new Date('2026-03-10T21:05:00Z') });
    expect(ctx.send).not.toHaveBeenCalled();
    expect(nudges()[0]).toMatchObject({ status: 'skipped', skip_reason: 'quiet_hours' });
  });

  it('a send that returns false is marked failed, not sent', async () => {
    seedTeacher();
    ctx.send.mockResolvedValue(false);
    const out = await ctx.sweeper.runSweep({ now: NOW });
    expect(out).toMatchObject({ sent: 0, failed: 1 });
    expect(nudges()[0]).toMatchObject({ status: 'failed', context: expect.objectContaining({ error: expect.stringMatching(/false/) }) });
  });

  it('a teacher with no reachable address is skipped no_address', async () => {
    seedTeacher({ phone_number: null }, []);
    await ctx.sweeper.runSweep({ now: NOW });
    expect(nudges()[0]).toMatchObject({ status: 'skipped', skip_reason: 'no_address' });
  });

  it('a teacher with no first name still gets a well-formed greeting', async () => {
    seedTeacher({ first_name: null });
    await ctx.sweeper.runSweep({ now: NOW });
    expect(ctx.send.mock.calls[0][1]).toMatch(/^Hi 👋/);
  });
});
