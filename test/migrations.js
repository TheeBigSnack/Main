// The migrations as a database ends up with them. 0001 to 0008 are applied
// in the production project and are never edited (test/supabase.test.js
// holds each to its SHA-256), so a later file changes a function with
// create or replace. A test of what a function does reads its last
// definition, the one the database runs.

import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../supabase/migrations/', import.meta.url);

export const MIGRATIONS = readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

export const migration = (file) => readFileSync(new URL(file, DIR), 'utf8');

// The last file, in number order, that creates public.<name>(), and its text.
export function lastDefinition(name) {
  const marker = `create or replace function public.${name}(`;
  const file = MIGRATIONS.filter((f) => migration(f).replace(/--.*$/gm, '').includes(marker)).pop();
  if (!file) throw new Error(`no migration creates public.${name}()`);
  return { file, sql: migration(file) };
}
