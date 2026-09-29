import {
  modelSettingsSchema,
  type ModelSettings,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

interface NewChatThreadDefaults {
  readonly modelSettings: ModelSettings;
  readonly cloudBrowserEnabled: boolean;
}

/** Snapshot the member's Chat preferences only when a thread is created. */
export async function loadNewChatThreadDefaults(
  db: Pick<ReadonlyDb, "select">,
  args: { readonly orgId: string; readonly userId: string },
): Promise<NewChatThreadDefaults> {
  const [member] = await db
    .select({
      modelSettings: orgMembersMetadata.modelSettings,
      cloudBrowserEnabled: orgMembersMetadata.cloudBrowserEnabledByDefault,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.userId),
      ),
    )
    .limit(1);
  return {
    modelSettings: modelSettingsSchema.parse(member?.modelSettings ?? {}),
    cloudBrowserEnabled: member?.cloudBrowserEnabled ?? true,
  };
}
