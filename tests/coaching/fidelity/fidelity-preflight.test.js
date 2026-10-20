'use strict';
/**
 * Fidelity pre-flight: deterministic facts about the RECORDING (timestamps, where the transcript stops against the
 * audio, one collapsed block), persisted on every graded blob as telemetry. Pure module, no mocks.
 */
const preflight = require('../../../bot/shared/services/coaching/fidelity/fidelity-preflight');

const { describeRecording } = preflight;

describe('fidelity-preflight · describeRecording', () => {
  const T = '[00:03] Teacher (EN): Good morning, class\n\n[10:20] Teacher (EN): Open your copybooks\n\n[15:00] Student (EN): Is it three?\n\n[20:20] Teacher (EN): Thank you, everyone';

  test('counts the stamps and finds where the transcript ends', () => {
    expect(describeRecording(T, 1256)).toEqual({
      stamps: 4, no_timestamps: false, last_stamp_s: 1220, ends_at: '20:20',
      audio_s: 1256, transcript_short_of_audio: false, collapsed_block: false,
    });
  });

  test('a transcript that stops more than 90 s before the audio ends is short of the audio', () => {
    expect(describeRecording(T, 2138).transcript_short_of_audio).toBe(true);
    expect(describeRecording(T, 1310).transcript_short_of_audio).toBe(false);
    expect(describeRecording(T, 1311).transcript_short_of_audio).toBe(true);
  });

  test('an unknown, zero or junk audio duration never flags the tail', () => {
    for (const a of [null, undefined, 0, -5, 'abc']) {
      const r = describeRecording(T, a);
      expect(r.audio_s).toBe(null);
      expect(r.transcript_short_of_audio).toBe(false);
    }
  });

  test('one timestamped block holding at least 40% of the text is a collapsed block', () => {
    const big = '[00:10] a\n\n[08:04] ' + 'x'.repeat(4000) + '\n\n[42:40] end';
    expect(describeRecording(big, 2565).collapsed_block).toBe(true);
  });

  test('no timestamps is reported, never thrown', () => {
    expect(describeRecording('no stamps here', 900)).toMatchObject({
      stamps: 0, no_timestamps: true, last_stamp_s: null, ends_at: null, transcript_short_of_audio: false, collapsed_block: false,
    });
    expect(describeRecording(null, null).stamps).toBe(0);
  });

  test('one-digit and three-digit minute stamps count too', () => {
    expect(describeRecording('[5:07] a\n\n[105:10] b', 6400)).toMatchObject({ stamps: 2, last_stamp_s: 6310, ends_at: '105:10' });
  });

  test('the stamp pattern is one shared constant (the formatter, the guard and any repair read the same shape)', () => {
    expect(preflight.STAMP_RE.source).toBe('\\[(\\d{1,3}):(\\d{2})\\]');
    expect(preflight.hasTimestamps('[00:10] Teacher (EN): hello')).toBe(true);
    expect(preflight.hasTimestamps('hello, no stamps')).toBe(false);
    expect(preflight.hasTimestamps(null)).toBe(false);
  });
});
