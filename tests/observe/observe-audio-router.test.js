/**
 * The ONE place that decides what a coach's audio means.
 *
 * Invariant: a coach's classroom-length recording NEVER starts the teacher
 * self-coaching path — not on a lost state, not on a Redis blip, not when the
 * channel gives no duration (Matrix sends file size only). A short clip with
 * nothing armed is the coach talking to Rumi and falls through.
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const { createFakeSupabase } = require('./_helpers/fake-supabase');
const mockDb = createFakeSupabase({ chat_sessions: [] });
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
const mockState = { value: null, throws: false };
jest.mock('../../bot/shared/services/observe/observe-state.service', () => ({
  getState: jest.fn(async () => { if (mockState.throws) throw new Error('redis down'); return mockState.value; }),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  getMediaInfo: jest.fn(async () => ({ file_size: 100 })),
  downloadMedia: jest.fn(async () => Buffer.from('x')),
  sendMessage: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/services/audio.service', () => ({ getAudioDuration: jest.fn(async () => 1500) }));
const mockCapture = { startFromAudio: jest.fn(async () => ({ id: 'obs-1' })) };
jest.mock('../../bot/shared/services/observe/observe-capture.service', () => mockCapture);
// The park is its own module (observe-binding.test.js runs it for real); here
// only the router's decision is under test.
const mockBinding = { parkAndAsk: jest.fn(async () => ({ action: 'asked' })), rememberCaptured: jest.fn(async () => {}) };
jest.mock('../../bot/shared/services/observe/observe-binding.service', () => mockBinding);

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const { routeLeaderAudio, hasDeclaredDcIntent } = require('../../bot/shared/services/observe/observe-audio-router');

const COACH = { id: 'coach-1', role: 'coach', preferred_language: 'en' };
const PRINCIPAL = { id: 'p-1', role: 'principal', preferred_language: 'en' };
const args = (over = {}) => ({ user: COACH, from: '15550100001', audioId: 'media-1', sessionId: 'chat-1', ...over });

describe('observe audio router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OBSERVE_ENABLED = 'true';
    mockState.value = null;
    mockState.throws = false;
  });

  test('off, or a teacher: never handled', async () => {
    delete process.env.OBSERVE_ENABLED;
    expect(await routeLeaderAudio(args({ durationSeconds: 2000 }))).toBe(false);
    process.env.OBSERVE_ENABLED = 'true';
    expect(await routeLeaderAudio(args({ user: { id: 't', role: null }, durationSeconds: 2000 }))).toBe(false);
  });

  test('armed awaiting_audio: any length is captured, with the resolved duration', async () => {
    mockState.value = { state: 'awaiting_audio' };
    expect(await routeLeaderAudio(args({ durationSeconds: 30 }))).toBe(true);
    expect(mockCapture.startFromAudio).toHaveBeenCalledWith(COACH, '15550100001', 'media-1', 'chat-1', 30);
  });

  test('nothing armed + classroom length: parked and the coach asked whose it is — never self-coaching', async () => {
    expect(await routeLeaderAudio(args({ durationSeconds: 1800, sha256: 'abc', mimeType: 'audio/ogg' }))).toBe(true);
    expect(mockCapture.startFromAudio).not.toHaveBeenCalled();
    expect(mockBinding.parkAndAsk).toHaveBeenCalledWith(COACH, '15550100001', {
      audioId: 'media-1', sha256: 'abc', durationSeconds: 1800, mimeType: 'audio/ogg', sessionId: 'chat-1',
    });
  });

  test('the park failing (Redis down) still holds the invariant: the coach is told to start from /observe', async () => {
    mockBinding.parkAndAsk.mockRejectedValueOnce(new Error('redis down'));
    expect(await routeLeaderAudio(args({ durationSeconds: 1800 }))).toBe(true);
    expect(WhatsAppService.sendMessage.mock.calls[0][1]).toMatch(/type \/observe first/);
  });

  test('an armed capture is remembered, so an identical re-send is recognised later', async () => {
    mockState.value = { state: 'awaiting_audio', boundTeacher: { name: 'Sam Taylor' } };
    await routeLeaderAudio(args({ durationSeconds: 1800, sha256: 'abc' }));
    expect(mockBinding.rememberCaptured).toHaveBeenCalledWith('coach-1', expect.objectContaining({ audioId: 'media-1', sha256: 'abc' }), { id: 'obs-1' }, 'Sam Taylor');
  });

  test('no duration from the channel but a large file: probes the bytes and still holds the invariant', async () => {
    WhatsAppService.getMediaInfo.mockResolvedValueOnce({ file_size: 2_000_000 });
    expect(await routeLeaderAudio(args())).toBe(true);
    expect(WhatsAppService.downloadMedia).toHaveBeenCalledWith('media-1');
  });

  test('a lost state (Redis error) fails safe for classroom-length audio', async () => {
    mockState.throws = true;
    expect(await routeLeaderAudio(args({ durationSeconds: 1800 }))).toBe(true);
    expect(await routeLeaderAudio(args({ durationSeconds: 20 }))).toBe(false);
  });

  test('the classroom line follows COACHING_MIN_AUDIO_SECONDS, the one the self-coaching path uses', async () => {
    // Lowered to 10 minutes: a 12-minute lesson is classroom audio for self-coaching,
    // so it must be an observation here — or it would fall through and start the coach's own coaching.
    process.env.COACHING_MIN_AUDIO_SECONDS = '600';
    try {
      expect(await routeLeaderAudio(args({ durationSeconds: 720 }))).toBe(true);
      expect(mockBinding.parkAndAsk).toHaveBeenCalled();
      expect(await routeLeaderAudio(args({ durationSeconds: 300 }))).toBe(false);   // still a voice note
    } finally {
      delete process.env.COACHING_MIN_AUDIO_SECONDS;
    }
  });

  test('a short clip with nothing armed is the coach talking — falls through to chat', async () => {
    expect(await routeLeaderAudio(args({ durationSeconds: 20 }))).toBe(false);
  });

  test('a principal who asked for their OWN coaching gets self-coaching; a coach never does', async () => {
    const declared = { current_state: 'AWAITING_CLASSROOM_AUDIO', awaiting_audio_since: new Date().toISOString() };
    expect(hasDeclaredDcIntent(declared)).toBe(true);
    expect(hasDeclaredDcIntent({ current_state: 'AWAITING_CLASSROOM_AUDIO', awaiting_audio_since: '2020-01-01T00:00:00Z' })).toBe(false);
    expect(hasDeclaredDcIntent(null)).toBe(false);
    mockDb.tables.chat_sessions.push({ id: 'chat-1', conversation_state: declared });
    expect(await routeLeaderAudio(args({ user: PRINCIPAL, durationSeconds: 1800 }))).toBe(false);
    expect(await routeLeaderAudio(args({ user: COACH, durationSeconds: 1800 }))).toBe(true);
    mockDb.tables.chat_sessions.length = 0;
  });

  test('a capture error is reported and still never falls through', async () => {
    mockState.value = { state: 'awaiting_audio' };
    mockCapture.startFromAudio.mockRejectedValueOnce(new Error('boom'));
    expect(await routeLeaderAudio(args({ durationSeconds: 1800 }))).toBe(true);
    expect(WhatsAppService.sendMessage).toHaveBeenCalled();
  });
});
