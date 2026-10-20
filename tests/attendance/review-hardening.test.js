/**
 * Hardening found in independent review: a correction never loses the day on
 * file, the fallback text offers only replies that work, class names with a
 * slash are not read as dates, and the staff guards at submit time hold.
 */
const { createAttendanceDb } = require('./_helpers/attendance-db');

let mockDb;
const mockRedis = new Map();
const mockSendMessage = jest.fn().mockResolvedValue(true);
const mockSendFlow = jest.fn().mockResolvedValue(false);

jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (t) => mockDb.client.from(t) }) }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async (k) => (mockRedis.has(k) ? mockRedis.get(k) : null)),
  set: jest.fn(async (k, v) => { mockRedis.set(k, v); return true; }),
  delete: jest.fn(async (k) => { mockRedis.delete(k); return true; }),
  incr: jest.fn(async () => 1),
  expire: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: (...a) => mockSendMessage(...a),
  sendFlow: (...a) => mockSendFlow(...a),
  sendDocument: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/storage/r2', () => ({
  uploadBuffer: jest.fn(), isR2Configured: () => false, getSignedUrl: jest.fn(),
}));

const Entry = require('../../bot/shared/services/attendance-entry.service');
const Staff = require('../../bot/shared/services/staff-attendance.service');
const Delivery = require('../../bot/shared/services/attendance-delivery.service');
const FlowHandler = require('../../bot/shared/handlers/attendance-flow.handler');
const dates = require('../../bot/shared/services/attendance-dates');

const SCHOOL = { id: 'sch1', name: 'Hillside Primary', ext_id: null };

function seed() {
  mockDb = createAttendanceDb({
    student_lists: [{ id: 'L1', user_id: 'u1', class_name: 'Grade 5', section: 'A', is_active: true, created_at: '2026-01-01' }],
    users: [
      { id: 'u1', name: 'Ivy Park', role: null, school_id: 'sch1' },
      { id: 'h1', name: 'Grace Hall', role: 'head_teacher', school_id: 'sch1' },
    ],
    schools: [SCHOOL],
    students: [
      { id: 'k1', list_id: 'L1', roll_number: 1, student_name: 'Dana Lee', is_active: true },
      { id: 'k2', list_id: 'L1', roll_number: 2, student_name: 'Eli Moss', is_active: true },
    ],
  });
}

const classDay = (k2, date = '2026-09-04') => ({
  selectedClass: { id: 'L1', class_name: 'Grade 5', section: 'A' }, selectedListId: 'L1',
  markingMethod: 'tap', sessionDate: date,
  records: [
    { studentId: 'k1', studentName: 'Dana Lee', status: 'present' },
    { studentId: 'k2', studentName: 'Eli Moss', status: k2 },
  ],
});

beforeEach(() => { jest.clearAllMocks(); mockRedis.clear(); seed(); });

describe('correcting a day never loses the day on file', () => {
  it('keeps the previous records when writing the new ones fails', async () => {
    const first = await Delivery.processAndDeliver('u1', '15550100001', classDay('absent'));
    expect(first.saved).toBe(true);
    expect(mockDb.rowsOf('attendance_records')).toHaveLength(2);

    // The database refuses the rewrite (a constraint, a timeout, a dropped connection).
    const realFrom = mockDb.client.from;
    mockDb.client.from = (t) => {
      const b = realFrom(t);
      if (t === 'attendance_records') {
        b.insert = () => ({ then: (res) => res({ data: null, error: { message: 'simulated insert failure' } }) });
      }
      return b;
    };
    const second = await Delivery.processAndDeliver('u1', '15550100001', classDay('leave'));
    mockDb.client.from = realFrom;

    expect(second.success).toBe(false);
    const kept = mockDb.rowsOf('attendance_records');
    expect(kept.map((r) => r.status).sort()).toEqual(['absent', 'present']);
    // …and the session's tallies still describe the records on file.
    const [session] = mockDb.rowsOf('attendance_sessions');
    expect(session).toMatchObject({ present_count: 1, absent_count: 1, leave_count: 0 });
  });

  it('a successful correction leaves exactly the new records', async () => {
    await Delivery.processAndDeliver('u1', '15550100001', classDay('absent'));
    await Delivery.processAndDeliver('u1', '15550100001', classDay('leave'));
    expect(mockDb.rowsOf('attendance_records').map((r) => r.status).sort()).toEqual(['leave', 'present']);
    expect(mockDb.rowsOf('attendance_sessions')).toHaveLength(1);
  });

  it('only the teacher whose class it is can file or replace its day', async () => {
    mockDb.rowsOf('users').push({ id: 'u2', name: 'Other Teacher', role: null });
    await Delivery.processAndDeliver('u1', '15550100001', classDay('present'));
    const other = await Delivery.processAndDeliver('u2', '15550100002', classDay('absent'));
    expect(other.saved).not.toBe(true);
    expect(mockDb.rowsOf('attendance_records').every((r) => r.status === 'present')).toBe(true);
  });
});

