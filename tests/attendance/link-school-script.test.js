/**
 * bot/scripts/attendance/link-school.js — how a deployment turns staff attendance on.
 *
 * A head teacher's "attendance" is staff attendance once three things are true: a
 * school exists, the head teacher is linked to it with role head_teacher, and their
 * colleagues are linked to it. Staff who never use the bot can be added by name.
 *
 * A person is named the way an operator knows them: a users.id, a WhatsApp number,
 * or a channel identity ("slack:U0123", "matrix:@ivy:example.org").
 */

const { createAttendanceDb } = require('./_helpers/attendance-db');

let mockDb;
// Mocked at the client library (the network boundary): the real config/supabase.js loads and hands
// every service this in-memory client.
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (t) => mockDb.client.from(t) }) }));

const linkSchool = require('../../bot/scripts/attendance/link-school');

beforeEach(() => {
  mockDb = createAttendanceDb({
    users: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Grace Hall', phone_number: '15550100009' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Amara Okafor', phone_number: null },
    ],
    user_channels: [
      { user_id: '22222222-2222-4222-8222-222222222222', channel: 'matrix', channel_user_id: '@amara:rumi.local' },
    ],
  });
});

describe('parseArgs', () => {
  it('reads repeated --staff and --staff-name', () => {
    expect(linkSchool.parseArgs([
      '--school', 'Hillside Primary', '--ext-id', 'HP-01', '--head', '15550100009',
      '--staff', 'matrix:@amara:rumi.local', '--staff-name', 'Chen Rao', '--staff-name', 'Ben Ito',
    ])).toEqual({
      school: 'Hillside Primary', extId: 'HP-01', head: '15550100009',
      staff: ['matrix:@amara:rumi.local'], staffNames: ['Chen Rao', 'Ben Ito'],
    });
  });
});

describe('resolveUser', () => {
  it('finds a person by id, by WhatsApp number and by channel identity', async () => {
    expect((await linkSchool.resolveUser('11111111-1111-4111-8111-111111111111')).name).toBe('Grace Hall');
    expect((await linkSchool.resolveUser('+1 555 010 0009')).name).toBe('Grace Hall');
    expect((await linkSchool.resolveUser('matrix:@amara:rumi.local')).name).toBe('Amara Okafor');
  });

  it('returns null for someone it cannot find', async () => {
    expect(await linkSchool.resolveUser('slack:UNOBODY')).toBeNull();
  });
});

describe('linkSchool', () => {
  it('creates the school, links the head teacher and the staff, and adds name-only staff', async () => {
    const result = await linkSchool.linkSchool({
      school: 'Hillside Primary', extId: 'HP-01', head: '15550100009',
      staff: ['matrix:@amara:rumi.local'], staffNames: ['Chen Rao'],
    });

    const [school] = mockDb.rowsOf('schools');
    expect(school).toMatchObject({ name: 'Hillside Primary', ext_id: 'HP-01' });

    const byName = Object.fromEntries(mockDb.rowsOf('users').map((u) => [u.name, u]));
    expect(byName['Grace Hall']).toMatchObject({ school_id: school.id, role: 'head_teacher' });
    expect(byName['Amara Okafor']).toMatchObject({ school_id: school.id });
    expect(byName['Amara Okafor'].role).toBeFalsy();
    expect(byName['Chen Rao']).toMatchObject({ school_id: school.id });
    expect(byName['Chen Rao'].phone_number ?? null).toBeNull();
    expect(result.missing).toEqual([]);
  });

  it('is idempotent: running it twice reuses the school and does not duplicate name-only staff', async () => {
    const args = { school: 'Hillside Primary', extId: 'HP-01', head: '15550100009', staff: [], staffNames: ['Chen Rao'] };
    await linkSchool.linkSchool(args);
    await linkSchool.linkSchool(args);
    expect(mockDb.rowsOf('schools')).toHaveLength(1);
    expect(mockDb.rowsOf('users').filter((u) => u.name === 'Chen Rao')).toHaveLength(1);
  });

  it('reports people it could not find instead of failing the whole link', async () => {
    const result = await linkSchool.linkSchool({
      school: 'Hillside Primary', head: '15550100009', staff: ['slack:UNOBODY'], staffNames: [],
    });
    expect(result.missing).toEqual(['slack:UNOBODY']);
    expect(mockDb.rowsOf('schools')).toHaveLength(1);
  });

  it('refuses to run without a head teacher it can find', async () => {
    await expect(linkSchool.linkSchool({ school: 'Hillside Primary', head: '15559999999', staff: [], staffNames: [] }))
      .rejects.toThrow(/head teacher/i);
    expect(mockDb.rowsOf('schools')).toHaveLength(0);
  });
});
