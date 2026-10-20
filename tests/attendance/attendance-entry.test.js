/**
 * The chat door into attendance — what text-message.handler hands a message to.
 *
 * Pinned here, end to end through the real conversation service, delivery and
 * register (database, Redis and the channel are the only stand-ins):
 *   - "attendance 30 sep" opens that day; a future day is refused in words
 *   - a head teacher's "attendance" is staff attendance
 *   - a channel with no native form gets the marking form as sendFlow's text
 *     stand-in, carrying the right token for a class or for staff
 *   - "everyone present" saves the named day and sends the register
 *   - the sixth start in five minutes is told to wait, not met with silence
 */

const fs = require('fs');
const { createAttendanceDb } = require('./_helpers/attendance-db');

let mockDb;
const mockRedis = new Map();
const mockSendMessage = jest.fn();
const mockSendFlow = jest.fn();
const mockSendDocument = jest.fn();
const mockSent = [];

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
  ttl: jest.fn(async () => 120),
}));
jest.mock('../../bot/shared/storage/r2', () => ({
  uploadBuffer: jest.fn(), isR2Configured: () => false, getSignedUrl: jest.fn(),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: (...a) => mockSendMessage(...a),
  sendFlow: (...a) => mockSendFlow(...a),
  sendDocument: (...a) => mockSendDocument(...a),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));

const AttendanceEntry = require('../../bot/shared/services/attendance-entry.service');

const TEACHER = { id: 'u1' };
const HEAD = { id: 'h1' };
const FROM = 'matrix:@ivy:rumi.local';
const typing = { stop: jest.fn() };

function seed() {
  mockDb = createAttendanceDb({
    schools: [{ id: 'sch1', name: 'Hillside Primary' }],
    users: [
      { id: 'u1', name: 'Ivy Park', role: null, school_id: 'sch1' },
      { id: 'h1', name: 'Grace Hall', role: 'head_teacher', school_id: 'sch1' },
      { id: 't1', name: 'Amara Okafor', role: null, school_id: 'sch1' },
    ],
    student_lists: [{ id: 'L1', user_id: 'u1', class_name: 'Grade 5', section: 'A', is_active: true, created_at: '2026-01-01' }],
    students: [
      { id: 'k1', list_id: 'L1', roll_number: 1, student_name: 'Dana Lee', is_active: true },
      { id: 'k2', list_id: 'L1', roll_number: 2, student_name: 'Eli Moss', is_active: true },
    ],
  });
}

/** One chat turn: the in-session door first, then the trigger door — the handler's order. */
async function say(user, text) {
  const handledInSession = await AttendanceEntry.handleInSession({ user, from: FROM, messageBody: text, typingController: typing });
  if (handledInSession) return true;
  return AttendanceEntry.handleTrigger({ user, from: FROM, messageBody: text, typingController: typing });
}

const replies = () => mockSendMessage.mock.calls.map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.clear();
  mockSent.length = 0;
  seed();
  mockSendMessage.mockResolvedValue(true);
  mockSendFlow.mockResolvedValue(true);
  mockSendDocument.mockImplementation(async (to, filePath, fileName, caption) => {
    mockSent.push({ to, fileName, caption, buffer: fs.readFileSync(filePath) });
    return true;
  });
});

it('ignores a message that is not about attendance', async () => {
  expect(await say(TEACHER, 'make me a lesson plan on fractions')).toBe(false);
});

it('"attendance 30 sep" opens that day and says so', async () => {
  expect(await say(TEACHER, 'attendance 30 sep')).toBe(true);
  expect(replies().pop()).toMatch(/30 September/);
});

it('a future day is refused in words, and nothing opens', async () => {
  await say(TEACHER, 'attendance 2099-01-01');
  expect(replies().pop()).toMatch(/future/i);
  expect(mockRedis.has('attendance:session:u1')).toBe(false);
});

it('the teacher\'s tap-to-mark opens the text stand-in with the class token for the named day', async () => {
  await say(TEACHER, 'attendance 2026-09-30');
  await say(TEACHER, '2');
  expect(mockSendFlow).toHaveBeenCalledTimes(1);
  const [to, opts] = mockSendFlow.mock.calls[0];
  expect(to).toBe(FROM);
  expect(opts.flowKind).toBe('attendance-mark');
  expect(opts.flowToken).toBe('u1:L1:2026-09-30:full_day:Grade%205');
});

it('a head teacher\'s "attendance" is staff attendance, and tap opens the staff form', async () => {
  await say(HEAD, 'attendance');
  expect(replies().pop()).toMatch(/Staff attendance — Hillside Primary/);
  await say(HEAD, '2');
  const [, opts] = mockSendFlow.mock.calls[0];
  expect(opts.flowToken).toMatch(/^h1:staff:\d{4}-\d{2}-\d{2}:full_day:Hillside%20Primary$/);
  expect(opts.header).toMatch(/Staff/);
});

it('"everyone present" saves the named day and sends that month\'s register', async () => {
  await say(TEACHER, 'attendance 2026-09-30');
  await say(TEACHER, '3');

  expect(mockDb.rowsOf('attendance_sessions')[0]).toMatchObject({
    session_date: '2026-09-30', present_count: 2, marking_method: 'everyone_present',
  });
  expect(mockSent[0].fileName).toBe('Attendance_Grade_5_A_September_2026.xlsx');
  expect(mockSent[0].to).toBe(FROM);
  expect(mockRedis.has('attendance:session:u1')).toBe(false);
});

it('a head teacher\'s "everyone present" writes the staff day', async () => {
  await say(HEAD, 'attendance yesterday');
  await say(HEAD, 'everyone present');
  expect(mockDb.rowsOf('teacher_attendance_records').map((r) => r.status)).toEqual(['present', 'present']);
  expect(mockSent[0].fileName).toMatch(/^Staff_Attendance_Hillside_Primary_/);
});

it('the sixth start in five minutes is told to wait', async () => {
  mockRedis.set('attendance:ratelimit:u1', { count: 5, windowStart: Date.now() });
  await say(TEACHER, 'attendance');
  expect(replies().pop()).toMatch(/Too Many Requests/);
});
