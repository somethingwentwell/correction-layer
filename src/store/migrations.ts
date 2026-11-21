/**
 * Versioned, forward-only migrations. Each migration runs once inside a transaction
 * and is recorded with a checksum; an applied migration whose text later changed is
 * reported instead of being silently accepted. Additive changes only within a major
 * schema version (docs/03 §11).
 */
import { sha256 } from "../domain/canonical.ts";
import type { Db } from "./db.ts";
import { all, run, tx } from "./db.ts";
import { M001_INIT, M002_PHASE2 } from "./schema.ts";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([{ version: 1, name: "init", sql: M001_INIT }, { version: 2, name: "phase2", sql: M002_PHASE2 }]);

export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS, now: () => string = () => new Date().toISOString()): { applied: number[]; version: number } {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const done = new Map(all<{ version: number; checksum: string }>(db, "SELECT version, checksum FROM schema_migrations").map((r) => [r.version, r.checksum]));
  const applied: number[] = [];
  let expected = 1;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version !== expected++) throw new Error(`migrations must be numbered contiguously from 1; found ${m.version}`);
    const checksum = sha256(m.sql);
    const previous = done.get(m.version);
    if (previous !== undefined) {
      if (previous !== checksum) throw new Error(`migration ${m.version} (${m.name}) was changed after it was applied; add a new migration instead`);
      continue;
    }
    tx(db, () => {
      db.exec(m.sql);
      run(db, "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)", m.version, m.name, checksum, now());
    });
    applied.push(m.version);
  }
  const newest = Math.max(0, ...migrations.map((m) => m.version));
  for (const version of done.keys()) {
    if (version > newest) throw new Error(`the store is at schema version ${version}, newer than this build (${newest}); refusing to open it`);
  }
  return { applied, version: newest };
}

export function schemaVersion(db: Db): number {
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  return row.v;
}
