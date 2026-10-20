'use strict';
/**
 * teacher-nudges.sweeper — the periodic tick over the registered nudge kinds.
 *
 * Driven against the REAL store over a stateful in-memory Supabase
 * (tests/fixtures/memory-supabase): the network boundary is mocked, the chain
 * under test (sweeper -> store -> conditional UPDATE) is not. Each test loads a
 * fresh module graph so the kind registry starts empty.
 *
 * The clauses asserted:
 *   kill switch   TEACHER_NUDGES_ENABLED read at CALL time; off = no database
 *                 access at all, no claim, no send.
 *   single-flight two sweeps over the same due row send it exactly once.
 *   per-tick cap  TEACHER_NUDGES_MAX_PER_TICK (default 200) bounds the claims of
 *                 one tick across every kind; a backlog drips out over ticks.
 *   one line      exactly one summary log line per tick.
 *   never throws  a broken database or a broken kind costs a row, not the tick.
 */

// Mocked at the client library (the network boundary): the real config/supabase.js loads and
// exports this in-memory client.
jest.mock('@supabase/supabase-js', () => {
  const { createMemorySupabase } = require('../fixtures/memory-supabase');
  const memory = createMemorySupabase({}, { unique: { teacher_nudges: ['user_id', 'nudge_date', 'kind'] } });
  return { createClient: () => memory };
});
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const NOW = new Date('2026-03-10T10:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000).toISOString();

const ENV_KEYS = ['TEACHER_NUDGES_ENABLED', 'TEACHER_NUDGES_MAX_PER_TICK', 'RUMI_FEATURE_TEACHER_NUDGES'];
const saved = {};

function load() {
  let mods;
  jest.isolateModules(() => {
    mods = {
      sweeper: require('../../bot/shared/services/nudges/teacher-nudges.sweeper'),
      supabase: require('../../bot/shared/config/supabase'),
      logger: require('../../bot/shared/utils/logger'),
    };
  });
  return mods;
}

let seq = 0;
function seed(supabase, over = {}) {
  seq += 1;
  const row = {
    id: `row-${seq}`,
    user_id: `user-${seq}`,
    kind: 'test_kind',
    nudge_date: '2026-03-10',
    scheduled_at: minutesAgo(1),
    status: 'pending',
    skip_reason: null,
    context: {},
    attempts: 0,
    claimed_at: null,
    ...over,
  };
  supabase.tables.teacher_nudges = supabase.tables.teacher_nudges || [];
  supabase.tables.teacher_nudges.push(row);
  return row;
}
const byId = (supabase, id) => supabase.rows('teacher_nudges').find((r) => r.id === id);

function sendingKind(kind = 'test_kind', handle = jest.fn(async () => ({ sent: true }))) {
  return { kind, handle };
}

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.TEACHER_NUDGES_ENABLED = 'true';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('kill switch — TEACHER_NUDGES_ENABLED', () => {
  it.each([undefined, '', 'false', '0', 'off'])('%j: no database access, no claim, no send', async (value) => {
    if (value === undefined) delete process.env.TEACHER_NUDGES_ENABLED;
    else process.env.TEACHER_NUDGES_ENABLED = value;
    const { sweeper, supabase } = load();
    const row = seed(supabase);
    const kind = { kind: 'test_kind', prepare: jest.fn(), handle: jest.fn(async () => ({ sent: true })) };
    sweeper.register(kind);
    supabase.from.mockClear();

    const out = await sweeper.runSweep({ now: NOW });

    expect(out.off).toBe(true);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(kind.prepare).not.toHaveBeenCalled();
    expect(kind.handle).not.toHaveBeenCalled();
    expect(byId(supabase, row.id).status).toBe('pending');
  });

  it('the operator feature switch RUMI_FEATURE_TEACHER_NUDGES=off pauses it even with the flag on', async () => {
    process.env.RUMI_FEATURE_TEACHER_NUDGES = 'off';
    const { sweeper, supabase } = load();
    const row = seed(supabase);
    const kind = sendingKind();
    sweeper.register(kind);

    expect(sweeper.isEnabled()).toBe(false);
    const out = await sweeper.runSweep({ now: NOW });
    expect(out.off).toBe(true);
    expect(kind.handle).not.toHaveBeenCalled();
    expect(byId(supabase, row.id).status).toBe('pending');
  });

  it('is read at call time: flipping it on takes effect on the next tick', async () => {
    process.env.TEACHER_NUDGES_ENABLED = 'false';
    const { sweeper, supabase } = load();
    const row = seed(supabase);
    const kind = sendingKind();
    sweeper.register(kind);

    await sweeper.runSweep({ now: NOW });
    expect(kind.handle).not.toHaveBeenCalled();

    process.env.TEACHER_NUDGES_ENABLED = '1';
    await sweeper.runSweep({ now: NOW });
    expect(kind.handle).toHaveBeenCalledTimes(1);
    expect(byId(supabase, row.id).status).toBe('sent');
  });
});

describe('register', () => {
  it('refuses a kind without a handle, or with a malformed name', () => {
    const { sweeper } = load();
    expect(() => sweeper.register({ kind: 'no_handle' })).toThrow(/handle/);
    expect(() => sweeper.register({ kind: 'Bad Name', handle: async () => ({}) })).toThrow(/kind/);
  });

  it('refuses two owners for one kind, but registering the same module twice is a no-op', () => {
    const { sweeper } = load();
    const kind = sendingKind();
    sweeper.register(kind);
    expect(() => sweeper.register(kind)).not.toThrow();
    expect(() => sweeper.register(sendingKind())).toThrow(/already registered/);
    expect(sweeper.registeredKinds()).toEqual(['test_kind']);
  });
});

describe('one tick', () => {
  it('runs prepare before the claim, so rows it books are sent in the same tick', async () => {
    const { sweeper, supabase } = load();
    const handle = jest.fn(async () => ({ sent: true }));
    sweeper.register({
      kind: 'test_kind',
      prepare: async () => { seed(supabase, { scheduled_at: NOW.toISOString() }); },
      handle,
    });

    const out = await sweeper.runSweep({ now: NOW });
    expect(out).toMatchObject({ claimed: 1, sent: 1 });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ status: 'sending' }), { now: NOW });
  });

  it('a prepare that throws still claims rows booked on an earlier tick', async () => {
    const { sweeper, supabase } = load();
    const row = seed(supabase);
    sweeper.register({ kind: 'test_kind', prepare: async () => { throw new Error('cohort query broke'); }, handle: async () => ({ sent: true }) });

    const out = await sweeper.runSweep({ now: NOW });
    expect(out.sent).toBe(1);
    expect(byId(supabase, row.id).status).toBe('sent');
  });

  it('records each outcome: sent, skipped with its reason, failed on a throw or a malformed answer', async () => {
    const { sweeper, supabase } = load();
    const a = seed(supabase, { context: { why: 'a' } });
    const b = seed(supabase, { context: { why: 'b' } });
    const c = seed(supabase, { context: { why: 'c' } });
    const d = seed(supabase, { context: { why: 'd' } });
    sweeper.register({
      kind: 'test_kind',
      handle: async (row) => {
        if (row.context.why === 'a') return { sent: true, context: { channel: 'whatsapp' } };
        if (row.context.why === 'b') return { skipped: 'window_closed' };
        if (row.context.why === 'c') throw new Error('send returned false');
        return { maybe: true };
      },
    });

    const out = await sweeper.runSweep({ now: NOW });

    expect(out).toMatchObject({ claimed: 4, sent: 1, skipped: 1, failed: 2 });
    expect(byId(supabase, a.id)).toMatchObject({ status: 'sent', context: { why: 'a', channel: 'whatsapp' } });
    expect(byId(supabase, b.id)).toMatchObject({ status: 'skipped', skip_reason: 'window_closed' });
    expect(byId(supabase, c.id)).toMatchObject({ status: 'failed', context: { error: 'send returned false' } });
    expect(byId(supabase, d.id).status).toBe('failed');
  });

  it('a skip with an unknown reason is a failure, not a silent skip', async () => {
    const { sweeper, supabase } = load();
    const row = seed(supabase);
    sweeper.register({ kind: 'test_kind', handle: async () => ({ skipped: 'felt_like_it' }) });
    const out = await sweeper.runSweep({ now: NOW });
    expect(out.failed).toBe(1);
    expect(byId(supabase, row.id).status).toBe('failed');
  });

  it('reclaims rows stuck in sending before claiming', async () => {
    const { sweeper, supabase } = load();
    const stuck = seed(supabase, { status: 'sending', claimed_at: minutesAgo(15) });
    sweeper.register(sendingKind());
    const out = await sweeper.runSweep({ now: NOW });
    expect(out.reclaimed).toBe(1);
    expect(byId(supabase, stuck.id)).toMatchObject({ status: 'failed', context: { error: 'stale_sending' } });
  });

  it('only claims kinds this process registered', async () => {
    const { sweeper, supabase } = load();
    const orphan = seed(supabase, { kind: 'nobody_sends_this' });
    sweeper.register(sendingKind());
    await sweeper.runSweep({ now: NOW });
    expect(byId(supabase, orphan.id).status).toBe('pending');
  });

  it('logs exactly one summary line per tick', async () => {
    const { sweeper, supabase, logger } = load();
    seed(supabase);
    sweeper.register(sendingKind());
    logger.logToFile.mockClear();
    await sweeper.runSweep({ now: NOW });
    const summaries = logger.logToFile.mock.calls.filter(([msg]) => /teacher_nudges sweep:? (done|tick)/.test(msg));
    expect(summaries).toHaveLength(1);
    expect(summaries[0][1]).toMatchObject({ claimed: 1, sent: 1, skipped: 0, failed: 0, reclaimed: 0 });
  });

  it('never throws, even when the database client itself throws', async () => {
    const { sweeper, supabase } = load();
    sweeper.register(sendingKind());
    supabase.from.mockImplementation(() => { throw new Error('socket hang up'); });
    await expect(sweeper.runSweep({ now: NOW })).resolves.toMatchObject({ claimed: 0 });
  });
});

