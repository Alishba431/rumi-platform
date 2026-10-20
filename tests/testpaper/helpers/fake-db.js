/**
 * A small in-memory stand-in for the Supabase query builder, for the
 * test-paper suites. It implements only the chain shapes those services use —
 * insert/update/delete/select with eq/in/neq/gte/lte/order/limit and the
 * single/maybeSingle terminals — and returns PostgREST's `{ data, error }`.
 *
 * Rows live in plain arrays (`db.tables.<name>`), so a test can seed state and
 * assert on what was written without mocking each call.
 */

const crypto = require('crypto');

function createFakeDb(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  let clock = Date.parse('2026-10-01T08:00:00Z');
  const now = () => new Date((clock += 1000)).toISOString();
  const calls = [];

  function rowsOf(name) {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  function pick(row, columns) {
    if (!columns || columns === '*') return { ...row };
    const out = {};
    for (const c of columns.split(',').map((x) => x.trim()).filter(Boolean)) out[c] = row[c];
    return out;
  }

  function from(name) {
    const state = { op: 'select', filters: [], columns: '*', order: null, limit: null, payload: null, returning: false };

    const matches = (row) => state.filters.every((f) => f(row));

    function run() {
      const rows = rowsOf(name);
      calls.push({ table: name, op: state.op, payload: state.payload });
      if (state.op === 'insert') {
        const list = (Array.isArray(state.payload) ? state.payload : [state.payload]).map((r) => ({
          id: crypto.randomUUID(), created_at: now(), ...r,
        }));
        rows.push(...list);
        return list;
      }
      if (state.op === 'update') {
        const hit = rows.filter(matches);
        hit.forEach((r) => Object.assign(r, state.payload));
        return hit;
      }
      if (state.op === 'delete') {
        const hit = rows.filter(matches);
        tables[name] = rows.filter((r) => !matches(r));
        return hit;
      }
      let out = rows.filter(matches);
      if (state.order) {
        const { col, ascending } = state.order;
        out = [...out].sort((a, b) => {
          if (a[col] === b[col]) return 0;
          return (a[col] > b[col] ? 1 : -1) * (ascending ? 1 : -1);
        });
      }
      if (state.limit != null) out = out.slice(0, state.limit);
      return out;
    }

    const project = (list) => list.map((r) => pick(r, state.columns));

    const builder = {
      select(columns = '*') { state.columns = columns; state.returning = true; return builder; },
      insert(payload) { state.op = 'insert'; state.payload = payload; return builder; },
      update(payload) { state.op = 'update'; state.payload = payload; return builder; },
      delete() { state.op = 'delete'; return builder; },
      eq(col, val) { state.filters.push((r) => r[col] === val); return builder; },
      neq(col, val) { state.filters.push((r) => r[col] !== val); return builder; },
      in(col, vals) { state.filters.push((r) => vals.includes(r[col])); return builder; },
      gte(col, val) { state.filters.push((r) => r[col] >= val); return builder; },
      lte(col, val) { state.filters.push((r) => r[col] <= val); return builder; },
      not(col, op, val) { state.filters.push((r) => !(op === 'is' && val === null ? r[col] == null : r[col] === val)); return builder; },
      order(col, opts = {}) { state.order = { col, ascending: opts.ascending !== false }; return builder; },
      limit(n) { state.limit = n; return builder; },
      async single() {
        const list = project(run());
        if (list.length !== 1) return { data: null, error: { message: `expected 1 row, got ${list.length}` } };
        return { data: list[0], error: null };
      },
      async maybeSingle() {
        const list = project(run());
        if (list.length > 1) return { data: null, error: { message: 'more than one row' } };
        return { data: list[0] || null, error: null };
      },
      then(resolve, reject) {
        try {
          const list = run();
          const data = state.op === 'select' || state.returning ? project(list) : null;
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        } catch (err) {
          return Promise.reject(err).then(resolve, reject);
        }
      },
    };
    return builder;
  }

  return { from, tables, calls };
}

module.exports = { createFakeDb };
