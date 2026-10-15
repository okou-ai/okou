import { singleton } from "../lib/singleton";
import { settleIncludingAbort } from "../signals/utils";
import {
  createPgliteDatabase,
  type PgliteTestDatabase,
} from "./pglite-database";

interface CaseDatabase {
  sharedAccessed: boolean;
  isolated?: Promise<PgliteTestDatabase>;
  ready?: PgliteTestDatabase;
}

interface DatabaseState {
  snapshotPath: string;
  current?: CaseDatabase;
  prepared?: PgliteTestDatabase;
}

// Cases in a file run serially. Database selection needs no async-local scope.
const state = singleton((): DatabaseState => {
  return { snapshotPath: "" };
});

export function configureCaseDatabase(
  snapshotPath: string,
  prepared: PgliteTestDatabase,
): void {
  const scope = state();
  scope.snapshotPath = snapshotPath;
  scope.prepared = prepared;
}

/** Worker setup owns the baseline until an isolated case takes it once. */
export async function closePreparedCaseDatabase(): Promise<void> {
  const scope = state();
  const prepared = scope.prepared;
  scope.prepared = undefined;
  await prepared?.close();
}

/** testContext owns disposal after request cleanup and tracked background work. */
export function beginCaseDatabase(): () => Promise<void> {
  const current: CaseDatabase = { sharedAccessed: false };
  state().current = current;
  return async () => {
    const closed = await settleIncludingAbort(async () => {
      const isolated = await current.isolated;
      await isolated?.close();
    });
    state().current = undefined;
    if (!closed.ok) {
      throw closed.error;
    }
  };
}

/** Called by setupApp before any fixture or application database access. */
export async function initializeCaseDatabase(): Promise<void> {
  const scope = state();
  const { current, snapshotPath } = scope;
  if (!current) {
    throw new Error("Database isolation requires an active test case");
  }
  if (current.sharedAccessed) {
    throw new Error(
      "Call setupApp({ isolatePg: true }) before accessing the database",
    );
  }
  if (!snapshotPath) {
    throw new Error("The API test database snapshot was not provided");
  }
  if (!current.isolated) {
    const prepared = scope.prepared;
    scope.prepared = undefined;
    current.isolated = prepared
      ? Promise.resolve(prepared)
      : createPgliteDatabase(snapshotPath);
  }
  current.ready = await current.isolated;
}

export function caseDatabase() {
  const current = state().current;
  if (!current) {
    return undefined;
  }
  if (current.isolated && !current.ready) {
    throw new Error(
      "Await setupApp({ isolatePg: true }) before accessing the database",
    );
  }
  if (current.ready) {
    return current.ready.database;
  }
  current.sharedAccessed = true;
  return undefined;
}
