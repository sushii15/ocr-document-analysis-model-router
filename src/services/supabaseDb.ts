import pg from "pg";

export async function withSupabaseDb<T>(run: (client: pg.Client) => Promise<T>): Promise<T | undefined> {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) return undefined;
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    return await run(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
