import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import type { ApiDb } from "../../lib/db-types";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

export function brandMotionDraftTemplateIds(
  document: UserMessageInputDocument | null,
): readonly string[] {
  return (
    document?.parts.flatMap((part) => {
      return part.type === "template" && part.template.type === "brand-motion"
        ? [part.template.selection.templateId]
        : [];
    }) ?? []
  );
}

/** Disabling selection still allows editing text around a saved template. */
export async function canSaveBrandMotionDraft(
  db: ApiDb,
  args: {
    readonly orgId: string | null;
    readonly userId: string;
    readonly templateIds: readonly string[];
    readonly savedDocument: UserMessageInputDocument | null;
  },
): Promise<boolean> {
  if (args.orgId) {
    const context = await loadUserFeatureSwitchContext(
      db,
      args.orgId,
      args.userId,
    );
    if (isFeatureEnabled(FeatureSwitchKey.BrandMotion, context)) {
      return true;
    }
  }
  const remaining = [...brandMotionDraftTemplateIds(args.savedDocument)];
  for (const id of args.templateIds) {
    const index = remaining.indexOf(id);
    if (index === -1) {
      return false;
    }
    remaining.splice(index, 1);
  }
  return true;
}
