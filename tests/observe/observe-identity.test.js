/**
 * Where a person can be reached. users.phone_number is the identity only for
 * WhatsApp: someone who first reached Rumi on Matrix, Slack or Discord has no
 * phone number at all, just user_channels rows. Every observe send to a person
 * the bot is not currently replying to (the coach's form from a worker, the
 * teacher's report, a sweep's reminder) resolves the address here.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockDb = createFakeSupabase({
  users: [
    { id: 'wa-1', phone_number: '15550100009' },
    { id: 'mx-1', phone_number: null },
    { id: 'mx-2', phone_number: null },
    { id: 'sl-1', phone_number: null },
    { id: 'none', phone_number: null },
    { id: 'both', phone_number: '15550100077' },
  ],
  user_channels: [
    { user_id: 'mx-1', channel: 'matrix', channel_user_id: '1555400001', last_message_at: '2026-10-02T10:00:00Z' },
    { user_id: 'mx-2', channel: 'matrix', channel_user_id: '@robin:example.org', last_message_at: '2026-10-02T10:00:00Z' },
    { user_id: 'sl-1', channel: 'matrix', channel_user_id: '1555400099', last_message_at: '2026-09-01T10:00:00Z' },
    { user_id: 'sl-1', channel: 'slack', channel_user_id: 'U0123', last_message_at: '2026-10-01T10:00:00Z' },
    { user_id: 'both', channel: 'whatsapp', channel_user_id: '15550100077', last_message_at: '2026-09-01T10:00:00Z' },
    { user_id: 'both', channel: 'matrix', channel_user_id: '1555400077', last_message_at: '2026-10-02T09:00:00Z' },
  ],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const Identity = require('../../bot/shared/services/observe/observe-identity');

describe('observe-identity', () => {
  test('wireIdentity: the address the messaging router understands, per channel', () => {
    expect(Identity.wireIdentity('whatsapp', '15550100001')).toBe('15550100001');
    expect(Identity.wireIdentity('matrix', '1555400001')).toBe('mtx:1555400001');
    expect(Identity.wireIdentity('matrix', '@robin:example.org')).toBe('matrix:@robin:example.org');
    expect(Identity.wireIdentity('slack', 'U0123')).toBe('slack:U0123');
    expect(Identity.wireIdentity('discord', '9182')).toBe('discord:9182');
  });

  test('identityForUser: the channel they last used, else the phone number on file', async () => {
    expect(await Identity.identityForUser('wa-1')).toBe('15550100009');
    expect(await Identity.identityForUser('mx-1')).toBe('mtx:1555400001');
    expect(await Identity.identityForUser('mx-2')).toBe('matrix:@robin:example.org');
    expect(await Identity.identityForUser('sl-1')).toBe('slack:U0123');
    expect(await Identity.identityForUser('none')).toBeNull();
    // Someone on two channels is reached where they last talked, not on the
    // phone number just because one is on file.
    expect(await Identity.identityForUser('both')).toBe('mtx:1555400077');
    expect(await Identity.identityForUser(null)).toBeNull();
  });

  test('identitiesForUsers: one batch lookup for a roster', async () => {
    const map = await Identity.identitiesForUsers(['wa-1', 'mx-1', 'none']);
    expect(map.get('wa-1')).toBe('15550100009');
    expect(map.get('mx-1')).toBe('mtx:1555400001');
    expect(map.has('none')).toBe(false);
  });

  test('userIdForIdentity: back from an address to the person, on any channel', async () => {
    expect(await Identity.userIdForIdentity('15550100009')).toBe('wa-1');
    expect(await Identity.userIdForIdentity('mtx:1555400001')).toBe('mx-1');
    expect(await Identity.userIdForIdentity('matrix:@robin:example.org')).toBe('mx-2');
    expect(await Identity.userIdForIdentity('slack:U0123')).toBe('sl-1');
    expect(await Identity.userIdForIdentity('mtx:15559999999')).toBeNull();
  });

  test('candidatesForTypedNumber: a number a coach typed may be a WhatsApp or a Matrix person', () => {
    expect(Identity.candidatesForTypedNumber('+1 555 400 0001')).toEqual(['15554000001', '+15554000001', 'mtx:15554000001']);
    expect(Identity.candidatesForTypedNumber('call me')).toEqual([]);
  });
});
