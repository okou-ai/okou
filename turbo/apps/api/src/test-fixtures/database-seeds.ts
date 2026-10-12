// The same fixed, test-only files initialize native PostgreSQL and PGlite.
// Cases cannot select seed data or override this common baseline.
export const API_DATABASE_SEED_FILES = [
  new URL("./seeds/usage-pricing.sql", import.meta.url),
  new URL("./seeds/connector-catalog.sql", import.meta.url),
  new URL("./seeds/managed-model-key.sql", import.meta.url),
] as const;
