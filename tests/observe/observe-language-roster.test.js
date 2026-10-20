/**
 * Whose language is this (named audience, never the session join), the
 * terminal-status owner, and the DERIVED coach roster: a coach holds schools
 * (leader_schools); their teachers are whoever has users.school_id in those
 * schools — never a second stored list that can disagree with the first.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', name: 'Robin Coach', phone_number: '15550100001', preferred_language: 'en' },
    { id: 't-1', name: 'Sam Taylor', phone_number: '15550100002', preferred_language: 'sw', school_id: 'sch-1' },
    { id: 't-2', name: 'Alex Kim', phone_number: 'mtx:15550100003', preferred_language: 'en', school_id: 'sch-1' },
    { id: 't-3', name: 'Jo Park', phone_number: '15550100004', school_id: 'sch-2' },
    { id: 'coach-2', role: 'coach', name: 'Other Coach', phone_number: '15550100005', school_id: 'sch-1' },
  ],
  schools: [
    { id: 'sch-1', ext_id: 'S-001', name: 'Hillside Primary' },
    { id: 'sch-2', ext_id: 'S-002', name: 'Riverside Primary' },
    { id: 'sch-3', ext_id: 'S-003', name: 'Lakeside Primary' },
  ],
  leader_schools: [
    { id: 'ls-1', leader_user_id: 'coach-1', school_id: 'sch-1', school_ext_id: 'S-001', school_name: 'Hillside Primary' },
    { id: 'ls-2', leader_user_id: 'coach-1', school_id: 'sch-2', school_ext_id: 'S-002', school_name: 'Riverside Primary' },
  ],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const { languageFor } = require('../../bot/shared/services/observe/observe-language');
const { registerLanguagePack } = require('../../bot/shared/services/observe/observe-strings');
const { isTerminalStatus, TERMINAL_IN_FILTER } = require('../../bot/shared/services/observe/observe-terminal');
const Roster = require('../../bot/shared/services/observe/observe-roster.service');

describe('observe-language', () => {
  test('coach language comes from observer_user_id, teacher language from the bound teacher', async () => {
    registerLanguagePack('sw', { cancel_ack: '✅ Imeghairiwa.' });
    const bound = { user_id: 't-1', observer_user_id: 'coach-1' };
    expect(await languageFor('coach', bound)).toBe('en');
    expect(await languageFor('teacher', bound)).toBe('sw');
  });

  test('a bare capture (user_id = coach) never gives the teacher the coach\'s language', async () => {
    const bare = { user_id: 'coach-1', observer_user_id: 'coach-1' };
    expect(await languageFor('teacher', bare)).toBe('en');
  });

  test('a language with no pack renders in English; an unknown audience is a programming error', async () => {
    expect(await languageFor('teacher', { user_id: 't-3', observer_user_id: 'coach-1' })).toBe('en');
    await expect(languageFor('parent', {})).rejects.toThrow(/unknown audience/);
  });
});

describe('observe-terminal', () => {
  test('cancelled and abandoned are terminal; the filter spells the same set', () => {
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('abandoned')).toBe(true);
    expect(isTerminalStatus('awaiting_observer_review')).toBe(false);
    expect(isTerminalStatus(null)).toBe(false);
    expect(TERMINAL_IN_FILTER).toBe('(cancelled,abandoned)');
  });
});

describe('observe-roster (derived)', () => {
  test('listSchools returns the coach\'s schools, by name', async () => {
    const schools = await Roster.listSchools('coach-1');
    expect(schools.map((s) => s.name)).toEqual(['Hillside Primary', 'Riverside Primary']);
    expect(schools[0]).toMatchObject({ id: 'sch-1', ext_id: 'S-001' });
  });

  test('listTeachers derives teachers from users.school_id, excluding coaches, scoped to one school', async () => {
    const all = await Roster.listTeachers('coach-1');
    expect(all.map((t) => t.name).sort()).toEqual(['Alex Kim', 'Jo Park', 'Sam Taylor']);
    const one = await Roster.listTeachers('coach-1', { schoolId: 'sch-1' });
    expect(one.map((t) => t.name).sort()).toEqual(['Alex Kim', 'Sam Taylor']);
    expect(one.find((t) => t.name === 'Sam Taylor')).toMatchObject({
      user_id: 't-1', teacher_ext_id: 't-1', phone: '15550100002', school_id: 'sch-1', school_name: 'Hillside Primary', school_ext_id: 'S-001',
    });
  });

  test('a school the coach does not hold yields nobody', async () => {
    expect(await Roster.listTeachers('coach-1', { schoolId: 'sch-3' })).toEqual([]);
    expect(await Roster.listTeachers('nobody')).toEqual([]);
  });

  test('hasAssignment is true only for a coach with at least one school', async () => {
    expect(await Roster.hasAssignment('coach-1')).toBe(true);
    expect(await Roster.hasAssignment('coach-2')).toBe(false);
  });
});
