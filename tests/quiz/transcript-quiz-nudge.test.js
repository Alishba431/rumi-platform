'use strict';
/**
 * The one nudge: "only N have started — forward the link again?"
 *
 *   - its wait and its threshold are configuration (TRANSCRIPT_QUIZ_NUDGE_AFTER_MINUTES,
 *     default 360; TRANSCRIPT_QUIZ_NUDGE_BELOW, default 5);
 *   - the quiet hours are the school's (QUIET_HOURS in SCHOOL_TIMEZONE): a nudge
 *     due inside them waits for the window's end, it is never dropped;
 *   - a teacher hears at most one nudge per SCHOOL day, and a quiz never twice.
 */
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-language', () => require('./helpers/language-mock').factory());
jest.mock('../../bot/shared/services/quiz/teacher-self-test', () => require('./helpers/language-mock').selfTestFactory());
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const { makeSchemaDb } = require('./helpers/schema-db');
const Nudge = require('../../bot/shared/services/quiz/transcript-quiz-nudge.service');

const UID = '33333333-3333-4333-8333-333333333333';
const PHONE = '15550100001';
const Q = (n) => `2222222${n}-2222-4222-8222-222222222222`;

let db;
function install({ quizzes, sessions = [] }) {
  db = makeSchemaDb({
    users: [{ id: UID, phone_number: PHONE, preferred_language: 'en' }],
    quizzes,
    quiz_sessions: sessions,
  });
  supabase.from.mockImplementation(db.from);
}
function sentQuiz(n, over = {}) {
  return {
    id: Q(n), teacher_id: UID, quiz_source: 'transcript', topic: `Lesson ${n}`, status: 'sent',
    meta: { sent_at: new Date(Date.now() - 7 * 3600 * 1000).toISOString() }, created_at: new Date().toISOString(), ...over,
  };
}
const kids = (quizId, n) => Array.from({ length: n }, (_, i) => ({
  id: `${quizId.slice(0, 8)}-s${i}`, quiz_id: quizId, user_id: null, student_name: `Child ${i}`, status: 'in_progress',
  created_at: new Date().toISOString(),
}));

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV, SCHOOL_TIMEZONE: 'Africa/Nairobi', QUIET_HOURS: '21-7' };
  delete process.env.TRANSCRIPT_QUIZ_NUDGE_AFTER_MINUTES;
  delete process.env.TRANSCRIPT_QUIZ_NUDGE_BELOW;
});
afterEach(() => jest.useRealTimers());
afterAll(() => { process.env = ENV; });

describe('when the nudge may speak — the school\'s clock', () => {
  test('a job arriving inside the quiet hours in SCHOOL_TIMEZONE is held to 07:00 school time', () => {
    // 19:30 UTC = 22:30 at a UTC+3 school: quiet. At a UTC+5 school it would be 00:30.
    const decision = Nudge.nudgeDispatch({ now: new Date('2026-10-01T19:30:00Z') });
    expect(decision.action).toBe('requeue');
    expect(decision.targetAt).toBe('2026-10-02T04:00:00.000Z');
    expect(decision.delaySeconds).toBe(900);
  });

  test('the same instant is daytime for a school whose quiet hours have not begun', () => {
    process.env.SCHOOL_TIMEZONE = 'America/Sao_Paulo';            // 16:30 there
    expect(Nudge.nudgeDispatch({ now: new Date('2026-10-01T19:30:00Z') })).toEqual({ action: 'process' });
  });

  test('QUIET_HOURS=off lifts the window', () => {
    process.env.QUIET_HOURS = 'off';
    expect(Nudge.nudgeDispatch({ now: new Date('2026-10-01T19:30:00Z') })).toEqual({ action: 'process' });
  });

  test('a target still in the future is waited for, in hops the queue accepts', () => {
    const now = new Date('2026-10-01T08:00:00Z');
    const d = Nudge.nudgeDispatch({ now, targetAt: '2026-10-01T08:02:00Z' });
    expect(d).toEqual({ action: 'requeue', targetAt: '2026-10-01T08:02:00.000Z', delaySeconds: 120 });
  });

  test('the wait is TRANSCRIPT_QUIZ_NUDGE_AFTER_MINUTES, six hours when unset', () => {
    expect(Nudge.nudgeAfterMs()).toBe(6 * 3600 * 1000);
    process.env.TRANSCRIPT_QUIZ_NUDGE_AFTER_MINUTES = '3';
    expect(Nudge.nudgeAfterMs()).toBe(3 * 60 * 1000);
    process.env.TRANSCRIPT_QUIZ_NUDGE_AFTER_MINUTES = 'soon';
    expect(Nudge.nudgeAfterMs()).toBe(6 * 3600 * 1000);
  });

  test('the school day starts at midnight school time', () => {
    expect(Nudge.schoolDayStartIso(new Date('2026-10-01T22:30:00Z'))).toBe('2026-10-01T21:00:00.000Z');
  });
});

