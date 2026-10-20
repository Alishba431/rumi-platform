/**
 * A coach's calendar address is matched only when the match can be justified —
 * exact name, the mailbox's first.last, or the same words in another order.
 * Never a similarity score, never a subset: one wrong match puts a school visit
 * on a stranger's calendar.
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const CD = require('../../bot/shared/services/observe/coach-directory');

describe('coach directory matching', () => {
  test('invisible characters and punctuation do not block a match', () => {
    expect(CD.normalizeCoachName('‎Sam  Taylor-Reed ')).toBe('sam taylor reed');
    expect(CD.nameFromEmail('sam.taylor@example.org')).toBe('sam taylor');
  });

  test('matches on the full name, the mailbox, or the same words reordered', () => {
    expect(CD.matchesRosterName('Sam Taylor', 'Sam Taylor', 'x@example.org')).toBe(true);
    expect(CD.matchesRosterName('Sam Taylor', 'Sam', 'sam.taylor@example.org')).toBe(true);
    expect(CD.matchesRosterName('Taylor Sam', 'Sam Taylor', null)).toBe(true);
  });

  test('a subset or a near-miss is NOT a match', () => {
    expect(CD.matchesRosterName('Sam', 'Sam Taylor', 'sam.taylor@example.org')).toBe(false);
    expect(CD.matchesRosterName('Sam Tailor', 'Sam Taylor', 'sam.taylor@example.org')).toBe(false);
  });

  test('two candidates for one name is ambiguous and goes to a person', () => {
    const r = CD.resolveRosterName('Sam Taylor', [
      { name: 'Sam Taylor', email: 'sam.taylor@example.org' },
      { name: 'Taylor Sam', email: 'st2@example.org' },
    ]);
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(CD.resolveRosterName('Sam Taylor', [{ name: 'Ana Fox', email: 'ana@example.org' }]).reason).toBe('no_match');
    expect(CD.resolveRosterName('', []).reason).toBe('no_input');
  });
});
