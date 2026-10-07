import { AsyncLocalStorage } from "node:async_hooks";
import { singleton } from "../lib/singleton";
import { settleIncludingAbort } from "../signals/utils";
import { abortTestCaseOwner, withTestCaseOwner } from "./case-owner";
import {
  createPgliteDatabase,
  type PgliteTestDatabase,
} from "./pglite-database";

interface CaseDatabase {
  phase: "open" | "closed";
  sharedAccessed: boolean;
  isolated?: Promise<PgliteTestDatabase>;
  ready?: PgliteTestDatabase;
}

const caseScope = singleton(() => {
  return new AsyncLocalStorage<CaseDatabase>();
});
const snapshot = singleton(() => {
  return { path: "" };
});

export function configureCaseDatabase(snapshotPath: string): void {
  snapshot().path = snapshotPath;
}

/** Called by setupApp before any fixture or application database access. */
export async function initializeCaseDatabase(): Promise<void> {
  const owner = caseScope().getStore();
  if (!owner || owner.phase !== "open") {
    throw new Error("Database isolation requires an active test case");
  }
  if (owner.sharedAccessed) {
    throw new Error(
      "Call setupApp({ isolatePg: true }) before accessing the database",
    );
  }
  if (!snapshot().path) {
    throw new Error("The API test database snapshot was not provided");
  }
  owner.isolated ??= createPgliteDatabase(snapshot().path);
  owner.ready = await owner.isolated;
}

/** Keep the case binding even after teardown so late work cannot reach shared PG. */
export function caseDatabase() {
  const owner = caseScope().getStore();
  if (!owner) {
    return undefined;
  }
  if (owner.phase === "closed") {
    throw new Error("Database accessed after its test case finished");
  }
  if (owner.isolated && !owner.ready) {
    throw new Error(
      "Await setupApp({ isolatePg: true }) before accessing the database",
    );
  }
  if (owner.ready) {
    return owner.ready.database;
  }
  owner.sharedAccessed = true;
  return undefined;
}

export function isolatedCaseDatabase(): PgliteTestDatabase {
  const owner = caseScope().getStore();
  if (!owner?.ready || owner.phase !== "open") {
    throw new Error("The current test case has no isolated database");
  }
  return owner.ready;
}

export async function withCaseDatabase(
  work: () => Promise<void>,
  drain: () => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const owner: CaseDatabase = { phase: "open", sharedAccessed: false };
  await withTestCaseOwner(controller, async () => {
    await caseScope().run(owner, async () => {
      const result = await settleIncludingAbort(work);
      abortTestCaseOwner(new DOMException("Test case finished", "AbortError"));
      const drained = await settleIncludingAbort(drain);
      // A failed setup may still have started native initialization. It remains
      // owned here even if the test never reached its ordinary cleanup hooks.
      const initialized = owner.isolated
        ? await settleIncludingAbort(owner.isolated)
        : undefined;
      owner.phase = "closed";
      const closed = initialized?.ok
        ? await settleIncludingAbort(initialized.value.close())
        : undefined;
      const errors = [result, drained, initialized, closed].flatMap(
        (outcome) => {
          return outcome && !outcome.ok ? [outcome.error] : [];
        },
      );
      const uniqueErrors = [...new Set(errors)];
      if (uniqueErrors.length === 1) {
        throw uniqueErrors[0];
      }
      if (uniqueErrors.length > 1) {
        throw new AggregateError(
          uniqueErrors,
          "Test case and database cleanup failed",
        );
      }
    });
  });
}
