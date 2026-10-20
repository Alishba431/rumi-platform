'use strict';
/**
 * The timestamp input contract, end to end through the REAL transcription code.
 *
 * Lesson-plan fidelity can only judge a recording whose transcript carries [MM:SS] stamps, and only the diarized
 * branch of audio.service writes them (one stamp per speaker turn). A regression on that branch is silent: in a
 * deployment fork, a single undefined variable on the diarization-success path made every good transcription throw
 * and fall back to a non-diarized model; transcripts lost their stamps across the whole fleet for days, and the only
 * symptom was "not assessed" everywhere. So:
 *   1. a test that runs the real diarization-success branch (Soniox mocked at the HTTP boundary) and checks the
 *      stamps the contract needs are there;
 *   2. the non-diarized branch → no stamps → fidelity refuses with no model call;
 *   3. a counter, recorded on every classroom transcription, that makes a silent loss of timestamps visible
 *      (a log line per recording, daily counts in Redis, shown by `rumi doctor`).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logWarn: jest.fn() }));
const mockCounts = {};
jest.mock('../../../bot/shared/services/cache/railway-redis.service', () => ({
  incr: jest.fn(async (k) => { mockCounts[k] = (mockCounts[k] || 0) + 1; return mockCounts[k]; }),
  expire: jest.fn(async () => true),
  get: jest.fn(async (k) => (mockCounts[k] != null ? String(mockCounts[k]) : null)),
}));

const axios = require('axios');
const { logToFile } = require('../../../bot/shared/utils/logger');
const AudioService = require('../../../bot/shared/services/audio.service');
const { describeRecording } = require('../../../bot/shared/services/coaching/fidelity/fidelity-preflight');
const { computeLpFidelity } = require('../../../bot/shared/services/coaching/fidelity/fidelity-orchestrator');
const { diarizationStats, dayKey } = require('../../../bot/shared/services/coaching/diarization-health');

const tok = (text, speaker, start) => ({ text, speaker, start_ms: start, end_ms: start + 400, language: 'en' });
const DIARIZED_TOKENS = [
  tok('Good ', '1', 0), tok('morning. ', '1', 400), tok('Fold ', '1', 800), tok('the ', '1', 1200), tok('strip.', '1', 1600),
  tok('Three ', '2', 12000), tok('fifths!', '2', 12400),
  tok('Well ', '1', 15000), tok('done.', '1', 15400),
];

function sonioxReturns(tokens, text) {
  axios.post.mockReset();
  axios.get.mockReset();
  axios.delete.mockReset();
  axios.post
    .mockResolvedValueOnce({ data: { id: 'file-1' } }) // upload
    .mockResolvedValueOnce({ data: { id: 'tr-1' } }); // create transcription
  axios.get
    .mockResolvedValueOnce({ data: { status: 'completed' } })
    .mockResolvedValueOnce({ data: { text, tokens } });
  axios.delete.mockResolvedValue({ data: {} });
}

let audioPath;
beforeAll(() => {
  audioPath = path.join(os.tmpdir(), `diarization-contract-${process.pid}.ogg`);
  fs.writeFileSync(audioPath, Buffer.from('OggS fake audio'));
});
afterAll(() => { try { fs.unlinkSync(audioPath); } catch (_) { /* gone */ } });
beforeEach(() => { for (const k of Object.keys(mockCounts)) delete mockCounts[k]; logToFile.mockClear(); });

