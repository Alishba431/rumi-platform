'use strict';
/**
 * Where a teacher is in the /testpaper conversation: which source they
 * picked, which chapters were offered, which mix and language they chose, and
 * which paper an edit request applies to.
 *
 * Storage mirrors pending-options.js: Redis-backed, so the conversation
 * survives the process restart a redeploy causes mid-pick, with an in-memory
 * fallback and a TTL so a stale half-finished pick cannot capture a much later
 * message. Keyed by users.id, not by phone, so it is the same conversation on
 * every channel the teacher reaches the bot from.
 */

const { logToFile } = require('../../utils/logger');

/**
 * Redis is required lazily: the cache service dials on require, and this file
 * is loaded by the message handler, the worker and tests alike.
 */
function redis() {
  // eslint-disable-next-line global-require -- deliberate: see comment above
  return require('../cache/railway-redis.service');
}

const KEY_PREFIX = 'testpaper:session:';
/** Long enough to find a chapter's number in the book; short enough to expire. */
const TTL_SECONDS = 30 * 60;

const memory = new Map();

function keyFor(userId) {
  return `${KEY_PREFIX}${userId}`;
}

function prune(now = Date.now()) {
  for (const [k, entry] of memory) {
    if (entry.expiresAt <= now) memory.delete(k);
  }
}

async function save(userId, state) {
  if (!userId) return;
  const value = { ...state, updatedAt: Date.now() };
  memory.set(userId, { expiresAt: Date.now() + TTL_SECONDS * 1000, state: value });
  prune();
  try {
    const stored = await redis().set(keyFor(userId), JSON.stringify(value), TTL_SECONDS);
    if (stored === false) {
      logToFile('⚠️ test paper session: Redis unavailable — kept in memory only', { userId });
    }
  } catch (error) {
    logToFile('⚠️ test paper session: Redis write failed, using memory', { error: error.message });
  }
}

async function get(userId) {
  if (!userId) return null;
  try {
    const raw = await redis().get(keyFor(userId));
    if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    logToFile('⚠️ test paper session: Redis read failed, using memory', { error: error.message });
  }
  prune();
  return memory.get(userId)?.state || null;
}

async function update(userId, patch) {
  const current = (await get(userId)) || {};
  const next = { ...current, ...patch };
  await save(userId, next);
  return next;
}

async function clear(userId) {
  if (!userId) return;
  memory.delete(userId);
  try {
    await redis().delete(keyFor(userId));
  } catch (error) {
    logToFile('⚠️ test paper session: Redis delete failed', { error: error.message });
  }
}

function _resetForTests() {
  memory.clear();
}

module.exports = { get, save, update, clear, TTL_SECONDS, _resetForTests };
