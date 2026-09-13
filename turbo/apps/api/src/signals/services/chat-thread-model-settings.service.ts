import {
  modelSettingsSchema,
  type ModelSettings,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

/** Snapshot the member's complete sparse map when a chat thread is created. */
export async function loadNewChatThreadModelSettings(
  db: Pick<ReadonlyDb, "select">,
  args: { readonly orgId: string; readonly userId: string },
): Promise<ModelSettings> {
  const [member] = await db
    .select({ modelSettings: orgMembersMetadata.modelSettings })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.userId),
      ),
    )
    .limit(1);
  return modelSettingsSchema.parse(member?.modelSettings ?? {});
}
