'use strict';
/**
 * How long a recording must be before Rumi treats it as a classroom lesson (and starts coaching) rather than a voice
 * note was a 15-minute constant written in two places. It is now one setting, COACHING_MIN_AUDIO_SECONDS, default
 * 900 (unchanged): a deployment whose teachers record shorter segments can lower it, and short synthetic lessons can
 * exercise the coaching flow end to end.
 */
const { classroomAudioThresholdSeconds } = require('../../../bot/shared/config/coaching-audio');
const fs = require('fs');
const path = require('path');

describe('classroomAudioThresholdSeconds', () => {
  const saved = process.env.COACHING_MIN_AUDIO_SECONDS;
  afterEach(() => { if (saved === undefined) delete process.env.COACHING_MIN_AUDIO_SECONDS; else process.env.COACHING_MIN_AUDIO_SECONDS = saved; });

  test('unset → 900 seconds, as before', () => {
    delete process.env.COACHING_MIN_AUDIO_SECONDS;
    expect(classroomAudioThresholdSeconds()).toBe(900);
  });

  test('a deployment can lower or raise it', () => {
    process.env.COACHING_MIN_AUDIO_SECONDS = '180';
    expect(classroomAudioThresholdSeconds()).toBe(180);
  });

  test('junk, or anything under a minute, falls back to 900 (a voice note must never start a coaching session)', () => {
    for (const v of ['abc', '-5', '0', '30']) {
      process.env.COACHING_MIN_AUDIO_SECONDS = v;
      expect(classroomAudioThresholdSeconds()).toBe(900);
    }
  });

  test('both classroom-audio checks read the setting (voice note and audio sent as a document)', () => {
    const read = (p) => fs.readFileSync(path.resolve(__dirname, '../../../', p), 'utf8');
    for (const p of ['bot/shared/handlers/voice-message.handler.js', 'bot/whatsapp-bot.js']) {
      const src = read(p);
      expect(src).toContain('classroomAudioThresholdSeconds()');
      expect(src).not.toMatch(/CLASSROOM_AUDIO_THRESHOLD = 900/);
    }
  });
});

describe('resolveAudioDurationSeconds — channels that report no duration', () => {
  const { resolveAudioDurationSeconds } = require('../../../bot/shared/config/coaching-audio');

  test('a duration in the channel metadata is used as is, with no download', async () => {
    let downloaded = false;
    const r = await resolveAudioDurationSeconds('m1', { audio: { duration: 1200.4 } }, { downloadMedia: async () => { downloaded = true; }, measure: async () => 0 });
    expect(r).toEqual({ seconds: 1200.4, buffer: null });
    expect(downloaded).toBe(false);
  });

  test('no duration (Matrix, Slack, Discord) → the audio is downloaded once and measured; the buffer is handed back for reuse', async () => {
    const buf = Buffer.from('audio');
    const r = await resolveAudioDurationSeconds('m1', { mime_type: 'audio/ogg' }, { downloadMedia: async () => buf, measure: async (b) => (b === buf ? 261.1 : 0) });
    expect(r).toEqual({ seconds: 261.1, buffer: buf });
  });

  test('a measurement failure is 0 seconds (a voice note), never a throw', async () => {
    const r = await resolveAudioDurationSeconds('m1', {}, { downloadMedia: async () => Buffer.from('x'), measure: async () => { throw new Error('ffprobe'); } });
    expect(r.seconds).toBe(0);
  });

  test('the voice handler uses it', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../bot/shared/handlers/voice-message.handler.js'), 'utf8');
    expect(src).toContain('resolveAudioDurationSeconds(audioId, audioMetadata');
  });
});
