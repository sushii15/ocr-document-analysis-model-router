import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL. Use the Supabase pooled or direct Postgres connection string with sslmode=require.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "..", "..", "supabase", "migrations");
const migrationFile = fs
  .readdirSync(migrationsDir)
  .filter((file) => file.endsWith("_add_llm_router_persistence.sql"))
  .sort()
  .at(-1);

if (!migrationFile) {
  console.error(`Could not find *_add_llm_router_persistence.sql under ${migrationsDir}`);
  process.exit(1);
}

const sql = fs.readFileSync(path.join(migrationsDir, migrationFile), "utf8");
const client = new pg.Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query("begin");
  await client.query(sql);
  await client.query("commit");
  console.log(`Applied ${migrationFile}`);
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
