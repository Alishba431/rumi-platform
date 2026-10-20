'use strict';
/**
 * One attempt per child (review F-S9): the FIRST completed attempt is the one
 * that counts. Each answer's feedback shows the right option, and re-joining is
 * never blocked, so a retake after seeing the reasons is not the child's
 * standing — counting the latest would let any child score full marks.
 */
const { oneAttemptPerChild } = require('../../bot/shared/services/quiz/one-attempt-per-child');

const at = (h) => `2026-09-01T${String(h).padStart(2, '0')}:00:00.000Z`;

test('a retake after the first completed attempt does not replace it', () => {
  const kept = oneAttemptPerChild([
    { id: 'a', student_id: 's1', status: 'completed', created_at: at(7), completed_at: at(8), correct_answers: 2 },
    { id: 'b', student_id: 's1', status: 'completed', created_at: at(8), completed_at: at(9), correct_answers: 5 },
  ]);
  expect(kept.map((s) => s.id)).toEqual(['a']);
});

test('the order the rows arrive in does not matter', () => {
  const kept = oneAttemptPerChild([
    { id: 'b', student_id: 's1', status: 'completed', created_at: at(8), completed_at: at(9) },
    { id: 'a', student_id: 's1', status: 'completed', created_at: at(7), completed_at: at(8) },
  ]);
  expect(kept.map((s) => s.id)).toEqual(['a']);
});

test('a completed attempt beats a later unfinished one', () => {
  const kept = oneAttemptPerChild([
    { id: 'a', student_id: 's1', status: 'completed', created_at: at(7), completed_at: at(8) },
    { id: 'b', student_id: 's1', status: 'in_progress', created_at: at(10), completed_at: null },
  ]);
  expect(kept.map((s) => s.id)).toEqual(['a']);
});

test('with nothing completed, the latest row shows the child as started', () => {
  const kept = oneAttemptPerChild([
    { id: 'a', student_id: 's1', status: 'abandoned', created_at: at(7), completed_at: null },
    { id: 'b', student_id: 's1', status: 'in_progress', created_at: at(9), completed_at: null },
  ]);
  expect(kept.map((s) => s.id)).toEqual(['b']);
});

test('one row per child; rows without a student pass through', () => {
  const kept = oneAttemptPerChild([
    { id: 'a', student_id: 's1', status: 'completed', created_at: at(7), completed_at: at(8) },
    { id: 'c', student_id: 's2', status: 'completed', created_at: at(7), completed_at: at(9) },
    { id: 'x', student_id: null, status: 'completed', created_at: at(7), completed_at: at(8) },
  ]);
  expect(kept.map((s) => s.id).sort()).toEqual(['a', 'c', 'x']);
});
