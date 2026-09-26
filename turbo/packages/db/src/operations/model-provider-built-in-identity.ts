import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { modelProviders } from "../schema/model-provider";

const ORG_NO_SECRET_PROVIDER_USER_ID = "__org__";

type ModelProviderRow = typeof modelProviders.$inferSelect;

/**
 * One statement: idx_model_providers_org_user_type arbitrates concurrent
 * upserts, and the row keeps its original id when it already existed.
 */
export async function upsertBuiltInNoSecretModelProviderIdentity(
  db: NodePgDatabase<Record<string, never>>,
  args: {
    readonly orgId: string;
    readonly selectedModel: string | null;
    readonly updatedAt: Date;
  },
  signal: AbortSignal,
): Promise<{ readonly provider: ModelProviderRow; readonly created: boolean }> {
  const proposedId = randomUUID();
  const [provider] = await db
    .insert(modelProviders)
    .values({
      id: proposedId,
      type: "built-in",
      userId: ORG_NO_SECRET_PROVIDER_USER_ID,
      isDefault: false,
      selectedModel: args.selectedModel,
      orgId: args.orgId,
    })
    .onConflictDoUpdate({
      target: [
        modelProviders.orgId,
        modelProviders.userId,
        modelProviders.type,
      ],
      set: {
        selectedModel: args.selectedModel,
        updatedAt: args.updatedAt,
      },
    })
    .returning();
  signal.throwIfAborted();
  if (!provider) {
    throw new Error("Expected no-secret model provider upsert to return row");
  }
  return { provider, created: provider.id === proposedId };
}
