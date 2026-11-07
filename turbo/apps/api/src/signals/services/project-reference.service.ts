import { computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { projects } from "@okouai/db/schema/project";
import type { AuthContext } from "../../types/auth";
import { db$ } from "../external/db";
import { userFeatureSwitchContext } from "./feature-switches.service";

function projectReferences(document: UserMessageDocument | null | undefined) {
  return (document?.parts ?? [])
    .flatMap((part) => {
      return part.type === "feedback" ? part.note : [part];
    })
    .filter((part) => {
      return part.type === "project";
    });
}

export function projectReferencesAvailable(
  auth: AuthContext,
  document: UserMessageDocument | null | undefined,
) {
  // PostgreSQL UUID equality ignores case; normalize only the lookup keys.
  const projectIds = [
    ...new Set(
      projectReferences(document).map((reference) => {
        return reference.projectId.toLowerCase();
      }),
    ),
  ];
  const writesEnabled$ = projectReferenceWritesEnabled(auth, document);
  return computed(async (get) => {
    if (projectIds.length === 0) {
      return true;
    }
    if (!auth.orgId || !(await get(writesEnabled$))) {
      return false;
    }
    const rows = await get(db$)
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          inArray(projects.id, projectIds),
          eq(projects.userId, auth.userId),
          eq(projects.orgId, auth.orgId),
        ),
      );
    return rows.length === projectIds.length;
  });
}

export function projectReferenceWritesEnabled(
  auth: AuthContext,
  document: UserMessageDocument | null | undefined,
) {
  const references = projectReferences(document);
  return computed(async (get) => {
    if (references.length === 0) {
      return true;
    }
    if (!auth.orgId) {
      return false;
    }
    return isFeatureEnabled(
      FeatureSwitchKey.Projects,
      await get(userFeatureSwitchContext(auth.orgId, auth.userId)),
    );
  });
}
