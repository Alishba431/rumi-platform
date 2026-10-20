'use strict';
/**
 * How the teacher-nudge sweep is scheduled — two ways, one kind list:
 *
 *   1. In-process, on `bot/workers/sqs-worker.js`: this suite drives the REAL
 *      `startWorker()` with fake timers. Everything it touches that reaches a
 *      socket is mocked at its boundary (express, SQS, the recovery services,
 *      the database); the wiring under test — the boot-time flag gate, the
 *      90-second first run, the TEACHER_NUDGES_SWEEP_MINUTES interval, the
 *      shutdown skip — is the shipped code, and the proof is that the sweeper's
 *      `runSweep` is actually called (or not) once the clock is advanced. A
 *      source grep would pass on a setInterval inside an `if` nobody enters.
 *
 *   2. One-shot, `bot/workers/teacher-nudges.worker.js`, for a deployment that
 *      prefers cron: `main()` runs one sweep and returns.
 *
 * Unset flag = a complete no-op in both: nothing registered, nothing armed.
 */

// ── boundaries ───────────────────────────────────────────────────────────────
function mockThenable(result) {
  const b = {};
  for (const op of ['select', 'eq', 'neq', 'is', 'not', 'gte', 'lte', 'lt', 'gt', 'in', 'order', 'limit', 'range', 'update', 'insert']) {
    b[op] = () => b;
  }
  b.single = async () => result;
  b.maybeSingle = async () => result;
  b.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return b;
}
jest.mock('../../bot/shared/config/supabase', () => ({ from: () => mockThenable({ data: [], error: null }) }));