describe('single-flight', () => {
  it('two concurrent sweeps over the same due row send it exactly once', async () => {
    const { sweeper, supabase } = load();
    const row = seed(supabase);
    const kind = sendingKind();
    sweeper.register(kind);

    const [one, two] = await Promise.all([
      sweeper.runSweep({ now: NOW }),
      sweeper.runSweep({ now: NOW }),
    ]);

    expect(kind.handle).toHaveBeenCalledTimes(1);
    expect(one.sent + two.sent).toBe(1);
    expect(byId(supabase, row.id).status).toBe('sent');
  });
});

describe('per-tick cap — TEACHER_NUDGES_MAX_PER_TICK', () => {
  it('defaults to 200', () => {
    const { sweeper } = load();
    expect(sweeper.maxPerTick()).toBe(200);
  });

  it('bounds one tick across every kind; the backlog drips out over later ticks', async () => {
    process.env.TEACHER_NUDGES_MAX_PER_TICK = '3';
    const { sweeper, supabase } = load();
    for (let i = 0; i < 3; i += 1) seed(supabase, { kind: 'kind_a' });
    for (let i = 0; i < 3; i += 1) seed(supabase, { kind: 'kind_b' });
    const a = sendingKind('kind_a');
    const b = sendingKind('kind_b');
    sweeper.register(a);
    sweeper.register(b);

    const first = await sweeper.runSweep({ now: NOW });
    expect(first.claimed).toBe(3);
    expect(a.handle.mock.calls.length + b.handle.mock.calls.length).toBe(3);

    const second = await sweeper.runSweep({ now: NOW });
    expect(second.claimed).toBe(3);
    const third = await sweeper.runSweep({ now: NOW });
    expect(third.claimed).toBe(0);
  });

  it('a junk env value keeps the default', () => {
    process.env.TEACHER_NUDGES_MAX_PER_TICK = 'lots';
    const { sweeper } = load();
    expect(sweeper.maxPerTick()).toBe(200);
  });

  it('an explicit limit wins over the env', async () => {
    process.env.TEACHER_NUDGES_MAX_PER_TICK = '50';
    const { sweeper, supabase } = load();
    seed(supabase);
    seed(supabase);
    sweeper.register(sendingKind());
    const out = await sweeper.runSweep({ now: NOW, limit: 1 });
    expect(out.claimed).toBe(1);
  });
});
