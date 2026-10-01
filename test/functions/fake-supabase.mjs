// A stand-in for the part of supabase-js the Edge Functions use, for the
// handler tests (test/fn-*.test.js). test/functions/loader.mjs points the
// functions' npm:@supabase/supabase-js@2 import here.
//
// It models exactly the chains supabase/functions/** call and nothing else,
// so a function that starts using another one fails its tests until the
// chain is added here:
//   createClient(url, key, options)             a client; its key and bearer token are recorded
//   client.auth.getUser(token)                  the user the test registered for that token
//   from(t).select(columns, { count, head }?)   then eq, in, lt, lte, gte, is, not(col, 'is', null),
//                                               order, range, maybeSingle
//   from(t).update(patch, { count }?)           then eq, in or is (count: 'exact' answers how many rows it changed),
//                                               then select(columns)? (answers the changed rows, projected)
//   from(t).insert(rows), from(t).upsert(rows, { onConflict, ignoreDuplicates? })
//
// The tables live in memory and answer the way PostgREST would. Their
// columns, types, unique keys, defaults and checks are the migrations'
// (supabase/migrations/): an unknown column, a broken unique key or check, a
// value of the wrong type or an ON CONFLICT with no matching key is an error
// with Postgres's code, selected columns are projected (an embedded
// `dealerships ( ... )` is joined through dealership_id), and timestamps are
// kept to the microsecond and come back in Postgres's text form
// (2026-09-29T12:00:00.123+00:00), so a handler that compares them as text
// shows it. A select answers at most fake.maxRows rows (1,000, the API's
// max-rows on a Supabase project) whatever range it asks for, so a read
// that does not page loses rows here as it would there. Row-level security
// is not modelled: every client may read and write everything
// (supabase/tests/rls.sql proves the policies); a test that needs a refusal
// scripts it.
//
// Two clocks and two transactions, for the sync races: fake.now is the
// database's clock (now() defaults), apart from the Date the functions read,
// so a test can set it ahead or behind. fake.hold(match) keeps the next
// query `match` accepts open like a transaction another request holds: a
// write takes its now() defaults when it arrives (Postgres's now() is the
// transaction's start) but reaches the tables, and its caller hears back,
// only at commit(); a read waits until then. Everything else goes on
// meanwhile.
//
// A test resets the fake (fake.reset), reads what happened (fake.calls: one
// entry per query or auth call, with the client's key and token, in the
// order they ran), reads the tables (fake.rows), and may answer any call
// itself (fake.script: return { data, error, count } to answer in place of
// the tables, or nothing to let the tables answer).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Defaults the database fills in.
const NEW_UUID = Symbol('gen_random_uuid()');
const NOW = Symbol('now()');
const SERIAL = Symbol('serial');

