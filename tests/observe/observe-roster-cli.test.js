/**
 * The roster CLI a partner runs to set up coaches, schools and teachers —
 * no forms, no Flows, any channel.
 *
 *   grant-coach <phone> [role]
 *   add-school  <coach-phone> <school-ext-id> <school name…>
 *   add-teacher <teacher-phone> <school-ext-id> [name…]
 *   import      <csv>   coach_phone,school_ext_id,school_name,teacher_phone,teacher_name
 *   list        <coach-phone>
 *   set-email   <coach-phone> <email> [full name…]
 *
 * Phones may be channel identities (mtx:…, slack:…). The roster stays DERIVED:
 * a teacher belongs to a school through users.school_id, nothing else.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockDb = createFakeSupabase({ users: [], user_channels: [], schools: [], leader_schools: [], coach_directory: [] });
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const Cli = require('../../bot/scripts/observe-roster');
const Roster = require('../../bot/shared/services/observe/observe-roster.service');

const out = () => {
  const lines = [];
  return { log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(`ERR ${a.join(' ')}`), lines };
};

beforeEach(() => {
  for (const k of Object.keys(mockDb.tables)) mockDb.tables[k].length = 0;
  delete process.env.OBSERVE_SCHOOL_ID_PREFIX;
  delete process.env.OBSERVE_ROSTER_SOURCE;
});

describe('observe roster CLI', () => {
  test('grant-coach creates or promotes the user; phones are normalised, channel identities kept', async () => {
    mockDb.tables.users.push({ id: 'u-1', phone_number: '15550100001', role: null });
    expect(await Cli.main(['grant-coach', '+1 555 010 0001'], out())).toBe(0);
    expect(mockDb.tables.users[0].role).toBe('coach');
    expect(await Cli.main(['grant-coach', 'mtx:15550100002', 'principal'], out())).toBe(0);
    // A Matrix person is stored the way the bot stores them: no phone number,
    // a user_channels row — so their first message finds THIS row, not a new one.
    const link = mockDb.tables.user_channels.find((c) => c.channel === 'matrix' && c.channel_user_id === '15550100002');
    expect(link).toBeTruthy();
    // One role vocabulary across releases: principal / school_leader are READ
    // aliases of head_teacher; a leader is always WRITTEN as head_teacher.
    expect(mockDb.tables.users.find((u) => u.id === link.user_id)).toMatchObject({ role: 'head_teacher', phone_number: null });
    const o = out();
    expect(await Cli.main(['grant-coach', '15550100003', 'janitor'], o)).toBe(1);
    expect(o.lines.join('\n')).toMatch(/not a coach role/);
  });

  test('the confirmation names the identity given — a Matrix/Slack person has no phone number to print', async () => {
    const o = out();
    expect(await Cli.main(['grant-coach', 'mtx:15550100004'], o)).toBe(0);
    expect(await Cli.main(['grant-coach', 'slack:U0COACH', 'principal'], o)).toBe(0);
    expect(await Cli.main(['add-school', 'mtx:15550100004', 'SCH-1', 'Hill School'], o)).toBe(0);
    expect(await Cli.main(['add-teacher', 'discord:4242', 'SCH-1'], o)).toBe(0);
    expect(await Cli.main(['list', 'slack:U0COACH'], o)).toBe(0);
    expect(o.lines).toEqual(expect.arrayContaining([
      '✓ mtx:15550100004 is a coach',
      '✓ slack:U0COACH is a head_teacher',
      '✓ discord:4242 is at Hill School (SCH-1)',
      'slack:U0COACH (head_teacher)',
    ]));
    expect(o.lines.join('\n')).not.toMatch(/null/);
  });

  test('someone who already messaged the bot on Matrix (user_channels only) is found, not duplicated', async () => {
    mockDb.tables.users.push({ id: 'mx-1', phone_number: null, role: null });
    mockDb.tables.user_channels.push({ user_id: 'mx-1', channel: 'matrix', channel_user_id: '1555400011' });
    expect(await Cli.main(['grant-coach', 'mtx:1555400011'], out())).toBe(0);
    expect(mockDb.tables.users).toHaveLength(1);
    expect(mockDb.tables.users[0].role).toBe('coach');
  });

  test('add-school links a coach to a school (prefixed), creating the school; re-running is a no-op', async () => {
    process.env.OBSERVE_SCHOOL_ID_PREFIX = 'district-a:';
    process.env.OBSERVE_ROSTER_SOURCE = 'import';
    await Cli.main(['grant-coach', '15550100001'], out());
    expect(await Cli.main(['add-school', '15550100001', 'SCH-1', 'Hill', 'School'], out())).toBe(0);
    expect(await Cli.main(['add-school', '15550100001', 'SCH-1', 'Hill', 'School'], out())).toBe(0);
    expect(mockDb.tables.schools).toEqual([expect.objectContaining({ ext_id: 'district-a:SCH-1', name: 'Hill School' })]);
    expect(mockDb.tables.leader_schools).toEqual([expect.objectContaining({
      school_id: mockDb.tables.schools[0].id, school_ext_id: 'district-a:SCH-1', school_name: 'Hill School', source: 'import',
    })]);
  });

  test('add-school refuses someone who is not a coach yet', async () => {
    mockDb.tables.users.push({ id: 'u-9', phone_number: '15550100009', role: 'teacher' });
    const o = out();
    expect(await Cli.main(['add-school', '15550100009', 'SCH-1', 'Hill School'], o)).toBe(1);
    expect(o.lines.join('\n')).toMatch(/grant-coach/);
  });

  test('add-teacher sets users.school_id (creating the school if needed) and the coach sees them', async () => {
    await Cli.main(['grant-coach', '15550100001'], out());
    await Cli.main(['add-school', '15550100001', 'SCH-1', 'Hill School'], out());
    expect(await Cli.main(['add-teacher', '15550100201', 'SCH-1', 'Avery', 'Stone'], out())).toBe(0);
    expect(await Cli.main(['add-teacher', 'slack:U0TEACH', 'SCH-2'], out())).toBe(0);
    const avery = mockDb.tables.users.find((u) => u.phone_number === '15550100201');
    expect(avery).toMatchObject({ name: 'Avery Stone', school_id: mockDb.tables.schools[0].id });
    expect(mockDb.tables.schools.map((s) => s.ext_id)).toEqual(['SCH-1', 'SCH-2']);
    const coach = mockDb.tables.users.find((u) => u.phone_number === '15550100001');
    expect((await Roster.listTeachers(coach.id)).map((t) => t.name)).toEqual(['Avery Stone']);
  });

  test('import reads the CSV (quoted fields too), keeps going past a bad row, and reports it', async () => {
    const csv = [
      'coach_phone,school_ext_id,school_name,teacher_phone,teacher_name',
      '15550100001,SCH-1,"Hill School, East",15550100201,Avery Stone',
      '15550100001,SCH-1,"Hill School, East",15550100202,"Blake Reed"',
      ',SCH-2,River School,mtx:15550100203,Casey Park',
      'not-a-phone,SCH-3,Lake School,,',
    ].join('\r\n');
    const file = path.join(os.tmpdir(), `roster-${Date.now()}.csv`);
    fs.writeFileSync(file, csv);
    const o = out();
    expect(await Cli.main(['import', file], o)).toBe(1);   // one bad row → non-zero, the rest applied
    expect(o.lines.join('\n')).toMatch(/row 5/);
    const coach = mockDb.tables.users.find((u) => u.phone_number === '15550100001');
    expect(coach.role).toBe('coach');
    expect(mockDb.tables.leader_schools).toHaveLength(1);
    expect(mockDb.tables.schools.find((s) => s.ext_id === 'SCH-1').name).toBe('Hill School, East');
    expect((await Roster.listTeachers(coach.id)).map((t) => t.name)).toEqual(['Avery Stone', 'Blake Reed']);
    const mx = mockDb.tables.user_channels.find((c) => c.channel === 'matrix' && c.channel_user_id === '15550100203');
    expect(mockDb.tables.users.find((u) => u.id === mx.user_id).school_id)
      .toBe(mockDb.tables.schools.find((s) => s.ext_id === 'SCH-2').id);
    fs.unlinkSync(file);
  });

  test('import never demotes a principal to coach', async () => {
    mockDb.tables.users.push({ id: 'p-1', phone_number: '15550100007', role: 'principal' });
    const file = path.join(os.tmpdir(), `roster-p-${Date.now()}.csv`);
    fs.writeFileSync(file, 'coach_phone,school_ext_id,school_name,teacher_phone,teacher_name\n15550100007,SCH-1,Hill School,,\n');
    expect(await Cli.main(['import', file], out())).toBe(0);
    expect(mockDb.tables.users[0].role).toBe('principal');
    fs.unlinkSync(file);
  });

  test('list prints the coach\'s schools and teachers; set-email stores the calendar address', async () => {
    await Cli.main(['grant-coach', '15550100001'], out());
    await Cli.main(['add-school', '15550100001', 'SCH-1', 'Hill School'], out());
    await Cli.main(['add-teacher', '15550100201', 'SCH-1', 'Avery Stone'], out());
    const o = out();
    expect(await Cli.main(['list', '15550100001'], o)).toBe(0);
    expect(o.lines.join('\n')).toMatch(/Hill School[\s\S]*Avery Stone/);
    expect(await Cli.main(['set-email', '15550100001', 'coach.one@example.org', 'Coach', 'One'], out())).toBe(0);
    expect(mockDb.tables.coach_directory).toEqual([expect.objectContaining({ work_email: 'coach.one@example.org', full_name: 'Coach One', match_method: 'manual' })]);
    expect(await Cli.main(['set-email', '15550100001', 'nope'], out())).toBe(1);
  });

  test('no command / unknown command prints usage and fails', async () => {
    const o = out();
    expect(await Cli.main([], o)).toBe(1);
    expect(o.lines.join('\n')).toMatch(/grant-coach/);
    expect(await Cli.main(['frobnicate'], out())).toBe(1);
  });
});