describe('who is nudged', () => {
  test('fewer than five started: the teacher is told, and the quiz is stamped', async () => {
    install({ quizzes: [sentQuiz(1)], sessions: kids(Q(1), 2) });
    const out = await Nudge.process(Q(1));
    expect(out.ok).toBe(true);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);
    expect(WhatsAppService.sendMessage.mock.calls[0][0]).toBe(PHONE);
    expect(db.table('quizzes')[0].meta.nudged_at).toBeTruthy();
    expect(db.refused).toEqual([]);
  });

  test('a teacher on Matrix is nudged in the chat the quiz was sent to, not at users.phone_number', async () => {
    // users.phone_number is a bare number (a WhatsApp recipient) or empty for a
    // Matrix teacher; the hand-off records the recipient it sent to.
    install({ quizzes: [sentQuiz(1, { meta: { sent_at: new Date(Date.now() - 7 * 3600 * 1000).toISOString(), teacher_to: 'mtx:15550100001' } })], sessions: kids(Q(1), 1) });
    db.table('users')[0].phone_number = null;
    const out = await Nudge.process(Q(1));
    expect(out.ok).toBe(true);
    expect(WhatsAppService.sendMessage.mock.calls[0][0]).toBe('mtx:15550100001');
  });

  test('never twice', async () => {
    install({ quizzes: [sentQuiz(1)], sessions: kids(Q(1), 1) });
    await Nudge.process(Q(1));
    expect(await Nudge.process(Q(1))).toEqual({ skipped: 'already_nudged' });
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('five started is enough by default; TRANSCRIPT_QUIZ_NUDGE_BELOW moves the line', async () => {
    install({ quizzes: [sentQuiz(1)], sessions: kids(Q(1), 5) });
    expect(await Nudge.process(Q(1))).toEqual({ skipped: 'enough_started', started: 5 });
    process.env.TRANSCRIPT_QUIZ_NUDGE_BELOW = '10';
    expect((await Nudge.process(Q(1))).ok).toBe(true);
  });

  test('one nudge per school day: a second quiz the same school day stays quiet', async () => {
    // 22:30 school time on 1 Oct; the first nudge went out at 08:00 school time that day.
    jest.useFakeTimers({ now: new Date('2026-10-01T19:30:00Z') });
    install({
      quizzes: [
        sentQuiz(1, { meta: { sent_at: '2026-09-30T23:00:00Z', nudged_at: '2026-10-01T05:00:00.000Z' } }),
        sentQuiz(2, { meta: { sent_at: '2026-10-01T10:00:00Z' } }),
      ],
    });
    expect(await Nudge.process(Q(2))).toEqual({ skipped: 'teacher_nudged_today' });
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
  });

  test('yesterday\'s nudge, by the school\'s calendar, does not hold today\'s back', async () => {
    // 21:30 UTC on 1 Oct is 00:30 on 2 Oct at the school (UTC+3); a nudge at 20:00 UTC (23:00 on 1 Oct) was yesterday.
    jest.useFakeTimers({ now: new Date('2026-10-01T21:30:00Z') });
    install({
      quizzes: [
        sentQuiz(1, { meta: { sent_at: '2026-10-01T08:00:00Z', nudged_at: '2026-10-01T20:00:00.000Z' } }),
        sentQuiz(2, { meta: { sent_at: '2026-10-01T10:00:00Z' } }),
      ],
    });
    expect((await Nudge.process(Q(2))).ok).toBe(true);
  });
});
