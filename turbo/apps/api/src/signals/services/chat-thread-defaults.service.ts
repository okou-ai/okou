import {
  modelSettingsSchema,
  type ModelSettings,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { and, eq } from "drizzle-orm";

import { command } from "ccstate";
import { writeDb$ } from "../external/db";

interface NewChatThreadDefaults {
  readonly modelSettings: ModelSettings;
  readonly cloudBrowserEnabled: boolean;
}

export const loadNewChatThreadDefaults$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal?: AbortSignal,
  ): Promise<NewChatThreadDefaults> => {
    const db = set(writeDb$);
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
    signal?.throwIfAborted();
    return {
      modelSettings: modelSettingsSchema.parse(member?.modelSettings ?? {}),
      cloudBrowserEnabled: member?.cloudBrowserEnabled ?? true,
    };
  },
);
