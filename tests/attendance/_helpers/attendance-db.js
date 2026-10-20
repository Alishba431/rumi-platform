/**
 * An in-memory stand-in for the Supabase client, just wide enough for attendance.
 *
 * It really filters and really writes, so a test can mark a day, mark it again, and
 * read the month back — the behaviour under test runs unmocked against it. Only the
 * network boundary (the client) is replaced.
 *
 * Supports: select (with one nested child select, e.g.
 * `attendance_records(student_id, status)` under attendance_sessions), eq, neq, gte,
 * lte, in, is, order, limit, maybeSingle, single, insert, update, delete, upsert
 * ({ onConflict }). Every builder is thenable, like the real client.
 */

let idSeq = 0;
const nextId = (table) => `${table}-${(idSeq += 1)}`;

// parent table -> { child table, foreign key on the child }
const RELATIONS = {
  attendance_sessions: { attendance_records: 'session_id' },
};

function createAttendanceDb(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((r) => ({ id: r.id || nextId(name), ...r }));
  }
  const rowsOf = (name) => {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  };
  const log = [];

  function project(table, row, columns) {
    const out = { ...row };
    const nested = /(\w+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = nested.exec(columns || ''))) {
      const [, child, childCols] = m;
      const fk = RELATIONS[table]?.[child];
      if (!fk) continue;
      const wanted = childCols.split(',').map((c) => c.trim()).filter(Boolean);
      out[child] = rowsOf(child)
        .filter((c) => c[fk] === row.id)
        .map((c) => Object.fromEntries(wanted.map((k) => [k, c[k]])));
    }
    return out;
  }

  function builder(table) {
    const filters = [];
    let op = 'select';
    let payload = null;
    let columns = '*';
    let returning = false;
    let single = null; // 'single' | 'maybe'
    let orderBy = null;
    let limitN = null;
    let upsertKeys = null;

    const match = (row) => filters.every((f) => f(row));

    function run() {
      const rows = rowsOf(table);
      let result = [];
      if (op === 'select') {
        result = rows.filter(match).map((r) => project(table, r, columns));
      } else if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: nextId(table), ...r }));
        rows.push(...list);
        log.push({ op, table, rows: list });
        result = list;
      } else if (op === 'upsert') {
        const list = Array.isArray(payload) ? payload : [payload];
        result = list.map((r) => {
          const existing = rows.find((x) => upsertKeys.every((k) => x[k] === r[k]));
          if (existing) { Object.assign(existing, r); return existing; }
          const created = { id: nextId(table), ...r };
          rows.push(created);
          return created;
        });
        log.push({ op, table, rows: list });
      } else if (op === 'update') {
        result = rows.filter(match);
        result.forEach((r) => Object.assign(r, payload));
        log.push({ op, table, patch: payload, count: result.length });
      } else if (op === 'delete') {
        result = rows.filter(match);
        tables[table] = rows.filter((r) => !match(r));
        log.push({ op, table, count: result.length });
      }

      if (orderBy) {
        const { col, ascending } = orderBy;
        result = [...result].sort((a, b) => ((a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (ascending ? 1 : -1)));
      }
      if (limitN != null) result = result.slice(0, limitN);

      const data = op === 'select' || returning ? result : null;
      if (single === 'single') {
        if (!result.length) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        return { data: result[0], error: null };
      }
      if (single === 'maybe') return { data: result[0] || null, error: null };
      return { data, error: null };
    }

    const b = {
      select(cols) { if (op === 'select') columns = cols || '*'; else returning = true; return b; },
      insert(rows) { op = 'insert'; payload = rows; return b; },
      upsert(rows, opts = {}) {
        op = 'upsert';
        payload = rows;
        upsertKeys = String(opts.onConflict || 'id').split(',').map((k) => k.trim());
        return b;
      },
      update(patch) { op = 'update'; payload = patch; return b; },
      delete() { op = 'delete'; return b; },
      eq(col, val) { filters.push((r) => r[col] === val); return b; },
      neq(col, val) { filters.push((r) => r[col] !== val); return b; },
      gte(col, val) { filters.push((r) => r[col] >= val); return b; },
      lte(col, val) { filters.push((r) => r[col] <= val); return b; },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col, val) { filters.push((r) => (r[col] ?? null) === val); return b; },
      order(col, opts = {}) { orderBy = { col, ascending: opts.ascending !== false }; return b; },
      limit(n) { limitN = n; return b; },
      single() { single = 'single'; return Promise.resolve(run()); },
      maybeSingle() { single = 'maybe'; return Promise.resolve(run()); },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };
    return b;
  }

  return {
    client: { from: (table) => builder(table) },
    tables,
    rowsOf,
    log,
  };
}

module.exports = { createAttendanceDb };
