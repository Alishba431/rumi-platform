/**
 * Diarization health: how many classroom recordings came back with speaker turns — and so with the [MM:SS]
 * timings lesson-plan fidelity needs.
 *
 * Only the diarized transcription branch writes timestamps. If diarization silently stops (a provider change, a
 * fallback to a model without it, a bug on the success branch), every lesson becomes "not assessed" and nothing
 * else looks wrong. So every classroom transcription records its outcome: a log line, and a daily counter in Redis
 * (rumi:diarization:<YYYY-MM-DD>:<diarized|not_diarized>, kept 8 days) that `rumi doctor` reads.
 * Recording never throws and never blocks a transcription.
 */
const { logToFile } = require('../../utils/logger');

const OUTCOMES = ['diarized', 'not_diarized'];
const KEEP_SECONDS = 8 * 24 * 60 * 60;
// Below this share of recordings with timings, doctor flags it.
const WARN_RATE = 0.8;

function dayKey(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function counterKey(outcome, daysAgo = 0) {
  return `rumi:diarization:${dayKey(daysAgo)}:${outcome}`;
}

/**
 * @param {'diarized'|'not_diarized'} outcome
 * @param {object} [detail] e.g. { model, source }
 */
async function recordDiarization(outcome, detail = {}) {
  const message = outcome === 'diarized'
    ? '[diarization] classroom transcription diarized'
    : '[diarization] classroom transcription NOT diarized — no [MM:SS] timings';
  logToFile(message, { outcome, ...detail });
  try {
    const redis = require('../cache/railway-redis.service');
    const key = counterKey(outcome);
    await redis.incr(key);
    await redis.expire(key, KEEP_SECONDS);
  } catch (e) {
    logToFile('[diarization] counter not recorded (non-critical)', { error: e.message });
  }
}

/**
 * @param {number} days
 * @param {{redis?: {get: Function}}} [deps]
 * @returns {Promise<{days:number, diarized:number, not_diarized:number, total:number, rate:number|null}>}
 */
async function diarizationStats(days = 7, deps = {}) {
  const redis = deps.redis || require('../cache/railway-redis.service');
  const totals = { diarized: 0, not_diarized: 0 };
  for (let d = 0; d < days; d += 1) {
    for (const outcome of OUTCOMES) {
      const n = Number(await redis.get(counterKey(outcome, d)));
      if (Number.isFinite(n)) totals[outcome] += n;
    }
  }
  const total = totals.diarized + totals.not_diarized;
  return { days, ...totals, total, rate: total ? Math.round((totals.diarized / total) * 1000) / 1000 : null };
}

/** The doctor line for these stats. */
function describeDiarization(stats) {
  if (!stats || !stats.total) {
    return { ok: true, detail: `no classroom recordings transcribed in the last ${stats ? stats.days : 7} days` };
  }
  const pct = Math.round(stats.rate * 100);
  const line = `${stats.diarized} of ${stats.total} classroom recordings in the last ${stats.days} days came back with speech timings (${pct}%)`;
  if (stats.rate < WARN_RATE) {
    return { ok: true, detail: `⚠️ ${line} — recordings without timings cannot be compared with a plan; check SONIOX_API_KEY and the transcription logs ([diarization])` };
  }
  return { ok: true, detail: line };
}

module.exports = { recordDiarization, diarizationStats, describeDiarization, dayKey, counterKey, WARN_RATE };
