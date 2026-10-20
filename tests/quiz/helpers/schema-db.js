'use strict';
/**
 * An in-memory Supabase stand-in that answers the way PostgREST does WHERE THE
 * SCHEMA MATTERS — for the teacher's side of the lesson quiz, whose failures in
 * a fresh deployment are schema failures, not logic ones.
 *
 *   - Every column a query names (select list, an embedded `users!inner(...)`,
 *     a filter, an order, an insert or update key) must exist in
 *     infrastructure/supabase/00_complete-schema.sql. One that does not makes
 *     PostgREST refuse the WHOLE request with 42703 — so a select asking for a
 *     column this schema never had (a fork-only `observation_type`) reads
 *     nothing at all, exactly as it would on a clone.
 *   - The unique indexes the schema declares on `quizzes` are enforced: a second
 *     transcript quiz for one coaching session, or a second lp_generated quiz for
 *     one lesson plan, is refused with 23505 — the claim the services rely on.
 *   - `col->>key` filters read inside a jsonb column, as PostgREST's do.
 *   - Writes are remembered: what one call inserts, the next one reads.
 *
 * Seed embedded resources pre-joined (a coaching session row carries `users`).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_PATH = path.resolve(__dirname, '../../../infrastructure/supabase/00_complete-schema.sql');

let cachedColumns = null;
/** table → Set(columns), from CREATE TABLE and the ALTER … ADD COLUMN reconcile lines. */
function schemaColumns() {
  if (cachedColumns) return cachedColumns;
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const tables = {};
  const createRe = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\)\s*;/gi;
  let m;
  while ((m = createRe.exec(sql)) !== null) {
    const cols = new Set();
    for (const line of m[2].split('\n')) {
      const cm = line.match(/^\s*"?([a-z_][a-z0-9_]*)"?\s+[a-z]/i);
      if (cm && !['primary', 'foreign', 'unique', 'constraint', 'check', 'references'].includes(cm[1].toLowerCase())) {
        cols.add(cm[1].toLowerCase());
      }
    }
    tables[m[1].toLowerCase()] = cols;
  }
  const alterRe = /ALTER TABLE (?:IF EXISTS )?(?:public\.)?(\w+)\s+ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi;
  while ((m = alterRe.exec(sql)) !== null) {
    (tables[m[1].toLowerCase()] = tables[m[1].toLowerCase()] || new Set()).add(m[2].toLowerCase());
  }
  cachedColumns = tables;
  return tables;
}

/** The unique partial indexes on quizzes (00_complete-schema.sql). */
const DEFAULT_UNIQUE = {
  quizzes: [
    { name: 'quizzes_one_transcript_quiz_per_session', cols: ['coaching_session_id'], where: (r) => r.quiz_source === 'transcript' },
    { name: 'quizzes_one_lesson_plan_quiz', cols: ['lesson_plan_id'], where: (r) => r.quiz_source === 'lp_generated' },
    { name: 'idx_quizzes_video_id', cols: ['video_id'], where: (r) => r.video_id != null },
  ],
};

/** Split a select list at top-level commas (not inside an embed's parentheses). */
function splitTop(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(list || '')) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const baseColumn = (c) => String(c).split(/->>?/)[0].trim();
const jsonPath = (c) => String(c).split(/->>?/).slice(1);
function valueAt(row, col) {
  const base = row[baseColumn(col)];
  const p = jsonPath(col);
  if (!p.length) return base;
  const v = p.reduce((o, k) => (o == null ? undefined : o[k]), base);
  // ->> answers text
  return v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v));
}

function cmp(a, b) {
  const t = (v) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return v;
    const x = Date.parse(v);
    return Number.isNaN(x) ? v : x;
  };
  const x = t(a);
  const y = t(b);
  if (x === y) return 0;
  return x > y ? 1 : -1;
}

