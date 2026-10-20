/**
 * channel-health.js -- keeping a persistent-connection channel that failed
 * at boot trying to come up, and what GET /health says about it.
 *
 * One failed Matrix connect at boot (the homeserver still starting) used to
 * disable Matrix until the next restart, while /health kept saying
 * "healthy" -- with CHANNEL_DRIVER=none that is a silent bot reported as fine.
 */

beforeEach(() => {
  jest.resetModules();
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
});

afterEach(() => {
  jest.useRealTimers();
  jest.resetModules();
});

describe('attachWithRetry', () => {
  it('re-attaches after failures, waiting 5 s and doubling each time, and logs each failed attempt once', async () => {
    jest.useFakeTimers();
    const { attachWithRetry } = require('../../bot/shared/services/messaging/channel-health');
    const logger = require('../../bot/shared/utils/logger');
    let calls = 0;
    const attach = jest.fn(async () => {
      calls += 1;
      if (calls <= 3) throw new Error('connect ECONNREFUSED');
    });

    const done = attachWithRetry('matrix', attach);
    await jest.advanceTimersByTimeAsync(0);
    expect(attach).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(4999);
    expect(attach).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(attach).toHaveBeenCalledTimes(2); // after 5 s
    await jest.advanceTimersByTimeAsync(10000);
    expect(attach).toHaveBeenCalledTimes(3); // after a further 10 s
    await jest.advanceTimersByTimeAsync(20000);
    expect(attach).toHaveBeenCalledTimes(4); // after a further 20 s: connects

    await expect(done).resolves.toBe(true);
    const failures = logger.logToFile.mock.calls.filter(([msg]) => /did not start/.test(msg));
    expect(failures).toHaveLength(3);
    expect(failures[0][0]).toMatch(/ECONNREFUSED.*retrying in 5 s/);
    expect(failures[0][1]).toEqual(expect.objectContaining({ channel: 'matrix', attempt: 1, retryInMs: 5000 }));
    expect(logger.logToFile).toHaveBeenCalledWith(expect.stringMatching(/matrix channel started/), expect.objectContaining({ attempt: 4 }));
  });

  it('caps the wait at 5 minutes', async () => {
    jest.useFakeTimers();
    const { attachWithRetry } = require('../../bot/shared/services/messaging/channel-health');
    const logger = require('../../bot/shared/utils/logger');
    const attach = jest.fn(async () => { throw new Error('still down'); });

    attachWithRetry('matrix', attach);
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

    const waits = logger.logToFile.mock.calls.filter(([msg]) => /did not start/.test(msg)).map(([, meta]) => meta.retryInMs);
    expect(waits.slice(0, 7)).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 300000]);
    expect(Math.max(...waits)).toBe(300000);
  });
});

describe('healthReport', () => {
  function withMatrixStatus(status) {
    jest.doMock('../../bot/shared/services/messaging/matrix-connection', () => ({ connectionStatus: () => status }));
    return require('../../bot/shared/services/messaging/channel-health');
  }
  const MATRIX = { MATRIX_HOMESERVER_URL: 'https://matrix.example.org', MATRIX_ACCESS_TOKEN: 'test-token' };

  it('names Matrix\'s state when Matrix is configured', () => {
    const { healthReport } = withMatrixStatus('connecting');
    expect(healthReport({ ...MATRIX, CHANNEL_DRIVER: 'baileys' })).toEqual({ status: 'healthy', channels: { matrix: 'connecting' } });
  });

  it('is degraded when Matrix is the only answering channel (CHANNEL_DRIVER=none) and not connected', () => {
    for (const state of ['connecting', 'down']) {
      jest.resetModules();
      const { healthReport } = withMatrixStatus(state);
      expect(healthReport({ ...MATRIX, CHANNEL_DRIVER: 'none' })).toEqual({ status: 'degraded', channels: { matrix: state } });
    }
  });

  it('is healthy once that only channel is connected', () => {
    const { healthReport } = withMatrixStatus('connected');
    expect(healthReport({ ...MATRIX, CHANNEL_DRIVER: 'none' })).toEqual({ status: 'healthy', channels: { matrix: 'connected' } });
  });

  it('stays healthy when another channel still answers teachers', () => {
    const { healthReport } = withMatrixStatus('down');
    const env = { ...MATRIX, CHANNEL_DRIVER: 'none', DISCORD_BOT_TOKEN: 'x', DISCORD_APPLICATION_ID: '1', DISCORD_PUBLIC_KEY: 'k' };
    expect(healthReport(env).status).toBe('healthy');
  });

  it('reports no channels, and never loads the Matrix connection, when Matrix is not configured', () => {
    jest.doMock('../../bot/shared/services/messaging/matrix-connection', () => { throw new Error('must not be loaded'); });
    const { healthReport } = require('../../bot/shared/services/messaging/channel-health');
    expect(healthReport({ CHANNEL_DRIVER: 'baileys' })).toEqual({ status: 'healthy', channels: {} });
  });
});

describe('whatsapp-bot.js wiring', () => {
  // whatsapp-bot.js binds a port and pulls in the whole bot on require (see
  // channel-lifecycle.test.js), so the wiring itself is pinned by its source.
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../bot/whatsapp-bot.js'), 'utf-8');

  it('keeps retrying the Matrix attach instead of giving up after one failure', () => {
    expect(src).toMatch(/matrix: \{[\s\S]*?retryAttach: true/);
    expect(src).toMatch(/attachWithRetry\(channel/);
  });

  it('/health reports the channel state and the degraded status', () => {
    expect(src).toMatch(/app\.get\('\/health'[\s\S]*?healthReport\(process\.env\)[\s\S]*?status: report\.status[\s\S]*?channels: report\.channels/);
  });
});