// Column types: uuid, text, int, num, bool, ts (timestamptz), json, serial;
// a trailing ! is NOT NULL.
const SCHEMA = {
  dealerships: {
    columns: { id: 'uuid!', name: 'text!', website_origin: 'text!', created_at: 'ts!' },
    keys: [['id'], ['website_origin']],
    defaults: { id: NEW_UUID, created_at: NOW },
  },
  memberships: {
    columns: { user_id: 'uuid!', dealership_id: 'uuid!', role: 'text!', name: 'text' },
    keys: [['user_id', 'dealership_id']],
    check: (r) => (['salesperson', 'manager'].includes(r.role) ? '' : 'memberships_role_check'),
  },
  listings: {
    columns: {
      id: 'uuid!', dealership_id: 'uuid!', user_id: 'uuid!', vin: 'text!', name: 'text', price: 'int', posted_at: 'ts!', created_at: 'ts!',
      listing_url: 'text', salesperson: 'text', updated_at: 'ts', taken_down_at: 'ts', status: 'text!',
    },
    keys: [['id'], ['dealership_id', 'vin', 'posted_at']],
    defaults: { id: NEW_UUID, created_at: NOW, status: 'listed' },
    check: (r) => {
      if (!['listed', 'taken_down'].includes(r.status)) return 'listings_status_check';
      return (r.status === 'taken_down') === (r.taken_down_at !== null) ? '' : 'listings_status_matches_taken_down';
    },
  },
  todo_items: {
    columns: { id: 'uuid!', dealership_id: 'uuid!', vin: 'text!', kind: 'text!', name: 'text', flagged_at: 'ts!', done_at: 'ts', how: 'text', from_price: 'int', to_price: 'int' },
    keys: [['id'], ['dealership_id', 'vin', 'kind', 'flagged_at']],
    defaults: { id: NEW_UUID },
    check: (r) => (!['takeDown', 'price'].includes(r.kind) ? 'todo_items_kind_check' : r.how !== null && !['detected', 'manual', 'cleared'].includes(r.how) ? 'todo_items_how_check' : ''),
  },
  scan_summaries: {
    columns: { id: 'uuid!', dealership_id: 'uuid!', website_origin: 'text!', taken_at: 'ts!', cars: 'int', ready: 'int', take_down_count: 'int', price_update_count: 'int' },
    keys: [['id'], ['dealership_id', 'website_origin', 'taken_at']],
    defaults: { id: NEW_UUID },
  },
  post_attempts: {
    columns: {
      id: 'uuid!', dealership_id: 'uuid!', user_id: 'uuid!', vin: 'text!', name: 'text', salesperson: 'text', queue: 'bool!', started_at: 'ts!',
      ended_at: 'ts', outcome: 'text', seconds: 'int', reason: 'text',
    },
    keys: [['id'], ['dealership_id', 'user_id', 'vin', 'started_at']],
    defaults: { id: NEW_UUID, queue: false },
  },
  rewrite_usage: {
    columns: { id: 'serial!', dealership_id: 'uuid!', user_id: 'uuid!', at: 'ts!', model: 'text', input_tokens: 'int', output_tokens: 'int', cost_usd: 'num', kind: 'text' },
    keys: [['id']],
    defaults: { id: SERIAL, at: NOW },
    check: (r) => (r.kind === null || ['rewrite', 'color'].includes(r.kind) ? '' : 'rewrite_usage_kind_check'),
  },
  subscriptions: {
    columns: { dealership_id: 'uuid!', stripe_customer_id: 'text', stripe_subscription_id: 'text', status: 'text', pilot_ends_at: 'ts', current_period_end: 'ts', seats: 'int!', updated_at: 'ts!' },
    keys: [['dealership_id'], ['stripe_customer_id'], ['stripe_subscription_id']],
    defaults: { seats: 5, updated_at: NOW },
    check: (r) => {
      const statuses = ['pilot', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'];
      if (r.status !== null && !statuses.includes(r.status)) return 'subscriptions_status_check';
      return r.seats >= 1 ? '' : 'subscriptions_seats_check';
    },
  },
  billing_events: {
    columns: { id: 'serial!', stripe_event_id: 'text!', type: 'text!', received_at: 'ts!', payload: 'json' },
    keys: [['id'], ['stripe_event_id']],
    defaults: { id: SERIAL, received_at: NOW },
  },
  demo_requests: {
    columns: {
      id: 'serial!', received_at: 'ts!', name: 'text!', dealership: 'text!', website: 'text!', email: 'text!', phone: 'text', message: 'text',
      page_origin: 'text', handled_at: 'ts',
    },
    keys: [['id']],
    defaults: { id: SERIAL, received_at: NOW },
    check: (r) => {
      const within = (v, lo, hi) => v === null || (v.length >= lo && v.length <= hi);
      const ok = within(r.name, 1, 80) && within(r.dealership, 1, 120) && within(r.website, 1, 200) && within(r.email, 3, 200) && within(r.phone, 0, 40) && within(r.message, 0, 2000) && within(r.page_origin, 0, 200);
      return ok ? '' : 'demo_requests_check';
    },
  },
};

class PgError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const typeOf = (table, column) => SCHEMA[table].columns[column].replace('!', '');
const clone = (x) => (x === undefined ? undefined : structuredClone(x));

// ---------- timestamps, to the microsecond ----------

// A timestamptz as microseconds since the epoch, from ISO text with any
// number of fraction digits and a Z or an offset; null when it is no time.
function micros(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?)(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(value.trim());
  if (!m) return null;
  const zone = !m[3] || /^z$/i.test(m[3]) ? 'Z' : m[3].length === 3 ? m[3] + ':00' : m[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const base = m[1].replace(' ', 'T');
  const whole = Date.parse(base.length === 10 ? `${base}T00:00:00${zone}` : `${base}${base.length === 16 ? ':00' : ''}${zone}`);
  if (Number.isNaN(whole)) return null;
  const fraction = Number((m[2] || '').padEnd(6, '0').slice(0, 6));
  return whole * 1000 + fraction;
}

// Postgres's text form in UTC: trailing zeros of the fraction dropped.
function pgText(us) {
  const whole = new Date(Math.floor(us / 1e6) * 1000).toISOString().slice(0, 19);
  const fraction = String(us % 1e6).padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? '.' + fraction : ''}+00:00`;
}

// ---------- values in and out ----------

// A value as the column stores it, or a PgError for one Postgres refuses.
function stored(table, column, value) {
  if (value === null || value === undefined) return null;
  const type = typeOf(table, column);
  const bad = () => new PgError(type === 'ts' ? '22007' : '22P02', `invalid input syntax for type ${{ ts: 'timestamp with time zone', int: 'integer', num: 'numeric', bool: 'boolean', uuid: 'uuid', serial: 'bigint', text: 'text' }[type]}: "${typeof value === 'object' ? JSON.stringify(value) : value}"`);
  switch (type) {
    case 'ts': {
      const us = micros(value);
      if (us === null) throw bad();
      return pgText(us);
    }
    case 'uuid':
      if (typeof value !== 'string' || !UUID.test(value)) throw bad();
      return value.toLowerCase();
    case 'int':
    case 'serial': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n)) throw bad();
      // int is Postgres integer (4 bytes); serial stands for bigint identities
      if (type === 'int' && (n < -2147483648 || n > 2147483647)) throw new PgError('22003', `value "${n}" is out of range for type integer`);
      return n;
    }
    case 'num': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw bad();
      return n;
    }
    case 'bool':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw bad();
    case 'text':
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return String(value);
      throw bad();
    default:
      return clone(value);
  }
}

// Two stored values of one column, for filters, keys and order: <0, 0, >0.
function compare(table, column, a, b) {
  const type = typeOf(table, column);
  if (type === 'ts') return micros(a) - micros(b);
  if (['int', 'num', 'serial'].includes(type)) return Number(a) - Number(b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------- the tables ----------

let serials = {};
let tables = {};

function tableOf(name) {
  if (!SCHEMA[name]) throw new PgError('42P01', `relation "public.${name}" does not exist`);
  if (!tables[name]) tables[name] = [];
  return tables[name];
}

function columnOf(table, column) {
  if (!Object.hasOwn(SCHEMA[table].columns, column)) throw new PgError('42703', `column ${table}.${column} does not exist`);
  return column;
}

// A new row from an insert: the given columns, the listed ones missing from
// this object as null (PostgREST's columns for an array are the union of
// its objects' keys), everything else its default.
function newRow(table, given, listed) {
  const spec = SCHEMA[table];
  const row = {};
  for (const column of Object.keys(given)) columnOf(table, column);
  for (const column of Object.keys(spec.columns)) {
    if (Object.hasOwn(given, column)) row[column] = stored(table, column, given[column]);
    else if (listed.has(column)) row[column] = null;
    else row[column] = defaultOf(table, column);
  }
  return row;
}

function defaultOf(table, column) {
  const d = SCHEMA[table].defaults?.[column];
  if (d === NEW_UUID) return globalThis.crypto.randomUUID();
  if (d === NOW) return pgText((startedAt ?? fake.now()) * 1000);
  if (d === SERIAL) {
    serials[table] = (serials[table] || 0) + 1;
    return serials[table];
  }
  return d === undefined ? null : clone(d);
}

// NOT NULL and the table's checks.
function checkRow(table, row) {
  const spec = SCHEMA[table];
  for (const [column, type] of Object.entries(spec.columns)) {
    if (type.endsWith('!') && row[column] === null) throw new PgError('23502', `null value in column "${column}" of relation "${table}" violates not-null constraint`);
  }
  const broken = spec.check ? spec.check(row) : '';
  if (broken) throw new PgError('23514', `new row for relation "${table}" violates check constraint "${broken}"`);
}

// A row's values in one unique key as text (times by their instant), or null
// when one of them is null: Postgres lets any number of those through.
function keyText(table, key, row) {
  if (key.some((c) => row[c] === null)) return null;
  return key.map((c) => (typeOf(table, c) === 'ts' ? String(micros(row[c])) : `${typeof row[c]}:${row[c]}`)).join('\u0000');
}

// Every unique key of every row: a second row with the same values is refused.
function checkKeys(table, rows) {
  for (const key of SCHEMA[table].keys) {
    const seen = new Set();
    for (const row of rows) {
      const k = keyText(table, key, row);
      if (k === null) continue;
      if (seen.has(k)) throw new PgError('23505', `duplicate key value violates unique constraint "${table}_${key.join('_')}_key"`);
      seen.add(k);
    }
  }
}

// ---------- reading: filters, order, range, projection ----------

function matches(table, row, filters) {
  return filters.every(({ op, column, value }) => {
    const v = row[column];
    switch (op) {
      case 'eq': return v !== null && compare(table, column, v, value) === 0;
      case 'in': return v !== null && value.some((x) => compare(table, column, v, x) === 0);
      case 'lt': return v !== null && compare(table, column, v, value) < 0;
      case 'lte': return v !== null && compare(table, column, v, value) <= 0;
      case 'gte': return v !== null && compare(table, column, v, value) >= 0;
      case 'is': return v === null;
      case 'not.is': return v !== null;
      default: throw new Error(`the fake has no filter ${op}`);
    }
  });
}

// A filter's value as the column would store it, so a bad one fails the way
// Postgres fails it (a uuid column compared with text that is no uuid).
function filterValue(table, column, value) {
  columnOf(table, column);
  return value === null ? null : stored(table, column, value);
}

// Rows that tie on every ORDER BY key come back from Postgres in no set
// order, and a LIMIT/OFFSET page may break the ties differently from the
// page before it (a bounded top-N sort for one, a full sort for the next),
// so a paged read whose last key is not unique can repeat some rows and lose
// others. The fake does the same to a paged read: it shuffles the rows,
// seeded by the page's offset, before its stable sort, so each page breaks
// ties its own way and only a unique last key (the id) makes the pages fit.
function shuffled(rows, seed) {
  const out = [...rows];
  let s = (seed * 2654435761 + 1013904223) >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function ordered(table, rows, order) {
  const out = [...rows];
  for (const { column, ascending } of [...order].reverse()) {
    out.sort((a, b) => {
      const x = a[column];
      const y = b[column];
      if (x === null || y === null) return x === y ? 0 : (x === null) === ascending ? 1 : -1; // nulls last ascending, first descending
      const c = compare(table, column, x, y);
      return ascending ? c : -c;
    });
  }
  return out;
}

// `a, b, dealerships ( id, name )`: the top-level parts, split on commas outside parentheses.
function parts(columns) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of String(columns)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

// The selected columns of a row, with an embedded table joined through its
// foreign key (memberships.dealership_id -> dealerships.id): an object, or
// null when there is no such row.
function project(table, row, columns) {
  const out = {};
  for (const part of parts(columns)) {
    if (part === '*') {
      Object.assign(out, clone(row));
      continue;
    }
    const embed = /^(\w+)\s*\(([\s\S]*)\)$/.exec(part);
    if (embed) {
      const other = embed[1];
      tableOf(other);
      const fk = other.replace(/s$/, '') + '_id';
      if (!Object.hasOwn(SCHEMA[table].columns, fk)) throw new PgError('PGRST200', `Could not find a relationship between '${table}' and '${other}'`);
      const hit = tableOf(other).find((r) => r.id === row[fk]);
      out[other] = hit ? project(other, hit, embed[2]) : null;
      continue;
    }
    columnOf(table, part);
    out[part] = clone(row[part]);
  }
  return out;
}

// ---------- the calls ----------

function record(entry) {
  fake.calls.push(entry);
  const scripted = fake.script ? fake.script(entry) : undefined;
  return scripted === undefined || scripted === null ? null : { data: null, error: null, count: null, ...scripted };
}

const failed = (e) => {
  if (!(e instanceof PgError)) throw e;
  return { data: null, error: { message: e.message, code: e.code, details: null, hint: null }, count: null, status: 400 };
};

function runSelect(q) {
  const rows = tableOf(q.table);
  const filters = q.filters.map((f) => ({ ...f, value: f.op === 'in' ? f.value.map((v) => filterValue(q.table, f.column, v)) : f.op === 'is' || f.op === 'not.is' ? null : filterValue(q.table, f.column, f.value) }));
  for (const o of q.order) columnOf(q.table, o.column);
  const found = rows.filter((r) => matches(q.table, r, filters));
  const hits = ordered(q.table, q.range ? shuffled(found, q.range[0]) : found, q.order);
  const count = q.count === 'exact' ? hits.length : null;
  const page = (q.range ? hits.slice(q.range[0], q.range[1] + 1) : hits).slice(0, fake.maxRows);
  const data = page.map((r) => project(q.table, r, q.columns));
  if (q.head) return { data: null, error: null, count, status: 200 };
  if (q.single) {
    if (data.length > 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: `The result contains ${data.length} rows`, hint: null }, count, status: 406 };
    return { data: data[0] ?? null, error: null, count, status: 200 };
  }
  return { data, error: null, count, status: 200 };
}

function runUpdate(q) {
  const rows = tableOf(q.table);
  const filters = q.filters.map((f) => ({ ...f, value: f.op === 'in' ? f.value.map((v) => filterValue(q.table, f.column, v)) : f.op === 'is' ? null : filterValue(q.table, f.column, f.value) }));
  const patch = {};
  for (const [column, value] of Object.entries(q.payload)) patch[columnOf(q.table, column)] = stored(q.table, column, value);
  const changed = [];
  const next = rows.map((r) => {
    if (!matches(q.table, r, filters)) return r;
    const row = { ...r, ...patch };
    changed.push(row);
    return row;
  });
  next.forEach((r) => checkRow(q.table, r));
  checkKeys(q.table, next);
  tables[q.table] = next;
  const count = q.options?.count === 'exact' ? changed.length : null;
  // select() after an update is PostgREST's return=representation: the changed rows come back
  if (q.columns) return { data: changed.map((r) => project(q.table, r, q.columns)), error: null, count, status: 200 };
  return { data: null, error: null, count, status: 204 };
}

// insert and upsert. An upsert names its conflict columns, which must be
// one of the table's unique keys; a row that meets an existing one updates
// the columns it carries, or is left out with ignoreDuplicates.
function runWrite(q) {
  const rows = tableOf(q.table);
  const list = Array.isArray(q.payload) ? q.payload : [q.payload];
  const listed = new Set(list.flatMap((o) => Object.keys(o)));
  let conflict = null;
  if (q.op === 'upsert') {
    const wanted = String(q.options?.onConflict || '').split(',').map((s) => s.trim()).filter(Boolean);
    conflict = SCHEMA[q.table].keys.find((k) => k.length === wanted.length && k.every((c) => wanted.includes(c)));
    if (!conflict) throw new PgError('42P10', 'there is no unique or exclusion constraint matching the ON CONFLICT specification');
  }
  const next = [...rows];
  const byKey = new Map(); // the conflict key's text -> the row's place in next
  if (conflict) next.forEach((r, i) => byKey.set(keyText(q.table, conflict, r), i));
  const touched = new Set(); // places this statement wrote
  for (const given of list) {
    const row = newRow(q.table, given, listed);
    const k = conflict ? keyText(q.table, conflict, row) : null;
    const at = k !== null && byKey.has(k) ? byKey.get(k) : -1;
    if (at >= 0) {
      if (q.options?.ignoreDuplicates) continue;
      if (touched.has(at)) throw new PgError('21000', 'ON CONFLICT DO UPDATE command cannot affect row a second time');
      const patch = {};
      for (const column of listed) patch[column] = row[column];
      next[at] = { ...next[at], ...patch };
      touched.add(at);
    } else {
      next.push(row);
      touched.add(next.length - 1);
      if (k !== null) byKey.set(k, next.length - 1);
    }
  }
  next.forEach((r) => checkRow(q.table, r));
  checkKeys(q.table, next);
  tables[q.table] = next;
  return { data: null, error: null, count: null, status: 201 };
}

const entryOf = (q) => ({
  kind: 'query', table: q.table, op: q.op, columns: q.columns ?? null, count: q.count ?? null, head: Boolean(q.head),
  filters: q.filters.map((f) => ({ ...f, value: clone(f.value) })), order: [...q.order], range: q.range, single: Boolean(q.single),
  payload: clone(q.payload), options: clone(q.options), key: q.client.key, token: q.client.token,
});

let holds = [];
let startedAt = null; // while a held query runs: the database's clock when it arrived

// A query that arrived: run now, or, when a hold takes it, at its commit,
// with now() read as it was on arrival: Postgres's now() is the time the
// transaction started, however long it stays open.
async function arrive(q) {
  const at = holds.findIndex((h) => h.match(entryOf(q)));
  if (at < 0) return execute(q);
  const [hold] = holds.splice(at, 1);
  const arrivedAt = fake.now();
  hold.reached(entryOf(q));
  await hold.committed;
  startedAt = arrivedAt;
  try {
    return execute(q);
  } finally {
    startedAt = null;
  }
}

function execute(q) {
  const entry = entryOf(q);
  const scripted = record(entry);
  if (scripted) return scripted;
  try {
    if (q.op === 'select') return runSelect(q);
    if (q.op === 'update') return runUpdate(q);
    return runWrite(q);
  } catch (e) {
    return failed(e);
  }
}

// One chain: the filters and modifiers its operation allows, then awaited.
function builder(client, table, op, init) {
  const q = { client, table, op, filters: [], order: [], range: null, single: false, ...init };
  const b = {
    then(resolve, reject) {
      const trip = fake.latencyMs > 0 ? new Promise((r) => setTimeout(r, fake.latencyMs)) : Promise.resolve();
      return trip.then(() => arrive(q)).then(resolve, reject);
    },
  };
  if (op === 'insert' || op === 'upsert') return b;
  const filter = (name, op2 = name) => (column, value) => {
    q.filters.push({ op: op2, column, value });
    return b;
  };
  b.eq = filter('eq');
  b.in = (column, values) => {
    if (!Array.isArray(values)) throw new TypeError('in() takes a list');
    q.filters.push({ op: 'in', column, value: [...values] });
    return b;
  };
  b.is = (column, value) => {
    if (value !== null) throw new Error('the fake models is(column, null) only');
    q.filters.push({ op: 'is', column, value: null });
    return b;
  };
  if (op === 'update') {
    b.select = (columns = '*') => {
      q.columns = columns;
      return b;
    };
    return b;
  }
  b.lt = filter('lt');
  b.lte = filter('lte');
  b.gte = filter('gte');
  b.not = (column, operator, value) => {
    if (operator !== 'is' || value !== null) throw new Error("the fake models not(column, 'is', null) only");
    q.filters.push({ op: 'not.is', column, value: null });
    return b;
  };
  b.order = (column, { ascending = true } = {}) => {
    q.order.push({ column, ascending });
    return b;
  };
  b.range = (from, to) => {
    q.range = [from, to];
    return b;
  };
  b.maybeSingle = () => {
    q.single = true;
    return b;
  };
  return b;
}

export function createClient(url, key, options = {}) {
  const headers = (options && options.global && options.global.headers) || {};
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.Authorization || headers.authorization || '');
  const client = { url, key, token: bearer ? bearer[1] : '' };
  fake.clients.push({ ...client, options: clone(options) });
  return {
    auth: {
      async getUser(jwt) {
        const scripted = record({ kind: 'auth', op: 'getUser', jwt, key: client.key, token: client.token });
        if (scripted) return scripted;
        const user = fake.users.get(jwt);
        if (!user) return { data: { user: null }, error: { message: 'invalid JWT: unable to parse or verify signature', status: 403, code: 'bad_jwt' } };
        return { data: { user: { aud: 'authenticated', role: 'authenticated', ...clone(user) } }, error: null };
      },
    },
    from(table) {
      return {
        select: (columns = '*', { count = null, head = false } = {}) => builder(client, table, 'select', { columns, count, head }),
        insert: (payload, options = {}) => builder(client, table, 'insert', { payload, options }),
        upsert: (payload, options = {}) => builder(client, table, 'upsert', { payload, options }),
        update: (payload, options = {}) => builder(client, table, 'update', { payload, options }),
      };
    },
  };
}

// ---------- the test's side ----------

export const fake = {
  calls: [],
  clients: [],
  users: new Map(), // bearer token -> { id, email }
  script: null,
  now: () => Date.now(), // the database's clock, for now() defaults
  latencyMs: 0, // how long each query waits before it runs, like a trip to a real database
  maxRows: 1000, // the most rows one select answers, like the API's max-rows

  // An empty database, the users by token, and rows to start from (written
  // the way an insert writes them: defaults filled, types checked, not
  // recorded as calls).
  reset({ users = {}, rows = {}, script = null, now = () => Date.now(), latencyMs = 0, maxRows = 1000 } = {}) {
    tables = {};
    serials = {};
    holds = [];
    this.calls = [];
    this.clients = [];
    this.users = new Map(Object.entries(users));
    this.script = script;
    this.now = now;
    this.latencyMs = latencyMs;
    this.maxRows = maxRows;
    for (const [table, list] of Object.entries(rows)) this.seed(table, list);
  },

  // Keeps the next query that match(entry) accepts open until commit() (the
  // entry is the one fake.calls records). `arrived` resolves with that entry
  // when the query reaches the database, which for a write is when its now()
  // defaults are taken.
  hold(match) {
    let reached;
    let commit;
    const arrived = new Promise((r) => { reached = r; });
    const committed = new Promise((r) => { commit = r; });
    holds.push({ match, reached, committed });
    return { arrived, commit: () => commit() };
  },

  seed(table, list) {
    const current = tableOf(table);
    const added = list.map((given) => newRow(table, given, new Set()));
    const next = [...current, ...added];
    next.forEach((r) => checkRow(table, r));
    checkKeys(table, next);
    tables[table] = next;
    return added.map(clone);
  },

  // The table as the database holds it (copies).
  rows(table) {
    return tableOf(table).map(clone);
  },

  // The queries that wrote something, optionally to one table.
  writes(table = null) {
    return this.calls.filter((c) => c.kind === 'query' && c.op !== 'select' && (!table || c.table === table));
  },

  // The queries against one table, optionally one operation.
  queries(table, op = null) {
    return this.calls.filter((c) => c.kind === 'query' && c.table === table && (!op || c.op === op));
  },
};

// The tables as the fake models them, for the test that holds them to the
// migrations (test/fn-sync.test.js).
export const MODELLED_TABLES = SCHEMA;

// Postgres's text form of a time, for tests that compare with stored rows.
export const pgTime = (iso) => {
  const us = micros(iso);
  if (us === null) throw new Error(`not a time: ${iso}`);
  return pgText(us);
};