const mockLog = jest.fn();
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: (...a) => mockLog(...a) }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({
  runWithCorrelation: (_id, fn) => fn(),
  generateCorrelationId: () => 'corr-test',
}));
jest.mock('express', () => {
  const app = { get: jest.fn(), use: jest.fn(), post: jest.fn(), listen: jest.fn(() => ({ close: jest.fn() })) };
  const express = () => app;
  express.json = () => (_q, _s, next) => next && next();
  return express;
});
jest.mock('../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn(), queueVideoJob: jest.fn() }));
jest.mock('../../bot/shared/services/coaching-orchestrator.service', () => ({}));
jest.mock('../../bot/shared/services/lesson-plan-queue.service', () => ({
  getStaleRequests: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../bot/workers/lesson-plan-extraction.worker', () => ({}));
jest.mock('../../bot/workers/lesson-plan-generation.worker', () => ({}));
jest.mock('../../bot/workers/video-generation.worker', () => ({}));
jest.mock('../../bot/workers/exam-grading.worker', () => ({
  recoverStaleExamSessions: jest.fn().mockResolvedValue(undefined),
}));

// The module under observation: the sweeper. Real in its own suite; a spy here,
// with the real flag reading so the boot gate sees what the tick would see.
const mockRunSweep = jest.fn().mockResolvedValue({ claimed: 0 });
const mockRegister = jest.fn();
jest.mock('../../bot/shared/services/nudges/teacher-nudges.sweeper', () => ({
  register: (...a) => mockRegister(...a),
  runSweep: (...a) => mockRunSweep(...a),
  isEnabled: () => require('../../bot/shared/services/nudges/flags').flagOn('TEACHER_NUDGES_ENABLED'),
}));
jest.mock('../../bot/shared/services/nudges/re-engage.kind', () => ({ kind: 're_engage', handle: jest.fn() }));

const ENV_KEYS = ['TEACHER_NUDGES_ENABLED', 'TEACHER_NUDGES_SWEEP_MINUTES'];
const saved = {};
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Let the promise chain inside startWorker settle under fake timers. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function boot() {
  let mod;
  jest.isolateModules(() => { mod = require('../../bot/workers/sqs-worker'); });
  mod.SQSCoachingWorker.prototype.start = jest.fn().mockResolvedValue(undefined);
  await mod.startWorker();
  await flush();
  return mod;
}

async function advance(ms) {
  await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  jest.useFakeTimers();
  mockRunSweep.mockClear();
  mockRegister.mockClear();
  mockLog.mockClear();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('sqs-worker — the in-process sweep', () => {
  it('flag unset at boot: registers nothing, arms nothing, says so once', async () => {
    await boot();
    await advance(30 * MINUTE);
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockRunSweep).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringMatching(/Teacher-nudge sweep not enabled/), expect.any(Object));
  });

  it('flag on: registers the kind, first sweep 90 s after boot, then every 5 minutes', async () => {
    process.env.TEACHER_NUDGES_ENABLED = 'true';
    await boot();
    expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ kind: 're_engage' }));

    await advance(89 * SECOND);
    expect(mockRunSweep).not.toHaveBeenCalled();
    await advance(1 * SECOND);
    expect(mockRunSweep).toHaveBeenCalledTimes(1);

    await advance(5 * MINUTE - SECOND);
    expect(mockRunSweep).toHaveBeenCalledTimes(1);
    await advance(SECOND);
    expect(mockRunSweep).toHaveBeenCalledTimes(2);
    await advance(5 * MINUTE);
    expect(mockRunSweep).toHaveBeenCalledTimes(3);
  });

  it('TEACHER_NUDGES_SWEEP_MINUTES may be fractional (0.5 = every 30 s)', async () => {
    process.env.TEACHER_NUDGES_ENABLED = '1';
    process.env.TEACHER_NUDGES_SWEEP_MINUTES = '0.5';
    await boot();
    await advance(90 * SECOND);
    expect(mockRunSweep).toHaveBeenCalledTimes(1);
    await advance(30 * SECOND);
    expect(mockRunSweep).toHaveBeenCalledTimes(2);
    await advance(60 * SECOND);
    expect(mockRunSweep).toHaveBeenCalledTimes(4);
  });

  it.each(['0', '-3', 'soon', '0.01'])('a junk interval %j keeps the 5-minute default', async (value) => {
    process.env.TEACHER_NUDGES_ENABLED = 'true';
    process.env.TEACHER_NUDGES_SWEEP_MINUTES = value;
    await boot();
    await advance(90 * SECOND + 4 * MINUTE);
    expect(mockRunSweep).toHaveBeenCalledTimes(1);
    await advance(MINUTE);
    expect(mockRunSweep).toHaveBeenCalledTimes(2);
  });

  it('skips ticks while the worker is shutting down', async () => {
    process.env.TEACHER_NUDGES_ENABLED = 'true';
    const mod = await boot();
    mod.worker.isShuttingDown = true;
    await advance(90 * SECOND + 10 * MINUTE);
    expect(mockRunSweep).not.toHaveBeenCalled();
  });

  it('a sweep that rejects is logged and the interval keeps going', async () => {
    process.env.TEACHER_NUDGES_ENABLED = 'true';
    mockRunSweep.mockRejectedValueOnce(new Error('boom'));
    await boot();
    await advance(90 * SECOND);
    await advance(5 * MINUTE);
    expect(mockRunSweep).toHaveBeenCalledTimes(2);
    expect(mockLog).toHaveBeenCalledWith(expect.stringMatching(/teacher-nudge sweep/i), expect.objectContaining({ error: 'boom' }));
  });
});

describe('teacher-nudges.worker — the one-shot cron entry', () => {
  function loadCron() {
    let mod;
    jest.isolateModules(() => { mod = require('../../bot/workers/teacher-nudges.worker'); });
    return mod;
  }

  it('flag unset: does nothing at all', async () => {
    const { main } = loadCron();
    const out = await main();
    expect(out).toMatchObject({ off: true });
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockRunSweep).not.toHaveBeenCalled();
  });

  it('flag on: registers the same kinds and runs exactly one sweep', async () => {
    process.env.TEACHER_NUDGES_ENABLED = 'yes';
    mockRunSweep.mockResolvedValueOnce({ booked: 1, claimed: 1, sent: 1, skipped: 0, failed: 0, reclaimed: 0 });
    const { main } = loadCron();
    const out = await main();
    expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ kind: 're_engage' }));
    expect(mockRunSweep).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ sent: 1 });
  });
});
