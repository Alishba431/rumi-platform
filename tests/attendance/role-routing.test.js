/**
 * What "attendance" means depends on who says it.
 *
 *   teacher       → their class (one class: straight to marking; several: which one?)
 *   head teacher  → the school's staff, always — the role has already answered
 *                   "whose attendance?". "class attendance" still reaches their class.
 *
 * And a day can be named: "attendance yesterday" / "attendance 30 sep" opens that
 * day, so a past day can be corrected.
 *
 * Runs the real conversation service against an in-memory database and Redis.
 */

const { createAttendanceDb } = require('./_helpers/attendance-db');

let mockDb;
const mockRedis = new Map();

// Mocked at the client library (the network boundary): the real config/supabase.js loads and hands
// every service this in-memory client.
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (t) => mockDb.client.from(t) }) }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async (k) => (mockRedis.has(k) ? mockRedis.get(k) : null)),
  set: jest.fn(async (k, v) => { mockRedis.set(k, v); return true; }),
  delete: jest.fn(async (k) => { mockRedis.delete(k); return true; }),
  incr: jest.fn(async () => 1),
  expire: jest.fn(async () => true),
}));

const Conversation = require('../../bot/shared/services/attendance-conversation.service');

function seed({ headSchool = 'sch1', staff = true } = {}) {
  mockDb = createAttendanceDb({
    schools: [{ id: 'sch1', name: 'Hillside Primary' }],
    users: [
      { id: 'u1', name: 'Ivy Park', role: null, school_id: 'sch1' },
      { id: 'h1', name: 'Grace Hall', role: 'head_teacher', school_id: headSchool },
      ...(staff ? [
        { id: 't1', name: 'Amara Okafor', role: null, school_id: 'sch1' },
        { id: 't2', name: 'Ben Ito', role: null, school_id: 'sch1' },
      ] : []),
    ],
    student_lists: [
      { id: 'L1', user_id: 'u1', class_name: 'Grade 5', section: 'A', is_active: true, created_at: '2026-01-01' },
      { id: 'L9', user_id: 'h1', class_name: 'Grade 6', section: null, is_active: true, created_at: '2026-01-01' },
    ],
    students: [
      { id: 'k1', list_id: 'L1', roll_number: 1, student_name: 'Dana Lee', is_active: true },
      { id: 'k2', list_id: 'L1', roll_number: 2, student_name: 'Eli Moss', is_active: true },
      { id: 'k9', list_id: 'L9', roll_number: 1, student_name: 'Gus Ray', is_active: true },
    ],
  });
}

const session = (userId) => {
  const v = mockRedis.get(`attendance:session:${userId}`);
  return typeof v === 'string' ? JSON.parse(v) : (v || null);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.clear();
  seed();
});

describe('a teacher', () => {
  it('goes straight to their only class', async () => {
    const result = await Conversation.startAttendanceSession('u1');
    expect(result.action).toBe('ASK_MARKING_METHOD');
    expect(result.message).toContain('Grade 5 - A');
    expect(session('u1')).toMatchObject({ subject: 'class', selectedListId: 'L1' });
  });
});

describe('a head teacher', () => {
  it('is taken to staff attendance, not asked which class', async () => {
    const result = await Conversation.startAttendanceSession('h1');
    expect(result.action).toBe('ASK_MARKING_METHOD');
    expect(result.message).toMatch(/staff attendance/i);
    expect(result.message).toContain('Hillside Primary');
    expect(session('h1')).toMatchObject({ subject: 'staff', schoolId: 'sch1' });
    expect(session('h1').students.map((s) => s.student_name)).toEqual(['Amara Okafor', 'Ben Ito', 'Ivy Park']);
  });

  it('still reaches their own class when they ask for class attendance', async () => {
    const result = await Conversation.startAttendanceSession('h1', { subject: 'class' });
    expect(result.message).toContain('Grade 6');
    expect(session('h1')).toMatchObject({ subject: 'class', selectedListId: 'L9' });
  });

  it('who is not linked to a school is told so, not dropped into a dead end', async () => {
    seed({ headSchool: null });
    const result = await Conversation.startAttendanceSession('h1');
    expect(result.action).toBe('ERROR');
    expect(result.message).toMatch(/not linked to a school/i);
    expect(session('h1')).toBeNull();
  });

  it('whose school has nobody on the staff list is told so', async () => {
    seed({ staff: false });
    mockDb.tables.users = mockDb.rowsOf('users').filter((u) => u.id !== 'u1');
    const result = await Conversation.startAttendanceSession('h1');
    expect(result.action).toBe('ERROR');
    expect(result.message).toMatch(/no staff/i);
  });

  it('tap-to-mark opens the staff roster', async () => {
    await Conversation.startAttendanceSession('h1');
    const result = await Conversation.handleMarkingMethodSelection('h1', '2');
    expect(result.action).toBe('SEND_MARKING_FLOW');
    expect(result.students.map((s) => s.id)).toEqual(['t1', 't2', 'u1']);
  });

  it('"everyone present" marks the whole staff present', async () => {
    await Conversation.startAttendanceSession('h1');
    const result = await Conversation.handleEveryonePresent('h1');
    expect(result.action).toBe('GENERATE_ATTENDANCE');
    expect(result.records.map((r) => [r.studentId, r.status])).toEqual([['t1', 'present'], ['t2', 'present'], ['u1', 'present']]);
  });
});

describe('a named day', () => {
  it('opens that day, and says which day it is', async () => {
    const result = await Conversation.startAttendanceSession('u1', { selectedDate: '2026-09-30' });
    expect(session('u1').selectedDate).toBe('2026-09-30');
    expect(result.message).toContain('Wednesday 30 September 2026');
  });

  it('defaults to today in the school\'s timezone', async () => {
    const AttendanceDates = require('../../bot/shared/services/attendance-dates');
    await Conversation.startAttendanceSession('u1');
    expect(session('u1').selectedDate).toBe(AttendanceDates.todayString());
  });
});

describe('the marking menu', () => {
  it('offers "everyone present" as a numbered option, not a hidden shortcut', async () => {
    const result = await Conversation.startAttendanceSession('u1');
    expect(result.message).toMatch(/3\. Everyone present/);
  });
});

describe('voice verification', () => {
  it('lists who is on leave beside who is absent', () => {
    const message = Conversation.generateVerificationMessage(
      [
        { studentName: 'Dana Lee', status: 'present' },
        { studentName: 'Eli Moss', status: 'absent' },
        { studentName: 'Fay Ng', status: 'leave' },
      ],
      { present: 1, absent: 1, leave: 1, attendancePercentage: 33 },
      { class_name: 'Grade 5', section: 'A' },
    );
    expect(message).toMatch(/On leave: 1/);
    expect(message).toContain('Fay Ng');
  });
});

describe('voice verification for staff', () => {
  it('names staff attendance and uses the staff rate', () => {
    const message = Conversation.generateVerificationMessage(
      [
        { studentName: 'Amara Okafor', status: 'present' },
        { studentName: 'Ben Ito', status: 'leave' },
      ],
      { present: 1, absent: 0, leave: 1, attendancePercentage: 50 },
      { class_name: 'Hillside Primary' },
      '',
      { subject: 'staff' },
    );
    expect(message).toMatch(/Staff attendance — Hillside Primary/);
    expect(message).toMatch(/Attendance: 100%/);
  });
});
