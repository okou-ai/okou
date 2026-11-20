import { computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { projects } from "@okouai/db/schema/project";
import type { AuthContext } from "../../types/auth";
import { db$ } from "../external/db";

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
  return computed(async (get) => {
    if (projectIds.length === 0) {
      return true;
    }
    if (
      !auth.orgId ||
      (auth.tokenType === "agent" && auth.singleAgent !== true)
    ) {
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

export function canWriteProjectReferences(
  auth: AuthContext,
  document: UserMessageDocument | null | undefined,
) {
  return (
    projectReferences(document).length === 0 ||
    (!!auth.orgId && (auth.tokenType !== "agent" || auth.singleAgent === true))
  );
}
