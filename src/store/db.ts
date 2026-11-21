/**
 * The workspace store: one SQLite database per workspace, single writer
 * (docs/03 §3, ADR-001). Uses Node's built-in `node:sqlite`, so the store has no
 * native add-on to compile.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;
export type Row = Record<string, any>;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  return db;
}

const depth = new WeakMap<Db, number>();

/**
 * Run `fn` atomically. Nested calls use savepoints, so a service can compose other
 * services and still commit or roll back as one unit (a check writes its run, events
 * and receipt together or not at all).
 */
export function tx<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const name = `sp_${level}`;
  db.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(level === 0 ? "COMMIT" : `RELEASE ${name}`);
    return result;
  } catch (error) {
    try {
      db.exec(level === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
    } catch {
      /* the original error is the one worth reporting */
    }
    throw error;
  } finally {
    depth.set(db, level);
  }
}

export function all<T = Row>(db: Db, sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T = Row>(db: Db, sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: Db, sql: string, ...params: any[]): { changes: number; lastInsertRowid: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export const json = (value: unknown): string => JSON.stringify(value);
export const parse = <T = any>(text: string | null | undefined): T => (text == null ? (null as T) : (JSON.parse(text) as T));