describe('when the marking form cannot be sent', () => {
  it('"Reply 3 if everyone is present" marks everyone present', async () => {
    const user = { id: 'u1' };
    await Entry.handleTrigger({ user, from: '15550100001', messageBody: 'attendance' });
    await Entry.handleInSession({ user, from: '15550100001', messageBody: '2' });
    const offered = mockSendMessage.mock.calls.map((c) => c[1]).pop();
    expect(offered).toMatch(/\*3\* if everyone is present/);

    mockSendMessage.mockClear();
    await Entry.handleInSession({ user, from: '15550100001', messageBody: '3' });
    const reply = mockSendMessage.mock.calls.map((c) => c[1]).join('\n');
    expect(reply).not.toMatch(/reply "yes" to confirm/i);
    expect(reply).toMatch(/Generating/i);
  });

  it('"Reply 1" starts the voice roll call', async () => {
    const user = { id: 'u1' };
    await Entry.handleTrigger({ user, from: '15550100001', messageBody: 'attendance' });
    await Entry.handleInSession({ user, from: '15550100001', messageBody: '2' });
    mockSendMessage.mockClear();
    await Entry.handleInSession({ user, from: '15550100001', messageBody: '1' });
    expect(mockSendMessage.mock.calls.map((c) => c[1]).join('\n')).toMatch(/Voice Roll Call/);
  });
});

describe('a class name with a slash is not a date', () => {
  const now = new Date('2026-10-02T09:00:00Z');
  it.each([
    'attendance class 9/10',
    'attendance for grade 5/6',
    'attendance section 1/2',
    'attendance 3 marks',
    'attendance 9/10', // bare and ambiguous: 9 October is ahead, so it would be last year — open today instead
  ])('%s opens today', (text) => {
    expect(dates.parseRequestedDate(text, now)).toBeNull();
  });

  it.each([
    ['attendance 30/9', '2026-09-30'],
    ['attendance 30/9/2026', '2026-09-30'],
    ['attendance 3 mar', null], // more than 62 days back — refused below, not read as a class
    ['attendance 30 sept', '2026-09-30'],
    ['attendance september 30', '2026-09-30'],
  ])('%s is still a day', (text, expected) => {
    const parsed = dates.parseRequestedDate(text, now);
    if (expected) expect(parsed).toEqual({ date: expected });
    else expect(parsed).toEqual({ error: 'too_old', maxBack: 62 });
  });
});

describe('staff attendance is refused at submit time for anyone but a linked head teacher', () => {
  const flowMessage = { interactive: { nfm_reply: { response_json: JSON.stringify({ absent_students: [], leave_students: [] }) } } };

  it('the Flow submission refuses a staff token from a teacher', async () => {
    const result = await FlowHandler.handleMarkingFlowSubmission(
      flowMessage, '15550100001', 'u1', FlowHandler.STAFF_TARGET, '2026-09-04', 'full_day',
    );
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/head teacher/);
  });

  it('the Flow submission accepts the same token from the head teacher', async () => {
    const result = await FlowHandler.handleMarkingFlowSubmission(
      flowMessage, '15550100009', 'h1', FlowHandler.STAFF_TARGET, '2026-09-04', 'full_day',
    );
    expect(result.success).not.toBe(false);
  });

  it('saving a staff session as a teacher writes nothing', async () => {
    const result = await Staff.saveAndDeliver('u1', '15550100001', {
      subject: 'staff', sessionDate: '2026-09-04', markingMethod: 'tap',
      records: [{ studentId: 'h1', studentName: 'Grace Hall', status: 'present' }],
    });
    expect(result).toMatchObject({ success: false, saved: false });
    expect(mockDb.rowsOf('teacher_attendance_records')).toHaveLength(0);
  });

  it('a head teacher whose school was unlinked writes nothing either', async () => {
    mockDb.rowsOf('users').find((u) => u.id === 'h1').school_id = null;
    const result = await Staff.saveAndDeliver('h1', '15550100009', {
      subject: 'staff', sessionDate: '2026-09-04', markingMethod: 'tap',
      records: [{ studentId: 'u1', studentName: 'Ivy Park', status: 'present' }],
    });
    expect(result).toMatchObject({ success: false, saved: false });
    expect(mockDb.rowsOf('teacher_attendance_records')).toHaveLength(0);
  });
});

describe('a correction whose cleanup fails', () => {
  it('removes the new records again, so the day holds only what was on file', async () => {
    await Delivery.processAndDeliver('u1', '15550100001', classDay('absent'));
    // The first delete (removing the old records) fails; the next one (taking the new ones back) works.
    const realFrom = mockDb.client.from;
    let deletes = 0;
    mockDb.client.from = (t) => {
      const b = realFrom(t);
      if (t === 'attendance_records') {
        const del = b.delete;
        b.delete = (...a) => {
          deletes += 1;
          if (deletes === 1) return { in: () => ({ then: (res) => res({ data: null, error: { message: 'simulated delete failure' } }) }) };
          return del.apply(b, a);
        };
      }
      return b;
    };
    const second = await Delivery.processAndDeliver('u1', '15550100001', classDay('leave'));
    mockDb.client.from = realFrom;
    expect(second.success).toBe(false);
    expect(mockDb.rowsOf('attendance_records').map((r) => r.status).sort()).toEqual(['absent', 'present']);
  });
});

describe('every date in the message is considered, and the class word may be punctuated', () => {
  const now = new Date('2026-10-02T09:00:00Z');
  it.each([
    ['attendance grade 5 sep 30', { date: '2026-09-30' }],
    ['attendance class 9/10 for 30/9', { date: '2026-09-30' }],
    ['attendance class: 1/10', null],
    ['attendance class-1/10', null],
    ['attendance cls 1/10', null],
    ['attendance class #1/10', null],
  ])('%s', (text, expected) => {
    expect(dates.parseRequestedDate(text, now)).toEqual(expected);
  });
});

describe('the method menu always names the day being marked', () => {
  const Conversation = require('../../bot/shared/services/attendance-conversation.service');
  it('names today when no day was asked for', () => {
    const msg = Conversation.generateMarkingMethodMessage({ class_name: 'Grade 5', section: 'A' });
    expect(msg).toContain(`📅 ${dates.formatDisplayDate(dates.todayString())}`);
  });
});
