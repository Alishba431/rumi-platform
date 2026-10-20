'use strict';
/**
 * Numbered-list helpers for the observe chat surfaces.
 *
 * Every list goes out through sendInteractiveMessage: a native list on Meta, a
 * numbered text menu on Baileys / Matrix / Slack / Discord (the typed number
 * comes back as the same row id through pending-options). So one shape, with
 * the tightest channel caps: ≤10 rows, title ≤24, description ≤72, button ≤20.
 */

const MAX_ROWS = 10;
const TITLE_CAP = 24;
const DESC_CAP = 72;
const BUTTON_CAP = 20;

const clip = (s, n) => (s == null ? '' : String(s)).slice(0, n);

const row = (id, title, description) => ({ id, title: clip(title, TITLE_CAP), description: clip(description || '', DESC_CAP) });

/**
 * One page of `items`, leaving room for `fixed` rows that always ship. When the
 * items do not fit, one slot goes to a "More…" row (hasMore).
 * @returns {{items: Array, hasMore: boolean}}
 */
function pageOf(items, page = 0, fixed = 0) {
  const list = items || [];
  const capacity = MAX_ROWS - fixed;
  if (page === 0 && list.length <= capacity) return { items: list, hasMore: false };
  const per = Math.max(1, capacity - 1);
  const start = page * per;
  return { items: list.slice(start, start + per), hasMore: list.length > start + per };
}

/** sendInteractiveMessage payload. Empty sections are dropped. */
function listPayload(body, button, sections) {
  return {
    type: 'list',
    header: '',
    body,
    action: {
      button: clip(button, BUTTON_CAP),
      sections: sections
        .filter((s) => s.rows && s.rows.length)
        .map((s) => ({ title: clip(s.title, TITLE_CAP), rows: s.rows })),
    },
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' (or an ISO timestamp) → 'Mon 5 Oct'. Read as a calendar day, no timezone shift. */
function fmtDay(isoDate, { weekday = true } = {}) {
  const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(isoDate || '');
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return weekday ? `${WEEKDAYS[d.getUTCDay()]} ${day}` : day;
}

const today = () => new Date().toISOString().slice(0, 10);

module.exports = { MAX_ROWS, clip, row, pageOf, listPayload, fmtDay, today };
