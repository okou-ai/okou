import postgres from "postgres";

export function connectErasureJournal(connectionString: string) {
  // Never let postgres(undefined/empty) select ambient connection settings.
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error("erasure_journal:connection_required");
  }
  const url = new URL(connectionString);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.pathname.length < 2
  ) {
    throw new Error("erasure_journal:invalid_connection");
  }
  return postgres(connectionString, {
    max: 4,
    connect_timeout: 10,
    connection: {
      lock_timeout: 1000,
      statement_timeout: 10_000,
      idle_in_transaction_session_timeout: 10_000,
    },
  });
}
