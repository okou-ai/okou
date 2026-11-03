import { computed } from "ccstate";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { AuthContext } from "../../types/auth";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { projectById } from "./project.service";

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
  const references = projectReferences(document);
  return computed(async (get) => {
    if (references.length === 0) {
      return true;
    }
    if (
      !auth.orgId ||
      !(await get(projectReferenceWritesEnabled(auth, document)))
    ) {
      return false;
    }
    const owner = { userId: auth.userId, orgId: auth.orgId };
    for (const reference of references) {
      if (!(await get(projectById(owner, reference.projectId)))) {
        return false;
      }
    }
    return true;
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