function contains(value, subset) {
  if (subset === null || typeof subset !== 'object') return value === subset;
  if (Array.isArray(subset)) return Array.isArray(value) && subset.every((s) => value.some((v) => contains(v, s)));
  if (value === null || typeof value !== 'object') return false;
  return Object.keys(subset).every((k) => contains(value[k], subset[k]));
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * @param {object} seed  table → rows
 * @param {{unique?: object, now?: () => Date}} [opts]
 */
function makeSchemaDb(seed = {}, { unique = DEFAULT_UNIQUE, now = () => new Date() } = {}) {
  const schema = schemaColumns();
  const tables = {};
  Object.entries(seed).forEach(([t, rows]) => { tables[t] = rows.map(clone); });
  const writes = [];
  const refused = [];

  function unknownColumn(table, cols) {
    const known = schema[table];
    if (!known) return { code: '42P01', message: `relation "public.${table}" does not exist` };
    const bad = cols.map(baseColumn).find((c) => c && c !== '*' && !known.has(c.toLowerCase()));
    return bad ? { code: '42703', message: `column ${table}.${bad} does not exist` } : null;
  }

  function checkSelect(table, list) {
    for (const item of splitTop(list)) {
      const embed = /^(\w+)(?:!\w+)?\((.*)\)$/s.exec(item);
      if (embed) {
        const err = unknownColumn(embed[1], splitTop(embed[2]));
        if (err) return { ...err, message: err.message.replace(`${embed[1]}.`, `${embed[1]}_1.`) };
        continue;
      }
      const aliased = /^\w+:(.+)$/.exec(item);
      const err = unknownColumn(table, [aliased ? aliased[1] : item]);
      if (err) return err;
    }
    return null;
  }

  function from(table) {
    if (!tables[table]) tables[table] = [];
    const filters = [];
    const named = [];
    let op = 'select';
    let payload = null;
    let selectList = '*';
    let returning = false;
    let head = false;
    const orders = [];
    let lim = null;
    let rng = null;

    const filter = (col, fn) => { named.push(col); filters.push((r) => fn(valueAt(r, col))); return b; };
    const matches = (r) => filters.every((f) => f(r));

    function violates(row, rows) {
      for (const idx of (unique[table] || [])) {
        if (!idx.where(row) || idx.cols.some((c) => row[c] == null)) continue;
        if (rows.some((r) => idx.where(r) && idx.cols.every((c) => r[c] === row[c]))) return idx.name;
      }
      return null;
    }

    function run() {
      const writeKeys = op === 'insert' || op === 'update'
        ? (Array.isArray(payload) ? payload : [payload]).flatMap((r) => Object.keys(r || {})) : [];
      const err = (op === 'select' || returning ? checkSelect(table, selectList) : null)
        || unknownColumn(table, [...named, ...orders.map((o) => o.col), ...writeKeys]);
      if (err) { refused.push({ table, op, error: err }); return { data: null, error: err }; }
      const rows = tables[table];
      if (op === 'insert') {
        const made = [];
        for (const r of (Array.isArray(payload) ? payload : [payload])) {
          const row = { id: crypto.randomUUID(), created_at: now().toISOString(), ...clone(r) };
          const dup = violates(row, rows);
          if (dup) {
            const e = { code: '23505', message: `duplicate key value violates unique constraint "${dup}"` };
            refused.push({ table, op, error: e });
            return { data: null, error: e };
          }
          made.push(row);
        }
        made.forEach((r) => rows.push(r));
        writes.push({ table, op, rows: clone(made) });
        return { data: returning ? clone(made) : null, error: null };
      }
      if (op === 'update') {
        const hit = rows.filter(matches);
        hit.forEach((r) => Object.assign(r, clone(payload)));
        writes.push({ table, op, patch: clone(payload), ids: hit.map((r) => r.id) });
        return { data: returning ? clone(hit) : null, error: null, count: hit.length };
      }
      if (op === 'delete') {
        const keep = rows.filter((r) => !matches(r));
        writes.push({ table, op, removed: rows.length - keep.length });
        tables[table] = keep;
        return { data: null, error: null };
      }
      let out = rows.filter(matches);
      if (orders.length) {
        out = [...out].sort((x, y) => {
          for (const { col, asc } of orders) {
            const c = cmp(valueAt(x, col), valueAt(y, col));
            if (c) return asc ? c : -c;
          }
          return 0;
        });
      }
      if (rng) out = out.slice(rng[0], rng[1] + 1);
      if (lim !== null) out = out.slice(0, lim);
      return { data: head ? null : clone(out), error: null, count: out.length };
    }

    const b = {
      select(cols, opts) {
        selectList = cols || '*';
        if (opts && opts.head) head = true;
        if (op !== 'select') returning = true;
        return b;
      },
      insert(rows) { op = 'insert'; payload = rows; return b; },
      update(patch) { op = 'update'; payload = patch; return b; },
      delete() { op = 'delete'; return b; },
      eq: (c, v) => filter(c, (x) => x === v || (x != null && v != null && String(x) === String(v) && jsonPath(c).length > 0)),
      neq: (c, v) => filter(c, (x) => x !== v),
      is: (c, v) => filter(c, (x) => (v === null ? x === null || x === undefined : x === v)),
      not: (c, o, v) => {
        if (o !== 'is') throw new Error(`schema-db: .not(${c}, ${o}) is not modelled`);
        return filter(c, (x) => (v === null ? !(x === null || x === undefined) : x !== v));
      },
      in: (c, vs) => filter(c, (x) => (vs || []).includes(x)),
      gte: (c, v) => filter(c, (x) => x != null && cmp(x, v) >= 0),
      gt: (c, v) => filter(c, (x) => x != null && cmp(x, v) > 0),
      lte: (c, v) => filter(c, (x) => x != null && cmp(x, v) <= 0),
      lt: (c, v) => filter(c, (x) => x != null && cmp(x, v) < 0),
      contains: (c, v) => filter(c, (x) => contains(x, v)),
      order(col, opts) { orders.push({ col, asc: !(opts && opts.ascending === false) }); return b; },
      limit(n) { lim = n; return b; },
      range(a, z) { rng = [a, z]; return b; },
      async single() {
        const r = run();
        if (r.error) return r;
        const rows = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
        if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: `expected one row from ${table}, got ${rows.length}` } };
        return { data: rows[0], error: null };
      },
      async maybeSingle() {
        const r = run();
        if (r.error) return r;
        const rows = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
        if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: `expected at most one row from ${table}, got ${rows.length}` } };
        return { data: rows[0] || null, error: null };
      },
      then(resolve, reject) {
        try { return Promise.resolve(run()).then(resolve, reject); } catch (e) { return Promise.reject(e).then(resolve, reject); }
      },
    };
    return b;
  }

  return { from: jest.fn(from), tables, writes, refused, table: (t) => (tables[t] = tables[t] || []) };
}

module.exports = { makeSchemaDb, schemaColumns, DEFAULT_UNIQUE };
