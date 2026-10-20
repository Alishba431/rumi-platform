'use strict';
/**
 * A teacher's self-test retires only the stray rows of that teacher joining
 * their OWN class link as a child (review F-S11) — never the teacher's own
 * children, who share the handset and were filed under the teacher whose quiz
 * brought them in. A teacher is often a parent on the same number.
 *
 * Driven through the real resolveSelfTest; only the store and loggers are
 * stand-ins.
 */
const { createMemorySupabase } = require('./helpers/memory-supabase');

let mockMem;
jest.mock('../../bot/shared/config/supabase', () => ({
  from: (t) => mockMem.from(t),
  rpc: (...a) => mockMem.rpc(...a),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const SelfTest = require('../../bot/shared/services/quiz/teacher-self-test');

const PHONE = '15550105555';
const TEACHER = 'u-teacher';

beforeEach(() => {
  mockMem = createMemorySupabase({
    users: [{ id: TEACHER, phone_number: PHONE, name: 'Teacher Example' }],
    students: [
      // The teacher, joined to their own class link as a child before the
      // self-test path existed.
      { id: 'st-stray', student_name: 'Teacher Example', phone: PHONE, list_id: null, is_active: true, enrolled_by_user_id: TEACHER },
      // The teacher's own child, who joined another teacher's quiz on this phone.
      { id: 'st-own-child', student_name: 'Child Example', phone: PHONE, list_id: null, is_active: true, enrolled_by_user_id: 'u-other-teacher' },
      // A child on the same phone with no recorded teacher.
      { id: 'st-unknown', student_name: 'Child Two', phone: PHONE, list_id: null, is_active: true, enrolled_by_user_id: null },
    ],
  });
});

const active = () => mockMem.tables.students.filter((s) => s.is_active).map((s) => s.id).sort();

test('the teacher is recognised, and only rows their own quiz filed are retired', async () => {
  const self = await SelfTest.resolveSelfTest({ phone: PHONE, teacherUserId: TEACHER });
  expect(self).toEqual(expect.objectContaining({ userId: TEACHER }));
  expect(active()).toEqual(['st-own-child', 'st-unknown']);
});

test('retireQuizStudentRows without a teacher retires nothing', async () => {
  expect(await SelfTest.retireQuizStudentRows(PHONE, 'self_test')).toBe(0);
  expect(active()).toEqual(['st-own-child', 'st-stray', 'st-unknown']);
});
