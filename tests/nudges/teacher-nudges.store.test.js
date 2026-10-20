'use strict';
/**
 * teacher-nudges.store — the only code that touches `teacher_nudges`.
 *
 * Two guards make scheduled messaging safe, and both are asserted against a
 * Supabase stand-in that REALLY filters (tests/fixtures/memory-supabase) — a
 * stub that ignored `.eq()` would let a broken claim pass:
 *
 *   G1  booking is idempotent: UNIQUE (user_id, nudge_date, kind) answers a
 *       duplicate insert with 23505, which `book` reads as "already booked".
 *   G2  sending is claimed: `claimDue` flips pending -> sending with
 *       `.eq('status','pending')` still on the UPDATE, and only the rows that
 *       UPDATE returned are this caller's.
 */

// Mocked at the client library (the network boundary): the real config/supabase.js loads and
// exports this in-memory client.
jest.mock('@supabase/supabase-js', () => {
  const { createMemorySupabase } = require('../fixtures/memory-supabase');
  const memory = createMemorySupabase({}, { unique: { teacher_nudges: ['user_id', 'nudge_date', 'kind'] } });
  return { createClient: () => memory };
});
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const { logToFile } = require('../../bot/shared/utils/logger');
const store = require('../../bot/shared/services/nudges/teacher-nudges.store');

const NOW = new Date('2026-03-10T10:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000).toISOString();
const TEACHER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const KIND = 'test_kind';

let seq = 0;
function seed(over = {}) {
  seq += 1;
  const row = {
    id: `seed-${seq}`,
    user_id: TEACHER,
    kind: KIND,
    nudge_date: '2026-03-10',
    scheduled_at: minutesAgo(1),
    status: 'pending',
    skip_reason: null,
    context: {},
    attempts: 0,
    claimed_at: null,
    sent_at: null,
    ...over,
  };
  supabase.tables.teacher_nudges = supabase.tables.teacher_nudges || [];
  supabase.tables.teacher_nudges.push(row);
  return row;
}
const rows = () => supabase.rows('teacher_nudges');
const byId = (id) => rows().find((r) => r.id === id);

beforeEach(() => {
  supabase.reset({ teacher_nudges: [] });
  logToFile.mockClear();
});

describe('book — G1, idempotent on (user, day, kind)', () => {
  it('inserts a pending row and says it created it', async () => {
    const { row, created } = await store.book({
      userId: TEACHER, kind: KIND, nudgeDate: '2026-03-10', scheduledAt: NOW, context: { a: 1 },
    });
    expect(created).toBe(true);
    expect(row).toMatchObject({ user_id: TEACHER, kind: KIND, status: 'pending', context: { a: 1 } });
    expect(rows()).toHaveLength(1);
  });

  it('a second booking of the same teacher-day-kind is a no-op returning the first row', async () => {
    const first = await store.book({ userId: TEACHER, kind: KIND, nudgeDate: '2026-03-10', scheduledAt: NOW, context: { n: 1 } });
    const second = await store.book({ userId: TEACHER, kind: KIND, nudgeDate: '2026-03-10', scheduledAt: NOW, context: { n: 2 } });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.context).toEqual({ n: 1 });
    expect(rows()).toHaveLength(1);
  });

  it('a different day or a different teacher is a new row', async () => {
    await store.book({ userId: TEACHER, kind: KIND, nudgeDate: '2026-03-10', scheduledAt: NOW });
    await store.book({ userId: TEACHER, kind: KIND, nudgeDate: '2026-03-11', scheduledAt: NOW });
    await store.book({ userId: OTHER, kind: KIND, nudgeDate: '2026-03-10', scheduledAt: NOW });
    expect(rows()).toHaveLength(3);
  });

  it('any other insert error throws, so a cohort builder knows the row is missing', async () => {
    supabase.failNext('teacher_nudges', 'insert', { code: '57014', message: 'timeout' });
    await expect(store.book({ userId: TEACHER, kind: KIND, nudgeDate: '2026-03-10', scheduledAt: NOW }))
      .rejects.toThrow(/timeout/);
  });
});

