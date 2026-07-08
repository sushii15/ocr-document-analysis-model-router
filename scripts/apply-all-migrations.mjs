import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL. Use the Supabase pooled or direct Postgres connection string.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "..", "..", "supabase", "migrations");
const migrationFiles = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
const client = new pg.Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  for (const migrationFile of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationFile), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("commit");
      console.log(`Applied ${migrationFile}`);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw new Error(`Failed ${migrationFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
