import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the db/migrations directory. Walks up from this file's location
 * looking for a sibling/ancestor `db/migrations` folder. Works whether run
 * from `src/` (ts-node-style) or `dist/src/db/` (compiled).
 */
function locateMigrationsDir(): string {
  let cursor = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(cursor, "db", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(cursor, "..");
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`[migrate] Could not locate db/migrations dir starting from ${here}`);
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const dir = locateMigrationsDir();
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  if (files.length === 0) {
    console.warn(`[migrate] no .sql files in ${dir}`);
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    console.log(`[migrate] applying ${files.length} migration(s) from ${dir}`);
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      try {
        await pool.query(sql);
        console.log(`[migrate]   ${file} ok`);
      } catch (error) {
        console.error(`[migrate]   ${file} FAILED: ${(error as Error).message}`);
        throw error;
      }
    }
    console.log("[migrate] all migrations applied");
  } finally {
    await pool.end();
  }
}
