/**
 * Keeping a persistent-connection channel trying to come up after a failed
 * boot, and what GET /health says about the channels.
 *
 * Before this, whatsapp-bot.js attached each persistent-connection driver
 * once: if Matrix's first connect failed (the homeserver still starting, which
 * is normal when the pair is deployed together), Matrix stayed down until the
 * next restart, and /health still said "healthy". With CHANNEL_DRIVER=none
 * Matrix is the only channel teachers can reach, so that was a silent bot
 * reported as fine.
 *
 * Only drivers that opt in (`retryAttach: true` in whatsapp-bot.js's
 * PERSISTENT_CONNECTION_DRIVERS, today Matrix) use attachWithRetry; Slack and
 * Discord keep their existing behaviour.
 */

const { logToFile } = require('../../utils/logger');
const { resolveActiveChannels, resolveChannelDriver } = require('../../config/feature-availability');

const RETRY_INITIAL_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending retry alone must never keep the process alive (a shutdown
    // signal exits anyway; this is for scripts and tests).
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Calls `attach()` until it resolves, waiting 5 s after the first failure and
 * doubling up to 5 minutes. Each failed attempt is logged once, with the wait
 * before the next one. Never rejects.
 *
 * @param {string} channel driver name, for the log lines
 * @param {() => Promise<void>} attach
 * @returns {Promise<true>} resolves once an attach succeeded
 */
async function attachWithRetry(channel, attach, { initialDelayMs = RETRY_INITIAL_MS, maxDelayMs = RETRY_MAX_MS } = {}) {
  let delay = initialDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one attempt at a time, by design
      await attach();
      if (attempt > 1) logToFile(`✅ The ${channel} channel started`, { channel, attempt });
      return true;
    } catch (error) {
      logToFile(`❌ The ${channel} channel did not start: ${error.message} -- retrying in ${Math.round(delay / 1000)} s`, {
        channel, attempt, retryInMs: delay, error: error.message, stack: error.stack,
      });
      // eslint-disable-next-line no-await-in-loop -- backoff between attempts, by design
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

/**
 * The status and per-channel state GET /health reports.
 *
 * `channels.matrix` ('connected' | 'connecting' | 'down') appears when Matrix
 * is configured. The status is 'degraded' when Matrix is the only channel that
 * can answer teachers (CHANNEL_DRIVER=none and no other additive channel) and
 * it is not connected; otherwise 'healthy'. The route keeps answering HTTP 200
 * either way (see whatsapp-bot.js).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{status: 'healthy'|'degraded', channels: Object<string, string>}}
 */
function healthReport(env = process.env) {
  const active = resolveActiveChannels(env);
  const channels = {};
  if (active.includes('matrix')) {
    // eslint-disable-next-line global-require -- lazy: only a Matrix deployment loads the Matrix connection
    channels.matrix = require('./matrix-connection').connectionStatus();
  }
  const matrixIsTheOnlyChannel = resolveChannelDriver(env) === 'none' && active.length === 1 && active[0] === 'matrix';
  const status = matrixIsTheOnlyChannel && channels.matrix !== 'connected' ? 'degraded' : 'healthy';
  return { status, channels };
}

module.exports = { attachWithRetry, healthReport, RETRY_INITIAL_MS, RETRY_MAX_MS };
