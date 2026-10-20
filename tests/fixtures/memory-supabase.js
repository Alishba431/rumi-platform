'use strict';
/**
 * A STATEFUL in-memory Supabase stand-in, for tests that follow one teacher
 * through several steps in a row: one step writes a row, a later one reads it
 * back on a moved (fake) clock, a third one updates it.
 *
 * Unlike a mock that replays a canned answer, this one can answer "after the
 * first sweep claimed the row, does the second sweep claim it too?", because:
 *
 *   - filters are applied to reads AND to updates, and an update mutates the
 *     rows it matched and returns them. The conditional claims in this code base
 *     (`.update(...).in('id', ids).eq('status','pending').select()`) depend on
 *     exactly that.
 *   - range filters (`lt`/`lte`/`gt`/`gte`) compare instants when both sides
 *     read as dates, so `…+00:00` and `…Z` spellings of one instant agree.
 *   - an optional UNIQUE per table answers a duplicate insert with 23505.
 *   - `.single()` on no rows is PostgREST's PGRST116 error, not a quiet null.
 *   - `failNext(table, op)` makes the next matching chain return an error, so
 *     the "every chain checks error" paths can be driven.
 *
 * NOT modelled: `.or()` is recorded and ignored (every row passes). A test whose
 * outcome turns on an `.or()` filter must not rely on this fake for it.
 */

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(T|$)/;

function comparable(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && DATE_LIKE.test(v)) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return v;
}

function createMemorySupabase(seed = {}, { unique = {} } = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  let seq = 0;
  const failures = [];

  function from(table) {
    if (!tables[table]) tables[table] = [];
    const rows = tables[table];
    const filters = [];
    let op = 'select';
    let payload = null;
    let head = false;
    let order = null;
    let lim = null;
    let rng = null;

    const test = (r) => filters.every((f) => f(r));

    const exec = () => {
      const forced = failures.findIndex((f) => f.table === table && f.op === op);
      if (forced >= 0) {
        const [f] = failures.splice(forced, 1);
        return { data: null, error: f.error };
      }
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload];
        const made = [];
        for (const p of list) {
          seq += 1;
          const row = { id: `${table}-${seq}`, ...p };
          const keys = unique[table];
          if (keys && rows.some((r) => keys.every((k) => r[k] === row[k]))) {
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint on ${table}` } };
          }
          rows.push(row);
          made.push({ ...row });
        }
        return { data: made, error: null };
      }
      let hit = rows.filter(test);
      if (op === 'update') {
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (op === 'delete') {
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (order) {
        const { col, asc } = order;
        hit = [...hit].sort((a, b) => {
          const av = comparable(a[col]);
          const bv = comparable(b[col]);
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (asc ? 1 : -1);
        });
      }
      if (rng) hit = hit.slice(rng[0], rng[1] + 1);
      if (lim != null) hit = hit.slice(0, lim);
      return { data: head ? null : hit.map((r) => ({ ...r })), error: null, count: hit.length };
    };

    const cmp = (fn) => (col, v) => {
      filters.push((r) => {
        const a = comparable(r[col]);
        const b = comparable(v);
        return a !== null && a !== undefined && fn(a, b);
      });
      return c;
    };

    const c = {
      select: (_cols, opts) => { if (opts && opts.head) head = true; return c; },
      insert: (p) => { op = 'insert'; payload = p; return c; },
      update: (p) => { op = 'update'; payload = p; return c; },
      delete: () => { op = 'delete'; return c; },
      eq: (col, v) => { filters.push((r) => r[col] === v); return c; },
      neq: (col, v) => { filters.push((r) => r[col] !== v); return c; },
      in: (col, vs) => { filters.push((r) => vs.includes(r[col])); return c; },
      is: (col, v) => {
        filters.push((r) => (v === null ? (r[col] === null || r[col] === undefined) : r[col] === v));
        return c;
      },
      not: (col, o, v) => {
        if (o !== 'is') throw new Error(`memory-supabase: .not(${col}, ${o}) is not modelled`);
        filters.push((r) => (v === null ? !(r[col] === null || r[col] === undefined) : r[col] !== v));
        return c;
      },
      lt: cmp((a, b) => a < b),
      lte: cmp((a, b) => a <= b),
      gt: cmp((a, b) => a > b),
      gte: cmp((a, b) => a >= b),
      or: () => c,
      order: (col, o) => { order = { col, asc: !o || o.ascending !== false }; return c; },
      limit: (n) => { lim = n; return c; },
      range: (a, b) => { rng = [a, b]; return c; },
      single: async () => {
        const r = exec();
        if (r.error) return { data: null, error: r.error };
        const first = (r.data || [])[0];
        return first ? { data: first, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      },
      maybeSingle: async () => {
        const r = exec();
        if (r.error) return { data: null, error: r.error };
        return { data: (r.data || [])[0] || null, error: null };
      },
      then: (res, rej) => Promise.resolve(exec()).then(res, rej),
    };
    return c;
  }

  return {
    from: jest.fn(from),
    rpc: jest.fn(async () => ({ data: null, error: null })),
    tables,
    rows: (t) => tables[t] || [],
    /** The next chain on `table` doing `op` (select|insert|update|delete) resolves with `error`. */
    failNext(table, op, error = { message: 'simulated database error' }) {
      failures.push({ table, op, error });
    },
    /** Replace every table's contents (the object identity the mock holds stays the same). */
    reset(next = {}) {
      for (const k of Object.keys(tables)) delete tables[k];
      for (const [name, list] of Object.entries(next)) tables[name] = list.map((r) => ({ ...r }));
      failures.length = 0;
    },
  };
}

module.exports = { createMemorySupabase };
