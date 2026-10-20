'use strict';
/**
 * nudges/address.js — where a proactive message to a teacher goes.
 *
 * Worker-side sends have no inbound message to reply to, so the address is
 * resolved from the database: the teacher's `user_channels` row with the most
 * recent activity, formatted as the identifier the messaging facade routes on
 * (a bare phone for WhatsApp, `slack:<id>` / `discord:<id>` for the additive
 * channels), falling back to `users.phone_number`. A channel this deployment
 * does not run is never chosen — the facade would hand `slack:U…` to the
 * WhatsApp driver.
 */

// Mocked at the client library (the network boundary): the real config/supabase.js loads and
// exports this in-memory client.
jest.mock('@supabase/supabase-js', () => {
  const { createMemorySupabase } = require('../fixtures/memory-supabase');
  const memory = createMemorySupabase();
  return { createClient: () => memory };
});
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const { addressForUser, lastActivityFor } = require('../../bot/shared/services/nudges/address');

const ENV_KEYS = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID'];
const saved = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  supabase.reset();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const USER = 'u-1';
const H = (h) => new Date(Date.UTC(2026, 2, 10, h)).toISOString();

function slackOn() {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-real';
  process.env.SLACK_SIGNING_SECRET = 'test-signing-not-real';
}

describe('addressForUser', () => {
  it('a WhatsApp teacher is addressed by their bare phone number', async () => {
    supabase.reset({
      users: [{ id: USER, phone_number: '15550001111', last_message_at: H(9) }],
      user_channels: [{ user_id: USER, channel: 'whatsapp', channel_user_id: '15550001111', is_primary: true, last_message_at: H(1) }],
    });
    const addr = await addressForUser(USER);
    // The WhatsApp row's own stamp is only written on insert; users.last_message_at is the live one.
    expect(addr).toEqual({ to: '15550001111', channel: 'whatsapp', lastMessageAt: H(9) });
  });

  it('prefers the channel the teacher used most recently, formatted with its prefix', async () => {
    slackOn();
    supabase.reset({
      users: [{ id: USER, phone_number: '15550001111', last_message_at: H(2) }],
      user_channels: [
        { user_id: USER, channel: 'whatsapp', channel_user_id: '15550001111', is_primary: true, last_message_at: H(1) },
        { user_id: USER, channel: 'slack', channel_user_id: 'U0TEST01', is_primary: false, last_message_at: H(8) },
      ],
    });
    expect(await addressForUser(USER)).toEqual({ to: 'slack:U0TEST01', channel: 'slack', lastMessageAt: H(8) });
  });

  it('never picks a channel this deployment does not run', async () => {
    // Slack env vars unset: Slack is not an active channel here.
    supabase.reset({
      users: [{ id: USER, phone_number: '15550001111', last_message_at: H(2) }],
      user_channels: [
        { user_id: USER, channel: 'whatsapp', channel_user_id: '15550001111', is_primary: true, last_message_at: H(1) },
        { user_id: USER, channel: 'slack', channel_user_id: 'U0TEST01', is_primary: false, last_message_at: H(8) },
      ],
    });
    expect(await addressForUser(USER)).toMatchObject({ to: '15550001111', channel: 'whatsapp' });
  });

  it('falls back to users.phone_number when there is no channel row', async () => {
    supabase.reset({ users: [{ id: USER, phone_number: '15550002222', last_message_at: H(5) }], user_channels: [] });
    expect(await addressForUser(USER)).toEqual({ to: '15550002222', channel: 'whatsapp', lastMessageAt: H(5) });
  });

  it('returns null when the teacher cannot be reached at all', async () => {
    supabase.reset({ users: [{ id: USER, phone_number: null, last_message_at: H(5) }], user_channels: [] });
    expect(await addressForUser(USER)).toBeNull();
  });

  it('returns null rather than throwing when the database read fails', async () => {
    supabase.reset({ users: [{ id: USER, phone_number: '15550002222' }] });
    supabase.failNext('user_channels', 'select');
    expect(await addressForUser(USER)).toBeNull();
  });
});

describe('lastActivityFor', () => {
  it('is the latest of users.last_message_at and every channel row, per user', async () => {
    supabase.reset({
      user_channels: [
        { user_id: 'a', channel: 'slack', channel_user_id: 'U1', last_message_at: H(8) },
        { user_id: 'b', channel: 'whatsapp', channel_user_id: '15550003333', last_message_at: H(1) },
      ],
    });
    const map = await lastActivityFor([
      { id: 'a', last_message_at: H(2) },
      { id: 'b', last_message_at: H(4) },
      { id: 'c', last_message_at: H(3) },
    ]);
    expect(map.get('a')).toBe(H(8));
    expect(map.get('b')).toBe(H(4));
    expect(map.get('c')).toBe(H(3));
  });
});

describe('the stored reply identifier', () => {
  // A background send must deliver back to the identifier the teacher actually wrote
  // from, never re-derive it from (channel, channel_user_id): a channel's wire identity
  // can differ from "<prefix>:<id>" (a short alias form, a re-encoded id).
  it('is used when it routes to that row\'s channel', async () => {
    slackOn();
    supabase.reset({
      users: [{ id: USER, phone_number: null, last_message_at: null }],
      user_channels: [{
        user_id: USER, channel: 'slack', channel_user_id: 'legacy-id', reply_identifier: 'slack:U0REAL',
        is_primary: true, last_message_at: H(5),
      }],
    });
    expect((await addressForUser(USER)).to).toBe('slack:U0REAL');
  });

  it('is ignored when it would route somewhere else, and the row is addressed the old way', async () => {
    slackOn();
    supabase.reset({
      users: [{ id: USER, phone_number: null, last_message_at: null }],
      user_channels: [{
        user_id: USER, channel: 'slack', channel_user_id: 'U0OLD', reply_identifier: '15550001111',
        is_primary: true, last_message_at: H(5),
      }],
    });
    expect((await addressForUser(USER)).to).toBe('slack:U0OLD');
  });
});
