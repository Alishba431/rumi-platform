'use strict';
/**
 * What "on" means for a teacher-nudge switch — one reading, shared.
 *
 * The sweeper checks its master switch on every tick and the worker checks the
 * same switch once at boot to decide whether to arm the interval. If each parsed
 * the flag its own way they would disagree (one taking only the literal `'true'`,
 * the other also `1`), and a flag would end up armed at boot but ignored per
 * tick, or the reverse. Read at call time and never cached, so a flag flipped
 * off takes effect on the next tick.
 *
 * @param {string} name  the environment variable
 * @returns {boolean}    true for `1`, `true` or `yes` (any case, trimmed)
 */
function flagOn(name) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

module.exports = { flagOn };
