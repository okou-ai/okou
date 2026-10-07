import { inject, vi } from "vitest";
import { API_DATABASE_SNAPSHOT } from "./database-snapshot";
import { configureCaseDatabase } from "../test-fixtures/case-database";

// One transport binding for the entire API project. Production SQL and services
// are unchanged; setupApp selects the database owned by the current case.
vi.mock("../lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/db")>();
  const { caseDatabase } = await import("../test-fixtures/case-database");
  return {
    ...original,
    db: Object.assign(
      () => {
        return caseDatabase() ?? original.db();
      },
      {
        peek: original.db.peek,
        reset: original.db.reset,
      },
    ),
  };
});

configureCaseDatabase(inject(API_DATABASE_SNAPSHOT));
