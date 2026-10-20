'use strict';
/**
 * The inbound path records the exact identifier a teacher wrote from on their
 * user_channels row (`reply_identifier`), so a later proactive send — a nudge, with
 * no inbound message to reply to — can deliver back to it instead of re-deriving it.
 */

// Mocked at the client library — the network boundary — so the real
// config/supabase.js loads and hands bot-helpers this in-memory client. (Mocking
// config/supabase.js itself is what the bot-helpers suites in tests/database do,
// and on a warm jest cache that mock is intermittently not the module bot-helpers
// receives; the library boundary does not depend on it.)
const mockMemory = require('../fixtures/memory-supabase').createMemorySupabase();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mockMemory }));

const supabase = mockMemory;
const { getOrCreateUserByChannel } = require('../../bot/shared/database/bot-helpers');

beforeEach(() => supabase.reset());

it('stamps the reply identifier on an existing channel link', async () => {
  supabase.reset({
    users: [{ id: 'u-1', registration_completed: true }],
    user_channels: [{ id: 'c-1', user_id: 'u-1', channel: 'slack', channel_user_id: 'U1', last_message_at: null }],
  });
  await getOrCreateUserByChannel('slack', 'U1', { replyIdentifier: 'slack:U1' });
  expect(supabase.rows('user_channels')[0]).toMatchObject({ reply_identifier: 'slack:U1' });
});

it('records it on a brand-new channel link', async () => {
  supabase.reset({ users: [], user_channels: [] });
  await getOrCreateUserByChannel('discord', '42', { replyIdentifier: 'discord:42' });
  expect(supabase.rows('user_channels')[0]).toMatchObject({ channel: 'discord', channel_user_id: '42', reply_identifier: 'discord:42' });
});

it('leaves it alone when the caller does not pass one', async () => {
  supabase.reset({
    users: [{ id: 'u-1' }],
    user_channels: [{ id: 'c-1', user_id: 'u-1', channel: 'slack', channel_user_id: 'U1', reply_identifier: 'slack:U1' }],
  });
  await getOrCreateUserByChannel('slack', 'U1');
  expect(supabase.rows('user_channels')[0].reply_identifier).toBe('slack:U1');
});