describe('the diarization branch of audio.service (real code, Soniox mocked at HTTP)', () => {
  test('diarized tokens → a transcript with one [MM:SS] stamp per speaker turn, counted as diarized', async () => {
    sonioxReturns(DIARIZED_TOKENS, 'Good morning. Fold the strip. Three fifths! Well done.');
    const result = await AudioService.transcribe(audioPath, true);
    expect(result.text).toMatch(/^\[00:00\] Teacher \(EN\): Good morning\. Fold the strip\./);
    expect(result.text).toContain('[00:12] Student (EN): Three fifths!');
    expect(describeRecording(result.text).stamps).toBe(3);
    expect(mockCounts[`rumi:diarization:${dayKey()}:diarized`]).toBe(1);
    expect(logToFile).toHaveBeenCalledWith('[diarization] classroom transcription diarized', expect.objectContaining({ outcome: 'diarized' }));
  }, 15000);

  test('tokens without speakers → raw text with no stamps, counted as NOT diarized, and fidelity refuses with no model call', async () => {
    sonioxReturns(DIARIZED_TOKENS.map(({ speaker, ...t }) => t), 'Good morning. Fold the strip. Three fifths! Well done.');
    const result = await AudioService.transcribe(audioPath, true);
    expect(describeRecording(result.text).no_timestamps).toBe(true);
    expect(mockCounts[`rumi:diarization:${dayKey()}:not_diarized`]).toBe(1);
    expect(logToFile).toHaveBeenCalledWith('[diarization] classroom transcription NOT diarized — no [MM:SS] timings', expect.objectContaining({ outcome: 'not_diarized' }));

    let modelCalls = 0;
    const r = await computeLpFidelity(
      { planText: 'Warm up, explain with strips, model an example, pair practice, exit ticket — a real plan.', source: 'pasted', transcript: result.text },
      { extractPlanMoves: async () => { modelCalls += 1; return { moves: [] }; }, analyzeFidelity: async () => { modelCalls += 1; return {}; } },
    );
    expect(r).toMatchObject({ status: 'ok', fidelity_pct: null, unusable_guard: 'no_timestamps' });
    expect(modelCalls).toBe(0);
  }, 15000);

  test('a voice note (no diarization asked for) is not counted', async () => {
    sonioxReturns(DIARIZED_TOKENS.map(({ speaker, ...t }) => t), 'hello');
    await AudioService.transcribe(audioPath, false);
    expect(Object.keys(mockCounts)).toHaveLength(0);
  }, 15000);
});

describe('diarizationStats', () => {
  test('sums the last N days and gives the rate', async () => {
    const redis = { get: async (k) => ({ [`rumi:diarization:${dayKey(0)}:diarized`]: '9', [`rumi:diarization:${dayKey(1)}:diarized`]: '2', [`rumi:diarization:${dayKey(1)}:not_diarized`]: '1' }[k] || null) };
    expect(await diarizationStats(7, { redis })).toEqual({ days: 7, diarized: 11, not_diarized: 1, total: 12, rate: 0.917 });
  });

  test('no recordings → rate null, never a division by zero', async () => {
    expect(await diarizationStats(7, { redis: { get: async () => null } })).toEqual({ days: 7, diarized: 0, not_diarized: 0, total: 0, rate: null });
  });
});

describe('rumi doctor shows it', () => {
  const { describeDiarization } = require('../../../bot/shared/services/coaching/diarization-health');

  test.each([
    [{ total: 0, diarized: 0, not_diarized: 0, rate: null, days: 7 }, /no classroom recordings/],
    [{ total: 12, diarized: 11, not_diarized: 1, rate: 0.917, days: 7 }, /11 of 12 classroom recordings .* speech timings \(92%\)/],
  ])('%j', (stats, re) => {
    expect(describeDiarization(stats).detail).toMatch(re);
  });

  test('a low rate is flagged — every recording without timings is a lesson fidelity cannot judge', () => {
    expect(describeDiarization({ total: 10, diarized: 4, not_diarized: 6, rate: 0.4, days: 7 }).detail).toMatch(/⚠️/);
  });
});

describe('the doctor probe', () => {
  test('feature off → off, with what to set', async () => {
    const { defaultProbes } = require('../../../bot/scripts/setup/doctor');
    const r = await defaultProbes.diarization({ SONIOX_API_KEY: 'k' });
    expect(r).toEqual({ ok: false, detail: 'set: LP_FIDELITY_ENABLED=true and SONIOX_API_KEY' });
  });

  test('feature on without Redis → on, and says how to see the counts', async () => {
    const { defaultProbes } = require('../../../bot/scripts/setup/doctor');
    const r = await defaultProbes.diarization({ SONIOX_API_KEY: 'k', LP_FIDELITY_ENABLED: 'true' });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/REDIS_URL/);
  });
});
