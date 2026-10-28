import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type ApiDb = NodePgDatabase<Record<string, never>>;
