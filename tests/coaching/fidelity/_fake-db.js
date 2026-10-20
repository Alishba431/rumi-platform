'use strict';
/**
 * A small in-memory stand-in for the supabase-js query builder — the database is the network boundary for these
 * tests. It supports the chains the coaching services use: select/eq/in/or/order/limit with single/maybeSingle, and
 * update/insert awaited directly or through .select(). Tables are plain arrays of rows keyed by `id`.
 */
function makeFakeDb(tables = {}) {
  const writes = [];

  function query(table) {
    const rows = () => (tables[table] = tables[table] || []);
    const filters = [];
    let op = 'select';
    let patch = null;
    let limitN = null;

    const matches = (row) => filters.every((f) => f(row));
    const run = () => {
      if (op === 'update') {
        const hit = rows().filter(matches);
        for (const r of hit) Object.assign(r, patch);
        writes.push({ table, op, patch, ids: hit.map((r) => r.id) });
        return hit;
      }
      if (op === 'insert') {
        const added = (Array.isArray(patch) ? patch : [patch]).map((r) => ({ id: r.id || `${table}-${rows().length + 1}`, ...r }));
        rows().push(...added);
        writes.push({ table, op, patch, ids: added.map((r) => r.id) });
        return added;
      }
      const hit = rows().filter(matches);
      return limitN == null ? hit : hit.slice(0, limitN);
    };

    const builder = {
      select() { return builder; },
      update(p) { op = 'update'; patch = p; return builder; },
      insert(p) { op = 'insert'; patch = p; return builder; },
      eq(col, val) { filters.push((r) => r[col] === val); return builder; },
      neq(col, val) { filters.push((r) => r[col] !== val); return builder; },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return builder; },
      not() { return builder; },
      or() { return builder; },
      gte() { return builder; },
      order() { return builder; },
      limit(n) { limitN = n; return builder; },
      async single() {
        const hit = run();
        return hit.length ? { data: hit[0], error: null } : { data: null, error: { message: 'not found' } };
      },
      async maybeSingle() {
        const hit = run();
        return { data: hit[0] || null, error: null };
      },
      then(resolve, reject) {
        try { resolve({ data: run(), error: null }); } catch (e) { reject(e); }
      },
    };
    return builder;
  }

  return { from: (table) => query(table), tables, writes };
}

module.exports = { makeFakeDb };
