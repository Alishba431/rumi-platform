/**
 * A person's name for a message, report or filename, built only from the
 * parts that exist. Template strings over first_name/last_name printed a
 * missing part as the word "null" ("Teacher: Hi null", "Hi null! 👋").
 *
 * @param {{first_name?: string|null, last_name?: string|null}|null} user
 * @param {string} [fallback='Teacher'] used when there is no name at all
 * @param {{firstOnly?: boolean}} [opts]
 */
function displayName(user, fallback = 'Teacher', { firstOnly = false } = {}) {
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  const first = clean(user && user.first_name);
  const last = firstOnly ? '' : clean(user && user.last_name);
  return [first, last].filter(Boolean).join(' ') || fallback;
}

module.exports = { displayName };