describe('claimDue — G2, single-flight', () => {
  it('claims only due, pending rows of the kind, flipping them to sending', async () => {
    const due = seed();
    const future = seed({ user_id: OTHER, scheduled_at: new Date(NOW.getTime() + 60000).toISOString() });
    const otherKind = seed({ user_id: OTHER, kind: 'another_kind', nudge_date: '2026-03-09' });
    const done = seed({ user_id: OTHER, nudge_date: '2026-03-08', status: 'sent' });

    const claimed = await store.claimDue({ kind: KIND, limit: 10, now: NOW });

    expect(claimed.map((r) => r.id)).toEqual([due.id]);
    expect(byId(due.id).status).toBe('sending');
    expect(byId(due.id).claimed_at).toBe(NOW.toISOString());
    expect(byId(future.id).status).toBe('pending');
    expect(byId(otherKind.id).status).toBe('pending');
    expect(byId(done.id).status).toBe('sent');
  });

  it('respects the limit, oldest first', async () => {
    const a = seed({ scheduled_at: minutesAgo(30) });
    const b = seed({ user_id: OTHER, scheduled_at: minutesAgo(20) });
    seed({ user_id: 'u3', scheduled_at: minutesAgo(10) });
    const claimed = await store.claimDue({ kind: KIND, limit: 2, now: NOW });
    expect(claimed.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it('two concurrent claims over the same due row: exactly one wins it', async () => {
    const row = seed();
    const [one, two] = await Promise.all([
      store.claimDue({ kind: KIND, limit: 10, now: NOW }),
      store.claimDue({ kind: KIND, limit: 10, now: NOW }),
    ]);
    expect(one.length + two.length).toBe(1);
    expect(byId(row.id).status).toBe('sending');
  });

  it('the conditional UPDATE is what claims: a row taken between select and update is not returned', async () => {
    const row = seed();
    // Simulate another replica flipping the row right after our select ran.
    const realFrom = supabase.from.getMockImplementation();
    let selects = 0;
    supabase.from.mockImplementation((table) => {
      const chain = realFrom(table);
      const realThen = chain.then;
      chain.then = (res, rej) => {
        selects += 1;
        const out = realThen(res, rej);
        if (selects === 1) byId(row.id).status = 'sending';
        return out;
      };
      return chain;
    });
    try {
      const claimed = await store.claimDue({ kind: KIND, limit: 10, now: NOW });
      expect(claimed).toEqual([]);
    } finally {
      supabase.from.mockImplementation(realFrom);
    }
  });

  it('a failed select claims nothing and logs, never throws', async () => {
    seed();
    supabase.failNext('teacher_nudges', 'select');
    await expect(store.claimDue({ kind: KIND, limit: 10, now: NOW })).resolves.toEqual([]);
    expect(logToFile).toHaveBeenCalledWith(expect.stringMatching(/claim select failed/), expect.any(Object));
  });
});

describe('marking the outcome', () => {
  it('markSent records sent_at, merges context and counts the attempt', async () => {
    const row = seed({ status: 'sending', context: { last_message_at: 'x' } });
    await store.markSent(row.id, { context: { channel: 'whatsapp' } });
    expect(byId(row.id)).toMatchObject({
      status: 'sent',
      sent_at: expect.any(String),
      attempts: 1,
      context: { last_message_at: 'x', channel: 'whatsapp' },
    });
  });

  it('markSkipped stores the reason; an unknown reason throws before any write', async () => {
    const row = seed({ status: 'sending' });
    await store.markSkipped(row.id, 'window_closed');
    expect(byId(row.id)).toMatchObject({ status: 'skipped', skip_reason: 'window_closed' });

    const other = seed({ user_id: OTHER, status: 'sending' });
    await expect(store.markSkipped(other.id, 'because')).rejects.toThrow(/unknown skip reason/);
    expect(byId(other.id).status).toBe('sending');
  });

  it('markFailed keeps the error MESSAGE in context', async () => {
    const row = seed({ status: 'sending', context: { keep: true } });
    await store.markFailed(row.id, new Error('send returned false'));
    expect(byId(row.id)).toMatchObject({ status: 'failed', context: { keep: true, error: 'send returned false' } });
  });

  it('release hands a claimed row back to pending at a new time; only while it is still sending', async () => {
    const row = seed({ status: 'sending' });
    const later = new Date(NOW.getTime() + 3600000);
    expect(await store.release(row.id, { scheduledAt: later })).toBe(true);
    expect(byId(row.id)).toMatchObject({ status: 'pending', scheduled_at: later.toISOString() });

    const finished = seed({ user_id: OTHER, status: 'sent' });
    expect(await store.release(finished.id, { scheduledAt: later })).toBe(false);
    expect(byId(finished.id).status).toBe('sent');
  });
});

describe('reclaimStale', () => {
  it('rows stuck in sending past 10 minutes become failed; fresh ones are left alone', async () => {
    const stuck = seed({ status: 'sending', claimed_at: minutesAgo(11) });
    const fresh = seed({ user_id: OTHER, status: 'sending', claimed_at: minutesAgo(2) });
    const pending = seed({ user_id: 'u3', status: 'pending', claimed_at: null });

    const n = await store.reclaimStale({ now: NOW });

    expect(n).toBe(1);
    expect(byId(stuck.id)).toMatchObject({ status: 'failed', context: { error: 'stale_sending' } });
    expect(byId(fresh.id).status).toBe('sending');
    expect(byId(pending.id).status).toBe('pending');
  });
});

describe('rowsFor', () => {
  it('returns a teacher\'s rows of one kind, filtered by status when asked', async () => {
    seed({ status: 'sent', nudge_date: '2026-03-08' });
    seed({ status: 'skipped', nudge_date: '2026-03-09' });
    seed({ user_id: OTHER, status: 'sent' });
    const sent = await store.rowsFor(TEACHER, { kind: KIND, status: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0].nudge_date).toBe('2026-03-08');
  });
});
