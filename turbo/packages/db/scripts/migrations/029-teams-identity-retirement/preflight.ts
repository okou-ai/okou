import { Client } from "pg";
import { date, literal, object, string } from "zod";

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required for the read-only Teams preflight",
    );
  }
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '5s'");
    const result = await client.query(`
      SELECT count(*)::text AS connections,
        count(*) FILTER (WHERE org_id IS NULL)::text AS unowned,
        count(*) FILTER (WHERE teams_aad_object_id IS NULL)::text AS unverified,
        statement_timestamp() AS query_time,
        current_setting('transaction_read_only') AS read_only
      FROM teams_org_connections
    `);
    const count = string().regex(/^\d+$/u);
    const rows = object({
      connections: count,
      unowned: count,
      unverified: count,
      query_time: date(),
      read_only: literal("on"),
    }).parse(result.rows[0]);
    console.log(
      JSON.stringify(
        {
          queriedAt: rows.query_time.toISOString(),
          transactionReadOnly: rows.read_only,
          connectionRows: rows.connections,
          unownedConnectionRows: rows.unowned,
          missingAadIdentityRows: rows.unverified,
          ownerConstraintReady: rows.unowned === "0",
        },
        null,
        2,
      ),
    );
    return rows.unowned === "0" ? 0 : 1;
  } finally {
    await client.end();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const parsed = object({
    code: string()
      .regex(/^[A-Z0-9]{5}$/u)
      .optional(),
  }).safeParse(error);
  console.error(
    JSON.stringify({
      error: "Teams ownership preflight failed",
      ...(parsed.success && parsed.data.code
        ? { sqlstate: parsed.data.code }
        : {}),
    }),
  );
  process.exitCode = 1;
}
