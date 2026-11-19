import { array, string, uuid } from "zod";
import { command } from "ccstate";
import { localStorageSignals } from "../external/local-storage.ts";
import { jsonParseOr } from "../utils.ts";

const recentWorkflowIdsSchema = array(string());
const workflowIdSchema = uuid();
export const recentWorkflowStorage = localStorageSignals("recent-workflows");

export function readRecentWorkflowIds(value: string | null): readonly string[] {
  const parsed = recentWorkflowIdsSchema.safeParse(
    jsonParseOr<unknown>(value ?? "[]", null),
  );
  return parsed.success ? parsed.data : [];
}

/** Legacy order is newest-first, without timestamps or an owner identity. */
export function legacyWorkflowIdsForMigration(value: string | null): string[] {
  const parsed = jsonParseOr<unknown>(value ?? "[]", null);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const ids = new Set<string>();
  for (const value of parsed) {
    const id = workflowIdSchema.safeParse(value);
    if (id.success) {
      ids.add(id.data.toLowerCase());
      if (ids.size === 1000) {
        break;
      }
    }
  }
  return [...ids];
}

export const readLegacyWorkflowIdsForMigration$ = command(({ set }) => {
  return legacyWorkflowIdsForMigration(set(recentWorkflowStorage.readFresh$));
});
